// SPDX-License-Identifier: AGPL-3.0-or-later
// Alternating opt-in source/compiled observations on one CI runner.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {serveDemo} from '../../scripts/milestone-two/serve.mjs';

const site=resolve(process.env.PRECOMPILED_SITE||'site/_site');
const output=resolve(process.env.PRECOMPILED_REPORT||'test-results/precompiled-stack/measure.json');
const digest=body=>createHash('sha256').update(body).digest('hex');
await mkdir(resolve(output,'..'),{recursive:true});
const files=['stack-sources.json','stack-sources-timed-source.json','stack-sources-precompiled.json','maxima-runtime/stackmaxima.fas',
  'runtime/maxima-child.js','runtime/maxima-session.js'];
const restartChecksText=await readFile(new URL('./restart-checks.json',import.meta.url),'utf8');
const restartChecks=JSON.parse(restartChecksText);
assert.equal(restartChecks.schema,1);
assert.equal(restartChecks.kind,'full-session-restart');
assert.equal(restartChecks.checks.length,9);
assert.equal(new Set(restartChecks.checks.map(row=>row.name)).size,9);
assert.ok(restartChecks.checks.every(row=>Object.hasOwn(row,'expected')));
const report={schema:2,createdAt:new Date().toISOString(),sourceRevision:process.env.GITHUB_SHA||null,
  scope:'Opt-in local HTTP measurement with a fresh Chromium process/profile per candidate/repetition pair and one same-profile reload: four fresh profiles and eight cold/reload samples in the full matrix. Alternating order limits runner warming bias but does not remove it. Initial readiness includes Maxima and STACK; warm calls reuse that worker. Every trial then performs three full CAS session restarts in the same page/profile with warm caches, before the next same-profile page reload. Restart readiness is separate. lifecycleEncodedBodyBytes sums server-accounted response-body bytes across all four initializations and checks, not initial startup alone. The server records queued bodies before response finish; this total does not prove completed wire transfer or include internet traffic.',
  restartProtocol:{...restartChecks,sha256:digest(restartChecksText),bytes:Buffer.byteLength(restartChecksText)},
  files:[],samples:[],passed:false};
if(process.env.PRECOMPILED_DIAGNOSTIC_PROVENANCE){
  report.diagnosticInputs=JSON.parse(await readFile(process.env.PRECOMPILED_DIAGNOSTIC_PROVENANCE,'utf8'));
  assert.equal(report.diagnosticInputs.diagnosticOnly,true);
  report.diagnosticOnly=true;
  report.scope+=' Frozen separately built runtime and older entry bundle; no fresh-build/current-head parity clearance.';
}
const shortDiagnostic=process.env.PRECOMPILED_DIAGNOSTIC_SHORT==='1';
if(shortDiagnostic)assert.equal(report.diagnosticOnly,true,'Short trials cannot clear fresh-build parity');
const repetitions=shortDiagnostic?1:2;
const modes=shortDiagnostic?['cold']:['cold','warm-profile-reload'];
report.planned={trials:repetitions*2*modes.length,initializations:repetitions*8*modes.length,restarts:repetitions*6*modes.length};
if(shortDiagnostic){report.shortDiagnostic=true;report.scope+=' Short frozen diagnostic: one cold trial per loading mode, eight initializations; no full-matrix or timing clearance.';}
for(const path of files){const body=await readFile(join(site,path));report.files.push({path,bytes:body.length,sha256:digest(body)});}
const worker=`importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{let session;const progress={phase:'initializing',restartKind:'full-session-restart',restarts:[]};
const require=(condition,message)=>{if(!condition)throw new Error(message);};
const checkpoint=phase=>{progress.phase=phase;self.postMessage({type:'progress',progress});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const checks=${JSON.stringify(restartChecks.checks)};
const newSession=()=>new MaximaSession({baseURL:'./maxima-runtime/',stackSourceURL:'./'+data.manifest});
const initialize=async(target,generation)=>{
  target.generation=generation;checkpoint('initialize-'+generation);
  const started=performance.now();target.initialization=await session.init();target.readyMs=performance.now()-started;
  require(Number.isFinite(target.readyMs)&&target.readyMs>0,'Invalid initialization duration');
  const bytes=new TextEncoder().encode(JSON.stringify(session.manifest));
  target.manifestSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  require(target.manifestSha256===data.expected.manifestSha256,'Restart manifest content changed');
  target.version=session.evaluate('stackmaximaversion');
  require(String(target.version)===String(data.expected.stackLibraryVersion),'Restart STACK version mismatch');
  require(session.manifest.stackRevision===data.expected.stackRevision,'Restart STACK pin mismatch');
  const init=target.initialization,stages=init.stages;
  require(init.stackRevision===data.expected.stackRevision&&String(init.stackLibraryVersion)===String(data.expected.stackLibraryVersion),'Initialization identity mismatch');
  require(init.maximaVersion===data.expected.maximaVersion,'Maxima source version mismatch');
  require(Number.isFinite(stages.stackLoadMs)&&stages.stackLoadMs>0,'STACK initialization was not measured');
  if(data.expected.compiledStack){
    require(stages.compiledStackMounted===true&&stages.compiledStackBytes===data.expected.compiledStack.asset.fileBytes,'Compiled entry was not mounted');
    require(stages.compiledStackOpens>0&&stages.compiledSourceEntryOpens===0,'Compiled entry read/source fallback verification failed');
    require(stages.compiledStackSha256===data.expected.bundleSha256&&stages.compiledStackSha256===data.expected.compiledStack.asset.sha256,'Compiled entry hash mismatch');
  }else require(stages.compiledStackBytes===undefined&&stages.compiledStackMounted!==true,'Source control loaded a compiled entry');
};
const semantics=(target,generation)=>{
  checkpoint('policy-'+generation);
  target.policy=session.evaluate('[STACKpmOPT,algebraic_equivalence_factorp,algebraic_equivalence_trigexpandp,algebraic_equivalence_nounsp,tex_plain_atoms,stackintfmt,stackfltfmt,stackfltsep,setp(FORBIDDEN_SYMBOLS_SET),is(cardinality(FORBIDDEN_SYMBOLS_SET)>0)]');
  require(same(target.policy,['#pm#',true,true,true,false,'~d','~a','.',true,true]),'Fresh library policy differs from pinned defaults');
  target.checks=[];
  for(const check of checks){
    const row={name:check.name,result:null};target.checks.push(row);checkpoint('semantic-'+generation+':'+check.name);
    row.result=session.evaluate('block([%ERR:["stack_map"],%NOTES:["stack_map"],%FEEDBACK:["stack_map"],r],r:errcatch('+check.expression+'),if r=[] then [false,errormsgtostring()] else if length(%ERR)>1 then [false,string(%ERR)] else [true,first(r)])');
    require(Array.isArray(row.result)&&row.result[0]===true,'Lifecycle check failed: '+check.name+': '+JSON.stringify(row.result));
    const value=row.result[1];
    require(same(value,check.expected),'Lifecycle value mismatch: '+check.name+': '+JSON.stringify(value));
  }
};
const grade=(target,generation)=>{
  checkpoint('grade-'+generation);
  target.grade=session.assess({test:'AlgEquiv',student:'(x+1)^2',teacher:'x^2+2*x+1'});
  require(target.grade.cas_valid===true&&target.grade.correct===true,'Positive regrading failed');
  target.negativeGrade=session.assess({test:'AlgEquiv',student:'x+1',teacher:'x+2'});
  require(target.negativeGrade.cas_valid===true&&target.negativeGrade.correct===false,'Negative regrading failed');
};
try{
  session=newSession();await initialize(progress,0);
  checkpoint('warm-calls');progress.warmCalls=[];
  for(let i=0;i<10;i++){const started=performance.now();progress.warmCalls.push({value:session.evaluate('6*7'),elapsedMs:performance.now()-started});}
  require(progress.warmCalls.every(row=>row.value===42),'Warm arithmetic failed');
  grade(progress,0);semantics(progress,0);
  for(let generation=1;generation<=3;generation++){
    const round={generation,kind:'full-session-restart'};progress.restarts.push(round);checkpoint('seed-old-state-'+generation);
    session.write('ctm_restart_sentinel:123456$\\nctm_restart_private(x):=x+1$\\ndeclare(ctm_restart_symbol,integer)$\\nassume(ctm_restart_symbol>0)$\\nalgebraic_equivalence_nounsp:false$\\n',60000);
    round.oldState=session.evaluate("[ctm_restart_sentinel,ctm_restart_private(41),member('ctm_restart_private,map(lambda([f],op(f)),functions)),is(length(errcatch(fundef(ctm_restart_private)))=1),featurep(ctm_restart_symbol,integer),is(ctm_restart_symbol>0),is(algebraic_equivalence_nounsp=false)]");
    require(same(round.oldState,[123456,42,true,true,true,true,true]),'Disposable old state was not established');
    const previous=session,child=previous.child,buffers=[previous.controlBuffer,previous.inputBuffer,previous.outputBuffer];
    checkpoint('terminate-'+generation);previous.terminate();
    round.oldSessionStopped=previous.poisoned===true&&previous.ready===null;
    try{previous.evaluate('6*7');round.oldSessionRejected=false;}catch(error){round.oldSessionRejected=/not ready/i.test(String(error));}
    require(round.oldSessionStopped&&round.oldSessionRejected,'Terminated session still accepts evaluation');
    session=newSession();await initialize(round,generation);
    round.childReplaced=Boolean(session.child)&&session.child!==child;
    round.buffersReplaced=[session.controlBuffer,session.inputBuffer,session.outputBuffer].map((buffer,index)=>Boolean(buffer)&&buffer!==buffers[index]);
    require(round.childReplaced&&round.buffersReplaced.every(value=>value===true),'Restart reused a worker or shared buffer');
    checkpoint('namespace-'+generation);
    round.namespaceCleared=session.evaluate("[is(ctm_restart_sentinel='ctm_restart_sentinel),not member('ctm_restart_private,map(lambda([f],op(f)),functions)),is(errcatch(fundef(ctm_restart_private))=[]),not featurep(ctm_restart_symbol,integer),is(facts(ctm_restart_symbol)=[])]");
    require(same(round.namespaceCleared,[true,true,true,true,true]),'Old namespace or assumptions survived restart');
    semantics(round,generation);
    checkpoint('gc-'+generation);
    session.write(':lisp (defun maxima::$ctm_force_gc () (si:gc t) (quote maxima::$done))\\n',60000);
    round.gc=session.evaluate('block([temporary:makelist(j^3,j,1,2000)],is(ctm_force_gc()=done) and is(temporary[2000]=8000000000))');
    require(round.gc===true,'Full collection verification failed');
    checkpoint('caught-error-'+generation);
    round.caught=session.evaluate('block([r:errcatch(error("CTM deliberate caught CAS error"))],if r=[] then errormsgtostring() else "unexpected")');
    require(typeof round.caught==='string'&&round.caught.includes('CTM deliberate caught CAS error'),'Caught-error verification failed');
    round.afterError=session.evaluate('6*7');require(round.afterError===42,'Post-error arithmetic failed');
    grade(round,generation);
  }
  checkpoint('complete');self.postMessage({ok:true,...progress,expectedVersion:data.expected.stackLibraryVersion});
}catch(error){self.postMessage({ok:false,...progress,error:String(error),stack:error.stack});}finally{session?.terminate();}};`;
await writeFile(join(site,'precompiled-measure.html'),'<!doctype html><title>Precompiled STACK timing</title>');
await writeFile(join(site,'precompiled-measure-worker.js'),worker);
const app=await serveDemo({root:site,compression:'gzip'});
try{
  for(let repetition=1;repetition<=repetitions;repetition++){
    for(const candidate of repetition===1?['source','precompiled']:['precompiled','source']){
      const browser=await chromium.launch({headless:true});
      try{
        report.browser=browser.version();
        const page=await browser.newPage();
        for(const mode of modes){
          const start=app.requests.length;
          if(mode==='cold')await page.goto(app.baseURL+'precompiled-measure.html');else await page.reload();
          const manifest=candidate==='source'?'stack-sources-timed-source.json':'stack-sources-precompiled.json';
          const expectedManifest=JSON.parse(await readFile(join(site,manifest),'utf8'));
          const expected={manifestSha256:digest(JSON.stringify(expectedManifest)),stackRevision:expectedManifest.stackRevision,stackLibraryVersion:expectedManifest.stackLibraryVersion,
            maximaVersion:expectedManifest.runtimeBuild.sourcePins.sources.find(row=>row.name==='maxima').version,compiledStack:expectedManifest.compiledStack||null,
            bundleSha256:report.files.find(row=>row.path==='maxima-runtime/stackmaxima.fas').sha256};
          const result=await page.evaluate(input=>new Promise(resolveResult=>{
            let latest={phase:'worker-start'};
            const instance=new Worker('precompiled-measure-worker.js');
            const timer=setTimeout(()=>{instance.terminate();resolveResult({ok:false,...latest,error:'Full-session lifecycle watchdog expired'});},1200000);
            instance.onmessage=({data})=>{if(data.type==='progress'){latest=data.progress;return;}clearTimeout(timer);instance.terminate();resolveResult(data);};
            instance.onerror=error=>{clearTimeout(timer);instance.terminate();resolveResult({ok:false,...latest,error:error.message});};
            instance.postMessage(input);
          }),{manifest,expected});
          const requests=app.requests.slice(start);
          const row={repetition,candidate,mode,...result,requests,
            lifecycleEncodedBodyBytes:requests.reduce((sum,record)=>sum+(record.encodedBodyBytes||0),0)};
          report.samples.push(row);
          await writeFile(output,JSON.stringify(report,null,2)+'\n');
          // A diagnostic retains every attempted sample, including failures, so
          // a source-control reset error cannot hide compiled initialization.
          // The fresh parity workflow still stops at the first failed sample.
          if(report.diagnosticOnly&&result.ok!==true)continue;
          assert.equal(result.ok,true,result.error);
          assert.ok(Number.isFinite(result.readyMs)&&result.readyMs>0);
          assert.ok(Number.isFinite(result.initialization.stages.stackLoadMs)&&result.initialization.stages.stackLoadMs>0);
          assert.equal(result.warmCalls.length,10);
          assert.ok(result.warmCalls.every(call=>call.value===42&&Number.isFinite(call.elapsedMs)));
          assert.equal(result.grade.cas_valid,true);
          assert.equal(result.grade.correct,true);
          assert.ok(result.version);
          assert.equal(String(result.version),String(result.expectedVersion));
          assert.equal(result.restartKind,'full-session-restart');
          assert.equal(result.restarts.length,3);
          for(const restart of result.restarts){
            assert.equal(restart.kind,'full-session-restart');
            assert.ok(Number.isFinite(restart.readyMs)&&restart.readyMs>0);
            assert.equal(restart.childReplaced,true);
            assert.deepEqual(restart.buffersReplaced,[true,true,true]);
            assert.deepEqual(restart.namespaceCleared,[true,true,true,true,true]);
            assert.equal(restart.gc,true);assert.match(restart.caught,/CTM deliberate caught CAS error/);
            assert.equal(restart.afterError,42);assert.equal(restart.grade.correct,true);assert.equal(restart.negativeGrade.correct,false);
          }
          assert.equal(requests.some(record=>record.status>=400||record.error),false);
          if(candidate==='precompiled'){
            assert.ok(result.initialization.stages.compiledStackBytes>0,'Compiled asset must reach the Wasm filesystem');
            assert.equal(result.initialization.stages.compiledStackMounted,true);
            assert.ok(result.initialization.stages.compiledStackOpens>0,'STACK must open the compiled entry');
            assert.equal(result.initialization.stages.compiledSourceEntryOpens,0,'Compiled startup must not open the source entry');
            assert.equal(result.initialization.stages.compiledStackSha256,
              report.files.find(row=>row.path==='maxima-runtime/stackmaxima.fas').sha256);
            if(mode==='cold')assert.ok(requests.some(record=>record.pathname?.endsWith('/stackmaxima.fas')),'Compiled asset must transfer from origin');
          }else assert.equal(result.initialization.stages.compiledStackBytes,undefined);
        }
      }finally{await browser.close();}
    }
  }
  assert.ok(report.samples.every(row=>row.ok===true),'Every sample must pass before paired observations can clear');
  for(let repetition=1;repetition<=repetitions;repetition++)for(const mode of modes) {
    const source=report.samples.find(row=>row.repetition===repetition&&row.mode===mode&&row.candidate==='source');
    const compiled=report.samples.find(row=>row.repetition===repetition&&row.mode===mode&&row.candidate==='precompiled');
    assert.ok(source&&compiled);
    for(let generation=0;generation<=3;generation++){
      const left=generation===0?source:source.restarts[generation-1],right=generation===0?compiled:compiled.restarts[generation-1];
      assert.deepEqual(right.policy,left.policy);
      assert.deepEqual(right.checks.map(row=>row.result),left.checks.map(row=>row.result));
      assert.equal(String(right.version),String(left.version));
    }
  }
  assert.equal(report.samples.length,report.planned.trials);
  report.completed={trials:report.samples.length,initializations:report.samples.reduce((sum,row)=>sum+1+row.restarts.length,0),restarts:report.samples.reduce((sum,row)=>sum+row.restarts.length,0)};
  assert.deepEqual(report.completed,report.planned);
  report.passed=true;
}catch(error){report.failure=String(error.stack||error);console.error(report.failure);}
finally{await app.close();await writeFile(output,JSON.stringify(report,null,2)+'\n');}
if(!report.passed)process.exitCode=1;
