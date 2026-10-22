// SPDX-License-Identifier: AGPL-3.0-or-later
// Exact-build public UI timings; no assessment request or result is fabricated.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {chromium} from 'playwright';
import {observeWorkers} from './milestone-two/browser.mjs';

const pageURL=new URL(process.env.TIMING_PAGE_URL || 'https://erasmus-ctm.github.io/stack-wasm-maxima/previews/research/2026-10-native-stack/maxima/native.html');
assert.equal(pageURL.origin,'https://erasmus-ctm.github.io');
assert.ok(pageURL.pathname.startsWith('/stack-wasm-maxima/') && pageURL.pathname.endsWith('/maxima/native.html'));
assert.equal(pageURL.username+pageURL.password+pageURL.hash,'');
const expectedHTML=process.env.EXPECTED_HTML_SHA256;
assert.match(expectedHTML || '',/^[a-f0-9]{64}$/,'EXPECTED_HTML_SHA256 must identify the exact published native HTML');
const baseURL=new URL('../',pageURL);
const output=resolve(process.env.TIMING_OUTPUT || 'test-results/native-page-timings');
const starts=3,repeats=5;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const interrupted=error=>/Execution context was destroyed|Cannot find context|interrupted by another navigation|ERR_ABORTED/.test(String(error));
const safeConsole=text=>/^warning: unsupported syscall: __syscall_(?:prlimit64|getrusage)\s*$/.test(text);
const pythonAsset=value=>{
  const path=new URL(value).pathname;
  // pyodide-runtime.js is shared configuration, not the interpreter.
  return /\/(?:pyodide(?:\/|$)|pyodide(?:\.asm)?\.(?:js|wasm)|pyodide-lock\.json|python_stdlib\.zip)(?:\/|$)/i.test(path) || /\.whl$/i.test(path);
};
const report={schema:1,createdAt:new Date().toISOString(),pageURL:pageURL.href,expectedHTML,
  benchmarkSource:process.env.GITHUB_SHA || null,
  runURL:process.env.GITHUB_RUN_ID ? 'https://github.com/'+process.env.GITHUB_REPOSITORY+'/actions/runs/'+process.env.GITHUB_RUN_ID : null,
  method:{freshStarts:starts,warmCallsPerStart:repeats,
    nativeWorkload:'native-rational, variant 1, actual native-prepared model answer',
    optionalWorkload:'native-python-board, variant 1, accepted coordinate list [2,2]',
    order:'First native Validate; 5 warm Validate; first native grade and 5 warm grades; graphical PythonChecker native Validate; first Python grade and 5 warm grades',
    uiClock:'Browser performance.now: original click at window capture to verdict DOM mutation, including graphical collection/replay; excludes later MathJax paint',
    workerClock:'Browser performance.now: real postMessage to response. Initialization is recorded separately and is included in first native Validate UI time.',
    cache:'Fresh Chromium process, context/profile and worker per sample; OS and CDN caches are not cleared. Provenance fetches outside timed intervals can warm CDN caches.',
    scope:'One public build, two accepted-answer workloads and one runner; descriptive samples, not a general device/network benchmark or confidence interval.'},
  limitations:['First Python grade reuses an initialized native worker and measures incremental Python startup, not a second cold page.',
    'Diagnostic stage clocks have different origins from the page clock.',
    'UI completion is verdict DOM update, not final mathematics rendering.',
    'Only these accepted answers and this exact deployment are measured; no previous-build speedup is inferred.'],
  runner:{platform:os.platform(),architecture:os.arch(),cpus:os.cpus().length,cpu:os.cpus()[0]?.model},
  fingerprints:{before:[],after:[]},samples:[],passed:false};
await mkdir(output,{recursive:true});
const save=()=>writeFile(resolve(output,'timings.json'),JSON.stringify(report,null,2)+'\n');
function assetURL(path) {
  const url=new URL(path,baseURL);
  assert.equal(url.origin,baseURL.origin);
  assert.ok(url.pathname.startsWith(baseURL.pathname),'Asset outside measured deployment: '+url);
  return url;
}
async function fingerprint(url) {
  const response=await fetch(url,{redirect:'error',cache:'no-store'});
  assert.equal(response.status,200,String(url));
  const bytes=new Uint8Array(await response.arrayBuffer());
  return {record:{url:String(url),bytes:bytes.length,sha256:hash(bytes)},text:()=>new TextDecoder().decode(bytes)};
}
export function statistics(values) {
  assert.ok(values.length && values.every(value=>Number.isFinite(value) && value>=0));
  const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return {n:values.length,median:sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2,min:sorted[0],max:sorted.at(-1)};
}
async function action(page,card,type) {
  const button=card.locator(type==='validate'?'.stack-validate':'.stack-check');
  assert.equal(await button.isEnabled(),true);
  await card.evaluate((element,type)=>{
    const result=element.querySelector('.stack-result');
    const button=element.querySelector(type==='validate'?'.stack-validate':'.stack-check');
    const mark=window.__nativeTimingMark={type,before:window.__ctmHarness.calls.length,eventsBefore:window.__ctmHarness.events.length};
    const begin=event=>{
      if(!button.contains(event.target))return;
      mark.startedAt=performance.now();window.removeEventListener('click',begin,true);
    };
    window.addEventListener('click',begin,true);
    const observer=new MutationObserver(()=>{
      if(mark.startedAt==null)return;
      if(result.dataset.state==='loading'){mark.sawLoading=true;return;}
      if(!mark.sawLoading || (!result.querySelector('.stack-verdict') && result.dataset.state!=='error'))return;
      mark.completedAt=performance.now();mark.uiMs=mark.completedAt-mark.startedAt;
      mark.state=result.dataset.state;mark.verdict=result.textContent;observer.disconnect();
    });
    observer.observe(result,{attributes:true,attributeFilter:['data-state'],childList:true,subtree:true});
  },type);
  await button.click();
  await page.waitForFunction(()=>window.__nativeTimingMark.completedAt!=null,null,{timeout:330000});
  const data=await page.evaluate(()=>({mark:window.__nativeTimingMark,
    calls:window.__ctmHarness.calls.slice(window.__nativeTimingMark.before),
    events:window.__ctmHarness.events.slice(window.__nativeTimingMark.eventsBefore)}));
  const calls=data.calls.filter(call=>call.type===type);
  assert.equal(calls.length,1,'Each original button action must send exactly one assessment request');
  const call=calls[0];
  assert.ok(call.response);assert.equal(call.response.ok,true,call.response.error);
  assert.equal(call.response.backend?.id,'maxima-native');
  assert.equal(call.response.result.status,type==='validate'?'valid':'graded');
  assert.equal(data.mark.state,type==='validate'?'valid':'correct');
  if(type==='grade')assert.equal(call.response.result.score,1);
  assert.ok(Number.isFinite(call.elapsedMs) && call.elapsedMs>=0);
  assert.ok(Number.isFinite(data.mark.uiMs) && data.mark.uiMs>=call.elapsedMs);
  return {uiMs:data.mark.uiMs,workerMs:call.elapsedMs,...data};
}
async function sample(repetition,inventory) {
  const result={repetition,phase:'launch',phases:[],network:[],errors:[],consoleErrors:[],httpErrors:[],failedRequests:[],navigation:[],native:{},python:{}};
  report.samples.push(result);
  const began=performance.now(),tasks=[];
  let browser,page;
  const phase=value=>{result.phase=value;result.phases.push({phase:value,runnerMs:performance.now()-began,at:new Date().toISOString()});};
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || undefined});
    report.browserVersion=browser.version();
    const context=await browser.newContext();page=await context.newPage();
    // The native HTML embeds all prepared questions and boards (about 17 MB).
    // Chrome's default inspector resource buffer evicts that navigation body.
    // Retain the actual response bytes for the mandatory hash admission gate;
    // these protocol buffers neither fetch resources nor alter browser caches.
    result.navigationCapture={maxTotalBufferSize:256*1024*1024,maxResourceBufferSize:64*1024*1024,enableDurableMessages:true};
    const capture=await context.newCDPSession(page);
    const topFrame=(await capture.send('Page.getFrameTree')).frameTree.frame.id;
    result.documentResponses=[];
    const documents=new Map();
    capture.on('Network.responseReceived',event=>{
      if(event.type!=='Document' || event.frameId!==topFrame)return;
      const response=event.response,headers=Object.fromEntries(Object.entries(response.headers).map(([key,value])=>[key.toLowerCase(),value]));
      const row={requestId:event.requestId,url:response.url,status:response.status,fromServiceWorker:response.fromServiceWorker===true,
        coop:headers['cross-origin-opener-policy'],coep:headers['cross-origin-embedder-policy']};
      documents.set(event.requestId,row);result.documentResponses.push(row);
    });
    capture.on('Network.loadingFinished',event=>{
      const row=documents.get(event.requestId);if(!row)return;
      tasks.push((async()=>{
        try {
          const body=await capture.send('Network.getResponseBody',{requestId:event.requestId});
          const bytes=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');
          row.bytes=bytes.length;row.sha256=hash(bytes);
        }catch(error){row.bodyError=String(error);}
      })());
    });
    await capture.send('Network.enable',result.navigationCapture);
    page.on('pageerror',error=>result.errors.push(String(error)));
    page.on('console',message=>{if(message.type()==='error')result.consoleErrors.push(message.text());});
    context.on('request',request=>result.network.push({url:request.url(),method:request.method(),resourceType:request.resourceType(),
      phase:result.phase,runnerMs:performance.now()-began,pythonAsset:pythonAsset(request.url())}));
    context.on('requestfailed',request=>result.failedRequests.push({url:request.url(),phase:result.phase,error:request.failure()?.errorText}));
    context.on('response',response=>{
      if(response.status()>=400)result.httpErrors.push({url:response.url(),status:response.status(),phase:result.phase});
      if(response.request().isNavigationRequest() && response.request().frame()===page.mainFrame()) {
        const row={url:response.url(),status:response.status(),fromServiceWorker:response.fromServiceWorker()};
        result.navigation.push(row);
        tasks.push((async()=>{
          const headers=await response.allHeaders();row.coop=headers['cross-origin-opener-policy'];row.coep=headers['cross-origin-embedder-policy'];
          try {const body=await response.body();row.bytes=body.length;row.sha256=hash(body);}
          catch(error){row.bodyError=String(error);}
        })());
      }
    });
    await page.addInitScript(observeWorkers);
    phase('navigation-and-isolation-bootstrap');
    try {await page.goto(pageURL.href,{waitUntil:'load',timeout:90000});}catch(error){if(!interrupted(error))throw error;}
    const deadline=Date.now()+120000;
    for(;;)try {
      await page.waitForFunction(()=>self.crossOriginIsolated && window.__ctmHarness &&
        document.querySelector('section.stack-sympy[data-stack-id="native-rational"] .stack-reset') &&
        document.querySelector('section.stack-sympy[data-stack-id="native-python-board"] .stack-reset'),
      null,{timeout:Math.max(1,deadline-Date.now())});break;
    }catch(error){if(!interrupted(error) || Date.now()>=deadline)throw error;}
    await Promise.all(tasks);
    assert.equal(result.navigation.at(-1)?.coop,'same-origin');assert.equal(result.navigation.at(-1)?.coep,'require-corp');
    const finalDocument=result.documentResponses.at(-1);
    assert.equal(finalDocument?.url,pageURL.href);assert.equal(finalDocument?.status,200);
    assert.equal(finalDocument?.coop,'same-origin');assert.equal(finalDocument?.coep,'require-corp');
    assert.equal(finalDocument?.sha256,expectedHTML,'Actual final browser HTML must match the requested artifact');
    assert.equal(page.url(),pageURL.href);
    result.isolation=await page.evaluate(()=>({crossOriginIsolated:self.crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer}));
    const card=id=>page.locator('section.stack-sympy[data-stack-id='+JSON.stringify(id)+']');
    const rational=card('native-rational'),optional=card('native-python-board');
    result.workloads={};
    for(const [id,element] of [['native-rational',rational],['native-python-board',optional]]) {
      const text=await element.locator('script.stack-sympy-data').textContent(),payload=JSON.parse(text);
      const entry=inventory.questions.find(item=>item.id===id);assert.ok(entry);
      assert.equal(payload.id,id);assert.deepEqual(payload.question,entry.question);
      assert.deepEqual(payload.variants,entry.payload.variants,'All prepared variants must belong to the measured build');
      result.workloads[id]={payloadSha256:hash(text),seed:payload.variants[0].seed,questionSha256:hash(JSON.stringify(payload.question)),
        source:entry.source,answers:id==='native-rational'?{ans:payload.variants[0].teachers.ans.source}:{ans:'[2,2]'}};
    }
    await rational.locator('.stack-answer[data-name="ans"]').fill(result.workloads['native-rational'].answers.ans);
    assert.equal(await page.evaluate(()=>window.__ctmHarness.calls.length),0,'First Validate must start with zero RPCs');
    assert.equal(await page.evaluate(()=>window.__ctmHarness.workers.length),0,'First Validate must create the cold native worker');
    const noPython=async label=>{
      const calls=await page.evaluate(()=>window.__ctmHarness.calls);
      assert.deepEqual(result.network.filter(row=>row.pythonAsset),[],label+': no interpreter, stdlib or wheel');
      for(const call of calls){assert.ok(call.response);assert.equal(call.response.backend?.pythonLoaded,false,label);}
      result.nativeOnlyEvidence={through:label,requestCount:result.network.length,workerCalls:calls.length,pythonAssetCount:0,pythonLoaded:false};
    };
    phase('native-first-validation');result.native.firstValidation=await action(page,rational,'validate');
    const init=result.native.firstValidation.calls.find(call=>call.type==='init');assert.ok(init?.response?.ok);
    result.native.initializationMs=init.elapsedMs;result.native.initializationStages=init.response.backend.timings;
    await noPython(result.phase);result.native.warmValidation=[];
    for(let at=0;at<repeats;at++){phase('native-warm-validation-'+(at+1));result.native.warmValidation.push(await action(page,rational,'validate'));}
    phase('native-first-grade');result.native.firstGrade=await action(page,rational,'grade');result.native.warmGrade=[];
    for(let at=0;at<repeats;at++){phase('native-warm-grade-'+(at+1));result.native.warmGrade.push(await action(page,rational,'grade'));}
    await noPython(result.phase);
    phase('python-board-input-synchronization');
    const iframe=optional.locator('iframe[data-stack-jsxgraph]');assert.equal(await iframe.count(),1);
    const handle=await iframe.elementHandle();
    await page.waitForFunction(element=>element.getAttribute('data-stack-jsxgraph-ready')==='true',handle,{timeout:30000});
    const frame=await handle.contentFrame();assert.ok(frame);
    await optional.locator('.stack-answer[data-name="ans"]').fill('[2,2]');
    await frame.waitForFunction(()=>Object.values(window.JXG?.boards || {}).some(board=>board.objectsList?.some(point=>
      point.elType==='point' && point.name==='P' && Math.abs(point.X()-2)<1e-8 && Math.abs(point.Y()-2)<1e-8)),null,{timeout:30000});
    phase('python-board-native-validation');result.python.validation=await action(page,optional,'validate');await noPython(result.phase);
    result.python.beforeGrade={workerCalls:await page.evaluate(()=>window.__ctmHarness.calls.length),networkRequests:result.network.length};
    phase('python-first-grade');result.python.firstGrade=await action(page,optional,'grade');
    assert.equal(result.python.firstGrade.calls.at(-1).response.backend.pythonLoaded,true);
    const ready=result.python.firstGrade.events.find(row=>row.data?.event==='python-ready');
    assert.ok(ready,'Optional grade must actually initialize Python');
    assert.ok(result.network.slice(result.python.beforeGrade.networkRequests).some(row=>row.pythonAsset),'Optional grade must actually request Python assets');
    result.python.initializationStages=ready.data;result.python.warmGrade=[];
    for(let at=0;at<repeats;at++) {
      phase('python-warm-grade-'+(at+1));const grade=await action(page,optional,'grade');
      assert.equal(grade.calls.at(-1).response.backend.pythonLoaded,true);
      assert.equal(grade.events.some(row=>row.data?.event==='python-ready'),false);result.python.warmGrade.push(grade);
    }
    result.observation=await page.evaluate(()=>window.__ctmHarness);
    assert.equal(result.observation.workers.length,1);
    assert.equal(result.observation.calls.filter(call=>call.type==='init').length,1);
    assert.equal(result.observation.calls.length,20);
    assert.ok(result.observation.calls.every(call=>['init','validate','grade'].includes(call.type)));
    for(const call of result.observation.calls) {
      assert.equal(call.response?.ok,true);assert.equal(call.response.backend?.id,'maxima-native');
      if(call.type!=='init') {
        const id=['native-rational','native-python-board'].find(id=>inventory.questions.find(item=>item.id===id).question.name===call.question);
        assert.ok(id);assert.deepEqual(call.answers,result.workloads[id].answers);
      }
    }
    assert.equal(result.observation.calls.at(-1).response.backend.pythonCheckerCount,repeats+1);
    assert.deepEqual(result.errors,[]);assert.deepEqual(result.httpErrors,[]);
    assert.deepEqual(result.consoleErrors.filter(text=>!safeConsole(text)),[]);
    assert.deepEqual(result.failedRequests.filter(row=>!/ERR_ABORTED/.test(row.error || '')),[]);
    phase('complete');result.passed=true;
  }catch(error) {
    result.failure={message:String(error),stack:error.stack};
    if(page)try{result.observation=await page.evaluate(()=>window.__ctmHarness);}catch{}
    throw error;
  }finally {await Promise.allSettled(tasks);if(browser)await browser.close();await save();}
}

try {
  const html=await fingerprint(pageURL);report.htmlBefore=html.record;
  assert.equal(html.record.sha256,expectedHTML,'Measure the exact requested public build');
  const paths=['MATERIALIZATION.json','stack-sources.json','runtime-assets.json','native/build-manifest.json',
    'runtime/maxima-session.js','runtime/maxima-child.js','native/backend-worker.js','native/engine.js',
    'native/input.js','native/input-rules.json','native/stack-parser.js','native/input-provenance.json',
    'native/feedback.js','native/feedback-messages.json','native/feedback-provenance.json',
    'native/python-bridge.js','native/python_bridge.py','jsxgraph/host.js','jsxgraph/frame.js'];
  const fetched=new Map();
  const add=async url=>{
    if(!fetched.has(String(url))){const value=await fingerprint(url);fetched.set(String(url),value);report.fingerprints.before.push(value.record);}
    return fetched.get(String(url));
  };
  for(const path of paths)await add(assetURL(path));
  const dependencyURLs=[];
  for(const match of html.text().matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const url=new URL(match[1].replace(/&amp;/g,'&'),pageURL);
    if(url.origin===baseURL.origin && url.pathname.startsWith(baseURL.pathname)){await add(url);dependencyURLs.push(url);}
  }
  const json=path=>JSON.parse(fetched.get(assetURL(path).href).text());
  const inventory=json('native/build-manifest.json'),stack=json('stack-sources.json'),runtime=json('runtime-assets.json'),materialization=json('MATERIALIZATION.json');
  assert.equal(inventory.preparation?.actualWasm,true);assert.equal(inventory.preparation.final.pythonLoaded,false);
  report.provenance={sourceRevision:inventory.sourceRevision,stackRevision:inventory.stackRevision,
    ctmCheckersRevision:inventory.ctmCheckersRevision,jsxgraphQuartoRevision:inventory.jsxgraphQuartoRevision,
    preparation:inventory.preparation,buildSourceFiles:inventory.buildSourceFiles,nativeAssets:inventory.nativeAssets,
    sourcePins:materialization.sourcePins,frontendPatches:materialization.frontendPatches,trackedPageSha256:materialization.trackedPageSha256};
  for(const source of inventory.buildSourceFiles || [])if(source.path.startsWith('prototype/')) {
    const url=assetURL(source.path.slice('prototype/'.length));
    const value=await add(url);assert.equal(value.record.sha256,source.sha256,'Served prototype differs from its build source: '+source.path);
  }
  const frontend=dependencyURLs.filter(url=>/\/stack-sympy\.js$/.test(url.pathname));assert.equal(frontend.length,1);
  const patch=materialization.frontendPatches.find(row=>String(row.path || row.file || '').endsWith('stack-sympy.js')) || materialization.frontendPatches[0];
  assert.equal(fetched.get(frontend[0].href).record.sha256,patch.materializedSha256,'Actual emitted frontend must match staged patch');
  const hostSource=inventory.buildSourceFiles.find(row=>row.path==='prototype/jsxgraph/host.js');assert.ok(hostSource);
  const hosts=dependencyURLs.filter(url=>/\/host\.js$/.test(url.pathname));assert.equal(hosts.length,1);
  assert.equal(fetched.get(hosts[0].href).record.sha256,hostSource.sha256,'Actual emitted graphical host must match its source');
  for(const item of inventory.nativeAssets || [])assert.equal((await add(assetURL(item.path))).record.sha256,item.sha256);
  for(const asset of runtime.assets)assert.equal((await add(assetURL('maxima-runtime/'+asset.path))).record.sha256,asset.sha256,'Pinned runtime asset: '+asset.path);
  if(stack.preload)assert.equal((await add(assetURL('maxima-runtime/'+stack.preload.path))).record.sha256,stack.preload.sha256);
  await save();
  for(let at=0;at<starts;at++) {
    await sample(at+1,inventory);
    const row=report.samples.at(-1);
    console.log(JSON.stringify({repetition:at+1,firstNativeValidateUI:row.native.firstValidation.uiMs,nativeInitialization:row.native.initializationMs,firstPythonGradeUI:row.python.firstGrade.uiMs}));
  }
  report.htmlAfter=(await fingerprint(pageURL)).record;assert.equal(report.htmlAfter.sha256,report.htmlBefore.sha256);
  for(const before of report.fingerprints.before) {
    const after=(await fingerprint(before.url)).record;report.fingerprints.after.push(after);
    assert.equal(after.sha256,before.sha256,'Measured asset changed: '+before.url);
  }
  const metric=(select,key)=>statistics(report.samples.flatMap(select).map(row=>row[key]));
  report.statistics={nativeInitialization:statistics(report.samples.map(row=>row.native.initializationMs)),
    native:Object.fromEntries(['firstValidation','warmValidation','firstGrade','warmGrade'].map(name=>[name,{ui:metric(row=>row.native[name],'uiMs'),worker:metric(row=>row.native[name],'workerMs')}])),
    python:Object.fromEntries(['validation','firstGrade','warmGrade'].map(name=>[name,{ui:metric(row=>row.python[name],'uiMs'),worker:metric(row=>row.python[name],'workerMs')}])),
    pythonInitialization:statistics(report.samples.map(row=>row.python.initializationStages.timings.readyMs))};
  report.passed=true;
}catch(error){report.failure={message:String(error),stack:error.stack};}
await save();
const {samples,...summary}=report;
summary.sampleChecks=samples.map(row=>({repetition:row.repetition,passed:row.passed===true,nativeOnlyEvidence:row.nativeOnlyEvidence,
  pythonAssetRequests:row.network.filter(item=>item.pythonAsset).length,failure:row.failure}));
await writeFile(resolve(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,statistics:report.statistics,failure:report.failure}));
if(!report.passed)process.exitCode=1;
