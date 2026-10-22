// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise the tracked QMD's real CTM controls and inspect real worker RPCs.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { serveDemo } from '../milestone-two/serve.mjs';
import { observeWorkers } from '../milestone-two/browser.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = resolve(process.argv[2] || 'site/_site');
const output = resolve(process.argv[3] || 'test-results/reviewer-site');
await mkdir(output, { recursive: true });
const report = { schema: 1, root, sourceRevision: process.env.GITHUB_SHA ||
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  cards: 0, variants: 0, authoredTestRows: 0, crossOriginIsolated: false,
  validation: false, grade: false, payloads: [], tests: [], errors: [], consoleErrors: [],
  failedRequests: [], httpErrors: [], passed: false };
let app, browser, page;

async function action(card, type, timeout = 330000) {
  const before = await page.evaluate(() => window.__ctmHarness.calls.length);
  const button = card.locator({ tests: '.stack-tests', validate: '.stack-validate', grade: '.stack-check' }[type]);
  assert.equal(await button.isEnabled(), true, type + ' must be available through the real UI');
  await button.click();
  await page.waitForFunction(({ before, type }) =>
    window.__ctmHarness.calls.slice(before).some(call => call.type === type && call.response || call.response?.ok === false) ||
    document.querySelector('.stack-result[data-state="error"]'), { before, type }, { timeout });
  const call = await page.evaluate(({ before, type }) => window.__ctmHarness.calls.slice(before)
    .find(call => call.type === type && call.response), { before, type });
  assert.ok(call, 'The ' + type + ' request did not reach the grading worker');
  assert.equal(call.response.ok, true, type + ': ' + (call.response.error || 'Worker failed'));
  assert.equal(call.response.backend?.id, 'maxima', 'The tracked page must actually use the Maxima backend');
  assert.ok(call.response.result && typeof call.response.result === 'object');
  const events = await page.evaluate(({ id, worker }) => window.__ctmHarness.events
    .filter(event => event.worker === worker && event.data?.requestId === id), call);
  return { call, events };
}

function assertRoutes(question, result, events) {
  const tests = new Set();
  for (const actual of result.results ? result.results.map(row => row.actual) : [result]) {
    for (const [name, detail] of Object.entries(actual.prts || {})) {
      const prt = question.prts.find(item => item.name === name);
      for (const branch of detail.path || []) {
        const node = prt?.nodes.find(item => String(item.name) === String(branch.node));
        assert.ok(node, 'Every observed grading branch must identify its authored node');
        tests.add(node.test);
      }
    }
  }
  for (const test of tests) assert.ok(events.some(event => test === 'PythonChecker' ?
    event.data.event === 'python-checker' : event.data.event === 'maxima-at' && event.data.test === test),
  'Missing actual backend routing evidence for ' + test);
  return [...tests];
}

try {
  const manifest = JSON.parse(await readFile(join(repository, 'demos/manifest.json')));
  const expected = manifest.demos.filter(demo => demo.sourcePage === 'examples.qmd');
  const accepted = JSON.parse(await readFile(join(repository, 'reports/milestone-two/latest.json')));
  assert.equal(accepted.passed, true, 'Use the accepted milestone-two reference');
  const run = new URL(accepted.runURL).pathname.split('/').at(-1);
  assert.match(run, /^\d+$/);
  const evidence = JSON.parse(await readFile(join(repository, 'reports/milestone-two/runs', run, 'browser.json')));
  const acceptedPage = evidence.pages.find(item => item.backend === 'maxima' && item.page === 'examples');
  const expectedVariants = acceptedPage.variants.length;
  const expectedRows = acceptedPage.variants.reduce((count, row) => count + row.authoredTests.response.result.results.length, 0);
  report.reference = { sourceRevision: accepted.sourceRevision, runURL: accepted.runURL,
    cards: expected.length, variants: expectedVariants, authoredTestRows: expectedRows };
  report.files = await Promise.all(['scripts/site/smoke.mjs', 'scripts/milestone-two/browser.mjs', 'site/maxima/examples.qmd'].map(async path => {
    const bytes = await readFile(join(repository, path));
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  app = await serveDemo({ root });
  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();
  page = await browser.newPage();
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ url: response.url(), status: response.status() }); });
  await page.addInitScript(observeWorkers);
  const response = await page.goto(new URL('maxima/examples.html', app.baseURL).href, { waitUntil: 'load', timeout: 90000 });
  assert.equal(response.status(), 200);
  report.crossOriginIsolated = await page.evaluate(() => self.crossOriginIsolated);
  assert.equal(report.crossOriginIsolated, true);
  await page.waitForFunction(() => document.querySelectorAll('section.stack-sympy .stack-reset').length === 18);
  const cards = page.locator('section.stack-sympy:not(.stack-diagnostic)');
  report.cards = await cards.count();
  assert.equal(report.cards, expected.length);
  const sources = await cards.evaluateAll(items => items.map(card => card.querySelector('script.stack-sympy-data')?.textContent));
  // The accepted collector uses Python's sorted JSON, including float spelling.
  // Hash original payload text before JavaScript can turn 0.0 into 0.
  const hashes = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,hashlib\nprint(json.dumps([hashlib.sha256(json.dumps(json.loads(s),ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest() for s in json.load(sys.stdin)]))'],
  { input: JSON.stringify(sources), encoding: 'utf8' }));
  const acceptedHashes = new Map(evidence.frozenPayloads.hashes.map(row => [row.demoId, row.payloadSha256]));
  for (let index = 0; index < sources.length; index++) {
    const payload = JSON.parse(sources[index]), demo = expected[index], card = cards.nth(index);
    assert.equal(payload.question.name, demo.options.question, 'The tracked QMD must preserve the accepted question order');
    assert.equal(hashes[index], acceptedHashes.get(demo.id), 'The rendered frozen payload must match the accepted examples: ' + demo.id);
    report.payloads.push({ demoId: demo.id, sha256: hashes[index], variants: payload.variants.length });
    for (let variant = 0; variant < payload.variants.length; variant++) {
      console.log(JSON.stringify({ demoId: demo.id, variant, seed: payload.variants[variant].seed }));
      await card.locator('.stack-variant').selectOption(String(variant));
      assert.equal(await card.locator('.stack-check').isDisabled(), true, 'Variant changes must require validation');
      const tests = await action(card, 'tests');
      const result = tests.call.response.result;
      assert.equal(result.passed, true, 'Every authored question test must pass');
      assert.equal(result.results.length, payload.question.qtests.length);
      assert.ok(result.results.length > 0);
      for (const [at, row] of result.results.entries()) {
        assert.equal(row.testcase, payload.question.qtests[at].testcase);
        assert.equal(row.seed, payload.variants[variant].seed);
        assert.equal(row.passed, true, 'Authored test failed: ' + demo.id + '/' + row.testcase);
      }
      const routes = assertRoutes(payload.question, result, tests.events);
      report.tests.push({ demoId: demo.id, variant, seed: payload.variants[variant].seed, ...tests, routes });
      report.variants++;
      report.authoredTestRows += result.results.length;
      if (index === 0 && variant === 0) {
        const positive = result.results.find(row => row.actual?.status === 'graded' && row.actual.score === 1);
        assert.ok(positive, 'The first card must provide an authored full-credit response');
        for (const [name, text] of Object.entries(positive.inputs)) {
          const input = card.locator('input.stack-answer[data-name=' + JSON.stringify(name) + ']');
          assert.equal(await input.count(), 1, 'The scalar smoke input must exist');
          await input.fill(text);
        }
        const validation = await action(card, 'validate');
        report.validationEvidence = validation;
        assert.equal(validation.call.response.result.status, 'valid');
        assert.ok(Object.values(validation.call.response.result.inputs).every(input => input.valid === true));
        assert.equal(await card.locator('.stack-check').isEnabled(), true);
        assert.equal(await card.locator('.stack-result').getAttribute('data-state'), 'valid');
        report.validation = true;
        const grade = await action(card, 'grade', 120000);
        report.gradeEvidence = grade;
        assert.equal(grade.call.response.result.status, 'graded');
        assert.equal(grade.call.response.result.score, 1, 'Actual grading must award full credit');
        assert.deepEqual(grade.call.answers, positive.inputs, 'The UI must preserve the authored scalar answer text');
        assert.ok(grade.events.some(event => event.data.event === 'maxima-at' && event.data.cas_valid === true && event.data.correct === true),
          'Full credit must come from an actual successful native Maxima answer test');
        assertRoutes(payload.question, grade.call.response.result, grade.events);
        assert.equal(await card.locator('.stack-result').getAttribute('data-state'), 'correct');
        assert.equal((await card.locator('.stack-result .stack-verdict').textContent()).trim(), 'Correct.');
        report.grade = true;
        await card.screenshot({ path: output + '/maxima-correct-card.png', animations: 'disabled' });
        await page.screenshot({ path: output + '/maxima-examples.png', fullPage: false, animations: 'disabled' });
        await card.locator('.stack-reset').click();
        assert.equal(await card.locator('.stack-check').isDisabled(), true);
        assert.equal(await card.locator('.stack-result').textContent(), '');
      }
    }
  }
  assert.equal(report.variants, expectedVariants, 'All accepted worked variants must execute');
  assert.equal(report.authoredTestRows, expectedRows, 'All accepted worked author tests must execute');
  report.observation = await page.evaluate(() => window.__ctmHarness);
  assert.equal(report.observation.workers.length, 1, 'All cards must reuse one persistent grading worker');
  assert.equal(report.validation, true);
  assert.equal(report.grade, true);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.httpErrors, [], 'No actual HTTP 4xx/5xx response is allowed');
  const failed = report.failedRequests.filter(row => {
    if (/ERR_ABORTED/.test(row.error || '')) return false;
    // Quarto 1.8.27 requests this obsolete optional ES6 shim. COEP blocks it,
    // which is expected because the Maxima worker requires isolation and the
    // supported browsers already provide ES6.
    return !(row.url === 'https://cdnjs.cloudflare.com/polyfill/v3/polyfill.min.js?features=es6' &&
      /NotSameOriginAfterDefaultedToSameOriginByCoep/.test(row.error || ''));
  });
  assert.deepEqual(failed, []);
  assert.deepEqual(app.requests.filter(row => row.status >= 400), [], 'The static host must serve every requested resource');
  report.passed = true;
} catch (error) {
  report.failure = { message: String(error), stack: error.stack };
  if (page && !page.isClosed()) {
    report.observation = await page.evaluate(() => window.__ctmHarness).catch(() => null);
    await page.screenshot({ path: output + '/failure.png', fullPage: false }).catch(() => {});
  }
} finally {
  if (browser) await browser.close();
  if (app) { report.serverRequests = app.requests; await app.close(); }
  await writeFile(output + '/smoke.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, cards: report.cards, variants: report.variants,
  authoredTestRows: report.authoredTestRows, validation: report.validation, grade: report.grade, failure: report.failure }));
if (!report.passed) process.exitCode = 1;
