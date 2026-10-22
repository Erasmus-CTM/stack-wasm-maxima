// SPDX-License-Identifier: AGPL-3.0-or-later
// An isolated loader comparison; this does not replace public UI timings.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { serveDemo } from '../milestone-two/serve.mjs';

const root = resolve(process.env.LOADER_SITE || '.cache/loader-demo');
const output = resolve(process.env.LOADER_OUTPUT || 'test-results/loader');
const repetitions = Number(process.env.LOADER_REPETITIONS || 3);
const latencyMs = Number(process.env.LOADER_LATENCY_MS || 0);
await mkdir(output, { recursive: true });
await writeFile(resolve(root, 'loader.html'), '<!doctype html><title>Maxima loader benchmark</title>');
await writeFile(resolve(root, 'loader-worker.js'), `
importScripts('runtime/maxima-session.js');
self.onmessage = async ({data}) => {
  const events = [];
  try {
    const started = performance.now();
    const session = new MaximaSession({baseURL: './maxima-runtime/', stackSourceURL: './stack-sources.json',
      preload: data.preload, onEvent: event => events.push(event)});
    const initialization = await session.init();
    const result = session.assess({test: 'AlgEquiv', student: '(x+1)^2', teacher: 'x^2+2*x+1'});
    self.postMessage({ok: true, elapsedMs: performance.now() - started, initialization, result, events});
    session.terminate();
  } catch (error) { self.postMessage({ok: false, error: String(error), stack: error.stack, events}); }
};
`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schema: 1, createdAt: new Date().toISOString(), latencyMs, repetitions,
  sourceRevision: process.env.GITHUB_SHA || null,
  scope: 'Fresh Chromium process/profile/worker per trial; local static server. Added latency is simulated per HTTP request, not an internet benchmark.',
  files: [], samples: [], passed: false };
for (const path of ['stack-sources.json', 'runtime/maxima-child.js', 'runtime/maxima-session.js', 'maxima-runtime/runtime-preload.json']) {
  const bytes = await readFile(resolve(root, path)); report.files.push({path, sha256: hash(bytes), bytes: bytes.length});
}
const app = await serveDemo({root, latencyMs});
try {
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const preload of repetition % 2 ? [false, true] : [true, false]) {
      const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined});
      try {
        report.browser = browser.version();
        const page = await browser.newPage();
        const networkStart = app.requests.length;
        await page.goto(app.baseURL + 'loader.html');
        const result = await page.evaluate(preload => new Promise(resolveResult => {
          const worker = new Worker('loader-worker.js');
          const timer = setTimeout(() => { worker.terminate(); resolveResult({ok:false, error:'Loader timeout'}); }, 240000);
          worker.onmessage = ({data}) => { clearTimeout(timer); worker.terminate(); resolveResult(data); };
          worker.onerror = error => { clearTimeout(timer); worker.terminate(); resolveResult({ok:false,error:error.message}); };
          worker.postMessage({preload});
        }), preload);
        const row = {repetition, preload, ...result, requests: app.requests.slice(networkStart)};
        report.samples.push(row);
        await writeFile(resolve(output, 'loader.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({repetition, preload, ok:result.ok, initialization:result.initialization, error:result.error,
          requests:row.requests.length, headRequests:row.requests.filter(x=>x.method==='HEAD').length}));
        assert.equal(result.ok, true, result.error);
        assert.equal(result.result.cas_valid, true);
        assert.equal(result.result.correct, true);
        assert.equal(row.requests.some(x => x.status >= 400), false);
      } finally { await browser.close(); }
    }
  }
  report.passed = true;
} catch(error) { report.failure = String(error); console.error(report.failure); }
finally { await app.close(); await writeFile(resolve(output, 'loader.json'), JSON.stringify(report, null, 2) + '\n'); }
if (!report.passed) process.exitCode = 1;
