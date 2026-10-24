// Diagnostic-only observers; copied into a new child wrapper, never runtime assets.
(() => {
  'use strict';
  const start = performance.now(), ordinaryLimit = 512, priorityLimit = 1200, pathLimit = 512, otherLimit = 64, exampleLimit = 4;
  let ordinaryCount = 0, priorityCount = 0, ordinaryDropped = 0, priorityDropped = 0, observerErrors = 0;
  let fsOpenCalls = 0, fsOpenElapsedMs = 0, fsUnbucketedFileCalls = 0, fsUnbucketedFileElapsedMs = 0, fsUnbucketedOtherCalls = 0, fsUnbucketedOtherElapsedMs = 0;
  const fsPaths = new Map(), fsOthers = new Map();
  const traceStack=[],traceFrameLimit=512,traceDepthLimit=64;
  let tracing=false,traceSerial=0,traceCompleted=0,traceDropped=0;
  const post = self.postMessage.bind(self);
  const emit = row => {
    try {
      const priority=/^(?:lisp|trace)-/.test(row.kind)||['child-created','child-ready','fs-summary','observer-error'].includes(row.kind);
      // Completion cannot be displaced by optional high-volume observers.
      if(row.kind!=='trace-finish') {
        if(priority) { if(priorityCount++>=priorityLimit){priorityDropped++;return;} }
        else if(ordinaryCount++>=ordinaryLimit){ordinaryDropped++;return;}
      }
      post({type:'ctm-profile', row:{childMs:performance.now()-start, ...row}});
    } catch (_) { observerErrors++; }
  };
  const span = (name, fn) => {
    const begin=performance.now();
    emit({kind:'js-span-begin',name});
    try { const value=fn(); emit({kind:'js-span',name,elapsedMs:performance.now()-begin,completed:true}); return value; }
    catch(error) { emit({kind:'js-span',name,elapsedMs:performance.now()-begin,completed:false}); throw error; }
  };
  const asyncSpan = async (name, fn) => {
    const begin=performance.now();
    emit({kind:'js-span-begin',name});
    try { const value=await fn(); emit({kind:'js-span',name,elapsedMs:performance.now()-begin,completed:true}); return value; }
    catch(error) { emit({kind:'js-span',name,elapsedMs:performance.now()-begin,completed:false}); throw error; }
  };
  const imports=self.importScripts;
  self.importScripts=function(...urls){return span('importScripts:'+urls.join(','),()=>Reflect.apply(imports,this,urls));};
  for(const name of ['compile','compileStreaming','instantiate','instantiateStreaming']) {
    const original=WebAssembly[name];
    if(typeof original==='function') WebAssembly[name]=function(...args){return asyncSpan('WebAssembly.'+name,()=>Reflect.apply(original,this,args));};
  }
  const installFS = fs => {
    const original=fs.open;
    const record=(path,flags,completed,elapsedMs,errorCode,kind)=>{
      try {
        fsOpenCalls++;fsOpenElapsedMs+=elapsedMs;
        const fullName=String(path),name=fullName.slice(0,512);
        if(completed&&kind==='regular-file'){
          const key=JSON.stringify([name,flags]);let row=fsPaths.get(key);
          if(fullName.length>512||(!row&&fsPaths.size>=pathLimit)){fsUnbucketedFileCalls++;fsUnbucketedFileElapsedMs+=elapsedMs;return;}
          if(!row){row={path:name,flags,completed:true,kind,opens:0,openElapsedMs:0};fsPaths.set(key,row);}
          row.opens++;row.openElapsedMs+=elapsedMs;return;
        }
        const key=JSON.stringify([kind,flags,errorCode]);let row=fsOthers.get(key);
        if(!row){if(fsOthers.size>=otherLimit){fsUnbucketedOtherCalls++;fsUnbucketedOtherElapsedMs+=elapsedMs;return;}row={kind,flags,completed,errorCode,opens:0,openElapsedMs:0,examples:[]};fsOthers.set(key,row);}
        if(row.examples.length<exampleLimit&&!row.examples.some(p=>p.path===name))row.examples.push({path:name,truncated:fullName.length>512});
        row.opens++;row.openElapsedMs+=elapsedMs;
      }catch(_){observerErrors++;}
    };
    fs.open=function(...args){
      const begin=performance.now();
      try {
        const result=Reflect.apply(original,this,args);
        try {
          const elapsedMs=performance.now()-begin,mode=result.node?.mode;
          const kind=!Number.isInteger(mode)?'unknown':(mode&61440)===32768?'regular-file':(mode&61440)===16384?'directory':'other';
          record(typeof result.path==='string'?result.path:fs.getPath(result.node),result.flags,true,elapsedMs,null,kind);
        } catch (_) { observerErrors++; }
        return result;
      } catch(error) { record(args[0],['string','number'].includes(typeof args[1])?args[1]:null,false,performance.now()-begin,Number.isInteger(error?.errno)?error.errno:null,'failure'); throw error; }
    };
  };
  const traceAtom=text=>{
    if(text.length>2048)throw Error('Trace argument exceeds bound');
    if(text.startsWith('"')){
      let value='';for(let i=1;i<text.length;i++){
        const ch=text[i];if(ch==='"'){if(i!==text.length-1)throw Error('Multiple trace values');return {kind:'string',value};}
        if(ch==='\\'){if(++i>=text.length)throw Error('Incomplete trace string escape');value+=text[i];}else value+=ch;
        if(value.length>512)throw Error('Trace string exceeds bound');
      }throw Error('Unterminated trace string');
    }
    if(!/^[A-Za-z0-9_$:+*.\/-]{1,512}$/.test(text))throw Error('Unsupported trace argument');
    return {kind:'symbol',value:text};
  };
  const traceLine=text=>{
    const marker=/(?:^|[\s|])(?:(\d+)>|<(\d+))\s+\((?:MAXIMA:{1,2})?\$LOAD\s+(.+)\)\s*$/i.exec(text);
    if(!marker){if(/(?:\d+>|<\d+)\s+\((?:MAXIMA:{1,2})?\$LOAD/i.test(text))throw Error('Malformed LOAD trace line');return;}
    if(!tracing)throw Error('LOAD trace outside active interval');
    const level=Number(marker[1]||marker[2]),atom=traceAtom(marker[3]),time=performance.now()-start;
    if(marker[1]){
      if(level!==traceStack.length+1||level>traceDepthLimit)throw Error('Unexpected LOAD trace entry depth');
      const id=++traceSerial,frame={id,parent:traceStack.at(-1)?.id||0,depth:level-1,name:atom.value,argumentKind:atom.kind,operation:'maxima-load',startMs:time,kept:id<=traceFrameLimit};
      traceStack.push(frame);if(frame.kept)emit({kind:'trace-enter',...frame});else traceDropped++;
    }else{
      const frame=traceStack.at(-1);if(!frame||level!==traceStack.length)throw Error('Unmatched LOAD trace return');
      traceStack.pop();if(frame.kept){traceCompleted++;emit({kind:'trace-call',...frame,endMs:time,returnedValue:atom.value,returnKind:atom.kind,resolvedPath:atom.kind==='string'&&atom.value.startsWith('/')?atom.value:null,completed:true});}
    }
  };
  const line = text => {
    try {
      if(!text.startsWith('CTM-PROFILE|')){traceLine(text);return;}
      const row=JSON.parse(text.slice('CTM-PROFILE|'.length));
      if(row.kind==='trace-start'){if(tracing||traceSerial||row.active!==true)throw Error('Invalid/duplicate trace start');tracing=true;}
      if(row.kind==='trace-finish') {
        if(!tracing)throw Error('Trace finish without start');tracing=false;
        emit({kind:'fs-summary',schema:2,pathLimit,otherLimit,exampleLimit,totalOpenCalls:fsOpenCalls,totalOpenElapsedMs:fsOpenElapsedMs,unbucketedFileCalls:fsUnbucketedFileCalls,unbucketedFileElapsedMs:fsUnbucketedFileElapsedMs,unbucketedOtherCalls:fsUnbucketedOtherCalls,unbucketedOtherElapsedMs:fsUnbucketedOtherElapsedMs,paths:[...fsPaths.values()],otherGroups:[...fsOthers.values()]});
        row.observed=traceCompleted;row.entries=traceSerial;row.openFrames=traceStack.length;row.dropped=traceDropped;row.observerErrors=observerErrors;
        row.jsDropped=priorityDropped+observerErrors;
        row.ordinaryEventsDropped=ordinaryDropped;
        row.fsUnbucketedOpenCalls=fsUnbucketedFileCalls+fsUnbucketedOtherCalls;
      }
      emit(row);
    } catch(error) { observerErrors++;emit({kind:'observer-error',error:String(error)}); }
  };
  self.CTMProfile={emit,span,asyncSpan,installFS,line};
  emit({kind:'child-created',timeOrigin:performance.timeOrigin,createdEpochMs:performance.timeOrigin+start});
})();
