// Diagnostic only: replay the failed source controller's exact CAS evaluation order.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
const hash=b=>createHash('sha256').update(b).digest('hex');
const root=resolve('.'),work=join(root,'.cache/full-timing-table-guarded'),out=join(root,'replay-evidence');await mkdir(out,{recursive:true});
const failed=join(root,'failed-build'),browserBody=await readFile(join(failed,'test-results/milestone-three/browser.json')),browser=JSON.parse(browserBody);
const events=browser.observation.events.filter(e=>e.data?.event==='native-evaluate');assert.equal(new Set(events.map(e=>e.worker)).size,1);
const history=events.map((e,index)=>({pauseMs:index ? Math.max(0,e.receivedAt-events[index-1].receivedAt) : 0,operation:e.data.operation,question:e.data.question,expression:e.data.expression,recorded:e.data.result}));
assert.equal(history.at(-1).recorded.ans.valid,false);assert.ok(history.at(-1).expression.includes('[1,1]'));
const sources={old:join(work,'profiles/ecl-oz/site'),candidate:join(work,'profiles/ecl-oz-maxima-oz/site'),fresh:join(failed,'.cache/precompiled-stack/site')};
const {serveDemo}=await import(pathToFileURL(join(root,'old-trusted/scripts/milestone-two/serve.mjs')));
const report={diagnosticOnly:true,acceptance:false,pacing:'Observed source-failure inter-result gaps inserted as idle delays. Includes original CAS time, therefore intentionally over-delays instead of claiming exact timing replay.',failedBuildRun:40169665328,failedBrowser:{bytes:browserBody.length,sha256:hash(browserBody)},history,sourceRevision:process.env.GITHUB_SHA,samples:[]};
let commonFiles,commonStartup;
for(const [name,source] of Object.entries(sources)){
 const stage=join(out,'staged',name);await cp(source,stage,{recursive:true});
 const m=JSON.parse(await readFile(join(stage,'stack-sources-timed-source.json')));assert.equal(m.compiledStack,undefined);
 if(commonFiles){assert.deepEqual(m.files,commonFiles);assert.equal(m.startup,commonStartup);}else{commonFiles=m.files;commonStartup=m.startup;}
 for(const a of m.runtimeAssets){const b=await readFile(join(stage,'maxima-runtime',a.path));assert.equal(b.length,a.fileBytes);assert.equal(hash(b),a.sha256);}
 let child=(await readFile(join(stage,'runtime/maxima-child.js'))).toString();const anchor='    const ready =';assert.equal(child.split(anchor).length,2);
 child=child.replace(anchor,"    if (initialized && !line.startsWith('CTMMAXIMA|')) self.postMessage({type:'diagnostic',text:line});\n"+anchor);await writeFile(join(stage,'runtime/maxima-child.js'),child);
 await cp(join(root,'benchmark/runtime/timing/source-replay/worker.js'),join(stage,'replay-worker.js'));await writeFile(join(stage,'replay.html'),'<!doctype html><title>Diagnostic source history replay</title>');
}
for(let repetition=1;repetition<=3;repetition++)for(const name of (repetition%2?['old','candidate','fresh']:['fresh','candidate','old'])){
 let app,b;
 try{
  app=await serveDemo({root:join(out,'staged',name),compression:'gzip',sidecarSource:null});b=await chromium.launch({headless:true});const page=await b.newPage();await page.goto(app.baseURL+'replay.html');
  const result=await page.evaluate(history=>new Promise(resolve=>{const w=new Worker('replay-worker.js'),timer=setTimeout(()=>{w.terminate();resolve({ok:false,error:'300-second replay watchdog'})},300000);w.onmessage=({data})=>{if(data.complete){clearTimeout(timer);w.terminate();resolve(data)}};w.onerror=e=>{clearTimeout(timer);w.terminate();resolve({ok:false,error:e.message})};w.postMessage({history})}),history);
  report.samples.push({name,repetition,...result});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({name,repetition,ok:result.ok,error:result.error,target:result.target,repeatTargets:result.repeatTargets,errormsg:result.errormsg}));
 }finally{if(b)await b.close();if(app)await app.close();}
}
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
