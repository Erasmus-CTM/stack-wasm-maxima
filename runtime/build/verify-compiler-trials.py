#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Admit only current, fully accepted trial artifacts before shared-runner timing."""
import json
import os
from pathlib import Path
from cold_evidence import current_expectations, digest, validate_build
from compiler_profile import profiles
from timing_evidence import verify_workload_files

ROOT = Path(__file__).resolve().parents[2]
TRIALS = ROOT/'.cache/compiler-trials'
OUT = TRIALS/'comparison'
OUT.mkdir(parents=True,exist_ok=True)
report = {'schema':1,'passed':False,'trials':{}}
try:
    identity = {'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'sourceRevision':os.environ['GITHUB_SHA']}
    programs = None
    # Comparison membership is explicit and independent of production promotion.
    for name in ('baseline', 'ecl-oz', 'ecl-o2'):
        profile = profiles()['profiles'][name]
        root = TRIALS/name
        expected = current_expectations(ROOT,identity)
        expected['compilerProfile']=profile
        accepted = validate_build(root,'cold1',expected)
        acceptance = root/'.cache/runtime-build/validation/acceptance.json'
        metadata = json.loads(acceptance.read_bytes())
        assert metadata['compilerProfile']==profile
        evidence = root/'.cache/runtime-build/artifact/logs/compiler-experiment.json'
        assert metadata['compilerEvidenceSha256']==digest(evidence.read_bytes())
        timing_path = root/'.cache/runtime-build/validation/timings.json'
        trial_programs=verify_workload_files(timing_path,root/'test-results/milestone-three/browser.json',metadata,accepted['manifestSha256'])
        timing = json.loads(timing_path.read_bytes())
        assert timing['passed'] and timing['owned']['runtimeBuild']['manifestSha256']==accepted['manifestSha256']
        if programs is None:
            programs=trial_programs
        assert trial_programs==programs, 'Controlled trials must execute identical native programs and expected values'
        assert len(programs)==3 and {p['operation'] for p in programs}=={'prepare','validate','prt'}
        accepted.update(acceptanceSha256=digest(acceptance.read_bytes()),
                        artifactManifestSha256=digest((root/'.cache/runtime-build/artifact/artifact-manifest.json').read_bytes()),
                        timingReportSha256=digest(timing_path.read_bytes()),runtimeBytes=sum(row['bytes'] for row in accepted['assets'].values()))
        report['trials'][name]=accepted
    assert len({trial['manifestSha256'] for trial in report['trials'].values()})==3, 'Duplicate trial artifact'
    report['nativePrograms']=programs
    report['passed']=True
except Exception as error:
    report['failure']=f'{type(error).__name__}: {error}'
finally:
    (OUT/'admission.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':report['passed'],'trials':list(report['trials']),'failure':report.get('failure')}))
if not report['passed']:
    raise SystemExit(1)
