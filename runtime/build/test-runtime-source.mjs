// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {loadOwnedRuntime} from './runtime-source.mjs';
import {expectedRuntimePaths} from './inventory.mjs';
const repository=resolve('.'),work=join(repository,'.cache/runtime-build/tests');
await mkdir(work,{recursive:true});
const root=await mkdtemp(join(work,'owned-runtime-'));
const sourcePins=JSON.parse(await readFile(join(repository,'runtime/build/pins.json')));
const body=Buffer.from('fixed asset'),sha256=createHash('sha256').update(body).digest('hex');
const paths=[...await expectedRuntimePaths(repository)];
for(const path of paths){await mkdir(dirname(join(root,'runtime',path)),{recursive:true});await writeFile(join(root,'runtime',path),body);}
const configuration=JSON.parse(await readFile(join(repository,'runtime/build/configuration.json')));
const startup=(await readFile(join(repository,'runtime/build/no-plot.mac'),'utf8')).trim()+'\n';
const compilerProfile=JSON.parse(await readFile(join(repository,'runtime/build/compiler-profiles.json'))).profiles[process.env.CTM_ECL_COMPILER_PROFILE||'baseline'];
const valid={schema:1,compilerProfile,sourcePins,configuration,startupAdapter:{content:startup,sha256:configuration.startupSha256},runtimeAssets:paths.map(path=>({path,bytes:body.length,sha256}))};
valid.sourceIntegrity={schema:1,allVerifiedFilesUnmodified:false,overlays:[JSON.parse(await readFile(join(repository,'runtime/build/patches/ecl-root-scanner.json')))],
 originalArchives:sourcePins.sources.filter(p=>['maxima','ecl'].includes(p.name)).map(p=>({path:'sources/'+p.name+'.tar',sha256:p.archive.sha256})),
 beforeSha256:'0'.repeat(64),hostSourceSha256:'1'.repeat(64),afterSha256:'2'.repeat(64),applicationSha256:'3'.repeat(64)};
async function check(manifest){await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));return loadOwnedRuntime(root,repository);}
try {
 assert.equal(await loadOwnedRuntime(undefined,repository),null);
 assert.equal((await check(valid)).records.size,paths.length);
 const oldPins={...sourcePins};delete oldPins.buildPatches;
 const oldConfiguration={...configuration};delete oldConfiguration.targetSourceOverlaySha256;
 await assert.rejects(()=>check({...valid,sourcePins:oldPins,configuration:oldConfiguration,sourceIntegrity:undefined}),'Unchanged older runtime must not be admitted');
 await assert.rejects(()=>check({...valid,sourceIntegrity:undefined}),'Relabelled older manifest still lacks overlay evidence');
 await assert.rejects(()=>check({...valid,sourceIntegrity:{...valid.sourceIntegrity,allVerifiedFilesUnmodified:true}}));
 await assert.rejects(()=>check({...valid,compilerProfile:undefined}));
 await assert.rejects(()=>check({...valid,compilerProfile:{...compilerProfile,name:"fabricated"}}));
 const profiles=JSON.parse(await readFile(join(repository,'runtime/build/compiler-profiles.json'))).profiles;
 const originalProfile=process.env.CTM_ECL_COMPILER_PROFILE;
 try{
  const alternate=Object.values(profiles).find(profile=>profile.name!==compilerProfile.name);
  const candidate={...valid,compilerProfile:alternate};
  await assert.rejects(()=>check(candidate));
  process.env.CTM_ECL_COMPILER_PROFILE=alternate.name;assert.equal((await check(candidate)).records.size,paths.length);
  await assert.rejects(()=>check(valid));
  process.env.CTM_ECL_COMPILER_PROFILE='unknown';await assert.rejects(()=>check(candidate));
 }finally{if(originalProfile===undefined)delete process.env.CTM_ECL_COMPILER_PROFILE;else process.env.CTM_ECL_COMPILER_PROFILE=originalProfile;}
 await assert.rejects(()=>check({...valid,configuration:undefined}));
 await assert.rejects(()=>check({...valid,startupAdapter:undefined}));
 for(const runtimeAssets of [
  [{...valid.runtimeAssets[0],path:'../escape'}],
  [{...valid.runtimeAssets[0],sha256:'0'.repeat(64)}],
  [{...valid.runtimeAssets[0],bytes:body.length+1}],
  [valid.runtimeAssets[0],valid.runtimeAssets[0]],
 ])await assert.rejects(()=>check({...valid,runtimeAssets}));
 await assert.rejects(()=>check({...valid,sourcePins:{...sourcePins,schema:999}}));
 await check(valid);await writeFile(join(root,'runtime',paths[0]),'changed');
 await assert.rejects(()=>loadOwnedRuntime(root,repository));
 console.log('Owned manifest integrity: valid/default, traversal, digest, size, duplicate, pins and tampering checks passed');
}finally{assert.equal(dirname(resolve(root)),work);await rm(root,{recursive:true,force:true});}
