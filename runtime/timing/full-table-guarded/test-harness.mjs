import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {profiles,trialPlan,validateAdmission,compactResult,summarize,runPageMeasurement,stopPageWorker,isFatalConsole} from './run.mjs';
const checks=JSON.parse(await readFile(new URL('../gc-aggregate-budget-fix/runtime/precompiled/restart-checks.json',import.meta.url))).checks;
const nativePrograms=['prepare','validate','prt'].map((operation,i)=>({operation,question:'synthetic',expression:'fixture-'+operation,expected:[i,true]}));
const plan=trialPlan(3);assert.equal(plan.length,18);assert.equal(plan.flatMap(p=>p.modes).length,36);
assert.throws(()=>trialPlan(1),/three repetitions/);
assert.equal(isFatalConsole('error','warning: unsupported syscall: __syscall_prlimit64'),false);assert.equal(isFatalConsole('error','warning: unsupported syscall: __syscall_getrusage'),false);
assert.equal(isFatalConsole('error','warning: unsupported syscall: __syscall_other'),true);assert.equal(isFatalConsole('warning','RuntimeError: memory access out of bounds'),true);assert.equal(isFatalConsole('log','Unexpected mark stack overflow'),true);
for(const profile of profiles)for(const candidate of ['source','precompiled'])for(const mode of ['cold','warm-profile-reload'])assert.equal(plan.filter(p=>p.profile===profile&&p.candidate===candidate&&p.modes.includes(mode)).length,3);
assert.deepEqual(plan.filter(p=>p.pair%6===1).map(p=>p.profile),profiles);
for(const profile of profiles)assert.equal(new Set([1,2,3].map(repetition=>plan.find(p=>p.profile===profile&&p.repetition===repetition).candidate)).size,2,'Each profile must alternate source/FAS order');
const identities={old:{runId:40108653819,runAttempt:1,head:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',testedRevision:'5295b5a79bfb983f9e43dd911e6f8ab65139a930',tree:'0e543f936a385548a7ffd53d68930bd88c033922',trustedRevision:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',recipeFiles:71},candidate:{runId:40136606442,runAttempt:1,head:'58cf269f303898a7b679d9d164346fbb9384b781',testedRevision:'58cf269f303898a7b679d9d164346fbb9384b781',tree:'3cf2954ebe3ab81990e47b37106d0e07b12b544d',trustedRevision:'58cf269f303898a7b679d9d164346fbb9384b781',recipeFiles:80}};
const assets=Array.from({length:79},(_,i)=>({path:'asset-'+i,bytes:i+1,sha256:'a'.repeat(64)}));
const admission={schema:1,passed:true,nativePrograms,profiles:Object.fromEntries(profiles.map((name,i)=>{const source=name===profiles[2]?identities.candidate:identities.old;return [name,{source:{...source,workflowId:123,jobs:[]},compilerProfile:{name},packageManifest:{bytes:123,sha256:String(i).repeat(64)},runtimeAssets:assets,nativePrograms,artifact:{id:i+1,name:(i===2?'maxima-oz-candidate-':'precompiled-stack-probe-')+name+'-'+source.testedRevision,digest:'sha256:'+'b'.repeat(64),size_in_bytes:100,workflow_run:{id:source.runId,head_sha:source.head}}}];}))};
const manifest=name=>({runtimeBuild:{compilerProfile:{name},manifestSha256:admission.profiles[name].packageManifest.sha256},runtimeAssets:assets.map(r=>({path:r.path,fileBytes:r.bytes,sha256:r.sha256})),files:Array.from({length:77},(_,i)=>({path:'stack/'+i}))});
for(const name of profiles)validateAdmission(admission,name,manifest(name));
assert.throws(()=>validateAdmission({...admission,passed:false},'baseline',manifest('baseline')),/admission/);
assert.throws(()=>validateAdmission(admission,'ecl-oz',manifest('baseline')),/swapped/);
const wrongName=structuredClone(admission);wrongName.profiles[profiles[2]].artifact.name='precompiled-stack-probe-'+profiles[2]+'-'+identities.candidate.testedRevision;assert.throws(()=>validateAdmission(wrongName,profiles[2],manifest(profiles[2])));
const wrongSource=structuredClone(admission);wrongSource.profiles[profiles[2]].source={...identities.old};assert.throws(()=>validateAdmission(wrongSource,profiles[2],manifest(profiles[2])),/Wrong source/);
const wrongPackage=manifest('baseline');wrongPackage.runtimeBuild.manifestSha256='f'.repeat(64);assert.throws(()=>validateAdmission(admission,'baseline',wrongPackage),/manifest swapped/);
const wrongAssets=manifest('baseline');wrongAssets.runtimeAssets[0].sha256='f'.repeat(64);assert.throws(()=>validateAdmission(admission,'baseline',wrongAssets),/asset closure/);
const wrongNative=structuredClone(admission);wrongNative.profiles.baseline.nativePrograms=structuredClone(nativePrograms);wrongNative.profiles.baseline.nativePrograms[0].expected=42;assert.throws(()=>validateAdmission(wrongNative,'baseline',manifest('baseline')),/Native workload/);

const workerSource=await readFile(new URL('./clean-probe-worker.js',import.meta.url),'utf8');
async function fakeProbe(options={}){
  const messages=[],calls=[];let ticks=0,terminations=0,session;
  const self={postMessage:value=>{ticks+=100;messages.push(structuredClone(value));}};Object.defineProperty(self,'Worker',{get:()=>class{},set:()=>{throw Error('Clean worker constructor must remain untouched');}});
  class Session{
    constructor(sessionOptions){session=this;this.options=sessionOptions;this.sequence=0;this.counters={nativeCalls:0};this.poisoned=false;this.manifest={stackRevision:'pin'};if(options.preexisting)this.child={terminate(){terminations++;}};}
    async init(){const guard={schema:1,kind:'ctm-startup-stdout-guard',passed:!options.failedGuard,failed:Boolean(options.failedGuard),firstFatal:options.failedGuard?{line:'loadfile: failed to load draw.lisp'}:null,state:'ready',beginCount:1,endCount:1,readyCount:1,stdoutTail:'fixture startup'};const emit=()=>this.options.onEvent({event:'maxima-diagnostic',text:'CTM-STARTUP-GUARD|'+JSON.stringify(guard)});if(!options.missingGuard)emit();if(options.delayedDuplicateGuard)setTimeout(emit,0);
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
  vm.runInContext(workerSource,context);const data={type:'run',runId:'fixture-run-0000000000001',candidate:options.compiled?'precompiled':'source',manifest:'source.json',expected:{stackRevision:'pin',stackLibraryVersion:'version',maximaVersion:'maxima',compiledStack:{asset:{fileBytes:7,sha256:'hash'}}},checks,nativePrograms};
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
for(const options of [{missingGuard:true},{failedGuard:true},{delayedDuplicateGuard:true}]){const value=await fakeProbe(options);assert.equal(value.result.ok,false);assert.equal(value.result.startupGuard.passed,false);assert.equal(value.result.failedSessionTerminated,true);if(!options.delayedDuplicateGuard)assert.equal(value.calls.length,0);}
const reused=await fakeProbe({reuse:true});assert.match(reused.messages.filter(r=>r.type==='complete')[1].progress.error,/cannot be reused/);
const timings=compactResult(clean.result);assert.equal(timings.readyPlusFirstLogicalAndFirstPositiveMs,timings.readyMs+timings.firstLogicalMs+timings.firstPositiveGradeMs);
assert.equal(summarize([{profile:'baseline',candidate:'source',mode:'cold',ok:true,timings}]).find(r=>r.profile==='baseline'&&r.candidate==='source'&&r.mode==='cold').successfulTrials,1);

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
console.log(JSON.stringify({passed:true,scope:'Trusted source with synthetic JS sessions/browser transports only; no browser, CAS, Lisp, Wasm or artifact program executed',checks:['36 balanced guarded cells','missing/fatal/delayed duplicate startup receipts reject and terminate','rotating profile order','both source/FAS orderings for every profile','minimum three repetitions','known syscall warnings retained and other fatal console text rejected','old/new source identities stay separate','exact candidate artifact prefix accepted','wrong artifact prefix rejected','failed admission rejected','profile swap rejected','source swap rejected','package swap rejected','asset tamper rejected','native workload substitution rejected','first logical before grades or warmup','clean Worker binding unchanged','ten typed controls and pinned policy','positive and negative grades','ten warm grades and arithmetic calls','three native programs','100 GC/live-object checks','caught-error recovery and four plot diagnostics','fresh worker/buffer guards','exact matching FAS read and zero fallback','logical failure rejects before grading','grade/native/GC/plot mismatches fail','worker reuse rejected','terminated session rejects calls','combined metric sums declared blocks','cold worker terminated before fresh reload worker','failed stop acknowledgment fails','300-second watchdog retains failure and forces cleanup','progress serialization excluded from measured call durations']}));
