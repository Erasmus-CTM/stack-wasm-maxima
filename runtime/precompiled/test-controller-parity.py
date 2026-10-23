#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reject source/mixed/partial reports even when their summary says pass."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('controller_parity', Path(__file__).with_name('check-controller-parity.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def encoded(value):
    return json.dumps(value).encode()


class EvidenceBinding(unittest.TestCase):
    def setUp(self):
        self.binary = b'unit fixture bundle'
        compiled = {'stackRevision': gate.PIN, 'asset': {'path': 'stackmaxima.fas',
                    'fileBytes': len(self.binary), 'sha256': gate.digest(self.binary)}}
        manifest = {'stackRevision': gate.PIN, 'stackLibraryVersion': 'unit-version', 'compiledStack': compiled}
        self.manifest_bytes = encoded(manifest)
        stages = {'compiledStackMounted': True, 'compiledStackBytes': len(self.binary),
                  'compiledStackSha256': gate.digest(self.binary), 'compiledStackRevision': gate.PIN,
                  'compiledStackOpens': 1, 'compiledSourceEntryOpens': 0}
        self.prepared = {'sourceRevision': 'unit-revision', 'programs': [], 'preparation': {
            'stackManifestSha256': gate.digest(self.manifest_bytes), 'compiledStack': compiled,
            'initialization': {'timings': {'maximaStages': stages}}}}
        programs = [{'operation': 'prepare' if index < 11 else 'validate', 'question': 'unit question',
                     'expression': f'6*7+{index}', 'result': 42 + index} for index in range(316)]
        self.prepared['programs'] = programs[:11]
        self.build_bytes = encoded(self.prepared)
        self.browser = {'passed': True, 'sourceRevision': 'unit-revision', 'coverage': {'programs': 316, 'graphics': 3},
            'programs': programs, 'runtime': {'compiledStack': compiled, 'stackRevision': gate.PIN,
                'manifestSha256': gate.digest(self.manifest_bytes), 'maximaVersion': 'same-source-version'},
            'manifest': {**copy.deepcopy(self.prepared), 'sha256': gate.digest(self.build_bytes), 'bytes': len(self.build_bytes)},
            'observation': {'events': [{'worker': 0, 'data': {'event': 'ready', 'timings': {'maximaStages': copy.deepcopy(stages)}}}]
                          + [{'worker': 0, 'data': {**program, 'event': 'native-evaluate'}} for program in programs[11:]]}}
        # Captured program dictionaries include their event metadata verbatim.
        self.browser['programs'] = programs[:11] + [row['data'] for row in self.browser['observation']['events'][1:]]
        self.references = []
        for version in ('independent-version', 'same-source-version'):
            self.references.append({'passed': True, 'stackRevision': gate.PIN,
                'nativeRuntime': {'maxima': version, 'stackLibrary': 'unit-version'},
                'summary': {'programs': 316, 'passed': 316, 'unaccepted': 0, 'different': 0},
                'observations': [{'index': index, 'operation': program['operation'], 'question': program['question'],
                    'expressionSha256': gate.digest(program['expression'].encode()), 'wasm': program['result'],
                    'native': program['result'], **gate.policy.compare_results(program['result'], program['result'])}
                    for index, program in enumerate(self.browser['programs'])]})

    def verify(self):
        browser_bytes = encoded(self.browser)
        # Rebind outer hashes so regressions must detect the inner inconsistency.
        for reference in self.references:
            reference['browserReport'] = {'sha256': gate.digest(browser_bytes), 'sourceRevision': 'unit-revision'}
            reference['wasmRuntime'] = copy.deepcopy(self.browser['runtime'])
        return gate.verify(self.manifest_bytes, self.binary, self.prepared, self.build_bytes, browser_bytes, self.references)

    def test_complete_bound_fixture(self):
        self.assertTrue(self.verify()['passed'])

    def test_source_worker_cannot_stand_in_for_compiled(self):
        self.browser['observation']['events'][0]['data']['timings']['maximaStages']['compiledStackOpens'] = 0
        with self.assertRaises(AssertionError): self.verify()

    def test_ready_after_evaluation(self):
        self.browser['observation']['events'].append(self.browser['observation']['events'].pop(0))
        with self.assertRaises(AssertionError): self.verify()

    def test_unrelated_captured_program(self):
        self.browser['programs'][20] = {**self.browser['programs'][20], 'expression': 'different()'}
        with self.assertRaises(AssertionError): self.verify()

    def test_stale_reference_expression(self):
        self.references[0]['observations'][20]['expressionSha256'] = '0' * 64
        with self.assertRaises(AssertionError): self.verify()

    def test_false_pass_native_result(self):
        self.references[0]['observations'][20]['native'] = -1
        with self.assertRaises(AssertionError): self.verify()

    def test_partial_replay_with_pass_summary(self):
        self.references[1]['observations'].pop()
        with self.assertRaises(AssertionError): self.verify()

    def test_prepared_manifest_mismatch(self):
        self.browser['manifest']['sourceRevision'] = 'other-revision'
        with self.assertRaises(AssertionError): self.verify()

    def test_source_entry_read(self):
        self.browser['observation']['events'][0]['data']['timings']['maximaStages']['compiledSourceEntryOpens'] = 1
        with self.assertRaises(AssertionError): self.verify()


if __name__ == '__main__':
    unittest.main()
