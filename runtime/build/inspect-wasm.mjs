// SPDX-License-Identifier: AGPL-3.0-or-later
// Structural memory-type check of a dynamic main module; never instantiate it.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const bytes=new Uint8Array(await readFile(process.argv[2]));
new WebAssembly.Module(bytes); // Validate the complete module before inspecting.
let cursor=8;
function uleb(){let result=0,shift=0,part;do{assert.ok(cursor<bytes.length&&shift<53);part=bytes[cursor++];result+=(part&127)*2**shift;shift+=7;}while(part&128);return result;}
function name(){const length=uleb();assert.ok(cursor+length<=bytes.length);const value=new TextDecoder().decode(bytes.subarray(cursor,cursor+length));cursor+=length;return value;}
function valueType(){const type=bytes[cursor++];if(type===0x63||type===0x64)uleb();}
function limits(){const flags=uleb(),minimumPages=uleb(),maximumPages=flags&1?uleb():null;return {flags,minimumPages,maximumPages};}
const memories=[];
while(cursor<bytes.length){
 const id=bytes[cursor++],size=uleb(),end=cursor+size;assert.ok(end<=bytes.length);
 if(id===2){
  const count=uleb();
  for(let i=0;i<count;i++){
   const module=name(),field=name(),kind=bytes[cursor++];
   if(kind===0)uleb();
   else if(kind===1){valueType();limits();}
   else if(kind===2)memories.push({location:'import',module,field,...limits()});
   else if(kind===3){valueType();cursor++;}
   else if(kind===4){uleb();uleb();}
   else throw new Error('Unknown Wasm import kind '+kind);
  }
  assert.equal(cursor,end);
 }
 if(id===5){const count=uleb();for(let i=0;i<count;i++)memories.push({location:'defined',...limits()});assert.equal(cursor,end);}
 cursor=end;
}
assert.equal(memories.length,1);
for(const memory of memories){memory.shared=Boolean(memory.flags&2);memory.memory64=Boolean(memory.flags&4);assert.equal(memory.shared,false);assert.equal(memory.memory64,false);}
console.log(JSON.stringify({schema:1,architecture:'wasm32',memories},null,2));
