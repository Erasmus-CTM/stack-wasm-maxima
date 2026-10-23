// SPDX-License-Identifier: AGPL-3.0-or-later
// Execute the actual static-host worker, retaining its non-board restrictions.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../../scripts/public-demo/isolation-worker.js',import.meta.url),'utf8');
for(const prefix of ['/','/dept/course/']){
  const root='https://site.test'+prefix;
  const handlers={};let fetched=[];
  let upstream=()=>new Response('original bytes',{
    status:200,headers:{'Content-Type':'text/plain','X-Original':'retained'}});
  const self={location:new URL(root+'ctm-isolation-worker.js'),
    addEventListener:(name,callback)=>{handlers[name]=callback;}};
  vm.runInNewContext(source,{self,URL,Headers,Response,
    fetch:async request=>{fetched.push(request.url);return upstream();}});
  const cases=[
    ['native/boards/assets/exact.js',true,true],
    ['native/boards/mathjax/npm/mathjax@4.1.3/sre/speech-worker.js',true,true],
    ['native/boards/question-b0.html',true,false],
    ['native/boards/nested/question.html',false,false],
    ['native/boards/question.html.txt',false,false],
    ['native/boards/../private.html',false,false],
    ['maxima/native.html',false,false],
    ['native/backend-worker.js',false,false],
    ['native/boards-assets/private.js',false,false],
  ];
  for(const [path,publicResource,cors] of cases){
    let response;
    const request=new Request(new URL(path,root));
    handlers.fetch({request,respondWith:promise=>{response=promise;}});
    const result=await response;
    assert.equal(await result.text(),'original bytes');
    assert.equal(result.headers.get('X-Original'),'retained');
    assert.equal(result.headers.get('Cross-Origin-Opener-Policy'),'same-origin');
    assert.equal(result.headers.get('Cross-Origin-Embedder-Policy'),'require-corp');
    assert.equal(result.headers.get('Cross-Origin-Resource-Policy'),publicResource?'cross-origin':'same-origin',path);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'),cors?'*':null,path);
  }
  const count=fetched.length;
  handlers.fetch({request:new Request('https://external.test/native/boards/assets/x.js'),
    respondWith:()=>assert.fail('external origins retain their own policy')});
  assert.equal(fetched.length,count);
  for(const status of [204,205,304]){
    upstream=()=>({type:'basic',status,statusText:'',headers:new Headers({'X-Original':'retained'}),
      body:new ReadableStream({start(controller){controller.close();}})});
    let response;
    handlers.fetch({request:new Request(root+'empty'),respondWith:value=>{response=value;}});
    const result=await response;
    assert.equal(result.status,status);assert.equal(result.body,null);
    assert.equal(result.headers.get('X-Original'),'retained');
  }
  upstream=()=>new Response('upstream bytes');
  let head;
  handlers.fetch({request:new Request(root+'head',{method:'HEAD'}),respondWith:value=>{head=value;}});
  assert.equal((await head).body,null);
}
console.log('actual isolation worker: public board resources only, root and nested hosting pass');
const bootstrap=await readFile(new URL('../../scripts/public-demo/isolation.js',import.meta.url),'utf8');
for(const state of ['loading','complete']){
  let loaded,mathDone,fontsDone,frameDone,reloads=0;
  const math=new Promise(resolve=>{mathDone=resolve;});
  const fonts=new Promise(resolve=>{fontsDone=resolve;});
  const document={readyState:state,currentScript:{src:'https://site.test/course/ctm-isolation.js'},fonts:{ready:fonts}};
  const window={MathJax:{startup:{promise:math}},requestAnimationFrame(callback){frameDone=callback;},addEventListener(name,callback){assert.equal(name,'load');loaded=callback;}};
  const serviceWorker={controller:{},ready:Promise.resolve(),register:async()=>({})};
  const errors=[];
  vm.runInNewContext(bootstrap,{self:{crossOriginIsolated:false,isSecureContext:true},document,window,
    navigator:{serviceWorker},URL,sessionStorage:{getItem:()=>null,setItem(){}},
    location:{reload(){reloads++;}},console:{error:(...values)=>errors.push(values)}});
  const turn=()=>new Promise(resolve=>setImmediate(resolve));
  await turn();assert.equal(reloads,0);
  if(state==='loading'){assert.equal(typeof loaded,'function');document.readyState='complete';loaded();await turn();}
  mathDone();await turn();assert.equal(reloads,0,'font styles have not reached a layout frame');
  assert.equal(typeof frameDone,'function');frameDone();await turn();assert.equal(reloads,0,'fonts still loading');
  fontsDone();await turn();assert.equal(reloads,0,'loaded fonts have not reached their rendering frame');
  frameDone();await turn();assert.equal(reloads,1);assert.deepEqual(errors,[]);
}
console.log('isolation bootstrap waits for document, MathJax and fonts before first-visit reload');

// public-demo/package.py copies this canonical policy unchanged.
const headers=await readFile(new URL('../../comparison/_headers',import.meta.url),'utf8');
const rules=new Map();let rule;
for(const line of headers.split(/\r?\n/)){if(!line.trim())continue;if(!/^\s/.test(line)){rule={};rules.set(line,rule);}else if(line.trim().startsWith('! ')){rule[line.trim().toLowerCase()]=true;}else{const split=line.indexOf(':');assert.ok(split>0);rule[line.slice(0,split).trim().toLowerCase()]=line.slice(split+1).trim();}}
assert.deepEqual([...rules.keys()],['/*','/native/boards/assets/*','/native/boards/mathjax/*']);
assert.deepEqual(rules.get('/*'),{'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp','cross-origin-resource-policy':'same-origin'});
for(const key of ['/native/boards/assets/*','/native/boards/mathjax/*'])assert.deepEqual(rules.get(key),{'! cross-origin-resource-policy':true,'access-control-allow-origin':'*','cross-origin-resource-policy':'cross-origin'});
console.log('canonical generated-host headers: only public board asset roots permit opaque CORS access');
