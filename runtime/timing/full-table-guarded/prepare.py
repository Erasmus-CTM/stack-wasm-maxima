#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Admit three immutable producers without changing fresh benchmark identity."""
import argparse,json,os,re,shutil,subprocess,sys,urllib.error
from pathlib import Path
from artifact import (API,PACKAGE,REPOSITORY,api,pages,verify_run,verify_artifact,
                      download,unpack_selected,record,read,emit,same,safe_path)

PROFILES=['baseline','ecl-oz','ecl-oz-maxima-oz']
OLD={'head':'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31','trustedRevision':'e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31',
     'testedRevision':'5295b5a79bfb983f9e43dd911e6f8ab65139a930','tree':'0e543f936a385548a7ffd53d68930bd88c033922','recipeFiles':71,'runId':40108653819}
NEW={'head':'58cf269f303898a7b679d9d164346fbb9384b781','trustedRevision':'58cf269f303898a7b679d9d164346fbb9384b781',
     'testedRevision':'58cf269f303898a7b679d9d164346fbb9384b781','tree':'3cf2954ebe3ab81990e47b37106d0e07b12b544d','recipeFiles':80,'runId':40136606442}


def validate_bindings(bindings,toolroot):
 assert bindings['schema']==1 and bindings['repository']==REPOSITORY
 assert bindings['branch']=='refs/heads/timing/e8ad-six-cell-guarded'
 assert bindings['publicationAllowed'] is True,'Template blocked: final artifact acceptance/bindings have not been authorized'
 assert set(bindings['profiles'])==set(PROFILES)
 for name,binding in bindings['profiles'].items():
  source=binding['source'];artifact=binding['artifact'];review=binding['independentReview']
  expected=NEW if name==PROFILES[-1] else OLD
  same({k:source[k] for k in expected},expected)
  assert source['runAttempt']==1
  assert type(source['workflowId']) is int and source['workflowId']>0
  assert isinstance(source['jobs'],list) and source['jobs'] and len({j['id'] for j in source['jobs']})==len(source['jobs'])
  assert all(type(j['id']) is int and j['id']>0 and isinstance(j['name'],str) and j['name'] for j in source['jobs'])
  assert len(source['jobs'])==(1 if name==PROFILES[-1] else 2)
  assert any(j['name']==f'bundle-probe ({name})' for j in source['jobs'])
  for key in ['id','zipBytes','zipFileCount','packageFileCount']:
   assert type(artifact[key]) is int and artifact[key]>0,'Unresolved artifact '+name+':'+key
  assert isinstance(artifact['zipSha256'],str) and re.fullmatch('[0-9a-f]{64}',artifact['zipSha256'])
  prefix='maxima-oz-candidate-' if name==PROFILES[-1] else 'precompiled-stack-probe-'
  assert artifact['name']==prefix+name+'-'+source['testedRevision']
  assert artifact['archivedPreload'] is (name==PROFILES[-1])
  assert isinstance(review['path'],str) and review['path'].startswith('reviews/')
  safe_path(review['path']);assert re.fullmatch('[0-9a-f]{64}',review['sha256'])
  assert record(toolroot/review['path'])['sha256']==review['sha256'],'Independent review bytes differ'
 assert len({b['artifact']['id'] for b in bindings['profiles'].values()})==3


def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()


def trusted_checkout(root,source):
 assert git(root,'rev-parse','HEAD')==source['trustedRevision']
 assert git(root,'rev-parse','HEAD^{tree}')==source['tree']
 assert not git(root,'status','--porcelain','--untracked-files=no'),'Changed trusted recipe checkout'


def main():
 parser=argparse.ArgumentParser()
 for arg in ['old-trusted-root','candidate-trusted-root','benchmark-root','work-root']:
  parser.add_argument('--'+arg,type=Path,required=True)
 args=parser.parse_args();benchmark=args.benchmark_root.resolve();toolroot=Path(__file__).resolve().parent
 work=args.work_root.resolve();out=work/'evidence';out.mkdir(parents=True,exist_ok=True)
 identity={k:os.environ.get(k) for k in ('GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REF','GITHUB_EVENT_NAME','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','RUNNER_OS','RUNNER_ARCH','ImageOS','ImageVersion')}
 emit(out,'identity.json',{'benchmark':identity,'scope':'New guarded timing run reusing three separately admitted original runtime producers; a separately proven identical stdout-only child observer is applied by the runner after original admission. No rebuild.'})
 try:
  bindings=read(toolroot/'bindings.json');validate_bindings(bindings,toolroot)
  assert identity['GITHUB_REPOSITORY']==REPOSITORY and identity['GITHUB_REF']==bindings['branch'] and identity['GITHUB_EVENT_NAME']=='push'
  assert identity['GITHUB_RUN_ID'].isdigit() and identity['GITHUB_RUN_ATTEMPT'].isdigit()
  assert git(benchmark,'rev-parse','HEAD')==identity['GITHUB_SHA']
  assert not git(benchmark,'status','--porcelain','--untracked-files=no')
  assert toolroot==benchmark/'runtime/timing/full-table-guarded'
  roots={'baseline':args.old_trusted_root.resolve(),'ecl-oz':args.old_trusted_root.resolve(),'ecl-oz-maxima-oz':args.candidate_trusted_root.resolve()}
  for name,binding in bindings['profiles'].items():
   trusted_checkout(roots[name],binding['source'])
   assert identity['GITHUB_RUN_ID']!=str(binding['source']['runId'])
  tools=[]
  for path in [benchmark/'.github/workflows/full-timing-table-guarded.yml',*sorted(toolroot.rglob('*'))]:
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
                          'nativePrograms':native_programs,
                          'scope':'Each original producer separately pinned and admitted before staging. Benchmark GitHub identity was never reassigned.'})
 except Exception as error:
  detail=('HTTP '+str(error.code)) if isinstance(error,urllib.error.HTTPError) else ('Network request failed' if isinstance(error,urllib.error.URLError) else str(error))
  emit(out,'admission-failure.json',{'passed':False,'type':type(error).__name__,'error':detail})
  raise SystemExit(type(error).__name__+': '+detail)


if __name__=='__main__':main()
