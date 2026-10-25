"""Capture CPU only around the first positive grade, outside selection runs."""
from pathlib import Path
r=Path('.cache/full-timing-table-guarded/tools')
p=r/'run.mjs';s=p.read_text()
a="""        await cdp.send('Tracing.start',{categories:'v8,wasm,devtools.timeline,disabled-by-default-v8.wasm.detailed',transferMode:'ReportEvents'});
        const syncBefore=Date.now();await cdp.send('Tracing.recordClockSyncMarker',{syncId:'epoch-'+syncBefore});"""
b="""        let tracingStarted=false;
        await page.exposeFunction('ctmGradeTrace',async({kind,runId})=>{
          if(kind==='begin'){
            assert.equal(tracingStarted,false);trace=[];tracingStarted=true;
            await cdp.send('Tracing.start',{categories:'v8,wasm,devtools.timeline,disabled-by-default-v8.wasm.detailed,disabled-by-default-v8.cpu_profiler',transferMode:'ReportEvents'});
            await cdp.send('Tracing.recordClockSyncMarker',{syncId:'epoch-'+Date.now()});
          }else{
            assert.equal(tracingStarted,true);
            const completed=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');await completed;tracingStarted=false;
            await writeFile(join(output,'trace-'+pair.pair+'-'+runId+'.json'),JSON.stringify({diagnosticOnly:true,scope:'CPU around one first positive grade only; no startup or later controls in this trace',pair,runId,traceEvents:trace}));
          }
          return true;
        });"""
assert s.count(a)==1;s=s.replace(a,b)
a="worker.onmessage=({data})=>{if(data.progress?.runId!==input.runId)"
b="worker.onmessage=({data})=>{if(data.type==='cpu-gate'){void window.ctmGradeTrace({kind:data.kind,runId:data.runId}).then(()=>worker.postMessage({type:'cpu-gate-ack',runId:data.runId})).catch(error=>finish({ok:false,error:String(error)}));return;}if(data.progress?.runId!==input.runId)"
assert s.count(a)==1;s=s.replace(a,b)
a="if(cdp){const completed=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');await completed;await writeFile(join(output,'trace-'+pair.pair+'.json'),JSON.stringify({diagnosticOnly:true,pair,traceEvents:trace}));}"
assert s.count(a)==1;s=s.replace(a,'')
p.write_text(s)
p=r/'clean-probe-worker.js';s=p.read_text()
s=s.replace('let started=false,activeSession,runId;',"let started=false,activeSession,runId,cpuResolve;\nconst cpuGate=kind=>new Promise(resolve=>{cpuResolve=resolve;self.postMessage({type:'cpu-gate',kind,runId});});")
s=s.replace("self.onmessage=async({data})=>{", "self.onmessage=async({data})=>{\n  if(data.type==='cpu-gate-ack'){require(data.runId===runId,'CPU gate token changed');cpuResolve();return;}")
a="    progress.firstPositiveGrade=grade(true,'first-positive-grade');"
b="""    await cpuGate('begin');
    progress.firstPositiveGrade=grade(true,'first-positive-grade');
    await cpuGate('end');
    // This is a narrow CPU diagnostic, not the complete selection/acceptance suite.
    progress.firstNegativeGrade={elapsedMs:null};progress.warmGrades=[];progress.warmCalls=[];
    progress.correctnessPassed=true;progress.ok=true;progress.phase='complete';
    await new Promise(resolve=>setTimeout(resolve,0));
    self.postMessage({type:'complete',progress});return;"""
assert s.count(a)==1;s=s.replace(a,b);p.write_text(s)
