// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {serveDemo} from '../../scripts/milestone-two/serve.mjs';

const output=resolve('.cache/runtime-build/validation');
await mkdir(output,{recursive:true});
const report={schema:1,sourceRevision:process.env.GITHUB_SHA||null,passed:false,samples:[],
 toolchain:{node:process.version,zlib:process.versions.zlib,platform:process.platform,arch:process.arch},
 scope:'Two alternating-order trials per candidate on one CI runner, including the frozen validated owned baseline. Each trial records a fresh profile, then a page reload in that same profile/context and same live origin with a new worker/session; request deltas are separate. Warm calls reuse each worker. Served with gzip-6 local HTTP, no simulated latency. Readiness includes runtime and STACK initialization; warm calls reuse that worker. OS/filesystem/process warming is uncontrolled. These are observations, not an internet benchmark or a statistical speed claim.'};
const roots={deployed:resolve('.cache/runtime-build/deployed-demo'),baseline:resolve('.cache/runtime-build/owned-baseline-demo'),owned:resolve('site')};
const worker=`importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{let session;try {
 session=new MaximaSession({baseURL:'./maxima-runtime/',stackSourceURL:'./stack-sources.json'});
 const started=performance.now(),initialization=await session.init();
 const readyMs=performance.now()-started,calls=[];
 for(let i=0;i<10;i++){const t=performance.now();const value=session.evaluate('6*7');calls.push({expression:'6*7',value,elapsedMs:performance.now()-t});}
 const nativeCalls=[];
 for(const program of data.programs){const t=performance.now();const result=session.evaluate(program.expression);nativeCalls.push({...program,result,elapsedMs:performance.now()-t});}
 session.write(':lisp (defun maxima::$ctm_force_gc () (si:gc t) (quote maxima::$done))\\n',60000);
 const gcCalls=[];
 const retained=session.evaluate('block([],ctm_retained:makelist([i,i^2],i,1,1000),length(ctm_retained))');
 for(let i=0;i<100;i++)gcCalls.push(session.evaluate('block([temporary:makelist(j^3,j,1,2000)],ctm_force_gc(),is(temporary[2000]=8000000000) and is(ctm_retained[1000]=[1000,1000000]) and is(length(ctm_retained)=1000))'));
 const caughtError=session.evaluate('block([r:errcatch(error("CTM deliberate caught CAS error"))],if r=[] then errormsgtostring() else "unexpected")');
 const afterError=session.evaluate('6*7');
 const plotting=[];
 if(data.trimPlot)for(const expression of ['plot2d(x,[x,0,1])','plot(x,[x,0,1])','get_plot_option(plot_format)','gnuplot_close()']){
  const diagnostic=session.evaluate('block([r:errcatch('+expression+')],if r=[] then errormsgtostring() else "unexpected plotting success")');
  plotting.push({expression,diagnostic,afterError:session.evaluate('6*7')});
 }
 self.postMessage({ok:true,readyMs,initialization,calls,nativeCalls,smoke:{retained,gcCalls,caughtError,afterError,plotting,
  scope:'100 separately acknowledged allocations/forced full ECL collections with a retained 1000-element symbolic object; caught CAS error then success in the same worker. This does not change the existing transport fatal-error policy. Linear-memory capacity is not live Lisp heap; no live-heap measurement claimed.'}});
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
 for(let repetition=1;repetition<=2;repetition++)for(const candidate of repetition===1?['deployed','baseline','owned']:['owned','baseline','deployed']){
  const app=await serveDemo({root:roots[candidate],compression:'gzip'});
  let browser;
  try {
   browser=await chromium.launch({headless:true});report.browser=browser.version();
   const page=await browser.newPage();
   for(const mode of ['cold','warm-profile-reload']){
   const requestStart=app.requests.length;
   if(mode==='cold')await page.goto(app.baseURL+'owned-build-timing.html');else await page.reload();
   const result=await page.evaluate(({programs,trimPlot})=>new Promise(resolveResult=>{
    const worker=new Worker('owned-build-timing.js');
    const timer=setTimeout(()=>{worker.terminate();resolveResult({ok:false,error:'Timing watchdog expired'});},300000);
    const finish=data=>{clearTimeout(timer);worker.terminate();resolveResult(data);};
    worker.onmessage=({data})=>finish(data);worker.onerror=e=>finish({ok:false,error:e.message});worker.postMessage({programs,trimPlot});
   }),{programs,trimPlot:candidate==='owned'});
   report.samples.push({candidate,repetition,mode,...result,requests:app.requests.slice(requestStart),encodedBodyBytes:app.requests.slice(requestStart).reduce((n,r)=>n+r.encodedBodyBytes,0)});
   await writeFile(join(output,'timings.json'),JSON.stringify(report,null,2)+'\n');
   assert.equal(result.ok,true,result.error);assert.equal(result.calls.length,10);
   assert.ok(result.calls.every(row=>row.value===42&&Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0));
   assert.equal(result.nativeCalls.length,3);
   assert.equal(result.smoke.retained,1000);assert.equal(result.smoke.gcCalls.length,100);assert.ok(result.smoke.gcCalls.every(value=>value===true));
   assert.match(result.smoke.caughtError,/CTM deliberate caught CAS error/);assert.equal(result.smoke.afterError,42);
   for(const row of result.smoke.plotting){assert.match(row.diagnostic,/CTM plotting unavailable; use JSXGraph/);assert.equal(row.afterError,42);}
   for(const row of result.nativeCalls){assert.deepEqual(row.result,row.expected);assert.ok(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0);}
   assert.ok(Number.isFinite(result.readyMs)&&result.readyMs>0);
   assert.equal(app.requests.some(row=>row.status>=400),false);
   if(candidate==='owned')assert.ok(!app.requests.some(row=>/maxima-plot\.fas|libgnuplot\.so/.test(row.pathname)));
   }
  }finally{if(browser)await browser.close();await app.close();}
 }
 report.passed=true;
}catch(error){report.failure=String(error);console.error(error);}
finally{await writeFile(join(output,'timings.json'),JSON.stringify(report,null,2)+'\n');}
if(!report.passed)process.exitCode=1;
