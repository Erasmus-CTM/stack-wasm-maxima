'use strict';
importScripts('runtime/maxima-session.js');
let activeSession;
self.onmessage=async({data})=>{
  if(data.type==='stop'){activeSession?.terminate();return;}
  const rows=[],progress={phase:'start',correctnessPassed:false,profileRows:rows,phases:[]};
  const send=()=>self.postMessage({type:'progress',progress});
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const require=(ok,message)=>{if(!ok)throw Error(message);};
  const beginPhase=name=>{const row={name,startEpochMs:performance.timeOrigin+performance.now(),completed:false};progress.phases.push(row);return row;};
  const endPhase=row=>{row.endEpochMs=performance.timeOrigin+performance.now();row.elapsedMs=row.endEpochMs-row.startEpochMs;};
  const timedPhase=(name,fn)=>{const row=beginPhase(name);try{const value=fn();row.completed=true;return {value,phase:row};}finally{endPhase(row);}};
  let resolveFlush;const flushed=new Promise(resolve=>{resolveFlush=resolve;});
  try{
    const options={baseURL:new URL('./maxima-runtime/',location.href).href,stackSourceURL:new URL(data.manifest,location.href).href,
      loadTimeoutMs:240000,callTimeoutMs:60000};
    if(data.instrumented)options.childURL=new URL('./runtime-profile/',location.href).href;
    const session=activeSession=new MaximaSession(options),start=performance.now();
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
    progress.readyMs=performance.now()-start;progress.phase='first-logical-validation';send();
    require(session.manifest.stackRevision===data.expected.stackRevision,'STACK pin changed');
    require(String(progress.initialization.stackLibraryVersion)===String(data.expected.stackLibraryVersion),'STACK version changed');
    require(progress.initialization.maximaVersion===data.expected.maximaVersion,'Maxima version changed');
    const stages=progress.initialization.stages;
    require(Number.isFinite(stages.stackLoadMs)&&stages.stackLoadMs>0,'STACK timing missing');
    if(data.candidate==='precompiled'){
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
    progress.phase='complete';progress.ok=true;self.postMessage({type:'complete',progress});
  }catch(error){progress.ok=false;progress.error=String(error);progress.stack=error.stack;self.postMessage({type:'complete',progress});}
  // Keep both worker contexts alive until the host has stopped their CPU samplers.
};
