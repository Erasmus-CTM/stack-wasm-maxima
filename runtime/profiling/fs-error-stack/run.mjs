// Explicit diagnostic A/B JavaScript derivation; original admitted Wasm/FAS stay unchanged.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,cp,stat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {deriveStartupObserver} from './derive-startup-observer.mjs';
import {pathToFileURL} from 'node:url';
export const arms=['control','errno-stack-suppressed'];
export const hash=body=>createHash('sha256').update(body).digest('hex');
const record=(path,body)=>({path,bytes:body.length,sha256:hash(body)});
const oldSource={runId:40108653819,runAttempt:1,head:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',testedRevision:'5295b5a79bfb983f9e43dd911e6f8ab65139a930',tree:'0e543f936a385548a7ffd53d68930bd88c033922',trustedRevision:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',recipeFiles:71};
export function validateAdmission(admission,arm,manifest){
  assert.equal(admission.schema,1);assert.equal(admission.passed,true,'Passed artifact admission required');
  assert.equal(admission.diagnosticOnly,true);assert.equal(admission.acceptance,false);
  assert.deepEqual(Object.keys(admission.arms).sort(),[...arms].sort(),'Exact two arms required');
  const row=admission.arms[arm];assert.ok(row);
  for(const [key,value] of Object.entries(oldSource))assert.deepEqual(admission.source[key],value,'Wrong source '+key);
  assert.equal(admission.compilerProfile.name,'ecl-oz');assert.deepEqual(manifest.runtimeBuild.compilerProfile,admission.compilerProfile,'Compiler profile changed');
  assert.equal(admission.artifact.id,12568085269);assert.equal(admission.artifact.workflow_run.id,oldSource.runId);assert.equal(admission.artifact.workflow_run.head_sha,oldSource.head);
  assert.equal(admission.artifact.name,'precompiled-stack-probe-ecl-oz-'+oldSource.testedRevision);
  assert.equal(admission.artifact.digest,'sha256:890a9c1c6c96d915ada2c41bf85e8b3756132ea2f42d6c5d4c6d9a9357c6759d');assert.equal(admission.artifact.size_in_bytes,213921626);
  assert.deepEqual(manifest.runtimeBuild,row.runtimeBuild,'Wrong original/derived runtime identity');
  assert.equal(row.runtimeBuild.manifestSha256,row.runtimeManifest.sha256);
  if(arm==='control'){
    assert.equal(row.kind,'accepted-original-runtime-with-observer');assert.equal(row.runtimeBuild.kind,'ctm-owned-build');assert.deepEqual(row.runtimeManifest,admission.originalPackageManifest);
  }else{
    assert.equal(row.kind,'derived-diagnostic-with-observer');assert.equal(row.runtimeBuild.kind,'ctm-derived-diagnostic');
    assert.deepEqual(row.runtimeBuild.originalBuild,admission.arms.control.runtimeBuild);assert.notEqual(row.runtimeManifest.sha256,admission.originalPackageManifest.sha256);
    assert.equal(admission.derivation.acceptedUnchangedRuntime,false);assert.equal(admission.derivation.kind,'derived-diagnostic-javascript');
  }
  const assets=rows=>rows.map(r=>({path:r.path,bytes:r.bytes??r.fileBytes,sha256:r.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  assert.equal(row.runtimeAssets.length,79);assert.equal(new Set(row.runtimeAssets.map(r=>r.path)).size,79);
  assert.deepEqual(assets(manifest.runtimeAssets),assets(row.runtimeAssets),'Runtime asset closure differs');
  assert.equal(manifest.files.length,77);assert.equal(new Set(manifest.files.map(r=>r.path)).size,77);
  assert.equal(admission.nativePrograms.length,3);assert.deepEqual(admission.nativePrograms.map(r=>r.operation),['prepare','validate','prt']);
  return row;
}
export function trialPlan(repetitions){
  assert.ok(Number.isSafeInteger(repetitions)&&repetitions>=3&&repetitions<=10,'At least three repetitions required');
  const pairs=[];
  for(let repetition=1;repetition<=repetitions;repetition++){
    const offset=(repetition-1)%arms.length,order=[...arms.slice(offset),...arms.slice(0,offset)];
    for(const arm of order)for(const candidate of (repetition+arms.indexOf(arm))%2?['source','precompiled']:['precompiled','source'])pairs.push({pair:pairs.length+1,repetition,arm,candidate,modes:['cold','warm-profile-reload']});
  }
  return pairs;
}
export const isKnownSyscallWarning=text=>/^warning: unsupported syscall: __syscall_(?:prlimit64|getrusage)\s*$/.test(text);
export const isFatalConsole=(type,text)=>(type==='error'&&!isKnownSyscallWarning(text))||/RuntimeError|Unexpected mark stack overflow|\bAborted\(|memory access out of bounds|unreachable executed|out of memory/i.test(text);
const median=values=>{const rows=values.filter(Number.isFinite).sort((a,b)=>a-b);return rows.length?(rows[Math.floor((rows.length-1)/2)]+rows[Math.ceil((rows.length-1)/2)])/2:null;};
export function compactResult(result){
  if(!result?.ok)return null;
  return {readyMs:result.readyMs,stackLoadMs:result.initialization.stages.stackLoadMs,
    wasmReadyMs:result.initialization.stages.wasmReadyMs,firstLogicalMs:result.checks[0].elapsedMs,
    firstPositiveGradeMs:result.firstPositiveGrade.elapsedMs,firstNegativeGradeMs:result.firstNegativeGrade.elapsedMs,
    warmGradeMedianMs:median(result.warmGrades.map(r=>r.elapsedMs)),warmArithmeticMedianMs:median(result.warmCalls.map(r=>r.elapsedMs)),
    readyPlusFirstLogicalAndFirstPositiveMs:result.readyMs+result.checks[0].elapsedMs+result.firstPositiveGrade.elapsedMs};
}
export function summarize(samples){
  const rows=[];for(const arm of arms)for(const candidate of ['source','precompiled'])for(const mode of ['cold','warm-profile-reload']){
    const matches=samples.filter(s=>s.arm===arm&&s.candidate===candidate&&s.mode===mode&&s.ok),eligible=matches.filter(s=>s.experiment?.comparisonEligible),keys=Object.keys(eligible[0]?.timings||{});
    rows.push({arm,candidate,mode,successfulCorrectnessTrials:matches.length,comparisonEligibleTrials:eligible.length,capabilityStatuses:matches.map(s=>s.experiment?.status||'missing'),medians:Object.fromEntries(keys.map(k=>[k,median(eligible.map(s=>s.timings[k]))]))});
  }return rows;
}
export function pairedComparisons(samples){
  const pairs=[];for(const changed of samples.filter(r=>r.arm==='errno-stack-suppressed'&&r.ok&&r.experiment?.comparisonEligible)){
    const control=samples.find(r=>r.arm==='control'&&r.ok&&r.experiment?.comparisonEligible&&r.candidate===changed.candidate&&r.mode===changed.mode&&r.repetition===changed.repetition);
    if(control)pairs.push({candidate:changed.candidate,mode:changed.mode,repetition:changed.repetition,control:control.id,experiment:changed.id,
      experimentalMinusControlMs:Object.fromEntries(Object.keys(changed.timings).map(k=>[k,changed.timings[k]-control.timings[k]]))});
  }return pairs;
}
export function assertManifestDelta(original,changed,runtimeBuild,asset){
  const expected=structuredClone(original);expected.runtimeBuild=runtimeBuild;
  assert.equal(expected.runtimeAssets.filter(r=>r.path==='maxima.js').length,1);
  expected.runtimeAssets=expected.runtimeAssets.map(r=>r.path==='maxima.js'?{...r,fileBytes:asset.bytes,sha256:asset.sha256}:r);
  assert.deepEqual(changed,expected,'Manifest changed beyond runtime identity/maxima.js metadata');
}
async function verifyArmDelta(root,admission){
  const names=admission.arms.control.stagedFiles.map(r=>r.path),exceptional=new Set(['maxima-runtime/maxima.js','stack-sources.json','stack-sources-timed-source.json','stack-sources-precompiled.json']);
  assert.deepEqual([...names].sort(),admission.arms['errno-stack-suppressed'].stagedFiles.map(r=>r.path).sort());
  for(const name of names){if(exceptional.has(name))continue;assert.deepEqual(await readFile(join(root,'control/site',name)),await readFile(join(root,'errno-stack-suppressed/site',name)),'Unexpected cross-arm byte change: '+name);}
  const original=await readFile(join(root,'control/site/maxima-runtime/maxima.js')),derived=await readFile(join(root,'errno-stack-suppressed/site/maxima-runtime/maxima.js'));
  assert.deepEqual(admission.derivation.original,{bytes:1239434,sha256:'385763ca1038fac02e8f7d247a8d808997238b03ba1919ce2f4dcec482fdb101'});
  assert.deepEqual({bytes:original.length,sha256:hash(original)},admission.derivation.original);assert.deepEqual({bytes:derived.length,sha256:hash(derived)},admission.derivation.derived);assert.notDeepEqual(original,derived);
  for(const name of [...exceptional].filter(r=>r.endsWith('.json'))){const a=JSON.parse(await readFile(join(root,'control/site',name))),b=JSON.parse(await readFile(join(root,'errno-stack-suppressed/site',name)));assertManifestDelta(a,b,admission.arms['errno-stack-suppressed'].runtimeBuild,admission.derivation.derived);}
  return {identicalFiles:83,changedRuntimeAssets:['maxima.js'],changedManifestFields:['runtimeBuild','runtimeAssets[maxima.js].fileBytes','runtimeAssets[maxima.js].sha256'],fasPreloadEmbeddedSourcesAndStartupUnchanged:true};
}
async function stageSite({site,output,root,admission,arm}){
  assert.notEqual(resolve(site),resolve(output));try{await stat(output);throw Error('Refusing to replace staged site');}catch(error){if(error.code!=='ENOENT')throw error;}
  const actual=[];async function walk(relative=''){for(const entry of await readdir(join(site,relative),{withFileTypes:true})){const path=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())await walk(path);else{assert.equal(entry.isFile(),true,'Nonregular site entry');actual.push(path);}}}await walk();
  const accepted=admission.arms[arm];assert.equal(accepted.stagedFiles.length,87);assert.equal(new Set(accepted.stagedFiles.map(r=>r.path)).size,87);
  assert.deepEqual(actual.sort(),accepted.stagedFiles.map(r=>r.path).sort(),'Staged file set differs from admission');
  for(const row of accepted.stagedFiles){assert.ok(resolve(site,row.path).startsWith(resolve(site)+'/'),'Unsafe admitted file path');const body=await readFile(join(site,row.path));assert.equal(body.length,row.bytes);assert.equal(hash(body),row.sha256,'Staged file bytes changed: '+row.path);}
  const originalChild=await readFile(join(root,'prototype/runtime/maxima-child.js')),expectedChild=deriveStartupObserver(originalChild);
  assert.deepEqual(await readFile(join(site,'runtime/maxima-child.js')),expectedChild.derived,'Shared guarded child derivation changed');
  assert.deepEqual(admission.observer.original,expectedChild.proof.original);assert.deepEqual(admission.observer.derived,expectedChild.proof.derived);
  assert.deepEqual(await readFile(join(site,'runtime/maxima-session.js')),await readFile(join(root,'prototype/runtime/maxima-session.js')),'Original session wrapper changed');
  const manifests={},identities={};
  for(const candidate of ['source','precompiled']){
    const name=candidate==='source'?'stack-sources-timed-source.json':'stack-sources-precompiled.json',body=await readFile(join(site,name)),manifest=JSON.parse(body);
    validateAdmission(admission,arm,manifest);assert.ok(manifest.startup.includes('CTMSTACK-LOAD-BEGIN')&&manifest.startup.includes('CTMSTACK-LOAD-END'));
    for(const row of manifest.files){const bytes=Buffer.from(row.content);assert.equal(bytes.length,row.bytes);assert.equal(hash(bytes),row.sha256);}
    if(candidate==='source')assert.equal(manifest.compiledStack,undefined);else{const file=manifest.compiledStack.asset,bytes=await readFile(join(site,'maxima-runtime',file.path));assert.equal(bytes.length,file.fileBytes);assert.equal(hash(bytes),file.sha256);}
    const preload=await readFile(join(site,'maxima-runtime',manifest.preload.path));assert.equal(preload.length,manifest.preload.fileBytes);assert.equal(hash(preload),manifest.preload.sha256);
    manifests[candidate]={name,expected:{stackRevision:manifest.stackRevision,stackLibraryVersion:manifest.stackLibraryVersion,maximaVersion:manifest.runtimeBuild.sourcePins.sources.find(r=>r.name==='maxima').version,compiledStack:manifest.compiledStack||null}};
    identities[candidate]={...record(name,body),stackRevision:manifest.stackRevision,stackLibraryVersion:manifest.stackLibraryVersion,compiledStack:manifest.compiledStack||null};
  }
  await mkdir(resolve(output,'..'),{recursive:true});await cp(site,output,{recursive:true,errorOnExist:true,force:false});
  await writeFile(join(output,'clean-timing.html'),'<!doctype html><meta charset="utf-8"><title>Clean STACK runtime comparison</title>');
  const worker=await readFile(new URL('./clean-probe-worker.js',import.meta.url));await writeFile(join(output,'clean-probe-worker.js'),worker);
  return {site:output,manifests,proof:{arm,kind:accepted.kind,source:admission.source,artifact:admission.artifact,originalPackageManifest:admission.originalPackageManifest,runtimeManifest:accepted.runtimeManifest,compilerProfile:admission.compilerProfile,manifestFiles:identities,stagedFilesVerified:87,runtimeAssetsVerified:79,embeddedStackFilesPerManifest:77,worker:record('clean-probe-worker.js',worker),acceptedUnchangedRuntimeAssets:arm==='control',diagnosticRuntimeAssetsModified:arm!=='control',originalChildUnchanged:false,sharedStartupObserver:admission.observer}};
}
export function runPageMeasurement(input){
  return new Promise(resolveTrial=>{
    if(window.ctmCleanWorker){resolveTrial({ok:false,error:'Prior worker has not been terminated'});return;}
    const worker=window.ctmCleanWorker=new Worker('clean-probe-worker.js');window.ctmCleanRunId=input.runId;let latest={runId:input.runId,phase:'worker-start'},finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);resolveTrial(value);};
    const timer=setTimeout(()=>finish({...latest,ok:false,error:'300-second clean measurement watchdog expired'}),300000);
    worker.onmessage=({data})=>{if(data.progress?.runId!==input.runId){finish({...latest,ok:false,error:'Worker measurement token changed'});return;}if(data.type==='progress'){latest=data.progress;void window.ctmCleanProgress(latest);}else if(data.type==='complete')finish(data.progress);};
    worker.onerror=error=>finish({...latest,ok:false,error:error.message});worker.postMessage(input);
  });
}
export function stopPageWorker(runId){
  return new Promise(resolveStop=>{
    const worker=window.ctmCleanWorker;if(!worker){resolveStop({ok:false,error:'No worker to terminate'});return;}
    const finish=value=>{clearTimeout(timer);worker.terminate();delete window.ctmCleanWorker;delete window.ctmCleanRunId;resolveStop(value);};
    const timer=setTimeout(()=>finish({ok:false,error:'Worker termination acknowledgment missing'}),5000);
    worker.onmessage=({data})=>{if(data.type==='stopped')finish({...data,ok:data.runId===runId&&data.stopped===true&&data.rejected===true});};
    worker.onerror=error=>finish({ok:false,error:error.message});worker.postMessage({type:'stop',runId});
  });
}
async function main(){
  const args={};for(let i=2;i<process.argv.length;i+=2){assert.ok(process.argv[i]?.startsWith('--')&&process.argv[i+1]);args[process.argv[i]]=process.argv[i+1];}
  for(const key of ['--trusted-root','--arms-root','--admission','--output'])assert.ok(args[key],key+' required');
  const trustedRoot=resolve(args['--trusted-root']),armsRoot=resolve(args['--arms-root']),output=resolve(args['--output']),repetitions=Number(args['--repetitions']||3),plan=trialPlan(repetitions);
  await mkdir(output,{recursive:true});const report={schema:1,diagnosticOnly:true,acceptance:false,passed:false,startedAt:new Date().toISOString(),runtimeProfile:'ecl-oz',repetitions,plan,plannedMeasurements:plan.length*2,watchdogMs:300000,staging:{},samples:[],skipped:[],scope:'Diagnostic A/B comparison of original Oz JavaScript versus an explicit errno44/54 stack-capture derivation, with the same original Wasm/modules/source/FAS/preload. Fresh browser/profile per pair followed by same-page/context reload and new workers. Both arms use one identical explicitly derived stdout-only child guard; startup commands/session/runtime bytes otherwise stay admitted (except experimental maxima.js). This is guarded timing, not pristine wrapper timing. Guard parsing/one bounded receipt add shared overhead and do not prove a same-evaluation root-load return. No TRACE, Worker replacement or CPU profiler; the experimental constructor emits one capability receipt. Its own checks/reporting costs are part of the intervention. Unsupported, missing or untreated receipts cannot establish a suppression effect. Alternating order limits but does not remove runner/cache variation; n3 medians are descriptive. No production acceptance, rebuild, default promotion or assumed speedup. Combined readiness/logical/positive is a synthetic sum, not complete UI latency.'};
  const save=async()=>{report.summary=summarize(report.samples);report.pairedComparisons=pairedComparisons(report.samples);await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');};await save();
  try{
    const body=await readFile(resolve(args['--admission'])),admission=JSON.parse(body);assert.equal(admission.passed,true);
    for(const key of ['GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REF']){assert.ok(process.env[key]);assert.equal(admission.benchmark[key],process.env[key],'Benchmark identity changed: '+key);}
    report.benchmark=admission.benchmark;report.admission=record(resolve(args['--admission']),body);
    for(const [root,expected] of [[trustedRoot,oldSource]]){
      const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();assert.equal(git('rev-parse','HEAD'),expected.trustedRevision);assert.equal(git('rev-parse','HEAD^{tree}'),expected.tree);assert.equal(git('status','--porcelain','--untracked-files=no'),'');
    }
    report.sharedTrustedFiles=[];
    for(const path of ['prototype/runtime/maxima-child.js','prototype/runtime/maxima-session.js','runtime/precompiled/restart-checks.json','scripts/milestone-two/serve.mjs','runtime/compression/server-source.mjs']){const a=await readFile(join(trustedRoot,path));report.sharedTrustedFiles.push(record(path,a));}
    const checks=JSON.parse(await readFile(join(trustedRoot,'runtime/precompiled/restart-checks.json'))).checks;assert.equal(checks.length,10);assert.equal(checks[0].name,'first-call-logical-validation');
    report.nativeWorkload={sha256:hash(JSON.stringify(admission.nativePrograms)),operations:admission.nativePrograms.map(r=>r.operation),capture:admission.nativeCapture};
    const proofBody=await readFile(join(dirname(resolve(args['--admission'])),'derivation.json'));assert.deepEqual(JSON.parse(proofBody),admission.derivation);assert.equal(hash(proofBody),admission.arms['errno-stack-suppressed'].runtimeBuild.derivationSha256);report.derivation=record('derivation.json',proofBody);
    const runtimeManifestBody=await readFile(join(dirname(resolve(args['--admission'])),'derived-runtime-manifest.json'));assert.deepEqual({bytes:runtimeManifestBody.length,sha256:hash(runtimeManifestBody)},admission.arms['errno-stack-suppressed'].runtimeManifest);report.derivedRuntimeManifest=record('derived-runtime-manifest.json',runtimeManifestBody);
    const observerBody=await readFile(join(dirname(resolve(args['--admission'])),'startup-observer-derivation.json'));
    const observerProof=JSON.parse(observerBody),expectedObserver=deriveStartupObserver(await readFile(join(trustedRoot,'prototype/runtime/maxima-child.js'))).proof;assert.deepEqual(observerProof,expectedObserver);assert.deepEqual({bytes:observerBody.length,sha256:hash(observerBody)},admission.observer.proof);report.startupObserver=record('startup-observer-derivation.json',observerBody);
    report.crossArmVerification=await verifyArmDelta(armsRoot,admission);
    const staged={};for(const arm of arms){staged[arm]=await stageSite({site:join(armsRoot,arm,'site'),output:join(output,'staged',arm),root:trustedRoot,admission,arm});report.staging[arm]=staged[arm].proof;await save();}
    const {chromium}=await import('playwright'),{serveDemo}=await import(pathToFileURL(join(trustedRoot,'scripts/milestone-two/serve.mjs')));
    for(const pair of plan){
      let app,browser,page,priorStopped=false;
      try{
        app=await serveDemo({root:staged[pair.arm].site,compression:'gzip',sidecarSource:null});browser=await chromium.launch({headless:true});page=await browser.newPage();report.browser=browser.version();
        let activeRow,writeQueue=Promise.resolve();await page.exposeFunction('ctmCleanProgress',value=>{if(!activeRow)return;const path=activeRow.partialPath;writeQueue=writeQueue.then(()=>writeFile(path,JSON.stringify(value,null,2)+'\n'));});
        page.on('console',message=>{if(!activeRow)return;const text=message.text(),type=message.type(),key=type+':'+text.slice(0,2000);if(Object.keys(activeRow.consoleCounts).length<1000||key in activeRow.consoleCounts)activeRow.consoleCounts[key]=(activeRow.consoleCounts[key]||0)+1;else activeRow.consoleOverflow=(activeRow.consoleOverflow||0)+1;if(isFatalConsole(type,text)){activeRow.fatalConsoleCount++;if(activeRow.fatalConsoleSamples.length<20)activeRow.fatalConsoleSamples.push({type,text:text.slice(0,2000)});}});
        page.on('pageerror',error=>{if(activeRow)activeRow.pageErrors.push(String(error));});
        for(const mode of pair.modes){
          const id=String(pair.pair).padStart(2,'0')+'-'+pair.arm+'-'+pair.candidate+'-'+mode,directory=join(output,'trials',id);await mkdir(directory,{recursive:true});
          const row=activeRow={id,...pair,mode,runId:randomUUID(),startedAt:new Date().toISOString(),ok:false,consoleCounts:{},fatalConsoleCount:0,fatalConsoleSamples:[],pageErrors:[],partialPath:join(directory,'partial.json')};
          report.samples.push({id,arm:pair.arm,candidate:pair.candidate,repetition:pair.repetition,mode,pair:pair.pair,ok:false,phase:'started',samplePath:'trials/'+id+'/sample.json'});await save();await writeFile(row.partialPath,JSON.stringify({phase:'before-navigation',runId:row.runId})+'\n');
          const requestStart=app.requests.length;
          try{
            if(mode==='cold')await page.goto(app.baseURL+'clean-timing.html');else{assert.equal(priorStopped,true,'Cannot reload without confirmed prior termination');await page.reload();}
            const m=staged[pair.arm].manifests[pair.candidate];row.result=await page.evaluate(runPageMeasurement,{runId:row.runId,arm:pair.arm,candidate:pair.candidate,manifest:m.name,expected:m.expected,checks,nativePrograms:admission.nativePrograms});await writeQueue;
            row.ok=row.result.ok===true&&row.result.correctnessPassed===true&&row.result.startupGuard?.passed===true;row.termination=await page.evaluate(stopPageWorker,row.runId);priorStopped=row.termination.ok===true;row.ok&&=priorStopped;
            row.requests=app.requests.slice(requestStart);assert.ok(!row.requests.some(r=>r.status>=400||/maxima-plot\.fas|libgnuplot\.so/.test(r.pathname||'')),'Unexpected runtime request failure or plotting asset');assert.equal(row.pageErrors.length,0,'Page error observed');assert.equal(row.fatalConsoleCount,0,'Fatal/unexpected console error observed');
          }catch(error){row.error=String(error);row.ok=false;priorStopped=false;}
          finally{
            await writeQueue;row.requests=app.requests.slice(requestStart);row.finishedAt=new Date().toISOString();delete row.partialPath;await writeFile(join(directory,'sample.json'),JSON.stringify(row,null,2)+'\n');
            Object.assign(report.samples.at(-1),{ok:row.ok,phase:'finished',runId:row.runId,timings:compactResult(row.result),experiment:row.result?.experiment||null,startupGuardPassed:row.result?.startupGuard?.passed===true,error:row.error||row.result?.error||(!priorStopped?'Worker termination guard failed':null),termination:row.termination||null,warningCount:Object.entries(row.consoleCounts).filter(([k])=>k.startsWith('warning:')||isKnownSyscallWarning(k.slice(k.indexOf(':')+1))).reduce((sum,[,n])=>sum+n,0),fatalConsoleCount:row.fatalConsoleCount});activeRow=null;await save();
          }
          if(!priorStopped&&mode==='cold'){report.skipped.push({...pair,mode:'warm-profile-reload',reason:'Cold measurement did not confirm old worker termination'});break;}
        }
      }catch(error){report.pairFailures??=[];report.pairFailures.push({...pair,error:String(error)});}
      finally{if(browser)await browser.close().catch(()=>{});if(app)await app.close();await save();}
    }
    report.correctnessComplete=report.samples.length===report.plannedMeasurements&&report.samples.every(s=>s.ok)&&!report.skipped.length&&!report.pairFailures?.length;
    report.suppressionComparisonEligible=report.correctnessComplete&&report.samples.every(s=>s.experiment?.comparisonEligible===true);
    report.passed=report.correctnessComplete&&report.suppressionComparisonEligible;
  }catch(error){report.failure=String(error);}
  finally{report.finishedAt=new Date().toISOString();await save();}
  if(!report.passed)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
