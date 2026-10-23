// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {cp,readFile,readdir,mkdir,writeFile,stat,realpath} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {hash,encode,settings,brotliSafe} from './codec.mjs';
import {loadOwnedRuntime} from '../build/runtime-source.mjs';

async function files(root){
 const result=[];
 async function visit(folder){for(const entry of await readdir(folder,{withFileTypes:true})){
  const path=join(folder,entry.name);assert.ok(!entry.isSymbolicLink(),'Artifact must be self-contained, without symbolic links');
  if(entry.isDirectory())await visit(path);else {assert.ok(entry.isFile());result.push(path);}
 }}
 await visit(root);return result.sort();
}
export async function verifyOwnedRecipe(source,repository){
 const raw=JSON.parse(await readFile(join(source,'manifest.json')));
 assert.match(raw.recipe.revision,/^[0-9a-f]{40}$/);
 const scope=JSON.parse(await readFile(join(repository,'runtime/build/recipe-inputs.json'),'utf8'));
 assert.equal(scope.schema,1);
 const relevant=[...scope.directories,...scope.files];
 const expected=execFileSync('git',['ls-files','-z','--',...relevant],{cwd:repository,encoding:'utf8'}).split('\0').filter(Boolean);
 assert.deepEqual(new Set(raw.recipe.files.map(row=>row.path)),new Set(expected),'Owned artifact must use the exact current relevant tracked recipe inventory');
 assert.equal(raw.recipe.files.length,expected.length);
 for(const row of raw.recipe.files){
  const current=await readFile(join(repository,row.path)),preserved=await readFile(join(source,'recipe',row.path));
  assert.equal(current.length,row.bytes,row.path);assert.equal(hash(current),row.sha256,'Owned artifact recipe differs from current checkout: '+row.path);
  assert.deepEqual(preserved,current,'Preserved recipe bytes differ: '+row.path);
 }
 return raw.recipe;
}
export async function compressArtifact({source,output,site,sourceRunJSON,repository=resolve('.')}){
 assert.equal(process.version,'v22.16.0','Artifact compression requires the SHA-verified pinned SDK Node 22.16.0');
 source=await realpath(resolve(source));output=resolve(output);site=await realpath(resolve(site));
 const within=relative(source,output);assert.ok(isAbsolute(within)||within==='..'||within.startsWith('../')||within.startsWith('..\\'),'Output must not be inside the input artifact');
 await assert.rejects(()=>stat(output),error=>error.code==='ENOENT','Output must be a fresh directory; previous evidence is retained');
 const owned=await loadOwnedRuntime(source,repository);
 await verifyOwnedRecipe(source,repository);
 const sourceManifest=await readFile(join(source,'artifact-manifest.json'));
 const input=JSON.parse(sourceManifest);
 const sourceFiles=await files(source);
 assert.equal(input.schema,1);
 assert.deepEqual(new Set(sourceFiles.map(path=>relative(source,path).replaceAll('\\','/'))),new Set([...input.files.map(row=>row.path),'artifact-manifest.json']),'Every copied input file must be manifested');
 assert.equal(new Set(input.files.map(row=>row.path)).size,input.files.length);
 for(const record of input.files){
  const path=resolve(source,record.path),rel=relative(source,path);
  assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..')&&!record.path.includes('\\'));
  const body=await readFile(path);assert.equal(body.length,record.bytes,record.path);assert.equal(hash(body),record.sha256,record.path);
 }
 const stagedBytes=await readFile(join(site,'stack-sources.json')),staged=JSON.parse(stagedBytes);
 assert.equal(staged.runtimeBuild.manifestSha256,owned.provenance.manifestSha256);
 assert.deepEqual(staged.runtimeBuild.sourcePins,owned.provenance.sourcePins);
 assert.equal(staged.preload.path,'runtime-preload.json');
 const preload=await readFile(join(site,'maxima-runtime',staged.preload.path));
 assert.equal(preload.length,staged.preload.fileBytes);assert.equal(hash(preload),staged.preload.sha256);
 // Every original source, notice, raw runtime byte and original manifest is retained.
 await cp(source,output,{recursive:true,errorOnExist:true,force:false});
 await mkdir(join(output,'derived'),{recursive:true});await writeFile(join(output,'derived/runtime-preload.json'),preload);
 const toolchainArchive=JSON.parse(await readFile(resolve(repository,'.cache/runtime-compression/node-provenance.json')));
 const pins=JSON.parse(await readFile(resolve(repository,'runtime/build/pins.json')));
 const nodePin=pins.toolchainArchives.find(row=>row.name==='sdk-node-linux-x86_64');
 assert.equal(toolchainArchive.verified,true);assert.equal(toolchainArchive.sha256,nodePin.sha256);
 assert.equal(hash(await readFile(process.execPath)),toolchainArchive.executableSha256);
 const toolLicence=await readFile(resolve(repository,'.cache/runtime-compression/NODE-TOOL-LICENSE'));
 assert.equal(hash(toolLicence),toolchainArchive.licenceSha256);
 await writeFile(join(output,'NODE-TOOL-LICENSE'),toolLicence);
 const report={schema:1,sourceRevision:process.env.GITHUB_SHA||null,
  source:{kind:'ctm-owned-build',manifestSha256:owned.provenance.manifestSha256,artifactManifestSha256:hash(sourceManifest),stagedManifestSha256:hash(stagedBytes),files:sourceFiles.length},
  toolchain:{node:process.version,zlib:process.versions.zlib,brotli:process.versions.brotli,platform:process.platform,arch:process.arch,archive:toolchainArchive},settings,
  policy:'Both encodings are retained for size comparisons. Brotli delivery is limited to ordinary-fetch main Wasm/JavaScript/preload; lazy modules/share files use gzip because this Emscripten loader recognizes only gzip. Range requests use identity.',
  files:[]};
 if(sourceRunJSON){
  const provenance=await readFile(resolve(sourceRunJSON)),run=JSON.parse(provenance);
  assert.equal(run.run.conclusion,'success');
  const raw=JSON.parse(await readFile(join(source,'manifest.json')));
  assert.equal(run.artifact.name,'owned-runtime-'+raw.recipe.revision,'Downloaded artifact must identify the actual build recipe revision');
  assert.equal(run.recipe.revision,raw.recipe.revision);
  assert.ok(run.recipe.revision===run.run.head_sha||run.recipe.parents.includes(run.run.head_sha),'Actual recipe revision must equal or directly merge the source-run head');
  report.source.github=run;await writeFile(join(output,'owned-build-run.json'),provenance);
 }
 const candidates=[...owned.records.values()].map(row=>({path:row.path,bytes:row.bytes,sha256:row.sha256,rawPath:'runtime/'+row.path}));
 candidates.push({path:'runtime-preload.json',bytes:preload.length,sha256:hash(preload),rawPath:'derived/runtime-preload.json'});
 for(const row of candidates.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)){
  const body=await readFile(join(output,row.rawPath));assert.equal(hash(body),row.sha256);assert.equal(body.length,row.bytes);
  const result={...row,kind:row.path==='runtime-preload.json'?'derived-preload':({'.wasm':'main-wasm','.so':'wasm-side-module','.fas':'wasm-side-module','.js':'javascript','.lisp':'lisp-source','.mac':'maxima-source'}[extname(row.path)]||'other'),brotliSafe:brotliSafe(row.path),encodings:{}};
  if(body.length>=settings.minimumBytes)for(const [encoding,encoded] of Object.entries(encode(body))){
   const path='compressed/'+row.path+(encoding==='gzip'?'.gz':'.br');
   await mkdir(resolve(output,path,'..'),{recursive:true});await writeFile(join(output,path),encoded);
   result.encodings[encoding]={path,bytes:encoded.length,sha256:hash(encoded),decodedBytes:body.length,decodedSha256:hash(body),...(encoding==='gzip'?{headerMtime:encoded.readUInt32LE(4),headerOS:encoded[9]}:{})};
  }
  report.files.push(result);
  console.log(JSON.stringify({path:row.path,rawBytes:row.bytes,gzipBytes:result.encodings.gzip?.bytes,brBytes:result.encodings.br?.bytes}));
 }
 report.totals={rawBytes:report.files.reduce((n,r)=>n+r.bytes,0),allGzipSidecarsBytes:report.files.reduce((n,r)=>n+(r.encodings.gzip?.bytes??r.bytes),0),allBrotliSidecarsBytes:report.files.reduce((n,r)=>n+(r.encodings.br?.bytes??r.bytes),0),gzipDeliveryBytesOneFetchPerFile:report.files.reduce((n,r)=>n+Math.min(r.bytes,r.encodings.gzip?.bytes??r.bytes),0),brotliSafeDeliveryBytesOneFetchPerFile:report.files.reduce((n,r)=>n+Math.min(r.bytes,(r.brotliSafe?r.encodings.br:r.encodings.gzip)?.bytes??r.bytes),0)};
 report.byKind={};for(const row of report.files){const group=report.byKind[row.kind]??={files:0,rawBytes:0,gzipBytes:0,brBytes:0};group.files++;group.rawBytes+=row.bytes;group.gzipBytes+=row.encodings.gzip?.bytes??row.bytes;group.brBytes+=row.encodings.br?.bytes??row.bytes;}
 await writeFile(join(output,'compression-manifest.json'),JSON.stringify(report,null,2)+'\n');
 const recipe={revision:process.env.GITHUB_SHA||null,files:[]};
 const recipePaths=[...await files(resolve(repository,'runtime/compression')),resolve(repository,'scripts/milestone-two/serve.mjs'),resolve(repository,'.github/workflows/runtime-compression.yml')].filter(path=>!path.includes('__pycache__'));
 for(const path of recipePaths){const body=await readFile(path),rel=relative(repository,path).replaceAll('\\','/');await mkdir(resolve(output,'compression-recipe',rel,'..'),{recursive:true});await writeFile(join(output,'compression-recipe',rel),body);recipe.files.push({path:rel,bytes:body.length,sha256:hash(body)});}
 await writeFile(join(output,'compression-recipe.json'),JSON.stringify(recipe,null,2)+'\n');
 await writeFile(join(output,'COMPRESSION-NOTICES.md'),'# Lossless compression artifact\n\nThe original runtime bytes, canonical hashes, licences, full sources and owned-build provenance remain unchanged. gzip/Brotli sidecars are reversible encodings, not rebuilt or trimmed runtime files. Original notices remain applicable. New compression automation is AGPL-3.0-or-later; exact scripts and toolchain identities are retained in compression-recipe.json and compression-manifest.json. The original artifact-manifest.json describes the preserved input bundle; compression-artifact-manifest.json inventories the whole augmented bundle.\n');
 const rows=['# Lossless sidecar size observations','','Raw files, upstream notices and source manifest are preserved. No trim or compiler flag changes.','','| Path | Kind | Raw bytes | gzip-9 | Brotli-11 | Brotli delivery allowed |','|---|---|---:|---:|---:|---|',...report.files.map(r=>`| ${r.path} | ${r.kind} | ${r.bytes} | ${r.encodings.gzip?.bytes??'identity'} | ${r.encodings.br?.bytes??'identity'} | ${r.brotliSafe?'yes':'gzip for lazy loader'} |`),'',JSON.stringify(report.totals),'','runtime-preload.json is a derived package, shown separately from the original 81 raw runtime files; its bytes duplicate files already represented in that inventory. Totals including it are packaging totals, not unique-runtime totals. All-Brotli sidecar bytes are a size comparison only; lazy resources use gzip. Delivery totals assume one fetch per packaged file and exclude headers/cache behavior; actual browser request byte counts are separate.'];
 await writeFile(join(output,'compression-sizes.md'),rows.join('\n')+'\n');
 const manifest=[];for(const path of await files(output)){const body=await readFile(path);manifest.push({path:relative(output,path).replaceAll('\\','/'),bytes:body.length,sha256:hash(body)});}
 await writeFile(join(output,'compression-artifact-manifest.json'),JSON.stringify({schema:1,files:manifest},null,2)+'\n');
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf('--'+name);assert.ok(i>=0&&args[i+1],'Missing --'+name);return args[i+1];};
 const at=args.indexOf('--source-run-json');
 await compressArtifact({source:option('source'),output:option('output'),site:option('site'),sourceRunJSON:at>=0?args[at+1]:undefined});
}
