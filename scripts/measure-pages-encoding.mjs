// SPDX-License-Identifier: AGPL-3.0-or-later
// What GitHub Pages sends for the published files: status, Content-Encoding and
// encoded against decoded bytes. HTTP only; nothing is executed. Each decoded
// body must equal the file on the gh-pages checkout, so the numbers describe
// the deployed build and not a neighbour.
import { get as getHttp } from 'node:http';
import { get as getHttps } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const BASE = process.env.PAGES_BASE_URL || 'https://erasmus-ctm.github.io/stack-wasm-maxima/';
const ROOT = process.env.PAGES_CHECKOUT || '.pages';
const PATHS = (process.env.PAGES_PATHS || 'maxima-runtime/ maxima/native.html').split(/\s+/).filter(Boolean);
const OUT = process.env.PAGES_OUT || 'test-results/pages-encoding';
// What Chromium sends for a fetch from a worker.
const ACCEPT_ENCODING = 'gzip, deflate, br, zstd';
const MAX_BYTES = 128 * 1024 * 1024;
const PARALLEL = 4;

const DECODERS = {
  identity: body => body,
  gzip: body => gunzipSync(body, { maxOutputLength: MAX_BYTES }),
  deflate: body => inflateSync(body, { maxOutputLength: MAX_BYTES }),
  br: body => brotliDecompressSync(body, { maxOutputLength: MAX_BYTES }),
  zstd: body => zstdDecompressSync(body, { maxOutputLength: MAX_BYTES }),
};

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function files(path) {
  const full = join(ROOT, path);
  if (!path.endsWith('/')) return [path];
  const entries = await readdir(full, { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile())
    .map(entry => relative(ROOT, join(entry.parentPath, entry.name)))
    .sort();
}

function fetchEncoded(url) {
  return new Promise((resolveRequest, reject) => {
    const get = new URL(url).protocol === 'http:' ? getHttp : getHttps;
    const request = get(url, { headers: { 'Accept-Encoding': ACCEPT_ENCODING } }, response => {
      const chunks = [];
      let received = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        received += chunk.length;
        if (received > MAX_BYTES) response.destroy(new Error(`${url}: exceeds measurement size limit`));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (!response.complete) reject(new Error(`${url}: incomplete HTTP response`));
        else resolveRequest({ status: response.statusCode, headers: response.headers, encoded: Buffer.concat(chunks) });
      });
    });
    request.setTimeout(60000, () => request.destroy(new Error(`${url}: request timed out`)));
    request.on('error', reject);
  });
}

async function measure(path) {
  const url = new URL(path, BASE).href;
  const local = await readFile(join(ROOT, path));
  const { status, headers, encoded } = await fetchEncoded(url);
  const encoding = headers['content-encoding'] || 'identity';
  const record = {
    path, url, status, contentEncoding: encoding, contentType: headers['content-type'] ?? null,
    cacheControl: headers['cache-control'] ?? null, vary: headers.vary ?? null,
    transferBytes: encoded.length, fileBytes: local.length, problem: null,
  };
  if (status !== 200) record.problem = `HTTP ${status}`;
  else if (!DECODERS[encoding]) record.problem = `unsupported Content-Encoding ${encoding}`;
  else if (sha256(DECODERS[encoding](encoded)) !== sha256(local)) record.problem = 'decoded body differs from the gh-pages file';
  return record;
}

async function inParallel(items, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

function summary(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${extname(record.path) || '(none)'} ${record.contentType ?? ''} ${record.contentEncoding}`;
    const group = groups.get(key) ?? { extension: extname(record.path) || '(none)', contentType: record.contentType,
      contentEncoding: record.contentEncoding, files: 0, transferBytes: 0, fileBytes: 0 };
    group.files += 1;
    group.transferBytes += record.transferBytes;
    group.fileBytes += record.fileBytes;
    groups.set(key, group);
  }
  const total = records.reduce((sum, record) => ({ transferBytes: sum.transferBytes + record.transferBytes,
    fileBytes: sum.fileBytes + record.fileBytes }), { transferBytes: 0, fileBytes: 0 });
  return { groups: [...groups.values()].sort((a, b) => b.fileBytes - a.fileBytes), total };
}

const megabytes = bytes => (bytes / 1e6).toFixed(2);

const paths = (await Promise.all(PATHS.map(files))).flat();
const records = await inParallel(paths, measure);
const { groups, total } = summary(records);
const problems = records.filter(record => record.problem);

const lines = [
  '# What GitHub Pages sends', '',
  `Base \`${BASE}\`, request \`Accept-Encoding: ${ACCEPT_ENCODING}\`, ${records.length} files; `
    + 'each decoded body compared with the gh-pages checkout.', '',
  '| Extension | Content-Type | Content-Encoding | Files | Transfer MB | File MB |',
  '|---|---|---|---:|---:|---:|',
  ...groups.map(group => `| \`${group.extension}\` | ${group.contentType ?? '—'} | ${group.contentEncoding} | ${group.files} `
    + `| ${megabytes(group.transferBytes)} | ${megabytes(group.fileBytes)} |`),
  `| **All** | | | ${records.length} | **${megabytes(total.transferBytes)}** | **${megabytes(total.fileBytes)}** |`, '',
  '| Largest files | Content-Encoding | Transfer MB | File MB |', '|---|---|---:|---:|',
  ...[...records].sort((a, b) => b.fileBytes - a.fileBytes).slice(0, 12)
    .map(record => `| \`${record.path}\` | ${record.contentEncoding} | ${megabytes(record.transferBytes)} | ${megabytes(record.fileBytes)} |`),
  '', problems.length ? `**${problems.length} problem(s):**` : 'No problems.',
  ...problems.map(record => `- \`${record.path}\`: ${record.problem}`), '',
];

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'pages-encoding.json'), JSON.stringify({ base: BASE, acceptEncoding: ACCEPT_ENCODING,
  measuredAt: new Date().toISOString(), total, groups, records }, null, 1) + '\n');
await writeFile(join(OUT, 'pages-encoding.md'), lines.join('\n'));
console.log(lines.join('\n'));
if (problems.length) process.exitCode = 1;
