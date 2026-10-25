"""Derive a separate diagnostic harness; never used for selection medians."""
from pathlib import Path
r=Path('.cache/full-timing-table-guarded/tools')
p=r/'run.mjs';s=p.read_text()
s=s.replace("const observer=deriveStartupObserver", "const observer=deriveStartupObserver")
a="await writeFile(join(output,'runtime/maxima-child.js'),observer.derived);"
b="""await writeFile(join(output,'runtime/maxima-child.js'),observer.derived.toString().replace('function consume(text) {',`function consume(text) {
  if (initialized && text.length) self.postMessage({type:'maxima-diagnostic',text:'CTM-GRADE-STDOUT|'+text});`));"""
assert s.count(a)==1;s=s.replace(a,b)
a="let app,browser,page,priorStopped=false,precedingCold=null;"
b="let app,browser,page,cdp,trace=[],priorStopped=false,precedingCold=null;"
s=s.replace(a,b)
a="let activeRow,lateRow,writeQueue=Promise.resolve();"
b="""cdp=await browser.newBrowserCDPSession();cdp.on('Tracing.dataCollected',e=>trace.push(...e.value));
        await cdp.send('Tracing.start',{categories:'v8,wasm,devtools.timeline,disabled-by-default-v8.wasm.detailed',transferMode:'ReportEvents'});
        const syncBefore=Date.now();await cdp.send('Tracing.recordClockSyncMarker',{syncId:'epoch-'+syncBefore});
        let activeRow,lateRow,writeQueue=Promise.resolve();"""
assert s.count(a)==1;s=s.replace(a,b)
a="finally{if(browser)await browser.close().catch(()=>{});if(app)await app.close();await save();}"
b="""finally{if(cdp){const completed=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');await completed;await writeFile(join(output,'trace-'+pair.pair+'.json'),JSON.stringify({diagnosticOnly:true,pair,traceEvents:trace}));}if(browser)await browser.close().catch(()=>{});if(app)await app.close();await save();}"""
assert s.count(a)==1;s=s.replace(a,b)
p.write_text(s)
p=r/'clean-probe-worker.js';s=p.read_text().replace("onEvent:event=>{startup.receive(event);}","onEvent:event=>{startup.receive(event);if(event.text?.startsWith('CTM-GRADE-STDOUT|')){progress.loadTrace??=[];if(progress.loadTrace.length<2000)progress.loadTrace.push({epochMs:now(),phase:progress.phase,text:event.text});}}")
a="progress.checks=[];";s=s.replace(a,"session.write(':lisp (trace maxima::$load cl:load)\\n',60000);\n    "+a)
p.write_text(s)
