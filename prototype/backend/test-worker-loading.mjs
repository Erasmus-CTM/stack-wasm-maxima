// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('worker.js', import.meta.url), 'utf8');
const replies = [], globals = new Map();
let starts = 0, failStart = false, pyCalls = 0;
const py = {loadPackage: async () => {}, globals: {set: (name, value) => globals.set(name, value)}, runPythonAsync: async () => {}};
const self = {location: {href: 'https://example.test/backend/worker.js'}, postMessage: data => replies.push(data),
  CTMCheckersStack: {}, MathExerciseRuntime: {
    ensurePyodide: async () => py, ensureCheckers: async () => {},
    callCheckers: async (_py, name) => { pyCalls++; return JSON.stringify({ok: true, result: {status: name === 'stack.validate' ? 'valid' : 'graded'}}); }
  }, MaximaSession: class {
    async init() { starts++; if (failStart) throw new Error('injected Maxima load failure'); return {stages:{preloadedFiles:50}}; }
  }};
const context = vm.createContext({self, URL, performance, importScripts: () => {},
  fetch: async () => ({ok:true, text: async () => '# adapter installed by the actual browser test'})});
vm.runInContext(code, context);
async function send(message) {
  self.onmessage({data:message});
  await vm.runInContext('queue', context);
  const reply = replies.findLast(data => data.id === message.id);
  assert.ok(reply, 'Request must receive its own reply');
  return reply;
}
const native = {prts:[{nodes:[{test:'AlgEquiv'}]}]};
const python = {prts:[{nodes:[{test:'PythonChecker'}]}]};
assert.equal((await send({id:1,type:'init',runtime:'runtime.js',checkers:[]})).ok, true);
assert.equal(starts, 0, 'Init must not start Maxima');
assert.equal((await send({id:2,type:'validate',question:native})).ok, true);
assert.equal(starts, 0, 'Validation must not start Maxima');
assert.equal((await send({id:3,type:'grade',question:python})).ok, true);
assert.equal((await send({id:4,type:'tests',question:python})).ok, true);
assert.equal(starts, 0, 'PythonChecker-only grading and authored tests must not start Maxima');
failStart = true;
const failure = await send({id:5,type:'grade',question:native});
assert.equal(failure.ok, false);
assert.match(failure.error, /injected Maxima/);
assert.equal(pyCalls, 3, 'A failed native startup must not fall back to Python grading');
failStart = false;
assert.equal((await send({id:6,type:'grade',question:native})).ok, true);
assert.equal(starts, 2, 'A failed load can be retried');
assert.equal((await send({id:7,type:'tests',question:native})).ok, true);
assert.equal(starts, 2, 'Subsequent native calls reuse the initialized worker');
console.log('Worker loading: deferred native startup, Python-only routes, fail-closed retry and reuse passed');
