#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Classify runtime-byte reproducibility only for two distinct accepted cold jobs."""
import json
import os
from pathlib import Path
from cold_evidence import current_expectations, validate_build

ROOT = Path(__file__).resolve().parents[2]
identity = {'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'sourceRevision':os.environ['GITHUB_SHA']}
expected = current_expectations(ROOT, identity)
report = {'schema':1,'passed':False}
output = ROOT / 'test-results/runtime-reproducibility'
output.mkdir(parents=True,exist_ok=True)
try:
    builds = [validate_build(ROOT / '.cache/runtime-repro' / name,name,expected) for name in ['cold1','cold2']]
    assert builds[0]['environment']['buildIdentity'] != builds[1]['environment']['buildIdentity']
    differences = [{'path':path,'cold1':builds[0]['assets'][path],'cold2':builds[1]['assets'][path]} for path in sorted(expected['runtimePaths']) if builds[0]['assets'][path] != builds[1]['assets'][path]]
    report.update({'passed':True,'byteReproducible':not differences,
                   'classification':'byte-reproducible-runtime' if not differences else 'rebuildable-with-equivalent-behaviour',
                   'scope':'Two distinct accepted jobs in this exact current run/attempt/head, on fresh hosted runners without configured source/SDK/host/ccache restores. Current source pins, configuration, complete recipe and actual runtime bytes are verified. Only runtime bytes are compared; evidence timestamps and environment records are not expected to reproduce.',
                   'runtimeFiles':len(expected['runtimePaths']),'differences':differences,'builds':builds})
except Exception as error:
    report['failure'] = f'{type(error).__name__}: {error}'
(output / 'comparison.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({key:value for key,value in report.items() if key!='builds'}))
if not report['passed']:
    raise SystemExit(1)
