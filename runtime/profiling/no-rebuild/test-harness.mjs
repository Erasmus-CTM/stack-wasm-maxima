import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {analyzeLoads,trialPlan,summarizeCPU} from './run.mjs';
import {instrumentChild,assertProfileAdmission} from './stage.mjs';

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
assert.throws(()=>instrumentChild(source.replace('      preInit();','      changed();'),hooks),/unique/);
const rows=[],fault=Error('sentinel'),result={exports:{fixture:1}};
const self={postMessage:r=>rows.push(r),importScripts(...urls){if(urls[0]==='bad')throw fault;return 7;}};
const context=vm.createContext({self,performance:{now:()=>0,timeOrigin:0},WebAssembly:{instantiate:async()=>result},JSON,String,Reflect});
vm.runInContext(hooks,context);
assert.equal(self.importScripts('ok'),7);assert.throws(()=>self.importScripts('bad'),e=>e===fault);
assert.equal(await context.WebAssembly.instantiate(),result);
const stream={path:'/resolved/file',flags:0},fs={open(path){if(path==='bad')throw fault;return stream;}};
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
  const messages=[],calls=[];let assignments=0,clock=0;const OriginalWorker=class{};
  const self={postMessage:value=>messages.push(structuredClone(value))};Object.defineProperty(self,'Worker',{get:()=>OriginalWorker,set:()=>{assignments++;},configurable:true});
  class Session{
    constructor(){this.manifest={stackRevision:'pin'};}
    async init(){return {stackLibraryVersion:'version',maximaVersion:'maxima',stages:{stackLoadMs:1}};}
    evaluate(expression){calls.push({kind:'evaluate',expression});if(expression==='logical')return options.failLogical?false:true;if(expression==='6*7')return 42;if(expression.startsWith('[STACKpmOPT'))return ['#pm#',true,true,true,false,'~d','~a','.',true,true];return true;}
    assess(request){calls.push({kind:'assess',request});return {cas_valid:true,correct:options.failGrade?false:request.student==='(x+1)^2'};}
    write(){throw Error('Clean mode must not send profile commands');}
  }
  const context=vm.createContext({self,importScripts(){},MaximaSession:Session,URL,location:{href:'http://fixture/no-rebuild-probe-worker.js'},performance:{now:()=>++clock},setTimeout,Promise,JSON,Error});
  vm.runInContext(probe,context);await self.onmessage({data:{candidate:'source',instrumented:false,manifest:'source.json',expected:{stackRevision:'pin',stackLibraryVersion:'version',maximaVersion:'maxima'},checks:Array.from({length:10},(_,i)=>({name:i?'check-'+i:'first-call-logical-validation',expression:i?'check-'+i:'logical',expected:true}))}});
  return {messages,calls,assignments,result:messages.findLast(x=>x.type==='complete').progress};
}
const clean=await fakeProbe();assert.equal(clean.result.ok,true);assert.equal(clean.assignments,0);assert.equal(clean.calls[0].expression,'logical');assert.equal(clean.calls[1].kind,'assess');assert.equal(clean.calls[1].request.student,'(x+1)^2');assert.equal(clean.calls[2].request.student,'x+1');
const badLogical=await fakeProbe({failLogical:true});assert.equal(badLogical.result.ok,false);assert.equal(badLogical.calls.filter(c=>c.kind==='assess').length,0);
const badGrade=await fakeProbe({failGrade:true});assert.equal(badGrade.result.ok,false);assert.equal(badGrade.result.correctnessPassed,false);
console.log(JSON.stringify({passed:true,scope:'Synthetic trusted harness tests only; no runtime, browser, artifact program or Lisp execution',checks:['24 planned cells','nested exclusive durations','unavailable run-clock handling','duplicate/cyclic frame rejection','exact child-source anchors','import exception/return preservation','Wasm result preservation','FS stream/exception preservation','flush marker forwarding','admission required','swapped profile rejected','manifest tamper rejected','CPU leaf summary','clean Worker untouched','first logical before grades','logical mismatch rejected before grading','wrong grade rejected']}));
