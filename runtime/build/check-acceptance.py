#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fail closed unless the owned artifact has the complete requested evidence."""
import importlib
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.cache/runtime-build/validation'

def read(path):
    return json.loads(path.read_text())

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def assets(rows, byte_field):
    inventory = {row['path'].removeprefix('/'): (row[byte_field], row['sha256']) for row in rows}
    assert len(inventory) == len(rows), 'Duplicate asset paths in evidence'
    return inventory

def main():
    report = {'schema': 1, 'passed': False, 'probeComparisons': []}
    try:
        pins = read(ROOT / 'runtime/build/pins.json')
        artifact_path = ROOT / '.cache/runtime-build/artifact/manifest.json'
        artifact = read(artifact_path)
        assert artifact['sourcePins'] == pins
        artifact_sha = digest(artifact_path)
        from profile import configuration, startup
        profile = configuration()
        assert artifact['configuration'] == profile
        assert artifact['profileEvidence']['startup'] == startup(profile)
        effective = read(ROOT / '.cache/runtime-build/logs/effective-flags.json')
        assert effective['passed'] and effective['configuration'] == profile
        assert effective['finalOptimization'] == profile['eclCFlag']
        owned_assets = assets(artifact['runtimeAssets'], 'bytes')
        pinned_version = next(row['version'] for row in pins['sources'] if row['name'] == 'maxima')
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
                    assert row['runtimeBuild']['manifestSha256'] == artifact_sha
                    assert row['runtimeBuild']['sourcePins'] == pins
                    assert all(a['pinVerified'] for a in row['servedAssets'])
                    assert assets(row['servedAssets'] + row['prefetchedAssets'], 'fileBytes') == owned_assets
                values = runner.parse_output(row['stdout'], prepared['cases'], 0)
                assert len(values) == 22
                observed[candidate] = [{key: value.get(key) for key in ('case_id','status','cas_valid','correct','answer_note')} for value in values]
            assert observed['owned'] == observed['deployed']
            report['probeComparisons'].append({'stackRevision': sha, 'programShaEvidence': 'identical prepared.json batch/files', 'comparisons': 22, 'passed': True})
        browser = read(ROOT / 'test-results/milestone-three/browser.json')
        assert browser['passed'] is True and len(browser['programs']) == 316
        assert assets(browser['runtime']['assets'], 'fileBytes') == owned_assets
        assert browser['runtime']['maximaVersion'] == pinned_version
        staged_path = ROOT / 'site/_site/stack-sources.json'
        assert browser['runtime']['manifestSha256'] == digest(staged_path)
        staged = read(staged_path)
        assert staged['startup'].startswith(startup(profile))
        for omitted in profile['omittedRuntimePaths']:
            assert omitted not in owned_assets
            assert not (artifact_path.parent / 'runtime' / omitted).exists()
            assert not (ROOT / 'site/maxima-runtime' / omitted).exists()
            assert not (ROOT / 'site/_site/maxima-runtime' / omitted).exists()
        assert staged['runtimeBuild']['manifestSha256'] == artifact_sha
        assert staged['runtimeBuild']['sourcePins'] == pins
        browser_sha = digest(ROOT / 'test-results/milestone-three/browser.json')
        report['nativeReplays'] = []
        for name in ('native-reference', 'same-source-reference'):
            reference = read(ROOT / f'test-results/milestone-three/{name}/native-reference.json')
            assert reference['passed'] is True
            assert reference['summary']['programs'] == 316
            assert reference['summary']['unaccepted'] == 0
            assert reference['browserReport']['sha256'] == browser_sha
            assert reference['wasmRuntime'] == browser['runtime']
            if name == 'same-source-reference':
                assert reference['nativeRuntime']['maxima'] == pinned_version
            report['nativeReplays'].append({'kind': name, 'nativeExecutableVersion': reference['nativeExecutableVersion'], 'summary': reference['summary']})
        timings = read(OUT / 'timings.json')
        assert timings['passed'] and len(timings['samples']) == 6
        assert {(r['candidate'], r['repetition']) for r in timings['samples']} == {(candidate,n) for candidate in ('owned','deployed','baseline') for n in (1,2)}
        baseline_pin = read(ROOT / 'runtime/build/baseline.json')
        assert timings['baseline']['runtimeBuild']['manifestSha256'] == baseline_pin['manifestSha256']
        assert assets(timings['owned']['runtimeAssets'], 'fileBytes') == owned_assets
        assert timings['owned']['runtimeBuild']['manifestSha256'] == artifact_sha
        assert timings['owned']['runtimeBuild']['sourcePins'] == pins
        baseline = read(ROOT / '.cache/runtime-build/deployed-demo/stack-sources.json')
        assert timings['deployed']['runtimeBuild'] is None
        assert timings['deployed']['runtimeAssets'] == baseline['runtimeAssets']
        assert all(row['sourceURL'].startswith('https://maxima-on-wasm.pages.dev/') for row in baseline['runtimeAssets'])
        for sample in timings['samples']:
            assert sample['initialization']['maximaVersion'] == pinned_version
            assert len(sample['nativeCalls']) == 3
            assert {row['operation'] for row in sample['nativeCalls']} == {'prepare','validate','prt'}
            assert all(row['result'] == row['expected'] for row in sample['nativeCalls'])
            smoke = sample['smoke']
            assert smoke['retained'] == 1000 and len(smoke['gcCalls']) == 100 and all(smoke['gcCalls'])
            assert 'CTM deliberate caught CAS error' in smoke['caughtError'] and smoke['afterError'] == 42
            if sample['candidate'] == 'owned' and not profile['capabilities']['plotting']:
                assert len(smoke['plotting']) == 4
                assert all('CTM plotting unavailable; use JSXGraph' in row['diagnostic'] and row['afterError'] == 42 for row in smoke['plotting'])
                assert not any(row['pathname'].endswith(tuple('/'+p for p in profile['omittedRuntimePaths'])) for row in sample['requests'])
        report['artifactManifestSha256'] = artifact_sha
        report['browserReportSha256'] = browser_sha
        report['timingSamples'] = [{k: row[k] for k in ('candidate','repetition','readyMs','calls','nativeCalls')} for row in timings['samples']]
        report['passed'] = True
        report['configuration'] = profile
        report['effectiveFlags'] = effective
    except Exception as error:
        report['failure'] = f'{type(error).__name__}: {error}'
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
