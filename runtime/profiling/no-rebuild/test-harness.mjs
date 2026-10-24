import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {analyzeLoads,trialPlan,summarizeCPU,haltForCoreFailure} from './run.mjs';
import {instrumentChild,assertProfileAdmission} from './stage.mjs';
import {startCPUProfiles} from './cdp-profile.mjs';

const plan=trialPlan(3);assert.equal(plan.length,24);
for(const profile of ['baseline','ecl-oz'])for(const candidate of ['source','precompiled'])for(const arm of ['control','instrumented'])assert.equal(plan.filter(r=>r.profile===profile&&r.candidate===candidate&&r.arm===arm).length,3);
const calls=[{kind:'lisp-clock-calibration',runTicks:0,realTicks:20,units:1000},
  {kind:'lisp-call',id:2,parent:1,depth:1,operation:'cl-load',name:'/a.lisp',realStart:20,realEnd:50,runStart:0,runEnd:0,units:1000},
  {kind:'lisp-call',id:1,parent:0,depth:0,operation:'maxima-load',name:'a',realStart:10,realEnd:80,runStart:0,runEnd:0,units:1000}];
const analysis=analyzeLoads(calls);assert.equal(analysis.frames[1].inclusiveElapsedMs,70);assert.equal(analysis.frames[1].exclusiveElapsedMs,40);assert.equal(analysis.frames[1].reportedRunClockMs,null);
assert.throws(()=>analyzeLoads([...calls,calls[1]]),/Duplicate/);
assert.throws(()=>analyzeLoads([calls[0],{...calls[1],parent:2}]),/cyclic/);
const source=await readFile(new URL('../gc-aggregate-budget-fix/prototype/runtime/maxima-child.js',import.meta.url),'utf8');
const hooks=await readFile(new URL('./child-hooks.js',import.meta.url),'utf8');
assert.ok(instrumentChild(source,hooks).includes('CTMProfile.installFS(FS)'));
assert.ok(instrumentChild(source,hooks).includes('startupStdoutTail:stdoutTail.slice(-4096)'));
assert.throws(()=>instrumentChild(source.replace('      preInit();','      changed();'),hooks),/unique/);
const rows=[],fault=Error('sentinel'),result={exports:{fixture:1}};
const self={postMessage:r=>rows.push(r),importScripts(...urls){if(urls[0]==='bad')throw fault;return 7;}};
const context=vm.createContext({self,performance:{now:()=>0,timeOrigin:0},WebAssembly:{instantiate:async()=>result},JSON,String,Reflect});
vm.runInContext(hooks,context);
assert.equal(self.importScripts('ok'),7);assert.throws(()=>self.importScripts('bad'),e=>e===fault);
assert.equal(await context.WebAssembly.instantiate(),result);
const stream={path:'/resolved/file',flags:0,node:{mode:33188}},fs={open(path){if(path==='bad')throw fault;return stream;}};
self.CTMProfile.installFS(fs);assert.equal(fs.open('ok'),stream);assert.throws(()=>fs.open('bad'),e=>e===fault);
self.CTMProfile.line('CTM-PROFILE|{"kind":"lisp-finish","dropped":0}');assert.ok(rows.some(r=>r.row.kind==='lisp-finish'));
const identity={runId:40108653819,runAttempt:1,head:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',testedRevision:'5295b5a79bfb983f9e43dd911e6f8ab65139a930',tree:'0e543f936a385548a7ffd53d68930bd88c033922'};
const admitted={schema:1,passed:true,source:identity,profiles:Object.fromEntries(['baseline','ecl-oz'].map((name,i)=>[name,{source:identity,compilerProfile:{name},packageManifest:{sha256:String(i).repeat(64)},artifact:{id:i?12568085269:12567788724},runtimeAssets:[]}]))};
const baselineManifest={runtimeBuild:{compilerProfile:{name:'baseline'},manifestSha256:'0'.repeat(64)},runtimeAssets:[]};
assertProfileAdmission(admitted,'baseline',baselineManifest);
assert.throws(()=>assertProfileAdmission(admitted,'ecl-oz',baselineManifest),/profile differs/);
assert.throws(()=>assertProfileAdmission(admitted,'baseline',{...baselineManifest,runtimeBuild:{...baselineManifest.runtimeBuild,manifestSha256:'f'.repeat(64)}}),/Package identity/);
assert.throws(()=>assertProfileAdmission({...admitted,passed:false},'baseline',baselineManifest),/admission/);
const cpu=summarizeCPU({profiles:[{target:{type:'worker'},profile:{nodes:[{id:1,callFrame:{functionName:'wasm-function[1]',url:'wasm://fixture',scriptId:'1'}}],samples:[1,1],timeDeltas:[100,200],startTime:0,endTime:300}}]});assert.equal(cpu[0].topSelfSampleIntervals[0].sampledIntervalMicroseconds,300);assert.equal(cpu[0].topSelfSampleIntervals[0].opaqueWasm,true);
const probe=await readFile(new URL('./probe-worker.js',import.meta.url),'utf8');
async function fakeProbe(options={}){
  const messages=[],calls=[];let assignments=0,clock=0,child;const OriginalWorker=class{addEventListener(name,listener){this.listener=listener;}emit(row){this.listener?.({data:{type:'ctm-profile',row}});}};let WorkerClass=OriginalWorker;
  const self={postMessage:value=>messages.push(structuredClone(value))};Object.defineProperty(self,'Worker',{get:()=>WorkerClass,set:value=>{assignments++;WorkerClass=value;},configurable:true});
  class Session{
    constructor(){this.manifest={stackRevision:'pin'};}
    async init(){if(options.instrumented)child=new self.Worker();return {stackLibraryVersion:'version',maximaVersion:'maxima',stages:{stackLoadMs:1}};}
    evaluate(expression){calls.push({kind:'evaluate',expression});if(expression==='logical')return options.failLogical?false:true;if(expression==='6*7')return 42;if(expression.startsWith('[STACKpmOPT'))return ['#pm#',true,true,true,false,'~d','~a','.',true,true];return true;}
    assess(request){calls.push({kind:'assess',request});return {cas_valid:true,correct:options.failGrade?false:request.student==='(x+1)^2'};}
    write(){assert.equal(options.instrumented,true,'Clean mode must not send profile commands');child.emit({kind:'lisp-call',operation:'maxima-load'});if(options.observerError)child.emit({kind:'observer-error',error:'fixture parse failure'});child.emit({kind:'lisp-finish',observed:options.missingFrame?2:1,dropped:0,observerErrors:0,jsDropped:0,changedFunctions:0});}
  }
  const context=vm.createContext({self,importScripts(){},MaximaSession:Session,URL,location:{href:'http://fixture/no-rebuild-probe-worker.js'},performance:{timeOrigin:100000,now:()=>++clock},setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},Promise,JSON,Error});
  vm.runInContext(probe,context);await self.onmessage({data:{candidate:'source',instrumented:Boolean(options.instrumented),manifest:'source.json',expected:{stackRevision:'pin',stackLibraryVersion:'version',maximaVersion:'maxima'},checks:Array.from({length:10},(_,i)=>({name:i?'check-'+i:'first-call-logical-validation',expression:i?'check-'+i:'logical',expected:true}))}});
  return {messages,calls,assignments,result:messages.findLast(x=>x.type==='complete').progress};
}
const clean=await fakeProbe();assert.equal(clean.result.ok,true);assert.equal(clean.assignments,0);assert.equal(clean.calls[0].expression,'logical');assert.equal(clean.calls[1].kind,'assess');assert.equal(clean.calls[1].request.student,'(x+1)^2');assert.equal(clean.calls[2].request.student,'x+1');
const badLogical=await fakeProbe({failLogical:true});assert.equal(badLogical.result.ok,false);assert.equal(badLogical.calls.filter(c=>c.kind==='assess').length,0);
const badGrade=await fakeProbe({failGrade:true});assert.equal(badGrade.result.ok,false);assert.equal(badGrade.result.correctnessPassed,false);
const fakeInstrumented=await fakeProbe({instrumented:true});assert.equal(fakeInstrumented.result.ok,true);assert.equal(fakeInstrumented.assignments,2);
const observerFailure=await fakeProbe({instrumented:true,observerError:true});assert.equal(observerFailure.result.ok,false);assert.match(observerFailure.result.error,/Observer error/);
const missingFrame=await fakeProbe({instrumented:true,missingFrame:true});assert.equal(missingFrame.result.ok,false);assert.match(missingFrame.result.error,/frame count/);
assert.deepEqual(clean.result.phases.slice(0,4).map(r=>r.name),['initialization','first-call-logical-validation','first-positive-grade','first-negative-grade']);
for(const [i,r] of clean.result.phases.entries()){assert.ok(r.completed&&Number.isFinite(r.startEpochMs)&&Number.isFinite(r.endEpochMs)&&r.endEpochMs>=r.startEpochMs);if(i)assert.ok(r.startEpochMs>=clean.result.phases[i-1].endEpochMs);}
const aligned=analyzeLoads([{kind:'child-created',createdEpochMs:1000},{kind:'lisp-clock-start',childMs:100,realTicks:10000,units:1000},calls[0],{...calls[2],realStart:10020,realEnd:10080}],[{name:'first-positive-grade',startEpochMs:1110,endEpochMs:1200}]);
assert.equal(aligned.frames[0].phaseAlignment.startEpochMs,1120);assert.equal(aligned.frames[0].phaseAlignment.overlaps[0].phase,'first-positive-grade');assert.equal(aligned.frames[0].phaseAlignment.overlaps[0].overlapMs,60);
assert.equal(haltForCoreFailure({arm:'instrumented',ok:false}),true);assert.equal(haltForCoreFailure({arm:'control',ok:false}),false);assert.equal(haltForCoreFailure({arm:'instrumented',ok:true,cpuUnavailable:'optional fixture failure'}),false);

// Exercise much more traffic than the failed CI run without spending the Lisp budget.
const stressRows=[],stressSelf={postMessage:value=>stressRows.push(structuredClone(value)),importScripts(){return 17;}};let stressClock=0;
const stressVM=vm.createContext({self:stressSelf,performance:{timeOrigin:0,now:()=>stressClock++},WebAssembly:{},JSON,String,Reflect});vm.runInContext(hooks,stressVM);
const missing=Object.assign(Error('fixture missing'),{errno:44});
const stressFS={open(path){if(path.startsWith('/missing/'))throw missing;return {path,flags:0,node:{mode:path.startsWith('/directory/')?16877:33188}};}};stressSelf.CTMProfile.installFS(stressFS);
for(let i=0;i<10000;i++){stressFS.open('/directory/'+i);assert.throws(()=>stressFS.open('/missing/'+i,'r'),e=>e===missing);}
for(let i=0;i<100;i++)assert.throws(()=>stressFS.open('/missing/overflow-'+i,i),e=>e===missing);
for(let i=0;i<10000;i++)stressFS.open('/locale');for(let i=0;i<600;i++)stressFS.open('/path/'+i);
for(let i=0;i<2000;i++)assert.equal(stressSelf.importScripts('optional-js-span'),17);
stressSelf.CTMProfile.line('CTM-PROFILE|'+JSON.stringify({...calls[2],completed:true}));
stressSelf.CTMProfile.line('CTM-PROFILE|'+JSON.stringify({kind:'lisp-finish',dropped:0,observerErrors:0,changedFunctions:0}));
const stress=stressRows.map(r=>r.row),finish=stress.find(r=>r.kind==='lisp-finish'),fsSummary=stress.find(r=>r.kind==='fs-summary');
assert.equal(stress.filter(r=>r.kind==='lisp-finish').length,1);assert.equal(stress.filter(r=>r.kind==='lisp-call').length,1);assert.equal(finish.jsDropped,0);assert.ok(finish.ordinaryEventsDropped>0);assert.ok(stress.length<1600);
assert.equal(fsSummary.totalOpenCalls,30700);assert.equal(fsSummary.totalOpenElapsedMs,30700);assert.equal(fsSummary.paths.length,512);assert.equal(fsSummary.unbucketedFileCalls,89);assert.equal(fsSummary.unbucketedFileElapsedMs,89);assert.equal(fsSummary.unbucketedOtherCalls,38);assert.equal(fsSummary.unbucketedOtherElapsedMs,38);assert.equal(fsSummary.paths.find(r=>r.path==='/locale').opens,10000);
assert.equal(fsSummary.otherGroups.length,64);assert.deepEqual(fsSummary.otherGroups.slice(0,2).map(r=>[r.kind,r.opens,r.examples.length]),[['directory',10000,4],['failure',10000,4]]);assert.equal(fsSummary.otherGroups[1].errorCode,44);assert.equal(fsSummary.otherGroups[1].flags,'r');
assert.equal(analyzeLoads(stress).successfulReadOpensByResolvedPath[0].opens,10000);
assert.throws(()=>analyzeLoads([{...fsSummary,totalOpenCalls:30701}]),/aggregate count/);
assert.throws(()=>analyzeLoads([{...fsSummary,totalOpenElapsedMs:30701}]),/aggregate duration/);
const malformedRows=[],malformedSelf={postMessage:value=>malformedRows.push(structuredClone(value)),importScripts(){}};
vm.runInContext(hooks,vm.createContext({self:malformedSelf,performance:{now:()=>0,timeOrigin:0},WebAssembly:{},JSON,String,Reflect}));
malformedSelf.CTMProfile.line('CTM-PROFILE|{not-json');malformedSelf.CTMProfile.line('CTM-PROFILE|'+JSON.stringify({kind:'lisp-finish'}));
assert.equal(malformedRows.find(r=>r.row.kind==='lisp-finish').row.jsDropped,1);assert.equal(malformedRows.filter(r=>r.row.kind==='observer-error').length,1);

// Real transport shape, synthetic replies only: page -> probe worker -> nested CAS worker.
async function cdpFixture({failNestedStart=false,failRootAttach=false}={}){
  const sent=[],resumed=[],tinyProfile={nodes:[{id:1,callFrame:{functionName:'fixture',url:'fixture',scriptId:'1'}}],samples:[1],timeDeltas:[1000],startTime:0,endTime:1000};
  const info={root:{type:'page',targetId:'page',url:'about:blank'},w1:{type:'worker',targetId:'probe',url:'http://fixture/no-rebuild-probe-worker.js'},w2:{type:'worker',targetId:'cas',url:'http://fixture/runtime-profile/maxima-child.js'}};
  class Session extends EventEmitter{
    event(path,message){
      let wrapped=message;
      for(let i=path.length-1;i>0;i--)wrapped={method:'Target.receivedMessageFromTarget',params:{sessionId:path[i],message:JSON.stringify(wrapped)}};
      this.emit('Target.receivedMessageFromTarget',{sessionId:path[0],message:JSON.stringify(wrapped)});
    }
    async command(path,method,params={}){
      const where=path.at(-1)||'root';sent.push({where,method,params});
      if(method==='Target.sendMessageToTarget'){
        const message=JSON.parse(params.message),next=[...path,params.sessionId];
        queueMicrotask(async()=>{try{const result=await this.command(next,message.method,message.params);this.event(next,{id:message.id,result});}catch(error){this.event(next,{id:message.id,error:{message:String(error)}});}});return {};
      }
      if(method==='Target.getTargetInfo')return {targetInfo:info[where]};
      if(method==='Target.setAutoAttach'){
        assert.equal(params.flatten,false);
        if(params.autoAttach){
          if(where==='root'&&failRootAttach)throw Error('fixture page auto-attach rejected');
          const child=where==='root'?'w1':where==='w1'?'w2':null;
          if(child)queueMicrotask(()=>{const value={sessionId:child,targetInfo:info[child],waitingForDebugger:true};if(path.length)this.event(path,{method:'Target.attachedToTarget',params:value});else this.emit('Target.attachedToTarget',value);});
        }return {};
      }
      if(method==='Profiler.start'&&where==='w2'&&failNestedStart)throw Error('fixture nested profiler rejected');
      if(method==='Profiler.stop')return {profile:tinyProfile};
      if(method==='Runtime.runIfWaitingForDebugger')resumed.push(where);
      return {};
    }
    send(method,params){return this.command([],method,params);}
  }
  const session=new Session();let pageSessions=0;
  const page={context:()=>({newCDPSession:async value=>{assert.equal(value,page);pageSessions++;return session;}})};
  let sampler,error;try{sampler=await startCPUProfiles(page);}catch(e){error=e;}
  await new Promise(resolve=>setImmediate(resolve));
  const value=sampler?await sampler.stop():null;
  return {value,error,sent,resumed,pageSessions};
}
const pageCDP=await cdpFixture();assert.equal(pageCDP.pageSessions,1);assert.equal(pageCDP.value.complete,true);assert.equal(pageCDP.value.attachmentRoot,'page');assert.equal(pageCDP.value.profiles.length,3);assert.deepEqual(pageCDP.resumed.sort(),['w1','w2']);assert.equal(pageCDP.value.contexts.find(r=>r.target.targetId==='cas').started,true);
const partialCDP=await cdpFixture({failNestedStart:true});assert.equal(partialCDP.value.complete,false);assert.ok(partialCDP.value.errors.some(r=>r.phase==='configure'&&r.target.targetId==='cas'));assert.deepEqual(partialCDP.resumed.sort(),['w1','w2']);assert.equal(partialCDP.value.profiles.length,2);
const rejectedCDP=await cdpFixture({failRootAttach:true});assert.match(String(rejectedCDP.error),/page auto-attach rejected/);assert.ok(rejectedCDP.sent.some(r=>r.where==='root'&&r.method==='Profiler.stop'));
console.log(JSON.stringify({passed:true,scope:'Synthetic trusted harness tests only; no runtime, browser, artifact program or Lisp execution',checks:['24 planned cells','nested exclusive durations','unavailable run-clock handling','duplicate/cyclic frame rejection','exact child-source anchors and bounded startup stdout','import exception/return preservation','Wasm result preservation','FS stream/exception preservation','flush marker forwarding','admission required','swapped profile rejected','manifest tamper rejected','CPU leaf summary','clean Worker untouched','first logical before grades','logical mismatch rejected before grading','wrong grade rejected','finite ordered phase timestamps','approximate phase alignment','core failure halts but optional CPU does not','30700 filesystem opens bounded and counted','early directory and failure traffic cannot consume file buckets','optional event saturation preserves Lisp and finish','bad aggregate count and duration rejected','page-root and nested CDP profiles','failed nested profiler still resumes child','rejected root attach stops profiler','instrumented fake session restores Worker','observer error records rejected','missing declared Lisp frames rejected','malformed profile JSON increments finish error counter']}));
