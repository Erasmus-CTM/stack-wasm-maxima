#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Require full existing controller parity to exercise the compiled entry."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

PIN = '33383047af39c204bf4442802a058f8b918b2b1b'
policy_spec = importlib.util.spec_from_file_location('native_reference',
    Path(__file__).resolve().parents[2] / 'scripts/milestone-three/native-reference.py')
policy = importlib.util.module_from_spec(policy_spec)
policy_spec.loader.exec_module(policy)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def compiled_stages(stages, compiled):
    assert stages['compiledStackMounted'] is True
    assert stages['compiledStackBytes'] == compiled['asset']['fileBytes']
    assert stages['compiledStackSha256'] == compiled['asset']['sha256']
    assert stages['compiledStackRevision'] == PIN
    assert stages['compiledStackOpens'] > 0
    assert stages['compiledSourceEntryOpens'] == 0


def verify(manifest_bytes, binary, prepared, build_manifest_bytes, browser_bytes, references):
    manifest = json.loads(manifest_bytes)
    browser = json.loads(browser_bytes)
    compiled = manifest['compiledStack']
    assert manifest['stackRevision'] == compiled['stackRevision'] == PIN
    assert compiled['asset'] == {'path': 'stackmaxima.fas', 'fileBytes': len(binary), 'sha256': digest(binary)}
    assert prepared['preparation']['stackManifestSha256'] == digest(manifest_bytes)
    assert prepared['preparation']['compiledStack'] == compiled
    compiled_stages(prepared['preparation']['initialization']['timings']['maximaStages'], compiled)
    assert browser['passed'] is True and browser['coverage']['programs'] == len(browser['programs']) == 316
    assert browser['runtime']['compiledStack'] == compiled
    assert browser['runtime']['manifestSha256'] == digest(manifest_bytes)
    assert browser['runtime']['stackRevision'] == PIN
    assert browser['manifest']['preparation'] == prepared['preparation']
    build_manifest = json.loads(build_manifest_bytes)
    assert browser['manifest'] == {**build_manifest, 'sha256': digest(build_manifest_bytes), 'bytes': len(build_manifest_bytes)}
    assert browser['sourceRevision'] == prepared['sourceRevision'] == build_manifest['sourceRevision']
    assert build_manifest['programs'] == prepared['programs']
    assert browser['coverage']['graphics'] >= 3
    # Every native worker that evaluates a captured program must have emitted
    # real ready metadata proving its own compiled mount and entry-file open.
    events = browser['observation']['events']
    evaluations = [row for row in events if row.get('data', {}).get('event') == 'native-evaluate']
    assert browser['programs'] == prepared['programs'] + [row['data'] for row in evaluations]
    active = {row['worker'] for row in evaluations}
    assert active
    ready = set()
    for row in events:
        event = row.get('data', {}).get('event')
        if event == 'ready' and row['worker'] in active:
            compiled_stages(row['data']['timings']['maximaStages'], compiled)
            ready.add(row['worker'])
        elif event == 'native-evaluate':
            assert row['worker'] in ready, 'Evaluation preceded compiled worker readiness'
    assert len(references) == 2
    assert references[0]['nativeRuntime']['maxima'] != references[1]['nativeRuntime']['maxima']
    assert references[1]['nativeRuntime']['maxima'] == browser['runtime']['maximaVersion']
    for reference in references:
        assert reference['passed'] is True and reference['stackRevision'] == PIN
        assert reference['browserReport']['sha256'] == digest(browser_bytes)
        assert reference['browserReport']['sourceRevision'] == browser['sourceRevision']
        assert reference['wasmRuntime'] == browser['runtime']
        assert str(reference['nativeRuntime']['stackLibrary']) == str(manifest['stackLibraryVersion'])
        assert reference['summary']['programs'] == reference['summary']['passed'] == len(reference['observations']) == 316
        assert reference['summary']['unaccepted'] == reference['summary']['different'] == 0
        for index, (program, observed) in enumerate(zip(browser['programs'], reference['observations'])):
            assert program['operation'] in {'prepare', 'validate', 'prt'} and program['expression']
            assert observed['index'] == index and observed['operation'] == program['operation']
            assert observed['question'] == program['question']
            assert observed['expressionSha256'] == digest(program['expression'].encode())
            assert observed['wasm'] == program['result']
            comparison = policy.compare_results(program['result'], observed['native'])
            assert comparison['passed'] is True
            for field, value in comparison.items():
                assert observed[field] == value
    return {'passed': True, 'stackRevision': PIN, 'programs': 316, 'nativeWorkers': sorted(active),
            'compiledStack': compiled, 'browserSha256': digest(browser_bytes),
            'scope': 'Existing full316 controller/graphical coverage at3338304, independent and same-source native replays; not Moodle/PHP parity or older-pin316 coverage'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--site', type=Path, required=True)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--browser', type=Path, required=True)
    parser.add_argument('--independent', type=Path, required=True)
    parser.add_argument('--same-source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = {'passed': False}
    try:
        result = verify((args.site / 'stack-sources.json').read_bytes(),
                        (args.site / 'maxima-runtime/stackmaxima.fas').read_bytes(),
                        json.loads(args.prepared.read_text()), (args.site / 'native/build-manifest.json').read_bytes(), args.browser.read_bytes(),
                        [json.loads(args.independent.read_text()), json.loads(args.same_source.read_text())])
    except Exception as error:
        result['failure'] = f'{type(error).__name__}: {error}'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    raise SystemExit(0 if result['passed'] else 1)
