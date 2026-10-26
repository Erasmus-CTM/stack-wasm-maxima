/* Grading runs in a disposable Worker: a timeout terminates runaway symbolic
 * calculations without freezing the student-facing page. Its Python is
 * CTM Assessment's: ctm-libs' runtime (MathExerciseRuntime) and ctm-checkers
 * with its STACK engine (ctm_checkers.stack), loaded from the page's own
 * scripts, whose URLs the first message brings. Loading is bounded by the
 * runtime's load limit; the page starts its calculation timer only when this
 * worker reports that it is ready. */
'use strict';
var ready = null;

function init(message) {
  if (!ready) {
    ready = (async function () {
      importScripts(message.runtime);
      importScripts.apply(self, message.checkers);
      var runtime = self.MathExerciseRuntime;
      var timer;
      var limit = new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          reject(new Error('Python did not finish loading within ' + runtime.loadTimeout / 1000 + ' s'));
        }, runtime.loadTimeout);
      });
      try {
        return await Promise.race([(async function () {
          var py = await runtime.ensurePyodide();
          await py.loadPackage('sympy');
          await runtime.ensureCheckers(py, self.CTMCheckersStack);
          return py;
        })(), limit]);
      } finally {
        clearTimeout(timer);
      }
    })();
    ready.catch(function () { ready = null; });
  }
  return ready;
}

// stack-sympy's requests, as ctm-checkers' calls (stack.grade, stack.validate,
// stack.tests) with the same answer: {ok: true, result} or {ok: false, error}.
var CALLS = { grade: 'stack.grade', validate: 'stack.validate', tests: 'stack.tests' };

self.onmessage = async function (event) {
  var msg = event.data;
  try {
    if (msg.type === 'init') {
      await init(msg);
      self.postMessage({ id: msg.id, ok: true, result: 'ready' });
      return;
    }
    if (!ready) throw new Error('The grading worker was not started.');
    var py = await ready;
    var name = CALLS[msg.type];
    if (!name) throw new Error('Unknown worker request');
    var text = await self.MathExerciseRuntime.callCheckers(py, name,
      { question: msg.question, variant: msg.variant, answers: msg.answers || {} }, self.CTMCheckersStack);
    self.postMessage(Object.assign({ id: msg.id }, JSON.parse(text)));
  } catch (error) {
    self.postMessage({ id: msg.id, ok: false, error: String(error && error.message || error) });
  }
};
