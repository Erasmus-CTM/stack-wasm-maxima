import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const directory=await mkdtemp(join(tmpdir(),'ctm-v3-admission-'));
try {
  for(const name of ['run.mjs','derive-startup-observer.mjs','startup-observer.jsfrag'])
    await cp(new URL(name,import.meta.url),join(directory,name));
  const binding=JSON.parse(await readFile(new URL('candidate-binding.json',import.meta.url)));
  binding.ready=true;binding.source.tree='f'.repeat(40);binding.source.recipeFiles=100;
  await writeFile(join(directory,'candidate-binding.json'),JSON.stringify(binding));
  const runner=await import(pathToFileURL(join(directory,'run.mjs')));
  const plan=runner.trialPlan(10);assert.equal(plan.length,20);
  assert.equal(plan.flatMap(pair=>pair.modes).length,40);
  for(let n=1;n<=10;n++){
    const pairs=plan.filter(p=>p.repetition===n);
    assert.deepEqual(pairs.map(p=>p.profile),n%2?runner.profiles:[...runner.profiles].reverse());
    assert.ok(pairs.every(p=>p.candidate==='source'));
  }
  assert.throws(()=>runner.trialPlan(1));
  const old={runId:40108653819,runAttempt:1,head:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',testedRevision:'5295b5a79bfb983f9e43dd911e6f8ab65139a930',tree:'0e543f936a385548a7ffd53d68930bd88c033922',trustedRevision:'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',recipeFiles:71};
  const nativePrograms=['prepare','validate','prt'].map(operation=>({operation,expression:'fixture',expected:true}));
  const assets=Array.from({length:79},(_,i)=>({path:'asset-'+i,bytes:i+1,sha256:'a'.repeat(64)}));
  const admission={schema:1,passed:true,nativePrograms,profiles:{}};
  for(const [i,name] of runner.profiles.entries()){
    const source=name==='ecl-oz'?old:binding.source;
    admission.profiles[name]={source,compilerProfile:{name},packageManifest:{sha256:String(i).repeat(64)},
      runtimeAssets:assets,nativePrograms,benchmarkNativePrograms:nativePrograms,artifact:{id:i+1,name:(i?'owned-runtime-':'precompiled-stack-probe-')+name+'-'+source.testedRevision,
      digest:'sha256:'+'b'.repeat(64),size_in_bytes:100,workflow_run:{id:source.runId,head_sha:source.head}}};
  }
  const manifest=name=>({runtimeBuild:{compilerProfile:{name},manifestSha256:admission.profiles[name].packageManifest.sha256},
    runtimeAssets:assets.map(r=>({path:r.path,fileBytes:r.bytes,sha256:r.sha256})),files:Array.from({length:77},(_,i)=>({path:'stack/'+i}))});
  for(const name of runner.profiles)runner.validateAdmission(admission,name,manifest(name));
  for(const mutate of [
    a=>{a.passed=false;},
    a=>{a.profiles['ecl-oz-maxima-oz'].source={...old};},
    a=>{a.profiles['ecl-oz-maxima-oz'].artifact.name='maxima-oz-candidate-old';},
    a=>{a.profiles['ecl-oz-maxima-oz'].artifact.workflow_run.head_sha='0'.repeat(40);},
    a=>{a.profiles['ecl-oz-maxima-oz'].runtimeAssets=[...assets.slice(1),assets[1]];},
    a=>{a.profiles['ecl-oz-maxima-oz'].benchmarkNativePrograms=[...nativePrograms].reverse();}
  ]){const changed=structuredClone(admission);mutate(changed);assert.throws(()=>runner.validateAdmission(changed,'ecl-oz-maxima-oz',manifest('ecl-oz-maxima-oz')));}
  const bad=manifest('ecl-oz-maxima-oz');bad.runtimeBuild.manifestSha256='0'.repeat(64);
  assert.throws(()=>runner.validateAdmission(admission,'ecl-oz-maxima-oz',bad));
  binding.ready=false;await writeFile(join(directory,'candidate-binding.json'),JSON.stringify(binding));
  const blocked=await import(pathToFileURL(join(directory,'run.mjs')).href+'?blocked');
  assert.throws(()=>blocked.validateAdmission(admission,'ecl-oz-maxima-oz',manifest('ecl-oz-maxima-oz')),/Reviewed accepted/);
  console.log('V3 benchmark: balanced source-only plan, immutable producer/capture/asset guards and blocked-binding checks passed');
} finally {await rm(directory,{recursive:true,force:true});}
