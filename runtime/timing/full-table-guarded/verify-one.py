#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""One trusted producer per interpreter; archive contents remain data only."""
import argparse,json,shutil,sys
from pathlib import Path
from artifact import PACKAGE,WORK,BROWSER,read,record,same,emit,verify_package,verify_site_inputs,stage
from prepare import trusted_checkout


def verify_stack_proofs(root,artifact,trusted,binding):
 sys.path.insert(0,str(trusted/'runtime/precompiled'))
 from stack_compiler_evidence import verify
 proofs={}
 for pin,folder in [('33383047af39c204bf4442802a058f8b918b2b1b',WORK),
                    ('10d323311b7f39fb7b092dd10ce75f7d8632f525','.cache/precompiled-stack-10d3233/')]:
  work=root/folder;actual=verify(work,artifact,pin)
  same(read(work/'logs/stack-compiler-package-binding.json'),actual)
  producer=read(work/'logs/stack-compiler-evidence.json')
  source=binding['source']
  same(producer['buildIdentity'],{'runId':str(source['runId']),'runAttempt':str(source['runAttempt']),'sourceRevision':source['testedRevision'],'coldBuild':None})
  proofs[pin]={'proof':record(work/'logs/stack-compiler-evidence.json'),
               'packageBinding':record(work/'logs/stack-compiler-package-binding.json'),
               'executionTrace':record(work/'logs/cross-compile-exec.log'),'bundle':record(work/'stackmaxima.fas')}
 return proofs


def main():
 parser=argparse.ArgumentParser();parser.add_argument('--profile',required=True)
 for name in ['binding','trusted-root','extracted','inventory','site','output']:parser.add_argument('--'+name,type=Path,required=True)
 args=parser.parse_args();binding=read(args.binding)['profiles'][args.profile]
 trusted=args.trusted_root.resolve();root=args.extracted.resolve();artifact=root/PACKAGE
 trusted_checkout(trusted,binding['source'])
 # Preserve raw proof data before verification, so failures retain their inputs.
 # Exclude only huge source/toolchain archives
 # and runtime/recipe copies whose complete hashes are already inventoried.
 destination=args.output/'admission-inputs'/args.profile
 for path in root.rglob('*'):
  if not path.is_file():continue
  relative=path.relative_to(root)
  if relative.as_posix().startswith(PACKAGE) and any(part in ('sources','runtime','recipe') for part in relative.parts[3:]):continue
  target=destination/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
 rows=read(args.inventory)['files'];inventory={r['path']:r for r in rows};assert len(rows)==len(inventory)
 m=verify_package(root,args.profile,trusted,inventory,binding)
 siteproof=verify_site_inputs(root,trusted,m,binding)
 from timing_evidence import captured_workload
 browser=read(root/BROWSER)
 assert browser['sourceRevision']==binding['source']['testedRevision'] and not browser['errors']
 assert len(browser['runtime']['assets'])==len({r['path'] for r in browser['runtime']['assets']})==79
 same(browser['runtime']['compiledStack'],siteproof['compiledStack'])
 same({r['path']:{'bytes':r['fileBytes'],'sha256':r['sha256']} for r in browser['runtime']['assets']},
      {r['path']:{'bytes':r['bytes'],'sha256':r['sha256']} for r in m['runtimeAssets']})
 programs=captured_workload(browser)
 stackproofs=verify_stack_proofs(root,artifact,trusted,binding) if args.profile=='ecl-oz-maxima-oz' else None
 # Stage only after the package, exact matching FAS, and both new FAS proofs pass.
 files,preload=stage(root,args.site,m)
 proof={'source':binding['source'],'packageManifest':record(artifact/'manifest.json'),
        'compilerProfile':m['compilerProfile'],'runtimeAssets':m['runtimeAssets'],'sourceIntegrity':m['sourceIntegrity'],
        'siteProof':siteproof,'stagedFiles':files,'preload':preload,'stackCompilerProofs':stackproofs,
        'nativePrograms':programs,'nativeCapture':record(root/BROWSER),
        'independentReview':binding['independentReview']}
 emit(args.output,args.profile+'-admission.json',proof)



if __name__=='__main__':main()
