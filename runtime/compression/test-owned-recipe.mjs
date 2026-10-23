// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyOwnedRecipe} from './package.mjs';
import {hash} from './codec.mjs';
const repository=resolve('.'),work=join(repository,'.cache/runtime-compression/tests');await mkdir(work,{recursive:true});
const root=await mkdtemp(join(work,'recipe-'));
try{
 const scope=JSON.parse(await readFile(join(repository,'runtime/build/recipe-inputs.json'),'utf8'));
 const paths=execFileSync('git',['ls-files','-z','--',...scope.directories,...scope.files],{encoding:'utf8'}).split('\0').filter(Boolean);
 const recipe={revision:'a'.repeat(40),files:[]};
 for(const path of paths){const body=await readFile(join(repository,path));await mkdir(resolve(root,'recipe',path,'..'),{recursive:true});await writeFile(join(root,'recipe',path),body);recipe.files.push({path,bytes:body.length,sha256:hash(body)});}
 const save=()=>writeFile(join(root,'manifest.json'),JSON.stringify({recipe}));
 await save();await verifyOwnedRecipe(root,repository);
 const row=recipe.files.find(row=>row.path==='runtime/build/build.sh'),original=await readFile(join(root,'recipe',row.path));
 const stale=Buffer.concat([original,Buffer.from('\n# stale recipe fixture\n')]);
 await writeFile(join(root,'recipe',row.path),stale);row.bytes=stale.length;row.sha256=hash(stale);await save();
 await assert.rejects(()=>verifyOwnedRecipe(root,repository),'Internally consistent older recipe bytes must not match the current checkout');
 await writeFile(join(root,'recipe',row.path),original);row.bytes=original.length;row.sha256=hash(original);
 const omitted=recipe.files.pop();await save();await assert.rejects(()=>verifyOwnedRecipe(root,repository),'Missing recipe inputs must fail');recipe.files.push(omitted);
 await save();await writeFile(join(root,'recipe',row.path),'tampered preserved source');await assert.rejects(()=>verifyOwnedRecipe(root,repository));
 console.log('Exact relevant recipe inventory, stale recipe and preserved-byte tampering checks passed');
}finally{assert.equal(dirname(root),work);await rm(root,{recursive:true,force:true});}
