importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{
 const report={experiment:data.experiment,observations:[],complete:true};let session;
 try{
  session=new MaximaSession({baseURL:new URL('./maxima-runtime/',location.href).href,stackSourceURL:new URL('probe-sources.json',location.href).href});
  report.initialization=await session.init();
  if(data.experiment==='postmortem-control'){
   report.caught=session.evaluate('block([simp:true,r],ctm_post_deep(n):=if is(n=0) then ?car(?subr) else ctm_post_deep(n-1),r:errcatch(ctm_post_deep(20)),[is(r=[])])');
   session.write(':lisp (setf maxima::$ctm_postmortem_snapshot '+data.snapshotLisp+')\n',60000);
   report.frames=session.evaluate('ctm_postmortem_snapshot');
   report.after=session.evaluate('6*7');
   report.ok=typeof report.frames==='string'&&report.frames.includes('$CTM_POST_DEEP')&&report.after===42;
  }else if(data.experiment==='hook-control'){
   session.write(':lisp (defun maxima::$ctm_injected_car_fault (x) (car x))\n',60000);
   report.injected=session.evaluate('block([r],r:errcatch(ctm_injected_car_fault(?subr)),[is(length(r)=0),ctm_validation_trace])');
   report.after=session.evaluate('6*7');
   report.ok=report.injected[0]===true&&typeof report.injected[1]==='string'&&report.injected[1].includes('SUBR')&&report.injected[1].includes('MEVAL:')&&report.after===42;
  }else{
   for(const [index,row] of data.history.entries()){
    if(row.pauseMs>0)await new Promise(resolve=>setTimeout(resolve,row.pauseMs));
    const result=session.evaluate(row.expression);
    report.observations.push({index,operation:row.operation,result});
   }
   report.target=report.observations.at(-1).result;
   report.repeats=[];
   if(data.experiment==='forced-gc')session.write(':lisp (defun maxima::$ctm_force_gc () (si:gc t) (quote maxima::$done))\n',60000);
   for(let i=0;i<200;i++){
    if(data.experiment==='forced-gc')session.evaluate('ctm_force_gc()');
    const result=session.evaluate(data.history.at(-1).expression);report.repeats.push(result);
    if(result.ans?.valid!==true){report.failureIndex=i;break;}
   }
   report.trace=session.evaluate('ctm_validation_trace');report.after=session.evaluate('6*7');
   report.ok=report.target.ans?.valid===true&&report.repeats.length===200&&report.repeats.every(r=>r.ans?.valid===true)&&report.after===42;
  }
 }catch(error){report.error=String(error);report.stack=error.stack;}
 finally{session?.terminate();}
 self.postMessage(report);
};
