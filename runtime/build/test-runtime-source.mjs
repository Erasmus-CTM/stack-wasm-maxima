// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {loadOwnedRuntime} from './runtime-source.mjs';
const repository=resolve('.'),work=join(repository,'.cache/runtime-build/tests');
await mkdir(work,{recursive:true});
const root=await mkdtemp(join(work,'owned-runtime-'));
const sourcePins=JSON.parse(await readFile(join(repository,'runtime/build/pins.json')));
const body=Buffer.from('fixed asset'),sha256=createHash('sha256').update(body).digest('hex');
await mkdir(join(root,'runtime'));await writeFile(join(root,'runtime','module.wasm'),body);
const valid={schema:1,sourcePins,runtimeAssets:[{path:'module.wasm',bytes:body.length,sha256}]};
async function check(manifest){await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));return loadOwnedRuntime(root,repository);}
try {
 assert.equal(await loadOwnedRuntime(undefined,repository),null);
 assert.equal((await check(valid)).records.size,1);
 for(const runtimeAssets of [
  [{...valid.runtimeAssets[0],path:'../escape'}],
  [{...valid.runtimeAssets[0],sha256:'0'.repeat(64)}],
  [{...valid.runtimeAssets[0],bytes:body.length+1}],
  [valid.runtimeAssets[0],valid.runtimeAssets[0]],
 ])await assert.rejects(()=>check({...valid,runtimeAssets}));
 await assert.rejects(()=>check({...valid,sourcePins:{...sourcePins,schema:999}}));
 await check(valid);await writeFile(join(root,'runtime','module.wasm'),'changed');
 await assert.rejects(()=>loadOwnedRuntime(root,repository));
 console.log('Owned manifest integrity: valid/default, traversal, digest, size, duplicate, pins and tampering checks passed');
}finally{assert.equal(dirname(resolve(root)),work);await rm(root,{recursive:true,force:true});}
