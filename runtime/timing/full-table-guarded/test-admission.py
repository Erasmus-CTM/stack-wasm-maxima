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

 def test_bound_template_requires_activation_and_exact_review_bytes(self):
  bindings=p.read(HERE/'bindings.json')
  with patch.object(gate,'api',side_effect=AssertionError('Network must not run')):
   with self.assertRaisesRegex(AssertionError,'Template blocked'):gate.validate_bindings(bindings,HERE)
  bindings['publicationAllowed']=True;gate.validate_bindings(bindings,HERE)
  bindings['profiles']['ecl-oz-maxima-oz']['independentReview']['sha256']='0'*64
  with self.assertRaisesRegex(AssertionError,'Independent review bytes differ'):gate.validate_bindings(bindings,HERE)
 def test_old_run_identity_and_artifact_are_bound_per_producer(self):
  metadata=p.read(Path('/workspace/work/e8ad-full-baseline-review/final-api-metadata.json'))
  bindings=p.read(HERE/'bindings.json')['profiles']
  for name in ['baseline','ecl-oz']:
   binding=bindings[name];p.verify_run(metadata['fullRun'],metadata['fullJobs'],binding)
   p.verify_artifact(metadata['artifacts']['artifacts'],binding)
   for field,value in [('head_sha','0'*40),('run_attempt',2),('status','in_progress'),('conclusion','failure')]:
    bad=copy.deepcopy(metadata['fullRun']);bad[field]=value
    with self.assertRaises(AssertionError):p.verify_run(bad,metadata['fullJobs'],binding)
   wrong=copy.deepcopy(binding);wrong['source']['runId']=40136606442
   with self.assertRaises(AssertionError):p.verify_run(metadata['fullRun'],metadata['fullJobs'],wrong)
   with self.assertRaises(AssertionError):p.verify_artifact(metadata['artifacts']['artifacts'],wrong)
 def test_old_actual_site_and_fas_bytes_with_original_identity(self):
  bindings=p.read(HERE/'bindings.json')['profiles']
  for name in ['baseline','ecl-oz']:
   root=Path('/workspace/work/compiler-audit-evidence')/str(bindings[name]['artifact']['id'])
   m=p.read(root/p.PACKAGE/'manifest.json')
   with patch.dict(os.environ,{'GITHUB_SHA':'fresh-benchmark-head'}):
    proof=p.verify_site_inputs(root,TRUSTED,m,bindings[name])
    self.assertEqual(os.environ['GITHUB_SHA'],'fresh-benchmark-head')
   self.assertEqual(proof['stackRevision'],'33383047af39c204bf4442802a058f8b918b2b1b')
   wrong=copy.deepcopy(bindings[name]);wrong['source']['testedRevision']='0'*40
   with self.assertRaises(AssertionError):p.verify_site_inputs(root,TRUSTED,m,wrong)
 def test_new_both_pin_compiler_proofs_cannot_be_omitted_or_cross_bound(self):
  spec=importlib.util.spec_from_file_location('verify_one',HERE/'verify-one.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
  import types,sys
  expected={'schema':1,'passed':True,'fixture':'verified by trusted source checker'};calls=[]
  module=types.ModuleType('stack_compiler_evidence');module.verify=lambda work,artifact,pin:(calls.append(pin) or expected)
  binding=p.read(HERE/'bindings.json')['profiles']['ecl-oz-maxima-oz'];source=binding['source']
  works=[]
  for pin,folder in [('33383047af39c204bf4442802a058f8b918b2b1b',p.WORK),('10d323311b7f39fb7b092dd10ce75f7d8632f525','.cache/precompiled-stack-10d3233/')]:
   work=self.root/folder;works.append(work);(work/'logs').mkdir(parents=True)
   p.emit(work/'logs','stack-compiler-package-binding.json',expected)
   p.emit(work/'logs','stack-compiler-evidence.json',{'buildIdentity':{'runId':str(source['runId']),'runAttempt':'1','sourceRevision':source['testedRevision'],'coldBuild':None}})
   (work/'logs/cross-compile-exec.log').write_bytes(b'fixture raw execution trace');(work/'stackmaxima.fas').write_bytes(b'fixture bundle')
  with patch.dict(sys.modules,{'stack_compiler_evidence':module}):
   proof=v.verify_stack_proofs(self.root,self.root/'artifact',TRUSTED,binding);self.assertEqual(set(proof),set(calls));self.assertEqual(len(proof),2)
   p.emit(works[1]/'logs','stack-compiler-package-binding.json',{'passed':True,'fixture':'copied wrong proof'})
   with self.assertRaises(AssertionError):v.verify_stack_proofs(self.root,self.root/'artifact',TRUSTED,binding)
   (works[1]/'logs/stack-compiler-package-binding.json').unlink()
   with self.assertRaises(FileNotFoundError):v.verify_stack_proofs(self.root,self.root/'artifact',TRUSTED,binding)
if __name__=='__main__':unittest.main()
