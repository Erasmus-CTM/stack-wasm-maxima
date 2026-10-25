importScripts('runtime/maxima-session.js');
self.onmessage=async({data})=>{
 const result={complete:true,ok:false,observations:[],diagnostics:[]};let session;
 try{
  session=new MaximaSession({baseURL:new URL('./maxima-runtime/',location.href).href,stackSourceURL:new URL('stack-sources-timed-source.json',location.href).href,loadTimeoutMs:240000,callTimeoutMs:60000,onEvent:e=>{if(e.event==='maxima-diagnostic'&&result.diagnostics.length<200)result.diagnostics.push(e.text)}});
  result.initialization=await session.init();
  for(const [index,row] of data.history.entries())result.observations.push({index,operation:row.operation,question:row.question,result:session.evaluate(row.expression)});
  result.target=result.observations.at(-1).result;result.errormsg=session.evaluate('errormsgtostring()');result.repeatTargets=[];
  for(let i=0;i<3;i++)result.repeatTargets.push({result:session.evaluate(data.history.at(-1).expression),errormsg:session.evaluate('errormsgtostring()')});
  result.ok=true;
 }catch(e){result.error=String(e);result.stack=e.stack;}
 finally{session?.terminate();}
 await new Promise(r=>setTimeout(r,0));self.postMessage(result);
};
