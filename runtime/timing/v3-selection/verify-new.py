"""Replay accepted producer evidence using only its pinned Git checkout as code."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'full-table-guarded'))
from artifact import read,record,same,emit,safe_path

parser=argparse.ArgumentParser()
for name in ('binding','trusted-root','extracted','output'):parser.add_argument('--'+name,type=Path,required=True)
a=parser.parse_args();binding=read(a.binding);assert binding['ready'] is True
source=binding['source'];trusted=a.trusted_root.resolve();root=a.extracted.resolve();artifact=root/'.cache/runtime-build/artifact'
def git(*args):return subprocess.check_output(['git','-C',str(trusted),*args],text=True).strip()
assert git('rev-parse','HEAD')==source['trustedRevision']==source['testedRevision']
assert git('rev-parse','HEAD^{tree}')==source['tree']
assert not git('status','--porcelain','--untracked-files=no')
sys.path.insert(0,str(trusted/'runtime/build'));sys.path.insert(0,str(trusted/'runtime/precompiled'))
from cold_evidence import current_expectations,validate_build
from compiler_profile import compiler_profile
identity={'runId':str(source['runId']),'runAttempt':str(source['runAttempt']),'sourceRevision':source['testedRevision']}
expected=current_expectations(trusted,identity);expected['compilerProfile']=compiler_profile('ecl-oz-maxima-oz')
assert len(expected['recipe']['files'])==source['recipeFiles']
verified=validate_build(root,'cold1',expected)
acceptance=read(root/'.cache/runtime-build/validation/acceptance.json');manifest=read(artifact/'manifest.json')
assert record(artifact/'manifest.json')['sha256']==binding['artifact']['manifestSha256']
assert acceptance['compilerProfile']==expected['compilerProfile']
assert acceptance['compilerEvidenceSha256']==record(artifact/'logs/compiler-experiment.json')['sha256']
# Report/archive content remains data. Only the independently pinned checkout
# supplies verifier code. Stage ignored evidence paths for its existing reader.
for relative in ('.cache/precompiled-stack','.cache/precompiled-stack-10d3233','.cache/precompiled-fixtures','test-results'):
 src=root/relative;dest=trusted/relative;assert src.is_dir() and not dest.exists(),relative
 dest.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(src,dest)
from stack_acceptance import verify
same(verify(artifact,source['testedRevision']),acceptance['stackAcceptance'])
browser_path=root/'test-results/milestone-three/browser.json';browser=read(browser_path)
assert browser['passed'] is True and len(browser['programs'])==316 and browser['sourceRevision']==source['testedRevision']
assert record(browser_path)['sha256']==acceptance['browserReportSha256']
for kind in ('native-reference','same-source-reference'):
 reference=read(root/'test-results/milestone-three'/kind/'native-reference.json')
 assert reference['passed'] is True and reference['summary']['programs']==316 and reference['summary']['unaccepted']==0
 assert reference['browserReport']['sha256']==record(browser_path)['sha256']
 same(reference['wasmRuntime'],browser['runtime'])
for mode in ('deployed','owned'):
 comparison=read(root/f'.cache/runtime-build/validation/m1-{mode}/comparison.json')
 assert comparison['status']=='passed' and len(comparison['versions'])==2
 assert {v['stackRevision'] for v in comparison['versions']}==set(manifest['sourcePins']['stack'])
 assert all(v['passed'] is True and v['comparisonCount']==22 for v in comparison['versions'])
plot=read(root/'.cache/runtime-build/validation/plot-diagnostic.json')
assert plot['passed'] and plot['expectedBuildFailure'] and plot['runtimeBuild']['manifestSha256']==verified['manifestSha256']
assert plot['buildFailureSha256']==record(root/'.cache/runtime-build/plot-diagnostic/preparation/build-failure.json')['sha256']
assert 'CTM plotting unavailable; use JSXGraph.' in plot['diagnostic']
from timing_evidence import captured_workload,validate_workload
timings=read(root/'.cache/runtime-build/validation/timings.json');validate_workload(timings,browser)
assert timings['passed'] is True and record(root/'.cache/runtime-build/validation/timings.json')['sha256']==acceptance['timingReportSha256']
assert not git('status','--porcelain','--untracked-files=no')
proof={'source':source,'packageManifest':record(artifact/'manifest.json'),'compilerProfile':manifest['compilerProfile'],
 'runtimeAssets':manifest['runtimeAssets'],'sourceIntegrity':manifest['sourceIntegrity'],
 'nativeCapture':record(browser_path),'producerNativePrograms':captured_workload(browser),
 'acceptance':record(root/'.cache/runtime-build/validation/acceptance.json'),
 'stackAcceptance':acceptance['stackAcceptance'],'independentReview':binding['independentReview'],
 'scope':'Pinned Git verifiers replay package/source/compiler/STACK/GC evidence; native316, both-pin official probes, plot and timing receipts are checked against the accepted source identity. Archive files are never executed as verifier code.'}
emit(a.output,'flattened-candidate-admission.json',proof)
