// Mock only the shared-memory transport to test its failure boundary. This
// does not execute Wasm or count toward the browser/native parity results.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const scope = { location: { href: 'http://localhost/backend/worker.js' } };
class BrowserTextDecoder extends TextDecoder {
  decode(value, options) {
    if (value?.buffer instanceof SharedArrayBuffer || value instanceof SharedArrayBuffer) {
      throw new TypeError('The provided ArrayBufferView value must not be shared.');
    }
    return super.decode(value, options);
  }
}
vm.runInNewContext(await readFile(new URL('maxima-session.js', import.meta.url), 'utf8'), {
  self: scope, URL, performance, Atomics, TextDecoder: BrowserTextDecoder, SharedArrayBuffer, Uint8Array, Int32Array,
});

function sessionWith(value) {
  const session = new scope.MaximaSession();
  session.ready = Promise.resolve();
  session.manifest = { tests: { AlgEquiv: [false, true, false], NumDecPlaces: [true, false, true] } };
  session.control = new Int32Array(new SharedArrayBuffer(32));
  session.output = new Uint8Array(new SharedArrayBuffer(4096));
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
// Node's native decoder accepts shared buffers; enforce the browser boundary
// here so replacing slice() with a shared subarray() fails this regression.
assert.throws(() => new BrowserTextDecoder().decode(new Uint8Array(new SharedArrayBuffer(8))), /must not be shared/);
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
const program = sessionWith({env:{a:'1/3'}, answer:[1, 2], valid:true});
let observed;
program.options.onEvaluate = value => { observed = value; };
assert.deepEqual(JSON.parse(JSON.stringify(program.evaluate('["stack_map",["valid",true]]'))), {env:{a:'1/3'}, answer:[1,2], valid:true});
assert.match(program.command, /errcatch\(\["stack_map"/);
assert.equal(observed.result.env.a, '1/3');
program.options.onEvaluate = () => { throw Error('diagnostic collector failed'); };
assert.equal(program.evaluate('42').valid,true);
assert.equal(program.poisoned,false,'A diagnostic exception cannot poison a successful CAS call');
assert.equal(program.terminated,undefined);
program.options.onEvent = () => { throw Error('event collector failed'); };
assert.doesNotThrow(() => program.event('diagnostic',{}));
assert.throws(() => program.evaluate(''), /Invalid native question/);
const programFailure = sessionWith(null);
programFailure.write = () => {
  const bytes = new TextEncoder().encode(JSON.stringify([false, 'Native evaluation failed']));
  programFailure.output.set(bytes);
  Atomics.store(programFailure.control, 3, bytes.length);
  Atomics.store(programFailure.control, 6, Atomics.load(programFailure.control, 5));
  Atomics.store(programFailure.control, 2, 1);
};
assert.throws(() => programFailure.evaluate('1/0'), /Native evaluation failed/);
assert.equal(programFailure.poisoned, true);
console.log('Shared-memory result boundary checks passed (mock transport).');
