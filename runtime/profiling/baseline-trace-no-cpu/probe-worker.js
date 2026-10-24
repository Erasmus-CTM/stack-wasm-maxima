'use strict';
importScripts('runtime/maxima-session.js');
let activeSession,started=false;
function receiptCollector(prefix,limit){
  const state={count:0,values:[],errors:[]};
  return {state,receive(event){
    if(event.event!=='maxima-diagnostic'||typeof event.text!=='string'||!event.text.startsWith(prefix))return;
    state.count++;
    try{if(event.text.length>limit)throw Error('Receipt exceeds bound');const value=JSON.parse(event.text.slice(prefix.length));if(state.values.length<2)state.values.push(value);}
    catch(error){if(state.errors.length<2)state.errors.push(String(error));}
  }};
}
function startupResult(state){
  const receipt=state.values[0]||null,result={receiptCount:state.count,parseErrors:state.errors,receipt,passed:false};
  result.passed=state.count===1&&state.errors.length===0&&receipt?.schema===1&&receipt.kind==='ctm-startup-stdout-guard'&&receipt.passed===true&&receipt.failed===false&&receipt.firstFatal===null&&receipt.state==='ready'&&receipt.beginCount===1&&receipt.endCount===1&&receipt.readyCount===1&&typeof receipt.stdoutTail==='string'&&receipt.stdoutTail.length<=16384;
  return result;
}

self.onmessage=async({data})=>{
  if(data.type==='stop'){activeSession?.terminate();return;}
  const startup=receiptCollector('CTM-STARTUP-GUARD|',65536);
  const rows=[],progress={phase:'start',correctnessPassed:false,profileRows:rows,phases:[]};
  const send=()=>self.postMessage({type:'progress',progress});
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const require=(ok,message)=>{if(!ok)throw Error(message);};
  const beginPhase=name=>{const row={name,startEpochMs:performance.timeOrigin+performance.now(),completed:false};progress.phases.push(row);return row;};
  const endPhase=row=>{row.endEpochMs=performance.timeOrigin+performance.now();row.elapsedMs=row.endEpochMs-row.startEpochMs;};
  const timedPhase=(name,fn)=>{const row=beginPhase(name);try{const value=fn();row.completed=true;return {value,phase:row};}finally{endPhase(row);}};
  let resolveFlush;const flushed=new Promise(resolve=>{resolveFlush=resolve;});
  try{
    if(data.baselineTracePilot){require(data.checks.length===10,'Ten typed checks required');require(data.instrumented&&data.startupGuard,'Baseline pilot requires guarded instrumentation');require(!started,'Pilot worker cannot be reused');started=true;}
    const options={baseURL:new URL('./maxima-runtime/',location.href).href,stackSourceURL:new URL(data.manifest,location.href).href,
      loadTimeoutMs:240000,callTimeoutMs:60000};
    if(data.startupGuard)options.onEvent=event=>startup.receive(event);
    if(data.instrumented)options.childURL=new URL('./runtime-profile/',location.href).href;
    const session=activeSession=new MaximaSession(options),start=performance.now();
    if(data.baselineTracePilot)require(!session.child&&!session.controlBuffer&&!session.inputBuffer&&!session.outputBuffer,'Session already has child/buffers');
    // start() creates the child only after fetching the manifest. Capture it at creation.
    const OriginalWorker=self.Worker;
    if(data.instrumented)self.Worker=class extends OriginalWorker{
      constructor(...args){super(...args);this.addEventListener('message',({data:message})=>{
        if(message.type!=='ctm-profile')return;
        if(rows.length>=4096){progress.profileOverflow=true;return;}
        rows.push(message.row);if(message.row.kind==='trace-finish')resolveFlush();
        if(['trace-start','trace-enter','trace-finish'].includes(message.row.kind)||rows.length%16===0)send();
      });}
    };
    const initializationPhase=beginPhase('initialization');
    try{progress.initialization=await session.init();initializationPhase.completed=true;}finally{endPhase(initializationPhase);if(data.instrumented)self.Worker=OriginalWorker;}
    progress.readyMs=performance.now()-start;
    if(data.startupGuard){progress.startupGuard=startupResult(startup.state);require(progress.startupGuard.passed,'Startup stdout guard receipt failed or missing');}
    if(data.baselineTracePilot){const buffers=[session.controlBuffer,session.inputBuffer,session.outputBuffer];progress.freshSession={childPresent:Boolean(session.child),buffersDistinct:new Set(buffers).size===3,bufferBytes:buffers.map(b=>b?.byteLength),initialSequence:session.sequence,initialNativeCalls:session.counters.nativeCalls,initialRequest:Atomics.load(session.control,5),initialResponse:Atomics.load(session.control,6)};require(progress.freshSession.childPresent&&progress.freshSession.buffersDistinct&&same(progress.freshSession.bufferBytes,[32,2097152,1048576])&&session.sequence===0&&session.counters.nativeCalls===0&&progress.freshSession.initialRequest===0&&progress.freshSession.initialResponse===0,'Fresh pilot worker/buffers guard failed');}
    progress.phase='first-logical-validation';send();
    require(session.manifest.stackRevision===data.expected.stackRevision,'STACK pin changed');
    require(String(progress.initialization.stackLibraryVersion)===String(data.expected.stackLibraryVersion),'STACK version changed');
    require(progress.initialization.maximaVersion===data.expected.maximaVersion,'Maxima version changed');
    const stages=progress.initialization.stages;
    require(Number.isFinite(stages.stackLoadMs)&&stages.stackLoadMs>0,'STACK timing missing');
    if(data.candidate==='precompiled'){
      if(data.baselineTracePilot)require(stages.compiledStackOpens===1,'Pilot requires exactly one FAS read');
      require(stages.compiledStackMounted===true&&stages.compiledStackOpens>0&&stages.compiledSourceEntryOpens===0,'FAS read/source fallback guard failed');
      require(stages.compiledStackBytes===data.expected.compiledStack.asset.fileBytes&&stages.compiledStackSha256===data.expected.compiledStack.asset.sha256,'FAS identity changed');
    }else require(stages.compiledStackMounted!==true&&stages.compiledStackBytes===undefined,'Source arm loaded FAS');
    progress.checks=[];
    const check=row=>{const {value,phase}=timedPhase(row.name,()=>session.evaluate(row.expression));require(same(value,row.expected),'Semantic mismatch: '+row.name);progress.checks.push({name:row.name,result:value,elapsedMs:phase.elapsedMs});};
    require(data.checks[0].name==='first-call-logical-validation','First logical check changed');check(data.checks[0]);
    const grade=(positive,label)=>{
      progress.phase=label;send();
      const {value:result,phase}=timedPhase(label,()=>session.assess({test:'AlgEquiv',student:positive?'(x+1)^2':'x+1',teacher:positive?'x^2+2*x+1':'x+2'}));
      require(result.cas_valid===true&&result.correct===positive,'Grade mismatch: '+label);
      return {label,positive,result,elapsedMs:phase.elapsedMs};
    };
    progress.firstPositiveGrade=grade(true,'first-positive-grade');
    progress.firstNegativeGrade=grade(false,'first-negative-grade');
    progress.warmGrades=[];for(let i=0;i<10;i++)progress.warmGrades.push(grade(i%2===0,'warm-grade-'+i));
    progress.warmCalls=[];for(let i=0;i<10;i++){const {value,phase}=timedPhase('warm-arithmetic-'+i,()=>session.evaluate('6*7'));require(value===42,'Warm arithmetic failed');progress.warmCalls.push({value,elapsedMs:phase.elapsedMs});}
    progress.phase='remaining-semantics';send();for(const row of data.checks.slice(1))check(row);
    progress.policy=timedPhase('policy',()=>session.evaluate('[STACKpmOPT,algebraic_equivalence_factorp,algebraic_equivalence_trigexpandp,algebraic_equivalence_nounsp,tex_plain_atoms,stackintfmt,stackfltfmt,stackfltsep,setp(FORBIDDEN_SYMBOLS_SET),is(cardinality(FORBIDDEN_SYMBOLS_SET)>0)]')).value;
    require(same(progress.policy,['#pm#',true,true,true,false,'~d','~a','.',true,true]),'STACK policy changed');
    if(data.baselineTracePilot){
    require(data.nativePrograms.length===3&&same(data.nativePrograms.map(r=>r.operation),['prepare','validate','prt']),'Native workload changed');
    progress.nativeCalls=[];for(const program of data.nativePrograms){const {value,phase}=timedPhase('native-'+program.operation,()=>session.evaluate(program.expression));require(same(value,program.expected),'Native result mismatch: '+program.operation);progress.nativeCalls.push({operation:program.operation,result:value,elapsedMs:phase.elapsedMs});}
    progress.phase='gc-error-plot-controls';send();
    session.write(':lisp (defun maxima::$ctm_force_gc () (si:gc t) (quote maxima::$done))\n',60000);
    const retained=session.evaluate('block([],ctm_retained:makelist([i,i^2],i,1,1000),length(ctm_retained))');require(retained===1000,'Retained object setup failed');
    const gcCalls=[];for(let i=0;i<100;i++){const value=session.evaluate('block([temporary:makelist(j^3,j,1,2000)],ctm_force_gc(),is(temporary[2000]=8000000000) and is(ctm_retained[1000]=[1000,1000000]) and is(length(ctm_retained)=1000))');require(value===true,'Full collection verification failed');gcCalls.push(value);}
    const caughtError=session.evaluate('block([r:errcatch(error("CTM deliberate caught CAS error"))],if r=[] then errormsgtostring() else "unexpected")');require(typeof caughtError==='string'&&caughtError.includes('CTM deliberate caught CAS error'),'Caught error verification failed');
    const afterError=session.evaluate('6*7');require(afterError===42,'Post-error arithmetic failed');
    const plotting=[];for(const expression of ['plot2d(x,[x,0,1])','plot(x,[x,0,1])','get_plot_option(plot_format)','gnuplot_close()']){
      const diagnostic=session.evaluate('block([r:errcatch('+expression+')],if r=[] then errormsgtostring() else "unexpected plotting success")'),value=session.evaluate('6*7');
      require(typeof diagnostic==='string'&&diagnostic.includes('CTM plotting unavailable; use JSXGraph')&&value===42,'Plot policy/recovery failed');plotting.push({expression,diagnostic,afterError:value});
    }
    progress.smoke={retained,gcCalls,caughtError,afterError,plotting};
    }
    progress.correctnessPassed=true;
    if(data.instrumented){
      progress.phase='finish-load-observers';send();
      session.write(':lisp (funcall (symbol-function (find-symbol "FINISH" "CTM-PROFILE")))\n',60000);
      require(session.evaluate('6*7')===42,'Post-observer restoration arithmetic failed');
      await Promise.race([flushed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Profile flush marker missing')),5000))]);
      const finish=rows.filter(r=>r.kind==='trace-finish');require(finish.length===1,'Duplicate profile finish marker');
      require(finish[0].restored===true&&!finish[0].openFrames&&!finish[0].dropped&&!finish[0].observerErrors&&!finish[0].jsDropped&&!progress.profileOverflow,'Incomplete observer coverage');
      require(!rows.some(r=>r.kind==='observer-error'),'Observer error record present');
      require(rows.filter(r=>r.kind==='trace-start'&&r.active===true).length===1,'Trace activation marker missing');
      require(finish[0].observed===rows.filter(r=>r.kind==='trace-call').length&&finish[0].entries===rows.filter(r=>r.kind==='trace-enter').length&&finish[0].entries===finish[0].observed,'Observed trace frame count differs from completion record');
      require(rows.some(r=>r.kind==='trace-call'&&r.operation==='maxima-load'),'No Maxima load calls observed');
    }
    if(data.startupGuard){await new Promise(resolve=>setTimeout(resolve,0));progress.startupGuard=startupResult(startup.state);require(progress.startupGuard.passed,'Final startup receipt failed or duplicated');}
    if(data.baselineTracePilot){session.terminate();let rejected=false;try{session.evaluate('6*7');}catch(error){rejected=/not ready/i.test(String(error));}progress.termination={poisoned:session.poisoned===true,readyCleared:session.ready===null,rejected};progress.termination.ok=progress.termination.poisoned&&progress.termination.readyCleared&&rejected;require(progress.termination.ok,'Pilot session termination failed');}
    progress.phase='complete';progress.ok=true;self.postMessage({type:'complete',progress});
  }catch(error){progress.ok=false;progress.error=String(error);progress.stack=error.stack;if(data.startupGuard)progress.startupGuard=startupResult(startup.state);if(data.baselineTracePilot){try{activeSession?.terminate();}catch(cleanupError){progress.cleanupError=String(cleanupError);}progress.failedSessionTerminated=activeSession?.poisoned===true&&activeSession?.ready===null;}self.postMessage({type:'complete',progress});}
  // Ordinary prior modes retain workers until CPU capture; the no-CPU baseline pilot has already terminated and checked its session.
};
