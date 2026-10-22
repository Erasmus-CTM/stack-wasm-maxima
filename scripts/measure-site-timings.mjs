// SPDX-License-Identifier: AGPL-3.0-or-later
// Measure the deployed page through its actual buttons, starting with Validate.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import { chromium } from 'playwright';
import { observeWorkers } from './milestone-two/browser.mjs';

const pageURL = new URL(process.env.TIMING_PAGE_URL || 'https://erasmus-ctm.github.io/stack-wasm-maxima/previews/research/2026-10-native-stack/maxima/examples.html');
assert.equal(pageURL.origin, 'https://erasmus-ctm.github.io');
assert.ok(pageURL.pathname.startsWith('/stack-wasm-maxima/'));
const expectedHTML = process.env.EXPECTED_HTML_SHA256;
assert.match(expectedHTML || '', /^[a-f0-9]{64}$/, 'EXPECTED_HTML_SHA256 must identify the exact published build');
const output = resolve(process.env.TIMING_OUTPUT || 'test-results/page-timings');
const starts = 3, repeats = 5;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseline = JSON.parse(gunzipSync(await readFile('reports/reviewer-site/runs/39754203113/public-smoke.json.gz')));
const selected = baseline.rows.sympy.find(row => row.demoId === 'examples-01' && row.variant === 0);
assert.ok(selected);
const answers = selected.gradeCalls[0].answers;
const report = { schema: 1, createdAt: new Date().toISOString(), pageURL: pageURL.href,
  benchmarkSource: process.env.GITHUB_SHA || null,
  runURL: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  expectedHTML, answersBaselineSource: baseline.sourceRevision,
  method: { startsPerBackend: starts, warmCallsPerStart: repeats,
    workload: 'examples-01, variant 1, the same accepted full-credit rational expression',
    firstAction: 'Validate answers; no authored tests or grading before it',
    uiClock: 'Browser performance.now: captured button click to verdict DOM mutation; excludes later MathJax paint',
    workerClock: 'Browser performance.now: actual worker postMessage to response; first validation RPC excludes separately recorded init',
    deferredNativeStartup: 'Hybrid init starts Python; native startup is included in the first native grade, not the first validation.',
    cache: 'A fresh Chromium process/profile and worker for every sample. OS and CDN caches are not cleared.',
    scope: 'Public GitHub Pages from one GitHub-hosted Linux runner; not a user-device or general workload benchmark.' },
  runner: { platform: os.platform(), architecture: os.arch(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model },
  fingerprints: [], samples: [], passed: false };
await mkdir(output, { recursive: true });

async function fingerprint(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, String(url));
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { url: String(url), bytes: bytes.length, sha256: hash(bytes) };
}

// Install the observer before the real click; polling on the Node side is not
// part of either measured interval and never supplies an assessment response.
async function action(page, card, type) {
  const button = card.locator(type === 'validate' ? '.stack-validate' : '.stack-check');
  assert.equal(await button.isEnabled(), true);
  await card.evaluate((element, type) => {
    const result = element.querySelector('.stack-result');
    const button = element.querySelector(type === 'validate' ? '.stack-validate' : '.stack-check');
    const mark = window.__timingMark = { type, before: window.__ctmHarness.calls.length };
    const observer = new MutationObserver(() => {
      if (mark.startedAt == null || result.dataset.state === 'loading') return;
      if (!result.querySelector('.stack-verdict') && result.dataset.state !== 'error') return;
      mark.completedAt = performance.now();
      mark.uiMs = mark.completedAt - mark.startedAt;
      mark.state = result.dataset.state;
      observer.disconnect();
    });
    observer.observe(result, { attributes: true, attributeFilter: ['data-state'], childList: true, subtree: true });
    button.addEventListener('click', () => { mark.startedAt = performance.now(); }, { capture: true, once: true });
  }, type);
  await button.click();
  await page.waitForFunction(() => window.__timingMark.completedAt != null, null, { timeout: 330000 });
  const data = await page.evaluate(() => ({ mark: window.__timingMark,
    calls: window.__ctmHarness.calls.slice(window.__timingMark.before) }));
  const call = data.calls.find(call => call.type === type);
  assert.ok(call?.response, 'A timed operation must reach the actual worker');
  assert.equal(call.response.ok, true, call.response.error);
  assert.equal(call.response.result.status, type === 'validate' ? 'valid' : 'graded');
  assert.equal(data.mark.state, type === 'validate' ? 'valid' : 'correct');
  if (type === 'grade') assert.equal(call.response.result.score, 1);
  assert.ok(Number.isFinite(data.mark.uiMs) && data.mark.uiMs >= call.elapsedMs);
  return { uiMs: data.mark.uiMs, workerMs: call.elapsedMs, calls: data.calls };
}

async function sample(backend, repetition) {
  let browser, page;
  const result = { backend, repetition, errors: [], consoleErrors: [], httpErrors: [], failedRequests: [], navigation: [] };
  report.samples.push(result); // Preserve partial evidence even when launch or an assertion fails.
  const headers = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
    const context = await browser.newContext();
    page = await context.newPage();
    report.browserVersion = browser.version();
    page.on('pageerror', error => result.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
    page.on('requestfailed', request => result.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => {
      if (response.status() >= 400) result.httpErrors.push({ url: response.url(), status: response.status() });
      if (response.request().isNavigationRequest() && response.request().frame() === page.mainFrame()) {
        const record = { url: response.url(), status: response.status(), fromServiceWorker: response.fromServiceWorker() };
        result.navigation.push(record);
        headers.push((async () => {
          const value = await response.allHeaders();
          record.coop = value['cross-origin-opener-policy']; record.coep = value['cross-origin-embedder-policy'];
          try { const body = await response.body(); record.bytes = body.length; record.sha256 = hash(body); }
          catch (error) { record.bodyError = String(error); } // An interrupted bootstrap may have no readable body.
        })());
      }
    });
    await page.addInitScript(observeWorkers);
    const interrupted = error => /Execution context was destroyed|Cannot find context|interrupted by another navigation|ERR_ABORTED/.test(String(error));
    try { await page.goto(pageURL.href, { waitUntil: 'load', timeout: 90000 }); }
    catch (error) { if (!interrupted(error)) throw error; }
    const deadline = Date.now() + 120000;
    for (;;) {
      try {
        await page.waitForFunction(() => self.crossOriginIsolated && document.querySelectorAll('section.stack-sympy .stack-reset').length === 36,
          null, { timeout: Math.max(1, deadline - Date.now()) });
        break;
      } catch (error) { if (!interrupted(error) || Date.now() >= deadline) throw error; }
    }
    await Promise.all(headers);
    assert.equal(result.navigation.at(-1).coop, 'same-origin');
    assert.equal(result.navigation.at(-1).coep, 'require-corp');
    assert.equal(result.navigation.at(-1).sha256, expectedHTML, 'The actual final browser navigation must use the requested HTML');
    const card = page.locator(`.backend-pair[data-demo-id="examples-01"] .backend-copy[data-backend="${backend}"] section.stack-sympy`);
    const payloadText = await card.locator('script.stack-sympy-data').textContent();
    const payload = JSON.parse(payloadText);
    assert.equal(payload.id, `${backend}-examples-01`);
    assert.equal(payload.variants[0].seed, selected.seed);
    result.payloadSha256 = hash(payloadText);
    result.seed = payload.variants[0].seed;
    for (const [name, value] of Object.entries(answers)) await card.locator(`.stack-answer[data-name=${JSON.stringify(name)}]`).fill(value);
    assert.equal(await page.evaluate(() => window.__ctmHarness.calls.length), 0, 'First Validate must start with no worker calls');
    result.firstValidation = await action(page, card, 'validate');
    const init = result.firstValidation.calls.find(call => call.type === 'init');
    assert.ok(init?.response?.ok);
    result.initializationMs = init.elapsedMs;
    result.initializationStages = init.response.backend?.timings || null;
    if (backend === 'maxima') {
      assert.equal(init.response.backend.maximaState, 'not-started');
      assert.equal(init.response.backend.nativeATCount, 0);
    }
    result.warmValidation = [];
    for (let at = 0; at < repeats; at++) result.warmValidation.push(await action(page, card, 'validate'));
    if (backend === 'maxima') for (const operation of [result.firstValidation, ...result.warmValidation]) {
      const reply = operation.calls.find(call => call.type === 'validate').response;
      assert.equal(reply.backend.maximaState, 'not-started', 'Validation must leave native loading deferred');
      assert.equal(reply.backend.nativeATCount, 0);
    }
    result.firstGrade = await action(page, card, 'grade');
    if (backend === 'maxima') {
      const reply = result.firstGrade.calls.find(call => call.type === 'grade').response;
      assert.equal(reply.backend.maximaState, 'ready');
      result.nativeInitialization = reply.backend.timings;
    }
    result.warmGrade = [];
    for (let at = 0; at < repeats; at++) result.warmGrade.push(await action(page, card, 'grade'));
    result.observation = await page.evaluate(() => window.__ctmHarness);
    assert.equal(result.observation.workers.length, 1);
    assert.equal(result.observation.calls.filter(call => call.type === 'init').length, 1);
    const native = result.observation.events.filter(event => event.data.event === 'maxima-at');
    if (backend === 'maxima') {
      assert.ok(native.length >= repeats + 1);
      for (const call of result.observation.calls) assert.equal(call.response.backend.id, 'maxima');
    } else assert.equal(native.length, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.httpErrors, []);
    assert.deepEqual(result.consoleErrors.filter(text => !/^warning: unsupported syscall: __syscall_(?:prlimit64|getrusage)\s*$/.test(text)), []);
    assert.deepEqual(result.failedRequests.filter(row => !/ERR_ABORTED/.test(row.error || '')), []);
    result.passed = true;
    return result;
  } catch (error) {
    result.failure = {message: String(error), stack: error.stack};
    if (page) try { result.observation = await page.evaluate(() => window.__ctmHarness); } catch {}
    await writeFile(resolve(output, 'timings.json'), JSON.stringify(report, null, 2) + '\n');
    throw error;
  } finally { await Promise.allSettled(headers); if (browser) await browser.close(); }
}

export function statistics(values) {
  assert.ok(values.length && values.every(value => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { n: values.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted.at(-1) };
}

try {
  report.htmlBefore = await fingerprint(pageURL);
  assert.equal(report.htmlBefore.sha256, expectedHTML, 'Measure the exact requested deployed build');
  const base = new URL('../', pageURL);
  for (const path of ['MATERIALIZATION.json', 'stack-sources.json', 'runtime-assets.json', 'native/build-manifest.json', 'backend/worker.js', 'backend/native_adapter.py', 'runtime/maxima-session.js', 'runtime/maxima-child.js']) {
    report.fingerprints.push(await fingerprint(new URL(path, base)));
  }
  const materialization = await (await fetch(new URL('MATERIALIZATION.json', base))).json();
  report.measuredDeploymentSource = (await (await fetch(new URL('native/build-manifest.json', base))).json()).sourceRevision;
  report.sourcePins = materialization.sourcePins;
  report.trackedPageSha256 = materialization.trackedPageSha256;
  report.frontendPatches = materialization.frontendPatches;
  const html = await (await fetch(pageURL, {cache:'no-store'})).text();
  assert.equal(hash(html), report.htmlBefore.sha256);
  const script = /<script\b[^>]*\bsrc=["']([^"']*\/stack-sympy\.js)["']/i.exec(html);
  assert.ok(script, 'The current HTML must identify its real frontend');
  const frontendURL = new URL(script[1], pageURL);
  assert.equal(frontendURL.origin, pageURL.origin);
  assert.ok(frontendURL.pathname.startsWith(base.pathname));
  for (const url of [new URL('worker.js', frontendURL), frontendURL]) {
    report.fingerprints.push(await fingerprint(url));
  }
  assert.equal(report.fingerprints.at(-1).sha256, materialization.frontendPatches[0].materializedSha256);
  for (let at = 0; at < starts; at++) {
    for (const backend of at % 2 ? ['maxima', 'sympy'] : ['sympy', 'maxima']) {
      const result = await sample(backend, at + 1);
      await writeFile(resolve(output, 'timings.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ backend, repetition: at + 1, firstValidateMs: result.firstValidation.uiMs,
        initializationMs: result.initializationMs, stages: result.initializationStages }));
    }
  }
  report.htmlAfter = await fingerprint(pageURL);
  assert.equal(report.htmlAfter.sha256, report.htmlBefore.sha256, 'The deployed build must not change during measurement');
  report.fingerprintsAfter = [];
  for (const before of report.fingerprints) {
    const after = await fingerprint(before.url); report.fingerprintsAfter.push(after);
    assert.equal(after.sha256, before.sha256, 'A measured deployment asset changed: ' + before.url);
  }
  report.statistics = Object.fromEntries(['sympy', 'maxima'].map(backend => {
    const rows = report.samples.filter(row => row.backend === backend);
    assert.equal(rows.length, starts);
    return [backend, { firstValidationUI: statistics(rows.map(row => row.firstValidation.uiMs)),
      initialization: statistics(rows.map(row => row.initializationMs)),
      firstValidationWorker: statistics(rows.map(row => row.firstValidation.workerMs)),
      warmValidationUI: statistics(rows.flatMap(row => row.warmValidation.map(call => call.uiMs))),
      warmValidationWorker: statistics(rows.flatMap(row => row.warmValidation.map(call => call.workerMs))),
      firstGradeUI: statistics(rows.map(row => row.firstGrade.uiMs)),
      firstGradeWorker: statistics(rows.map(row => row.firstGrade.workerMs)),
      ...(backend === 'maxima' ? {deferredNativeInitialization: statistics(rows.map(row => row.nativeInitialization.maximaReadyMs))} : {}),
      warmGradeUI: statistics(rows.flatMap(row => row.warmGrade.map(call => call.uiMs))),
      warmGradeWorker: statistics(rows.flatMap(row => row.warmGrade.map(call => call.workerMs))) }];
  }));
  report.passed = true;
} catch (error) { report.failure = { message: String(error), stack: error.stack }; }
await writeFile(resolve(output, 'timings.json'), JSON.stringify(report, null, 2) + '\n');
const { samples, ...summary } = report;
await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, statistics: report.statistics, failure: report.failure }));
if (!report.passed) process.exitCode = 1;
