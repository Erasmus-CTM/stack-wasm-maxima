// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expectedRuntimePaths} from './inventory.mjs';
import {effectivePins} from './toolchain-pins.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function loadOwnedRuntime(source,repository) {
 if(!source)return null;
 const root=resolve(source),bytes=await readFile(resolve(root,'manifest.json'));
 const manifest=JSON.parse(bytes);
 const pins=await effectivePins(repository);
 assert.equal(manifest.schema,1);assert.deepEqual(manifest.sourcePins,pins,'Owned runtime must match the exact current source pins');
 const profiles=JSON.parse(await readFile(resolve(repository,'runtime/build/compiler-profiles.json')));
 const profile={...profiles.profiles,...profiles.experimentalProfiles}[process.env.CTM_ECL_COMPILER_PROFILE||'baseline'];
 assert.ok(profile,'Unknown compiler experiment');assert.deepEqual(manifest.compilerProfile,profile,'Current compiler profile differs');
 const configuration=JSON.parse(await readFile(resolve(repository,'runtime/build/configuration.json')));
 assert.deepEqual(manifest.configuration,configuration,'Current candidates require the exact no-gnuplot configuration');
 const descriptorBytes=await readFile(resolve(repository,'runtime/build/patches/ecl-root-scanner.json'));
 const overlay=JSON.parse(descriptorBytes),integrity=manifest.sourceIntegrity;
 assert.equal(hash(descriptorBytes),configuration.targetSourceOverlaySha256);
 assert.equal(integrity?.schema,1);assert.equal(integrity.allVerifiedFilesUnmodified,false);
 assert.deepEqual(integrity.overlays,[overlay],'Prepared runtime requires the current declared target overlay');
 assert.deepEqual(integrity.originalArchives,pins.sources.filter(p=>['maxima','ecl'].includes(p.name)).map(p=>({path:'sources/'+p.name+'.tar',sha256:p.archive.sha256})));
 for(const key of ['beforeSha256','hostSourceSha256','afterSha256','applicationSha256'])assert.match(integrity[key],/^[0-9a-f]{64}$/);
 const startup=(await readFile(resolve(repository,'runtime/build/no-plot.mac'),'utf8')).trim()+'\n';
 assert.deepEqual(manifest.startupAdapter,{content:startup,sha256:configuration.startupSha256});
 assert.equal(hash(await readFile(resolve(repository,'runtime/build/no-plot.mac'))),configuration.startupSha256);
 assert.ok(Array.isArray(manifest.runtimeAssets)&&manifest.runtimeAssets.length>0);
 const records=new Map();
 for(const record of manifest.runtimeAssets) {
  assert.equal(typeof record.path,'string');
  assert.ok(record.path&&!record.path.includes('\\')&&!record.path.startsWith('/')&&!record.path.includes(':')&&record.path.split('/').every(p=>p&&p!=='.'&&p!=='..'));
  assert.ok(!records.has('/'+record.path),'Duplicate owned asset');
  assert.match(record.sha256,/^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(record.bytes)&&record.bytes>=0);
  const content=await readFile(resolve(root,'runtime',record.path));
  assert.equal(content.length,record.bytes,record.path);assert.equal(hash(content),record.sha256,record.path);
  records.set('/'+record.path,{...record,fileBytes:record.bytes});
 }
 for(const path of manifest.configuration?.omittedRuntimePaths||[])assert.ok(!records.has('/'+path),'Omitted file present in candidate manifest');
 assert.deepEqual(new Set([...records.keys()].map(path=>path.slice(1))),await expectedRuntimePaths(repository),'Current candidate inventory must match the exact no-gnuplot closure');
 return {root:resolve(root,'runtime'),records,startup,omittedRuntimePaths:manifest.configuration?.omittedRuntimePaths||[],provenance:{kind:'ctm-owned-build',manifestSha256:hash(bytes),sourcePins:pins,compilerProfile:profile}};
}
