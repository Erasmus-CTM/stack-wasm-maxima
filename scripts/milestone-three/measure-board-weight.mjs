// SPDX-License-Identifier: AGPL-3.0-or-later
// Real HTTP body measurements: no request routing, response replacement or
// service-worker blocker. Offline dependency proof is a separate harness.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {serveDemo} from '../milestone-two/serve.mjs';

const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes('--'+name)?args[args.indexOf('--'+name)+1]:fallback;
const engine=option('browser','chromium');
const width=Number(option('width','1280'));assert.ok(Number.isSafeInteger(width)&&width>=320);
const functionalOnly=args.includes('--functional-only');
assert.ok(['chromium','firefox','webkit'].includes(engine));
const types=await import(process.env.CTM_PLAYWRIGHT_MODULE||'playwright');
const output=resolve(option('output','test-results/board-weight-'+engine+'.json'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const gitBlob=bytes=>createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
const report={schema:1,engine,createdAt:new Date().toISOString(),capture:{quietMilliseconds:1000,deadlineMilliseconds:60000,source:'BrowserContext lifecycle plus concrete origin response finish/abort telemetry'},
  scope:functionalOnly?'Functional board acceptance; byte counts are bounded observations, not transfer benchmarks':'No-routing cold and same-profile warm HTTP measurements with variant visits, real drag and reset',
  packagingEncoder:{node:process.version,zlib:process.versions.zlib},
  byteSemantics:'request.sizes().responseBodySize is browser-reported encoded body received; headers are separate. Browser events may omit worker-owned HTTP requests, so these values are known observed subtotals and never full wire totals. Static file/gzip sizes are packaging data, never inferred wire traffic. Cached/unavailable timing is retained explicitly. Service-worker synthesized response sizes are browser-reported delivered bytes, not origin encoded traffic: they are excluded from known wire subtotals and make full wire totals unavailable; the raw reported sizes remain retained.',
  cases:[],passed:false};

async function packaging(root){
  const bytes=await readFile(join(root,'maxima/native.html'));
  const text=bytes.toString('utf8');
  const occurrences=Array.from(text.matchAll(/data:text\/html;base64,([A-Za-z0-9+/=]+)/g),row=>row[1]);
  const files=[];
  async function walk(path){
    for(const entry of await readdir(path,{withFileTypes:true})){
      const full=join(path,entry.name),stat=await lstat(full);
      assert.ok(!stat.isSymbolicLink(),'Packaging inventory cannot follow symlinks');
      if(stat.isDirectory())await walk(full);
      else {const body=await readFile(full);files.push({path:full.slice(root.length+1).replaceAll('\\','/'),bytes:body.length,gzip6Bytes:gzipSync(body,{level:6}).length,sha256:sha(body)});}
    }
  }
  try{await walk(join(root,'native/boards'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return {html:{bytes:bytes.length,sha256:sha(bytes),gzip6Bytes:gzipSync(bytes,{level:6}).length,gzip9Bytes:gzipSync(bytes,{level:9}).length},
    embeddedBoardOccurrences:occurrences.length,uniqueEmbeddedBoards:new Set(occurrences.map(value=>sha(Buffer.from(value,'base64')))).size,
    encodedEmbeddedBoardBytes:occurrences.reduce((total,value)=>total+Buffer.byteLength(value),0),
    stagedBoardFiles:files,stagedBoardFileBytes:files.reduce((sum,file)=>sum+file.bytes,0),
    sumPerFileGzip6Bytes:files.reduce((sum,file)=>sum+file.gzip6Bytes,0)};
}

async function boardsReady(page){
  const frames=page.locator('iframe[data-stack-jsxgraph]');
  await frames.first().waitFor({state:'attached',timeout:60000});
  assert.ok(await frames.count()>0,'A measured native page must contain actual graphical questions');
  for(let at=0;at<await frames.count();at++){
    const handle=await frames.nth(at).elementHandle();
    await page.waitForFunction(frame=>frame.dataset.stackJsxgraphReady==='true',handle,{timeout:60000});
    const child=await handle.contentFrame();assert.ok(child);
    await child.waitForFunction(()=>window.__ctmStackJSXGraphReady===true&&Object.keys(window.JXG?.boards||{}).length>0,null,{polling:100,timeout:60000});
  }
}

const trafficCaptures=new WeakMap();
async function settle(page){
  await boardsReady(page);
  // A board can report JSXGraph ready before MathJax starts its resource
  // fetches. Complete the current frame's typeset before replacing that frame
  // for the next variant; otherwise Firefox can cancel a real response and
  // make the transfer total look artificially low. Retired Firefox children
  // can also keep page.networkidle pending, so inspect current frames only.
  for(const element of await page.locator('iframe[data-stack-jsxgraph]').elementHandles()){
    const frame=await element.contentFrame();assert.ok(frame);
    await frame.waitForLoadState('load',{timeout:60000});
    await frame.waitForFunction(()=>!!window.MathJax?.startup?.promise,null,{polling:100,timeout:60000});
    await frame.evaluate(()=>Promise.race([MathJax.startup.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('MathJax startup/typeset deadline')),60000))]));
  }
  // Browser networkidle can stay pending after a retired iframe. Instead wait
  // concrete observed request completion, response measurements, origin-server
  // response completion and one second without activity. No routing or filters.
  await trafficCaptures.get(page).wait();
}

async function interactions(page,rows,manifest){
  const cards=page.locator('section.stack-sympy').filter({has:page.locator('iframe[data-stack-jsxgraph]')});
  if(manifest){const expected=manifest.questions.filter(entry=>entry.question.native.boards.length);assert.equal(await cards.count(),expected.length,'Every rendered graphical question must be exercised');}
  for(let at=0;at<await cards.count();at++){
    const card=cards.nth(at),id=await card.getAttribute('data-stack-id');
    const select=card.locator('.stack-variant');
    const choices=await select.locator('option').evaluateAll(options=>options.map(option=>option.value));
    const entry=manifest?.questions?.find(row=>row.id===id);
    if(entry){const payload=JSON.parse(await card.locator('script.stack-sympy-data').textContent());assert.deepEqual(payload.variants,entry.variants,'Functional variants must match the exact produced manifest');}
    const seenCoordinates=[];
    for(const value of [...choices.slice(1),choices[0]]){
    await select.selectOption(value);await settle(page);
    await card.scrollIntoViewIfNeeded();
    const element=card.locator('iframe[data-stack-jsxgraph]').first();
    await element.scrollIntoViewIfNeeded();
    const frame=await (await element.elementHandle()).contentFrame();assert.ok(frame);
    const descriptor=JSON.parse(await element.getAttribute('data-stack-jsxgraph'));
    assert.ok(descriptor.inputs.length>0,'Measured drag needs a bound ordinary input');
    const field=card.locator('.stack-answer[data-name='+JSON.stringify(descriptor.inputs[0])+']');
    const before=await field.inputValue();
    const evidence={id,variant:value,visitedVariants:choices,before,stage:'drag'};rows.push(evidence);
    const expected=entry?.graphical?.variantPoints?.find(row=>row.variant===Number(value));
    if(expected){const actual=await frame.evaluate(name=>{const point=Object.values(JXG.boards).flatMap(board=>board.objectsList).find(point=>point.elType==='point'&&point.name===name);if(!point)throw new Error('Missing seeded authored point');return [point.X(),point.Y()];},expected.pointName);assert.ok(actual.every((coordinate,axis)=>Math.abs(coordinate-expected.coordinates[axis])<0.01),'Each selected variant must use its prepared point');evidence.initialCoordinates=actual;seenCoordinates.push(actual);}
    await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const point=await frame.evaluate(()=>{
      const board=Object.values(JXG.boards).find(board=>board.objectsList.some(point=>point.elType==='point'&&point.visProp.visible&&!point.visProp.fixed));
      if(!board)throw new Error('No actual draggable authored point');
      const point=board.objectsList.find(point=>point.elType==='point'&&point.visProp.visible&&!point.visProp.fixed);
      const rect=point.rendNode?.getBoundingClientRect(),container=board.containerObj.getBoundingClientRect();
      return {name:point.name,user:[point.X(),point.Y()],from:point.coords.scrCoords.slice(1),svgPoint:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,container:{x:container.x,y:container.y,width:container.width,height:container.height},to:[board.origin.scrCoords[1]+board.unitX,board.origin.scrCoords[2]-board.unitY]};
    });
    let box=await element.boundingBox();assert.ok(box);
    // Keep the real authored point and target reachable on a narrow viewport.
    const scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
    const minimum=scroll.x+box.x+Math.min(point.from[0],point.to[0]);
    const maximum=scroll.x+box.x+Math.max(point.from[0],point.to[0]);
    const left=Math.max(0,Math.min(minimum-16,maximum-width+16));
    await page.evaluate(({left,top})=>window.scrollTo({left,top,behavior:'instant'}),{left,top:scroll.y});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    box=await element.boundingBox();
    assert.ok(box.x+point.from[0]>=0&&box.x+point.from[0]<width,'Real pointer drag must start inside the viewport');
    evidence.point=point;evidence.frameBox=box;evidence.viewport=await page.evaluate(()=>({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight}));
    const from=[box.x+point.from[0],box.y+point.from[1]],to=[box.x+point.to[0],box.y+point.to[1]];
    await page.mouse.move(...from);await new Promise(resolve=>setTimeout(resolve,50));await page.mouse.down();
    await new Promise(resolve=>setTimeout(resolve,50));
    for(let step=1;step<=12;step++){await page.mouse.move(from[0]+(to[0]-from[0])*step/12,from[1]+(to[1]-from[1])*step/12);await new Promise(resolve=>setTimeout(resolve,25));}
    await page.mouse.up();evidence.realPointerMoveMilliseconds=300;
    await page.waitForFunction(({id,name,before})=>Array.from(document.querySelectorAll('section.stack-sympy')).find(card=>card.dataset.stackId===id)
      ?.querySelector('.stack-answer[data-name='+JSON.stringify(name)+']')?.value!==before,{id,name:descriptor.inputs[0],before},{timeout:15000});
    const after=await field.inputValue();assert.notEqual(after,before,'Real drag must change its bound answer');
    evidence.dragChanged=true;evidence.after=after;evidence.stage='reset';
    await card.locator('.stack-reset').click();await settle(page);
    assert.equal(await field.inputValue(),before,'Reset must restore the original input');
    if(expected){const restored=await (await (await card.locator('iframe[data-stack-jsxgraph]').first().elementHandle()).contentFrame()).evaluate(name=>{const point=Object.values(JXG.boards).flatMap(board=>board.objectsList).find(point=>point.elType==='point'&&point.name===name);return [point.X(),point.Y()];},expected.pointName);assert.ok(restored.every((coordinate,axis)=>Math.abs(coordinate-expected.coordinates[axis])<0.01));evidence.resetCoordinates=restored;}
    evidence.resetRestored=true;
    if(entry?.graphical?.kind==='point'){await field.fill('[1,-1]');await field.dispatchEvent('change');const resetFrame=await (await card.locator('iframe[data-stack-jsxgraph]').first().elementHandle()).contentFrame();await resetFrame.waitForFunction(name=>Object.values(JXG.boards).flatMap(board=>board.objectsList).some(point=>point.elType==='point'&&point.name===name&&Math.abs(point.X()-1)<0.01&&Math.abs(point.Y()+1)<0.01),entry.graphical.pointName,{timeout:10000});evidence.ordinaryInputUpdatedPoint=true;await card.locator('.stack-reset').click();await settle(page);assert.equal(await field.inputValue(),before);}
    evidence.stage='complete';
    }
    if(entry?.graphical?.variantPoints)assert.equal(new Set(seenCoordinates.map(row=>JSON.stringify(row))).size,choices.length,'Seeded variants must remain distinct');
  }
  return rows;
}

async function measure(name,root,expectedSHA,live){
  root=resolve(root);
  let app,browser,packaged,manifest;
  if(!live){try{manifest=JSON.parse(await readFile(join(root,'native/build-manifest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(!live){packaged=await packaging(root);if(expectedSHA)assert.equal(packaged.html.sha256,expectedSHA,'Exact frozen baseline HTML is mandatory');app=await serveDemo({root,isolationHeaders:!args.includes('--static-host')});}
  const pageURL=live?.url||app.baseURL+'maxima/native.html';
  const result={name,root,pageURL,staticHost:args.includes('--static-host'),packaging:packaged,phases:[],errors:[],consoleErrors:[],failedRequests:[],verifiedBodies:[],externalBodies:[]};
  async function verifyLiveHTML(){
    const response=await fetch(pageURL,{signal:AbortSignal.timeout(60000)});assert.equal(response.status,200);
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(sha(bytes),expectedSHA,'Live baseline HTML changed');
    await mkdir(join(root,'maxima'),{recursive:true});await writeFile(join(root,'maxima/native.html'),bytes);
    return {bytes:bytes.length,sha256:sha(bytes),gitBlob:gitBlob(bytes)};
  }
  try{
    if(live)result.before=await verifyLiveHTML();
    const launch=engine==='chromium'&&process.env.CTM_CHROMIUM_CHANNEL?{channel:process.env.CTM_CHROMIUM_CHANNEL}:{};
    browser=await types[engine].launch({headless:true,...launch});
    result.browserVersion=browser.version();
    const context=await browser.newContext({viewport:{width,height:900}});
    const page=await context.newPage();let phase;
    const owners=new WeakMap(),pending=new Set(),active=new Map();let lastActivity=Date.now();
    trafficCaptures.set(page,{wait:async()=>{const deadline=Date.now()+60000;while(active.size||pending.size||app?.activeResponses.length||Date.now()-Math.max(lastActivity,app?.lastResponseActivity||0)<1000){if(Date.now()>deadline)throw new Error("HTTP capture deadline: "+JSON.stringify({browser:[...active.values()],origin:app?.activeResponses,measurements:pending.size}));await new Promise(resolve=>setTimeout(resolve,50));}}});
    result.pendingRequests=[];
    page.on('pageerror',error=>result.errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')result.consoleErrors.push(message.text());});
    context.on('requestfailed',request=>{active.delete(request);lastActivity=Date.now();result.pendingRequests=[...active.values()];result.failedRequests.push({url:request.url(),failure:request.failure(),at:new Date().toISOString(),phase:phase?{pass:phase.pass,action:phase.action}:null});});
    context.on('request',request=>{if(/^https?:/.test(request.url())){owners.set(request,phase);lastActivity=Date.now();active.set(request,{url:request.url(),resourceType:request.resourceType(),startedAt:new Date().toISOString(),phase:phase?{pass:phase.pass,action:phase.action}:null});result.pendingRequests=[...active.values()];}});
    context.on('requestfinished',request=>{
      active.delete(request);lastActivity=Date.now();result.pendingRequests=[...active.values()];
      if(!/^https?:/.test(request.url()))return;
      const owner=owners.get(request);if(!owner)return;
      const task=(async()=>{
        const response=await request.response();
        const row={url:request.url(),method:request.method(),resourceType:request.resourceType(),status:response?.status(),fromServiceWorker:response?.fromServiceWorker()};
        if(args.includes('--static-host')&&response&&!response.fromServiceWorker()&&new URL(request.url()).origin===new URL(pageURL).origin){row.rawHeaders=await response.allHeaders();for(const header of ['cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy'])assert.equal(row.rawHeaders[header],undefined,'Raw static host must not supply isolation headers');}
        try{const sizes=await Promise.race([request.sizes(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Browser size API deadline")),10000))]);assert.ok(Number.isFinite(sizes.responseBodySize)&&sizes.responseBodySize>=0);Object.assign(row,sizes);}catch(error){row.sizesUnavailable=String(error);}
        owner.requests.push(row);
        if(live&&response?.status()===200){
          let bytes;
          try{bytes=await response.body();}catch(error){
            row.observedBodyUnavailable=String(error);
            // A service-worker navigation may evict an inspector body. Verify
            // the frozen replay source separately; this fetch is NOT browser
            // transfer traffic and does not warm the measured browser cache.
            const verification=await fetch(row.url,{signal:AbortSignal.timeout(60000)});assert.equal(verification.status,200);
            bytes=Buffer.from(await verification.arrayBuffer());row.bodyFromVerificationFetch=true;
          }
          const url=new URL(row.url),base=new URL('../',pageURL);
          const body={url:row.url,bytes:bytes.length,sha256:sha(bytes),gitBlob:gitBlob(bytes)};
          if(row.bodyFromVerificationFetch)body.source='separate verification fetch; measured inspector body unavailable';
          if(url.origin===base.origin&&url.pathname.startsWith(base.pathname)){
            const path=decodeURIComponent(url.pathname.slice(base.pathname.length));
            assert.ok(path&&!path.split('/').includes('..')&&!path.startsWith('/'),'Unsafe baseline body path');
            assert.equal(body.gitBlob,live.tree.get(path),'Observed baseline body differs from pinned published Git tree: '+path);
            const target=join(root,path);await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,bytes);
            result.verifiedBodies.push({...body,path});
          }else result.externalBodies.push(body);
        }
      })().catch(error=>{(owner.measurementErrors||=[]).push(String(error.stack||error));});pending.add(task);task.finally(()=>pending.delete(task));
    });
    for(const pass of (functionalOnly?['functional']:['cold','warm-same-profile'])){
      for(const action of ['load','variants-drag-reset']){
        phase={pass,action,requests:[],serverRequestStart:app?.requests.length};result.phases.push(phase);
        if(action==='load'){await page.goto(pageURL,{waitUntil:'load'});if(args.includes('--static-host')){await page.waitForFunction(()=>crossOriginIsolated&&navigator.serviceWorker.controller!==null,null,{timeout:60000});await page.waitForLoadState('load',{timeout:60000});}await settle(page);if(args.includes('--static-host'))assert.equal(await page.evaluate(()=>crossOriginIsolated),true,'Canonical service worker must isolate the actual native page');}
        else {phase.interactions=[];await interactions(page,phase.interactions,manifest);}
        await Promise.all([...pending]);
        phase.serverRequests=app?.requests.slice(phase.serverRequestStart)||[];
        phase.browserKnownReportedBodyBytes=phase.requests.reduce((sum,row)=>sum+(row.responseBodySize??0),0);
        phase.serviceWorkerResponseCount=phase.requests.filter(row=>row.fromServiceWorker).length;
        phase.browserKnownEncodedBodyBytes=phase.requests.filter(row=>!row.fromServiceWorker).reduce((sum,row)=>sum+(row.responseBodySize??0),0);
        phase.browserKnownResponseHeaderBytes=phase.requests.filter(row=>!row.fromServiceWorker).reduce((sum,row)=>sum+(row.responseHeadersSize??0),0);
        phase.unavailableSizeCount=phase.requests.filter(row=>row.sizesUnavailable).length;
        phase.browserEncodedBodyBytes=null;
        phase.wireCoverage='Browser-observed subtotal only; worker-owned requests may be absent. The origin server counter covers served encoded bodies at this origin; external totals remain unknown.';
        phase.captureBoundary={quietMilliseconds:1000,browserPending:active.size,measurementPending:pending.size,originPending:app?.activeResponses.length};
        phase.browserResponseHeaderBytes=null;
        phase.serverEncodedBodyBytes=app?phase.serverRequests.reduce((sum,row)=>sum+(row.encodedBodyBytes??0),0):null;
        phase.coreServerRequests=manifest?.jsxgraphCore?phase.serverRequests.filter(row=>row.pathname?.endsWith('/'+manifest.jsxgraphCore.sha256+'.js')||row.url?.includes('/'+manifest.jsxgraphCore.sha256+'.js')):[];
        phase.coreBrowserRequests=manifest?.jsxgraphCore?phase.requests.filter(row=>row.url.includes('/'+manifest.jsxgraphCore.sha256+'.js')):[];
        phase.boardRequests=phase.requests.filter(row=>row.url.includes('/native/boards/'));
        phase.boardBrowserKnownEncodedBodyBytes=phase.boardRequests.filter(row=>!row.fromServiceWorker).reduce((sum,row)=>sum+(row.responseBodySize??0),0);
        phase.boardBrowserEncodedBodyBytes=null;
      }
    }
    await mkdir(resolve(output,'..'),{recursive:true});
    const screenshot=output.replace(/\.json$/,'.png');await page.screenshot({path:screenshot,fullPage:true});result.screenshot=screenshot;result.viewport={width,height:900};
    if(live){
      result.after=await verifyLiveHTML();
      result.observedMathJax=await Promise.all(page.frames().filter(frame=>frame!==page.mainFrame()).map(async frame=>({url:frame.url().startsWith('data:')?'data:board':frame.url(),version:await frame.evaluate(()=>window.MathJax?.version||null)})));
    }
    result.originAbortedResponses=app?.abortedResponses||[];
    // Intentional variant/reset iframe replacement can cancel a late MathJax
    // accessibility fetch in Firefox. Functional-only runs retain every abort
    // for review, but make no transfer-savings claim from these byte counts.
    result.originAbortPolicy=functionalOnly
      ? 'Recorded as functional-run evidence; no transfer comparison is made'
      : 'Zero aborts required for transfer comparison';
    result.originFailedResponses=app?.requests.filter(row=>row.status>=400||row.error)||[];
    result.browserFailedResponses=result.phases.flatMap(phase=>phase.requests).filter(row=>row.status>=400);
    await context.close();
    assert.ok(result.phases.every(phase=>!phase.measurementErrors?.length),'Body verification/measurement errors must not look like cache savings');
    if(name==='candidate'){
      assert.deepEqual(result.errors,[],'No raw browser errors are accepted in candidate transfer evidence');
      assert.deepEqual(result.failedRequests,[],'Failed transfers must not look like cache savings');
      if(!functionalOnly)assert.deepEqual(result.originAbortedResponses,[],'Origin response aborts must not look like cache savings');
      assert.deepEqual(result.originFailedResponses,[],'Origin HTTP errors must not look like cache savings');
      assert.deepEqual(result.browserFailedResponses,[],'HTTP errors must not look like cache savings');
      assert.deepEqual(result.consoleErrors,[],'Raw console failures are not accepted');
    }
    result.passed=true;
  }catch(error){result.error=String(error.stack||error);if(browser){const page=browser.contexts()[0]?.pages()[0];if(page){result.frameStates=[];for(const element of await page.locator('iframe[data-stack-jsxgraph]').elementHandles()){try{const frame=await element.contentFrame();result.frameStates.push({attributes:await element.evaluate(node=>({id:node.id,ready:node.getAttribute('data-stack-jsxgraph-ready'),spec:node.getAttribute('data-stack-jsxgraph')})),box:await element.boundingBox(),state:await Promise.race([frame.evaluate(()=>({url:location.href,base:document.baseURI,ready:window.__ctmStackJSXGraphReady,boardIds:Object.keys(window.JXG?.boards||{}),mathjax:window.MathJax?.version,text:document.body?.innerText.slice(-500)})),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Frame diagnostic deadline')),5000))])});}catch(error){result.frameStates.push({error:String(error)});}}await mkdir(resolve(output,'..'),{recursive:true});await page.screenshot({path:output.replace(/\.json$/,'.failure.png'),fullPage:true});}}throw error;}
  finally{if(browser)await browser.close();if(app)await app.close();report.cases.push(result);}
}

try{
  let baseline=option('baseline-site');
  const baselineURL=option('baseline-url');
  if(baselineURL){
    assert.equal(new URL(baselineURL).protocol,'https:');
    const expected=option('baseline-html-sha256');assert.match(expected||'',/^[a-f0-9]{64}$/);
    const source=JSON.parse(await readFile(resolve(option('baseline-tree')),'utf8'));
    const entries=Array.isArray(source.tree)?source.tree:Object.entries(source.files||{}).map(([path,row])=>({path,type:'blob',...row}));
    assert.ok(entries.length>0&&source.truncated===false,'A complete pinned published Git tree is required');
    const tree=new Map(entries.filter(row=>row.type==='blob').map(row=>[row.path,row.sha]));
    baseline=resolve(option('baseline-cache','.cache/board-weight-frozen-baseline'));
    report.baselineSource={url:baselineURL,revision:source.revision||source.sha,externalDependencyPolicy:'Baseline CDN resources are mutable remote dependencies; observed versions/body hashes are recorded separately.'};
    await measure('live-baseline-observation',baseline,expected,{url:baselineURL,tree});
  }
  if(baseline){
    const expected=option('baseline-html-sha256');assert.match(expected||'',/^[a-f0-9]{64}$/,'Supply the frozen baseline HTML SHA');
    await measure('frozen-baseline',baseline,expected);
  }else report.baselineUnavailable='No complete frozen baseline site was supplied; no before/after wire reduction is claimed.';
  if(args.includes('--harvest-only'))report.candidateUnavailable='Baseline closure harvesting only; candidate measurement remains pending.';
  else await measure('candidate',option('site','site/_site'));
  report.passed=true;
}finally{
  await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({engine,passed:report.passed,cases:report.cases.map(row=>({name:row.name,passed:row.passed,error:row.error,html:row.packaging?.html,
    phases:row.phases.map(phase=>({pass:phase.pass,action:phase.action,browserEncodedBodyBytes:phase.browserEncodedBodyBytes,serverEncodedBodyBytes:phase.serverEncodedBodyBytes,unavailableSizeCount:phase.unavailableSizeCount,graphicalVariants:phase.interactions?.map(row=>({id:row.id,variant:row.variant,dragChanged:row.dragChanged,resetRestored:row.resetRestored,ordinaryInputUpdatedPoint:row.ordinaryInputUpdatedPoint,initialCoordinates:row.initialCoordinates}))}))})),baselineUnavailable:report.baselineUnavailable}));
}
