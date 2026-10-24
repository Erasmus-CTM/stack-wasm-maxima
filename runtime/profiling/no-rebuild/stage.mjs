import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,stat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
export const digest=body=>createHash('sha256').update(body).digest('hex');
const record=(path,body)=>({path,bytes:Buffer.byteLength(body),sha256:digest(body)});
export function assertProfileAdmission(admission,profile,manifest){
  assert.equal(admission?.schema,1);assert.equal(admission.passed,true,'Successful admission required');
  assert.deepEqual(admission.source,{runId:40108653819,runAttempt:1,head:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',testedRevision:'5295b5a79bfb983f9e43dd911e6f8ab65139a930',tree:'0e543f936a385548a7ffd53d68930bd88c033922'});
  assert.deepEqual(Object.keys(admission.profiles).sort(),['baseline','ecl-oz']);
  const admitted=admission.profiles[profile];assert.ok(admitted);assert.deepEqual(admitted.source,admission.source);
  assert.equal(admitted.compilerProfile.name,profile,'Admitted profile is mislabeled');
  assert.deepEqual(manifest.runtimeBuild.compilerProfile,admitted.compilerProfile,'Staged profile differs from admission');
  assert.equal(manifest.runtimeBuild.manifestSha256,admitted.packageManifest.sha256,'Package identity differs from admission');
  assert.equal(admitted.artifact.id,profile==='baseline'?12567788724:12568085269);
  assert.deepEqual(manifest.runtimeAssets.map(x=>({path:x.path,bytes:x.fileBytes,sha256:x.sha256})),admitted.runtimeAssets.map(x=>({path:x.path,bytes:x.bytes,sha256:x.sha256})));
  return admitted;
}
function once(source,anchor,replacement){assert.equal(source.split(anchor).length,2,'Child source anchor must be unique: '+anchor);return source.replace(anchor,replacement);}
export function instrumentChild(source,hooks){
  source=once(source,"    const ready = /^CTMMAXIMA-READY", "    CTMProfile.line(line);\n    const ready = /^CTMMAXIMA-READY");
  source=once(source,"    const preloaded = await preloadFiles(runtimeBase, data.preload === false ? null : manifest.preload);", "    const preloaded = await CTMProfile.asyncSpan('preload-fetch-decode-hash',()=>preloadFiles(runtimeBase, data.preload === false ? null : manifest.preload));");
  source=once(source,"    const compiledStack = await fetchCompiledStack(runtimeBase, manifest.compiledStack);", "    const compiledStack = await CTMProfile.asyncSpan('fas-fetch-and-verify',()=>fetchCompiledStack(runtimeBase, manifest.compiledStack));");
  source=once(source,"      preInit();", "      CTMProfile.span('emscripten-preInit',()=>preInit());");
  source=once(source,"      stages.wasmReadyMs = performance.now() - started;", "      stages.wasmReadyMs = performance.now() - started;\n      CTMProfile.emit({kind:'wasm-preRun',elapsedFromStartMs:stages.wasmReadyMs});\n      CTMProfile.installFS(FS);\n      const profileMountStart=performance.now();");
  source=once(source,"        traceCompiledEntryReads(FS,stages,entry);\n      }", "        traceCompiledEntryReads(FS,stages,entry);\n      }\n      CTMProfile.emit({kind:'mount-stack-files',elapsedMs:performance.now()-profileMountStart});");
  source=once(source,"      initialized = true;", "      initialized = true;\n      CTMProfile.emit({kind:'child-ready',elapsedFromStartMs:performance.now()-started,startupStdoutTail:stdoutTail.slice(-4096)});");
  return hooks+'\n'+source;
}
export async function stageProfileSite({site,output,trustedRoot,admission,profile}){
  site=resolve(site);output=resolve(output);assert.notEqual(site,output);
  try{await stat(output);throw Error('Refusing to overwrite staged profile '+output);}catch(error){if(error.code!=='ENOENT')throw error;}
  const child=await readFile(join(site,'runtime/maxima-child.js')),session=await readFile(join(site,'runtime/maxima-session.js'));
  assert.deepEqual(child,await readFile(join(trustedRoot,'prototype/runtime/maxima-child.js')));
  assert.deepEqual(session,await readFile(join(trustedRoot,'prototype/runtime/maxima-session.js')));
  const hooks=await readFile(new URL('./child-hooks.js',import.meta.url),'utf8'),lisp=await readFile(new URL('./load-hooks.lisp',import.meta.url),'utf8');
  const manifestNames={source:'stack-sources-timed-source.json',precompiled:'stack-sources-precompiled.json'},manifests={},identities=[];
  const actualPaths=[];
  async function walk(relative=''){for(const entry of await readdir(join(site,relative),{withFileTypes:true})){const path=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())await walk(path);else{assert.equal(entry.isFile(),true,'Nonregular staged entry: '+path);actualPaths.push(path);}}}
  await walk();
  const admitted=admission?.profiles?.[profile];assert.ok(admitted?.stagedFiles,'Exact staged-file admission required');
  assert.equal(new Set(admitted.stagedFiles.map(x=>x.path)).size,admitted.stagedFiles.length);
  assert.deepEqual(actualPaths.sort(),admitted.stagedFiles.map(x=>x.path).sort(),'Staged file set differs from admission');
  for(const row of admitted.stagedFiles){assert.ok(resolve(site,row.path).startsWith(site+'/'),'Unsafe admitted path');const raw=await readFile(join(site,row.path));assert.equal(raw.length,row.bytes);assert.equal(digest(raw),row.sha256,'Staged bytes differ from admission: '+row.path);}
  for(const [candidate,name] of Object.entries(manifestNames)){
    const raw=await readFile(join(site,name)),m=JSON.parse(raw);assert.ok(m.runtimeBuild&&m.preload);
    assertProfileAdmission(admission,profile,m);
    const preload=await readFile(join(site,'maxima-runtime',m.preload.path));assert.equal(preload.length,m.preload.fileBytes);assert.equal(digest(preload),m.preload.sha256);
    assert.ok(m.startup.includes('CTMSTACK-LOAD-BEGIN')&&m.startup.includes('CTMSTACK-LOAD-END'));
    if(candidate==='precompiled'){const fas=await readFile(join(site,'maxima-runtime',m.compiledStack.asset.path));assert.equal(fas.length,m.compiledStack.asset.fileBytes);assert.equal(digest(fas),m.compiledStack.asset.sha256);}else assert.equal(m.compiledStack,undefined);
    manifests[candidate]={name,manifest:m,sha256:digest(raw),bytes:raw.length};identities.push(record(name,raw));
  }
  assert.equal(manifests.source.manifest.runtimeBuild.manifestSha256,manifests.precompiled.manifest.runtimeBuild.manifestSha256);
  assert.deepEqual(manifests.source.manifest.runtimeAssets,manifests.precompiled.manifest.runtimeAssets);
  for(const asset of manifests.source.manifest.runtimeAssets){const raw=await readFile(join(site,'maxima-runtime',asset.path));assert.equal(raw.length,asset.fileBytes);assert.equal(digest(raw),asset.sha256);}
  await mkdir(resolve(output,'..'),{recursive:true});await cp(site,output,{recursive:true,errorOnExist:true,force:false});
  await mkdir(join(output,'runtime-profile'));
  const derived=instrumentChild(child.toString('utf8'),hooks);await writeFile(join(output,'runtime-profile/maxima-child.js'),derived);
  const changes=[{kind:'child-observers',original:record('runtime/maxima-child.js',child),derived:record('runtime-profile/maxima-child.js',derived)}];
  for(const [candidate,item] of Object.entries(manifests)){
    const changed=structuredClone(item.manifest);changed.startup=':lisp '+lisp.trim()+'\n'+changed.startup;
    const body=JSON.stringify(changed)+'\n',name='stack-sources-profile-'+candidate+'.json';await writeFile(join(output,name),body);
    assert.deepEqual(changed.files,item.manifest.files,'Embedded STACK source bytes must remain unchanged');
    item.profileName=name;changes.push({kind:'startup-prefix',candidate,original:identities.find(x=>x.path===item.name),derived:record(name,body)});
  }
  await writeFile(join(output,'no-rebuild-profile.html'),'<!doctype html><meta charset="utf-8"><title>No-rebuild diagnostic profiling</title>');
  await writeFile(join(output,'no-rebuild-probe-worker.js'),await readFile(new URL('./probe-worker.js',import.meta.url)));
  return {site:output,manifests,changes,diagnosticOnly:true,runtimeAssetsChanged:false,embeddedStackFilesChanged:false,hooks:record('child-hooks.js',hooks),lisp:record('load-hooks.lisp',lisp)};
}
