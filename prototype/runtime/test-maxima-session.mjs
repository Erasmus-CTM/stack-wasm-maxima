// Mock only the shared-memory transport to test its failure boundary. This
// does not execute Wasm or count toward the browser/native parity results.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const scope = { location: { href: 'http://localhost/backend/worker.js' } };
vm.runInNewContext(await readFile(new URL('maxima-session.js', import.meta.url), 'utf8'), {
  self: scope, URL, performance, Atomics, TextDecoder, SharedArrayBuffer, Uint8Array, Int32Array,
});

function sessionWith(value) {
  const session = new scope.MaximaSession();
  session.ready = Promise.resolve();
  session.manifest = { tests: { AlgEquiv: [false, true, false], NumDecPlaces: [true, false, true] } };
  session.control = new Int32Array(new SharedArrayBuffer(32));
  session.output = new Uint8Array(4096);
  session.child = { terminate() { session.terminated = true; } };
  session.write = command => {
    session.command = command;
    const body = new TextEncoder().encode(JSON.stringify([true, value]));
    session.output.set(body);
    Atomics.store(session.control, 3, body.length);
    Atomics.store(session.control, 6, Atomics.load(session.control, 5));
    Atomics.store(session.control, 2, 1);
  };
  return session;
}

const feedback = "stack_trans('ATNumDecPlaces_Wrong_DPs'); !NEWLINE!";
const normal = sessionWith([true, false, 'ATNumDecPlaces_Wrong_DPs. ', feedback]);
const result = normal.assess({ test: 'NumDecPlaces', student: '1.50', teacher: '1.5', options: '3', raw: '1.50',
  assumptions: { positive: false, real: true } });
assert.equal(result.native_feedback, feedback);
assert.equal(result.feedback, '');
assert.match(normal.command, /assume_real:true/);
assert.match(normal.command, /%ERR:\["stack_map"\]/);
assert.match(normal.command, /%NOTES:\["stack_map"\]/);
assert.match(normal.command, /%FEEDBACK:\["stack_map"\]/);
assert.match(normal.command, /,"1\.50"\)/);
assert.equal(normal.poisoned, false);

const inapplicable = sessionWith([false, false, 'ATEqualComAss (AlgEquiv-false). ', '']);
assert.equal(inapplicable.assess({ test: 'AlgEquiv', student: 'x', teacher: 'y' }).correct, false);
assert.equal(inapplicable.poisoned, false);

for (const note of ['ATAlgEquiv_STACKERROR_TAns. ', 'ATNumDecPlaces_OptNotInt. ']) {
  const failed = sessionWith([false, false, note, '']);
  assert.throws(() => failed.assess({ test: 'AlgEquiv', student: 'x', teacher: 'y' }), /answer-test error/);
  assert.equal(failed.poisoned, true);
  assert.equal(failed.terminated, true);
}
const malformed = sessionWith([true, true, '', ['unexpected']]);
assert.throws(() => malformed.assess({ test: 'AlgEquiv', student: 'x', teacher: 'x' }), /Invalid native/);
console.log('Shared-memory result boundary checks passed (mock transport).');
