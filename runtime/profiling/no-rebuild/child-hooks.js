// Diagnostic-only observers; copied into a new child wrapper, never runtime assets.
(() => {
  'use strict';
  const start = performance.now(), ordinaryLimit = 512, priorityLimit = 1024, pathLimit = 512, otherLimit = 64, exampleLimit = 4;
  let ordinaryCount = 0, priorityCount = 0, ordinaryDropped = 0, priorityDropped = 0, observerErrors = 0;
  let fsOpenCalls = 0, fsOpenElapsedMs = 0, fsUnbucketedFileCalls = 0, fsUnbucketedFileElapsedMs = 0, fsUnbucketedOtherCalls = 0, fsUnbucketedOtherElapsedMs = 0;
  const fsPaths = new Map(), fsOthers = new Map();
  const post = self.postMessage.bind(self);
  const emit = row => {
    try {
      const priority=/^lisp-/.test(row.kind)||['child-created','child-ready','fs-summary','observer-error'].includes(row.kind);
      // Completion cannot be displaced by optional high-volume observers.
      if(row.kind!=='lisp-finish') {
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
  const line = text => {
    if(!text.startsWith('CTM-PROFILE|'))return;
    try {
      const row=JSON.parse(text.slice('CTM-PROFILE|'.length));
      if(row.kind==='lisp-finish') {
        emit({kind:'fs-summary',schema:2,pathLimit,otherLimit,exampleLimit,totalOpenCalls:fsOpenCalls,totalOpenElapsedMs:fsOpenElapsedMs,unbucketedFileCalls:fsUnbucketedFileCalls,unbucketedFileElapsedMs:fsUnbucketedFileElapsedMs,unbucketedOtherCalls:fsUnbucketedOtherCalls,unbucketedOtherElapsedMs:fsUnbucketedOtherElapsedMs,paths:[...fsPaths.values()],otherGroups:[...fsOthers.values()]});
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
