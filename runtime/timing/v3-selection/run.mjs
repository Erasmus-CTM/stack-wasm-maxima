// Explicit guarded comparison of admitted runtimes; shared derived stdout-only child, no rebuilding.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,cp,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {deriveStartupObserver} from './derive-startup-observer.mjs';
import {pathToFileURL} from 'node:url';
export const profiles=['ecl-oz','ecl-oz-maxima-oz'];
export const hash=body=>createHash('sha256').update(body).digest('hex');
const record=(path,body)=>({path,bytes:body.length,sha256:hash(body)});
const oldSource={runId:40108653819,runAttempt:1,head:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',testedRevision:'5295b5a79bfb983f9e43dd911e6f8ab65139a930',tree:'0e543f936a385548a7ffd53d68930bd88c033922',trustedRevision:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',recipeFiles:71};
const binding=JSON.parse(await readFile(new URL('./candidate-binding.json',import.meta.url)));
const newSource=binding.source;
export function validateAdmission(admission,profile,manifest){
  assert.equal(binding.ready,true,'Reviewed accepted candidate binding required');
  assert.equal(admission.schema,1);assert.equal(admission.passed,true,'Passed artifact admission required');
  assert.deepEqual(Object.keys(admission.profiles).sort(),[...profiles].sort(),'Exact two source profiles required');
  const row=admission.profiles[profile],expected=profile==='ecl-oz-maxima-oz'?newSource:oldSource;assert.ok(row);
  for(const [key,value] of Object.entries(expected))assert.deepEqual(row.source[key],value,'Wrong source '+key);
  assert.equal(row.compilerProfile.name,profile);assert.deepEqual(manifest.runtimeBuild.compilerProfile,row.compilerProfile,'Compiler profile swapped');
  assert.equal(manifest.runtimeBuild.manifestSha256,row.packageManifest.sha256,'Package manifest swapped');
  assert.ok(Number.isSafeInteger(row.artifact.id)&&row.artifact.id>0);
  assert.equal(row.artifact.workflow_run.id,expected.runId);assert.equal(row.artifact.workflow_run.head_sha,expected.head);
  assert.equal(row.artifact.name,(profile==='ecl-oz-maxima-oz'?'owned-runtime-':'precompiled-stack-probe-')+profile+'-'+expected.testedRevision);
  assert.match(row.artifact.digest,/^sha256:[a-f0-9]{64}$/);assert.ok(row.artifact.size_in_bytes>0);
  const assets=rows=>rows.map(r=>({path:r.path,bytes:r.bytes??r.fileBytes,sha256:r.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  assert.equal(row.runtimeAssets.length,79);assert.equal(new Set(row.runtimeAssets.map(r=>r.path)).size,79);
  assert.deepEqual(assets(manifest.runtimeAssets),assets(row.runtimeAssets),'Runtime asset closure differs');
  assert.equal(manifest.files.length,77);assert.equal(new Set(manifest.files.map(r=>r.path)).size,77);
  assert.equal(admission.nativePrograms.length,3);assert.deepEqual(admission.nativePrograms.map(r=>r.operation),['prepare','validate','prt']);
  assert.deepEqual(row.benchmarkNativePrograms,admission.nativePrograms,'Native workload differs across sources');
  return row;
}
export function trialPlan(repetitions){
  assert.ok(Number.isSafeInteger(repetitions)&&repetitions>=3&&repetitions<=10,'At least three repetitions required');
  const pairs=[], selected=['ecl-oz','ecl-oz-maxima-oz'];
  for(let repetition=1;repetition<=repetitions;repetition++){
    const order=repetition%2?selected:[...selected].reverse();
    for(const profile of order)pairs.push({pair:pairs.length+1,repetition,profile,candidate:'source',modes:['cold','warm-profile-reload']});
  }
  return pairs;
}
export const isKnownSyscallWarning=text=>/^warning: unsupported syscall: __syscall_(?:prlimit64|getrusage)\s*$/.test(text);
export const isFatalConsole=(type,text)=>(type==='error'&&!isKnownSyscallWarning(text))||/RuntimeError|Unexpected mark stack overflow|\bAborted\(|memory access out of bounds|unreachable executed|out of memory/i.test(text);
export function recordConsoleEvent(target,type,text){
  if(!target)return;
  const key=type+':'+text.slice(0,2000);
  if(Object.keys(target.consoleCounts).length<1000||key in target.consoleCounts)target.consoleCounts[key]=(target.consoleCounts[key]||0)+1;else target.consoleOverflow=(target.consoleOverflow||0)+1;
  if(isFatalConsole(type,text)){target.fatalConsoleCount++;if(target.fatalConsoleSamples.length<20)target.fatalConsoleSamples.push({type,text:text.slice(0,2000)});}
}
export function createLateTelemetry(id){return {id,scope:'Events received after the immutable sample snapshot and before the next active sample or browser closure; retained separately, with any fatal/page error failing the overall matrix.',consoleCounts:{},fatalConsoleCount:0,fatalConsoleSamples:[],pageErrors:[]};}
export function snapshotMeasurement(row){
  const snapshot=structuredClone(row);delete snapshot.partialPath;
  snapshot.ok=snapshot.ok===true&&snapshot.fatalConsoleCount===0&&snapshot.pageErrors.length===0;
  return snapshot;
}
export const lateTelemetryFailed=rows=>rows.some(row=>row.fatalConsoleCount>0||row.pageErrors.length>0);
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
  const rows=[];for(const profile of profiles)for(const candidate of ['source'])for(const mode of ['cold','warm-profile-reload']){
    const matches=samples.filter(s=>s.profile===profile&&s.candidate===candidate&&s.mode===mode&&s.ok),keys=Object.keys(matches[0]?.timings||{});
    rows.push({profile,candidate,mode,successfulTrials:matches.length,reloadsFollowingFailedCold:matches.filter(row=>row.precedingCold?.passed===false).length,cacheQualification:mode==='warm-profile-reload'?'Same browser/profile reload; any failed preceding cold is explicitly counted and does not establish a fully initialized warm cache':null,medians:Object.fromEntries(keys.map(k=>[k,median(matches.map(s=>s.timings[k]))]))});
  }return rows;
}
async function stageSite({site,output,root,admission,profile}){
  assert.notEqual(resolve(site),resolve(output));try{await stat(output);throw Error('Refusing to replace staged site');}catch(error){if(error.code!=='ENOENT')throw error;}
  const actual=[];async function walk(relative=''){for(const entry of await readdir(join(site,relative),{withFileTypes:true})){const path=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())await walk(path);else{assert.equal(entry.isFile(),true,'Nonregular site entry');actual.push(path);}}}await walk();
  const accepted=admission.profiles[profile];assert.ok(accepted.stagedFiles.length>=82&&accepted.stagedFiles.length<500);assert.equal(new Set(accepted.stagedFiles.map(r=>r.path)).size,accepted.stagedFiles.length);
  assert.deepEqual(actual.sort(),accepted.stagedFiles.map(r=>r.path).sort(),'Staged file set differs from admission');
  for(const row of accepted.stagedFiles){assert.ok(resolve(site,row.path).startsWith(resolve(site)+'/'),'Unsafe admitted file path');const body=await readFile(join(site,row.path));assert.equal(body.length,row.bytes);assert.equal(hash(body),row.sha256,'Staged file bytes changed: '+row.path);}
  for(const name of ['maxima-child.js','maxima-session.js'])assert.deepEqual(await readFile(join(site,'runtime',name)),await readFile(join(root,'prototype/runtime',name)),'Original runtime wrapper changed');
  const manifests={},identities={};
  for(const candidate of ['source']){
    const name=candidate==='source'?'stack-sources-timed-source.json':'stack-sources-precompiled.json',body=await readFile(join(site,name)),manifest=JSON.parse(body);
    validateAdmission(admission,profile,manifest);assert.ok(manifest.startup.includes('CTMSTACK-LOAD-BEGIN')&&manifest.startup.includes('CTMSTACK-LOAD-END'));
    for(const row of manifest.files){const bytes=Buffer.from(row.content);assert.equal(bytes.length,row.bytes);assert.equal(hash(bytes),row.sha256);}
    if(candidate==='source')assert.equal(manifest.compiledStack,undefined);else{const file=manifest.compiledStack.asset,bytes=await readFile(join(site,'maxima-runtime',file.path));assert.equal(bytes.length,file.fileBytes);assert.equal(hash(bytes),file.sha256);}
    const preload=await readFile(join(site,'maxima-runtime',manifest.preload.path));assert.equal(preload.length,manifest.preload.fileBytes);assert.equal(hash(preload),manifest.preload.sha256);
    manifests[candidate]={name,expected:{stackRevision:manifest.stackRevision,stackLibraryVersion:manifest.stackLibraryVersion,maximaVersion:manifest.runtimeBuild.sourcePins.sources.find(r=>r.name==='maxima').version,compiledStack:manifest.compiledStack||null}};
    identities[candidate]={...record(name,body),stackRevision:manifest.stackRevision,stackLibraryVersion:manifest.stackLibraryVersion,compiledStack:manifest.compiledStack||null};
  }
  await mkdir(resolve(output,'..'),{recursive:true});await cp(site,output,{recursive:true,errorOnExist:true,force:false});
  const observer=deriveStartupObserver(await readFile(join(site,'runtime/maxima-child.js')));
  await writeFile(join(output,'runtime/maxima-child.js'),observer.derived);
  const observerProof=Buffer.from(JSON.stringify(observer.proof,null,2)+'\n');
  await writeFile(output+'-startup-observer-derivation.json',observerProof);
  await writeFile(join(output,'clean-timing.html'),'<!doctype html><meta charset="utf-8"><title>Guarded STACK runtime comparison</title>');
  const worker=await readFile(new URL('./clean-probe-worker.js',import.meta.url));await writeFile(join(output,'clean-probe-worker.js'),worker);
  return {site:output,manifests,proof:{source:accepted.source,artifact:accepted.artifact,packageManifest:accepted.packageManifest,compilerProfile:accepted.compilerProfile,manifestFiles:identities,originalFilesVerified:accepted.stagedFiles.length,runtimeAssetsVerified:79,embeddedStackFilesPerManifest:77,worker:record('clean-probe-worker.js',worker),originalRuntimeAssetsUnchanged:true,commonCurrentSourceIntegration:true,originalChildUnchanged:false,sharedStartupObserver:{...observer.proof,proof:record('staged/'+profile+'-startup-observer-derivation.json',observerProof)}}};
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
  for(const key of ['--old-trusted-root','--candidate-trusted-root','--profiles-root','--admission','--output'])assert.ok(args[key],key+' required');
  const oldRoot=resolve(args['--old-trusted-root']),candidateRoot=resolve(args['--candidate-trusted-root']),profilesRoot=resolve(args['--profiles-root']),output=resolve(args['--output']),repetitions=Number(args['--repetitions']||3),plan=trialPlan(repetitions);
  await mkdir(output,{recursive:true});const report={schema:1,diagnosticOnly:true,acceptance:false,passed:false,startedAt:new Date().toISOString(),repetitions,cpuLimit:process.env.CTM_TIMING_CPU_LIMIT||'unrestricted',plan,plannedMeasurements:plan.length*2,watchdogMs:300000,staging:{},samples:[],skipped:[],lateTelemetry:[],scope:'No-rebuild source STACK comparison of accepted ecl-oz and the flattened production candidate. Both use identical pinned source files, classifier startup, session/child wrappers and controlled programs. n10 per profile/mode/CPU condition, five AB and five BA orders. Fresh browser/profile per cold pair and new terminated/recreated workers for same-profile reload. Existing bounded stdout observer and load markers are identical in both arms. No CPU/FS profiling; no samples omitted. Source files and runtime assets are hashed before staging. Historical old artifact is a profile control, not a byte-identical published-v2 timing. No compiled STACK sample is timed in this run.'};
  const save=async()=>{report.summary=summarize(report.samples);report.lateTelemetryFailed=lateTelemetryFailed(report.lateTelemetry);if(report.lateTelemetryFailed)report.passed=false;await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');};await save();
  try{
    const body=await readFile(resolve(args['--admission'])),admission=JSON.parse(body);assert.equal(admission.passed,true);
    for(const key of ['GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REF']){assert.ok(process.env[key]);assert.equal(admission.benchmark[key],process.env[key],'Benchmark identity changed: '+key);}
    report.benchmark=admission.benchmark;report.admission=record(resolve(args['--admission']),body);
    for(const [root,expected] of [[oldRoot,oldSource],[candidateRoot,newSource]]){
      const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();assert.equal(git('rev-parse','HEAD'),expected.trustedRevision);assert.equal(git('rev-parse','HEAD^{tree}'),expected.tree);assert.equal(git('status','--porcelain','--untracked-files=no'),'');
    }
    report.sharedTrustedFiles=[];
    for(const path of ['prototype/runtime/maxima-child.js','prototype/runtime/maxima-session.js','runtime/precompiled/restart-checks.json','scripts/milestone-two/serve.mjs','runtime/compression/server-source.mjs']){const a=await readFile(join(oldRoot,path));assert.deepEqual(a,await readFile(join(candidateRoot,path)),'Common trusted input differs: '+path);report.sharedTrustedFiles.push(record(path,a));}
    const checks=JSON.parse(await readFile(join(oldRoot,'runtime/precompiled/restart-checks.json'))).checks;assert.equal(checks.length,10);assert.equal(checks[0].name,'first-call-logical-validation');
    report.nativeWorkload={sha256:hash(JSON.stringify(admission.nativePrograms)),operations:admission.nativePrograms.map(r=>r.operation),captures:Object.fromEntries(profiles.map(p=>[p,admission.profiles[p].benchmarkNativeCapture])),producerCaptures:Object.fromEntries(profiles.map(p=>[p,admission.profiles[p].nativeCapture]))};
    const staged={};for(const profile of profiles){staged[profile]=await stageSite({site:join(profilesRoot,profile,'site'),output:join(output,'staged',profile),root:profile==='ecl-oz-maxima-oz'?candidateRoot:oldRoot,admission,profile});report.staging[profile]=staged[profile].proof;await save();}
    assert.equal(new Set(Object.values(staged).map(row=>row.proof.sharedStartupObserver.derived.sha256)).size,1,'Shared observer differs across profiles');
    const {chromium}=await import('playwright'),{serveDemo}=await import(pathToFileURL(join(oldRoot,'scripts/milestone-two/serve.mjs')));
    for(const pair of plan){
      let app,browser,page,priorStopped=false,precedingCold=null;
      try{
        app=await serveDemo({root:staged[pair.profile].site,compression:'gzip',sidecarSource:null});browser=await chromium.launch({headless:true});page=await browser.newPage();report.browser=browser.version();
        let activeRow,lateRow,writeQueue=Promise.resolve();await page.exposeFunction('ctmCleanProgress',value=>{if(!activeRow)return;const path=activeRow.partialPath;writeQueue=writeQueue.then(()=>writeFile(path,JSON.stringify(value,null,2)+'\n'));});
        page.on('console',message=>recordConsoleEvent(activeRow||lateRow,message.type(),message.text()));
        page.on('pageerror',error=>{const target=activeRow||lateRow;if(target)target.pageErrors.push(String(error));});
        for(const mode of pair.modes){
          const id=String(pair.pair).padStart(2,'0')+'-'+pair.profile+'-'+pair.candidate+'-'+mode,directory=join(output,'trials',id);await mkdir(directory,{recursive:true});
          lateRow=null;const row=activeRow={id,...pair,mode,precedingCold:mode==='warm-profile-reload'?precedingCold:null,runId:randomUUID(),startedAt:new Date().toISOString(),ok:false,consoleCounts:{},fatalConsoleCount:0,fatalConsoleSamples:[],pageErrors:[],partialPath:join(directory,'partial.json')};
          report.samples.push({id,profile:pair.profile,candidate:pair.candidate,repetition:pair.repetition,mode,pair:pair.pair,ok:false,phase:'started',samplePath:'trials/'+id+'/sample.json'});await save();await writeFile(row.partialPath,JSON.stringify({phase:'before-navigation',runId:row.runId})+'\n');
          console.log('CTM-TIMING-TRIAL|'+JSON.stringify({id,phase:'started',profile:pair.profile,candidate:pair.candidate,mode}));
          const requestStart=app.requests.length;
          try{
            if(mode==='cold')await page.goto(app.baseURL+'clean-timing.html');else{assert.equal(priorStopped,true,'Cannot reload without confirmed prior termination');await page.reload();}
            const m=staged[pair.profile].manifests[pair.candidate];row.result=await page.evaluate(runPageMeasurement,{runId:row.runId,candidate:pair.candidate,manifest:m.name,expected:m.expected,checks,nativePrograms:admission.nativePrograms});await writeQueue;
            row.ok=row.result.ok===true&&row.result.correctnessPassed===true&&row.result.startupGuard?.passed===true;row.termination=await page.evaluate(stopPageWorker,row.runId);priorStopped=row.termination.ok===true;row.ok&&=priorStopped;
            row.requests=app.requests.slice(requestStart);assert.ok(!row.requests.some(r=>r.status>=400||/maxima-plot\.fas|libgnuplot\.so/.test(r.pathname||'')),'Unexpected runtime request failure or plotting asset');assert.equal(row.pageErrors.length,0,'Page error observed');assert.equal(row.fatalConsoleCount,0,'Fatal/unexpected console error observed');
          }catch(error){row.error=String(error);row.ok=false;priorStopped=false;}
          finally{
            await writeQueue;row.requests=app.requests.slice(requestStart);row.finishedAt=new Date().toISOString();
            const snapshot=snapshotMeasurement(row);if(mode==='cold')precedingCold={id,passed:snapshot.ok,terminationAcknowledged:priorStopped};activeRow=null;lateRow=createLateTelemetry(id);report.lateTelemetry.push(lateRow);
            Object.assign(report.samples.at(-1),{ok:snapshot.ok,phase:'finished',precedingCold:snapshot.precedingCold,runId:snapshot.runId,timings:compactResult(snapshot.result),startupGuardPassed:snapshot.result?.startupGuard?.passed===true,error:snapshot.error||snapshot.result?.error||(!priorStopped?'Worker termination guard failed':null),termination:snapshot.termination||null,warningCount:Object.entries(snapshot.consoleCounts).filter(([k])=>k.startsWith('warning:')||isKnownSyscallWarning(k.slice(k.indexOf(':')+1))).reduce((sum,[,n])=>sum+n,0),fatalConsoleCount:snapshot.fatalConsoleCount});
            await writeFile(join(directory,'sample.json'),JSON.stringify(snapshot,null,2)+'\n');await save();
            console.log('CTM-TIMING-TRIAL|'+JSON.stringify({id,phase:'finished',ok:snapshot.ok,error:(snapshot.error||snapshot.result?.error||'').slice(0,500),startupFatal:snapshot.result?.startupGuard?.receipt?.firstFatal?.line?.slice(0,500)||null}));
          }
          if(!priorStopped&&mode==='cold'){report.skipped.push({...pair,mode:'warm-profile-reload',reason:'Cold measurement did not confirm old worker termination'});break;}
        }
      }catch(error){report.pairFailures??=[];report.pairFailures.push({...pair,error:String(error)});}
      finally{if(browser)await browser.close().catch(()=>{});if(app)await app.close();await save();}
    }
    report.passed=report.samples.length===report.plannedMeasurements&&report.samples.every(s=>s.ok)&&!report.skipped.length&&!report.pairFailures?.length&&!lateTelemetryFailed(report.lateTelemetry);
  }catch(error){report.failure=String(error);}
  finally{report.finishedAt=new Date().toISOString();await save();}
  if(!report.passed)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
