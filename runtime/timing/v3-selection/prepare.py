"""Admit the frozen control and the newly accepted flattened runtime, then stage common source STACK."""
import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'full-table-guarded'))
import artifact as helpers
from artifact import api,pages,read,record,same,emit,safe_path,verify_artifact,download,unpack_selected

p=argparse.ArgumentParser()
for name in ('old-trusted-root','frozen-candidate-root','current-trusted-root','benchmark-root','work-root','stack-source','checkers-source'):
 p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();benchmark=a.benchmark_root.resolve();trusted=a.current_trusted_root.resolve();work=a.work_root.resolve();out=work/'evidence';out.mkdir(parents=True,exist_ok=True)
binding=read(HERE/'candidate-binding.json');assert binding['ready'] is True,'Candidate bindings are blocked until full acceptance and review'
source=binding['source'];spec=binding['artifact']
identity={k:os.environ.get(k) for k in ('GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REF','GITHUB_EVENT_NAME','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','RUNNER_OS','RUNNER_ARCH','ImageOS','ImageVersion')}
assert identity['GITHUB_REPOSITORY']=='Erasmus-CTM/stack-wasm-maxima' and identity['GITHUB_REF']=='refs/heads/evidence/maxima-oz-production'
assert identity['GITHUB_EVENT_NAME']=='push' and identity['GITHUB_RUN_ID']!=str(source['runId'])
def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
assert git(benchmark,'rev-parse','HEAD')==identity['GITHUB_SHA']
assert not git(benchmark,'status','--porcelain','--untracked-files=no')
assert git(trusted,'rev-parse','HEAD')==source['trustedRevision']==source['testedRevision']
assert git(trusted,'rev-parse','HEAD^{tree}')==source['tree']
review=binding['independentReview'];safe_path(review['path']);assert review['path'].startswith('reviews/')
assert record(HERE/review['path'])['sha256']==review['sha256']
# Preserve the frozen admission rules: no relabeling of the old experimental
# artifact as a repaired candidate, and no benchmark identity reassignment.
frozen=work/'frozen'
subprocess.run([sys.executable,str(HERE.parent/'full-table-guarded/prepare.py'),
 '--old-trusted-root',str(a.old_trusted_root.resolve()),'--candidate-trusted-root',str(a.frozen_candidate_root.resolve()),
 '--benchmark-root',str(benchmark),'--work-root',str(frozen)],check=True)
old=read(frozen/'evidence/admission.json')['profiles']['ecl-oz']
run=api(f"/actions/runs/{source['runId']}")
assert run['status']=='completed' and run['conclusion']=='success' and run['run_attempt']==source['runAttempt']
assert run['head_sha']==source['head'] and run['workflow_id']==source['workflowId']
assert run['repository']['full_name']==identity['GITHUB_REPOSITORY'] and run['event']=='pull_request'
assert any(row['number']==28 for row in run['pull_requests'])
jobs=pages(f"/actions/runs/{source['runId']}/attempts/{source['runAttempt']}/jobs",'jobs')
builds=[row for row in jobs if row['id']==source['buildJobId']];assert len(builds)==1
build=builds[0];assert build['status']=='completed' and build['conclusion']=='success'
assert next(s for s in build['steps'] if s['name']=='Assert complete acceptance evidence')['conclusion']=='success'
commit=api('/commits/'+source['testedRevision'])
assert commit['sha']==source['testedRevision'] and commit['commit']['tree']['sha']==source['tree']
assert source['head']==source['testedRevision'] or source['head'] in {r['sha'] for r in commit['parents']}
artifact=verify_artifact(pages(f"/actions/runs/{source['runId']}/artifacts",'artifacts'),binding)
assert spec['name']=='owned-runtime-ecl-oz-maxima-oz-'+source['testedRevision']
emit(out,'producer-api.json',{'run':run,'jobs':jobs,'testedCommit':commit,'artifact':artifact})
archive=work/'downloads'/f"{spec['id']}.zip";download((spec['id'],spec['name'],spec['zipBytes'],spec['zipSha256']),archive)
root=work/'candidate'
# The current archive carries separate compiled/source controller snapshots and
# acceptance reports. Safe ZIP bounds/type/path/hash checks remain unchanged.
helpers.selected=lambda name:True
inventory=unpack_selected(archive,root);emit(out,'candidate-inventory.json',inventory)
subprocess.run([sys.executable,str(HERE/'verify-new.py'),'--binding',str(HERE/'candidate-binding.json'),
 '--trusted-root',str(trusted),'--extracted',str(root),'--output',str(out)],check=True)
new=read(out/'flattened-candidate-admission.json');new['artifact']=artifact
programs=new['producerNativePrograms'];assert [r['operation'] for r in programs]==['prepare','validate','prt']
old['producerNativePrograms']=old['nativePrograms'];old['producerNativeCapture']=old['nativeCapture']
for row in (old,new):
 row['nativePrograms']=programs;row['nativeCapture']=new['nativeCapture']
packages={'ecl-oz':frozen/'extracted/ecl-oz/.cache/runtime-build/artifact',
          'ecl-oz-maxima-oz':root/'.cache/runtime-build/artifact'}
profiles={'ecl-oz':old,'ecl-oz-maxima-oz':new};manifests={}
for name,row in profiles.items():
 site=work/'profiles'/name/'site'
 subprocess.run([sys.executable,str(trusted/'scripts/milestone-two/prepare-runtime.py'),
  '--runtime-source',str(packages[name]),'--compiler-profile',name,'--output',str(site),
  '--stack-source',str(a.stack_source.resolve()),'--ctm-checkers-source',str(a.checkers_source.resolve())],check=True)
 manifest=read(site/'stack-sources.json');assert 'compiledStack' not in manifest
 anchor='load("/ctm/moodle-qtype_stack-master/stack/maxima/stacklocallinux.mac")$'
 assert manifest['startup'].count(anchor)==1
 original=record(site/'stack-sources.json')
 manifest['startup']=manifest['startup'].replace(anchor,'m2_emit("CTMSTACK-LOAD-BEGIN")$\n'+anchor+'\nm2_emit("CTMSTACK-LOAD-END")$')
 (site/'stack-sources-timed-source.json').write_text(json.dumps(manifest,ensure_ascii=False)+'\n')
 row['stagingDerivation']={'commonIntegrationRevision':source['trustedRevision'],'originalSourceManifest':original,
  'timedSourceManifest':record(site/'stack-sources-timed-source.json'),
  'edits':'Only identical LOAD-BEGIN/LOAD-END markers around the source STACK load; common current classifier startup on both profiles. Runtime binaries unchanged.'}
 row['stagedFiles']=[{'path':f.relative_to(site).as_posix(),**record(f)} for f in sorted(site.rglob('*')) if f.is_file()]
 manifests[name]=manifest
same(manifests['ecl-oz']['files'],manifests['ecl-oz-maxima-oz']['files'])
same(manifests['ecl-oz']['startup'],manifests['ecl-oz-maxima-oz']['startup'])
for name,m in manifests.items():same({k:v for k,v in m.items() if k not in ('runtimeAssets','runtimeBuild','preload')},
 {k:v for k,v in manifests['ecl-oz'].items() if k not in ('runtimeAssets','runtimeBuild','preload')})
files=[]
for path in [benchmark/'.github/workflows/v3-selection.yml',*sorted(HERE.rglob('*'))]:
 if not path.is_file() or '__pycache__' in path.parts:continue
 relative=path.relative_to(benchmark).as_posix();assert subprocess.check_output(['git','-C',str(benchmark),'show',identity['GITHUB_SHA']+':'+relative])==path.read_bytes()
 target=out/'tool-sources'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
 files.append({'path':relative,**record(path)})
emit(out,'tool-sources.json',files)
emit(out,'admission.json',{'schema':1,'passed':True,'benchmark':identity,'profiles':profiles,'nativePrograms':programs,
 'sharedWorkload':{'source':source,'capture':new['nativeCapture'],'scope':'Identical current captured rational prepare/validate/PRT programs on both admitted runtime profiles; their shared current classifier is staged before timing.'},
 'scope':'Old and repaired runtime packages independently admitted; full producer acceptance required; current source integration shared. No runtime rebuild or reassigned benchmark identity.'})
