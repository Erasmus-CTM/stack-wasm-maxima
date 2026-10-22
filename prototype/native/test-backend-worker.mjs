// SPDX-License-Identifier: AGPL-3.0-or-later
// Worker lifecycle only. Real native programs run in the browser CI probe.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
let starts=0, pythonCreations=0, failNext=false;
const replies=[];
const self={location:{href:'https://example.test/native/backend-worker.js'},postMessage:data=>replies.push(data),
  MaximaSession:class{
    constructor(){this.initialization={stages:{}};this.poisoned=false;}
    async init(){starts++;this.poisoned=false;}
    terminate(){this.poisoned=true;}
  },NativePythonBridge:class{constructor(){pythonCreations++;this.state='not-started';}},
  NativeStackEngine:class{
    constructor({session}){this.session=session;}
    async validate(){if(failNext){failNext=false;this.session.poisoned=true;throw Error('injected CAS failure');}return {status:'valid'};}
  }};
const context=vm.createContext({self,URL,performance,importScripts:()=>{},fetch:async()=>({ok:true,json:async()=>({})})});
vm.runInContext(await readFile(new URL('backend-worker.js',import.meta.url),'utf8'),context);
async function send(message){self.onmessage({data:message});await vm.runInContext('queue',context);return replies.findLast(reply=>reply.id===message.id);}
assert.equal((await send({id:1,type:'validate'})).ok,false,'Requests require initialization');
assert.equal((await send({id:2,type:'init',recordPrograms:true})).ok,true);
assert.equal(starts,1);
failNext=true;
const failed=await send({id:3,type:'validate',question:{},variant:{},answers:{}});
assert.equal(failed.ok,false);assert.match(failed.error,/injected CAS/);assert.equal(failed.backend.restarts,1);
const recovered=await send({id:4,type:'validate',question:{},variant:{},answers:{}});
assert.equal(recovered.ok,true);assert.equal(recovered.result.status,'valid');assert.equal(starts,2,'A failed CAS child is recreated on the next request');
assert.equal(pythonCreations,1,'A CAS restart retains the optional Python bridge');
assert.equal((await send({id:5,type:'validate',question:{},variant:{},answers:{}})).ok,true);
assert.equal(starts,2,'A healthy child is reused');
console.log('Native worker lifecycle: explicit initialization, fail-closed error, restart and healthy reuse passed');
