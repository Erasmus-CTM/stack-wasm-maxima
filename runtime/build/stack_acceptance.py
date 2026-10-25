# SPDX-License-Identifier: AGPL-3.0-or-later
"""Bind the extra production STACK gates to the very same packaged runtime."""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def verify(artifact, revision):
    sys.path.insert(0, str(ROOT / 'runtime/precompiled'))
    from stack_compiler_evidence import verify as verify_compiler
    pins = json.loads((ROOT / 'runtime/build/pins.json').read_text())['stack']
    records = {}
    def read(relative):
        body = (ROOT / relative).read_bytes()
        records[relative] = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
        return json.loads(body)
    proofs = []
    for pin in pins:
        work = ROOT / ('.cache/precompiled-stack' if pin.startswith('3338304') else '.cache/precompiled-stack-10d3233')
        proofs.append(verify_compiler(work, artifact, pin))
        native = read('.cache/precompiled-fixtures/full-entry-' + pin + '/report.json')
        assert native['sourceRevision'] == revision and native['stackRevision'] == pin
        assert native['acceptance'] is True and native['evidenceComplete'] is True and native['parityPassed'] is True
    for loader in ('source', 'compiled'):
        probes = read('test-results/precompiled-stack/probes-' + loader + '/comparison.json')
        assert probes['status'] == 'passed' and len(probes['versions']) == 2
        assert {v['stackRevision'] for v in probes['versions']} == set(pins)
        assert all(v['passed'] is True and v['comparisonCount'] == 22 for v in probes['versions'])
    restarts = read('test-results/precompiled-stack/measure.json')
    assert restarts['sourceRevision'] == revision and restarts['passed'] is True
    assert restarts['planned'] == restarts['completed'] == {'trials': 8, 'initializations': 32, 'restarts': 24}
    assert len(restarts['samples']) == 8 and all(s['ok'] is True and len(s['restarts']) == 3 for s in restarts['samples'])
    controller = read('test-results/precompiled-stack/controller-parity.json')
    base = 'test-results/precompiled-stack/controller/'
    browser = read(base + 'browser.json')
    assert browser['sourceRevision'] == revision
    spec = importlib.util.spec_from_file_location('compiled_controller', ROOT / 'runtime/precompiled/check-controller-parity.py')
    checker = importlib.util.module_from_spec(spec); spec.loader.exec_module(checker)
    actual = checker.verify((ROOT / (base + 'stack-sources.json')).read_bytes(),
                            (ROOT / '.cache/precompiled-stack/stackmaxima.fas').read_bytes(),
                            read(base + 'prepared.json'), (ROOT / (base + 'build-manifest.json')).read_bytes(),
                            (ROOT / (base + 'browser.json')).read_bytes(),
                            [read(base + kind + '/native-reference.json') for kind in ('native-reference', 'same-source-reference')])
    assert controller == actual and controller['programs'] == 316
    graphics = [f'test-results/board-mathjax{suffix}-{engine}.json'
                for engine in ('chromium', 'firefox', 'webkit') for suffix in ('', '-static')]
    graphics += [base + f'board-functional-{engine}-{width}.json'
                 for engine in ('chromium', 'firefox', 'webkit') for width in (1280, 390)]
    graphics += [base + 'board-transfer-chromium.json']
    for path in graphics:
        assert read(path)['passed'] is True, path
    return {'passed': True, 'sourceRevision': revision, 'compilerProofs': proofs,
            'controllerPrograms': 316, 'restarts': 24, 'reports': records}
