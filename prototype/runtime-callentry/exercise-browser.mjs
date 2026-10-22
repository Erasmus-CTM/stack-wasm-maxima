// SPDX-License-Identifier: AGPL-3.0-or-later
// Serialized browser-side research driver; the final stack-stress probe is
// isolated at the end of each fresh worker and always has caller watchdogs.
export async function exerciseWorker({mode,manifest,fixtures,question}) {
 const result={isolated:crossOriginIsolated,sab:typeof SharedArrayBuffer,messages:[],recovery:{},longSession:{memoryMetric:'Wasm linear-memory capacity, not live Lisp heap',calls:[],heapSamples:[]}};
 const worker=new Worker(mode==='baseline'?'/baseline.js':'/worker.js');
 let pending=null,phase='startup';
 function waitFor(predicate,timeoutMs) {
  return new Promise(resolve=>{
   const timer=setTimeout(()=>{pending=null;resolve({type:'watchdog-timeout',phase});},timeoutMs);
   pending={predicate,resolve(data){clearTimeout(timer);pending=null;resolve(data);}};
  });
 }
 worker.onmessage=({data})=>{result.messages.push({...data,phase});if(pending?.predicate(data))pending.resolve(data);};
 worker.onerror=event=>{event.preventDefault();const data={type:'worker-error',error:event.message,phase};result.messages.push(data);pending?.resolve(data);};
 async function command(request,timeoutMs=60000) {
  const response=waitFor(data=>data.id===request.id,timeoutMs);worker.postMessage(request);return response;
 }
 try {
  let ready=waitFor(data=>['returned','complete','failure'].includes(data.type),240000);
  worker.postMessage(mode==='baseline'?{fixtures,question}:{type:'start',baseURL:'/maxima-runtime/',manifest,route:mode});
  ready=await ready;
  if(mode==='baseline'){if(ready.type!=='complete')throw new Error('Baseline failed: '+JSON.stringify(ready));return result;}
  if(ready.type!=='returned')throw new Error('Direct startup failed: '+JSON.stringify(ready));
  phase='suite';const suite=waitFor(data=>['complete','failure'].includes(data.type),120000);
  worker.postMessage({type:'suite',fixtures,question});
  const complete=await suite;if(complete.type!=='complete')throw new Error('Direct suite failed: '+JSON.stringify(complete));
  phase='cas-error';result.recovery.casError=await command({id:'cas-error',expression:'error("intentional step-zero CAS error")'});
  result.recovery.afterCas=await command({id:'after-error',expression:'6*7'});
  phase='lisp-error';result.recovery.lispError=await command({id:'lisp-error',lisp:'(error "intentional Lisp-level error")'});
  result.recovery.afterLisp=await command({id:'lisp-recovered',lisp:'(format t "LISPRECOVER|~a~%" (+ 20 22))'});
  result.recovery.lispUnicode=await command({id:'lisp-unicode',lisp:'(format t "LISPUNICODE|~a~%" "\u00e6\u00f8\u00e5\u2212\u03c0")'});
  phase='malformed';result.recovery.malformed=await command({id:'malformed',expression:'('});
  result.recovery.afterMalformed=await command({id:'after-malformed',expression:'6*7'});
  phase='long-session';
  for(let index=0;index<300;index++) {
   const response=await command({id:'sequential-'+index,expression:index+'+1',compact:true});
   if(response.type!=='evaluated'||response.value?.[0]!==true||response.value[1]!==index+1)throw new Error('Sequential call failed at '+index+': '+JSON.stringify(response));
   result.longSession.calls.push({index,result:response.value,elapsedMs:response.elapsedMs});
   if(index===0||(index+1)%50===0)result.longSession.heapSamples.push({completedCalls:index+1,heapBytes:response.heapBytes,wasmStackPointer:response.wasmStackPointer});
  }
  phase='deep-recursion';
  const expression='block([],_ctm_spike_recurse(n):=1+_ctm_spike_recurse(n+1),_ctm_spike_recurse(0))';
  const recursive=await command({id:'deep-recursion',expression},15000);
  phase='after-recursion';const after=await command({id:'after-recursion',expression:'6*7'},3000);
  result.recursion={expression,recursive,after,sameWorker:true,recovered:after.type==='evaluated'&&after.value?.[0]===true&&after.value[1]===42};
  result.recursion.replacementRequired=!result.recursion.recovered;
  result.recursion.outcome=result.recursion.recovered?'recovered':'replace-worker';
  result.recursion.watchdogsMs={recursive:15000,recovery:3000};
 } catch(error) {result.harnessError=String(error.stack||error);}
 finally {worker.terminate();}
 return result;
}
