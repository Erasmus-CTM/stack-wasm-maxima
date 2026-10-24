// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {serveDemo} from '../../scripts/milestone-two/serve.mjs';
import {timingWorker} from './timing-worker.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// CTM_TIMING_REPETITIONS alternating repetitions of CTM_TIMING_PROFILES (all
// admitted profiles are still verified). CTM_TIMING_LABEL names a run made
// under a CPU limit set from outside (the workflow's systemd CPUQuota), the
// stand-in for plan D8's reference laptop until one is named.
const repetitions=Number(process.env.CTM_TIMING_REPETITIONS||2);
const timed=(process.env.CTM_TIMING_PROFILES||'baseline,ecl-oz,ecl-o2').split(',');
const label=process.env.CTM_TIMING_LABEL||'';
const root=resolve('.cache/compiler-trials'),output=join(root,'comparison',label?`timings-${label}.json`:'timings.json');
const admissionBytes=await readFile(join(root,'comparison/admission.json'));
const admission=JSON.parse(admissionBytes);
const report={schema:1,passed:false,admissionSha256:hash(admissionBytes),samples:[],repetitions,profiles:timed,label:label||null,
 cpuLimit:process.env.CTM_TIMING_CPU_LIMIT||null,
 toolchain:{node:process.version,zlib:process.versions.zlib,platform:process.platform,arch:process.arch},
 runnerImage:Object.fromEntries(['ImageOS','ImageVersion','RUNNER_OS','RUNNER_ARCH'].map(k=>[k,process.env[k]||null])),
 scope:'Accepted compiler profiles on this same runner, gzip-6 server policy, alternating-order trials (see repetitions, profiles, cpuLimit). Each trial uses a fresh browser profile followed by a reload on the same live origin/context with a new worker. Warm calls retain their worker. OS/process/filesystem warming is uncontrolled; medians over the repetitions are reported, not a statistical claim. No profile is promoted automatically.'};
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
 assert.ok(Number.isInteger(repetitions)&&repetitions>=1&&repetitions<=20,'CTM_TIMING_REPETITIONS must be 1-20');
 assert.ok(timed.length&&timed.every(name=>names.includes(name)),'CTM_TIMING_PROFILES must name admitted profiles');
 for(let repetition=1;repetition<=repetitions;repetition++)for(const candidate of repetition%2===1?timed:[...timed].reverse()){
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
 assert.equal(report.samples.length,repetitions*timed.length*2);
 const median=values=>{const v=[...values].sort((a,b)=>a-b),m=v.length>>1;return v.length%2?v[m]:(v[m-1]+v[m])/2;};
 report.medians=Object.fromEntries(timed.map(name=>[name,Object.fromEntries(['cold','warm-profile-reload'].map(mode=>[mode,
  median(report.samples.filter(s=>s.candidate===name&&s.mode===mode).map(s=>s.readyMs))]))]));
 report.passed=true;
}catch(error){report.failure=String(error);console.error(error);}
finally{await writeFile(output,JSON.stringify(report,null,2)+'\n');}
if(!report.passed)process.exitCode=1;
