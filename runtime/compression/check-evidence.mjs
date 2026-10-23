// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSidecars} from './server-source.mjs';
import {hash} from './codec.mjs';
import {expectedRuntimePaths} from '../build/inventory.mjs';
const repository=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const artifact=resolve('.cache/runtime-compression/artifact'),output=resolve('test-results/runtime-compression');
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const normalize=rows=>new Map(rows.map(row=>[row.path,[row.bytes??row.fileBytes,row.sha256]]));
const report={schema:1,passed:false,policies:[]};
try{
 const bytes=await readFile(join(artifact,'compression-manifest.json')),manifest=JSON.parse(bytes);
 const raw=await read(join(artifact,'manifest.json'));
 assert.equal(manifest.toolchain.node,'v22.16.0');assert.equal(manifest.toolchain.platform,'linux');assert.equal(manifest.toolchain.arch,'x64');
 assert.equal(manifest.source.kind,'ctm-owned-build');assert.equal(manifest.source.github.run.conclusion,'success');
 assert.equal(manifest.source.github.artifact.name,'owned-runtime-'+raw.recipe.revision);
 assert.equal(manifest.source.manifestSha256,hash(await readFile(join(artifact,'manifest.json'))));
 for(const row of (await read(join(artifact,'compression-artifact-manifest.json'))).files){
  const body=await readFile(join(artifact,row.path));assert.equal(body.length,row.bytes);assert.equal(hash(body),row.sha256,row.path);
 }
 report.rawRuntimeBytes=raw.runtimeAssets.reduce((n,r)=>n+r.bytes,0);report.originalRuntimeFiles=raw.runtimeAssets.length;const config=JSON.parse(await readFile(join(repository,'runtime/build/configuration.json'),'utf8'));assert.deepEqual(raw.configuration,config);assert.deepEqual(new Set(raw.runtimeAssets.map(row=>row.path)),await expectedRuntimePaths(repository));assert.ok(config.omittedRuntimePaths.every(path=>!raw.runtimeAssets.some(row=>row.path===path)));
 report.packagingTotalsIncludingDerivedPreload=manifest.totals;
 for(const mode of ['gzip','br']){
  await loadSidecars(artifact,mode); // Verify all encoded bytes and decoded hashes.
  const browserPath=join(output,mode,'browser.json'),browserBytes=await readFile(browserPath),browser=JSON.parse(browserBytes);
  assert.equal(browser.passed,true);assert.equal(browser.programs.length,316);
  const sharedBuildPreparations=browser.manifest.programs.length;
  assert.deepEqual(browser.programs.slice(0,sharedBuildPreparations),browser.manifest.programs);
  const compressedSessionPrograms=browser.programs.length-sharedBuildPreparations;assert.ok(compressedSessionPrograms>0);
  assert.deepEqual(normalize(browser.runtime.assets),normalize(raw.runtimeAssets));
  assert.equal(browser.runtime.manifestSha256,manifest.source.stagedManifestSha256);
  const reference=await read(join(output,mode,'reference/native-reference.json'));
  assert.equal(reference.passed,true);assert.equal(reference.summary.programs,316);assert.equal(reference.summary.unaccepted,0);
  assert.equal(reference.browserReport.sha256,hash(browserBytes));assert.deepEqual(reference.wasmRuntime,browser.runtime);
  const requests=browser.serverRequests.filter(row=>row.pathname?.startsWith('/maxima-runtime/'));
  assert.ok(requests.length>0);assert.ok(requests.every(row=>row.sidecarManifestSha256===hash(bytes)));
  assert.ok(requests.some(row=>row.contentEncoding===mode));
  if(mode==='br')assert.ok(requests.some(row=>row.pathname==='/maxima-runtime/maxima.wasm'&&row.contentEncoding==='br'));
  report.policies.push({mode,browserVersion:browser.browserVersion,replay:reference.summary,
   programOrigins:{sharedRawBuildPreparations:sharedBuildPreparations,compressedSessionPrograms,combinedReplayPrograms:browser.programs.length},
   readinessObservations:browser.observation.events.filter(row=>row.data?.event==='runtime-maxima-ready').map(row=>({worker:row.worker,elapsedMs:row.data.elapsedMs,stages:row.data.stages})),
   requestRoundTrips:browser.observation.calls.filter(row=>['validate','grade'].includes(row.type)&&row.response).map(row=>({worker:row.worker,type:row.type,question:row.question,elapsedMs:row.elapsedMs})),
   observationScope:'Readiness events and UI request round trips from this one browser session include cache/deferred-work effects; they are observations, not isolated CAS timings or statistical speed evidence.',
   requests:requests.length,encodedBodyBytes:requests.reduce((n,row)=>n+row.encodedBodyBytes,0),browserReportSha256:hash(browserBytes)});
 }
 const probe=await read(join(output,'http-probe.json'));assert.equal(probe.passed,true);
 assert.ok(probe.requests.some(row=>row.pathname?.startsWith('/maxima-runtime/share/')&&row.method==='HEAD'&&row.contentEncoding==='gzip'));
 assert.ok(probe.requests.some(row=>row.pathname==='/maxima-runtime/maxima.wasm'&&row.method==='GET'&&row.contentEncoding==='br'));
 assert.ok(probe.requests.some(row=>row.range==='bytes=17-107'&&row.contentEncoding==='identity'&&row.status===206));
 assert.ok(probe.requests.filter(row=>row.pathname?.startsWith('/maxima-runtime/')).every(row=>row.sidecarManifestSha256===hash(bytes)));
 report.manifestSha256=hash(bytes);report.httpProbeSha256=hash(await readFile(join(output,'http-probe.json')));report.passed=true;
}catch(error){report.failure=String(error);console.error(error);}
await writeFile(join(output,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
if(!report.passed)process.exitCode=1;
