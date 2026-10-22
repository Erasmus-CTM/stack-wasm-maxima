// SPDX-License-Identifier: AGPL-3.0-or-later
// Optional callback from a native PRT continuation to PythonChecker API v1.
(function (scope) {
  'use strict';
  const MODULE = '_ctm_native_python_bridge';
  const REQUEST = '_ctm_native_python_request';
  const interpreterQueues = new WeakMap();

  function serialized(py, action) {
    const previous = interpreterQueues.get(py) || Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    interpreterQueues.set(py, result.catch(() => {}));
    return result;
  }

  class NativePythonBridge {
    constructor(options) {
      this.options = options || {};
      this.ready = null;
      this.state = 'not-started';
      this.calls = 0;
      this.timings = {};
    }

    event(data) {
      if (typeof this.options.onEvent === 'function') {
        try { this.options.onEvent(data); } catch (_) { /* Diagnostics do not change a verdict. */ }
      }
    }

    metadata() {
      return {state: this.state, calls: this.calls, timings: {...this.timings}};
    }

    ensure() {
      if (!this.ready) {
        this.state = 'loading';
        this.ready = (async () => {
          const started = performance.now();
          const scripts = this.options;
          if (typeof scripts.runtime !== 'string' || !scripts.runtime.trim() ||
              !Array.isArray(scripts.checkers) || !scripts.checkers.length ||
              scripts.checkers.some(url => typeof url !== 'string' || !url.trim())) {
            throw new Error('PythonChecker requires the configured CTM runtime and checker scripts');
          }
          scope.importScripts(scripts.runtime);
          scope.importScripts.apply(scope, scripts.checkers);
          const runtime = scope.MathExerciseRuntime;
          if (!runtime || !scope.CTMCheckersStack) throw new Error('PythonChecker STACK runtime is unavailable');
          const payload = scope.CTMCheckersStack;
          const py = await runtime.ensurePyodide();
          const url = scripts.moduleURL || new URL('../native/python_bridge.py', scope.location.href).href;
          const response = await fetch(url);
          if (!response.ok) throw new Error('Could not load the native PythonChecker bridge: HTTP ' + response.status);
          const source = await response.text();
          if (!source || new TextEncoder().encode(source).length > 128 * 1024) throw new Error('Invalid native PythonChecker bridge source');
          // A second bridge may share this interpreter. Installation belongs
          // to the same queue as callbacks, so it cannot run Python while an
          // earlier card's author code is still executing.
          await serialized(py, async () => {
            await py.loadPackage('sympy');
            await runtime.ensureCheckers(py, payload);
            if (typeof runtime.ensureGuard === 'function') await runtime.ensureGuard(py);
            await runtime.installModule(py, MODULE, source);
          });
          this.timings.readyMs = performance.now() - started;
          this.state = 'ready';
          this.event({event: 'python-ready', ...this.metadata()});
          return py;
        })().catch(error => {
          this.state = 'failed';
          this.ready = null;
          throw error;
        });
      }
      return this.ready;
    }

    async invoke(request) {
      // Construction and native-only calls import no Python scripts. Only a
      // visited PythonChecker continuation reaches this method.
      const py = await this.ensure();
      return serialized(py, async () => {
        const started = performance.now();
        const text = JSON.stringify(request);
        if (typeof text !== 'string' || new TextEncoder().encode(text).length > 256 * 1024) {
          throw new Error('Native PythonChecker request exceeds 256 KiB');
        }
        let result;
        try {
          await py.globals.set(REQUEST, text);
          const reply = await py.runPythonAsync(
            '__import__("' + MODULE + '", fromlist=["call_from_globals"]).call_from_globals(globals())');
          result = JSON.parse(reply);
        } finally {
          // call_from_globals pops first; this also covers an interpreter
          // failure before the helper was reached.
          try { py.globals.delete(REQUEST); } catch (_) { /* The helper normally removed it. */ }
        }
        if (!result || typeof result !== 'object' || typeof result.valid !== 'boolean' ||
            typeof result.correct !== 'boolean' || !result.valid && result.correct ||
            typeof result.feedback !== 'string') {
          throw new Error('Malformed native PythonChecker bridge result');
        }
        this.calls++;
        this.timings.lastCallMs = performance.now() - started;
        this.event({event: 'python-checker', valid: result.valid, correct: result.correct,
          implementation: result.implementation, elapsedMs: this.timings.lastCallMs});
        return result;
      });
    }
  }

  scope.NativePythonBridge = NativePythonBridge;
})(self);
