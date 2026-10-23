// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {serveDemo} from '../../scripts/milestone-two/serve.mjs';

const output=resolve('.cache/runtime-build/validation');
await mkdir(output,{recursive:true});
const report={schema:1,sourceRevision:process.env.GITHUB_SHA||null,passed:false,samples:[],
 scope:'Two alternating-order trials per candidate on one CI runner. Fresh Chromium process/profile and worker per trial; uncompressed local HTTP, no simulated latency. Readiness includes runtime and STACK initialization; warm calls reuse that worker. OS/filesystem/process warming is uncontrolled. These are observations, not an internet benchmark or a statistical speed claim.'};
const roots={deployed:resolve('.cache/runtime-build/deployed-demo'),owned:resolve('site')};
const worker=`importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{let session;try {
 session=new MaximaSession({baseURL:'./maxima-runtime/',stackSourceURL:'./stack-sources.json'});
 const started=performance.now(),initialization=await session.init();
 const readyMs=performance.now()-started,calls=[];
 for(let i=0;i<10;i++){const t=performance.now();const value=session.evaluate('6*7');calls.push({expression:'6*7',value,elapsedMs:performance.now()-t});}
 const nativeCalls=[];
 for(const program of data.programs){const t=performance.now();const result=session.evaluate(program.expression);nativeCalls.push({...program,result,elapsedMs:performance.now()-t});}
 self.postMessage({ok:true,readyMs,initialization,calls,nativeCalls});
}catch(error){self.postMessage({ok:false,error:String(error),stack:error.stack});}finally{if(session)session.terminate();}};`;
try {
 const questions=JSON.parse(await readFile('site/native/questions.json','utf8')).questions;
 const question=questions.find(q=>q.id==='native-rational').question;
 const captured=JSON.parse(await readFile('test-results/milestone-three/browser.json','utf8'));
 const programs=['prepare','validate','prt'].map(operation=>{const row=captured.programs.find(p=>p.question===question.name&&p.operation===operation);assert.ok(row,'Missing native-rational '+operation);return {operation,question:row.question,expression:row.expression,expected:row.result};});
 report.nativePrograms=programs;
 report.controlWorkload='Ten 6*7 calls measure simple call overhead; separate native-rational calls measure actual captured prepare/validate/PRT programs.';
 for(const [candidate,root] of Object.entries(roots)){
  const manifest=JSON.parse(await readFile(join(root,'stack-sources.json'),'utf8'));
  report[candidate]={stackRevision:manifest.stackRevision,runtimeBuild:manifest.runtimeBuild||null,runtimeAssets:manifest.runtimeAssets};
  await writeFile(join(root,'owned-build-timing.html'),'<!doctype html><title>Runtime source timing</title>');
  await writeFile(join(root,'owned-build-timing.js'),worker);
 }
 for(let repetition=1;repetition<=2;repetition++)for(const candidate of repetition===1?['deployed','owned']:['owned','deployed']){
  const app=await serveDemo({root:roots[candidate],compression:'none'});
  let browser;
  try {
   browser=await chromium.launch({headless:true});report.browser=browser.version();
   const page=await browser.newPage();await page.goto(app.baseURL+'owned-build-timing.html');
   const result=await page.evaluate(programs=>new Promise(resolveResult=>{
    const worker=new Worker('owned-build-timing.js');
    const timer=setTimeout(()=>{worker.terminate();resolveResult({ok:false,error:'Timing watchdog expired'});},300000);
    const finish=data=>{clearTimeout(timer);worker.terminate();resolveResult(data);};
    worker.onmessage=({data})=>finish(data);worker.onerror=e=>finish({ok:false,error:e.message});worker.postMessage({programs});
   }),programs);
   report.samples.push({candidate,repetition,...result,requests:app.requests});
   await writeFile(join(output,'timings.json'),JSON.stringify(report,null,2)+'\n');
   assert.equal(result.ok,true,result.error);assert.equal(result.calls.length,10);
   assert.ok(result.calls.every(row=>row.value===42&&Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0));
   assert.equal(result.nativeCalls.length,3);
   for(const row of result.nativeCalls){assert.deepEqual(row.result,row.expected);assert.ok(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0);}
   assert.ok(Number.isFinite(result.readyMs)&&result.readyMs>0);
   assert.equal(app.requests.some(row=>row.status>=400),false);
  }finally{if(browser)await browser.close();await app.close();}
 }
 report.passed=true;
}catch(error){report.failure=String(error);console.error(error);}
finally{await writeFile(join(output,'timings.json'),JSON.stringify(report,null,2)+'\n');}
if(!report.passed)process.exitCode=1;
