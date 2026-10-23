// SPDX-License-Identifier: AGPL-3.0-or-later
// Execute the actual static-host worker, retaining its non-board restrictions.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../../scripts/public-demo/isolation-worker.js',import.meta.url),'utf8');
for(const prefix of ['/','/dept/course/']){
  const root='https://site.test'+prefix;
  const handlers={};let fetched=[];
  const self={location:new URL(root+'ctm-isolation-worker.js'),
    addEventListener:(name,callback)=>{handlers[name]=callback;}};
  vm.runInNewContext(source,{self,URL,Headers,Response,
    fetch:async request=>{fetched.push(request.url);return new Response('original bytes',{
      status:200,headers:{'Content-Type':'text/plain','X-Original':'retained'}});}});
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
}
console.log('actual isolation worker: public board resources only, root and nested hosting pass');
