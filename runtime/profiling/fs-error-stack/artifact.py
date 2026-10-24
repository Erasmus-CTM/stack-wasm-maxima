#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Data-only admission helpers; run profile verification in separate processes."""
import argparse,base64,copy,hashlib,json,os,shutil,stat,subprocess,sys,urllib.error,urllib.parse,urllib.request,zipfile
from pathlib import Path,PurePosixPath
REPOSITORY='Erasmus-CTM/stack-wasm-maxima'
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

def verify_run(run,jobs,binding):
 source=binding['source']
 assert run['id']==source['runId'] and run['workflow_id']==source['workflowId'] and run['run_attempt']==source['runAttempt']
 assert run['repository']['full_name']==REPOSITORY and run['head_sha']==source['head']
 assert run['status']=='completed' and run['conclusion']=='success'
 assert len(jobs)==len(source['jobs'])
 same(sorted([{'id':r['id'],'name':r['name']} for r in jobs],key=lambda r:r['id']),sorted(source['jobs'],key=lambda r:r['id']))
 assert all(j['status']=='completed' and j['conclusion']=='success' for j in jobs)

def verify_artifact(rows,binding):
 spec=binding['artifact'];source=binding['source']
 identifier,name,size,sha=spec['id'],spec['name'],spec['zipBytes'],spec['zipSha256'];matches=[r for r in rows if r['id']==identifier or r['name']==name]
 assert len(matches)==1,'Missing or ambiguous exact artifact';row=matches[0]
 assert row['id']==identifier and row['name']==name and row['expired'] is False
 assert row['size_in_bytes']==size and row['digest']=='sha256:'+sha
 assert row['workflow_run']['id']==source['runId'] and row['workflow_run']['head_sha']==source['head']
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

def selected(path):
 return (path.startswith(PACKAGE) or path.startswith(SITE) or path in BUNDLE_FILES or path in (MEASURE,BROWSER) or
         any(path.startswith(prefix+'source-initialized/') or path.startswith(prefix+'logs/cross-compile') or
             path.startswith(prefix+'logs/stack-compiler-') or path in {prefix+'stackmaxima.fas',prefix+'stackmaxima.fas.json',prefix+'assignment-adapter.lisp'}
             for prefix in (WORK,'.cache/precompiled-stack-10d3233/')))

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

def verify_package(root,profile,trusted,inventory,binding):
 source=binding['source']
 artifact=root/PACKAGE;m=read(artifact/'manifest.json');rows=package_closure(artifact,inventory)
 assert len(rows)==binding['artifact']['packageFileCount'] and len(m['runtimeAssets'])==79
 sys.path.insert(0,str(trusted/'runtime/build'))
 from recipe_inputs import recipe_records
 from source_overlay import verify_packaged as overlay
 from compiler_evidence import verify_packaged as compiler
 same(m['recipe'],{'repository':'https://github.com/'+REPOSITORY,'revision':source['testedRevision'],'files':recipe_records(trusted)})
 assert len(m['recipe']['files'])==source['recipeFiles']
 same(m['sourcePins'],read(trusted/'runtime/build/pins.json'));same(m['configuration'],read(trusted/'runtime/build/configuration.json'))
 from compiler_profile import compiler_profile
 same(m['compilerProfile'],compiler_profile(profile))
 for folder,records in [('recipe',m['recipe']['files']),('runtime',m['runtimeAssets'])]:
  assert len({r['path'] for r in records})==len(records)
  for row in records:
   safe_path(row['path']);same(record(artifact/folder/row['path']),{k:row[k] for k in ('bytes','sha256')})
   if folder=='recipe':assert (artifact/folder/row['path']).read_bytes()==(trusted/row['path']).read_bytes()
 same(read(artifact/'source-manifest.json'),{k:m[k] for k in ('schema','compilerProfile','sourcePins','recipe','toolchain','upstreamRecipe','sourceIntegrity','configuration','startupAdapter')})
 environment=read(artifact/'logs/environment.json')
 same(environment['buildIdentity'],{'runId':str(source['runId']),'runAttempt':str(source['runAttempt']),'sourceRevision':source['testedRevision'],'coldBuild':None})
 same(environment['compilerProfile'],m['compilerProfile'])
 same(overlay(artifact,trusted),m['sourceIntegrity']);compiler(artifact,m['compilerProfile'])
 return m

def verify_site_inputs(root,trusted,m,binding):
 site=root/SITE;original=read(site/'stack-sources.json');timed=read(site/'stack-sources-timed-source.json');compiled=read(site/'stack-sources-precompiled.json')
 assert {p.relative_to(site).as_posix() for p in site.rglob('*') if p.is_file()}==SITE_FILES|({'maxima-runtime/runtime-preload.json'} if binding['artifact']['archivedPreload'] else set())
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
 measured=read(root/MEASURE);assert measured['passed'] is True and measured['sourceRevision']==binding['source']['testedRevision']
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
 expected=read(root/SITE/'stack-sources.json')['preload'];target=destination/'maxima-runtime/runtime-preload.json'
 if target.exists():
  assert expected['path']=='runtime-preload.json';same(record(target),{'bytes':expected['fileBytes'],'sha256':expected['sha256']})
  preload={'path':'maxima-runtime/runtime-preload.json',**record(target),'origin':'Exact archived producer preload bytes'}
 else:preload=reconstruct_preload(destination,expected,m['runtimeAssets'])
 files=[{'path':p.relative_to(destination).as_posix(),**record(p)} for p in sorted(destination.rglob('*')) if p.is_file()]
 assert len(files)==87;return files,preload
