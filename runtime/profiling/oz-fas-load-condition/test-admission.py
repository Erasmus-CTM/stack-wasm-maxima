"""Data-only archive/admission controls; no browser, runtime, compiler or network."""
import copy,importlib.util,io,json,os,stat,tempfile,unittest,urllib.error,zipfile,base64
from pathlib import Path
from unittest.mock import patch
import artifact as p
import prepare as gate
HERE=Path(__file__).resolve().parent
TRUSTED=Path('/workspace/work/gc-aggregate-budget-fix')
class AdmissionTests(unittest.TestCase):
 def setUp(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
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

 def test_one_pinned_profile_and_activation_gate(self):
  binding=p.read(HERE/'bindings.json');binding['publicationAllowed']=False
  with patch.object(gate,'api',side_effect=AssertionError('No network allowed')):
   with self.assertRaisesRegex(AssertionError,'Template blocked'):gate.validate_bindings(binding,HERE)
  binding['publicationAllowed']=True;gate.validate_bindings(binding,HERE)
  for section,key,value in [('artifact','id',1),('artifact','zipSha256','0'*64),('artifact','packageFileCount',224),('source','head','0'*40),('source','recipeFiles',80),('independentReview','sha256','0'*64)]:
   bad=copy.deepcopy(binding);bad['profiles']['ecl-oz'][section][key]=value
   with self.assertRaises(AssertionError):gate.validate_bindings(bad,HERE)
  bad=copy.deepcopy(binding);bad['profiles']['baseline']=bad['profiles']['ecl-oz']
  with self.assertRaises(AssertionError):gate.validate_bindings(bad,HERE)
 def test_actual_old_oz_run_site_fas_and_native_capture(self):
  metadata=p.read(Path('/workspace/work/e8ad-full-baseline-review/final-api-metadata.json'));binding=p.read(HERE/'bindings.json')['profiles']['ecl-oz']
  p.verify_run(metadata['fullRun'],metadata['fullJobs'],binding);p.verify_artifact(metadata['artifacts']['artifacts'],binding)
  for key,value in [('head_sha','0'*40),('run_attempt',2),('status','in_progress'),('conclusion','failure')]:
   bad=copy.deepcopy(metadata['fullRun']);bad[key]=value
   with self.assertRaises(AssertionError):p.verify_run(bad,metadata['fullJobs'],binding)
  root=Path('/workspace/work/compiler-audit-evidence/12568085269');m=p.read(root/p.PACKAGE/'manifest.json');proof=p.verify_site_inputs(root,TRUSTED,m,binding)
  self.assertEqual(proof['compiledStack']['stackRevision'],'33383047af39c204bf4442802a058f8b918b2b1b')
  import sys;sys.path.insert(0,str(TRUSTED/'runtime/build'));from timing_evidence import captured_workload
  browser=p.read(root/p.BROWSER);programs=captured_workload(browser)
  self.assertEqual([row['operation'] for row in programs],['prepare','validate','prt'])
  self.assertEqual(browser['sourceRevision'],binding['source']['testedRevision']);self.assertFalse(browser['errors'])
  p.same(browser['runtime']['compiledStack'],proof['compiledStack'])
  p.same({r['path']:{'bytes':r['fileBytes'],'sha256':r['sha256']} for r in browser['runtime']['assets']},{r['path']:{'bytes':r['bytes'],'sha256':r['sha256']} for r in m['runtimeAssets']})
  browser['programs'].pop()
  with self.assertRaises(AssertionError):captured_workload(browser)
 def test_workflow_copies_all_six_adjacent_runtime_dependencies_and_runs12(self):
  import re,subprocess,yaml
  workflow=yaml.safe_load((HERE/'oz-fas-load-condition.yml').read_text());steps=workflow['jobs']['diagnose']['steps']
  setup=next(s['run'] for s in steps if s.get('name')=='Install the pinned diagnostic browser driver')
  loop=re.search(r'(?m)^for diagnostic_tool in (.+); do\n(.+)\ndone$',setup);self.assertIsNotNone(loop)
  names=loop[1].split();self.assertEqual(names,['run.mjs','clean-probe-worker.js','derive-startup-observer.mjs','startup-observer.jsfrag','condition-stage.mjs','load-condition.lisp'])
  source=self.root/'diagnostic/runtime/profiling/oz-fas-load-condition';source.mkdir(parents=True);target=self.root/'.cache/oz-fas-load-condition/tools';target.mkdir(parents=True)
  for name in names:(source/name).write_text('own inert fixture '+name)
  subprocess.run(['bash','-c','set -e\n'+loop[0]],cwd=self.root,check=True);self.assertEqual({p.name for p in target.iterdir()},set(names))
  (source/'load-condition.lisp').unlink();bad=subprocess.run(['bash','-c','set -e\n'+loop[0]],cwd=self.root,capture_output=True);self.assertNotEqual(bad.returncode,0)
  command=next(s['run'] for s in steps if s.get('name')=='Run the twelve bounded cold FAS diagnostic cases');self.assertIn('--trials 12',command)
  for flag in ['--cpu-profile','--operational-pilot','--baseline-trace-pilot']:self.assertNotIn(flag,command)
  self.assertEqual(workflow['permissions'],{'contents':'read','actions':'read'});self.assertEqual(workflow['jobs']['diagnose']['timeout-minutes'],120)
if __name__=='__main__':unittest.main()
