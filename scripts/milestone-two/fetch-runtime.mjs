// SPDX-License-Identifier: AGPL-3.0-or-later
// Same ordinary fetch client as milestone one; stdout is only decoded bytes.
const url = new URL(process.argv[2]);
if (url.origin !== 'https://maxima-on-wasm.pages.dev' || url.username || url.password || url.hash) {
  throw new Error('Unexpected runtime asset URL');
}
const limit = 64 * 1024 * 1024;
const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
if (!response.ok) throw new Error(url.href + ': HTTP ' + response.status);
const chunks = [];
let bytes = 0;
for await (const part of response.body) {
  bytes += part.byteLength;
  if (bytes > limit) throw new Error('Runtime asset exceeds size limit: ' + url.href);
  chunks.push(part);
}
process.stdout.write(Buffer.concat(chunks));
