#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fail closed unless the owned artifact has the complete requested evidence."""
import importlib
import hashlib
import json
import re
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
        delivery = read(artifact_path.parent / 'artifact-manifest.json')['files']
        delivered_paths = {row['path'] for row in delivery}
        assert len(delivered_paths) == len(delivery)
        assert delivered_paths == {p.relative_to(artifact_path.parent).as_posix() for p in artifact_path.parent.rglob('*') if p.is_file() and p.name != 'artifact-manifest.json'}
        for row in delivery:
            path = artifact_path.parent / row['path']
            assert path.resolve().is_relative_to(artifact_path.parent.resolve())
            assert path.stat().st_size == row['bytes'] and digest(path) == row['sha256']
        from configuration import configuration, startup
        from package import records
        config = configuration()
        assert artifact['configuration'] == config
        assert artifact['startupAdapter'] == {'content':startup(config),'sha256':config['startupSha256']}
        assert all(row['name'] != 'gnuplot' for row in pins['sources']) and not pins.get('buildPatches')
        assert artifact['upstreamRecipe']['verifiedFilesUnmodified'] and artifact['upstreamRecipe']['patches'] == []
        assert artifact['upstreamRecipe']['beforeSha256'] == digest(artifact_path.parent / 'logs/source-state-before.json')
        assert artifact['upstreamRecipe']['afterSha256'] == digest(artifact_path.parent / 'logs/source-state-after.json')
        assert {row['path'] for row in artifact['upstreamRecipe']['verifiedInputs']} == {'wasm/Makefile','wasm/build.lisp','src/maxima.asd'}
        for row in artifact['upstreamRecipe']['verifiedInputs']:
            assert row['sha256'] == digest(artifact_path.parent / 'build-recipes/maxima' / row['path'])
        assert digest(artifact_path.parent / 'build-recipes/maxima/wasm/Makefile') == artifact['upstreamRecipe']['sha256']
        environment = read(artifact_path.parent / 'logs/environment.json')
        assert environment['coldBuild']['observedGithubHostedRun'] and not any(environment['coldBuild']['configuredWorkflowPolicy'].values())
        assert environment['runnerImage']['ImageVersion'] and environment['dpkgPackages']
        host_sha = (artifact_path.parent / 'logs/host-ecl.sha256').read_text().split()[0]
        assert re.fullmatch(r'[0-9a-f]{64}', host_sha)
        assert host_sha == digest(ROOT / '.cache/runtime-build/sources/maxima/wasm/ecl-host/bin/ecl')

        owned_assets = assets(artifact['runtimeAssets'], 'bytes')
        assert set(owned_assets) == set(records()) - set(config['omittedRuntimePaths'])
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
        assert staged['startup'].startswith(startup(config))
        for omitted in config['omittedRuntimePaths']:
            assert omitted not in owned_assets
            assert all(not (root / omitted).exists() for root in [artifact_path.parent / 'runtime',ROOT / 'site/maxima-runtime',ROOT / 'site/_site/maxima-runtime'])
        assert not (ROOT / '.cache/runtime-build/sources/gnuplot').exists()
        assert not (artifact_path.parent / 'sources/gnuplot.tar').exists()
        assert not (artifact_path.parent / 'LICENSES/gnuplot.txt').exists()
        diagnostic = read(OUT / 'plot-diagnostic.json')
        assert diagnostic['passed'] and diagnostic['expectedBuildFailure'] and diagnostic['question'] == 'authored-plot-diagnostic'
        assert 'CTM plotting unavailable; use JSXGraph.' in diagnostic['diagnostic']
        assert diagnostic['runtimeBuild']['manifestSha256'] == artifact_sha
        assert diagnostic['buildFailureSha256'] == digest(ROOT / '.cache/runtime-build/plot-diagnostic/preparation/build-failure.json')

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
        assert timings['passed'] and len(timings['samples']) == 12
        assert {(r['candidate'], r['repetition'],r['mode']) for r in timings['samples']} == {(candidate,n,mode) for candidate in ('owned','deployed','baseline') for n in (1,2) for mode in ('cold','warm-profile-reload')}
        baseline_pin = read(ROOT / 'runtime/build/baseline.json')
        assert timings['baseline']['runtimeBuild']['manifestSha256'] == baseline_pin['manifestSha256']
        assert timings['baseline']['runtimeBuild']['sourcePins'] == baseline_pin['sourcePins']
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
            assert sample['encodedBodyBytes'] == sum(row['encodedBodyBytes'] for row in sample['requests'])
            if sample['candidate'] == 'owned':
                assert len(smoke['plotting']) == 4
                assert all('CTM plotting unavailable; use JSXGraph' in row['diagnostic'] and row['afterError'] == 42 for row in smoke['plotting'])
                assert not any(row['pathname'].endswith(tuple('/'+p for p in config['omittedRuntimePaths'])) for row in sample['requests'])
        pages = read(OUT / 'public-pages-encoding.json')
        assert pages['passed'] and len(pages['assets']) == 3
        assert all(row['status']==200 and row['url'].startswith('https://erasmus-ctm.github.io/') for row in pages['assets'])

        report['artifactManifestSha256'] = artifact_sha
        report['browserReportSha256'] = browser_sha
        report['timingSamples'] = [{k: row[k] for k in ('candidate','repetition','mode','readyMs','calls','nativeCalls','encodedBodyBytes')} for row in timings['samples']]
        report['configuration'] = config
        report['publicPagesEncodings'] = pages['assets']
        report['plotDiagnostic'] = diagnostic
        report['environment'] = environment
        report['passed'] = True
    except Exception as error:
        report['failure'] = f'{type(error).__name__}: {error}'
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
