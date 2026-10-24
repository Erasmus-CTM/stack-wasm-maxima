import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {arms,trialPlan,validateAdmission,compactResult,summarize,runPageMeasurement,stopPageWorker,isFatalConsole,assertManifestDelta,pairedComparisons} from './run.mjs';
const checks=JSON.parse(await readFile(new URL('../gc-aggregate-budget-fix/runtime/precompiled/restart-checks.json',import.meta.url))).checks;
const nativePrograms=['prepare','validate','prt'].map((operation,i)=>({operation,question:'synthetic',expression:'fixture-'+operation,expected:[i,true]}));
const plan=trialPlan(3);assert.equal(plan.length,12);assert.equal(plan.flatMap(p=>p.modes).length,24);
assert.throws(()=>trialPlan(1),/three repetitions/);
assert.equal(isFatalConsole('error','warning: unsupported syscall: __syscall_prlimit64'),false);assert.equal(isFatalConsole('error','warning: unsupported syscall: __syscall_getrusage'),false);
assert.equal(isFatalConsole('error','warning: unsupported syscall: __syscall_other'),true);assert.equal(isFatalConsole('warning','RuntimeError: memory access out of bounds'),true);assert.equal(isFatalConsole('log','Unexpected mark stack overflow'),true);
for(const arm of arms)for(const candidate of ['source','precompiled'])for(const mode of ['cold','warm-profile-reload'])assert.equal(plan.filter(p=>p.arm===arm&&p.candidate===candidate&&p.modes.includes(mode)).length,3);
assert.deepEqual(plan.filter(p=>(p.pair-1)%4===0).map(p=>p.arm),['control','errno-stack-suppressed','control']);
for(const arm of arms)assert.equal(new Set([1,2,3].map(repetition=>plan.find(p=>p.arm===arm&&p.repetition===repetition).candidate)).size,2,'Each arm must alternate source/FAS order');
const source={runId:40108653819,runAttempt:1,head:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',testedRevision:'5295b5a79bfb983f9e43dd911e6f8ab65139a930',tree:'0e543f936a385548a7ffd53d68930bd88c033922',trustedRevision:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',recipeFiles:71};
const assets=Array.from({length:79},(_,i)=>({path:i?'asset-'+i:'maxima.js',bytes:i+1,sha256:'a'.repeat(64)}));
const compilerProfile={name:'ecl-oz'},originalBuild={kind:'ctm-owned-build',compilerProfile,manifestSha256:'0'.repeat(64)},derivedBuild={kind:'ctm-derived-diagnostic',compilerProfile,manifestSha256:'1'.repeat(64),originalBuild};
const admission={schema:1,passed:true,diagnosticOnly:true,acceptance:false,source,compilerProfile,nativePrograms,originalPackageManifest:{bytes:123,sha256:'0'.repeat(64)},derivation:{kind:'derived-diagnostic-javascript',acceptedUnchangedRuntime:false},artifact:{id:12568085269,name:'precompiled-stack-probe-ecl-oz-'+source.testedRevision,digest:'sha256:890a9c1c6c96d915ada2c41bf85e8b3756132ea2f42d6c5d4c6d9a9357c6759d',size_in_bytes:213921626,workflow_run:{id:source.runId,head_sha:source.head}},arms:{control:{kind:'accepted-original-runtime-with-observer',runtimeBuild:originalBuild,runtimeManifest:{bytes:123,sha256:'0'.repeat(64)},runtimeAssets:assets},'errno-stack-suppressed':{kind:'derived-diagnostic-with-observer',runtimeBuild:derivedBuild,runtimeManifest:{bytes:124,sha256:'1'.repeat(64)},runtimeAssets:assets}}};
const manifest=arm=>({runtimeBuild:structuredClone(admission.arms[arm].runtimeBuild),runtimeAssets:assets.map(r=>({path:r.path,fileBytes:r.bytes,sha256:r.sha256})),files:Array.from({length:77},(_,i)=>({path:'stack/'+i})),startup:'exact original startup'});
for(const arm of arms)validateAdmission(admission,arm,manifest(arm));
assert.throws(()=>validateAdmission({...admission,passed:false},'control',manifest('control')),/admission/);
assert.throws(()=>validateAdmission(admission,'errno-stack-suppressed',manifest('control')),/runtime identity/);
for(const mutate of [a=>a.artifact.name='wrong',a=>a.artifact.id++,a=>a.source.head='f'.repeat(40),a=>a.derivation.acceptedUnchangedRuntime=true,a=>a.arms['errno-stack-suppressed'].kind='accepted-original',a=>a.acceptance=true]){const value=structuredClone(admission);mutate(value);assert.throws(()=>validateAdmission(value,'errno-stack-suppressed',manifest('errno-stack-suppressed')));}
const wrongAssets=manifest('control');wrongAssets.runtimeAssets[0].sha256='f'.repeat(64);assert.throws(()=>validateAdmission(admission,'control',wrongAssets),/asset closure/);
const before=manifest('control'),after=manifest('errno-stack-suppressed');after.runtimeAssets[0]={path:'maxima.js',fileBytes:200,sha256:'d'.repeat(64)};const asset={bytes:200,sha256:'d'.repeat(64)};
assertManifestDelta(before,after,derivedBuild,asset);
for(const mutate of [m=>m.startup+=' warmup',m=>m.files[0].path='substituted',m=>m.runtimeAssets[1].sha256='e'.repeat(64)]){const wrong=structuredClone(after);mutate(wrong);assert.throws(()=>assertManifestDelta(before,wrong,derivedBuild,asset));}
const successGuard={schema:1,kind:'ctm-startup-stdout-guard',passed:true,failed:false,firstFatal:null,state:'ready',beginCount:1,endCount:1,readyCount:1,stdoutTail:'CTMSTACK-LOAD-BEGIN\nCTMSTACK-LOAD-END\nCTMMAXIMA-READY|v|m\n'};
const successCapability={schema:1,kind:'ctm-errno-stack-capability',errno:44,assignedErrno:44,code:'ENOENT',originalStackTraceLimit:10,supported:true,didSuppress:true,descriptorRestored:true,capability:{ownData:true,writable:true,finiteNumeric:true,messageIsString:true},stack:{type:'string',lineCount:1,frameCount:0},fallbackReason:null};
const workerSource=await readFile(new URL('./clean-probe-worker.js',import.meta.url),'utf8');
async function fakeProbe(options={}){
  const messages=[],calls=[];let ticks=0,terminations=0,session;
  const self={postMessage:value=>{ticks+=100;messages.push(structuredClone(value));}};Object.defineProperty(self,'Worker',{get:()=>class{},set:()=>{throw Error('Clean worker constructor must remain untouched');}});
  class Session{
    constructor(sessionOptions){session=this;this.options=sessionOptions;this.sequence=0;this.counters={nativeCalls:0};this.poisoned=false;this.manifest={stackRevision:'pin'};if(options.preexisting)this.child={terminate(){terminations++;}};}
    async init(){
      const emit=(prefix,value)=>this.options.onEvent({event:'maxima-diagnostic',text:prefix+(typeof value==='string'?value:JSON.stringify(value))});
      if(!options.missingGuard){const guard=structuredClone(successGuard);if(options.failedGuard){guard.passed=false;guard.failed=true;guard.firstFatal={line:'loadfile: failed to load draw.lisp'};}emit('CTM-STARTUP-GUARD|',guard);}
      if(options.receipt!==undefined){emit('CTM-ERRNO-STACK-CAPABILITY|',options.receipt);if(options.duplicateReceipt)emit('CTM-ERRNO-STACK-CAPABILITY|',options.receipt);}
      if(options.delayedDuplicateGuard)setTimeout(()=>emit('CTM-STARTUP-GUARD|',successGuard),0);
      this.child={terminate(){terminations++;}};this.controlBuffer=new SharedArrayBuffer(32);this.inputBuffer=new SharedArrayBuffer(2097152);this.outputBuffer=new SharedArrayBuffer(1048576);this.control=new Int32Array(this.controlBuffer);this.ready=Promise.resolve();if(options.staleRequest)Atomics.store(this.control,5,1);
      return {stackLibraryVersion:'version',maximaVersion:'maxima',stages:{stackLoadMs:5,wasmReadyMs:2,...(options.compiled?{compiledStackMounted:true,compiledStackOpens:options.badFasOpens?2:1,compiledSourceEntryOpens:options.sourceFallback?1:0,compiledStackBytes:7,compiledStackSha256:options.badFasHash?'wrong':'hash'}:{})}};}
    evaluate(expression){if(this.poisoned||!this.ready)throw Error('Maxima is not ready');calls.push({kind:'evaluate',expression});this.sequence++;
      const check=checks.find(r=>r.expression===expression);if(check)return options.failLogical&&check===checks[0]?false:structuredClone(check.expected);
      const program=nativePrograms.find(r=>r.expression===expression);if(program)return options.failNative?false:structuredClone(program.expected);
      if(expression==='6*7')return 42;
      if(expression.startsWith('[STACKpmOPT'))return ['#pm#',true,true,true,false,'~d','~a','.',true,true];
      if(expression.includes('ctm_retained:makelist'))return 1000;
      if(expression.includes('ctm_force_gc()'))return !options.failGC;
      if(expression.includes('CTM deliberate caught CAS error'))return 'CTM deliberate caught CAS error';
      if(expression.includes('unexpected plotting success'))return options.failPlot?'unexpected plotting success':'CTM plotting unavailable; use JSXGraph.';
      throw Error('Unexpected fixture expression');
    }
    assess(request){calls.push({kind:'assess',request});return {cas_valid:true,correct:options.failGrade?false:request.student==='(x+1)^2'};}
    write(command){calls.push({kind:'write',command});assert.equal(command.split('\n').length,2);assert.ok(command.startsWith(':lisp (defun maxima::$ctm_force_gc'));}
    terminate(){this.child?.terminate();this.ready=null;this.poisoned=true;}
  }
  const context=vm.createContext({self,importScripts(){},MaximaSession:Session,URL,location:{href:'http://fixture/clean-probe-worker.js'},performance:{timeOrigin:100000,now:()=>++ticks},SharedArrayBuffer,Atomics,JSON,Error,setTimeout});
  vm.runInContext(workerSource,context);const data={type:'run',runId:'fixture-run-0000000000001',arm:options.arm||'control',candidate:options.compiled?'precompiled':'source',manifest:'source.json',expected:{stackRevision:'pin',stackLibraryVersion:'version',maximaVersion:'maxima',compiledStack:{asset:{fileBytes:7,sha256:'hash'}}},checks,nativePrograms};
  await self.onmessage({data});const result=messages.findLast(r=>r.type==='complete').progress;
  if(options.reuse)await self.onmessage({data:{...data,runId:'fixture-run-0000000000002'}});
  await self.onmessage({data:{type:'stop',runId:data.runId}});
  return {result,calls,messages,session,terminations};
}
const clean=await fakeProbe();assert.equal(clean.result.ok,true);assert.equal(clean.result.correctnessPassed,true);assert.equal(clean.calls[0].expression,checks[0].expression);assert.equal(clean.calls[1].kind,'assess');assert.equal(clean.calls[1].request.student,'(x+1)^2');assert.equal(clean.calls[2].request.student,'x+1');
assert.equal(clean.result.checks.length,10);assert.equal(clean.result.warmGrades.length,10);assert.equal(clean.result.warmCalls.length,10);assert.equal(clean.result.nativeCalls.length,3);assert.equal(clean.result.smoke.gcCalls.length,100);assert.equal(clean.result.smoke.plotting.length,4);assert.equal(clean.terminations,1);assert.equal(clean.messages.at(-1).stopped,true);assert.equal(clean.messages.at(-1).rejected,true);
assert.ok(clean.result.warmGrades.every(r=>r.elapsedMs===1)&&clean.result.warmCalls.every(r=>r.elapsedMs===1),'Progress serialization must remain outside measured call durations');
assert.equal((await fakeProbe({compiled:true})).result.ok,true);
for(const [options,pattern] of [[{preexisting:true},/already has/],[{staleRequest:true},/already executed/],[{compiled:true,badFasOpens:true},/FAS read/],[{compiled:true,sourceFallback:true},/source fallback/],[{compiled:true,badFasHash:true},/FAS identity/],[{failLogical:true},/Semantic mismatch/],[{failGrade:true},/Grade mismatch/],[{failNative:true},/Native result/],[{failGC:true},/Full collection/],[{failPlot:true},/Plot policy/]]){const value=await fakeProbe(options);assert.equal(value.result.ok,false);assert.match(value.result.error,pattern);if(options.failLogical)assert.equal(value.calls.some(r=>r.kind==='assess'),false);}
const reused=await fakeProbe({reuse:true});assert.match(reused.messages.filter(r=>r.type==='complete')[1].progress.error,/cannot be reused/);
const timings=compactResult(clean.result);assert.equal(timings.readyPlusFirstLogicalAndFirstPositiveMs,timings.readyMs+timings.firstLogicalMs+timings.firstPositiveGradeMs);
assert.equal(clean.result.experiment.status,'control-original-runtime');assert.equal(clean.result.experiment.comparisonEligible,true);
for(const options of [{missingGuard:true},{failedGuard:true},{delayedDuplicateGuard:true}]){const bad=await fakeProbe(options);assert.equal(bad.result.ok,false);assert.equal(bad.result.failedSessionTerminated,true);if(!options.delayedDuplicateGuard)assert.equal(bad.calls.length,0);assert.equal(bad.result.startupGuard.passed,false);}
for(const [options,status] of [
 [{},'missing'],[{receipt:'{bad'},'malformed'],[{receipt:successCapability,duplicateReceipt:true},'duplicate'],
 [{receipt:{...successCapability,supported:false,didSuppress:false,capability:{...successCapability.capability,writable:false},fallbackReason:'unsupported'}},'unsupported'],
 [{receipt:{...successCapability,didSuppress:false}},'untreated'],[{receipt:{...successCapability,originalStackTraceLimit:0}},'already-disabled-stack-capture'],[{receipt:{...successCapability,originalStackTraceLimit:-1}},'already-disabled-stack-capture'],[{receipt:{...successCapability,descriptorRestored:false}},'not-restored'],
 [{receipt:{...successCapability,stack:{type:'string',lineCount:4,frameCount:3}}},'stack-suppression-unconfirmed'],
 [{receipt:{...successCapability,assignedErrno:54}},'malformed'],[{receipt:successCapability},'applied']]){
 const value=await fakeProbe({arm:'errno-stack-suppressed',...options});assert.equal(value.result.ok,true);assert.equal(value.result.experiment.status,status);assert.equal(value.result.experiment.comparisonEligible,status==='applied');}
assert.equal((await fakeProbe({receipt:successCapability})).result.experiment.status,'unexpected-control-receipt');
const samples=[{id:'c',arm:'control',candidate:'source',mode:'cold',repetition:1,ok:true,timings,experiment:clean.result.experiment},{id:'e',arm:'errno-stack-suppressed',candidate:'source',mode:'cold',repetition:1,ok:true,timings,experiment:{status:'applied',comparisonEligible:true}}];
assert.equal(summarize(samples).find(r=>r.arm==='control'&&r.candidate==='source'&&r.mode==='cold').comparisonEligibleTrials,1);assert.equal(pairedComparisons(samples).length,1);
samples[1].experiment={status:'unsupported',comparisonEligible:false};assert.equal(pairedComparisons(samples).length,0);assert.deepEqual(summarize(samples).find(r=>r.arm==='errno-stack-suppressed'&&r.candidate==='source'&&r.mode==='cold').medians,{});
samples[1].experiment.comparisonEligible=true;samples[0].experiment.comparisonEligible=false;assert.equal(pairedComparisons(samples).length,0);

function pageFixture({wrongStop=false,silent=false}={}){
  const timers=[],workers=[];const window={ctmCleanProgress(){}};
  class Worker{
    constructor(){workers.push(this);this.terminated=0;}
    postMessage(data){if(silent)return;queueMicrotask(()=>this.onmessage({data:data.type==='stop'?{type:'stopped',runId:data.runId,stopped:true,rejected:!wrongStop}:{type:'complete',progress:{runId:data.runId,ok:true,correctnessPassed:true}}}));}
    terminate(){this.terminated++;}
  }
  const context=vm.createContext({window,Worker,queueMicrotask,Promise,setTimeout:(fn,ms)=>{const id=timers.length;timers.push({fn,ms,cleared:false});return id;},clearTimeout:id=>{timers[id].cleared=true;}});
  return {context,window,workers,timers,run:input=>{context.input=input;return vm.runInContext('('+runPageMeasurement.toString()+')(input)',context);},stop:id=>{context.input=id;return vm.runInContext('('+stopPageWorker.toString()+')(input)',context);}};
}
const page=pageFixture();assert.equal((await page.run({runId:'cold'})).ok,true);assert.equal((await page.run({runId:'must-not-reuse'})).ok,false);assert.equal(page.workers.length,1);assert.equal((await page.stop('cold')).ok,true);assert.equal(page.workers[0].terminated,1);assert.equal(page.window.ctmCleanWorker,undefined);assert.equal((await page.run({runId:'reload'})).ok,true);assert.equal(page.workers.length,2);assert.notEqual(page.workers[0],page.workers[1]);assert.equal((await page.stop('reload')).ok,true);
const badStop=pageFixture({wrongStop:true});await badStop.run({runId:'cold'});assert.equal((await badStop.stop('cold')).ok,false);
const hung=pageFixture({silent:true}),pending=hung.run({runId:'hung'});assert.equal(hung.timers[0].ms,300000);hung.timers[0].fn();assert.match((await pending).error,/300-second/);const stopping=hung.stop('hung');assert.equal(hung.timers[1].ms,5000);hung.timers[1].fn();assert.equal((await stopping).ok,false);assert.equal(hung.workers[0].terminated,1);
console.log(JSON.stringify({passed:true,scope:'Synthetic trusted driver/session/browser transports only; no browser/CAS/Lisp/Wasm/artifact execution',groups:['24 balanced cells and both source/FAS orderings per arm','exact original/derived admission and allowed manifest deltas','original child/session lifecycle and first-call ordering','all typed/native/GC/error/plot guards','startup missing/failure rejection and termination','actual-child receipt classification including absent/fallback/malformed/duplicate/unrestored/untreated','capability-eligible summaries and matched pairs only','300-second watchdog/termination/reload','progress reporting excluded from timed calls']}));
