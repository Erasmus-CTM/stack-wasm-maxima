#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Admit immutable accepted full-run ZIPs and stage exact bytes without building."""
import argparse,base64,copy,hashlib,json,os,shutil,stat,subprocess,sys,urllib.error,urllib.parse,urllib.request,zipfile
from pathlib import Path,PurePosixPath

REPOSITORY='Erasmus-CTM/stack-wasm-maxima'
SOURCE_RUN=40108653819
SOURCE_WORKFLOW=394101239
SOURCE_HEAD='e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31'
SOURCE_MERGE='5295b5a79bfb983f9e43dd911e6f8ab65139a930'
SOURCE_TREE='0e543f936a385548a7ffd53d68930bd88c033922'
BRANCH='refs/heads/profiling/e8ad-baseline-trace-no-cpu'
SPECS={
 'baseline':(12567788724,'precompiled-stack-probe-baseline-'+SOURCE_MERGE,214342343,'8478694866575c1b638c00bfc1abe9868b8615b02002ad8013d73524354d290b'),
 'ecl-oz':(12568085269,'precompiled-stack-probe-ecl-oz-'+SOURCE_MERGE,213921626,'890a9c1c6c96d915ada2c41bf85e8b3756132ea2f42d6c5d4c6d9a9357c6759d'),
}
API='https://api.github.com/repos/'+REPOSITORY
PACKAGE='.cache/runtime-build/artifact/'
SITE='.cache/precompiled-stack/site/'
WORK='.cache/precompiled-stack/'
SITE_FILES={'stack-sources.json','stack-sources-timed-source.json','stack-sources-precompiled.json','precompiled-measure-worker.js','runtime/maxima-child.js','runtime/maxima-session.js','maxima-runtime/stackmaxima.fas'}
BUNDLE_FILES={WORK+p for p in ('stackmaxima.fas.json','assignment-adapter.lisp','source-initialized/stackmaxima.lisp','source-initialized/display2d-bridge.lisp','source-initialized/parser-declarations.mac','source-initialized/parser-declarations.json')}
MEASURE='test-results/precompiled-stack/measure.json'
BROWSER='test-results/milestone-three/browser.json'

def digest(body):return hashlib.sha256(body).hexdigest()
def read(path):return json.loads(path.read_bytes())
def record(path):
 body=path.read_bytes();return {'bytes':len(body),'sha256':digest(body)}
def same(a,b):assert json.dumps(a,sort_keys=True,allow_nan=False)==json.dumps(b,sort_keys=True,allow_nan=False)
def emit(out,name,value):
 out.mkdir(parents=True,exist_ok=True);(out/name).write_text(json.dumps(value,indent=2,allow_nan=False)+'\n')
def safe_path(name):
 path=PurePosixPath(name)
 assert name and path.parts and not path.is_absolute() and '\\' not in name and ':' not in name
 assert '..' not in path.parts and path.as_posix()==name.rstrip('/')
 return path

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,request,fp,code,message,headers,newurl):return None

def request(path):
 assert path.startswith('/') and not path.startswith('//')
 return urllib.request.Request(API+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ctm-no-rebuild-profile'},method='GET')

def api(path):
 # Never forward a metadata bearer token through any redirect.
 with urllib.request.build_opener(NoRedirect).open(request(path),timeout=120) as response:return json.load(response)

def pages(path,field):
 rows=[]
 for page in range(1,101):
  batch=api(path+('' if '?' in path else '?')+('&' if '?' in path else '')+f'per_page=100&page={page}')[field];rows.extend(batch)
  if len(batch)<100:return rows
 raise AssertionError('Pagination bound exceeded')

def verify_run(run,jobs):
 assert run['id']==SOURCE_RUN and run['workflow_id']==SOURCE_WORKFLOW and run['run_attempt']==1
 assert run['repository']['full_name']==REPOSITORY and run['head_sha']==SOURCE_HEAD
 assert run['status']=='completed' and run['conclusion']=='success'
 assert len(jobs)==2 and {j['id'] for j in jobs}=={120915544152,120915544199}
 assert {j['name'] for j in jobs}=={'bundle-probe (baseline)','bundle-probe (ecl-oz)'}
 assert all(j['status']=='completed' and j['conclusion']=='success' for j in jobs)

def verify_artifact(rows,spec):
 identifier,name,size,sha=spec;matches=[r for r in rows if r['id']==identifier or r['name']==name]
 assert len(matches)==1,'Missing or ambiguous exact artifact';row=matches[0]
 assert row['id']==identifier and row['name']==name and row['expired'] is False
 assert row['size_in_bytes']==size and row['digest']=='sha256:'+sha
 assert row['workflow_run']['id']==SOURCE_RUN and row['workflow_run']['head_sha']==SOURCE_HEAD
 return row

def download(spec,archive):
 identifier,_,size,sha=spec
 try:urllib.request.build_opener(NoRedirect).open(request(f'/actions/artifacts/{identifier}/zip'),timeout=120)
 except urllib.error.HTTPError as response:
  assert response.code==302;location=response.headers['Location']
 else:raise AssertionError('Expected signed artifact redirect')
 parsed=urllib.parse.urlsplit(location)
 assert parsed.scheme=='https' and parsed.hostname and not parsed.username and not parsed.password and parsed.port in (None,443)
 archive.parent.mkdir(parents=True,exist_ok=True);length=0;h=hashlib.sha256()
 # No Authorization header and no further redirects, including HTTPS downgrade.
 with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(location,method='GET'),timeout=120) as source,archive.open('xb') as target:
  while block:=source.read(1024*1024):
   length+=len(block);assert length<=size,'Oversized ZIP';h.update(block);target.write(block)
 assert length==size and h.hexdigest()==sha,'ZIP identity changed'

def selected(path):return path.startswith(PACKAGE) or path.startswith(SITE) or path in BUNDLE_FILES or path in (MEASURE,BROWSER)

def unpack_selected(archive,destination):
 assert not destination.exists();inventory=[];seen=set()
 with zipfile.ZipFile(archive) as z:
  entries=z.infolist();assert 0<len(entries)<=10000 and sum(x.file_size for x in entries)<=2*1024**3
  for entry in entries:
   path=safe_path(entry.filename);name=path.as_posix();assert name not in seen,'Duplicate ZIP path';seen.add(name)
   mode=stat.S_IFMT(entry.external_attr>>16);assert mode in (0,stat.S_IFREG,stat.S_IFDIR)
   assert not entry.flag_bits&1 and entry.file_size<=1024**3
   if entry.is_dir():assert mode in (0,stat.S_IFDIR);continue
   assert mode in (0,stat.S_IFREG)
   target=destination.joinpath(*path.parts);assert target.resolve().is_relative_to(destination.resolve())
   output=None
   if selected(name):target.parent.mkdir(parents=True,exist_ok=True);output=target.open('xb')
   h=hashlib.sha256();length=0
   try:
    with z.open(entry) as source:
     while block:=source.read(1024*1024):
      h.update(block);length+=len(block)
      if output:output.write(block)
   finally:
    if output:output.close()
   assert length==entry.file_size
   inventory.append({'path':name,'bytes':length,'sha256':h.hexdigest()})
 return inventory

def package_closure(artifact,inventory):
 rows=read(artifact/'artifact-manifest.json')['files'];paths=[r['path'] for r in rows]
 assert len(paths)==len(set(paths))
 assert not any(p.is_symlink() for p in artifact.rglob('*'))
 actual={p.relative_to(artifact).as_posix() for p in artifact.rglob('*') if p.is_file() and p!=artifact/'artifact-manifest.json'}
 assert set(paths)==actual=={p.removeprefix(PACKAGE) for p in inventory if p.startswith(PACKAGE) and p!=PACKAGE+'artifact-manifest.json'}
 for row in rows:
  safe_path(row['path']);same(record(artifact/row['path']),{k:row[k] for k in ('bytes','sha256')})
  same(row,{'path':row['path'],**{k:inventory[PACKAGE+row['path']][k] for k in ('bytes','sha256')}})
 return rows

def verify_package(root,profile,trusted,inventory):
 artifact=root/PACKAGE;m=read(artifact/'manifest.json');rows=package_closure(artifact,inventory)
 assert len(rows)==223 and len(m['runtimeAssets'])==79
 sys.path.insert(0,str(trusted/'runtime/build'))
 from recipe_inputs import recipe_records
 from source_overlay import verify_packaged as overlay
 from compiler_evidence import verify_packaged as compiler
 same(m['recipe'],{'repository':'https://github.com/'+REPOSITORY,'revision':SOURCE_MERGE,'files':recipe_records(trusted)})
 assert len(m['recipe']['files'])==71
 same(m['sourcePins'],read(trusted/'runtime/build/pins.json'));same(m['configuration'],read(trusted/'runtime/build/configuration.json'))
 same(m['compilerProfile'],read(trusted/'runtime/build/compiler-profiles.json')['profiles'][profile])
 for folder,records in [('recipe',m['recipe']['files']),('runtime',m['runtimeAssets'])]:
  assert len({r['path'] for r in records})==len(records)
  for row in records:
   safe_path(row['path']);same(record(artifact/folder/row['path']),{k:row[k] for k in ('bytes','sha256')})
   if folder=='recipe':assert (artifact/folder/row['path']).read_bytes()==(trusted/row['path']).read_bytes()
 same(read(artifact/'source-manifest.json'),{k:m[k] for k in ('schema','compilerProfile','sourcePins','recipe','toolchain','upstreamRecipe','sourceIntegrity','configuration','startupAdapter')})
 environment=read(artifact/'logs/environment.json')
 same(environment['buildIdentity'],{'runId':str(SOURCE_RUN),'runAttempt':'1','sourceRevision':SOURCE_MERGE,'coldBuild':None})
 same(environment['compilerProfile'],m['compilerProfile'])
 same(overlay(artifact,trusted),m['sourceIntegrity']);compiler(artifact,m['compilerProfile'])
 return m

def verify_site_inputs(root,trusted,m):
 site=root/SITE;original=read(site/'stack-sources.json');timed=read(site/'stack-sources-timed-source.json');compiled=read(site/'stack-sources-precompiled.json')
 assert {p.relative_to(site).as_posix() for p in site.rglob('*') if p.is_file()}==SITE_FILES
 assert original['schema']==1 and original['stackRevision']=='33383047af39c204bf4442802a058f8b918b2b1b'
 assert str(original['stackLibraryVersion'])=='2026101500' and 'compiledStack' not in original and len(original['files'])==77
 assert len({r['path'] for r in original['files']})==77
 for row in original['files']:
  safe_path(row['path']);body=row['content'].encode();same({'bytes':len(body),'sha256':digest(body)},{k:row[k] for k in ('bytes','sha256')})
 same(original['runtimeBuild'],{'kind':'ctm-owned-build','manifestSha256':digest((root/PACKAGE/'manifest.json').read_bytes()),'sourcePins':m['sourcePins'],'compilerProfile':m['compilerProfile']})
 assets={r['path']:{'bytes':r['fileBytes'],'sha256':r['sha256']} for r in original['runtimeAssets']}
 assert len(assets)==len(original['runtimeAssets'])==79;same(assets,{r['path']:{k:r[k] for k in ('bytes','sha256')} for r in m['runtimeAssets']})
 start='load("/ctm/moodle-qtype_stack-master/stack/maxima/stacklocallinux.mac")$';assert original['startup'].count(start)==1
 expected=copy.deepcopy(original);expected['startup']=expected['startup'].replace(start,'m2_emit("CTMSTACK-LOAD-BEGIN")$\n'+start+'\nm2_emit("CTMSTACK-LOAD-END")$');same(timed,expected)
 expected=copy.deepcopy(timed);loader=next(r for r in expected['files'] if r['path']=='stack/maxima/stacklocallinux.mac');oldhash=loader['sha256'];old='load("stackmaxima.mac")$';assert loader['content'].count(old)==1
 loader['content']=loader['content'].replace(old,'load("/ctm/moodle-qtype_stack-master/stack/maxima/stackmaxima.fas")$');body=loader['content'].encode();loader.update({'bytes':len(body),'sha256':digest(body)})
 stripped=copy.deepcopy(compiled);cs=stripped.pop('compiledStack');same(stripped,expected)
 bundle=site/'maxima-runtime/stackmaxima.fas';assert bundle.read_bytes()[:8]==b'\0asm\1\0\0\0'
 same(cs['asset'],{'path':'stackmaxima.fas','fileBytes':bundle.stat().st_size,'sha256':record(bundle)['sha256']})
 assert cs['originalLoaderSha256']==oldhash and cs['overlayLoaderSha256']==loader['sha256']
 assert cs['stackRevision']==original['stackRevision'] and cs['mode']=='entry-fas'
 source=next(r for r in original['files'] if r['path']=='stack/maxima/stackmaxima.mac')['content'].encode()
 assert cs['sourceSha256']==digest(source)
 sys.path.insert(0,str(trusted/'runtime/precompiled'))
 from bundle_provenance import describe
 from parser_bootstrap import extract
 work=root/WORK;init=work/'source-initialized';lisp=(init/'stackmaxima.lisp').read_bytes();bridge=(init/'display2d-bridge.lisp').read_bytes();adapter=(work/'assignment-adapter.lisp').read_bytes()
 assert bridge==(trusted/'runtime/precompiled/display2d-bridge.lisp').read_bytes() and adapter==(trusted/'runtime/precompiled/assignment-adapter.lisp').read_bytes()
 assessment=next(r for r in original['files'] if r['path']=='stack/maxima/assessment.mac')['content'].encode();declarations,start=extract(assessment,original['stackRevision'])
 assert declarations==(init/'parser-declarations.mac').read_bytes();parser_metadata=read(init/'parser-declarations.json')
 same(parser_metadata,{'schema':1,'stackRevision':original['stackRevision'],'scope':'Translation-process parser declarations only; target dependency loads and upstream files are unchanged','source':{'path':'stack/maxima/assessment.mac','bytes':len(assessment),'sha256':digest(assessment),'start':start,'end':start+len(declarations)},'file':{'path':'parser-declarations.mac','bytes':len(declarations),'sha256':digest(declarations)}})
 descriptor=work/'stackmaxima.fas.json';same(read(descriptor),describe(original['stackRevision'],source,lisp,bridge,adapter,declarations,(init/'parser-declarations.json').read_bytes(),bundle.read_bytes()))
 assert cs['bundleProvenanceSha256']==record(descriptor)['sha256'] and cs['translatedLispSha256']==digest(lisp)
 for name in ('maxima-child.js','maxima-session.js'):assert (site/'runtime'/name).read_bytes()==(trusted/'prototype/runtime'/name).read_bytes()
 measured=read(root/MEASURE);assert measured['passed'] is True and measured['sourceRevision']==SOURCE_MERGE
 same(measured['planned'],{'trials':8,'initializations':32,'restarts':24});same(measured['completed'],measured['planned'])
 for row in measured['files']:same(record(site/row['path']),{k:row[k] for k in ('bytes','sha256')})
 return {'stackRevision':original['stackRevision'],'siteManifestRecords':[{ 'path':name,**record(site/name)} for name in sorted(SITE_FILES)],'compiledStack':cs,'originalMeasurement':record(root/MEASURE)}

def reconstruct_preload(destination,preload,assets):
 # The accepted ZIPs omit this ordinary generated JSON. Reconstruct its exact
 # existing bytes with the pinned prepare-runtime.py serialization, never compile.
 assert preload['path']=='runtime-preload.json'
 paths=preload['paths'];assert paths==sorted(set(paths)) and set(paths)<={r['path'] for r in assets}
 body=(json.dumps({'schema':1,'files':[{'path':p,'content':base64.b64encode((destination/'maxima-runtime'/p).read_bytes()).decode('ascii')} for p in paths]},separators=(',',':'))+'\n').encode()
 assert len(body)==preload['fileBytes'] and digest(body)==preload['sha256'],'Reconstructed preload differs from accepted manifest'
 target=destination/'maxima-runtime/runtime-preload.json';assert not target.exists();target.write_bytes(body)
 return {'path':'maxima-runtime/runtime-preload.json',**record(target),'origin':'Deterministically reconstructed from admitted runtime assets; exact bytes/SHA required by archived manifest.preload. Not an archived ZIP member; no compile.'}

def stage(root,destination,m):
 assert not destination.exists();shutil.copytree(root/SITE,destination)
 for row in m['runtimeAssets']:
  safe_path(row['path']);target=destination/'maxima-runtime'/row['path'];assert not target.exists();target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/PACKAGE/'runtime'/row['path'],target)
 preload=reconstruct_preload(destination,read(root/SITE/'stack-sources.json')['preload'],m['runtimeAssets'])
 files=[{'path':p.relative_to(destination).as_posix(),**record(p)} for p in sorted(destination.rglob('*')) if p.is_file()]
 assert len(files)==87;return files,preload

def native_workload(root,trusted,m,siteproof):
 # Accepted capture is data only. Select the same three native-rational calls
 # as the reviewed timing harness, after binding all original runtime inputs.
 sys.path.insert(0,str(trusted/'runtime/build'))
 from timing_evidence import captured_workload
 browser=read(root/BROWSER)
 assert browser['sourceRevision']==SOURCE_MERGE and not browser['errors']
 assert len(browser['runtime']['assets'])==len({r['path'] for r in browser['runtime']['assets']})==79
 same(browser['runtime']['compiledStack'],siteproof['compiledStack'])
 same({r['path']:{'bytes':r['fileBytes'],'sha256':r['sha256']} for r in browser['runtime']['assets']},
      {r['path']:{'bytes':r['bytes'],'sha256':r['sha256']} for r in m['runtimeAssets']})
 programs=captured_workload(browser)
 assert [p['operation'] for p in programs]==['prepare','validate','prt']
 return programs,{'profile':'baseline','artifact':SPECS['baseline'][0],'path':BROWSER,**record(root/BROWSER)}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--trusted-root',type=Path,required=True);parser.add_argument('--profiling-root',type=Path,required=True);parser.add_argument('--work-root',type=Path,required=True);args=parser.parse_args()
 trusted=args.trusted_root.resolve();profiling=args.profiling_root.resolve();work=args.work_root.resolve();out=work/'evidence';out.mkdir(parents=True,exist_ok=True)
 identity={k:os.environ.get(k) for k in ('GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REF','GITHUB_EVENT_NAME','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','RUNNER_OS','RUNNER_ARCH','ImageOS','ImageVersion')}
 source={'runId':SOURCE_RUN,'runAttempt':1,'head':SOURCE_HEAD,'testedRevision':SOURCE_MERGE,'tree':SOURCE_TREE}
 emit(out,'identity.json',{'profiling':identity,'source':source,'scope':'Reused accepted owned baseline/Oz runtime; source versus compiled STACK. No rebuild, default promotion or fresh parity admission.'})
 try:
  assert identity['GITHUB_REPOSITORY']==REPOSITORY and identity['GITHUB_REF']==BRANCH and identity['GITHUB_EVENT_NAME']=='push'
  assert identity['GITHUB_RUN_ID']!=str(SOURCE_RUN)
  git=lambda root,*cmd:subprocess.check_output(['git','-C',str(root),*cmd],text=True).strip()
  assert git(trusted,'rev-parse','HEAD')==SOURCE_HEAD and git(trusted,'rev-parse','HEAD^{tree}')==SOURCE_TREE
  assert git(profiling,'rev-parse','HEAD')==identity['GITHUB_SHA']
  assert not git(trusted,'status','--porcelain','--untracked-files=no')
  assert digest((trusted/'.github/workflows/runtime-build.yml').read_bytes())=='be1faf5aba77f2d1c1dace09ba495687f03f086dbcf145f1ad2ad45f53e2f19c'
  toolroot=profiling/'runtime/profiling/baseline-trace-no-cpu';toolrecords=[]
  for p in [profiling/'.github/workflows/baseline-trace-no-cpu-pilot.yml',*sorted(toolroot.glob('*'))]:
   if not p.is_file():continue
   relative=p.relative_to(profiling);assert subprocess.check_output(['git','-C',str(profiling),'show',identity['GITHUB_SHA']+':'+relative.as_posix()])==p.read_bytes()
   dest=out/'tool-sources'/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest);toolrecords.append({'path':relative.as_posix(),**record(p)})
  emit(out,'tool-sources.json',toolrecords)
  run=api(f'/actions/runs/{SOURCE_RUN}');jobs=pages(f'/actions/runs/{SOURCE_RUN}/attempts/1/jobs','jobs');verify_run(run,jobs)
  merge=api('/commits/'+SOURCE_MERGE);assert merge['sha']==SOURCE_MERGE and merge['commit']['tree']['sha']==SOURCE_TREE and SOURCE_HEAD in {p['sha'] for p in merge['parents']}
  rows=pages(f'/actions/runs/{SOURCE_RUN}/artifacts','artifacts');artifacts={p:verify_artifact(rows,s) for p,s in SPECS.items()}
  emit(out,'source-api-provenance.json',{'run':run,'jobs':jobs,'merge':merge,'artifacts':artifacts})
  admitted={};native_programs=None;native_capture=None
  for profile,spec in SPECS.items():
   archive=work/'downloads'/f'{spec[0]}.zip';download(spec,archive)
   extracted=work/'extracted'/profile;inventory=unpack_selected(archive,extracted);assert len(inventory)==3404
   emit(out,f'{profile}-zip-inventory.json',{'artifact':artifacts[profile],'zipBytes':spec[2],'zipSha256':spec[3],'files':inventory})
   bypath={r['path']:r for r in inventory};assert len(bypath)==len(inventory)
   m=verify_package(extracted,profile,trusted,bypath);siteproof=verify_site_inputs(extracted,trusted,m)
   if profile=='baseline':
    # Retain this raw captured input before its semantic/provenance checks.
    target=out/'admission-inputs'/profile/BROWSER;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(extracted/BROWSER,target)
    native_programs,native_capture=native_workload(extracted,trusted,m,siteproof)
   files,preload=stage(extracted,work/'profiles'/profile/'site',m)
   admitted[profile]={'source':source,'artifact':artifacts[profile],'packageManifest':record(extracted/PACKAGE/'manifest.json'),'compilerProfile':m['compilerProfile'],'runtimeAssets':m['runtimeAssets'],'sourceIntegrity':m['sourceIntegrity'],'siteProof':siteproof,'stagedFiles':files,'reconstructedPreload':preload}
   emit(out,f'{profile}-admission.json',admitted[profile])
   for relative in ('manifest.json','source-manifest.json','artifact-manifest.json','logs/compiler-experiment.json','logs/target-source-overlay.json'):
    dest=out/'admission-inputs'/profile/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(extracted/PACKAGE/relative,dest)
  assert native_programs is not None and native_capture is not None
  emit(out,'admission.json',{'schema':1,'passed':True,'source':source,'profiling':identity,'profiles':admitted,
       'nativePrograms':native_programs,'nativeCapture':native_capture,
       'scope':'Both exact original packages admitted and staged; this dedicated pilot measures only baseline source/matching FAS with shared startup guard and TRACE/FS instrumentation, without CPU sampling/polling. Exact native programs come from its accepted316-program capture. No production, full-comparison or causal diagnosis claim.'})
  print('Admitted both immutable full-run packages; staged87 files per profile including exact manifest-bound preload reconstruction, without rebuilding.')
 except Exception as error:
  # Do not persist short-lived signed download URLs or credential-bearing requests.
  detail=('HTTP '+str(error.code)) if isinstance(error,urllib.error.HTTPError) else ('Network request failed' if isinstance(error,urllib.error.URLError) else str(error))
  emit(out,'admission-failure.json',{'passed':False,'type':type(error).__name__,'error':detail});raise SystemExit(type(error).__name__+': '+detail)

if __name__=='__main__':main()
