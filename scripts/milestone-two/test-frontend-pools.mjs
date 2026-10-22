// Exercise only frontend routing/queues with mock Workers. The browser harness
// separately verifies real cards, Python, Maxima and structured grade results.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const path = process.argv[2] || '.cache/milestone-two/demo/_extensions/stack-sympy/stack-sympy.js';
const source = await readFile(path, 'utf8');
const entry = "  document.querySelectorAll('.stack-sympy:not(.stack-diagnostic)').forEach(initialize);";
assert.equal(source.split(entry).length, 2, 'Expected the pinned CTM initialization seam');
const instrumented = source.replace(entry, '  window.backendTest = { backendForCard: backendForCard };');
const turn = () => new Promise(resolve => setImmediate(resolve));
const card = name => ({ closest() { return name ? { getAttribute() { return name; } } : null; } });

function fixture(configured = true) {
  const workers = [];
  class Worker {
    constructor(url) { this.url = String(url); this.messages = []; workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      if (message.type === 'init') queueMicrotask(() => this.reply(message, 'ready'));
    }
    reply(message, result) { this.onmessage({ data: { id: message.id, ok: true, result } }); }
    terminate() { this.terminated = true; }
  }
  const window = {
    MathExerciseRuntime: { scriptURL: '/runtime.js', loadTimeout: 180000 },
    CTMCheckers: { scriptURL: '/checkers.js' }, CTMCheckersStack: { scriptURL: '/stack.js' },
    // A legacy page-wide default must never capture an ordinary SymPy card.
    CTMStackBackend: { workerURL: '../backend/worker.js', label: 'wrong global default' },
  };
  if (configured) window.CTMStackBackends = {
    maxima: { workerURL: '../backend/worker.js', label: 'Maxima', loadTimeout: 240000 },
  };
  const document = { currentScript: { src: 'http://localhost/_extensions/stack-sympy/stack-sympy.js' },
    baseURI: 'http://localhost/compare/index.html' };
  vm.runInNewContext(instrumented, { window, document, URL, Worker, setTimeout, clearTimeout, console });
  return { workers, backendForCard: window.backendTest.backendForCard };
}

const { workers, backendForCard } = fixture();
const sympy = backendForCard(card());
const maxima = backendForCard(card('maxima'));
assert.equal(sympy, backendForCard(card()), 'Ordinary cards share their SymPy pool');
assert.equal(maxima, backendForCard(card('maxima')), 'Maxima wrappers share their own pool');
assert.notEqual(sympy, maxima);
assert.equal(sympy.label, 'SymPy');
assert.equal(maxima.label, 'Maxima');

const s1 = sympy.evaluate({ type: 'grade', answers: { ans: 's1' } });
const s2 = sympy.evaluate({ type: 'grade', answers: { ans: 's2' } });
const m1 = maxima.evaluate({ type: 'grade', answers: { ans: 'm1' } });
await turn();
assert.equal(workers.length, 2);
const sw = workers.find(worker => worker.url.endsWith('/_extensions/stack-sympy/worker.js'));
const mw = workers.find(worker => worker.url.endsWith('/backend/worker.js'));
assert.ok(sw && mw, 'Each selected backend uses its own worker URL');
assert.equal(sw.messages.length, 2, 'Second SymPy request waits behind the first');
assert.equal(mw.messages.length, 2, 'Maxima request starts independently');
assert.equal(sw.messages[0].id, 1);
assert.equal(mw.messages[0].id, 1, 'Request ID counters are independent');
mw.reply(mw.messages[1], 'm1 done');
assert.equal(await m1, 'm1 done', 'Maxima finishes while SymPy remains pending');
sw.reply(sw.messages[1], 's1 done');
assert.equal(await s1, 's1 done');
await turn();
assert.equal(sw.messages.length, 3);
sw.reply(sw.messages[2], 's2 done');
assert.equal(await s2, 's2 done');

const failed = maxima.evaluate({ type: 'grade', answers: { ans: 'fail' } });
await turn();
mw.onerror({ message: 'controlled Maxima crash' });
await assert.rejects(failed, /controlled Maxima crash/);
assert.equal(mw.terminated, true);
assert.notEqual(sw.terminated, true, 'A Maxima error must not reset SymPy');
const s3 = sympy.evaluate({ type: 'validate', answers: { ans: 'still alive' } });
await turn();
assert.equal(workers.length, 2, 'Healthy SymPy worker is reused after a Maxima reset');
sw.reply(sw.messages.at(-1), 'SymPy survived');
assert.equal(await s3, 'SymPy survived');
const restarted = maxima.evaluate({ type: 'validate', answers: { ans: 'restart' } });
await turn();
assert.equal(workers.length, 3);
const replacement = workers.at(-1);
assert.equal(replacement.url, mw.url);
replacement.reply(replacement.messages.at(-1), 'Maxima restarted');
assert.equal(await restarted, 'Maxima restarted');

const missing = fixture(false);
assert.throws(() => missing.backendForCard(card('maxima')), /maxima backend is not configured/);
assert.equal(missing.workers.length, 0, 'Missing native descriptor cannot fall back to a worker');
console.log('Scoped backend routing, independent queues and reset checks passed (mock Workers).');
