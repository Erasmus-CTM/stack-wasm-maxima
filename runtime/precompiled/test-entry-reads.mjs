// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {posix} from 'node:path';
const directory='/ctm/moodle-qtype_stack-master/stack/maxima';
const entry=directory+'/stackmaxima';
function filesystem() {
  return {fail:false,open(path,flags='r') {
    if(this.fail)throw new Error('Failed open');
    return {path:posix.resolve(directory,path),flags:flags==='w'?1:0};
  },writeFile(path){this.open(path,'w');},mkdirTree(){},ioctl(){},isFile(){return true;},ErrnoError:class {}};
}
const context=vm.createContext({self:{importScripts(){},addEventListener(){}}});
vm.runInContext(await readFile(new URL('../../prototype/runtime/maxima-child.js',import.meta.url),'utf8'),context);
const instrument=vm.runInContext('traceCompiledEntryReads',context);
const fs=filesystem(),stages={compiledStackOpens:0,compiledSourceEntryOpens:0};
instrument(fs,stages,entry);
fs.fail=true;assert.throws(()=>fs.open(entry+'.fas'));fs.fail=false;
assert.equal(stages.compiledStackOpens,0,'Failed open cannot prove a compiled read');
fs.open(entry+'.fas','w');assert.equal(stages.compiledStackOpens,0,'Write cannot prove a compiled read');
fs.open('./stackmaxima.fas');assert.equal(stages.compiledStackOpens,1);
fs.open('../maxima/stackmaxima.mac');assert.equal(stages.compiledSourceEntryOpens,1,'Normalized source read must be detected');

const worker=await readFile(new URL('../../scripts/milestone-one/worker.js',import.meta.url),'utf8');
function probe(reads=[]) {
  const messages=[],FS=filesystem(),Module={preRun:[]};
  const self={postMessage:data=>messages.push(data),importScripts(){},addEventListener(){},onmessage(){
    for(const run of Module.preRun)run();
    for(const path of reads)FS.open(path);
  }};
  vm.runInNewContext(worker,{self,importScripts(){},FS,Module,TextEncoder,
    MEMFS:{ops_table:{dir:{node:{}}}},atob:value=>Buffer.from(value,'base64').toString('binary')});
  self.onmessage({data:{buffers:[],files:[{path:'stack/maxima/stackmaxima.mac',content:'source'},
    {path:'stack/maxima/stackmaxima.fas',encoding:'base64',content:Buffer.from('bundle').toString('base64')}]}});
  return messages.filter(row=>row.type==='m1-fs-open');
}
assert.equal(probe().length,0,'Mounting both files cannot prove either entry was loaded');
const compiled=probe(['./stackmaxima.fas']);
assert.equal(compiled.length,1);assert.equal(compiled[0].path,entry+'.fas');assert.equal(compiled[0].read,true);
assert.equal(probe(['../maxima/stackmaxima.mac'])[0].path,entry+'.mac');
console.log('Actual worker instrumentation: mounting/writes/failed opens excluded; successful normalized reads recorded');
