// SPDX-License-Identifier: AGPL-3.0-or-later
// Instrument a diagnostic copy; never substitute it for the real reset gate.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function resetStatements(source){
  assert.equal(createHash('sha256').update(source).digest('hex'),'7dce85b0c4949944e1963e87b07310356ef93b93d99c1f318f1db1df3cc8d359');
  const start='stack_reset(not_used) := block(\n';
  assert.equal(source.split(start).length,2);
  const body=source.slice(source.indexOf(start)+start.length).split('\n)$\n')[0];
  const statements=[];let first=0,depth=0,comment=false,string=false;
  for(let i=0;i<body.length;i++){
    const c=body[i],next=body[i+1];
    if(comment){if(c==='*'&&next==='/'){comment=false;i++;}continue;}
    if(string){if(c==='\\'){i++;continue;}if(c==='"')string=false;continue;}
    if(c==='/'&&next==='*'){comment=true;i++;continue;}
    if(c==='"'){string=true;continue;}
    if(c==='('||c==='[')depth++;
    if(c===')'||c===']')depth--;
    assert.ok(depth>=0);
    if(c===','&&depth===0){statements.push(body.slice(first,i));first=i+1;}
  }
  assert.equal(depth,0);assert.equal(comment,false);assert.equal(string,false);
  statements.push(body.slice(first));
  assert.equal(statements.join(','),body);
  assert.equal(statements[1].trim(),'kill(allbut [functions])');
  assert.equal(statements.at(-1).trim(),'true');
  return statements;
}

export const worker=`importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{let session;const report={phase:'initializing'};try{
  session=new MaximaSession({baseURL:'./maxima-runtime/',stackSourceURL:'./'+data.manifest});
  report.initialization=await session.init();
  if(data.afterGrade){report.phase='initial-grade';report.grade=session.assess({test:'AlgEquiv',student:'(x+1)^2',teacher:'x^2+2*x+1'});}
  report.phase='sentinel';report.sentinel=session.evaluate('ctm_reset_sentinel:123456');
  if(report.sentinel!==123456)throw new Error('Sentinel assignment failed');
  // Raw Lisp marker storage is outside the Maxima values/props lists that kill
  // clears. The unchanged original function remains available and untouched.
  session.write(':lisp (defparameter maxima::*ctm_reset_steps* nil)\\n'+
    ':lisp (defun maxima::$ctm_reset_mark (n) (push n maxima::*ctm_reset_steps*) n)\\n'+
    ':lisp (defun maxima::$ctm_reset_markers () (cons (quote (maxima::mlist)) (reverse maxima::*ctm_reset_steps*)))\\n',60000);
  if(data.copy)session.write(data.copy+'\\n',60000);
  report.phase='reset';
  session.write('ctm_isolation_result:false$\\nctm_isolation_result:errcatch('+data.call+'(true))$\\n',60000);
  report.observation=session.evaluate("[ctm_isolation_result,is(ctm_reset_sentinel='ctm_reset_sentinel),ctm_reset_markers(),if ctm_isolation_result=[] then errormsgtostring() else false]");
  report.phase='complete';report.ok=true;
}catch(error){report.ok=false;report.error=String(error);report.stack=error.stack;}
finally{session?.terminate();self.postMessage(report);}};`;

async function main(){
  const {chromium}=await import('playwright');
  const {serveDemo}=await import('../../scripts/milestone-two/serve.mjs');
  const site=resolve(process.env.PRECOMPILED_SITE||'.cache/precompiled-browser/site');
  const output=resolve('test-results/precompiled-browser/reset-isolation.json');
  await mkdir(resolve(output,'..'),{recursive:true});
  const manifest=JSON.parse(await readFile(join(site,'stack-sources-timed-source.json'),'utf8'));
  const source=manifest.files.find(f=>f.path==='stack/maxima/stackmaxima.mac').content;
  const statements=resetStatements(source);
  const marked=statements.flatMap((statement,i)=>['ctm_reset_mark('+2*i+')',statement,'ctm_reset_mark('+(2*i+1)+')']).join(',');
  const copy='ctm_diagnostic_reset(not_used):=block('+marked+',true)$';
  const report={schema:1,diagnosticOnly:true,sourceRevision:process.env.GITHUB_SHA||null,
    scope:'Fresh sessions isolate original reset before grading and a hash-bound marked copy before/after grading. Copy results never satisfy real reset or parity gates.',
    provenance:JSON.parse(await readFile(process.env.PRECOMPILED_DIAGNOSTIC_PROVENANCE,'utf8')),
    statements:statements.map((text,i)=>({text,before:2*i,after:2*i+1})),samples:[]};
  assert.equal(report.provenance.diagnosticOnly,true);
  await writeFile(join(site,'reset-isolation.html'),'<!doctype html><title>Reset isolation diagnostic</title>');
  await writeFile(join(site,'reset-isolation-worker.js'),worker);
  const app=await serveDemo({root:site,compression:'gzip'});
  try{
    for(const candidate of ['source','precompiled'])for(const experiment of ['original-before-grade','copy-before-grade','copy-after-grade']){
      const browser=await chromium.launch({headless:true});
      try{
        const page=await browser.newPage();await page.goto(app.baseURL+'reset-isolation.html');
        const data={manifest:candidate==='source'?'stack-sources-timed-source.json':'stack-sources-precompiled.json',
          afterGrade:experiment==='copy-after-grade',copy:experiment.startsWith('copy-')?copy:null,
          call:experiment.startsWith('copy-')?'ctm_diagnostic_reset':'stack_reset'};
        const result=await page.evaluate(data=>new Promise(resolveResult=>{
          const instance=new Worker('reset-isolation-worker.js');
          const timer=setTimeout(()=>{instance.terminate();resolveResult({ok:false,error:'Diagnostic watchdog expired'});},300000);
          instance.onmessage=({data})=>{clearTimeout(timer);instance.terminate();resolveResult(data);};
          instance.onerror=error=>{clearTimeout(timer);instance.terminate();resolveResult({ok:false,error:error.message});};
          instance.postMessage(data);
        }),data);
        report.samples.push({candidate,experiment,...result});
        console.log(JSON.stringify({candidate,experiment,...result}));
        await writeFile(output,JSON.stringify(report,null,2)+'\n');
      }finally{await browser.close();}
    }
  }finally{await app.close();await writeFile(output,JSON.stringify(report,null,2)+'\n');}
  // This file is evidence collection, not an acceptance test. A zero exit code
  // means the collector finished; report carries no passed/parity claim.
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
