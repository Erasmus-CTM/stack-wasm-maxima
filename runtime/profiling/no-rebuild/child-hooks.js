// Diagnostic-only observers; copied into a new child wrapper, never runtime assets.
(() => {
  'use strict';
  const start = performance.now(), limit = 4096;
  let count = 0, dropped = 0;
  const post = self.postMessage.bind(self);
  const emit = row => {
    try {
      if (count++ >= limit) { dropped++; return; }
      post({type:'ctm-profile', row:{childMs:performance.now()-start, ...row}});
    } catch (_) { dropped++; }
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
    fs.open=function(...args){
      const begin=performance.now();
      try {
        const result=Reflect.apply(original,this,args);
        try { emit({kind:'fs-open',path:typeof result.path==='string'?result.path:fs.getPath(result.node),flags:result.flags,elapsedMs:performance.now()-begin,completed:true}); } catch (_) { dropped++; }
        return result;
      } catch(error) { emit({kind:'fs-open',path:String(args[0]).slice(0,512),elapsedMs:performance.now()-begin,completed:false}); throw error; }
    };
  };
  const line = text => {
    if(!text.startsWith('CTM-PROFILE|'))return;
    try {
      const row=JSON.parse(text.slice('CTM-PROFILE|'.length));
      if(row.kind==='lisp-finish') row.jsDropped=dropped;
      emit(row);
    } catch(error) { emit({kind:'observer-error',error:String(error)}); }
  };
  self.CTMProfile={emit,span,asyncSpan,installFS,line};
  emit({kind:'child-created',timeOrigin:performance.timeOrigin,createdEpochMs:performance.timeOrigin+start});
})();
