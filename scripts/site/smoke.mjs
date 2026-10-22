// SPDX-License-Identifier: AGPL-3.0-or-later
// Verify both backend copies on the tracked page through real CTM controls.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { serveDemo } from '../milestone-two/serve.mjs';
import { observeWorkers, matrixCells, compareBackends } from '../milestone-two/browser.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = resolve(process.argv[2] || 'site/_site');
const output = resolve(process.argv[3] || 'test-results/reviewer-site');
const reviewerURL = process.env.REVIEWER_URL ? new URL(process.env.REVIEWER_URL) : null;
if (reviewerURL) {
  assert.equal(reviewerURL.protocol, 'https:', 'Live reviewer verification requires HTTPS');
  if (!reviewerURL.pathname.endsWith('/')) reviewerURL.pathname += '/';
}
await mkdir(output, { recursive: true });
const report = { schema: 2, root, sourceRevision: process.env.GITHUB_SHA ||
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  serving: reviewerURL ? { mode: 'public', baseURL: reviewerURL.href } : { mode: 'local', root },
  cards: 0, pairs: 0, crossOriginIsolated: false, payloads: [], rows: { sympy: [], maxima: [] },
  rpcScopes: [], screenshots: [], errors: [], consoleErrors: [], failedRequests: [], httpErrors: [],
  differences: [], passed: false };
let app, browser, page;
const pools = new Map();

async function action(card, type, scope, timeout = 330000) {
  const before = await page.evaluate(() => window.__ctmHarness.calls.length);
  const button = card.locator({ tests: '.stack-tests', validate: '.stack-validate', grade: '.stack-check' }[type]);
  assert.equal(await button.isEnabled(), true, type + ' must be available through the real UI');
  await button.click();
  await page.waitForFunction(({ before, type }) =>
    window.__ctmHarness.calls.slice(before).some(call => call.type === type && call.response || call.response?.ok === false) ||
    document.querySelector('.stack-result[data-state="error"]'), { before, type }, { timeout });
  const call = await page.evaluate(({ before, type }) => window.__ctmHarness.calls.slice(before)
    .find(call => call.type === type && call.response), { before, type });
  assert.ok(call, 'The ' + type + ' request did not reach its grading worker');
  assert.equal(call.response.ok, true, type + ': ' + (call.response.error || 'Worker failed'));
  assert.ok(call.response.result && typeof call.response.result === 'object');
  const observation = await page.evaluate(({ id, worker }) => ({
    worker: window.__ctmHarness.workers[worker],
    events: window.__ctmHarness.events.filter(event => event.worker === worker && event.data?.requestId === id),
  }), call);
  assert.equal(observation.worker.url, report.expectedWorkers[scope.backend], 'The card must use its own backend pool');
  if (pools.has(scope.backend)) assert.equal(call.worker, pools.get(scope.backend), 'Reuse one worker per backend');
  else pools.set(scope.backend, call.worker);
  if (scope.backend === 'maxima') assert.equal(call.response.backend?.id, 'maxima');
  else {
    assert.notEqual(call.response.backend?.id, 'maxima', 'The SymPy card must retain the Python backend');
    assert.equal(observation.events.filter(event => event.data.event === 'maxima-at').length, 0, 'SymPy must never dispatch to Maxima');
  }
  report.rpcScopes.push({ ...scope, type, worker: call.worker, id: call.id });
  return { call, events: observation.events };
}

function assertRoutes(question, result, events, backend) {
  const tests = new Set();
  for (const actual of result.results ? result.results.map(row => row.actual) : [result]) {
    for (const [name, detail] of Object.entries(actual.prts || {})) {
      const prt = question.prts.find(item => item.name === name);
      for (const branch of detail.path || []) {
        const node = prt?.nodes.find(item => String(item.name) === String(branch.node));
        assert.ok(node, 'Observed grading branches must identify authored nodes');
        tests.add(node.test);
      }
    }
  }
  if (backend === 'maxima') {
    for (const test of tests) assert.ok(events.some(event => test === 'PythonChecker' ?
      event.data.event === 'python-checker' : event.data.event === 'maxima-at' && event.data.test === test),
    'Missing actual backend routing evidence for ' + test);
  } else assert.equal(events.filter(event => event.data.event === 'maxima-at').length, 0);
  return [...tests];
}

async function fillAnswers(card, answers) {
  const fields = await card.locator('.stack-answer[data-name]').evaluateAll(items => items.map(item =>
    ({ name: item.dataset.name, matrix: item.classList.contains('stack-matrix') })));
  assert.equal(fields.length, Object.keys(answers).length, 'Supply each authored input');
  for (const field of fields) {
    const host = card.locator('.stack-answer[data-name=' + JSON.stringify(field.name) + ']');
    assert.equal(typeof answers[field.name], 'string');
    if (!field.matrix) { await host.fill(answers[field.name]); continue; }
    const rows = matrixCells(answers[field.name]), target = { rows: rows.length, cols: rows[0].length };
    for (const [axis, attribute] of [['row', 'rows'], ['col', 'cols']]) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const actual = Number(await host.locator('.math-dynamic-mat').getAttribute('data-' + attribute));
        if (actual === target[attribute]) break;
        const button = host.locator('[data-dynamic-action=' + JSON.stringify((actual < target[attribute] ? 'add-' : 'remove-') + axis) + ']');
        assert.equal(await button.isEnabled(), true, 'The matrix editor must reach the authored dimensions');
        await button.click();
      }
      assert.equal(Number(await host.locator('.math-dynamic-mat').getAttribute('data-' + attribute)), target[attribute]);
    }
    for (let row = 0; row < rows.length; row++) for (let col = 0; col < rows[0].length; col++) {
      await host.locator('input[data-matrix-row="' + (row + 1) + '"][data-matrix-column="' + (col + 1) + '"]').fill(rows[row][col]);
    }
  }
}

const state = card => card.evaluate(element => ({
  fields: [...element.querySelectorAll('.stack-answer[data-name]')].map(input => ({ name: input.dataset.name,
    value: input.matches('input,textarea') ? input.value : null,
    cells: [...input.querySelectorAll('input[data-matrix-row]')].map(cell => cell.value),
    shape: input.querySelector('.math-dynamic-mat') ? [input.querySelector('.math-dynamic-mat').dataset.rows, input.querySelector('.math-dynamic-mat').dataset.cols] : null,
  })), resultState: element.querySelector('.stack-result').dataset.state || null,
  verdict: element.querySelector('.stack-result .stack-verdict')?.textContent || null,
  previews: [...element.querySelectorAll('.stack-validation[data-name]')].map(item =>
    ({ name: item.dataset.name, state: item.dataset.state || null, latex: item.dataset.latex || null })),
  checkDisabled: element.querySelector('.stack-check').disabled,
}));

async function openAssessment(url) {
  const started = Date.now(), deadline = started + 180000;
  const navigation = report.navigation = { requestedURL: url, responses: [], bootstrapInterruptions: [] };
  const pending = [];
  const observer = response => {
    const request = response.request();
    if (!request.isNavigationRequest()) return;
    try { if (request.frame() !== page.mainFrame()) return; } catch { return; }
    const record = { url: response.url(), status: response.status(), fromServiceWorker: response.fromServiceWorker() };
    navigation.responses.push(record);
    pending.push(response.allHeaders().then(headers => Object.assign(record, {
      coop: headers['cross-origin-opener-policy'], coep: headers['cross-origin-embedder-policy'],
    })));
  };
  page.on('response', observer);
  const interrupted = error => Boolean(reviewerURL) &&
    /Execution context was destroyed|Cannot find context|interrupted by another navigation|ERR_ABORTED/.test(String(error));
  try {
    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: 90000 });
      assert.equal(response.status(), 200);
    } catch (error) {
      if (!interrupted(error)) throw error;
      navigation.bootstrapInterruptions.push(String(error));
    }
    for (;;) {
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, 'The isolation bootstrap did not finish');
      try {
        await page.waitForFunction(() => self.crossOriginIsolated && document.readyState === 'complete', null, { timeout: remaining });
        await page.waitForLoadState('load', { timeout: Math.max(1, deadline - Date.now()) });
        navigation.document = await page.evaluate(() => ({
          url: location.href, crossOriginIsolated: self.crossOriginIsolated,
          controller: navigator.serviceWorker?.controller?.scriptURL || null,
        }));
        break;
      } catch (error) {
        if (!interrupted(error)) throw error;
        navigation.bootstrapInterruptions.push(String(error));
      }
    }
    await Promise.all(pending);
    assert.equal(navigation.document.crossOriginIsolated, true);
    const expected = new URL(url), actual = new URL(navigation.document.url);
    assert.equal(actual.origin, expected.origin);
    const canonical = pathname => pathname.replace(/(?:\.html)?\/?$/, '');
    assert.equal(canonical(actual.pathname), canonical(expected.pathname), 'The bootstrap must return to the requested assessment page');
    const effective = navigation.responses.at(-1);
    assert.ok(effective, 'Capture the effective navigation response');
    assert.equal(effective.status, 200);
    assert.equal(effective.coop, 'same-origin');
    assert.ok(['require-corp', 'credentialless'].includes(effective.coep));
    navigation.elapsedMs = Date.now() - started;
  } finally {
    await Promise.allSettled(pending);
    page.off('response', observer);
  }
}

try {
  const manifest = JSON.parse(await readFile(join(repository, 'demos/manifest.json')));
  const expected = manifest.demos.filter(demo => demo.sourcePage === 'examples.qmd');
  const materialization = JSON.parse(await readFile(join(root, 'MATERIALIZATION.json')));
  report.materialization = materialization;
  assert.equal(materialization.cards, expected.length * 2);
  assert.equal(materialization.variants, expected.reduce((count, demo) => count + Number(demo.options.variants || 1), 0) * 2);
  assert.equal(materialization.pythonCheckerCards, 12);
  assert.deepEqual(materialization.backends, ['sympy', 'maxima']);
  assert.deepEqual(materialization.pairs, expected.map((demo, index) => ({ demoId: demo.id,
    sympyId: 'sympy-' + demo.id, maximaId: 'maxima-' + demo.id,
    acceptedPayloadId: demo.authoredIdentifier || 'stack-sympy-' + (index + 1) })));
  const accepted = JSON.parse(await readFile(join(repository, 'reports/milestone-two/runs/39721228518/latest.json')));
  assert.equal(accepted.passed, true);
  assert.equal(accepted.sourceRevision, '2493268c2bf3eb9941407f376d20a07fb5da4ec9');
  const run = new URL(accepted.runURL).pathname.split('/').at(-1); assert.match(run, /^\d+$/);
  const evidence = JSON.parse(await readFile(join(repository, 'reports/milestone-two/runs', run, 'browser.json')));
  const reference = evidence.pages.find(item => item.backend === 'maxima' && item.page === 'examples');
  report.reference = { sourceRevision: accepted.sourceRevision, runURL: accepted.runURL, pairs: expected.length,
    variantsPerBackend: reference.variants.length,
    authoredRowsPerBackend: reference.variants.reduce((count, row) => count + row.authoredTests.response.result.results.length, 0) };
  report.files = await Promise.all(['scripts/site/smoke.mjs', 'scripts/milestone-two/browser.mjs', 'site/maxima/examples.qmd'].map(async path => {
    const bytes = await readFile(join(repository, path));
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  if (!reviewerURL) app = await serveDemo({ root });
  const baseURL = reviewerURL ? reviewerURL.href : app.baseURL;
  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version(); page = await browser.newPage();
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ url: response.url(), status: response.status() }); });
  await page.addInitScript(observeWorkers);
  await openAssessment(new URL('maxima/examples.html', baseURL).href);
  report.crossOriginIsolated = await page.evaluate(() => self.crossOriginIsolated); assert.equal(report.crossOriginIsolated, true);
  await page.waitForFunction(() => document.querySelectorAll('section.stack-sympy .stack-reset').length === 36);
  report.expectedWorkers = await page.evaluate(() => ({
    maxima: new URL(window.CTMStackBackends.maxima.workerURL, document.baseURI).href,
    sympy: new URL('worker.js', [...document.scripts].find(script => /\/stack-sympy\.js$/.test(script.src)).src).href,
  }));
  assert.notEqual(report.expectedWorkers.sympy, report.expectedWorkers.maxima);
  report.cards = await page.locator('section.stack-sympy').count(); assert.equal(report.cards, expected.length * 2);
  report.pairs = await page.locator('.backend-pair').count(); assert.equal(report.pairs, expected.length);
  assert.equal(await page.locator('.backend-copy').count(), expected.length * 2);
  assert.deepEqual(await page.locator('.backend-pair').evaluateAll(items => items.map(item => item.dataset.demoId)), expected.map(demo => demo.id));
  const duplicates = await page.locator('[id]').evaluateAll(items => items.map(item => item.id).filter((id, index, ids) => ids.indexOf(id) !== index));
  assert.deepEqual(duplicates, [], 'Same-page copies must not duplicate DOM or matrix identifiers');
  const sources = await page.locator('.backend-pair').evaluateAll(pairs => pairs.flatMap(pair =>
    [...pair.querySelectorAll('.backend-copy')].map(copy => ({ demoId: pair.dataset.demoId, backend: copy.dataset.backend,
      source: copy.querySelector('script.stack-sympy-data')?.textContent }))));
  const acceptedHashes = new Map(evidence.frozenPayloads.hashes.map(row => [row.demoId, row.payloadSha256]));
  const canonicalRows = sources.map(row => {
    const at = expected.findIndex(demo => demo.id === row.demoId); assert.ok(at >= 0);
    return { ...row, canonicalId: expected[at].authoredIdentifier || 'stack-sympy-' + (at + 1),
      presentationId: row.backend + '-' + row.demoId };
  });
  const hashes = JSON.parse(execFileSync('python3', ['-c', [
    'import json,sys,hashlib',
    'result=[]',
    'for row in json.load(sys.stdin):',
    ' payload=json.loads(row["source"])',
    ' assert payload["id"]==row["presentationId"], "Unexpected presentation namespace"',
    ' payload["id"]=row["canonicalId"]',
    ' result.append(hashlib.sha256(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest())',
    'print(json.dumps(result))',
  ].join('\n')], { input: JSON.stringify(canonicalRows), encoding: 'utf8' }));
  for (const [at, row] of canonicalRows.entries()) {
    assert.equal(hashes[at], acceptedHashes.get(row.demoId), 'Every mathematical field must match the accepted frozen payload');
    report.payloads.push({ demoId: row.demoId, backend: row.backend, presentationId: row.presentationId,
      canonicalId: row.canonicalId, normalizedPayloadSha256: hashes[at] });
  }
  const screenshotKinds = new Set();
  for (const demo of expected) {
    const pair = page.locator('.backend-pair[data-demo-id=' + JSON.stringify(demo.id) + ']');
    assert.deepEqual(await pair.locator('.backend-copy').evaluateAll(items => items.map(item => item.dataset.backend)), ['sympy', 'maxima']);
    const cards = {}, payloads = {};
    for (const backend of ['sympy', 'maxima']) {
      cards[backend] = pair.locator('.backend-copy[data-backend=' + JSON.stringify(backend) + '] section.stack-sympy');
      assert.equal(await cards[backend].count(), 1);
      payloads[backend] = JSON.parse(canonicalRows.find(row => row.demoId === demo.id && row.backend === backend).source);
    }
    assert.deepEqual({ ...payloads.sympy, id: '' }, { ...payloads.maxima, id: '' }, 'Paired question/variant payloads must be exactly equal');
    assert.equal(payloads.sympy.question.name, demo.options.question);
    for (let variant = 0; variant < payloads.sympy.variants.length; variant++) {
      console.log(JSON.stringify({ demoId: demo.id, variant, seed: payloads.sympy.variants[variant].seed }));
      const tested = {}, validated = {}, graded = {};
      for (const backend of ['sympy', 'maxima']) {
        const card = cards[backend], payload = payloads[backend], scope = { demoId: demo.id, backend, variant };
        await card.locator('.stack-variant').selectOption(String(variant));
        assert.equal(await card.locator('.stack-check').isDisabled(), true);
        tested[backend] = await action(card, 'tests', scope);
        const result = tested[backend].call.response.result;
        assert.equal(result.passed, true, 'Every authored question test must pass');
        assert.equal(result.results.length, payload.question.qtests.length); assert.ok(result.results.length > 0);
        for (const [at, row] of result.results.entries()) {
          assert.equal(row.testcase, payload.question.qtests[at].testcase); assert.equal(row.seed, payload.variants[variant].seed); assert.equal(row.passed, true);
        }
        tested[backend].routes = assertRoutes(payload.question, result, tested[backend].events, backend);
      }
      const positive = tested.sympy.call.response.result.results.find(row => row.actual?.status === 'graded' && row.actual.score === 1);
      assert.ok(positive, 'Use an authored full-credit input for the real UI comparison');
      const untouchedMaxima = await state(cards.maxima);
      await fillAnswers(cards.sympy, positive.inputs);
      assert.deepEqual(await state(cards.maxima), untouchedMaxima, 'Editing SymPy must not change the Maxima copy');
      const untouchedSympy = await state(cards.sympy);
      await fillAnswers(cards.maxima, positive.inputs);
      assert.deepEqual(await state(cards.sympy), untouchedSympy, 'Editing Maxima must not change the SymPy copy');
      for (const backend of ['sympy', 'maxima']) {
        const card = cards[backend], scope = { demoId: demo.id, backend, variant };
        validated[backend] = await action(card, 'validate', scope);
        assert.equal(validated[backend].call.response.result.status, 'valid');
        assert.ok(Object.values(validated[backend].call.response.result.inputs).every(input => input.valid === true));
        assert.equal(await card.locator('.stack-check').isEnabled(), true);
        assert.equal(await card.locator('.stack-result').getAttribute('data-state'), 'valid');
        if (backend === 'sympy') assert.equal(await cards.maxima.locator('.stack-check').isDisabled(), true, 'Validation must remain independent');
        graded[backend] = await action(card, 'grade', scope, 120000);
        assert.equal(graded[backend].call.response.result.status, 'graded');
        assert.equal(graded[backend].call.response.result.score, 1, 'Actual UI grading must award full credit');
        graded[backend].routes = assertRoutes(payloads[backend].question, graded[backend].call.response.result, graded[backend].events, backend);
        assert.equal(await card.locator('.stack-result').getAttribute('data-state'), 'correct');
        assert.equal((await card.locator('.stack-result .stack-verdict').textContent()).trim(), 'Correct.');
        for (const [name, text] of Object.entries(positive.inputs)) {
          const input = card.locator('.stack-answer[data-name=' + JSON.stringify(name) + ']');
          if (!await input.evaluate(element => element.classList.contains('stack-matrix'))) {
            assert.equal(graded[backend].call.answers[name], text, 'Preserve original scalar answer spelling');
          }
        }
        report.rows[backend].push({ demoId: demo.id, variant, seed: payloads[backend].variants[variant].seed,
          pythonChecker: Boolean(demo.pythonCheckerSource), authoredTests: tested[backend].call,
          testRoutes: tested[backend].events, validation: validated[backend].call,
          gradeCalls: [graded[backend].call], gradeRoutes: graded[backend].events });
      }
      const kind = await pair.locator('.stack-matrix').count() ? 'matrix' : 'scalar';
      if (!screenshotKinds.has(kind)) {
        await page.evaluate(async () => { if (window.MathJax?.startup?.promise) await window.MathJax.startup.promise; if (document.fonts?.ready) await document.fonts.ready; });
        const path = 'backend-pair-' + kind + '.png';
        await pair.screenshot({ path: output + '/' + path, animations: 'disabled' });
        report.screenshots.push({ path, kind, demoId: demo.id, variant }); screenshotKinds.add(kind);
      }
      const checkedMaxima = await state(cards.maxima);
      await cards.sympy.locator('.stack-reset').click();
      assert.equal(await cards.sympy.locator('.stack-check').isDisabled(), true); assert.equal(await cards.sympy.locator('.stack-result').textContent(), '');
      assert.deepEqual(await state(cards.maxima), checkedMaxima, 'Resetting SymPy must not reset Maxima');
      const resetSympy = await state(cards.sympy);
      await cards.maxima.locator('.stack-reset').click();
      assert.equal(await cards.maxima.locator('.stack-check').isDisabled(), true); assert.equal(await cards.maxima.locator('.stack-result').textContent(), '');
      assert.deepEqual(await state(cards.sympy), resetSympy, 'Resetting Maxima must not reset SymPy');
      for (const card of Object.values(cards)) assert.ok((await state(card)).fields.every(field => !field.value && field.cells.every(cell => !cell)), 'Reset must clear scalar and matrix inputs');
    }
  }
  report.coverage = ['sympy', 'maxima'].map(backend => ({ backend, cards: new Set(report.rows[backend].map(row => row.demoId)).size,
    variants: report.rows[backend].length, pythonCheckerCards: new Set(report.rows[backend].filter(row => row.pythonChecker).map(row => row.demoId)).size,
    authoredTestRows: report.rows[backend].reduce((count, row) => count + row.authoredTests.response.result.results.length, 0) }));
  for (const coverage of report.coverage) {
    assert.equal(coverage.cards, expected.length); assert.equal(coverage.variants, report.reference.variantsPerBackend);
    assert.equal(coverage.authoredTestRows, report.reference.authoredRowsPerBackend); assert.equal(coverage.pythonCheckerCards, 6);
  }
  report.differences = compareBackends(report.rows.sympy, report.rows.maxima);
  assert.deepEqual(report.differences, [], 'Full structured question-test, validation and grade results must match');
  report.observation = await page.evaluate(() => window.__ctmHarness);
  assert.equal(report.observation.workers.length, 2, 'Reuse exactly one isolated worker per backend');
  assert.equal(new Set(pools.values()).size, 2, 'The two backends must not share a grading worker');
  assert.equal(report.observation.calls.filter(call => call.type === 'init').length, 2);
  assert.equal(report.screenshots.length, 2);
  assert.deepEqual(report.errors, []);
  // These two Emscripten diagnostics describe unsupported optional syscalls,
  // not an exception or a failed grading response. Keep the raw messages.
  assert.deepEqual(report.consoleErrors.filter(message =>
    !/^warning: unsupported syscall: __syscall_(?:prlimit64|getrusage)\s*$/.test(message)), []);
  assert.deepEqual(report.httpErrors, []);
  assert.deepEqual(report.failedRequests.filter(row => !/ERR_ABORTED/.test(row.error || '')), []);
  if (app) assert.deepEqual(app.requests.filter(row => row.status >= 400), []);
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
console.log(JSON.stringify({ passed: report.passed, cards: report.cards, pairs: report.pairs, coverage: report.coverage,
  differences: report.differences.length, failure: report.failure }));
if (!report.passed) process.exitCode = 1;
