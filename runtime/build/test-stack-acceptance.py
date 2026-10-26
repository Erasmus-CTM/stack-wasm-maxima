#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reject incomplete or mixed-head STACK evidence before release acceptance."""
import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import stack_acceptance

PINS = ['3338304' + 'a' * 33, '10d3233' + 'b' * 33]

class StackAcceptance(unittest.TestCase):
    def test_missing_mixed_head_and_incomplete_gates_fail_closed(self):
        reports = {'runtime/build/pins.json': {'stack': PINS}, 'artifact/manifest.json': {'runtime': 'under-test'}}
        digest = lambda body: hashlib.sha256(body).hexdigest()
        engine_body, classifier = b'engine under test', b'classifier under test'
        for pin in PINS:
            reports['.cache/precompiled-fixtures/full-entry-' + pin + '/report.json'] = {
                'sourceRevision': 'head', 'stackRevision': pin, 'acceptance': True,
                'evidenceComplete': True, 'parityPassed': True}
        for loader in ('source', 'compiled'):
            reports['test-results/precompiled-stack/probes-' + loader + '/comparison.json'] = {
                'status': 'passed', 'versions': [{'stackRevision': pin, 'passed': True, 'comparisonCount': 22} for pin in PINS]}
        lifecycle = {'trials': 8, 'initializations': 32, 'restarts': 24}
        reports['test-results/precompiled-stack/measure.json'] = {'sourceRevision': 'head', 'passed': True,
            'planned': lifecycle, 'completed': lifecycle,
            'samples': [{'ok': True, 'restarts': [1, 2, 3]} for _ in range(8)]}
        controller = {'passed': True, 'programs': 316}
        reports['test-results/precompiled-stack/controller-parity.json'] = controller
        base = 'test-results/precompiled-stack/controller/'
        for name in ('browser.json', 'prepared.json', 'stack-sources.json', 'build-manifest.json',
                     'native-reference/native-reference.json', 'same-source-reference/native-reference.json'):
            reports[base + name] = {'sourceRevision': 'head'}
        for engine in ('chromium', 'firefox', 'webkit'):
            for suffix in ('', '-static'):
                reports[f'test-results/board-mathjax{suffix}-{engine}.json'] = {'passed': True}
            for width in (1280, 390):
                reports[base + f'board-functional-{engine}-{width}.json'] = {'passed': True}
        reports[base + 'board-transfer-chromium.json'] = {'passed': True}
        for path in (base + 'browser.json', 'test-results/milestone-three/browser.json'):
            reports[path] = {'sourceRevision': 'head', 'runtime': {'manifestSha256': path, 'stackRevision': PINS[0]}}
        stress = {'sourceRevision':'head', 'runtimeManifestSha256':digest(json.dumps(reports['artifact/manifest.json']).encode()),
                  'stackRevision':PINS[0], 'ok': True, 'deviations': [], 'divisor': 1000, 'iterations': 400, 'rounds': 1,
                  'targetPrograms': 1, 'replayPrograms': 316, 'gcStats': [1, 5000, True]}
        for prefix in (base, 'test-results/milestone-three/'):
            reports[prefix + 'gc-stress.json'] = {**stress, 'browserReportSha256':digest(json.dumps(reports[prefix+'browser.json']).encode()),
                'stackManifestSha256':reports[prefix+'browser.json']['runtime']['manifestSha256']}
        for kind in ('independent', 'same-source'):
            reports[base + 'validation-boundary-' + kind + '.json'] = {'passed': True, 'sourceRevision':'head', 'stackRevision':PINS[0],
                'classifierSha256':digest(classifier), 'engineSha256':digest(engine_body)}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'prototype/native').mkdir(parents=True)
            (root/'prototype/native/engine.js').write_bytes(engine_body)
            (root/'prototype/native/classified-errcatch.lisp').write_bytes(classifier)
            binary = root / '.cache/precompiled-stack/stackmaxima.fas'
            binary.parent.mkdir(parents=True); binary.write_bytes(b'bound by compiler checker')
            def emit(values):
                for name, value in values.items():
                    path = root / name; path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps(value))
            # Existing compiler/controller test suites own their semantic/byte checks.
            # Isolate the new aggregation boundary here; their replay is mandatory.
            compiler_calls = []
            compiler = SimpleNamespace(verify=lambda work, artifact, pin: compiler_calls.append(pin) or {'passed': True})
            checker = SimpleNamespace(verify=lambda *args: controller)
            spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
            with patch.object(stack_acceptance, 'ROOT', root), \
                 patch.dict('sys.modules', {'stack_compiler_evidence': compiler}), \
                 patch.object(stack_acceptance.importlib.util, 'spec_from_file_location', return_value=spec), \
                 patch.object(stack_acceptance.importlib.util, 'module_from_spec', return_value=checker):
                emit(reports)
                accepted = stack_acceptance.verify(root / 'artifact', 'head')
                self.assertTrue(accepted['passed']); self.assertEqual(compiler_calls, PINS)
                cases = [
                    ('.cache/precompiled-fixtures/full-entry-' + PINS[0] + '/report.json', 'sourceRevision', 'other-head'),
                    ('test-results/precompiled-stack/measure.json', 'completed', {**lifecycle, 'restarts': 23}),
                    ('test-results/precompiled-stack/probes-compiled/comparison.json', 'versions', [{'stackRevision': PINS[0], 'passed': True, 'comparisonCount': 22}]),
                    (base + 'browser.json', 'sourceRevision', 'other-head'),
                    ('test-results/precompiled-stack/controller-parity.json', 'programs', 315),
                    (base + 'board-functional-webkit-390.json', 'passed', False),
                    (base + 'gc-stress.json', 'deviations', [{'phase': 'target', 'index': 7}]),
                    ('test-results/milestone-three/gc-stress.json', 'ok', False),
                    ('test-results/milestone-three/gc-stress.json', 'iterations', 50),
                    ('test-results/milestone-three/gc-stress.json', 'gcStats', [1, 10, True]),
                    (base + 'gc-stress.json', 'replayPrograms', 1),
                    (base + 'validation-boundary-same-source.json', 'passed', False),
                    (base + 'validation-boundary-independent.json', 'sourceRevision', 'other-head'),
                    (base + 'validation-boundary-independent.json', 'engineSha256', '0'*64),
                    (base + 'gc-stress.json', 'sourceRevision', 'other-head'),
                    (base + 'gc-stress.json', 'browserReportSha256', '0'*64),
                    (base + 'gc-stress.json', 'runtimeManifestSha256', '0'*64),
                    (base + 'gc-stress.json', 'stackManifestSha256', '0'*64)]
                for name, key, value in cases:
                    with self.subTest(report=name, key=key):
                        mutated = copy.deepcopy(reports); mutated[name][key] = value; emit(mutated)
                        with self.assertRaises(AssertionError): stack_acceptance.verify(root / 'artifact', 'head')
                emit(reports)
                (root / 'test-results/precompiled-stack/measure.json').unlink()
                with self.assertRaises(FileNotFoundError): stack_acceptance.verify(root / 'artifact', 'head')
                emit(reports)
                (root / 'test-results/milestone-three/gc-stress.json').unlink()
                with self.assertRaises(FileNotFoundError): stack_acceptance.verify(root / 'artifact', 'head')

if __name__ == '__main__': unittest.main()
