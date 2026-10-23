// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {serveDemo} from '../../scripts/milestone-two/serve.mjs';
import {hash} from './codec.mjs';
const site=resolve('site/_site'),source=resolve('.cache/runtime-compression/artifact'),out=resolve('test-results/runtime-compression');
await mkdir(out,{recursive:true});
const report={schema:1,passed:false,scope:'Actual Chromium session with preload disabled exercises Emscripten lazy HEAD/GET behavior; an independent browser fetch checks canonical byte-range offsets.'};
let app,browser;
try{
 await writeFile(join(site,'compression-probe.html'),'<!doctype html><title>Compression HTTP research</title>');
 await writeFile(join(site,'compression-probe.js'),`importScripts('runtime/maxima-session.js');self.onmessage=async()=>{let session;try{session=new MaximaSession({baseURL:'./maxima-runtime/',stackSourceURL:'./stack-sources.json',preload:false});const initialization=await session.init();const value=session.evaluate('6*7');const grade=session.assess({test:'AlgEquiv',student:'(x+1)^2',teacher:'x^2+2*x+1'});self.postMessage({ok:true,initialization,value,grade});}catch(error){self.postMessage({ok:false,error:String(error)});}finally{if(session)session.terminate();}};`);
 app=await serveDemo({root:site,sidecarSource:source,sidecarMode:'br'});
 browser=await chromium.launch({headless:true});report.browser=browser.version();
 const page=await browser.newPage();await page.goto(app.baseURL+'compression-probe.html');
 report.session=await page.evaluate(()=>new Promise(resolveResult=>{
  const worker=new Worker('compression-probe.js'),timer=setTimeout(()=>{worker.terminate();resolveResult({ok:false,error:'Lazy-session watchdog expired'});},300000);
  const finish=data=>{clearTimeout(timer);worker.terminate();resolveResult(data);};worker.onmessage=({data})=>finish(data);worker.onerror=e=>finish({ok:false,error:e.message});worker.postMessage({});
 }));
 assert.equal(report.session.ok,true,report.session.error);assert.equal(report.session.value,42);assert.equal(report.session.grade.correct,true);assert.equal(report.session.grade.cas_valid,true);
 const body=await readFile(join(site,'maxima-runtime/maxima.wasm'));
 report.range=await page.evaluate(async()=>{const response=await fetch('maxima-runtime/maxima.wasm',{headers:{Range:'bytes=17-107'}});return {status:response.status,contentType:response.headers.get('content-type'),contentEncoding:response.headers.get('content-encoding'),contentRange:response.headers.get('content-range'),body:[...new Uint8Array(await response.arrayBuffer())]};});
 assert.equal(report.range.status,206);assert.equal(report.range.contentEncoding,null);assert.equal(report.range.contentType,'application/wasm');assert.equal(report.range.contentRange,`bytes 17-107/${body.length}`);assert.deepEqual(Buffer.from(report.range.body),body.subarray(17,108));
 report.range.decodedSha256=hash(Buffer.from(report.range.body));
 assert.ok(app.requests.some(row=>row.pathname==='/maxima-runtime/maxima.wasm'&&row.contentEncoding==='br'&&row.method==='GET'));
 assert.ok(app.requests.some(row=>row.pathname?.startsWith('/maxima-runtime/share/')&&row.contentEncoding==='gzip'&&row.method==='HEAD'));
 assert.ok(app.requests.some(row=>row.pathname?.startsWith('/maxima-runtime/share/')&&row.contentEncoding==='gzip'&&row.method==='GET'));
 assert.ok(app.requests.some(row=>row.range==='bytes=17-107'&&row.contentEncoding==='identity'&&row.status===206));
 assert.equal(app.requests.some(row=>row.status>=400),false);
 report.passed=true;
}catch(error){report.failure=String(error);console.error(error);}
finally{if(browser)await browser.close();if(app){report.requests=app.requests;await app.close();}await writeFile(join(out,'http-probe.json'),JSON.stringify(report,null,2)+'\n');}
if(!report.passed)process.exitCode=1;
