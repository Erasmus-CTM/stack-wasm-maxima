/* The existing CTM request/result protocol, with native STACK AT dispatch.
 * Validation, frozen values, PRTs, CAStext and PythonChecker remain CTM's.
 * SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict';
importScripts('../runtime/maxima-session.js');

let ready = null;
let session = null;
let queue = Promise.resolve();
let currentRequest = null;
const counters = { nativeATCount: 0, pythonCheckerCount: 0, perTest: {} };
const timings = {};
const CALLS = { grade: 'stack.grade', validate: 'stack.validate', tests: 'stack.tests' };

function metadata() {
  return { id: 'maxima', mode: 'hybrid', validation: 'ctm-sympy', controller: 'ctm',
    nativeATCount: counters.nativeATCount, pythonCheckerCount: counters.pythonCheckerCount,
    perTest: { ...counters.perTest }, timings: { ...timings } };
}

function event(data) {
  if (data.event === 'python-checker') counters.pythonCheckerCount++;
  self.postMessage({ type: 'backend-event', backend: 'maxima', requestId: currentRequest, ...data });
}

function init(message) {
  if (!ready) {
    ready = (async () => {
      const started = performance.now();
      importScripts(message.runtime);
      importScripts.apply(self, message.checkers);
      const runtime = self.MathExerciseRuntime;
      session = new self.MaximaSession({
        baseURL: new URL('../maxima-runtime/', self.location.href).href,
        stackSourceURL: new URL('../stack-sources.json', self.location.href).href,
        onEvent: data => event({ ...data, event: 'runtime-' + (data.event || data.type || 'event') }),
      });
      const python = (async () => {
        const py = await runtime.ensurePyodide();
        await py.loadPackage('sympy');
        await runtime.ensureCheckers(py, self.CTMCheckersStack);
        timings.pythonReadyMs = performance.now() - started;
        return py;
      })();
      const maxima = session.init().then(() => { timings.maximaReadyMs = performance.now() - started; });
      const [py] = await Promise.all([python, maxima]);
      const response = await fetch(new URL('native_adapter.py', self.location.href));
      if (!response.ok) throw new Error('Could not load the native Maxima adapter: HTTP ' + response.status);
      const source = await response.text();
      py.globals.set('_ctm_maxima_assess', text => {
        const request = JSON.parse(text);
        const result = session.assess(request);
        counters.nativeATCount++;
        counters.perTest[request.test] = (counters.perTest[request.test] || 0) + 1;
        event({ event: 'maxima-at', test: request.test, cas_valid: result.cas_valid, correct: result.correct });
        return JSON.stringify(result);
      });
      py.globals.set('_ctm_maxima_event', text => event(JSON.parse(text)));
      await py.runPythonAsync(source + '\ninstall(_ctm_maxima_assess, _ctm_maxima_event)\ndel _ctm_maxima_assess, _ctm_maxima_event\n');
      timings.readyMs = performance.now() - started;
      event({ event: 'ready', ...metadata() });
      return py;
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

async function handle(message) {
  currentRequest = message.id;
  try {
    if (message.type === 'init') {
      await init(message);
      self.postMessage({ id: message.id, ok: true, result: 'ready', backend: metadata() });
      return;
    }
    if (!ready) throw new Error('The grading worker was not started.');
    const py = await ready;
    if (message.type === 'diagnostics') {
      self.postMessage({ id: message.id, ok: true, result: metadata(), backend: metadata() });
      return;
    }
    const name = CALLS[message.type];
    if (!name) throw new Error('Unknown worker request');
    const started = performance.now();
    const text = await self.MathExerciseRuntime.callCheckers(py, name,
      { question: message.question, variant: message.variant, answers: message.answers || {} }, self.CTMCheckersStack);
    self.postMessage({ id: message.id, ...JSON.parse(text), backend: { ...metadata(), requestMs: performance.now() - started } });
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: String(error && error.message || error), backend: metadata() });
  } finally {
    currentRequest = null;
  }
}

self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data), () => handle(data));
};
