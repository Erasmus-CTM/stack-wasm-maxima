// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic orchestration fixtures only; no claim of Wasm/browser execution.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {encode,hash,brotliSafe} from './codec.mjs';
import {expectedRuntimePaths} from '../build/inventory.mjs';
const repository=resolve('.'),work=join(repository,'.cache/runtime-compression/tests');await mkdir(work,{recursive:true});
const root=await mkdtemp(join(work,'evidence-')),artifact=join(root,'.cache/runtime-compression/artifact'),output=join(root,'test-results/runtime-compression');
const json=async(path,value)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value));};
const load=async path=>JSON.parse(await readFile(path,'utf8'));
async function allFiles(folder){const result=[];for(const row of await readdir(folder,{withFileTypes:true})){const path=join(folder,row.name);if(row.isDirectory())result.push(...await allFiles(path));else result.push(path);}return result;}
async function refreshManifest(){const files=[];for(const path of await allFiles(artifact)){if(path.endsWith('compression-artifact-manifest.json'))continue;const body=await readFile(path);files.push({path:relative(artifact,path).replaceAll('\\','/'),bytes:body.length,sha256:hash(body)});}await json(join(artifact,'compression-artifact-manifest.json'),{schema:1,files});}
function run(expected){const processResult=spawnSync(process.execPath,[join(repository,'runtime/compression/check-evidence.mjs')],{cwd:root,encoding:'utf8'});assert.equal(processResult.status,expected,processResult.stdout+processResult.stderr);}
try{
 const pins=await load(join(repository,'runtime/build/pins.json')),body=Buffer.from('synthetic compression fixture '.repeat(100)),variants=encode(body),rows=[];
 const configuration=await load(join(repository,'runtime/build/configuration.json'));
 const startup=(await readFile(join(repository,'runtime/build/no-plot.mac'),'utf8')).trim()+'\n';
 const paths=[...await expectedRuntimePaths(repository)];
 for(const path of [...paths,'runtime-preload.json']){
  const rawPath=path==='runtime-preload.json'?'derived/'+path:'runtime/'+path;
  await mkdir(dirname(join(artifact,rawPath)),{recursive:true});await writeFile(join(artifact,rawPath),body);
  const encodings={};for(const [encoding,encoded] of Object.entries(variants)){const file='compressed/'+path+'.'+encoding;await mkdir(dirname(join(artifact,file)),{recursive:true});await writeFile(join(artifact,file),encoded);encodings[encoding]={path:file,bytes:encoded.length,sha256:hash(encoded),decodedBytes:body.length,decodedSha256:hash(body)};}
  rows.push({path,bytes:body.length,sha256:hash(body),brotliSafe:brotliSafe(path),encodings});
 }
 const compilerProfile=(await load(join(repository,'runtime/build/compiler-profiles.json'))).profiles.baseline;
 const raw={schema:1,compilerProfile,sourcePins:pins,configuration,startupAdapter:{content:startup,sha256:configuration.startupSha256},recipe:{revision:'a'.repeat(40)},runtimeAssets:rows.filter(row=>row.path!=='runtime-preload.json').map(({path,bytes,sha256})=>({path,bytes,sha256}))};
 await json(join(artifact,'manifest.json'),raw);await json(join(artifact,'artifact-manifest.json'),{schema:1,files:[]});
 const manifest={schema:1,source:{kind:'ctm-owned-build',manifestSha256:hash(await readFile(join(artifact,'manifest.json'))),artifactManifestSha256:hash(await readFile(join(artifact,'artifact-manifest.json'))),stagedManifestSha256:'b'.repeat(64),github:{run:{conclusion:'success'},artifact:{name:'owned-runtime-'+raw.recipe.revision}}},toolchain:{node:'v22.16.0',platform:'linux',arch:'x64'},files:rows,totals:{fixture:true}};
 await json(join(artifact,'compression-manifest.json'),manifest);const manifestSHA=hash(await readFile(join(artifact,'compression-manifest.json')));
 const runtime={assets:raw.runtimeAssets.map(({bytes,...row})=>({...row,fileBytes:bytes})),manifestSha256:manifest.source.stagedManifestSha256};
 for(const mode of ['gzip','br']){
  const programs=Array.from({length:316},(_,i)=>({expression:'fixture-'+i,result:i}));
  const browser={passed:true,browserVersion:'synthetic-fixture',programs,manifest:{programs:programs.slice(0,2)},runtime,observation:{events:[],calls:[]},serverRequests:[{pathname:'/maxima-runtime/maxima.wasm',contentEncoding:mode,sidecarManifestSha256:manifestSHA,encodedBodyBytes:10}]};
  const path=join(output,mode,'browser.json');await json(path,browser);
  await json(join(output,mode,'reference/native-reference.json'),{passed:true,summary:{programs:316,unaccepted:0},browserReport:{sha256:hash(await readFile(path))},wasmRuntime:runtime});
 }
 const probe={passed:true,requests:[{pathname:'/maxima-runtime/'+paths.find(path=>path.startsWith('share/')),method:'HEAD',contentEncoding:'gzip',sidecarManifestSha256:manifestSHA},{pathname:'/maxima-runtime/maxima.wasm',method:'GET',contentEncoding:'br',sidecarManifestSha256:manifestSHA},{pathname:'/maxima-runtime/maxima.wasm',range:'bytes=17-107',status:206,contentEncoding:'identity',sidecarManifestSha256:manifestSHA}]};
 await json(join(output,'http-probe.json'),probe);await refreshManifest();run(0);
 const valid=await load(join(output,'acceptance.json'));assert.deepEqual(valid.policies[0].programOrigins,{sharedRawBuildPreparations:2,compressedSessionPrograms:314,combinedReplayPrograms:316});
 const browserPath=join(output,'br/browser.json'),originalBrowser=await readFile(browserPath);
 let browser=JSON.parse(originalBrowser);browser.programs.pop();await json(browserPath,browser);run(1);await writeFile(browserPath,originalBrowser);
 browser=JSON.parse(originalBrowser);browser.runtime.assets[0].sha256='0'.repeat(64);await json(browserPath,browser);run(1);await writeFile(browserPath,originalBrowser);
 const referencePath=join(output,'br/reference/native-reference.json'),originalReference=await readFile(referencePath);let reference=JSON.parse(originalReference);reference.browserReport.sha256='0'.repeat(64);await json(referencePath,reference);run(1);await writeFile(referencePath,originalReference);
 const originalProbe=await readFile(join(output,'http-probe.json'));probe.requests[2].contentEncoding='br';await json(join(output,'http-probe.json'),probe);run(1);await writeFile(join(output,'http-probe.json'),originalProbe);
 run(0);console.log('Synthetic evidence checker: valid full graph and origin counts pass; missing program, wrong assets, stale replay and compressed range are rejected');
}finally{assert.equal(dirname(root),work);await rm(root,{recursive:true,force:true});}
