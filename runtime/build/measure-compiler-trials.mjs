// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {serveDemo} from '../../scripts/milestone-two/serve.mjs';
import {timingWorker} from './timing-worker.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const root=resolve('.cache/compiler-trials'),output=join(root,'comparison/timings.json');
const admissionBytes=await readFile(join(root,'comparison/admission.json'));
const admission=JSON.parse(admissionBytes);
const report={schema:1,passed:false,admissionSha256:hash(admissionBytes),samples:[],
 toolchain:{node:process.version,zlib:process.versions.zlib,platform:process.platform,arch:process.arch},
 runnerImage:Object.fromEntries(['ImageOS','ImageVersion','RUNNER_OS','RUNNER_ARCH'].map(k=>[k,process.env[k]||null])),
 scope:'All three accepted compiler profiles on this same runner, gzip-6 server policy, two alternating-order trials. Each trial uses a fresh browser profile followed by a reload on the same live origin/context with a new worker. Warm calls retain their worker. OS/process/filesystem warming is uncontrolled; two observations per mode are not a statistical performance claim. No profile is promoted automatically.'};
try{
 assert.equal(admission.passed,true);
 const names=['baseline','ecl-oz','ecl-o2'];assert.deepEqual(Object.keys(admission.trials),names);
 const programs=admission.nativePrograms;
 report.nativePrograms=programs;report.trials={};
 for(const name of names){
  const accepted=admission.trials[name],demo=join(root,'demos',name);
  const stagedBytes=await readFile(join(demo,'stack-sources.json')),manifest=JSON.parse(stagedBytes);
  assert.equal(manifest.runtimeBuild.manifestSha256,accepted.manifestSha256);
  assert.deepEqual(manifest.runtimeBuild.compilerProfile,accepted.compilerProfile);
  assert.deepEqual(manifest.runtimeBuild.sourcePins,accepted.pins);
  assert.deepEqual(new Set(manifest.runtimeAssets.map(r=>r.path)),new Set(Object.keys(accepted.assets)));
  for(const asset of manifest.runtimeAssets){const body=await readFile(join(demo,'maxima-runtime',asset.path));assert.equal(hash(body),accepted.assets[asset.path].sha256);assert.equal(body.length,accepted.assets[asset.path].bytes);}
  const preload=await readFile(join(demo,'maxima-runtime',manifest.preload.path));assert.equal(hash(preload),manifest.preload.sha256);
  await writeFile(join(demo,'compiler-timing.html'),'<!doctype html><title>Controlled ECL compiler timing</title>');
  await writeFile(join(demo,'compiler-timing.js'),timingWorker);
  report.trials[name]={manifestSha256:accepted.manifestSha256,compilerProfile:accepted.compilerProfile,runtimeBytes:accepted.runtimeBytes,stagedManifestSha256:hash(stagedBytes),runtimeAssets:manifest.runtimeAssets,preload:manifest.preload};
 }
 for(let repetition=1;repetition<=2;repetition++)for(const candidate of repetition===1?names:[...names].reverse()){
  const app=await serveDemo({root:join(root,'demos',candidate),compression:'gzip'});let browser;
  try{
   browser=await chromium.launch({headless:true});report.browserVersion=browser.version();const page=await browser.newPage();
   for(const mode of ['cold','warm-profile-reload']){
    const requestStart=app.requests.length;
    if(mode==='cold')await page.goto(app.baseURL+'compiler-timing.html');else await page.reload();
    const result=await page.evaluate(programs=>new Promise(resolve=>{const worker=new Worker('compiler-timing.js');const timer=setTimeout(()=>{worker.terminate();resolve({ok:false,error:'Timing watchdog expired'})},300000);const finish=data=>{clearTimeout(timer);worker.terminate();resolve(data)};worker.onmessage=({data})=>finish(data);worker.onerror=e=>finish({ok:false,error:e.message});worker.postMessage({programs,trimPlot:true})}),programs);
    const requests=app.requests.slice(requestStart),sample={candidate,repetition,mode,...result,requests,encodedBodyBytes:requests.reduce((n,r)=>n+r.encodedBodyBytes,0)};
    report.samples.push(sample);await writeFile(output,JSON.stringify(report,null,2)+'\n');
    assert.equal(result.ok,true,result.error);assert.equal(result.nativeCalls.length,3);
    for(const call of result.nativeCalls)assert.deepEqual(call.result,call.expected);
    assert.equal(result.calls.length,10);assert.ok(result.calls.every(call=>call.value===42&&Number.isFinite(call.elapsedMs)&&call.elapsedMs>=0));
    assert.equal(result.smoke.retained,1000);assert.equal(result.smoke.gcCalls.length,100);assert.ok(result.smoke.gcCalls.every(v=>v===true));
    assert.match(result.smoke.caughtError,/CTM deliberate caught CAS error/);assert.equal(result.smoke.afterError,42);
    assert.equal(result.smoke.plotting.length,4);for(const call of result.smoke.plotting){assert.match(call.diagnostic,/CTM plotting unavailable; use JSXGraph/);assert.equal(call.afterError,42);}
    assert.ok(Number.isFinite(result.readyMs)&&result.readyMs>0);assert.equal(requests.some(r=>r.status>=400||/maxima-plot\.fas|libgnuplot\.so/.test(r.pathname)),false);
   }
  }finally{if(browser)await browser.close();await app.close();}
 }
 assert.equal(report.samples.length,12);report.passed=true;
}catch(error){report.failure=String(error);console.error(error);}
finally{await writeFile(output,JSON.stringify(report,null,2)+'\n');}
if(!report.passed)process.exitCode=1;
