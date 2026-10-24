// No rebuilds. Executes only admitted runtime copies in a separately labelled diagnostic job.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stageProfileSite,digest} from './stage.mjs';
import {startCPUProfiles,startProcessCPU} from './cdp-profile.mjs';

export function analyzeLoads(rows,phases=[]){
  const calls=rows.filter(r=>r.kind==='lisp-call'),byId=new Map(calls.map(r=>[r.id,r]));
  assert.equal(byId.size,calls.length,'Duplicate load frame ID');
  const calibration=rows.filter(r=>r.kind==='lisp-clock-calibration');
  const cpuAdvanced=calibration.length===1&&calibration[0].runTicks>0;
  const childClock=rows.find(r=>r.kind==='child-created'),lispClock=rows.find(r=>r.kind==='lisp-clock-start');
  const frames=calls.map(r=>{
    assert.ok(r.units>0&&r.realEnd>=r.realStart&&r.runEnd>=r.runStart);
    if(r.parent){assert.ok(byId.has(r.parent)&&r.parent<r.id,'Missing or cyclic parent load frame');assert.equal(r.depth,byId.get(r.parent).depth+1,'Wrong load depth');}else assert.equal(r.depth,0);
    const children=calls.filter(c=>c.parent===r.id);
    for(const c of children)assert.ok(c.realStart>=r.realStart&&c.realEnd<=r.realEnd,'Child load interval outside parent');
    const inclusive=(r.realEnd-r.realStart)*1000/r.units;
    const exclusive=inclusive-children.reduce((s,c)=>s+(c.realEnd-c.realStart)*1000/c.units,0);
    assert.ok(exclusive>=-1e-6,'Overlapping child frame accounting');
    let alignment=null;
    if(childClock&&lispClock&&lispClock.units===r.units){
      const anchor=childClock.createdEpochMs+lispClock.childMs;
      const startEpochMs=anchor+(r.realStart-lispClock.realTicks)*1000/r.units,endEpochMs=anchor+(r.realEnd-lispClock.realTicks)*1000/r.units;
      alignment={startEpochMs,endEpochMs,overlaps:phases.filter(p=>Number.isFinite(p.endEpochMs)).map(p=>({phase:p.name,overlapMs:Math.max(0,Math.min(endEpochMs,p.endEpochMs)-Math.max(startEpochMs,p.startEpochMs))})).filter(p=>p.overlapMs>0).sort((a,b)=>b.overlapMs-a.overlapMs),scope:'Approximate alignment using the emitted ECL real-clock anchor and child epoch clock; anchor emission overhead and timer resolution remain.'};
    }
    return {...r,inclusiveElapsedMs:inclusive,exclusiveElapsedMs:Math.max(0,exclusive),reportedRunClockMs:cpuAdvanced?(r.runEnd-r.runStart)*1000/r.units:null,phaseAlignment:alignment};
  });
  const groups=new Map();for(const r of frames){const key=r.operation+'|'+r.name,g=groups.get(key)||{operation:r.operation,name:r.name,calls:0,inclusiveElapsedMs:0,exclusiveElapsedMs:0};g.calls++;g.inclusiveElapsedMs+=r.inclusiveElapsedMs;g.exclusiveElapsedMs+=r.exclusiveElapsedMs;groups.set(key,g);}
  const opens=new Map();for(const r of rows.filter(r=>r.kind==='fs-open'&&r.completed&&(r.flags&3)!==1)){const p=opens.get(r.path)||{path:r.path,opens:0,openElapsedMs:0};p.opens++;p.openElapsedMs+=r.elapsedMs;opens.set(r.path,p);}
  const summaries=rows.filter(r=>r.kind==='fs-summary');assert.ok(summaries.length<=1,'Duplicate filesystem summary');
  for(const summary of summaries){
    assert.equal(summary.schema,2,'Filesystem aggregate schema changed');
    assert.ok(summary.paths.length<=summary.pathLimit&&summary.otherGroups.length<=summary.otherLimit);
    assert.equal(summary.totalOpenCalls,summary.unbucketedFileCalls+summary.unbucketedOtherCalls+[...summary.paths,...summary.otherGroups].reduce((s,r)=>s+r.opens,0),'Filesystem aggregate count mismatch');
    const totalTime=summary.unbucketedFileElapsedMs+summary.unbucketedOtherElapsedMs+[...summary.paths,...summary.otherGroups].reduce((s,r)=>s+r.openElapsedMs,0);
    assert.ok(Math.abs(summary.totalOpenElapsedMs-totalTime)<Math.max(1e-6,summary.totalOpenElapsedMs*1e-9),'Filesystem aggregate duration mismatch');
    for(const r of summary.paths){assert.ok(r.completed&&r.kind==='regular-file','Non-file consumed reserved file bucket');if((r.flags&3)!==1){const p=opens.get(r.path)||{path:r.path,opens:0,openElapsedMs:0};p.opens+=r.opens;p.openElapsedMs+=r.openElapsedMs;opens.set(r.path,p);}}
  }
  return {frames,groupedByExactLoadArgument:[...groups.values()].sort((a,b)=>b.exclusiveElapsedMs-a.exclusiveElapsedMs),successfulReadOpensByResolvedPath:[...opens.values()].sort((a,b)=>b.opens-a.opens),filesystemAggregate:summaries[0]||null,clockCalibration:calibration,
    reportedRunClockStatus:cpuAdvanced?'advanced during calibration; ECL clock implementation still unvalidated as process CPU':'unavailable/nonadvancing in calibration; zero is not evidence of zero CPU',
    scope:'Nested function-cell load/compile observers only, inclusive and direct-child-subtracted elapsed durations. Compiled direct calls may bypass these wrappers. FS.open paths are resolved paths but file-open time is not full load time. Observer and clock-call overhead is included; do not sum inclusive nested durations.'};
}
export function trialPlan(repetitions){
  const rows=[];
  for(let repetition=1;repetition<=repetitions;repetition++){
    const profiles=repetition%2?['baseline','ecl-oz']:['ecl-oz','baseline'];
    for(const profile of profiles){
      const candidates=repetition%2?['source','precompiled']:['precompiled','source'];
      for(const arm of repetition%2?['control','instrumented']:['instrumented','control'])for(const candidate of candidates)rows.push({repetition,profile,arm,candidate});
    }
  }
  return rows;
}
export const haltForCoreFailure=row=>row.arm==='instrumented'&&row.ok!==true;
export function summarizeCPU(value){
  return value.profiles.map(({target,profile})=>{
    const samples=profile.samples||[],deltas=profile.timeDeltas||[],nodes=new Map(profile.nodes.map(n=>[n.id,n]));
    if(samples.length!==deltas.length||nodes.size!==profile.nodes.length)return {target,complete:false,error:'Sampling arrays or node IDs are inconsistent'};
    const totals=new Map();for(let i=0;i<samples.length;i++){assert.ok(nodes.has(samples[i])&&Number.isFinite(deltas[i])&&deltas[i]>=0);const r=totals.get(samples[i])||{nodeId:samples[i],samples:0,sampledIntervalMicroseconds:0};r.samples++;r.sampledIntervalMicroseconds+=deltas[i];totals.set(samples[i],r);}
    const top=[...totals.values()].sort((a,b)=>b.sampledIntervalMicroseconds-a.sampledIntervalMicroseconds).slice(0,30).map(r=>({...r,frame:nodes.get(r.nodeId).callFrame,opaqueWasm:/wasm|wasm-function/i.test(JSON.stringify(nodes.get(r.nodeId).callFrame))}));
    return {target,complete:true,samples:samples.length,profileStartMicroseconds:profile.startTime,profileEndMicroseconds:profile.endTime,topSelfSampleIntervals:top,scope:'Top30 sampled leaf nodes weighted by observed inter-sample intervals; includes idle/program frames and profiler overhead. Not exact function CPU time. Opaque Wasm names remain opaque.'};
  });
}
function summarizeTrials(samples){
  const median=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?(v[Math.floor((v.length-1)/2)]+v[Math.ceil((v.length-1)/2)])/2:null;};
  const groups=[];
  for(const profile of ['baseline','ecl-oz'])for(const candidate of ['source','precompiled'])for(const arm of ['control','instrumented']){
    const rows=samples.filter(r=>r.profile===profile&&r.candidate===candidate&&r.arm===arm&&r.ok);
    const metrics={readyMs:r=>r.result.readyMs,stackLoadMs:r=>r.result.initialization.stages.stackLoadMs,wasmReadyMs:r=>r.result.initialization.stages.wasmReadyMs,preStackAfterWasmMs:r=>r.result.initialization.stages.stackLoadStartedMs-r.result.initialization.stages.wasmReadyMs,firstLogicalMs:r=>r.result.checks[0].elapsedMs,firstPositiveGradeMs:r=>r.result.firstPositiveGrade.elapsedMs,firstNegativeGradeMs:r=>r.result.firstNegativeGrade.elapsedMs,readyPlusFirstLogicalAndFirstPositiveMs:r=>r.result.readyMs+r.result.checks[0].elapsedMs+r.result.firstPositiveGrade.elapsedMs};
    groups.push({profile,candidate,arm,successfulTrials:rows.length,medians:Object.fromEntries(Object.entries(metrics).map(([k,f])=>[k,median(rows.map(f))])),perTrialLoadTop20:rows.filter(r=>r.loads).map(r=>({trial:r.id,rows:r.loads.groupedByExactLoadArgument.slice(0,20)}))});
  }
  const pairedOverhead=[];for(const instrumented of samples.filter(r=>r.arm==='instrumented'&&r.ok)){const control=samples.find(r=>r.arm==='control'&&r.ok&&r.profile===instrumented.profile&&r.candidate===instrumented.candidate&&r.repetition===instrumented.repetition);if(control)pairedOverhead.push({profile:instrumented.profile,candidate:instrumented.candidate,repetition:instrumented.repetition,instrumentedMinusControlReadyMs:instrumented.result.readyMs-control.result.readyMs,instrumentedMinusControlStackLoadMs:instrumented.result.initialization.stages.stackLoadMs-control.result.initialization.stages.stackLoadMs,scope:'Uncontrolled cache/runner variation and instrumentation overhead both contribute; this difference does not isolate observer cost.'});}
  return {groups,pairedOverhead,scope:'Separate clean and instrumented summaries. n3 diagnostic observations are not a statistical speedup or performance acceptance claim. Ready+logical+positive is the sum of measured blocks, not full UI navigation latency.'};
}
async function main(){
  const {chromium}=await import('playwright');
  const args={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(key==='--cpu-profile')args[key]=true;else{assert.ok(key.startsWith('--')&&process.argv[i+1],'Invalid argument');args[key]=process.argv[++i];}}
  for(const key of ['--trusted-root','--profiles-root','--output','--admission'])assert.ok(args[key],key+' required');
  const trustedRoot=resolve(args['--trusted-root']),profilesRoot=resolve(args['--profiles-root']),output=resolve(args['--output']),repetitions=Number(args['--repetitions']||3);
  assert.ok(Number.isSafeInteger(repetitions)&&repetitions>=1&&repetitions<=10,'Repetitions must be1..10');
  await mkdir(output,{recursive:true});
  const {serveDemo}=await import(pathToFileURL(join(trustedRoot,'scripts/milestone-two/serve.mjs')));
  const checksBytes=await readFile(join(trustedRoot,'runtime/precompiled/restart-checks.json')),checks=JSON.parse(checksBytes);
  assert.equal(checks.checks.length,10);assert.equal(checks.checks[0].name,'first-call-logical-validation');
  const plan=trialPlan(repetitions),report={schema:1,diagnosticOnly:true,acceptance:false,startedAt:new Date().toISOString(),plan,repetitions,cpuSamplingRequested:Boolean(args['--cpu-profile']),watchdogMs:300000,checks:{bytes:checksBytes.length,sha256:digest(checksBytes)},staging:{},samples:[],passed:false,
    scope:'Fresh Chromium process/profile per trial, source versus entry-FAS STACK with identical admitted runtime assets within each compiler profile. Clean controls retain original child and startup. Instrumented timing includes observer/sampler overhead and is not mixed into clean-control medians. OS caches/runner contention remain uncontrolled. No production acceptance, rebuild, default promotion or speedup claim.'};
  const save=()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await save();
  const admissionBody=await readFile(resolve(args['--admission'])),admission=JSON.parse(admissionBody);assert.equal(admission.passed,true,'Successful current artifact admission required');
  report.admission={path:resolve(args['--admission']),bytes:admissionBody.length,sha256:digest(admissionBody),source:admission.source,profiling:admission.profiling};
  const stagedSites={};
  for(const profile of ['baseline','ecl-oz']){
    const staged=stagedSites[profile]=await stageProfileSite({site:join(profilesRoot,profile,'site'),output:join(output,'staged',profile),trustedRoot,admission,profile});
    report.staging[profile]={...staged,manifests:Object.fromEntries(Object.entries(staged.manifests).map(([candidate,m])=>[candidate,{name:m.name,profileName:m.profileName,bytes:m.bytes,sha256:m.sha256,stackRevision:m.manifest.stackRevision,stackLibraryVersion:m.manifest.stackLibraryVersion,runtimeBuild:m.manifest.runtimeBuild,compiledStack:m.manifest.compiledStack||null}]))};await save();
  }
  for(let index=0;index<plan.length;index++){
    const trial=plan[index],id=String(index+1).padStart(2,'0')+'-'+trial.profile+'-'+trial.candidate+'-'+trial.arm;
    const directory=join(output,'trials',id);await mkdir(directory,{recursive:true});
    const row={id,...trial,startedAt:new Date().toISOString(),phase:'starting',ok:false,consoleCounts:{},consoleSamples:[],pageErrors:[]};report.samples.push(row);await save();
    const staged=stagedSites[trial.profile],manifest=staged.manifests[trial.candidate],instrumented=trial.arm==='instrumented';
    let app,browser,cpu,processCPU,page;const nodeCPU=process.cpuUsage(),wallStart=performance.now();
    try{
      app=await serveDemo({root:staged.site,compression:'gzip'});browser=await chromium.launch({headless:true});row.browser=browser.version();
      if(instrumented)try{processCPU=await startProcessCPU(browser);}catch(error){row.processCPUUnavailable=String(error);}
      page=await browser.newPage();page.on('console',message=>{const text=message.text(),key=message.type()+':'+text;row.consoleCounts[key]=(row.consoleCounts[key]||0)+1;if(row.consoleSamples.length<1000)row.consoleSamples.push({type:message.type(),text});});page.on('pageerror',error=>row.pageErrors.push(String(error)));
      if(instrumented&&args['--cpu-profile']){try{cpu=await startCPUProfiles(page);}catch(error){row.cpuUnavailable=String(error);}}
      let latest={phase:'worker-start'},writeQueue=Promise.resolve();
      await page.exposeFunction('ctmProfileProgress',value=>{latest=value;row.progress=value;writeQueue=writeQueue.then(()=>writeFile(join(directory,'partial.json'),JSON.stringify(value,null,2)+'\n'));});
      await page.goto(app.baseURL+'no-rebuild-profile.html');
      const expected={stackRevision:manifest.manifest.stackRevision,stackLibraryVersion:manifest.manifest.stackLibraryVersion,maximaVersion:manifest.manifest.runtimeBuild.sourcePins.sources.find(x=>x.name==='maxima').version,compiledStack:manifest.manifest.compiledStack||null};
      row.result=await page.evaluate(input=>new Promise(resolveTrial=>{
        const worker=window.ctmProfileWorker=new Worker('no-rebuild-probe-worker.js');let latest={phase:'worker-start'};
        const timer=setTimeout(()=>resolveTrial({...latest,ok:false,error:'300-second profiling watchdog expired'}),300000);
        worker.onmessage=({data})=>{if(data.type==='progress'){latest=data.progress;void window.ctmProfileProgress(latest);return;}if(data.type==='complete'){clearTimeout(timer);resolveTrial(data.progress);}};
        worker.onerror=error=>{clearTimeout(timer);resolveTrial({...latest,ok:false,error:error.message});};worker.postMessage(input);
      }),{candidate:trial.candidate,instrumented,manifest:instrumented?manifest.profileName:manifest.name,expected,checks:checks.checks});
      await writeQueue;row.ok=row.result.ok===true&&row.result.correctnessPassed===true;
      if(instrumented&&row.result.profileRows?.length)try{row.loads=analyzeLoads(row.result.profileRows,row.result.phases||[]);}catch(error){row.ok=false;row.analysisError=String(error);}
      row.phase='capturing-cpu';await save();
    }catch(error){row.error=String(error);row.stack=error.stack;row.ok=false;}
    finally{
      if(cpu){try{const value=await cpu.stop();await writeFile(join(directory,'cpu-profiles.json'),JSON.stringify(value)+'\n');row.cpuProfiles={path:'trials/'+id+'/cpu-profiles.json',complete:value.complete,contexts:value.contexts,errors:value.errors,hotspots:summarizeCPU(value)};}catch(error){row.cpuUnavailable=String(error);}}
      if(processCPU){try{const value=await processCPU.stop();await writeFile(join(directory,'process-cpu.json'),JSON.stringify(value,null,2)+'\n');row.processCPU={path:'trials/'+id+'/process-cpu.json',totalObservedCPUSeconds:value.totalObservedCPUSeconds,errors:value.errors,scope:value.scope};}catch(error){row.processCPUUnavailable=String(error);}}
      if(page)await page.evaluate(()=>{window.ctmProfileWorker?.postMessage({type:'stop'});window.ctmProfileWorker?.terminate();}).catch(()=>{});
      if(browser)await browser.close().catch(error=>{row.closeError=String(error);});
      if(app){row.requests=app.requests;await app.close();}
      row.hostNodeCPU=process.cpuUsage(nodeCPU);row.wallElapsedMs=performance.now()-wallStart;row.phase='finished';row.finishedAt=new Date().toISOString();
      await writeFile(join(directory,'sample.json'),JSON.stringify(row,null,2)+'\n');report.summary=summarizeTrials(report.samples);await save();
    }
    if(haltForCoreFailure(row)){report.halted={trial:row.id,reason:'Instrumented core correctness/load/flush coverage failed; remaining cells were not attempted. Optional CPU partial coverage alone does not halt.'};report.skipped=plan.slice(index+1);await save();break;}
  }
  report.finishedAt=new Date().toISOString();report.passed=report.samples.length===plan.length&&report.samples.every(r=>r.ok);report.cpuSamplingComplete=report.samples.filter(r=>r.arm==='instrumented').every(r=>!args['--cpu-profile']||r.cpuProfiles?.complete===true);
  await save();if(!report.passed)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
