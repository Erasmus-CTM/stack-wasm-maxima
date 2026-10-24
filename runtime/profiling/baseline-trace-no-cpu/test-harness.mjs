import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {analyzeLoads,trialPlan,summarizeCPU,haltForCoreFailure} from './run.mjs';
import {instrumentChild,assertProfileAdmission,profileStartup,profileLispPath,digest} from './stage.mjs';
import {startCPUProfiles,startProcessCPU} from './cdp-profile.mjs';

const plan=trialPlan(3);assert.equal(plan.length,24);
assert.deepEqual(trialPlan(3,true),[{repetition:1,profile:'ecl-oz',arm:'instrumented',candidate:'source'},{repetition:1,profile:'ecl-oz',arm:'instrumented',candidate:'precompiled'}]);
for(const profile of ['baseline','ecl-oz'])for(const candidate of ['source','precompiled'])for(const arm of ['control','instrumented'])assert.equal(plan.filter(r=>r.profile===profile&&r.candidate===candidate&&r.arm===arm).length,3);
const calls=[{kind:'trace-enter',id:1,parent:0,depth:0,operation:'maxima-load',name:'a',startMs:10},
  {kind:'trace-enter',id:2,parent:1,depth:1,operation:'maxima-load',name:'b',startMs:20},
  {kind:'trace-call',id:2,parent:1,depth:1,operation:'maxima-load',name:'b',startMs:20,endMs:50,resolvedPath:'/b.lisp'},
  {kind:'trace-call',id:1,parent:0,depth:0,operation:'maxima-load',name:'a',startMs:10,endMs:80,resolvedPath:'/a.lisp'}];
const analysis=analyzeLoads(calls);assert.equal(analysis.frames[1].inclusiveElapsedMs,70);assert.equal(analysis.frames[1].exclusiveElapsedMs,40);assert.equal(analysis.frames[1].reportedRunClockMs,null);
assert.throws(()=>analyzeLoads([...calls,calls[2]]),/Duplicate/);
assert.throws(()=>analyzeLoads([{...calls[1],parent:2},{...calls[2],parent:2}]),/cyclic/);
const source=await readFile(new URL('../gc-aggregate-budget-fix/prototype/runtime/maxima-child.js',import.meta.url),'utf8');
const hooks=await readFile(new URL('./child-hooks.js',import.meta.url),'utf8');
const lisp=await readFile(new URL('./load-hooks.lisp',import.meta.url),'utf8'),derivedChild=instrumentChild(source,hooks,lisp);
assert.ok(derivedChild.includes('CTMProfile.installFS(FS)'));
assert.ok(derivedChild.includes('startupStdoutTail:stdoutTail.slice(-4096)'));
assert.throws(()=>instrumentChild(source.replace('      preInit();','      changed();'),hooks,lisp),/unique/);
assert.throws(()=>instrumentChild(source,hooks),/Exact Lisp/);
const originalStartup='m2_emit("CTMSTACK-LOAD-BEGIN")$\nload("stacklocallinux.mac")$\nm2_emit("CTMSTACK-LOAD-END")$',derivedStartup=profileStartup(originalStartup);
assert.equal(derivedStartup,':lisp (load "/ctm/no-rebuild-profile/load-hooks.lisp")\n'+originalStartup);
assert.deepEqual(derivedStartup.split('\n').filter(line=>line.startsWith(':lisp ')),[':lisp (load "/ctm/no-rebuild-profile/load-hooks.lisp")']);
async function fakeChildMount({corrupt=false}={}){
  const mounted=new Map(),order=[],messages=[],files=Array.from({length:77},(_,i)=>({path:'stack/fixture-'+i+'.mac',content:'/* fixture '+i+' */'})),originalFiles=structuredClone(files);
  let ticks=0,context;
  const FS={mkdirTree(){},createLazyFile(){},open(){throw Error('No runtime execution in fixture');},ioctl(){},ErrnoError:class extends Error{},isFile:()=>true,
    writeFile(path,body){const copy=new Uint8Array(body);if(corrupt&&path===profileLispPath)copy[0]^=1;mounted.set(path,copy);if(path===profileLispPath)order.push('hook-write');},
    readFile(path){order.push('hook-readback');return mounted.get(path);}};
  const self={location:{href:'http://fixture/runtime-profile/maxima-child.js'},postMessage:value=>messages.push(structuredClone(value)),addEventListener(){},importScripts(url){
    assert.ok(url.endsWith('/maxima_thread.js'),'Fixture forbids loading a runtime program');
    context.Module={preInit(){order.push('pre-init');},preRun:[]};
    self.onmessage=()=>{context.Module.preInit();for(const callback of context.Module.preRun)callback();order.push('native-initialization');};
  }};
  context=vm.createContext({self,FS,MEMFS:{ops_table:{dir:{node:{}}}},HEAP32:new Int32Array(16),performance:{timeOrigin:100000,now:()=>++ticks},WebAssembly:{},TextEncoder,TextDecoder,URL,SharedArrayBuffer,Int32Array,Uint32Array,Uint8Array,Atomics,JSON,Reflect,Error,String,Map});
  Object.defineProperty(context,'CTMProfile',{get:()=>self.CTMProfile});
  vm.runInContext(derivedChild,context);
  const buffers=[new SharedArrayBuffer(28),new SharedArrayBuffer(65536),new SharedArrayBuffer(65536)];
  await self.onmessage({data:{type:'start',baseURL:'http://fixture/maxima-runtime/',preload:false,buffers,manifest:{files,startup:derivedStartup}}});
  assert.deepEqual(files,originalFiles,'77 original embedded files changed');
  return {mounted,order,messages,input:String.fromCodePoint(...new Uint32Array(buffers[1]).slice(0,Atomics.load(new Int32Array(buffers[0]),1)))};
}
const mountedHook=await fakeChildMount();assert.ok(mountedHook.mounted.has(profileLispPath),JSON.stringify(mountedHook.messages));assert.deepEqual(Buffer.from(mountedHook.mounted.get(profileLispPath)),Buffer.from(lisp));assert.equal(mountedHook.input,derivedStartup);assert.ok(mountedHook.order.indexOf('hook-write')<mountedHook.order.indexOf('native-initialization'));assert.ok(mountedHook.order.indexOf('hook-readback')<mountedHook.order.indexOf('native-initialization'));
const mountProof=mountedHook.messages.find(r=>r.row?.kind==='lisp-hook-mounted').row;assert.equal(mountProof.path,profileLispPath);assert.equal(mountProof.bytes,Buffer.byteLength(lisp));assert.equal(mountProof.sha256,digest(lisp));assert.equal(mountedHook.mounted.size,78);
const corruptHook=await fakeChildMount({corrupt:true});assert.ok(corruptHook.messages.some(r=>r.type==='error'&&r.error.includes('hook mount differs')));assert.equal(corruptHook.order.includes('native-initialization'),false);
const rows=[],fault=Error('sentinel'),result={exports:{fixture:1}};
const self={postMessage:r=>rows.push(r),importScripts(...urls){if(urls[0]==='bad')throw fault;return 7;}};
const context=vm.createContext({self,performance:{now:()=>0,timeOrigin:0},WebAssembly:{instantiate:async()=>result},JSON,String,Reflect});
vm.runInContext(hooks,context);
assert.equal(self.importScripts('ok'),7);assert.throws(()=>self.importScripts('bad'),e=>e===fault);
assert.equal(await context.WebAssembly.instantiate(),result);
const stream={path:'/resolved/file',flags:0,node:{mode:33188}},fs={open(path){if(path==='bad')throw fault;return stream;}};
self.CTMProfile.installFS(fs);assert.equal(fs.open('ok'),stream);assert.throws(()=>fs.open('bad'),e=>e===fault);
self.CTMProfile.line('CTM-PROFILE|{"kind":"trace-start","active":true}');self.CTMProfile.line('1> ($LOAD "a")');self.CTMProfile.line('<1 ($LOAD "/a")');self.CTMProfile.line('CTM-PROFILE|{"kind":"trace-finish","restored":true}');assert.ok(rows.some(r=>r.row.kind==='trace-finish'));
const identity={runId:40108653819,runAttempt:1,head:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',testedRevision:'5295b5a79bfb983f9e43dd911e6f8ab65139a930',tree:'0e543f936a385548a7ffd53d68930bd88c033922'};
const admitted={schema:1,passed:true,source:identity,profiles:Object.fromEntries(['baseline','ecl-oz'].map((name,i)=>[name,{source:identity,compilerProfile:{name},packageManifest:{sha256:String(i).repeat(64)},artifact:{id:i?12568085269:12567788724},runtimeAssets:[]}]))};
const baselineManifest={runtimeBuild:{compilerProfile:{name:'baseline'},manifestSha256:'0'.repeat(64)},runtimeAssets:[]};
assertProfileAdmission(admitted,'baseline',baselineManifest);
assert.throws(()=>assertProfileAdmission(admitted,'ecl-oz',baselineManifest),/profile differs/);
assert.throws(()=>assertProfileAdmission(admitted,'baseline',{...baselineManifest,runtimeBuild:{...baselineManifest.runtimeBuild,manifestSha256:'f'.repeat(64)}}),/Package identity/);
assert.throws(()=>assertProfileAdmission({...admitted,passed:false},'baseline',baselineManifest),/admission/);
const cpu=summarizeCPU({profiles:[{target:{type:'worker'},profile:{nodes:[{id:1,callFrame:{functionName:'wasm-function[1]',url:'wasm://fixture',scriptId:'1'}}],samples:[1,1],timeDeltas:[100,200],startTime:0,endTime:300}}]});assert.equal(cpu[0].topSelfSampleIntervals[0].sampledIntervalMicroseconds,300);assert.equal(cpu[0].topSelfSampleIntervals[0].opaqueWasm,true);
const errnoFrame={functionName:'ErrnoError',url:'http://fixture/runtime.js',scriptId:'7',lineNumber:1,columnNumber:2};
const groupedCPU=summarizeCPU({profiles:[{target:{type:'worker'},profile:{nodes:[{id:1,callFrame:errnoFrame},{id:2,callFrame:errnoFrame},{id:3,callFrame:{...errnoFrame,columnNumber:3}}],samples:[1,2,3],timeDeltas:[100,200,50],startTime:0,endTime:350}}]})[0];
assert.equal(groupedCPU.topSelfSampleIntervals[0].sampledIntervalMicroseconds,200);assert.equal(groupedCPU.topCallFramesBySelfSampleIntervals[0].sampledIntervalMicroseconds,300);assert.deepEqual(groupedCPU.topCallFramesBySelfSampleIntervals[0].nodeIds,[1,2]);assert.equal(groupedCPU.topCallFramesBySelfSampleIntervals.length,2);
let processReplies=0;const processSampler=await startProcessCPU({newBrowserCDPSession:async()=>({send:async method=>{assert.equal(method,'SystemInfo.getProcessInfo');return {processInfo:[{id:1,type:'renderer',cpuTime:1+(processReplies++)/4}]};}})}),processResult=await processSampler.stop();
assert.equal(processResult.snapshots.length,2);assert.equal(processResult.totalObservedCPUSeconds,0.25);for(const row of processResult.snapshots)assert.equal(row.epochMs,processResult.performanceTimeOriginEpochMs+row.wallMs);
const probe=await readFile(new URL('./probe-worker.js',import.meta.url),'utf8');
async function fakeProbe(options={}){
  const messages=[],calls=[];let assignments=0,clock=0,child;const OriginalWorker=class{addEventListener(name,listener){this.listener=listener;}emit(row){this.listener?.({data:{type:'ctm-profile',row}});}};let WorkerClass=OriginalWorker;
  const self={postMessage:value=>messages.push(structuredClone(value))};Object.defineProperty(self,'Worker',{get:()=>WorkerClass,set:value=>{assignments++;WorkerClass=value;},configurable:true});
  class Session{
    constructor(){this.manifest={stackRevision:'pin'};}
    async init(){if(options.instrumented)child=new self.Worker();return {stackLibraryVersion:'version',maximaVersion:'maxima',stages:{stackLoadMs:1}};}
    evaluate(expression){calls.push({kind:'evaluate',expression});if(expression==='logical')return options.failLogical?false:true;if(expression==='6*7')return 42;if(expression.startsWith('[STACKpmOPT'))return ['#pm#',true,true,true,false,'~d','~a','.',true,true];return true;}
    assess(request){calls.push({kind:'assess',request});return {cas_valid:true,correct:options.failGrade?false:request.student==='(x+1)^2'};}
    write(){assert.equal(options.instrumented,true,'Clean mode must not send profile commands');child.emit({kind:'trace-start',active:true});child.emit({kind:'trace-enter',id:1});child.emit({kind:'trace-call',id:1,operation:'maxima-load'});if(options.observerError)child.emit({kind:'observer-error',error:'fixture parse failure'});child.emit({kind:'trace-finish',observed:options.missingFrame?2:1,entries:1,dropped:0,openFrames:0,observerErrors:0,jsDropped:0,restored:true});}
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
const aligned=analyzeLoads([{kind:'child-created',createdEpochMs:1000},{...calls[0],startMs:120},{...calls[3],startMs:120,endMs:180}],[{name:'first-positive-grade',startEpochMs:1110,endEpochMs:1200}]);
assert.equal(aligned.frames[0].phaseAlignment.startEpochMs,1120);assert.equal(aligned.frames[0].phaseAlignment.overlaps[0].phase,'first-positive-grade');assert.equal(aligned.frames[0].phaseAlignment.overlaps[0].overlapMs,60);
assert.equal(haltForCoreFailure({arm:'instrumented',ok:false}),true);assert.equal(haltForCoreFailure({arm:'control',ok:false}),false);assert.equal(haltForCoreFailure({arm:'instrumented',ok:true,cpuUnavailable:'optional fixture failure'}),false);

// Exercise much more traffic than the failed CI run without spending the Lisp budget.
const stressRows=[],stressSelf={postMessage:value=>stressRows.push(structuredClone(value)),importScripts(){return 17;}};let stressClock=0;
const stressVM=vm.createContext({self:stressSelf,performance:{timeOrigin:0,now:()=>stressClock++},WebAssembly:{},JSON,String,Reflect});vm.runInContext(hooks,stressVM);
const missing=Object.assign(Error('fixture missing'),{errno:44});
const stressFS={open(path){if(path.startsWith('/missing/'))throw missing;return {path,flags:0,node:{mode:path.startsWith('/directory/')?16877:33188}};}};stressSelf.CTMProfile.installFS(stressFS);
stressSelf.CTMProfile.line('CTM-PROFILE|{"kind":"trace-start","active":true}');
for(let i=0;i<10000;i++){stressFS.open('/directory/'+i);assert.throws(()=>stressFS.open('/missing/'+i,'r'),e=>e===missing);}
for(let i=0;i<100;i++)assert.throws(()=>stressFS.open('/missing/overflow-'+i,i),e=>e===missing);
for(let i=0;i<10000;i++)stressFS.open('/locale');for(let i=0;i<600;i++)stressFS.open('/path/'+i);
for(let i=0;i<2000;i++)assert.equal(stressSelf.importScripts('optional-js-span'),17);
stressSelf.CTMProfile.line('1> ($LOAD "a")');stressSelf.CTMProfile.line('<1 ($LOAD "/a")');
stressSelf.CTMProfile.line('CTM-PROFILE|'+JSON.stringify({kind:'trace-finish',restored:true}));
const stress=stressRows.map(r=>r.row),finish=stress.find(r=>r.kind==='trace-finish'),fsSummary=stress.find(r=>r.kind==='fs-summary');
assert.equal(stress.filter(r=>r.kind==='trace-finish').length,1);assert.equal(stress.filter(r=>r.kind==='trace-call').length,1);assert.equal(finish.jsDropped,0);assert.ok(finish.ordinaryEventsDropped>0);assert.ok(stress.length<1800);
assert.equal(fsSummary.totalOpenCalls,30700);assert.equal(fsSummary.totalOpenElapsedMs,30700);assert.equal(fsSummary.paths.length,512);assert.equal(fsSummary.unbucketedFileCalls,89);assert.equal(fsSummary.unbucketedFileElapsedMs,89);assert.equal(fsSummary.unbucketedOtherCalls,38);assert.equal(fsSummary.unbucketedOtherElapsedMs,38);assert.equal(fsSummary.paths.find(r=>r.path==='/locale').opens,10000);
assert.equal(fsSummary.otherGroups.length,64);assert.deepEqual(fsSummary.otherGroups.slice(0,2).map(r=>[r.kind,r.opens,r.examples.length]),[['directory',10000,4],['failure',10000,4]]);assert.equal(fsSummary.otherGroups[1].errorCode,44);assert.equal(fsSummary.otherGroups[1].flags,'r');
assert.equal(analyzeLoads(stress).successfulReadOpensByResolvedPath[0].opens,10000);
assert.throws(()=>analyzeLoads([{...fsSummary,totalOpenCalls:30701}]),/aggregate count/);
assert.throws(()=>analyzeLoads([{...fsSummary,totalOpenElapsedMs:30701}]),/aggregate duration/);
const malformedRows=[],malformedSelf={postMessage:value=>malformedRows.push(structuredClone(value)),importScripts(){}};
vm.runInContext(hooks,vm.createContext({self:malformedSelf,performance:{now:()=>0,timeOrigin:0},WebAssembly:{},JSON,String,Reflect}));
malformedSelf.CTMProfile.line('CTM-PROFILE|{"kind":"trace-start","active":true}');malformedSelf.CTMProfile.line('CTM-PROFILE|{not-json');malformedSelf.CTMProfile.line('CTM-PROFILE|'+JSON.stringify({kind:'trace-finish',restored:true}));
assert.equal(malformedRows.find(r=>r.row.kind==='trace-finish').row.jsDropped,1);assert.equal(malformedRows.filter(r=>r.row.kind==='observer-error').length,1);

// Replay retained stdout strictly as data; no Lisp reader or artifact program runs.
function parseTraceLines(lines){
  const records=[],self={postMessage:value=>records.push(structuredClone(value)),importScripts(){}};let clock=0;
  vm.runInContext(hooks,vm.createContext({self,performance:{now:()=>++clock,timeOrigin:100000},WebAssembly:{},JSON,String,Reflect}));
  self.CTMProfile.line('CTM-PROFILE|{"kind":"trace-start","active":true}');for(const line of lines)self.CTMProfile.line(line);
  self.CTMProfile.line('CTM-PROFILE|{"kind":"trace-finish","restored":true}');
  return records.map(r=>r.row);
}
const traceFixtures=[['original-failure/test-results/milestone-one/browser-3338304.json',false,30,27,3],
  ['frozen-replay/attempts/01-compiled/results/browser-3338304.json',true,53,53,0],
  ['frozen-replay/attempts/02-source/results/browser-3338304.json',true,81,81,0],
  ['frozen-replay/attempts/03-compiled/results/browser-3338304.json',true,53,53,0]],actualTraceReplays=[];
for(const [relative,ok,entryCount,returnCount,openFrames] of traceFixtures){
  const path=new URL('../ecl-root-localization/runtime/diagnostics/ecl-root-localization/evidence/'+relative,import.meta.url),body=await readFile(path),value=JSON.parse(body);assert.equal(value.ok,ok);
  const parsed=parseTraceLines(value.stdout.split(/\r?\n/)),finish=parsed.find(r=>r.kind==='trace-finish');
  assert.equal(parsed.filter(r=>r.kind==='trace-enter').length,entryCount);assert.equal(parsed.filter(r=>r.kind==='trace-call').length,returnCount);assert.equal(finish.openFrames,openFrames);assert.equal(finish.observerErrors,0);assert.equal(finish.dropped,0);assert.equal(finish.jsDropped,0);
  if(ok){const analyzed=analyzeLoads(parsed);assert.equal(analyzed.frames.length,returnCount);assert.ok(analyzed.groupedByResolvedReturnPath.length>0);}
  actualTraceReplays.push({relative,sha256:digest(body),declaredOk:ok,entries:entryCount,returns:returnCount,openFrames});
}
const quoted=parseTraceLines(['(%i3) 1> ($LOAD "a\\\"b\\\\c")','| 2> (MAXIMA::$LOAD $FUNCTS)','| <2 ($LOAD "/share/functs.mac")','<1 ($LOAD "/resolved/file")']);
assert.equal(quoted.find(r=>r.kind==='trace-enter').name,'a"b\\c');assert.equal(quoted.find(r=>r.kind==='trace-call').argumentKind,'symbol');assert.equal(quoted.find(r=>r.kind==='trace-call').resolvedPath,'/share/functs.mac');
for(const lines of [['2> ($LOAD "a")'],['<1 ($LOAD "a")'],['1> ($LOAD "a" "b")'],['1> ($LOAD #.(danger))'],['1> ($LOAD "unterminated)'],['1> ($LOAD "a")','| 2> ($LOAD "b")','<1 ($LOAD "a")']]){const rows=parseTraceLines(lines);assert.ok(rows.some(r=>r.kind==='observer-error'));assert.ok(rows.find(r=>r.kind==='trace-finish').observerErrors>0);}
const capped=parseTraceLines(Array.from({length:513},(_,i)=>['1> ($LOAD "file-'+i+'")','<1 ($LOAD "/file-'+i+'")']).flat());
assert.equal(capped.filter(r=>r.kind==='trace-enter').length,512);assert.equal(capped.filter(r=>r.kind==='trace-call').length,512);assert.equal(capped.find(r=>r.kind==='trace-finish').dropped,1);assert.equal(capped.find(r=>r.kind==='trace-finish').jsDropped,0);
const tooDeep=parseTraceLines([...Array.from({length:65},(_,i)=>(i+1)+'> ($LOAD "a")'),...Array.from({length:65},(_,i)=>'<'+(65-i)+' ($LOAD "/a")')]);assert.ok(tooDeep.find(r=>r.kind==='trace-finish').observerErrors>0);

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
console.log(JSON.stringify({passed:true,scope:'Trusted JS mocks plus retained stdout JSON replayed only as data; no runtime, browser, artifact program or Lisp execution',actualTraceReplays,checks:['default24 planned cells','explicit two-cell Oz operational pilot','nested exclusive durations','elapsed intervals never reported as ECL CPU','duplicate/cyclic frame rejection','exact child-source anchors and bounded startup stdout','import exception/return preservation','Wasm result preservation','FS stream/exception preservation','flush marker forwarding','admission required','swapped profile rejected','manifest tamper rejected','CPU leaf summary','clean Worker untouched','first logical before grades','logical mismatch rejected before grading','wrong grade rejected','finite ordered phase timestamps','direct child epoch phase alignment','core failure halts but optional CPU does not','30700 filesystem opens bounded and counted','early directory and failure traffic cannot consume file buckets','optional event saturation preserves trace and finish','bad aggregate count and duration rejected','page-root and nested CDP profiles','failed nested profiler still resumes child','rejected root attach stops profiler','instrumented fake session restores Worker','observer error records rejected','missing declared trace frames rejected','malformed profile JSON increments finish error counter','one physical Lisp load command preserves original startup','exact hook file mounted before native initialization','77 embedded STACK files unchanged','corrupt hook mount fails before initialization','canonical CPU call-frame aggregation retains node identities','process CPU snapshots include epoch alignment','three successful retained stdout traces parsed completely','original failed trace retains three open frames','Lisp string escapes and symbol arguments parsed without evaluation','malformed and mismatched traces rejected','512-frame and64-depth limits fail visibly']}));
