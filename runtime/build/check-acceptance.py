#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fail closed unless the owned artifact has the complete requested evidence."""
import importlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.cache/runtime-build/validation'

def read(path):
    return json.loads(path.read_text())

def main():
    report = {'schema': 1, 'passed': False, 'probeComparisons': []}
    try:
        pins = read(ROOT / 'runtime/build/pins.json')
        prepared = read(OUT / 'm1-owned/prepared.json')
        assert len(prepared['cases']) == 22
        assert read(OUT / 'm1-deployed/prepared.json') == prepared
        sys.path.insert(0, str(ROOT / '.ctm-checkers-source/tools/stack_native'))
        runner = importlib.import_module('native_compliance.maxima_runner')
        for candidate in ('deployed', 'owned'):
            summary = read(OUT / f'm1-{candidate}/comparison.json')
            assert summary['status'] == 'passed'
            assert len(summary['versions']) == 2
            assert all(v['passed'] and v['comparisonCount'] == 22 for v in summary['versions'])
        assert {v['stackRevision'] for v in prepared['versions']} == set(pins['stack'])
        for version in prepared['versions']:
            sha = version['stackRevision']
            observed = {}
            for candidate in ('deployed', 'owned'):
                row = read(OUT / f'm1-{candidate}/browser-{sha[:7]}.json')
                assert row['ok'] and not row['serverErrors']
                if candidate == 'owned':
                    assert row['runtimeBuild']['kind'] == 'ctm-owned-build'
                    assert all(a['pinVerified'] for a in row['servedAssets'])
                values = runner.parse_output(row['stdout'], prepared['cases'], 0)
                assert len(values) == 22
                observed[candidate] = [{key: value.get(key) for key in ('case_id','status','cas_valid','correct','answer_note')} for value in values]
            assert observed['owned'] == observed['deployed']
            report['probeComparisons'].append({'stackRevision': sha, 'programShaEvidence': 'identical prepared.json batch/files', 'comparisons': 22, 'passed': True})
        browser = read(ROOT / 'test-results/milestone-three/browser.json')
        assert browser['passed'] is True and len(browser['programs']) == 316
        report['nativeReplays'] = []
        for name in ('native-reference', 'same-source-reference'):
            reference = read(ROOT / f'test-results/milestone-three/{name}/native-reference.json')
            assert reference['passed'] is True
            assert reference['summary']['programs'] == 316
            assert reference['summary']['unaccepted'] == 0
            report['nativeReplays'].append({'kind': name, 'nativeExecutableVersion': reference['nativeExecutableVersion'], 'summary': reference['summary']})
        timings = read(OUT / 'timings.json')
        assert timings['passed'] and len(timings['samples']) == 4
        assert {r['candidate'] for r in timings['samples']} == {'owned', 'deployed'}
        report['timingSamples'] = [{k: row[k] for k in ('candidate','repetition','readyMs','calls','nativeCalls')} for row in timings['samples']]
        report['passed'] = True
    except Exception as error:
        report['failure'] = f'{type(error).__name__}: {error}'
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
