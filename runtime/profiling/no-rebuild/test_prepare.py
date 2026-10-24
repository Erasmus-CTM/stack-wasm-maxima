"""Data-only admission regressions; no network, browser, runtime or compiler."""
import base64,copy,hashlib,importlib.util,io,json,os,re,stat,subprocess,tempfile,unittest,urllib.error,zipfile
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('profile_prepare',HERE/'prepare.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
TRUSTED=Path('/workspace/work/gc-aggregate-budget-fix')

class AdmissionTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
 def test_current_run_and_both_exact_artifacts_pass_and_wrong_identity_fails(self):
  metadata=json.loads(Path('/workspace/work/e8ad-full-baseline-review/final-api-metadata.json').read_text())
  p.verify_run(metadata['fullRun'],metadata['fullJobs'])
  for spec in p.SPECS.values():p.verify_artifact(metadata['artifacts']['artifacts'],spec)
  for field,value in [('head_sha','0'*40),('run_attempt',2),('status','in_progress'),('conclusion','failure')]:
   bad=copy.deepcopy(metadata['fullRun']);bad[field]=value
   with self.assertRaises(AssertionError):p.verify_run(bad,metadata['fullJobs'])
  jobs=copy.deepcopy(metadata['fullJobs']);jobs[0]['conclusion']='failure'
  with self.assertRaises(AssertionError):p.verify_run(metadata['fullRun'],jobs)
  spec=p.SPECS['baseline'];good=p.verify_artifact(metadata['artifacts']['artifacts'],spec)
  for field,value in [('id',1),('name','latest'),('size_in_bytes',1),('digest','sha256:'+'0'*64),('expired',True)]:
   with self.assertRaises(AssertionError):p.verify_artifact([{**good,field:value}],spec)
  with self.assertRaises(AssertionError):p.verify_artifact([good,good],spec)
 def test_metadata_bearer_redirects_never_follow_any_redirect_status(self):
  real=p.urllib.request.build_opener
  for status in (301,302,303,307,308):
   seen=[]
   def build(*handlers):
    self.assertIn(p.NoRedirect,handlers);opener=real(*handlers)
    def opened(request,timeout):
     seen.append(request);return opener.error('http',request,io.BytesIO(),status,'Redirect',{'Location':'https://example.invalid/credential-target'})
    opener.open=opened;return opener
   with patch.dict(os.environ,{'GH_TOKEN':'test-token'}),patch.object(p.urllib.request,'build_opener',side_effect=build):
    with self.assertRaises(urllib.error.HTTPError) as error:p.api('/actions/runs/1')
   self.assertEqual(error.exception.code,status);self.assertEqual(len(seen),1);self.assertEqual(seen[0].get_header('Authorization'),'Bearer test-token')
 def test_download_storage_has_no_token_and_rejects_wrong_hash_and_insecure_location(self):
  data=b'fake ZIP bytes';seen=[];location='https://storage.example/signed'
  class Opener:
   def open(self,request,timeout):
    seen.append(request)
    if request.full_url.startswith(p.API):raise urllib.error.HTTPError(request.full_url,302,'Redirect',{'Location':location},None)
    return io.BytesIO(data)
  with patch.dict(os.environ,{'GH_TOKEN':'test-token'}),patch.object(p.urllib.request,'build_opener',return_value=Opener()):
   p.download((1,'test',len(data),p.digest(data)),self.root/'good.zip')
   self.assertEqual(seen[0].get_header('Authorization'),'Bearer test-token');self.assertIsNone(seen[1].get_header('Authorization'))
   with self.assertRaises(AssertionError):p.download((1,'test',len(data),'0'*64),self.root/'bad.zip')
   location='http://storage.example/insecure'
   with self.assertRaises(AssertionError):p.download((1,'test',len(data),p.digest(data)),self.root/'insecure.zip')
 def zip(self,entries):
  archive=self.root/'input.zip'
  with zipfile.ZipFile(archive,'w') as z:
   for name,body,mode in entries:
    info=zipfile.ZipInfo(name);info.external_attr=(mode|0o600)<<16;z.writestr(info,body)
  return archive
 def test_selective_extraction_hashes_even_unselected_entries_and_rejects_zip_paths(self):
  archive=self.zip([(p.PACKAGE+'file',b'package',stat.S_IFREG),('unused/data',b'also hashed',stat.S_IFREG)])
  destination=self.root/'valid';rows=p.unpack_selected(archive,destination);self.assertEqual(len(rows),2);self.assertTrue((destination/p.PACKAGE/'file').is_file());self.assertFalse((destination/'unused/data').exists());self.assertEqual(rows[1]['sha256'],p.digest(b'also hashed'))
  for i,entries in enumerate([[('../escape',b'x',stat.S_IFREG)],[('/absolute',b'x',stat.S_IFREG)],[('a\\b',b'x',stat.S_IFREG)],[('a/./b',b'x',stat.S_IFREG)],[('link',b'/elsewhere',stat.S_IFLNK)],[('same',b'x',stat.S_IFREG),('same',b'y',stat.S_IFREG)]]):
   with self.assertRaises(AssertionError):p.unpack_selected(self.zip(entries),self.root/f'bad{i}')
 def test_package_closure_nested_manifest_is_covered_and_tampering_rejected(self):
  artifact=self.root/'artifact';(artifact/'logs').mkdir(parents=True);body=b'nested';(artifact/'logs/artifact-manifest.json').write_bytes(body)
  row={'path':'logs/artifact-manifest.json','bytes':len(body),'sha256':p.digest(body)};(artifact/'artifact-manifest.json').write_text(json.dumps({'files':[row]}))
  inventory={p.PACKAGE+row['path']:{**row,'path':p.PACKAGE+row['path']},p.PACKAGE+'artifact-manifest.json':{}}
  p.package_closure(artifact,inventory)
  (artifact/'extra').write_bytes(b'extra')
  with self.assertRaises(AssertionError):p.package_closure(artifact,inventory)
  (artifact/'extra').unlink();(artifact/'logs/artifact-manifest.json').write_bytes(b'changed')
  with self.assertRaises(AssertionError):p.package_closure(artifact,inventory)
 def test_exact_preload_reconstruction_and_wrong_hash_path_order_rejection(self):
  destination=self.root/'site';runtime=destination/'maxima-runtime';runtime.mkdir(parents=True)
  for name,body in [('a.fas',b'\0asm'),('b.lisp',b'(identity 42)')]: (runtime/name).write_bytes(body)
  paths=['a.fas','b.lisp'];body=(json.dumps({'schema':1,'files':[{'path':n,'content':base64.b64encode((runtime/n).read_bytes()).decode()} for n in paths]},separators=(',',':'))+'\n').encode()
  preload={'path':'runtime-preload.json','paths':paths,'fileBytes':len(body),'sha256':p.digest(body)};assets=[{'path':n} for n in paths]
  result=p.reconstruct_preload(destination,preload,assets);self.assertEqual((runtime/'runtime-preload.json').read_bytes(),body);self.assertIn('reconstructed',result['origin']);(runtime/'runtime-preload.json').unlink()
  for patchrow in [{'sha256':'0'*64},{'paths':['b.lisp','a.fas']},{'paths':['../escape']}]:
   with self.assertRaises(AssertionError):p.reconstruct_preload(destination,{**preload,**patchrow},assets)
 def test_actual_both_site_manifests_and_bundles_bind_without_executing_them(self):
  for identifier in (12567788724,12568085269):
   root=Path('/workspace/work/compiler-audit-evidence')/str(identifier);m=p.read(root/p.PACKAGE/'manifest.json');proof=p.verify_site_inputs(root,TRUSTED,m)
   self.assertEqual(proof['stackRevision'],'33383047af39c204bf4442802a058f8b918b2b1b');self.assertEqual(len(proof['siteManifestRecords']),7)
   original=p.read
   def tampered(path):
    data=original(path)
    if path==root/p.SITE/'stack-sources-precompiled.json':
     loader=next(r for r in data['files'] if r['path']=='stack/maxima/stacklocallinux.mac');loader['content']=loader['content'].replace('stackmaxima.fas','stackmaxima.mac')
    return data
   with patch.object(p,'read',side_effect=tampered):
    with self.assertRaises(AssertionError):p.verify_site_inputs(root,TRUSTED,m)
 def test_current_recipe_shape_is_exact_and_preserves_fresh_github_identity(self):
  import sys;sys.path.insert(0,str(TRUSTED/'runtime/build'));from recipe_inputs import recipe_records
  m=p.read(Path('/workspace/work/compiler-audit-evidence/12567788724')/p.PACKAGE/'manifest.json')
  with patch.dict(os.environ,{'GITHUB_SHA':'fresh-benchmark-not-original-source'}):
   p.same(m['recipe'],{'repository':'https://github.com/'+p.REPOSITORY,'revision':p.SOURCE_MERGE,'files':recipe_records(TRUSTED)})
   self.assertEqual(os.environ['GITHUB_SHA'],'fresh-benchmark-not-original-source')
  with self.assertRaises(AssertionError):p.same(True,1)
 def test_workflow_copies_complete_adjacent_harness_and_fails_if_hook_missing(self):
  import yaml
  workflow=yaml.safe_load((HERE/'no-rebuild-profile.yml').read_text());step=next(s for s in workflow['jobs']['profile']['steps'] if s.get('name')=='Install pinned Chromium harness dependencies')
  match=re.search(r'(?m)^for profile_tool in (.+); do\n(.+)\ndone$',step['run']);self.assertIsNotNone(match)
  names=match[1].split();self.assertEqual(names,['run.mjs','stage.mjs','cdp-profile.mjs','child-hooks.js','load-hooks.lisp','probe-worker.js'])
  source=self.root/'profiling/runtime/profiling/no-rebuild';source.mkdir(parents=True);trusted=self.root/'trusted';target=trusted/'.cache/no-rebuild-profile/tools';target.mkdir(parents=True)
  for name in names:(source/name).write_text('fixture '+name)
  (source/'__pycache__').mkdir();(source/'__pycache__/unused').write_text('must not copy')
  command='set -e\n'+match[0];subprocess.run(['bash','-c',command],cwd=trusted,check=True)
  self.assertEqual({f.name for f in target.iterdir()},set(names))
  for name in names:self.assertEqual((target/name).read_bytes(),(source/name).read_bytes())
  (source/'load-hooks.lisp').unlink();bad=subprocess.run(['bash','-c',command],cwd=trusted,capture_output=True,text=True);self.assertNotEqual(bad.returncode,0)

if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AdmissionTests))
 (HERE/'prepare-test-results.json').write_text(json.dumps({'tests':result.testsRun,'passed':result.wasSuccessful(),'failures':len(result.failures),'errors':len(result.errors),'scope':'Own-source data fixtures and existing decoded evidence only; no network or artifact/browser/compiler execution.'},indent=2)+'\n')
 raise SystemExit(not result.wasSuccessful())
