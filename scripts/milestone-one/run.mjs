// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'test-results/milestone-one');
const cache = join(root, '.cache/maxima-runtime');
await mkdir(out, { recursive: true });
await mkdir(cache, { recursive: true });
const lock = JSON.parse(await readFile(join(root, 'measurements/2026-10-21-runtime-assets.json')));
const prepared = JSON.parse(await readFile(join(out, 'prepared.json')));
const supplement = JSON.parse(await readFile(join(root, 'measurements/2026-10-21-runtime-dependencies.json')));
const runtimeURLs = [...lock.groups.maximaCore, ...lock.groups.maximaOptionalModules, ...supplement.assets.map(asset => asset.url)];
const allAssets = [...lock.assets, ...supplement.assets];
const expected = new Map(runtimeURLs.map(url => [new URL(url).pathname, allAssets.find(asset => asset.url === url)]));
const served = new Map();
const hash = data => createHash('sha256').update(data).digest('hex');
const errors = [];
async function resource(pathname) {
  const known = expected.get(pathname);
  const sharePrefix = '/share/maxima/' + lock.deployment.maximaShareDirectory + '/';
  if (!known && !pathname.startsWith(sharePrefix)) throw new Error('Unapproved runtime path: ' + pathname);
  if (pathname.includes('..') || pathname.includes('\\')) throw new Error('Unsafe path');
  const path = join(cache, pathname.slice(1));
  let data;
  try { data = await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const url = new URL(pathname, lock.deployment.maximaBaseURL).href;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
    data = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  const digest = hash(data);
  if (known && known.sha256 !== digest) throw new Error('Pinned runtime hash mismatch: ' + pathname);
  served.set(pathname, { path: pathname, url: new URL(pathname, lock.deployment.maximaBaseURL).href,
    fileBytes: data.length, sha256: digest, pinVerified: Boolean(known) });
  return data;
}
await Promise.all([...expected.keys()].map(resource));

const client = await readFile(join(root, 'scripts/milestone-one/client.js'));
const worker = await readFile(join(root, 'scripts/milestone-one/worker.js'));
const html = Buffer.from('<!doctype html><meta charset="utf-8"><title>CTM STACK Wasm dependency check</title><pre id="status">Ready to test the backend dependency.</pre><script src="/m1-client.js"></script>');
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    let data = path === '/' ? html : path === '/m1-client.js' ? client : path === '/m1-worker.js' ? worker : await resource(path);
    const type = path.endsWith('.wasm') ? 'application/wasm'
      : path.endsWith('.js') ? 'application/javascript'
      : path === '/' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    let status = 200;
    if (request.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!range) throw new Error('Unsupported byte range');
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : data.length - 1;
      if (start > end || end >= data.length) {
        response.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + data.length }); response.end(); return;
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + data.length;
      data = data.subarray(start, end + 1); status = 206;
    }
    headers['Content-Length'] = data.length;
    response.writeHead(status, headers);
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    errors.push({ path: request.url, error: String(error.stack || error) });
    response.writeHead(500, { 'Content-Type': 'text/plain' }); response.end(String(error));
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const address = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const version of prepared.versions) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLines = [];
    page.on('console', message => consoleLines.push(message.type() + ': ' + message.text()));
    page.on('pageerror', error => consoleLines.push('pageerror: ' + error.stack));
    let result;
    try {
      await page.goto(address);
      result = await page.evaluate(({ files, batch }) => window.runMilestoneOne({ files, batch }),
        { files: version.files, batch: version.batch });
    } catch (error) { result = { ok: false, error: String(error.stack || error), stdout: '' }; }
    result.browser = browser.version();
    result.stackRevision = version.stackRevision;
    result.sourceRevision = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    result.scope = 'Direct official answer tests in a fresh worker per STACK revision; selected cases share the session';
    result.files = version.files.map(({ content, ...record }) => record);
    result.servedAssets = [...served.values()];
    result.serverErrors = [...errors];
    await writeFile(join(out, 'browser-' + version.stackRevision.slice(0, 7) + '.json'), JSON.stringify(result, null, 2) + '\n');
    await writeFile(join(out, 'console-' + version.stackRevision.slice(0, 7) + '.log'), consoleLines.join('\n') + '\n');
    await page.screenshot({ path: join(out, 'browser-' + version.stackRevision.slice(0, 7) + '.png'), fullPage: true }).catch(() => {});
    console.log(JSON.stringify({ stackRevision: version.stackRevision, ok: result.ok,
      readyMs: result.readyMs, totalMs: result.totalMs, error: result.error }));
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
