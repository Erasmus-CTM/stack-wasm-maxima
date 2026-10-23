// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, relative, extname, sep, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadSidecars } from '../../runtime/compression/server-source.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2' };

export async function serveDemo({ root, port = 0, compression = 'gzip', latencyMs = 0,
  isolationHeaders = true,
  sidecarSource = process.env.CTM_RUNTIME_COMPRESSION_SOURCE,
  sidecarMode = process.env.CTM_RUNTIME_COMPRESSION_MODE || 'br' }) {
  root = await realpath(resolve(root));
  if (process.env.CTM_RUNTIME_COMPRESSION_MODE && !sidecarSource) throw new Error('Compression mode requires an explicit sidecar source');
  const sidecars = sidecarSource ? await loadSidecars(sidecarSource, sidecarMode) : null;
  const cache = new Map(), requests = [], activeResponses = new Map(), abortedResponses = [];
  let lastResponseActivity=Date.now();
  const server = createServer(async (request, response) => {
    const record={url:request.url,startedAt:new Date().toISOString()};activeResponses.set(response,record);lastResponseActivity=Date.now();
    response.once('finish',()=>{activeResponses.delete(response);lastResponseActivity=Date.now();});
    response.once('close',()=>{if(!response.writableFinished)abortedResponses.push({...record,closedAt:new Date().toISOString()});activeResponses.delete(response);lastResponseActivity=Date.now();});
    const headers = { 'Cache-Control': 'public, max-age=3600', Vary: 'Accept-Encoding' };
    // Test-only static-host simulation: the normal server contract remains the
    // default. The canonical service worker must supply missing page isolation.
    if (isolationHeaders) Object.assign(headers, {'Cross-Origin-Opener-Policy':'same-origin',
      'Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'});
    try {
      if (latencyMs) await new Promise(resolveDelay => setTimeout(resolveDelay, latencyMs));
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      // Public, immutable board dependencies are fetched with CORS by an opaque
      // allow-scripts iframe. Keep CORP/COEP unchanged for all other resources.
      if (/^\/native\/boards\/(?:assets|mathjax)\//.test(pathname) && !pathname.split('/').includes('..')) {
        headers['Access-Control-Allow-Origin'] = '*';
        // MathJax's unchanged classic speech worker uses importScripts, whose
        // no-cors request cannot opt into the parent's anonymous CORS mode.
        if (isolationHeaders) headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
      }
      // A sandboxed HTTP board has an opaque origin; Firefox also enforces
      // CORP on its isolated-parent navigation. Only generated board documents
      // are public here, not arbitrary HTML under the native subtree.
      if (isolationHeaders && /^\/native\/boards\/[A-Za-z0-9_-]+\.html$/.test(pathname)) {
        headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
      }
      if (pathname === '/favicon.ico') { response.writeHead(204, headers); response.end(); return; }
      let target = resolve(root, '.' + pathname);
      let rel = relative(root, target);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || rel.includes('\0')) throw new Error('Unsafe static path');
      if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
      target = await realpath(target);
      rel = relative(root, target);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Static path escapes site root');
      let item = cache.get(target);
      if (!item) {
        const body = await readFile(target);
        item = { body, gzip: body.length >= 256 && (!sidecars || !pathname.startsWith('/maxima-runtime/')) ? gzipSync(body, { level: 6 }) : null,
          sha256: createHash('sha256').update(body).digest('hex') };
        cache.set(target, item);
      }
      let body = item.body, status = 200;
      const sidecar = sidecars?.select(pathname, body, request.headers['accept-encoding']);
      headers['Content-Type'] = types[extname(target)] || 'application/octet-stream';
      headers.ETag = '"' + item.sha256 + '"';
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!match) throw new Error('Unsupported static byte range');
        const first = Number(match[1]), last = match[2] ? Number(match[2]) : body.length - 1;
        if (first > last || last >= body.length) {
          response.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + body.length }); response.end(); return;
        }
        headers['Content-Range'] = 'bytes ' + first + '-' + last + '/' + body.length;
        headers['Accept-Ranges'] = 'bytes';
        body = body.subarray(first, last + 1);
        status = 206;
      } else if (sidecar) {
        body = sidecar.body;
        headers['Content-Encoding'] = sidecar.encoding;
        headers.ETag = '"' + sidecar.sha256 + '"';
        headers['Accept-Ranges'] = 'none';
      } else if (compression === 'gzip' && item.gzip && /\bgzip\b/.test(request.headers['accept-encoding'] || '')) {
        body = item.gzip;
        headers['Content-Encoding'] = 'gzip';
        // Emscripten's pinned lazy loader detects gzip, downloads the whole
        // object, and obtains its decoded length. Ranges remain uncompressed.
        headers['Accept-Ranges'] = 'none';
      } else headers['Accept-Ranges'] = 'bytes';
      headers['Content-Length'] = body.length;
      requests.push({ pathname, method: request.method, status, contentEncoding: headers['Content-Encoding'] || 'identity',
        encodedBodyBytes: request.method === 'HEAD' ? 0 : body.length, decodedFileBytes: item.body.length,
        sha256: item.sha256,
        ...(sidecars && pathname.startsWith('/maxima-runtime/') ? { sidecarManifestSha256:sidecars.manifestSha256,
          encodedSha256: status === 200 && sidecar ? sidecar.sha256 : null,
          range:request.headers.range || null, contentRange:headers['Content-Range'] || null } : {}) });
      response.writeHead(status, headers);
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const missing = error.code === 'ENOENT';
      requests.push({ url: request.url, error: String(error), status: missing ? 404 : 500 });
      response.writeHead(missing ? 404 : 500, { ...headers, 'Content-Type': 'text/plain' });
      response.end(missing ? 'File not found' : String(error));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return { server, baseURL: 'http://127.0.0.1:' + server.address().port + '/', requests,
    compression, abortedResponses, get activeResponses(){return [...activeResponses.values()];}, get lastResponseActivity(){return lastResponseActivity;}, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf('--root'), portAt = args.indexOf('--port');
  const app = await serveDemo({ root: rootAt >= 0 ? args[rootAt + 1] : '.cache/milestone-two/demo/_site',
    port: portAt >= 0 ? Number(args[portAt + 1]) : 4173 });
  console.log(app.baseURL);
}
