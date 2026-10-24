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

 def test_unreviewed_template_blocks_before_api(self):
  bindings=p.read(HERE/'bindings.json')
  with patch.object(gate,'api',side_effect=AssertionError('Network must not run')):
   with self.assertRaisesRegex(AssertionError,'Template blocked'):gate.validate_bindings(bindings,HERE)
  bindings['publicationAllowed']=True;gate.validate_bindings(bindings,HERE)
  for key,value in [('id',1),('zipSha256','0'*64),('zipBytes',1)]:
   bad=copy.deepcopy(bindings);bad['producer']['artifact'][key]=value
   with self.assertRaises(AssertionError):gate.validate_bindings(bad,HERE)
  bad=copy.deepcopy(bindings);bad['producer']['source']['head']='0'*40
  with self.assertRaises(AssertionError):gate.validate_bindings(bad,HERE)
 def test_actual_producer_and_fas_inputs_preserve_benchmark_identity(self):
  metadata=p.read(Path('/workspace/work/e8ad-full-baseline-review/final-api-metadata.json'))
  binding=p.read(HERE/'bindings.json')['producer']
  p.verify_run(metadata['fullRun'],metadata['fullJobs'],binding);p.verify_artifact(metadata['artifacts']['artifacts'],binding)
  for field,value in [('head_sha','0'*40),('run_attempt',2),('status','in_progress'),('conclusion','failure')]:
   bad=copy.deepcopy(metadata['fullRun']);bad[field]=value
   with self.assertRaises(AssertionError):p.verify_run(bad,metadata['fullJobs'],binding)
  root=Path('/workspace/work/compiler-audit-evidence/12568085269');m=p.read(root/p.PACKAGE/'manifest.json')
  with patch.dict(os.environ,{'GITHUB_SHA':'fresh-benchmark-head'}):
   proof=p.verify_site_inputs(root,TRUSTED,m,binding)
   self.assertEqual(os.environ['GITHUB_SHA'],'fresh-benchmark-head')
  self.assertEqual(proof['stackRevision'],'33383047af39c204bf4442802a058f8b918b2b1b')
  wrong=copy.deepcopy(binding);wrong['source']['testedRevision']='0'*40
  with self.assertRaises(AssertionError):p.verify_site_inputs(root,TRUSTED,m,wrong)
 def test_exact_derived_manifest_delta_and_raw_proof_binding(self):
  # Own staging fixture: actual manifests/FAS/JS are read only as data. Other
  # runtime payloads are inert placeholders; this test exercises derivation,
  # never claims package admission for the fixture.
  import shutil
  original=Path('/workspace/work/compiler-audit-evidence/12568085269')
  control=self.root/'control';shutil.copytree(original/p.SITE,control)
  m=p.read(original/p.PACKAGE/'manifest.json')
  for asset in m['runtimeAssets']:
   target=control/'maxima-runtime'/asset['path'];target.parent.mkdir(parents=True,exist_ok=True)
   body=(Path('/workspace/work/compiler-audit-evidence/12578048686/staged/ecl-oz/maxima-runtime/maxima.js').read_bytes()
         if asset['path']=='maxima.js' else b'inert transformation fixture')
   target.write_bytes(body)
  (control/'maxima-runtime/runtime-preload.json').write_bytes(b'inert preload fixture')
  package=p.record(original/p.PACKAGE/'manifest.json');out=self.root/'proof'
  proof,assets,build=gate.derive_runtime(control,self.root/'changed',out,m,package)
  self.assertEqual(len(assets),79);self.assertEqual(build['derivationSha256'],p.record(out/'derivation.json')['sha256'])
  self.assertEqual(build['manifestSha256'],p.record(out/'derived-runtime-manifest.json')['sha256'])
  self.assertEqual(proof['derived'],p.record(self.root/'changed/maxima-runtime/maxima.js'))
  for name in gate.MANIFESTS:
   a=p.read(control/name);b=p.read(self.root/'changed'/name);b['runtimeBuild']=a['runtimeBuild']
   next(r for r in b['runtimeAssets'] if r['path']=='maxima.js').update(next(r for r in a['runtimeAssets'] if r['path']=='maxima.js'))
   self.assertEqual(a,b)
  for a in gate.files(control):
   if a['path'] in ['maxima-runtime/maxima.js',*gate.MANIFESTS]:continue
   self.assertEqual((control/a['path']).read_bytes(),(self.root/'changed'/a['path']).read_bytes())
  original_body=(control/'maxima-runtime/maxima.js').read_bytes();(control/'maxima-runtime/maxima.js').write_bytes(original_body+b' ')
  with self.assertRaisesRegex(AssertionError,'Unexpected original'):gate.derive_runtime(control,self.root/'tampered',self.root/'bad-proof',m,package)
 def test_raw_inputs_retained_before_package_rejection(self):
  root=self.root/'input';(root/p.BROWSER).parent.mkdir(parents=True);(root/p.BROWSER).write_bytes(b'raw evidence')
  binding=p.read(HERE/'bindings.json')['producer'];out=self.root/'evidence'
  with patch.object(gate,'verify_package',side_effect=AssertionError('deliberate failed verifier')):
   with self.assertRaisesRegex(AssertionError,'deliberate failed'):gate.admit_and_stage(root,TRUSTED,[],binding,self.root/'arms',out)
  self.assertEqual((out/'admission-inputs'/p.BROWSER).read_bytes(),b'raw evidence')
if __name__=='__main__':unittest.main()
