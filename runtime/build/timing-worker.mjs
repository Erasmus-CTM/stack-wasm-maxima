// SPDX-License-Identifier: AGPL-3.0-or-later
export const timingWorker=`importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{let session;try {
 session=new MaximaSession({baseURL:'./maxima-runtime/',stackSourceURL:'./stack-sources.json'});
 const started=performance.now(),initialization=await session.init();
 const readyMs=performance.now()-started,calls=[];
 for(let i=0;i<10;i++){const t=performance.now();const value=session.evaluate('6*7');calls.push({expression:'6*7',value,elapsedMs:performance.now()-t});}
 const nativeCalls=[];
 for(const program of data.programs){const t=performance.now();const result=session.evaluate(program.expression);nativeCalls.push({...program,result,elapsedMs:performance.now()-t});}
 session.write(':lisp (defun maxima::$ctm_force_gc () (si:gc t) (quote maxima::$done))\\n',60000);
 const gcCalls=[];
 const retained=session.evaluate('block([],ctm_retained:makelist([i,i^2],i,1,1000),length(ctm_retained))');
 for(let i=0;i<100;i++)gcCalls.push(session.evaluate('block([temporary:makelist(j^3,j,1,2000)],ctm_force_gc(),is(temporary[2000]=8000000000) and is(ctm_retained[1000]=[1000,1000000]) and is(length(ctm_retained)=1000))'));
 const caughtError=session.evaluate('block([r:errcatch(error("CTM deliberate caught CAS error"))],if r=[] then errormsgtostring() else "unexpected")');
 const afterError=session.evaluate('6*7');
 const plotting=[];
 if(data.trimPlot)for(const expression of ['plot2d(x,[x,0,1])','plot(x,[x,0,1])','get_plot_option(plot_format)','gnuplot_close()']){
  const diagnostic=session.evaluate('block([r:errcatch('+expression+')],if r=[] then errormsgtostring() else "unexpected plotting success")');
  plotting.push({expression,diagnostic,afterError:session.evaluate('6*7')});
 }
 self.postMessage({ok:true,readyMs,initialization,calls,nativeCalls,smoke:{retained,gcCalls,caughtError,afterError,plotting,
  scope:'100 separately acknowledged allocations/forced full ECL collections with a retained 1000-element symbolic object; caught CAS error then success in the same worker. This does not change the existing transport fatal-error policy. Linear-memory capacity is not live Lisp heap; no live-heap measurement claimed.'}});
}catch(error){self.postMessage({ok:false,error:String(error),stack:error.stack});}finally{if(session)session.terminate();}};`;
