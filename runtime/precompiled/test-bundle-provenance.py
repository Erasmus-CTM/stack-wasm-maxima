#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reject cross-pin and stale compiler outputs before any site file is written."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from bundle_provenance import describe, record, produce, PROCESS_ADAPTER, TRANSLATION_MODE
from parser_bootstrap import PINNED_SOURCES

spec = importlib.util.spec_from_file_location('stage_variant', Path(__file__).with_name('stage-variant.py'))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


class BundleBinding(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.pin = next(iter(PINNED_SOURCES))
        self.other_pin = next(pin for pin in PINNED_SOURCES if pin != self.pin)
        self.stack = self.root / 'stack'
        self.site = self.root / 'site'
        self.work = self.root / 'build'
        initialized = self.work / 'source-initialized'
        initialized.mkdir(parents=True)
        self.stack.mkdir()
        self.site.mkdir()
        source, loader, assessment, declarations = b'fixture entry', stage.OLD.encode(), b'fixture assessment', b'fixture declarations'
        for name, body in [(stage.ENTRY, source), (stage.LOADER, loader), (stage.PARSER_SOURCE, assessment)]:
            path = self.stack / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        manifest = {'schema': 1, 'stackRevision': self.pin, 'startup': stage.START_LOAD,
                    'files': [{'path': name, 'content': body.decode(), **record(body)}
                              for name, body in [(stage.ENTRY, source), (stage.LOADER, loader)]]}
        (self.site / 'stack-sources.json').write_text(json.dumps(manifest))
        self.translated = initialized / 'stackmaxima.lisp'
        self.translated.write_bytes(b'fixture translated Lisp')
        (initialized / 'stackmaxima.mac').write_bytes(source)
        bridge = Path(__file__).with_name('display2d-bridge.lisp').read_bytes()
        (initialized / 'display2d-bridge.lisp').write_bytes(bridge)
        self.process_adapter = self.work / PROCESS_ADAPTER
        process_adapter = Path(__file__).with_name(PROCESS_ADAPTER).read_bytes()
        self.process_adapter.write_bytes(process_adapter)
        (initialized / 'parser-declarations.mac').write_bytes(declarations)
        metadata = {'schema': 1, 'stackRevision': self.pin,
                    'source': {'path': stage.PARSER_SOURCE, **record(assessment), 'start': 0, 'end': len(declarations)},
                    'file': {'path': 'parser-declarations.mac', **record(declarations)}}
        metadata_bytes = json.dumps(metadata).encode()
        (initialized / 'parser-declarations.json').write_bytes(metadata_bytes)
        self.bundle = self.work / 'stackmaxima.fas'
        self.bundle.write_bytes(b'fixture compiled bundle for ' + self.pin.encode())
        self.descriptor = self.work / 'stackmaxima.fas.json'
        self.descriptor.write_text(json.dumps(describe(self.pin, source, self.translated.read_bytes(),
                                  bridge, process_adapter, declarations, metadata_bytes, self.bundle.read_bytes())))
        # These tests isolate bundle/input binding. Actual pinned extraction is
        # independently tested against both complete audited assessment files.
        self.addCleanup(patch.stopall)
        patch.object(stage.subprocess, 'check_output', return_value=self.pin + '\n').start()
        patch.object(stage, 'parser_declarations', return_value=(declarations, 0)).start()

    def run_stage(self):
        return stage.stage(self.site, self.stack, self.bundle, self.translated)

    def assert_rejected(self):
        with self.assertRaises(ValueError):
            self.run_stage()
        self.assertFalse((self.site / 'maxima-runtime').exists())
        self.assertFalse((self.site / 'stack-sources-timed-source.json').exists())
        self.assertFalse((self.site / 'stack-sources-precompiled.json').exists())

    def test_matching_bundle_and_inputs(self):
        result = self.run_stage()
        self.assertEqual(result['asset']['sha256'], record(self.bundle.read_bytes())['sha256'])
        self.assertEqual(result['stackRevision'], self.pin)
        self.assertEqual(result['translationAdapter']['mode'], TRANSLATION_MODE)
        self.assertEqual(result['translationAdapter']['processAdapter'], {
            'path': PROCESS_ADAPTER, 'fileBytes': self.process_adapter.stat().st_size,
            'sha256': record(self.process_adapter.read_bytes())['sha256']})

    def test_tampered_process_adapter_and_matching_descriptor(self):
        # Matching self-reported hashes cannot authorize unreviewed translator code.
        self.process_adapter.write_bytes(b'(error "unreviewed translation adapter")\n')
        descriptor = json.loads(self.descriptor.read_text())
        descriptor['processAdapter'] = {'path': PROCESS_ADAPTER, **record(self.process_adapter.read_bytes())}
        self.descriptor.write_text(json.dumps(descriptor))
        self.assert_rejected()

    def test_changed_process_adapter_descriptor(self):
        descriptor = json.loads(self.descriptor.read_text())
        descriptor['processAdapter']['sha256'] = '0' * 64
        self.descriptor.write_text(json.dumps(descriptor))
        self.assert_rejected()

    def test_legacy_descriptor_cannot_clear_fresh_staging(self):
        descriptor = json.loads(self.descriptor.read_text())
        descriptor['schema'] = 1
        del descriptor['processAdapter']
        del descriptor['translationMode']
        self.descriptor.write_text(json.dumps(descriptor))
        self.assert_rejected()

    def test_producer_rejects_changed_process_adapter(self):
        self.descriptor.unlink()
        self.process_adapter.write_bytes(b'(error "unreviewed translation adapter")\n')
        with patch.object(stage.subprocess, 'check_output', side_effect=[self.pin + '\n',
                          (self.stack / stage.ENTRY).read_bytes()]):
            with self.assertRaisesRegex(ValueError, 'Translation-process adapter'):
                produce(self.stack, self.work, self.pin)
        self.assertFalse(self.descriptor.exists())

    def test_copied_bundle_from_other_pin(self):
        self.bundle.write_bytes(b'fixture compiled bundle for ' + self.other_pin.encode())
        self.assert_rejected()

    def test_descriptor_from_other_pin(self):
        descriptor = json.loads(self.descriptor.read_text())
        descriptor['stackRevision'] = self.other_pin
        self.descriptor.write_text(json.dumps(descriptor))
        self.assert_rejected()

    def test_changed_translated_input(self):
        self.translated.write_bytes(b'retained or unrelated translation')
        self.assert_rejected()

    def test_different_build_directory(self):
        self.bundle = self.root / 'other-build' / 'stackmaxima.fas'
        self.assert_rejected()

    def test_existing_descriptor_cannot_be_replaced(self):
        with patch.object(stage.subprocess, 'check_output', side_effect=[self.pin + '\n',
                          (self.stack / stage.ENTRY).read_bytes()]):
            with self.assertRaises(FileExistsError):
                produce(self.stack, self.work, self.pin)


if __name__ == '__main__':
    unittest.main()
