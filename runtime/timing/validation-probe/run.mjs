import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {serveDemo} from '../../../scripts/milestone-two/serve.mjs';
const snapshotLisp=JSON.parse(await readFile('runtime/timing/validation-probe/postmortem-expression.json')).lisp;
const root=resolve('.'),out=join(root,'validation-probe'),stage=join(out,'site');await mkdir(out,{recursive:true});
await cp('input/.cache/precompiled-stack/site',stage,{recursive:true});
const manifest=JSON.parse(await readFile(join(stage,'stack-sources-timed-source.json')));assert.equal(manifest.compiledStack,undefined);
const helper=(await readFile('runtime/timing/source-ui/validation-trace.lisp','utf8')).split('\n').map(l=>l.trim()).join(' ');
const lines=manifest.startup.split('\n'),marker=lines.findIndex(l=>l.includes('CTMMAXIMA-READY|'));assert.ok(marker>=0);lines.splice(marker,0,':lisp '+helper);manifest.startup=lines.join('\n');
await writeFile(join(stage,'probe-sources.json'),JSON.stringify(manifest));
await cp('runtime/timing/validation-probe/worker.js',join(stage,'probe-worker.js'));await writeFile(join(stage,'probe.html'),'<!doctype html><title>Diagnostic condition boundary and validation stress</title>');
const browserBytes=await readFile('input/test-results/milestone-three/browser.json'),failed=JSON.parse(browserBytes);
const events=failed.observation.events.filter(e=>e.data?.event==='native-evaluate');
const history=events.map((e,i)=>({operation:e.data.operation,expression:e.data.expression,pauseMs:i?Math.max(0,e.receivedAt-events[i-1].receivedAt):0}));
assert.ok(history.at(-1).expression.includes('[1,1]'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const report={diagnosticOnly:true,acceptance:false,runtimeBuildRun:40169665328,benchmarkHead:process.env.GITHUB_SHA,failedBrowserSha256:hash(browserBytes),helperSha256:hash(helper),runtimeAssets:manifest.runtimeAssets,pacing:'Original inter-result gaps inserted as idle delays; intentionally over-delays by original CAS duration.',samples:[]};
const app=await serveDemo({root:stage,compression:'gzip',sidecarSource:null});let browser;
try{
 browser=await chromium.launch({headless:true});
 for(const experiment of (process.env.CTM_VALIDATION_PROBE_EXPERIMENTS || 'hook-control,repeated-target,forced-gc').split(',')){
  const page=await browser.newPage();await page.goto(app.baseURL+'probe.html');
  const result=await page.evaluate(data=>new Promise(resolve=>{const worker=new Worker('probe-worker.js');const timer=setTimeout(()=>{worker.terminate();resolve({error:'600-second watchdog'})},600000);worker.onerror=e=>{clearTimeout(timer);worker.terminate();resolve({error:e.message})};worker.onmessage=({data})=>{clearTimeout(timer);worker.terminate();resolve(data)};worker.postMessage(data)}),{experiment,history,snapshotLisp});
  report.samples.push(result);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({experiment,ok:result.ok,error:result.error,failureIndex:result.failureIndex,trace:result.trace,hook:result.injected?.[1]?.slice(0,500)}));await page.close();
 }
}finally{await browser?.close();await app.close();}
assert.equal(report.samples[0].ok,true,'The diagnostic hook must capture an actual injected CAR(SUBR) fault and preserve subsequent arithmetic');
