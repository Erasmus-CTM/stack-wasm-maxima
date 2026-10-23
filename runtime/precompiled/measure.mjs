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
const report={schema:1,createdAt:new Date().toISOString(),sourceRevision:process.env.GITHUB_SHA||null,
  scope:'Opt-in local HTTP measurement with fresh Chromium process/profile per trial and one same-profile reload. Alternating order limits runner warming bias but does not remove it. Readiness includes Maxima and STACK; calls reuse the worker. Encoded bytes count only completed origin responses at this host, not internet traffic.',
  files:[],samples:[],passed:false};
if(process.env.PRECOMPILED_DIAGNOSTIC_PROVENANCE){
  report.diagnosticInputs=JSON.parse(await readFile(process.env.PRECOMPILED_DIAGNOSTIC_PROVENANCE,'utf8'));
  assert.equal(report.diagnosticInputs.diagnosticOnly,true);
  report.diagnosticOnly=true;
  report.scope+=' Frozen separately built runtime and older entry bundle; no fresh-build/current-head parity clearance.';
}
let resetCompatibility=null;
if(process.env.PRECOMPILED_RESET_COMPATIBILITY){
  assert.equal(report.diagnosticOnly,true,'Unvalidated reset adapter is diagnostic-only');
  const text=await readFile(process.env.PRECOMPILED_RESET_COMPATIBILITY,'utf8');
  // This trusted adapter has whole-line comments only. Preserve the exact
  // source separately; parse its flattened program explicitly in MAXIMA.
  const program='(progn '+text.split('\n').filter(line=>!line.trim().startsWith(';')).join(' ')+')';
  const quoted='"'+program.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
  resetCompatibility='(let ((*package* (find-package :maxima))) (eval (read-from-string '+quoted+')))';
  report.resetCompatibility={text,sha256:digest(text),command:resetCompatibility,commandSha256:digest(resetCompatibility)};
}
for(const path of files){const body=await readFile(join(site,path));report.files.push({path,bytes:body.length,sha256:digest(body)});}
const worker=`importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{let session;const progress={phase:'initializing',resets:[]};try{
  session=new MaximaSession({baseURL:'./maxima-runtime/',stackSourceURL:'./'+data.manifest});
  const started=performance.now(),initialization=await session.init();
  const readyMs=performance.now()-started;
  Object.assign(progress,{readyMs,initialization,phase:'warm-calls'});
  if(data.resetCompatibility){
    session.write(':lisp '+data.resetCompatibility.replaceAll('\\n',' ')+'\\n',60000);
    progress.reservedAllBefore=session.evaluate('ctm_reserved_all_state()');
  }
  const warmCalls=[];for(let i=0;i<10;i++){const t=performance.now();warmCalls.push({value:session.evaluate('6*7'),elapsedMs:performance.now()-t});}
  const grade=session.assess({test:'AlgEquiv',student:'(x+1)^2',teacher:'x^2+2*x+1'});
  const version=session.evaluate('stackmaximaversion');
  Object.assign(progress,{warmCalls,grade,version});
  const resets=progress.resets;
  for(let i=0;i<3;i++){
    progress.phase='reset-'+(i+1);
    const sentinel=session.evaluate('ctm_reset_sentinel:123456');
    if(sentinel!==123456)throw new Error('Reset sentinel assignment failed');
    const round={before:session.evaluate('string([STACKpmOPT,algebraic_equivalence_factorp,algebraic_equivalence_trigexpandp,algebraic_equivalence_nounsp])')};
    resets.push(round);
    // STACK resets the complete variable environment. Run that trusted command
    // outside evaluate()'s dynamically bound question/error result wrapper.
    // A fresh wrapped call verifies the actual return and cleared sentinel.
    session.write('ctm_reset_result:false$\\nctm_reset_result:errcatch(stack_reset(true))$\\n',60000);
    const acknowledgment=session.evaluate("[ctm_reset_result,is(ctm_reset_sentinel='ctm_reset_sentinel),if ctm_reset_result=[] then errormsgtostring() else false]");
    round.returned=acknowledgment[0];round.sentinelCleared=acknowledgment[1];round.error=acknowledgment[2];
    round.after=session.evaluate('string([STACKpmOPT,algebraic_equivalence_factorp,algebraic_equivalence_trigexpandp,algebraic_equivalence_nounsp])');
    round.reset=Array.isArray(round.returned)&&round.returned.length===1&&round.returned[0]===true&&round.sentinelCleared===true;
    if(!round.reset)throw new Error('Reset completion/sentinel verification failed: '+JSON.stringify(acknowledgment));
    progress.phase='gc-'+(i+1);
    session.write(':lisp (defun maxima::$ctm_force_gc () (si:gc t) (quote maxima::$done))\\n',60000);
    round.gc=session.evaluate('block([temporary:makelist(j^3,j,1,2000)],is(ctm_force_gc()=done) and is(temporary[2000]=8000000000))');
    if(round.gc!==true)throw new Error('Full collection verification failed');
    progress.phase='caught-error-'+(i+1);
    round.caught=session.evaluate('block([r:errcatch(error("CTM deliberate caught CAS error"))],if r=[] then errormsgtostring() else "unexpected")');
    if(typeof round.caught!=='string'||!round.caught.includes('CTM deliberate caught CAS error'))throw new Error('Caught error verification failed');
    progress.phase='arithmetic-'+(i+1);
    round.afterError=session.evaluate('6*7');
    if(round.afterError!==42)throw new Error('Error recovery arithmetic failed');
    progress.phase='regrade-'+(i+1);
    round.grade=session.assess({test:'AlgEquiv',student:'(x+1)^2',teacher:'x^2+2*x+1'});
    progress.phase='metadata-'+(i+1);
    round.version=session.evaluate('stackmaximaversion');
  }
  progress.phase='complete';
  self.postMessage({ok:true,...progress,
    expectedVersion:session.manifest.stackLibraryVersion});
}catch(error){self.postMessage({ok:false,...progress,error:String(error),stack:error.stack});}finally{session?.terminate();}};`;
await writeFile(join(site,'precompiled-measure.html'),'<!doctype html><title>Precompiled STACK timing</title>');
await writeFile(join(site,'precompiled-measure-worker.js'),worker);
const app=await serveDemo({root:site,compression:'gzip'});
try{
  for(let repetition=1;repetition<=2;repetition++){
    for(const candidate of repetition===1?['source','precompiled']:['precompiled','source']){
      const browser=await chromium.launch({headless:true});
      try{
        report.browser=browser.version();
        const page=await browser.newPage();
        for(const mode of ['cold','warm-profile-reload']){
          const start=app.requests.length;
          if(mode==='cold')await page.goto(app.baseURL+'precompiled-measure.html');else await page.reload();
          const manifest=candidate==='source'?'stack-sources-timed-source.json':'stack-sources-precompiled.json';
          const result=await page.evaluate(manifest=>new Promise(resolveResult=>{
            const instance=new Worker('precompiled-measure-worker.js');
            const timer=setTimeout(()=>{instance.terminate();resolveResult({ok:false,error:'Startup watchdog expired'});},300000);
            instance.onmessage=({data})=>{clearTimeout(timer);instance.terminate();resolveResult(data);};
            instance.onerror=error=>{clearTimeout(timer);instance.terminate();resolveResult({ok:false,error:error.message});};
            instance.postMessage({manifest:manifest.manifest,resetCompatibility:manifest.resetCompatibility});
          }),{manifest,resetCompatibility});
          const requests=app.requests.slice(start);
          const row={repetition,candidate,mode,...result,requests,
            encodedBodyBytes:requests.reduce((sum,record)=>sum+(record.encodedBodyBytes||0),0)};
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
          assert.equal(result.resets.length,3);
          for(const row of result.resets){
            assert.equal(row.reset,true);
            assert.equal(row.gc,true);
            assert.match(row.caught,/CTM deliberate caught CAS error/);
            assert.equal(row.afterError,42);
            assert.equal(row.grade.cas_valid,true);
            assert.equal(row.grade.correct,true);
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
  // STACK's reset can clear metadata variables. Require the compiled path to
  // match the source control's observed reset state, rather than inventing a
  // metadata-preservation contract that the source loader does not promise.
  for(const repetition of [1,2])for(const mode of ['cold','warm-profile-reload']) {
    const source=report.samples.find(row=>row.repetition===repetition&&row.mode===mode&&row.candidate==='source');
    const compiled=report.samples.find(row=>row.repetition===repetition&&row.mode===mode&&row.candidate==='precompiled');
    assert.ok(source&&compiled);
    assert.deepEqual(compiled.resets.map(row=>row.version),source.resets.map(row=>row.version),
      'Post-reset metadata must match the source control');
  }
  report.passed=true;
}catch(error){report.failure=String(error.stack||error);console.error(report.failure);}
finally{await app.close();await writeFile(output,JSON.stringify(report,null,2)+'\n');}
if(!report.passed)process.exitCode=1;
