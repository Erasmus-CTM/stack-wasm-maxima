// Guarded six-cell driver. Original runtime/session/startup stay unchanged; every cell uses the same declared stdout-only child observer.
'use strict';
importScripts('runtime/maxima-session.js');
let started=false,activeSession,runId;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const require=(condition,message)=>{if(!condition)throw Error(message);};
function receiptCollector(prefix,limit){
  const state={count:0,values:[],errors:[]};
  return {state,receive(event){
    if(event.event!=='maxima-diagnostic'||typeof event.text!=='string'||!event.text.startsWith(prefix))return;
    state.count++;
    try{require(event.text.length<=limit,'Receipt exceeds bound');const value=JSON.parse(event.text.slice(prefix.length));if(state.values.length<2)state.values.push(value);}
    catch(error){if(state.errors.length<2)state.errors.push(String(error));}
  }};
}
function startupResult(state){
  const receipt=state.values[0]||null,result={receiptCount:state.count,parseErrors:state.errors,receipt,passed:false};
  result.passed=state.count===1&&state.errors.length===0&&receipt?.schema===1&&receipt.kind==='ctm-startup-stdout-guard'&&receipt.passed===true&&receipt.failed===false&&receipt.firstFatal===null&&receipt.state==='ready'&&receipt.beginCount===1&&receipt.endCount===1&&receipt.readyCount===1&&typeof receipt.stdoutTail==='string'&&receipt.stdoutTail.length<=16384;
  return result;
}
self.onmessage=async({data})=>{
  if(data.type==='stop'){
    let stopped=false,rejected=false,error=null;
    try{
      require(data.runId===runId,'Stop token changed');
      activeSession?.terminate();
      stopped=Boolean(activeSession)&&activeSession.poisoned===true&&activeSession.ready===null;
      try{activeSession.evaluate('6*7');}catch(value){rejected=/not ready/i.test(String(value));}
    }catch(value){error=String(value);}
    self.postMessage({type:'stopped',runId,stopped,rejected,error});return;
  }
  const startup=receiptCollector('CTM-STARTUP-GUARD|',65536);
  const progress={phase:'starting',ok:false,correctnessPassed:false,runId:data.runId,phases:[]};
  const send=()=>self.postMessage({type:'progress',progress});
  const now=()=>performance.timeOrigin+performance.now();
  const begin=name=>{progress.phase=name;send();const row={name,startEpochMs:now(),completed:false};progress.phases.push(row);return row;};
  const end=row=>{row.endEpochMs=now();row.elapsedMs=row.endEpochMs-row.startEpochMs;};
  const timed=(name,fn)=>{const phase=begin(name);try{const value=fn();phase.completed=true;return {value,phase};}finally{end(phase);}};
  try{
    require(!started,'A measurement worker cannot be reused');started=true;runId=data.runId;
    require(typeof runId==='string'&&runId.length>=16,'Fresh measurement token required');
    const session=activeSession=new MaximaSession({baseURL:new URL('./maxima-runtime/',location.href).href,
      stackSourceURL:new URL(data.manifest,location.href).href,loadTimeoutMs:240000,callTimeoutMs:60000,
      onEvent:event=>{startup.receive(event);}});
    require(!session.child&&!session.controlBuffer&&!session.inputBuffer&&!session.outputBuffer,'Session already has worker or buffers');
    const phase=begin('initialization'),start=performance.now();
    try{progress.initialization=await session.init();phase.completed=true;}finally{end(phase);}
    progress.readyMs=performance.now()-start;
    progress.startupGuard=startupResult(startup.state);require(progress.startupGuard.passed,'Startup stdout guard receipt failed or missing');
    const buffers=[session.controlBuffer,session.inputBuffer,session.outputBuffer];
    progress.freshSession={newSessionHadNoChildOrBuffers:true,childPresent:Boolean(session.child),
      buffersDistinct:new Set(buffers).size===3,bufferBytes:buffers.map(b=>b?.byteLength),
      initialSequence:session.sequence,initialNativeCalls:session.counters.nativeCalls,
      initialRequest:Atomics.load(session.control,5),initialResponse:Atomics.load(session.control,6)};
    require(progress.freshSession.childPresent&&progress.freshSession.buffersDistinct&&same(progress.freshSession.bufferBytes,[32,2097152,1048576]),'Fresh worker/buffer allocation guard failed');
    require(session.sequence===0&&session.counters.nativeCalls===0&&progress.freshSession.initialRequest===0&&progress.freshSession.initialResponse===0,'Fresh session already executed calls');
    require(session.manifest.stackRevision===data.expected.stackRevision,'STACK pin changed');
    require(String(progress.initialization.stackLibraryVersion)===String(data.expected.stackLibraryVersion),'STACK version changed');
    require(progress.initialization.maximaVersion===data.expected.maximaVersion,'Maxima version changed');
    const stages=progress.initialization.stages;
    require(Number.isFinite(progress.readyMs)&&progress.readyMs>0&&Number.isFinite(stages.stackLoadMs)&&stages.stackLoadMs>0,'Startup timing missing');
    if(data.candidate==='precompiled'){
      require(stages.compiledStackMounted===true&&stages.compiledStackOpens===1&&stages.compiledSourceEntryOpens===0,'FAS read/source fallback guard failed');
      require(stages.compiledStackBytes===data.expected.compiledStack.asset.fileBytes&&stages.compiledStackSha256===data.expected.compiledStack.asset.sha256,'FAS identity changed');
    }else require(stages.compiledStackMounted!==true&&stages.compiledStackBytes===undefined,'Source arm loaded FAS');
    progress.checks=[];
    const check=row=>{const {value,phase}=timed(row.name,()=>session.evaluate(row.expression));require(same(value,row.expected),'Semantic mismatch: '+row.name);progress.checks.push({name:row.name,result:value,elapsedMs:phase.elapsedMs});};
    require(data.checks.length===10&&data.checks[0].name==='first-call-logical-validation','Typed check set changed');
    check(data.checks[0]);
    const grade=(positive,name)=>{const {value,phase}=timed(name,()=>session.assess({test:'AlgEquiv',student:positive?'(x+1)^2':'x+1',teacher:positive?'x^2+2*x+1':'x+2'}));require(value.cas_valid===true&&value.correct===positive,'Grade mismatch: '+name);return {positive,result:value,elapsedMs:phase.elapsedMs};};
    progress.firstPositiveGrade=grade(true,'first-positive-grade');
    progress.firstNegativeGrade=grade(false,'first-negative-grade');
    progress.warmGrades=[];for(let i=0;i<10;i++)progress.warmGrades.push(grade(i%2===0,'warm-grade-'+i));
    progress.warmCalls=[];for(let i=0;i<10;i++){const {value,phase}=timed('warm-arithmetic-'+i,()=>session.evaluate('6*7'));require(value===42,'Warm arithmetic failed');progress.warmCalls.push({value,elapsedMs:phase.elapsedMs});}
    for(const row of data.checks.slice(1))check(row);
    progress.policy=timed('policy',()=>session.evaluate('[STACKpmOPT,algebraic_equivalence_factorp,algebraic_equivalence_trigexpandp,algebraic_equivalence_nounsp,tex_plain_atoms,stackintfmt,stackfltfmt,stackfltsep,setp(FORBIDDEN_SYMBOLS_SET),is(cardinality(FORBIDDEN_SYMBOLS_SET)>0)]')).value;
    require(same(progress.policy,['#pm#',true,true,true,false,'~d','~a','.',true,true]),'STACK policy changed');
    require(data.nativePrograms.length===3&&same(data.nativePrograms.map(r=>r.operation),['prepare','validate','prt']),'Native workload changed');
    progress.nativeCalls=[];for(const program of data.nativePrograms){const {value,phase}=timed('native-'+program.operation,()=>session.evaluate(program.expression));require(same(value,program.expected),'Native result mismatch: '+program.operation);progress.nativeCalls.push({operation:program.operation,result:value,elapsedMs:phase.elapsedMs});}
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
    await new Promise(resolve=>setTimeout(resolve,0)); // Drain already queued diagnostics after every timed block.
    progress.startupGuard=startupResult(startup.state);require(progress.startupGuard.passed,'Final startup stdout guard receipt failed or duplicated');
    progress.correctnessPassed=true;progress.ok=true;progress.phase='complete';
  }catch(error){progress.error=String(error);progress.stack=error.stack;try{activeSession?.terminate();}catch(cleanupError){progress.cleanupError=String(cleanupError);}progress.failedSessionTerminated=activeSession?.poisoned===true&&activeSession?.ready===null;}
  progress.startupGuard=startupResult(startup.state);
  self.postMessage({type:'complete',progress});
};
