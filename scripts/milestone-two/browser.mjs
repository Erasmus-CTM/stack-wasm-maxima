// SPDX-License-Identifier: AGPL-3.0-or-later
// Drive the unchanged CTM controls. The observer records real worker messages;
// it neither supplies grading results nor replaces the browser's worker.
import assert from 'node:assert/strict';

export function observeWorkers() {
  const NativeWorker = window.Worker;
  const state = window.__ctmHarness = { workers: [], calls: [], events: [] };
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      const worker = { id: state.workers.length, url: String(url), createdAt: performance.now() };
      state.workers.push(worker);
      this.addEventListener('message', ({ data }) => {
        const receivedAt = performance.now();
        if (data && data.type === 'backend-event') {
          state.events.push({ worker: worker.id, receivedAt, data });
          return;
        }
        const call = state.calls.findLast(item => item.worker === worker.id && item.id === data?.id && !item.response);
        if (call) {
          call.receivedAt = receivedAt;
          call.elapsedMs = receivedAt - call.sentAt;
          call.response = data;
        }
      });
      this.addEventListener('error', event => {
        state.events.push({ worker: worker.id, receivedAt: performance.now(), error: event.message });
      });
      const send = this.postMessage.bind(this);
      this.postMessage = (data, transfer) => {
        state.calls.push({ worker: worker.id, id: data?.id, type: data?.type,
          question: data?.question?.name, seed: data?.variant?.seed,
          answers: data?.answers, sentAt: performance.now() });
        return transfer === undefined ? send(data) : send(data, transfer);
      };
    }
  };
}

function splitTopLevel(text) {
  const pieces = [], stack = [];
  let start = 0;
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if ('([{'.includes(char)) stack.push(char);
    else if (')]}'.includes(char)) assert.equal(stack.pop(), pairs[char], 'Unbalanced matrix source');
    else if (char === ',' && !stack.length) { pieces.push(text.slice(start, index).trim()); start = index + 1; }
  }
  assert.equal(stack.length, 0, 'Unbalanced matrix source');
  pieces.push(text.slice(start).trim());
  return pieces;
}

export function matrixCells(source) {
  const match = /^matrix\s*\(([\s\S]*)\)\s*$/.exec(source.trim());
  assert.ok(match, 'Matrix benchmark answer must be a literal matrix(...)');
  const rows = splitTopLevel(match[1]).map(row => {
    assert.ok(row.startsWith('[') && row.endsWith(']'), 'Matrix row must be a literal list');
    return splitTopLevel(row.slice(1, -1));
  });
  assert.ok(rows.length && rows[0].length, 'Matrix benchmark must be nonempty');
  assert.ok(rows.every(row => row.length === rows[0].length), 'Matrix benchmark must be rectangular');
  return rows;
}

async function fillAnswers(card, answers) {
  const fields = await card.locator('.stack-answer[data-name]').evaluateAll(items => items.map(item =>
    ({ name: item.dataset.name, matrix: item.classList.contains('stack-matrix') })));
  assert.ok(fields.length, 'A rendered question must have answer fields');
  for (const field of fields) {
    assert.equal(typeof answers[field.name], 'string', 'Benchmark input is missing: ' + field.name);
    const host = card.locator('.stack-answer[data-name=' + JSON.stringify(field.name) + ']');
    if (!field.matrix) { await host.fill(answers[field.name]); continue; }
    const cells = matrixCells(answers[field.name]);
    const target = { rows: cells.length, cols: cells[0].length };
    for (const [axis, attribute] of [['row', 'rows'], ['col', 'cols']]) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const size = Number(await host.locator('.math-dynamic-mat').getAttribute('data-' + attribute));
        if (size === target[attribute]) break;
        const action = (size < target[attribute] ? 'add-' : 'remove-') + axis;
        const button = host.locator('[data-dynamic-action=' + JSON.stringify(action) + ']');
        assert.equal(await button.isEnabled(), true, 'The matrix editor cannot reach the authored test dimensions');
        await button.click();
      }
      assert.equal(Number(await host.locator('.math-dynamic-mat').getAttribute('data-' + attribute)), target[attribute]);
    }
    for (let row = 0; row < cells.length; row++) {
      for (let col = 0; col < cells[0].length; col++) {
        await host.locator('input[data-matrix-row="' + (row + 1) + '"][data-matrix-column="' + (col + 1) + '"]').fill(cells[row][col]);
      }
    }
  }
}

async function action(page, card, type, timeout) {
  const before = await page.evaluate(() => window.__ctmHarness.calls.length);
  const selector = { tests: '.stack-tests', validate: '.stack-validate', grade: '.stack-check' }[type];
  const button = card.locator(selector);
  assert.equal(await button.isEnabled(), true, type + ' control must be enabled');
  const demoId = await card.getAttribute('data-demo-id');
  await button.click();
  await page.waitForFunction(({ before, type, demoId }) => {
    const calls = window.__ctmHarness.calls.slice(before);
    const card = document.querySelector('.ctm-demo-card[data-demo-id=' + JSON.stringify(demoId) + ']');
    return calls.some(call => call.type === type && call.response || call.response?.ok === false) ||
      card?.querySelector('.stack-result')?.dataset.state === 'error';
  }, { before, type, demoId }, { timeout });
  const call = await page.evaluate(({ before, type }) => window.__ctmHarness.calls.slice(before)
    .find(call => call.type === type && call.response), { before, type });
  assert.ok(call, type + ' did not reach the worker: ' + await card.locator('.stack-result').textContent());
  assert.equal(call.response.ok, true, type + ': ' + (call.response.error || 'Worker reported failure'));
  assert.ok(call.response.result && typeof call.response.result === 'object', 'Missing structured ' + type + ' result');
  await page.waitForFunction(element => element.querySelector('.stack-result').dataset.state !== 'loading',
    await card.elementHandle(), { timeout: 10000 });
  assert.notEqual(await card.locator('.stack-result').getAttribute('data-state'), 'error', 'UI reported an evaluation error');
  return call;
}

function requiredRoutes(question, result, type) {
  const actuals = type === 'tests' ? result.results.map(test => test.actual) : [result];
  const tests = new Set();
  for (const actual of actuals) {
    for (const [name, prt] of Object.entries(actual.prts || {})) {
      const source = question.prts.find(item => item.name === name);
      for (const branch of prt.path || []) {
        const node = source?.nodes.find(item => String(item.name) === String(branch.node));
        assert.ok(node, 'A graded PRT path must identify an authored node');
        tests.add(node.test);
      }
    }
  }
  return [...tests];
}

async function verifyRoutes(page, question, call, backend) {
  const events = await page.evaluate(({ id, worker }) => window.__ctmHarness.events
    .filter(event => event.worker === worker && event.data?.requestId === id), call);
  const required = call.type === 'validate' ? [] : requiredRoutes(question, call.response.result, call.type);
  if (backend === 'maxima') {
    assert.equal(call.response.backend?.id, 'maxima', 'The Maxima page must answer through its backend');
    for (const test of required) {
      assert.ok(events.some(event => test === 'PythonChecker' ? event.data.event === 'python-checker' :
        event.data.event === 'maxima-at' && event.data.test === test), 'Missing actual routing evidence for ' + test);
    }
  } else assert.equal(events.filter(event => event.data.event === 'maxima-at').length, 0);
  return { required, events };
}

function stableResult(result) {
  if (Array.isArray(result)) return result.map(stableResult);
  if (!result || typeof result !== 'object') return result;
  return Object.fromEntries(Object.keys(result).sort().map(key => [key, stableResult(result[key])]));
}

export function compareBackends(sympy, maxima) {
  const differences = [];
  assert.equal(sympy.length, maxima.length, 'Both backends must cover every frozen variant');
  for (let index = 0; index < sympy.length; index++) {
    const left = sympy[index], right = maxima[index];
    assert.equal(left.demoId, right.demoId); assert.equal(left.variant, right.variant); assert.equal(left.seed, right.seed);
    assert.deepEqual(left.gradeCalls[0].answers, right.gradeCalls[0].answers, 'Paired UI submissions must be identical');
    assert.deepEqual(left.authoredTests.response.result.results.map(row => [row.testcase, row.seed, row.inputs]),
      right.authoredTests.response.result.results.map(row => [row.testcase, row.seed, row.inputs]),
      'Authored tests must use the same frozen inputs');
    for (const [label, a, b] of [
      ['validation', left.validation.response.result, right.validation.response.result],
      ['grade', left.gradeCalls[0].response.result, right.gradeCalls[0].response.result],
      ...left.authoredTests.response.result.results.map((test, at) =>
        ['authored-test:' + test.testcase, test.actual, right.authoredTests.response.result.results[at].actual]),
    ]) {
      if (JSON.stringify(stableResult(a)) !== JSON.stringify(stableResult(b))) {
        differences.push({ demoId: left.demoId, variant: left.variant, seed: left.seed, operation: label, sympy: a, maxima: b });
      }
    }
  }
  return differences;
}

export async function runPage({ browser, baseURL, backend, pageName, demos, selectedInputs, repeats = 3, timeout = 330000, output, onProgress }) {
  // A new context per page gives a fresh HTTP cache and independent interpreters.
  // Successive checks on that page share its real persistent worker.
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const result = { backend, page: pageName, url: new URL(backend + '/' + pageName + '.html', baseURL).href,
    console: [], pageErrors: [], network: [], failures: [], variants: [] };
  let active = '';
  const networkTasks = [];
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') result.console.push({ type: message.type(), text: message.text() }); });
  page.on('pageerror', error => result.pageErrors.push(String(error)));
  page.on('requestfailed', request => result.network.push({ url: request.url(), failed: request.failure()?.errorText }));
  page.on('requestfinished', request => {
    networkTasks.push((async () => {
      const response = await request.response();
      if (!response) return;
      const sizes = await request.sizes();
      result.network.push({ url: request.url(), method: request.method(), status: response.status(),
        resourceType: request.resourceType(), ...sizes });
    })().catch(error => result.network.push({ url: request.url(), measurementError: String(error) })));
  });
  try {
    await page.addInitScript(observeWorkers);
    const navigationStarted = Date.now();
    await page.goto(result.url, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll('.stack-sympy .stack-reset').length ===
      document.querySelectorAll('.ctm-demo-card').length && document.querySelectorAll('.ctm-demo-card').length > 0);
    result.pageLoadMs = Date.now() - navigationStarted;
    assert.equal(await page.evaluate(() => self.crossOriginIsolated), true, 'Matched host must supply cross-origin isolation');
    assert.deepEqual(await page.locator('.ctm-demo-card').evaluateAll(items => items.map(item => item.dataset.demoId)), demos.map(demo => demo.id));
    for (const demo of demos) {
      const card = page.locator('.ctm-demo-card[data-demo-id=' + JSON.stringify(demo.id) + ']');
      const payload = await card.locator('script.stack-sympy-data').evaluate(element => JSON.parse(element.textContent));
      assert.equal(payload.question.name, demo.options.question);
      assert.equal(payload.variants.length, Number(demo.options.variants || 1));
      for (let variant = 0; variant < payload.variants.length; variant++) {
        active = demo.id + ':' + variant;
        onProgress?.(backend + '/' + pageName + ' ' + active);
        const selector = card.locator('.stack-variant');
        if (await selector.count()) await selector.selectOption(String(variant));
        assert.equal(await card.locator('.stack-check').isDisabled(), true, 'Variant changes require new validation');
        const authoredTests = await action(page, card, 'tests', timeout);
        const testResult = authoredTests.response.result;
        assert.ok(Array.isArray(testResult.results) && testResult.results.length === payload.question.qtests.length && testResult.results.length > 0,
          'Each variant must execute all authored tests');
        assert.equal(testResult.passed, testResult.results.every(test => test.passed === true), 'Authored test summary must match its rows');
        for (const [at, test] of testResult.results.entries()) {
          assert.equal(test.testcase, payload.question.qtests[at].testcase, 'Authored tests must retain source order and identity');
          assert.equal(test.seed, payload.variants[variant].seed);
          if (!test.passed) result.failures.push({ demoId: demo.id, variant, operation: 'authored-test', testcase: test.testcase, checks: test.checks });
        }
        const testRoutes = await verifyRoutes(page, payload.question, authoredTests, backend);
        if (backend === 'sympy') {
          const choice = testResult.results.find(row => row.actual?.status === 'graded' && row.actual.score >= 1) ||
            testResult.results.find(row => row.actual?.status === 'graded');
          assert.ok(choice, 'No valid authored input is available for the UI benchmark');
          selectedInputs.set(active, { inputs: choice.inputs, testcase: choice.testcase });
        }
        const choice = selectedInputs.get(active);
        assert.ok(choice, 'The paired SymPy run must supply the benchmark input');
        await card.locator('.stack-reset').click();
        await fillAnswers(card, choice.inputs);
        assert.equal(await card.locator('.stack-check').isDisabled(), true, 'Edits require validation');
        const validation = await action(page, card, 'validate', timeout);
        assert.equal(validation.response.result.status, 'valid', 'The authored benchmark input must validate');
        assert.equal(await card.locator('.stack-result').getAttribute('data-state'), 'valid', 'CTM must display the validation result');
        for (const [name, detail] of Object.entries(validation.response.result.inputs || {})) {
          assert.equal(detail.valid, true, 'Each benchmark input must validate');
          const preview = card.locator('.stack-validation[data-name=' + JSON.stringify(name) + ']');
          if (await preview.count()) {
            assert.equal(await preview.getAttribute('data-state'), 'valid', 'Each inline preview must show valid input');
            assert.equal(await preview.getAttribute('data-latex'), detail.latex || '', 'The preview must use the returned mathematical interpretation');
          }
        }
        assert.equal(await card.locator('.stack-check').isEnabled(), true, 'Valid inputs enable checking');
        const gradeCalls = [], gradeRoutes = [];
        for (let repeat = 0; repeat < repeats; repeat++) {
          const call = await action(page, card, 'grade', timeout);
          assert.equal(call.response.result.status, 'graded', 'Validated benchmark input must produce a grade');
          const expectedState = call.response.result.score >= 1 ? 'correct' : 'retry';
          assert.equal(await card.locator('.stack-result').getAttribute('data-state'), expectedState, 'CTM feedback state must match the result');
          gradeCalls.push(call);
          gradeRoutes.push(await verifyRoutes(page, payload.question, call, backend));
        }
        for (const call of gradeCalls.slice(1)) {
          assert.deepEqual(call.answers, gradeCalls[0].answers, 'Repeated checks must submit identical original text');
          assert.deepEqual(call.response.result, gradeCalls[0].response.result, 'Persistent-worker warm checks must be deterministic');
        }
        for (const [name, text] of Object.entries(choice.inputs)) {
          const host = card.locator('.stack-answer[data-name=' + JSON.stringify(name) + ']');
          if (!await host.evaluate(element => element.classList.contains('stack-matrix'))) {
            assert.equal(gradeCalls[0].answers[name], text, 'Scalar answer spelling must survive UI submission');
          }
        }
        let staleReply = null;
        if (demo === demos[0] && variant === 0) {
          const before = await page.evaluate(() => window.__ctmHarness.calls.length);
          // Click then edit in the same event-loop turn: a later validation
          // reply must not restore the old preview or enable Check.
          await card.evaluate(element => {
            element.querySelector('.stack-validate').click();
            const input = element.querySelector('.stack-answer:is(input,textarea), .stack-matrix input[data-matrix-row]');
            if (!input) throw new Error('No editable field for the stale-result check');
            input.value += ' ';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          await page.waitForFunction(before => window.__ctmHarness.calls.slice(before)
            .some(call => call.type === 'validate' && call.response), before, { timeout });
          staleReply = await page.evaluate(before => window.__ctmHarness.calls.slice(before)
            .find(call => call.type === 'validate' && call.response), before);
          assert.equal(staleReply.response.ok, true, 'Stale-result probe must compute a real reply');
          assert.equal(await card.locator('.stack-check').isDisabled(), true, 'A stale validation reply must leave Check disabled');
          assert.equal(await card.locator('.stack-result').textContent(), '', 'A stale reply must leave the edited preview empty');
        }
        await card.locator('.stack-reset').click();
        assert.equal(await card.locator('.stack-check').isDisabled(), true, 'Reset must disable checking');
        assert.equal(await card.locator('.stack-result').textContent(), '', 'Reset must clear feedback');
        assert.ok((await card.locator('.stack-answer[data-name]:is(input,textarea), .stack-matrix input[data-matrix-row]').evaluateAll(items => items.map(item => item.value))).every(text => !text), 'Reset must clear scalar and matrix cells');
        result.variants.push({ demoId: demo.id, variant, seed: payload.variants[variant].seed,
          pythonChecker: Boolean(demo.pythonCheckerSource), chosenTestcase: choice.testcase,
          authoredTests, testRoutes, validation, gradeCalls, gradeRoutes, staleReply, resetVerified: true });
      }
    }
    result.observation = await page.evaluate(() => window.__ctmHarness);
    assert.equal(result.observation.workers.length, 1, 'The CTM page must reuse one grading worker');
    const init = result.observation.calls.filter(call => call.type === 'init');
    assert.equal(init.length, 1); assert.equal(init[0].response?.ok, true, 'The page worker must initialize successfully');
    result.startup = { workerInitMs: init[0].elapsedMs, backend: init[0].response.backend || null,
      pageNavigationToFirstGradeMs: result.variants[0].gradeCalls[0].receivedAt };
    assert.equal(result.pageErrors.length, 0, 'The browser page must have no uncaught exceptions');
  } catch (error) {
    result.error = { active, message: String(error), stack: error.stack };
    if (!page.isClosed()) {
      result.observation = await page.evaluate(() => window.__ctmHarness).catch(() => null);
      await page.screenshot({ path: output + '/' + backend + '-' + pageName + '-failure.png', fullPage: false }).catch(() => {});
    }
  } finally {
    // Keep completed startup evidence even when a later card fails. This is
    // the original immutable init RPC, never a cumulative warm-call timer.
    const init = result.observation?.calls.filter(call => call.type === 'init') || [];
    if (init.length === 1 && init[0].response) {
      result.startup = { workerInitMs: init[0].elapsedMs, workerInitOK: init[0].response.ok === true,
        backend: init[0].response.backend || null,
        pageNavigationToFirstGradeMs: result.variants[0]?.gradeCalls[0]?.receivedAt ?? null };
    }
    await Promise.allSettled(networkTasks);
    result.networkTotals = result.network.reduce((sum, row) => {
      if (row.responseBodySize >= 0) sum.encodedResponseBodyBytes += row.responseBodySize;
      if (row.responseHeadersSize >= 0) sum.responseHeaderBytes += row.responseHeadersSize;
      return sum;
    }, { encodedResponseBodyBytes: 0, responseHeaderBytes: 0 });
    await context.close();
  }
  return result;
}
