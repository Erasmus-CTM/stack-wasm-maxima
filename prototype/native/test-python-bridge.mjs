// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('python-bridge.js', import.meta.url), 'utf8');
const imports = [], events = [], installed = [], namespace = new Map();
let starts = 0, loads = 0, active = 0, fail = false;
const py = {
  globals: namespace,
  loadPackage: async name => { assert.equal(active,0,'Package loading must not overlap a callback'); assert.equal(name, 'sympy'); loads++; },
  runPythonAsync: async code => {
    assert.match(code, /call_from_globals/);
    assert.equal(active++, 0, 'Python callbacks must not overlap');
    try {
      await new Promise(resolve => setTimeout(resolve,0));
      const request = JSON.parse(namespace.get('_ctm_native_python_request'));
      namespace.delete('_ctm_native_python_request');
      assert.deepEqual(request.assumptions,{real:true,positive:false},'Question assumption flags must reach Python unchanged');
      if (fail) throw new Error('injected PythonChecker failure');
      return JSON.stringify({valid:true, correct:request.student.source === request.teacher.source,
        feedback:'', note:'', implementation:'python-checker-v1', assessment:{columns:['correct']}});
    } finally { active--; }
  }
};
const scope = {location:{href:'https://example.test/native/worker.js'}, importScripts:(...urls) => imports.push(...urls),
  CTMCheckersStack:{}, MathExerciseRuntime:{
    ensurePyodide:async () => {starts++; return py;}, ensureCheckers:async (actual,payload) => assert.equal(actual,py),
    ensureGuard:async actual => assert.equal(actual,py),
    installModule:async (actual,name,text) => { assert.equal(active,0,'Module installation must not overlap a callback'); installed.push({actual,name,text}); }
  }};
vm.runInNewContext(source, {self:scope, performance, URL, TextEncoder,
  fetch:async url => ({ok:true,text:async () => '# trusted bridge source'})});
const bridge = new scope.NativePythonBridge({runtime:'runtime.js',checkers:['checkers.js','stack.js'],onEvent:data=>events.push(data)});
assert.equal(imports.length, 0, 'Native-only construction must load no Python scripts');
assert.equal(starts, 0);
const request = {descriptor:{api_version:1,source:'CHECKERS={}'},options:'{"checker":"check"}',assumptions:{real:true,positive:false},
  student:{type:'scalar',source:'1/3'}, teacher:{type:'scalar',source:'1/3'}};
const results = await Promise.all([bridge.invoke(request),bridge.invoke(request)]);
assert.equal(starts, 1);
assert.equal(loads, 1);
assert.deepEqual(imports, ['runtime.js','checkers.js','stack.js']);
assert.equal(installed.length, 1);
assert.equal(installed[0].name, '_ctm_native_python_bridge');
assert.equal(results[0].correct, true);
assert.deepEqual(JSON.parse(JSON.stringify(results[0].assessment)), {columns:['correct']});
assert.equal(namespace.size, 0);
assert.equal(events.filter(event=>event.event==='python-checker').length, 2);
fail = true;
await assert.rejects(bridge.invoke(request), /injected PythonChecker/);
assert.equal(namespace.size, 0, 'A failed callback leaves no request for another card');
fail = false;
assert.equal((await bridge.invoke(request)).correct, true);
assert.equal(starts, 1, 'A checker author error does not initialize another interpreter');
const other = new scope.NativePythonBridge({runtime:'runtime.js',checkers:['stack.js']});
await Promise.all([bridge.invoke(request),other.invoke(request)]);
assert.equal(active, 0, 'Bridge instances sharing one interpreter must use one queue');
assert.equal((new scope.NativePythonBridge()).metadata().state, 'not-started');
console.log('Native Python bridge: lazy initialization, reuse, serialized callbacks, assessment data and fail-closed errors passed');
