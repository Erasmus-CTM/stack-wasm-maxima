// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {requireCompiledEntryReads} from './result.mjs';

const clientSource = await readFile(new URL('./client.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const entry = '/ctm/moodle-qtype_stack-master/stack/maxima/';
const opened = (self, name) => self.postMessage({type:'m1-fs-open', path:entry+name, read:true});
const completed = self => self.postMessage({type:'output', text:'M1READY|2026101500\nM1META|2026101500|test-runtime\n'});

// Execute the real browser client and worker wrappers. Only the upstream CAS
// is replaced: it emits the same fatal callback/worker events that a native
// abort produces. Deliver queued messages even after terminate() to check that
// a late ready marker cannot overwrite the first failure.
async function exercise(runtime, {watchdog=false, importFailure=false}={}) {
  const timers=[], printed=[], forwardedAborts=[];
  let actualWorker, clock=0;
  class Worker {
    constructor() {
      actualWorker=this;
      this.terminated=false;
      const listeners={};
      const self={
        addEventListener:(name, callback)=>{listeners[name]=callback;},
        postMessage:data=>queueMicrotask(()=>this.onmessage?.({data}))
      };
      const Module={preRun:[],
        printErr:(...args)=>printed.push(args.map(String).join(' ')),
        onAbort:reason=>forwardedAborts.push(reason)};
      const context=vm.createContext({self, Module, console, SharedArrayBuffer,
        Int32Array, Uint32Array, Atomics,
        importScripts:()=>{
          if(importFailure)throw new Error('Pinned runtime import failed');
          self.onmessage=({data:buffers})=>{
            assert.deepEqual(Array.from(buffers,buffer=>buffer.byteLength),[8,2*1024*1024,4,4]);
            runtime({self,Module,listeners});
          };
        }});
      self.importScripts=context.importScripts;
      try {vm.runInContext(workerSource,context,{filename:'actual-m1-worker.js'});}
      catch(error){queueMicrotask(()=>this.onerror?.({message:error.message,error}));}
      this.start=data=>self.onmessage?.({data});
    }
    postMessage(data) {queueMicrotask(()=>this.start(data));}
    terminate() {this.terminated=true;}
  }
  const status={textContent:''};
  const context=vm.createContext({window:{}, Worker, crossOriginIsolated:true,
    SharedArrayBuffer, Int32Array, Uint32Array, Atomics,
    document:{getElementById:()=>status}, performance:{now:()=>++clock},
    setTimeout:(callback,ms)=>{const timer={callback,ms,active:true};timers.push(timer);return timer;},
    clearTimeout:timer=>{timer.active=false;}});
  vm.runInContext(clientSource,context,{filename:'actual-m1-client.js'});
  const pending=context.window.runMilestoneOne({files:[],batch:'first$\nsecond$\n'});
  if(watchdog){await new Promise(resolve=>setImmediate(resolve));assert.equal(timers[0].ms,180000);timers[0].callback();}
  const result=clone(await pending);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(actualWorker.terminated,true);
  assert.equal(timers[0].active,false);
  assert.deepEqual(JSON.parse(status.textContent),result);
  return {result,printed,forwardedAborts};
}

const ordinary=await exercise(({self,Module})=>{
  Module.printErr('warning: unsupported syscall: __syscall_getrusage');
  Module.printErr('warning: unsupported syscall: __syscall_prlimit64');
  for(const charactersRead of [37,511,1003])self.postMessage({type:'m1-transport-probe',charactersRead});
  self.postMessage({type:'waitingForInput'});self.postMessage({type:'waitingForInput'});
  opened(self,'stackmaxima.fas');completed(self);
});
assert.equal(ordinary.result.ok,true);
assert.equal(ordinary.result.injectedInterruptChecks,3);
assert.equal(ordinary.result.commandsSent,2);
assert.equal(ordinary.printed.length,2,'Preserve the upstream stderr handler');
assert.equal(ordinary.result.fatal,undefined);
assert.equal(requireCompiledEntryReads(ordinary.result).ok,true);

const aborted=await exercise(({self,Module})=>{
  Module.printErr('Unexpected mark stack overflow');
  Module.onAbort('native code called abort()');
  completed(self);
  self.postMessage({type:'m1-error',error:'Secondary error must not replace the abort'});
});
assert.equal(aborted.result.ok,false);
assert.equal(aborted.result.error,'native code called abort()');
assert.equal(aborted.result.fatal.kind,'runtime-abort');
assert.match(aborted.result.fatal.stderrTail,/Unexpected mark stack overflow/);
assert.equal(aborted.result.stdout,'');
assert.deepEqual(aborted.forwardedAborts,['native code called abort()']);
assert.deepEqual(aborted.printed,['Unexpected mark stack overflow']);
requireCompiledEntryReads(aborted.result);
assert.equal(aborted.result.error,'native code called abort()');
assert.deepEqual(aborted.result.compiledEntryErrors,['Compiled entry was not opened by the real Wasm filesystem']);

const fallbackAbort=await exercise(({self,Module})=>{
  opened(self,'stackmaxima.fas');opened(self,'stackmaxima.mac');
  Module.onAbort('abort after entry load');completed(self);
});
requireCompiledEntryReads(fallbackAbort.result);
assert.equal(fallbackAbort.result.error,'abort after entry load');
assert.deepEqual(fallbackAbort.result.compiledEntryErrors,['Compiled probe unexpectedly opened the source entry']);

for(const [kind,emit] of [
  ['worker-error',({listeners})=>listeners.error({error:new Error('native worker trap')})],
  ['unhandled-rejection',({listeners})=>listeners.unhandledrejection({reason:new Error('native rejected promise')})],
  ['worker-start',()=>{throw new Error('synchronous native startup failure');}]
]) {
  const {result}=await exercise(state=>{emit(state);completed(state.self);});
  assert.equal(result.ok,false);assert.equal(result.fatal.kind,kind);
  assert.notEqual(result.error,'Wasm batch timed out');assert.match(result.error,/native/);
}
const early=await exercise(()=>{}, {importFailure:true});
assert.equal(early.result.ok,false);assert.match(early.result.error,/Pinned runtime import failed/);
const stalled=await exercise(()=>{}, {watchdog:true});
assert.equal(stalled.result.ok,false);assert.equal(stalled.result.error,'Wasm batch timed out');
assert.equal(stalled.result.fatal,undefined);
for(const name of [null,'stackmaxima.mac']) {
  const {result}=await exercise(({self})=>{if(name)opened(self,name);completed(self);});
  requireCompiledEntryReads(result);assert.equal(result.ok,false);
  assert.ok(result.compiledEntryErrors.length);
}

// Run the actual Python comparator in an isolated temporary repository shape.
// Even an abort before the three interrupt probes must retain its original
// cause and fail both pins without calling the parity parser.
const temporary=await mkdtemp(join(tmpdir(),'ctm-m1-fatal-'));
try {
  const scriptDir=join(temporary,'scripts/milestone-one'), output=join(temporary,'test-results/milestone-one');
  const parserDir=join(temporary,'.ctm-checkers-source/tools/stack_native/native_compliance');
  await Promise.all([mkdir(scriptDir,{recursive:true}),mkdir(output,{recursive:true}),mkdir(parserDir,{recursive:true})]);
  await writeFile(join(scriptDir,'compare.py'),await readFile(new URL('./compare.py',import.meta.url)));
  await writeFile(join(parserDir,'maxima_runner.py'),'def parse_output(*args):\n    raise AssertionError("Fatal evidence must not reach parity parsing")\n');
  const pins=['10d323311b7f39fb7b092dd10ce75f7d8632f525','33383047af39c204bf4442802a058f8b918b2b1b'];
  await writeFile(join(output,'prepared.json'),JSON.stringify({ctmCheckersRevision:'test',fixtureSha256:'test',cases:[],versions:pins.map(stackRevision=>({stackRevision}))}));
  for(const pin of pins)await writeFile(join(output,'browser-'+pin.slice(0,7)+'.json'),JSON.stringify(aborted.result));
  const process=spawnSync('python',['-B',join(scriptDir,'compare.py')],{encoding:'utf8',timeout:10000,
    env:{...globalThis.process.env,MILESTONE_ONE_REPORT_ROOT:join(temporary,'report'),GITHUB_RUN_ID:'fatal-regression'}});
  assert.equal(process.status,1,process.stderr);
  const report=JSON.parse(await readFile(join(temporary,'report/latest.json'),'utf8'));
  assert.equal(report.status,'failed');assert.equal(report.versions.length,2);
  for(const version of report.versions){
    assert.equal(version.passed,false);assert.equal(version.error,'native code called abort()');
    assert.deepEqual(version.fatal,aborted.result.fatal);
    assert.deepEqual(version.compiledEntryErrors,aborted.result.compiledEntryErrors);
    assert.equal(version.comparisonCount,undefined);
  }
} finally {await rm(temporary,{recursive:true,force:true});}
console.log('Official fatal reporting: real worker/client wrappers and comparator reject aborts, preserve causes and secondary entry failures; ordinary warnings, transport, and watchdog controls pass');
