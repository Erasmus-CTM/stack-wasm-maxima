// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(process.env.CALLENTRY_MODULE_ROOT ? resolve(process.env.CALLENTRY_MODULE_ROOT,'placeholder.js') : import.meta.url);
const {chromium}=require('playwright');
const site=resolve(process.argv[2]||'.cache/callentry'), out=resolve(process.argv[3]||'test-results/runtime-callentry');
const here=resolve('prototype/runtime-callentry');
await mkdir(out,{recursive:true});
const report={schema:1,sourceRevision:process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),createdAt:new Date().toISOString(),passed:false,routes:[],errors:[]};
const digest=b=>createHash('sha256').update(b).digest('hex');
let browser;const servers=[];
async function serve(isolated){
 const server=createServer(async(q,r)=>{try {
  if(isolated){r.setHeader('Cross-Origin-Opener-Policy','same-origin');r.setHeader('Cross-Origin-Embedder-Policy','require-corp');}
  const path=new URL(q.url,'http://local').pathname;
  if(path==='/'){r.setHeader('Content-Type','text/html');r.end('<!doctype html><title>Call entry research</title>');return;}
  const local=['worker.js','suite.js','baseline.js'].includes(path.slice(1));
  const root=local?here:site,target=resolve(root,'.'+path), rel=relative(root,target);
  assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'));
  let bytes=await readFile(target);r.setHeader('Content-Type',extname(target)==='.js'?'application/javascript':extname(target)==='.wasm'?'application/wasm':'application/octet-stream');
  if(q.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(q.headers.range);assert.ok(m);let a=+m[1],z=m[2]?+m[2]:bytes.length-1;assert.ok(a<=z&&z<bytes.length);r.statusCode=206;r.setHeader('Content-Range',`bytes ${a}-${z}/${bytes.length}`);bytes=bytes.subarray(a,z+1);}
  r.setHeader('Content-Length',bytes.length);r.end(q.method==='HEAD'?undefined:bytes);
 }catch(e){r.statusCode=404;r.end(String(e));}});
 await new Promise(y=>server.listen(0,'127.0.0.1',y));servers.push(server);return `http://127.0.0.1:${server.address().port}/`;
}
try{
 const manifest=JSON.parse(await readFile(resolve(site,'stack-sources.json'),'utf8'));
 report.stackRevision=manifest.stackRevision;
 report.assets=[];
 for(const asset of manifest.runtimeAssets){const bytes=await readFile(resolve(site,'maxima-runtime',asset.path));assert.equal(bytes.length,asset.fileBytes,asset.path);assert.equal(digest(bytes),asset.sha256,asset.path);report.assets.push({path:asset.path,sha256:asset.sha256});}
 for(const file of manifest.files)assert.equal(digest(Buffer.from(file.content)),file.sha256,file.path);
 const fixtures=JSON.parse(await readFile('reports/milestone-one/latest.json','utf8')).cases;assert.equal(fixtures.length,22);
 const questions=JSON.parse(await readFile(resolve(site,'native/questions.json'),'utf8')).questions;
 const question=questions.find(q=>q.id==='native-rational').question;
 browser=await chromium.launch({headless:true,...(process.env.CALLENTRY_CHROME?{executablePath:process.env.CALLENTRY_CHROME}:{})});report.browserVersion=browser.version();
 for(const mode of ['baseline','eof','to-lisp']){
  const page=await browser.newPage();const url=await serve(mode==='baseline');
  const row={mode,messages:[],console:[],errors:[],passed:false};report.routes.push(row);
  page.on('console',m=>row.console.push(m.text()));page.on('pageerror',e=>row.errors.push(String(e)));
  await page.goto(url);
  const result=await page.evaluate(({mode,manifest,fixtures,question})=>new Promise(resolve=>{
   const isolated=crossOriginIsolated,sab=typeof SharedArrayBuffer;
   const messages=[];const worker=new Worker(mode==='baseline'?'/baseline.js':'/worker.js');
   const timer=setTimeout(()=>{worker.terminate();resolve({isolated,sab,messages,timeout:true})},240000);
   const done=()=>{clearTimeout(timer);worker.terminate();resolve({isolated,sab,messages})};
   worker.onerror=e=>{messages.push({type:'failure',error:e.message});done()};
   worker.onmessage=({data})=>{messages.push(data);if(data.type==='returned')worker.postMessage({type:'suite',fixtures,question});if(data.type==='failure')done();
    if(data.type==='complete') {
     if(mode==='baseline')done();else worker.postMessage({id:'cas-error',expression:'error("intentional step-zero CAS error")'});
    }
    if(data.type==='evaluated'&&data.id==='cas-error') {
     messages.find(m=>m.type==='complete').recovery={failed:data.value};
     worker.postMessage({id:'after-error',expression:'6*7'});
    }
    if(data.type==='evaluated'&&data.id==='after-error') {
     messages.find(m=>m.type==='complete').recovery.recovered=data.value;done();
    }};
   worker.postMessage(mode==='baseline'?{fixtures,question}:{type:'start',baseURL:'/maxima-runtime/',manifest,route:mode});
  }),{mode,manifest,fixtures,question});
  Object.assign(row,result);await page.close();
  assert.notEqual(row.timeout,true,mode+' worker timed out');
  assert.deepEqual(row.errors,[],mode+' page errors');
  assert.equal(row.messages.some(m=>m.type==='failure'),false,mode+' worker failure');
  const complete=row.messages.find(m=>m.type==='complete');
  if(!complete)throw new Error(mode+' failed: '+JSON.stringify(row.messages).slice(-3000));
  assert.equal(row.isolated,mode==='baseline');
  if(mode!=='baseline'){assert.equal(row.messages.filter(m=>m.type==='evaluated'&&m.id==='cas-error').length,1);assert.equal(row.messages.filter(m=>m.type==='evaluated'&&m.id==='after-error').length,1);assert.equal(row.sab,'undefined');assert.equal(complete.recovery.failed[0],false);assert.deepEqual(complete.recovery.recovered,[true,42]);}
  row.passed=true;
  await writeFile(resolve(out,mode+'.json'),JSON.stringify(row,null,2)+'\n');
 }
 const normalized=suite=>({rows:suite.rows.map(({name,result})=>({name,result})),native:suite.native});
 const baseline=report.routes[0].messages.find(m=>m.type==='complete').suite;
 assert.equal(baseline.rows.length,26,'Expected 22 answer tests and 4 native programs');
 for(const row of report.routes.slice(1))assert.deepEqual(normalized(row.messages.find(m=>m.type==='complete').suite),normalized(baseline),row.mode+' transport parity');
 const reference=JSON.parse(await readFile('reports/milestone-one/native-'+manifest.stackRevision.slice(0,7)+'.json','utf8'));
 for(const row of baseline.rows.slice(0,22)){const expected=reference.observations.find(o=>o.case_id===row.name);assert.deepEqual(row.result.slice(0,3),[expected.cas_valid,expected.correct,expected.answer_note]);}
 report.passed=true;
}catch(e){report.errors.push(String(e.stack||e));}
finally{await browser?.close();await Promise.all(servers.map(s=>new Promise(y=>s.close(y))));await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({passed:report.passed,routes:report.routes.map(r=>({mode:r.mode,passed:r.passed})),errors:report.errors}));
if(!report.passed)process.exitCode=1;
