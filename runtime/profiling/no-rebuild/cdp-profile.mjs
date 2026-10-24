// Page-root legacy sessions are supported; browser-root auto-attach requires flattening.
export async function startCPUProfiles(page){
  const cdp=await page.context().newCDPSession(page),contexts=[],errors=[],pendingConfigurations=new Set();
  let sequence=0;
  const root={children:new Map(),send:(method,params={})=>cdp.send(method,params)};
  function attach(parent,params){
    const channel={children:new Map(),pending:new Map(),info:params.targetInfo,sessionId:params.sessionId,started:false,detached:false};
    channel.send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{channel.pending.delete(id);reject(Error('CDP timeout: '+method));},10000);
      channel.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      parent.send('Target.sendMessageToTarget',{sessionId:channel.sessionId,message:JSON.stringify({id,method,params})}).catch(error=>{const p=channel.pending.get(id);if(p){channel.pending.delete(id);p.reject(error);}});
    });
    channel.receive=message=>{
      if(message.id){const p=channel.pending.get(message.id);if(p){channel.pending.delete(message.id);message.error?p.reject(Error(JSON.stringify(message.error))):p.resolve(message.result);}return;}
      route(channel,message.method,message.params);
    };
    parent.children.set(channel.sessionId,channel);contexts.push(channel);
    const configure=(async()=>{
      try{
        await channel.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:false});
        if(['worker','page','iframe'].includes(channel.info.type)){
          await channel.send('Profiler.enable');await channel.send('Profiler.setSamplingInterval',{interval:1000});await channel.send('Profiler.start');channel.started=true;
        }
      }catch(error){errors.push({phase:'configure',target:channel.info,error:String(error)});}
      finally{try{await channel.send('Runtime.runIfWaitingForDebugger');}catch(error){errors.push({phase:'resume',target:channel.info,error:String(error)});}}
    })();pendingConfigurations.add(configure);configure.finally(()=>pendingConfigurations.delete(configure));
  }
  function route(parent,method,params={}){
    if(method==='Target.attachedToTarget')attach(parent,params);
    if(method==='Target.receivedMessageFromTarget')parent.children.get(params.sessionId)?.receive(JSON.parse(params.message));
    if(method==='Target.detachedFromTarget'){const channel=parent.children.get(params.sessionId);if(channel)channel.detached=true;}
    if(method==='Target.targetInfoChanged'){const channel=contexts.find(c=>c.info.targetId===params.targetInfo.targetId);if(channel)channel.info=params.targetInfo;}
  }
  for(const method of ['Target.attachedToTarget','Target.receivedMessageFromTarget','Target.detachedFromTarget','Target.targetInfoChanged'])cdp.on(method,params=>route(root,method,params));
  const {targetInfo}=await cdp.send('Target.getTargetInfo');
  await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});await cdp.send('Profiler.start');
  contexts.push({...root,info:targetInfo,started:true,detached:false});
  try{await root.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:false});}
  catch(error){await cdp.send('Profiler.stop').catch(()=>{});throw error;}
  return {async stop(){
    await Promise.allSettled([...pendingConfigurations]);
    const profiles=[];
    await Promise.all(contexts.map(async channel=>{
      if(!channel.started)return;
      try{const {profile}=await channel.send('Profiler.stop');profiles.push({target:channel.info,profile});}
      catch(error){errors.push({phase:'stop',target:channel.info,error:String(error)});}
    }));
    const workers=contexts.filter(x=>x.info.type==='worker'),child=workers.filter(x=>x.info.url.endsWith('/runtime-profile/maxima-child.js'));
    const complete=errors.length===0&&workers.length>=2&&child.length===1&&workers.every(x=>profiles.some(p=>p.target.targetId===x.info.targetId));
    try{await root.send('Target.setAutoAttach',{autoAttach:false,waitForDebuggerOnStart:false,flatten:false});}catch(error){errors.push({phase:'disable',error:String(error)});}
    return {requested:true,attachmentRoot:'page',samplingIntervalMicroseconds:1000,complete:complete&&errors.length===0,contexts:contexts.map(x=>({target:x.info,started:x.started,detached:x.detached})),profiles,errors,scope:'Sampled JS/Wasm stacks from the page and attached nested workers; profiler overhead is present. Samples are not exact function CPU durations.'};
  }};
}
export async function startProcessCPU(browser){
  const cdp=await browser.newBrowserCDPSession(),snapshots=[],errors=[],performanceTimeOriginEpochMs=performance.timeOrigin;let collecting=Promise.resolve();
  const take=()=>{collecting=collecting.then(async()=>{try{const value=await cdp.send('SystemInfo.getProcessInfo'),wallMs=performance.now();snapshots.push({wallMs,epochMs:performanceTimeOriginEpochMs+wallMs,processes:value.processInfo});}catch(error){errors.push(String(error));}});return collecting;};
  await take();const timer=setInterval(take,250);
  return {async stop(){clearInterval(timer);await take();
    const first=new Map((snapshots[0]?.processes||[]).map(p=>[p.id,p])),last=new Map();for(const s of snapshots)for(const p of s.processes)last.set(p.id,p);
    const rows=[...last.values()].map(p=>({id:p.id,type:p.type,startCPUSeconds:first.get(p.id)?.cpuTime||0,lastObservedCPUSeconds:p.cpuTime,deltaCPUSeconds:p.cpuTime-(first.get(p.id)?.cpuTime||0)}));
    return {rows,totalObservedCPUSeconds:rows.reduce((s,r)=>s+r.deltaCPUSeconds,0),performanceTimeOriginEpochMs,snapshots,errors,scope:'Chrome SystemInfo cumulative process CPU seconds from pre-worker baseline to last observation, summed across this fresh browser. Polling stops before Profiler.stop and raw CPU-profile serialization. Snapshot epochMs marks receipt, allowing approximate alignment with parent phase epochs at250ms polling resolution plus protocol latency. Short-lived processes may be undercounted; this includes browser/renderer/utility work, not only CAS. Browser launch before baseline is excluded.'};
  }};
}
