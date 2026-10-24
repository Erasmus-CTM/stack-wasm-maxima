#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Admit one immutable producer, then explicitly derive two guarded A/B sites."""
import argparse,copy,json,os,shutil,subprocess,sys,urllib.error
from pathlib import Path
from artifact import (PACKAGE,SITE,BROWSER,REPOSITORY,api,pages,verify_run,verify_artifact,
                      download,unpack_selected,record,read,emit,same,verify_package,
                      verify_site_inputs,stage)
from derive import derive

SOURCE={'runId':40108653819,'runAttempt':1,'workflowId':394101239,
 'head':'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',
 'testedRevision':'5295b5a79bfb983f9e43dd911e6f8ab65139a930',
 'trustedRevision':'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',
 'tree':'0e543f936a385548a7ffd53d68930bd88c033922','recipeFiles':71,
 'jobs':[{'id':120915544152,'name':'bundle-probe (ecl-oz)'},{'id':120915544199,'name':'bundle-probe (baseline)'}]}
ARTIFACT={'id':12568085269,'name':'precompiled-stack-probe-ecl-oz-5295b5a79bfb983f9e43dd911e6f8ab65139a930',
 'zipBytes':213921626,'zipSha256':'890a9c1c6c96d915ada2c41bf85e8b3756132ea2f42d6c5d4c6d9a9357c6759d',
 'zipFileCount':3404,'packageFileCount':223,'archivedPreload':False}
REVIEW={'path':'reviews/ecl-oz.json','sha256':'0a1b39fb99372d10c58a2d4bd0071bd53dda7f39d74ffa9a282c3770495801ce'}
BRANCH='refs/heads/profiling/e8ad-fs-error-stack'
MANIFESTS=['stack-sources.json','stack-sources-timed-source.json','stack-sources-precompiled.json']

def validate_bindings(bindings,toolroot):
 assert bindings['publicationAllowed'] is True,'Template blocked: independent source review/publication approval is pending'
 same(bindings,{'schema':1,'repository':REPOSITORY,'branch':BRANCH,'publicationAllowed':True,
                'producer':{'source':SOURCE,'artifact':ARTIFACT,'independentReview':REVIEW}})
 assert record(toolroot/REVIEW['path'])['sha256']==REVIEW['sha256'],'Independent artifact review bytes changed'

def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()

def trusted_checkout(root):
 assert git(root,'rev-parse','HEAD')==SOURCE['trustedRevision']
 assert git(root,'rev-parse','HEAD^{tree}')==SOURCE['tree']
 assert not git(root,'status','--porcelain','--untracked-files=no')

def files(site):
 assert not any(p.is_symlink() for p in site.rglob('*'))
 rows=[{'path':p.relative_to(site).as_posix(),**record(p)} for p in sorted(site.rglob('*')) if p.is_file()]
 assert len(rows)==87 and len({r['path'] for r in rows})==87
 return rows

def derive_runtime(control,changed,out,m,package_record):
 """Only maxima.js and three manifest identities differ between these arms."""
 assert not changed.exists();shutil.copytree(control,changed)
 original=(control/'maxima-runtime/maxima.js').read_bytes();body,proof=derive(original)
 out.mkdir(parents=True,exist_ok=True)
 (out/'original-maxima.js').write_bytes(original);(out/'derived-maxima.js').write_bytes(body)
 (changed/'maxima-runtime/maxima.js').write_bytes(body);emit(out,'derivation.json',proof)
 assets=copy.deepcopy(m['runtimeAssets']);matches=[r for r in assets if r['path']=='maxima.js'];assert len(matches)==1
 matches[0].update(proof['derived'])
 derived_manifest={'schema':1,'kind':'ctm-derived-diagnostic','acceptance':False,
  'originalRuntime':{'manifest':package_record,'compilerProfile':m['compilerProfile'],'sourcePins':m['sourcePins']},
  'derivation':record(out/'derivation.json'),'runtimeAssets':assets}
 emit(out,'derived-runtime-manifest.json',derived_manifest)
 original_build=read(control/MANIFESTS[0])['runtimeBuild']
 build={'kind':'ctm-derived-diagnostic','manifestSha256':record(out/'derived-runtime-manifest.json')['sha256'],
        'sourcePins':m['sourcePins'],'compilerProfile':m['compilerProfile'],'originalBuild':original_build,
        'derivationSha256':record(out/'derivation.json')['sha256']}
 for name in MANIFESTS:
  value=read(control/name);same(value['runtimeBuild'],original_build);value['runtimeBuild']=build
  rows=[r for r in value['runtimeAssets'] if r['path']=='maxima.js'];assert len(rows)==1
  rows[0].update({'fileBytes':proof['derived']['bytes'],'sha256':proof['derived']['sha256']})
  emit(changed,name,value)
 a={r['path']:r for r in files(control)};b={r['path']:r for r in files(changed)};assert set(a)==set(b)
 assert {p for p in a if a[p]!=b[p]}=={'maxima-runtime/maxima.js',*MANIFESTS}
 assert 'maxima.js' not in read(control/MANIFESTS[0])['preload']['paths']
 return proof,assets,build

def retain_inputs(root,out):
 # Preserve already ZIP-hashed proof inputs before any later verifier can fail.
 for path in root.rglob('*'):
  if not path.is_file():continue
  relative=path.relative_to(root)
  if relative.as_posix().startswith(PACKAGE) and any(p in ('sources','runtime','recipe') for p in relative.parts[3:]):continue
  target=out/'admission-inputs'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)

def admit_and_stage(root,trusted,inventory,binding,arms_root,out):
 retain_inputs(root,out)
 rows={r['path']:r for r in inventory};assert len(rows)==len(inventory)
 m=verify_package(root,'ecl-oz',trusted,rows,binding);siteproof=verify_site_inputs(root,trusted,m,binding)
 from timing_evidence import captured_workload
 browser=read(root/BROWSER);assert browser['sourceRevision']==SOURCE['testedRevision'] and not browser['errors']
 assert len(browser['runtime']['assets'])==len({r['path'] for r in browser['runtime']['assets']})==79
 same(browser['runtime']['compiledStack'],siteproof['compiledStack'])
 same({r['path']:{'bytes':r['fileBytes'],'sha256':r['sha256']} for r in browser['runtime']['assets']},
      {r['path']:{'bytes':r['bytes'],'sha256':r['sha256']} for r in m['runtimeAssets']})
 programs=captured_workload(browser)
 control=arms_root/'control/site';changed=arms_root/'errno-stack-suppressed/site'
 _,preload=stage(root,control,m)
 # A shared declared stdout observer is identical in both arms. Its derivation
 # is separate from the runtime JS treatment and from original asset admission.
 child=control/'runtime/maxima-child.js';original_child=record(child)
 observer_output=out/'derived-maxima-child.js'
 subprocess.run(['node',str(Path(__file__).resolve().parent/'derive-startup-observer.mjs'),
                 '--input',str(child),'--output',str(observer_output),
                 '--proof',str(out/'startup-observer-derivation.json')],check=True)
 observer_proof=read(out/'startup-observer-derivation.json')
 same(observer_proof['original'],original_child);same(observer_proof['derived'],record(observer_output))
 shutil.copyfile(observer_output,child)
 package_record=record(root/PACKAGE/'manifest.json')
 proof,derived_assets,build=derive_runtime(control,changed,out,m,package_record)
 arms={'control':{'kind':'accepted-original-runtime-with-observer','runtimeManifest':package_record,
                  'runtimeBuild':read(control/MANIFESTS[0])['runtimeBuild'],'runtimeAssets':m['runtimeAssets'],
                  'stagedFiles':files(control),'preload':preload},
       'errno-stack-suppressed':{'kind':'derived-diagnostic-with-observer','runtimeManifest':record(out/'derived-runtime-manifest.json'),
                  'runtimeBuild':build,'runtimeAssets':derived_assets,'stagedFiles':files(changed),'preload':preload}}
 return {'schema':1,'passed':True,'diagnosticOnly':True,'acceptance':False,'source':SOURCE,
         'compilerProfile':m['compilerProfile'],'originalPackageManifest':package_record,
         'sourceIntegrity':m['sourceIntegrity'],'siteProof':siteproof,'independentReview':REVIEW,
         'nativePrograms':programs,'nativeCapture':record(root/BROWSER),'derivation':proof,'arms':arms,
         'observer':{'original':observer_proof['original'],'derived':observer_proof['derived'],
                     'proof':record(out/'startup-observer-derivation.json')},
         'scope':'Both arms use the same declared derived stdout-only child observer. Control retains all original runtime assets; experiment derives only maxima.js. Wasm/FAS/preload/embedded sources are unchanged. No accepted unchanged-site or production promotion claim.'}

def main():
 parser=argparse.ArgumentParser()
 for arg in ['trusted-root','benchmark-root','work-root']:parser.add_argument('--'+arg,type=Path,required=True)
 args=parser.parse_args();trusted=args.trusted_root.resolve();benchmark=args.benchmark_root.resolve();toolroot=Path(__file__).resolve().parent
 work=args.work_root.resolve();out=work/'evidence';out.mkdir(parents=True,exist_ok=True)
 identity={k:os.environ.get(k) for k in ('GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REF','GITHUB_EVENT_NAME','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','RUNNER_OS','RUNNER_ARCH','ImageOS','ImageVersion')}
 emit(out,'identity.json',{'benchmark':identity,'source':SOURCE,'scope':'No-rebuild diagnostic A/B; producer and benchmark identities remain distinct.'})
 try:
  bindings=read(toolroot/'bindings.json');validate_bindings(bindings,toolroot);binding=bindings['producer'];spec=binding['artifact']
  assert identity['GITHUB_REPOSITORY']==REPOSITORY and identity['GITHUB_REF']==BRANCH and identity['GITHUB_EVENT_NAME']=='push'
  assert identity['GITHUB_RUN_ID'].isdigit() and identity['GITHUB_RUN_ATTEMPT'].isdigit() and identity['GITHUB_RUN_ID']!=str(SOURCE['runId'])
  assert git(benchmark,'rev-parse','HEAD')==identity['GITHUB_SHA'] and not git(benchmark,'status','--porcelain','--untracked-files=no')
  assert toolroot==benchmark/'runtime/profiling/fs-error-stack';trusted_checkout(trusted)
  # Only tracked exact source files become tool provenance; local derived data
  # and bytecode caches are not source inputs.
  paths=git(benchmark,'ls-files','runtime/profiling/fs-error-stack','.github/workflows/fs-error-stack-ab.yml').splitlines();assert paths
  tools=[]
  for relative in paths:
   path=benchmark/relative;assert path.is_file() and not path.is_symlink()
   assert subprocess.check_output(['git','-C',str(benchmark),'show',identity['GITHUB_SHA']+':'+relative])==path.read_bytes()
   target=out/'tool-sources'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target);tools.append({'path':relative,**record(path)})
  emit(out,'tool-sources.json',tools);emit(out,'bindings.json',bindings)
  runid=SOURCE['runId'];run=api(f'/actions/runs/{runid}');jobs=pages(f'/actions/runs/{runid}/attempts/1/jobs','jobs');verify_run(run,jobs,binding)
  tested=api('/commits/'+SOURCE['testedRevision']);assert tested['sha']==SOURCE['testedRevision'] and tested['commit']['tree']['sha']==SOURCE['tree'] and SOURCE['head'] in {p['sha'] for p in tested['parents']}
  artifact=verify_artifact(pages(f'/actions/runs/{runid}/artifacts','artifacts'),binding)
  emit(out,'producer-api.json',{'run':run,'jobs':jobs,'testedCommit':tested,'artifact':artifact})
  archive=work/'downloads'/f"{spec['id']}.zip";download((spec['id'],spec['name'],spec['zipBytes'],spec['zipSha256']),archive)
  extracted=work/'extracted';inventory=unpack_selected(archive,extracted);assert len(inventory)==spec['zipFileCount']
  emit(out,'zip-inventory.json',{'artifact':artifact,'zipBytes':spec['zipBytes'],'zipSha256':spec['zipSha256'],'files':inventory})
  result=admit_and_stage(extracted,trusted,inventory,binding,work/'arms',out);result.update({'benchmark':identity,'artifact':artifact})
  emit(out,'admission.json',result)
 except Exception as error:
  detail=('HTTP '+str(error.code)) if isinstance(error,urllib.error.HTTPError) else ('Network request failed' if isinstance(error,urllib.error.URLError) else str(error))
  emit(out,'admission-failure.json',{'passed':False,'type':type(error).__name__,'error':detail})
  raise SystemExit(type(error).__name__+': '+detail)

if __name__=='__main__':main()
