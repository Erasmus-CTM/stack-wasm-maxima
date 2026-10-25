#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Admit the exact old Oz producer before bounded FAS load-condition diagnostics."""
import argparse,json,os,re,shutil,subprocess,sys,urllib.error
from pathlib import Path
from artifact import (API,PACKAGE,REPOSITORY,api,pages,verify_run,verify_artifact,
                      download,unpack_selected,record,read,emit,same,safe_path)

PROFILES=['ecl-oz']
EXPECTED_PROFILE={'source': {'runId': 40108653819, 'runAttempt': 1, 'workflowId': 394101239, 'head': 'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31', 'testedRevision': '5295b5a79bfb983f9e43dd911e6f8ab65139a930', 'trustedRevision': 'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31', 'tree': '0e543f936a385548a7ffd53d68930bd88c033922', 'recipeFiles': 71, 'jobs': [{'id': 120915544152, 'name': 'bundle-probe (ecl-oz)'}, {'id': 120915544199, 'name': 'bundle-probe (baseline)'}]}, 'artifact': {'id': 12568085269, 'name': 'precompiled-stack-probe-ecl-oz-5295b5a79bfb983f9e43dd911e6f8ab65139a930', 'zipBytes': 213921626, 'zipSha256': '890a9c1c6c96d915ada2c41bf85e8b3756132ea2f42d6c5d4c6d9a9357c6759d', 'zipFileCount': 3404, 'packageFileCount': 223, 'archivedPreload': False}, 'independentReview': {'path': 'reviews/ecl-oz.json', 'sha256': '0a1b39fb99372d10c58a2d4bd0071bd53dda7f39d74ffa9a282c3770495801ce'}}


def validate_bindings(bindings,toolroot):
 assert bindings['publicationAllowed'] is True,'Template blocked: independent diagnostic source review/publication approval pending'
 same(bindings,{'schema':1,'repository':REPOSITORY,'branch':'refs/heads/profiling/e8ad-oz-fas-load-condition','publicationAllowed':True,'profiles':{'ecl-oz':EXPECTED_PROFILE}})
 review=EXPECTED_PROFILE['independentReview']
 assert record(toolroot/review['path'])['sha256']==review['sha256'],'Independent review bytes differ'


def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()


def trusted_checkout(root,source):
 assert git(root,'rev-parse','HEAD')==source['trustedRevision']
 assert git(root,'rev-parse','HEAD^{tree}')==source['tree']
 assert not git(root,'status','--porcelain','--untracked-files=no'),'Changed trusted recipe checkout'


def main():
 parser=argparse.ArgumentParser()
 for arg in ['trusted-root','benchmark-root','work-root']:
  parser.add_argument('--'+arg,type=Path,required=True)
 args=parser.parse_args();benchmark=args.benchmark_root.resolve();toolroot=Path(__file__).resolve().parent
 work=args.work_root.resolve();out=work/'evidence';out.mkdir(parents=True,exist_ok=True)
 identity={k:os.environ.get(k) for k in ('GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REF','GITHUB_EVENT_NAME','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','RUNNER_OS','RUNNER_ARCH','ImageOS','ImageVersion')}
 emit(out,'identity.json',{'benchmark':identity,'scope':'Bounded12-cold old Oz FAS load-condition diagnostic. Original producer identity remains distinct; runner applies declared guard/condition derivation only after admission. No rebuild of admitted artifacts.'})
 try:
  bindings=read(toolroot/'bindings.json');validate_bindings(bindings,toolroot)
  assert identity['GITHUB_REPOSITORY']==REPOSITORY and identity['GITHUB_REF']==bindings['branch'] and identity['GITHUB_EVENT_NAME']=='push'
  assert identity['GITHUB_RUN_ID'].isdigit() and identity['GITHUB_RUN_ATTEMPT'].isdigit()
  assert git(benchmark,'rev-parse','HEAD')==identity['GITHUB_SHA']
  assert not git(benchmark,'status','--porcelain','--untracked-files=no')
  assert toolroot==benchmark/'runtime/profiling/oz-fas-load-condition'
  roots={'ecl-oz':args.trusted_root.resolve()}
  for name,binding in bindings['profiles'].items():
   trusted_checkout(roots[name],binding['source'])
   assert identity['GITHUB_RUN_ID']!=str(binding['source']['runId'])
  tools=[]
  for path in [benchmark/'.github/workflows/oz-fas-load-condition.yml',*sorted(toolroot.rglob('*'))]:
   if not path.is_file() or '__pycache__' in path.parts:continue
   relative=path.relative_to(benchmark).as_posix()
   assert subprocess.check_output(['git','-C',str(benchmark),'show',identity['GITHUB_SHA']+':'+relative])==path.read_bytes()
   dest=out/'tool-sources'/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,dest);tools.append({'path':relative,**record(path)})
  emit(out,'tool-sources.json',tools);emit(out,'bindings.json',bindings)
  admitted={};native_programs=None
  for name,binding in bindings['profiles'].items():
   source=binding['source'];spec=binding['artifact'];runid=source['runId']
   run=api(f'/actions/runs/{runid}');jobs=pages(f'/actions/runs/{runid}/attempts/1/jobs','jobs');verify_run(run,jobs,binding)
   tested=api('/commits/'+source['testedRevision'])
   assert tested['sha']==source['testedRevision'] and tested['commit']['tree']['sha']==source['tree']
   if source['testedRevision']!=source['head']:assert source['head'] in {p['sha'] for p in tested['parents']}
   artifact=verify_artifact(pages(f'/actions/runs/{runid}/artifacts','artifacts'),binding)
   emit(out,name+'-producer-api.json',{'run':run,'jobs':jobs,'testedCommit':tested,'artifact':artifact})
   archive=work/'downloads'/f"{spec['id']}.zip";download((spec['id'],spec['name'],spec['zipBytes'],spec['zipSha256']),archive)
   extracted=work/'extracted'/name;inventory=unpack_selected(archive,extracted)
   assert len(inventory)==spec['zipFileCount']
   inventory_path=out/(name+'-zip-inventory.json');emit(out,inventory_path.name,{'artifact':artifact,'zipBytes':spec['zipBytes'],'zipSha256':spec['zipSha256'],'files':inventory})
   # Separate interpreters prevent old/new trusted recipe modules from sharing
   # Python import-cache entries. Original producer identity is explicit data.
   subprocess.run([sys.executable,str(toolroot/'verify-one.py'),'--profile',name,'--binding',str(toolroot/'bindings.json'),
                   '--trusted-root',str(roots[name]),'--extracted',str(extracted),'--inventory',str(inventory_path),
                   '--site',str(work/'profiles'/name/'site'),'--output',str(out)],check=True)
   value=read(out/(name+'-admission.json'));value['artifact']=artifact;admitted[name]=value
   if native_programs is None:native_programs=value['nativePrograms']
   same(value['nativePrograms'],native_programs)
  emit(out,'admission.json',{'schema':1,'passed':True,'benchmark':identity,'profiles':admitted,
                          'nativePrograms':native_programs,'nativeCapture':admitted['ecl-oz']['nativeCapture'],
                          'diagnosticOnly':True,'acceptance':False,
                          'scope':'Exact old Oz original package/source/FAS/native capture admitted before the runner derives its explicit load-condition diagnostic. Twelve fresh cold FAS cases; no retry into success, CPU/TRACE/FS profiler, rebuild, acceptance, performance or causal claim. Fresh GitHub identity is unchanged.'})
 except Exception as error:
  detail=('HTTP '+str(error.code)) if isinstance(error,urllib.error.HTTPError) else ('Network request failed' if isinstance(error,urllib.error.URLError) else str(error))
  emit(out,'admission-failure.json',{'passed':False,'type':type(error).__name__,'error':detail})
  raise SystemExit(type(error).__name__+': '+detail)


if __name__=='__main__':main()
