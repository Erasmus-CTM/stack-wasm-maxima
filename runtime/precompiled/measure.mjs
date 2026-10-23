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
for(const path of files){const body=await readFile(join(site,path));report.files.push({path,bytes:body.length,sha256:digest(body)});}
const worker=`importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{let session;try{
  session=new MaximaSession({baseURL:'./maxima-runtime/',stackSourceURL:'./'+data.manifest});
  const started=performance.now(),initialization=await session.init();
  const readyMs=performance.now()-started;
  const warmCalls=[];for(let i=0;i<10;i++){const t=performance.now();warmCalls.push({value:session.evaluate('6*7'),elapsedMs:performance.now()-t});}
  const grade=session.assess({test:'AlgEquiv',student:'(x+1)^2',teacher:'x^2+2*x+1'});
  const version=session.evaluate('stackmaximaversion');
  const resets=[];
  for(let i=0;i<3;i++){
    const reset=session.evaluate('stack_reset(true)');
    session.write(':lisp (defun maxima::$ctm_force_gc () (si:gc t) (quote maxima::$done))\\n',60000);
    const gc=session.evaluate('block([temporary:makelist(j^3,j,1,2000)],is(ctm_force_gc()=done) and is(temporary[2000]=8000000000))');
    const caught=session.evaluate('block([r:errcatch(error("CTM deliberate caught CAS error"))],if r=[] then errormsgtostring() else "unexpected")');
    const afterError=session.evaluate('6*7');
    const afterGrade=session.assess({test:'AlgEquiv',student:'(x+1)^2',teacher:'x^2+2*x+1'});
    resets.push({reset,gc,caught,afterError,grade:afterGrade,version:session.evaluate('stackmaximaversion')});
  }
  self.postMessage({ok:true,readyMs,initialization,warmCalls,grade,version,resets,
    expectedVersion:session.manifest.stackLibraryVersion});
}catch(error){self.postMessage({ok:false,error:String(error),stack:error.stack});}finally{session?.terminate();}};`;
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
            instance.postMessage({manifest});
          }),manifest);
          const requests=app.requests.slice(start);
          const row={repetition,candidate,mode,...result,requests,
            encodedBodyBytes:requests.reduce((sum,record)=>sum+(record.encodedBodyBytes||0),0)};
          report.samples.push(row);
          await writeFile(output,JSON.stringify(report,null,2)+'\n');
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
            if(mode==='cold')assert.ok(requests.some(record=>record.pathname?.endsWith('/stackmaxima.fas')),'Compiled asset must transfer from origin');
          }else assert.equal(result.initialization.stages.compiledStackBytes,undefined);
        }
      }finally{await browser.close();}
    }
  }
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
