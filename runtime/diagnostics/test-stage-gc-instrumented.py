#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exercise interface shape, failure evidence and real Wasm import inventories."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('stage_gc_instrumented', Path(__file__).with_name('stage-gc-instrumented.py'))
STAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STAGE)


def descriptor(name='a', module='env', kind='function'):
    return {'module': module, 'name': name, 'kind': kind}


ORIGINAL = {'imports': [descriptor(), descriptor('b'), descriptor()],
            'exports': [{'name': 'run', 'kind': 'function'}]}


def u32(number):
    result = bytearray()
    while True:
        byte = number & 127
        number >>= 7
        result.append(byte | (128 if number else 0))
        if not number:
            return bytes(result)


def wasm(import_names, export_names=('run',)):
    # Small valid modules, compiled by Node but never instantiated or executed.
    def string(value):
        body = value.encode('utf-8')
        return u32(len(body)) + body

    def section(number, body):
        return bytes([number]) + u32(len(body)) + body

    types = b'\x01\x60\x00\x00'  # One () -> () function type.
    imports = u32(len(import_names)) + b''.join(string('env') + string(name) + b'\x00\x00'
                                               for name in import_names)
    exports = u32(len(export_names)) + b''.join(string(name) + b'\x00\x00' for name in export_names)
    return b'\0asm\x01\0\0\0' + section(1, types) + section(2, imports) + section(7, exports)


class InterfaceTests(unittest.TestCase):
    def test_reordering_and_duplicate_counts(self):
        reordered = copy.deepcopy(ORIGINAL)
        reordered['imports'].reverse()
        reordered['imports'] = [reordered['imports'][1], reordered['imports'][0], reordered['imports'][2]]
        result = STAGE.compare_interfaces(ORIGINAL, reordered)
        STAGE.enforce_interface_shape(result)
        self.assertFalse(result['importOrderMatches'])
        self.assertTrue(result['importsMatch'])
        self.assertEqual(result['addedImports'], [])
        self.assertEqual(result['removedImports'], [])
        self.assertEqual(result['originalImportDescriptors'][0]['count'], 2)

    def test_add_remove_duplicate_module_name_and_kind_changes_rejected(self):
        candidates = []
        changed = copy.deepcopy(ORIGINAL)
        changed['imports'].append(descriptor('new'))
        candidates.append(changed)
        changed = copy.deepcopy(ORIGINAL)
        changed['imports'].pop()
        candidates.append(changed)
        changed = copy.deepcopy(ORIGINAL)
        changed['imports'].append(descriptor())
        candidates.append(changed)
        for field, value in [('module', 'other'), ('name', 'renamed'), ('kind', 'global')]:
            changed = copy.deepcopy(ORIGINAL)
            changed['imports'][0][field] = value
            candidates.append(changed)
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                result = STAGE.compare_interfaces(ORIGINAL, candidate)
                self.assertFalse(result['importsMatch'])
                self.assertTrue(result['addedImports'] or result['removedImports'])
                with self.assertRaisesRegex(AssertionError, 'import descriptor multiset changed'):
                    STAGE.enforce_interface_shape(result)

    def test_duplicate_delta_is_exact(self):
        changed = copy.deepcopy(ORIGINAL)
        changed['imports'].pop()
        result = STAGE.compare_interfaces(ORIGINAL, changed)
        self.assertEqual(result['removedImports'], [{**descriptor(), 'count': 1}])
        self.assertEqual(result['addedImports'], [])

    def test_export_guards_remain_strict(self):
        for exports in [[], [{'name': 'run', 'kind': 'global'}],
                        ORIGINAL['exports'] + [{'name': 'new', 'kind': 'function'}]]:
            with self.subTest(exports=exports), self.assertRaises(AssertionError):
                STAGE.enforce_interface_shape(STAGE.compare_interfaces(ORIGINAL, {**ORIGINAL, 'exports': exports}))
        allowed = {**ORIGINAL, 'exports': ORIGINAL['exports'] + [{'name': 'ctm_trace', 'kind': 'global'}]}
        STAGE.enforce_interface_shape(STAGE.compare_interfaces(ORIGINAL, allowed))

    def test_malformed_inventories_are_rejected(self):
        for candidate in [[], {**ORIGINAL, 'extra': []},
                          {**ORIGINAL, 'imports': [dict(descriptor(), extra='hidden')]},
                          {**ORIGINAL, 'imports': [{**descriptor(), 'name': 1}]},
                          {**ORIGINAL, 'exports': ORIGINAL['exports'] * 2}]:
            with self.subTest(candidate=candidate), self.assertRaises(AssertionError):
                STAGE.compare_interfaces(ORIGINAL, candidate)

    def test_real_wasm_reordering_is_reported_and_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old, new = root / 'original.wasm', root / 'instrumented.wasm'
            old.write_bytes(wasm(['a', 'b', 'a']))
            new.write_bytes(wasm(['b', 'a', 'a'], ['run', 'ctm_trace']))
            before, after, result = STAGE.preserve_interfaces(old, new, root / 'evidence')
            self.assertEqual(before, ORIGINAL)
            self.assertEqual([row['name'] for row in after['imports']], ['b', 'a', 'a'])
            self.assertFalse(result['importOrderMatches'])
            self.assertTrue(result['comparisonComplete'])
            self.assertEqual(result['instrumentedModule'], STAGE.record(new.read_bytes()))
            STAGE.enforce_interface_shape(result)

    def test_real_difference_is_preserved_before_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old, new = root / 'original.wasm', root / 'instrumented.wasm'
            old.write_bytes(wasm(['a', 'b', 'a']))
            new.write_bytes(wasm(['a', 'b', 'added']))
            evidence = root / 'evidence'
            _, _, result = STAGE.preserve_interfaces(old, new, evidence)
            with self.assertRaisesRegex(AssertionError, 'import descriptor multiset changed'):
                STAGE.enforce_interface_shape(result)
            self.assertEqual(json.loads((evidence / 'comparison.json').read_text()), result)
            self.assertEqual(result['removedImports'], [{**descriptor(), 'count': 1}])
            self.assertEqual(result['addedImports'], [{**descriptor('added'), 'count': 1}])
            self.assertTrue((evidence / 'original-interface.json').is_file())
            self.assertTrue((evidence / 'instrumented-interface.json').is_file())
            self.assertFalse(result['moduleInterfaceShapeMatches'])
            self.assertFalse(result['acceptance'])
            self.assertFalse(result['productionAdmission'])
            self.assertEqual(new.read_bytes(), wasm(['a', 'b', 'added']))

    def test_inventory_error_retains_partial_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old, new = root / 'original.wasm', root / 'instrumented.wasm'
            old.write_bytes(wasm(['a', 'b', 'a']))
            new.write_bytes(b'failed module')
            evidence = root / 'evidence'
            with patch.object(STAGE, 'interface', side_effect=[ORIGINAL, ValueError('invalid module')]):
                with self.assertRaisesRegex(ValueError, 'invalid module'):
                    STAGE.preserve_interfaces(old, new, evidence)
            result = json.loads((evidence / 'comparison.json').read_text())
            self.assertFalse(result['comparisonComplete'])
            self.assertFalse(result['moduleInterfaceShapeMatches'])
            self.assertEqual(result['failure'], 'invalid module')
            self.assertTrue((evidence / 'original-interface.json').is_file())

    def test_replay_recomputes_actual_module_inventories_and_proof(self):
        spec = importlib.util.spec_from_file_location('run_gc_instrumentation', Path(__file__).with_name('run-gc-instrumentation.py'))
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        target = (b'((C::*MACHINE* . #S(C::MACHINE :C-TYPES NIL :HOST-TYPE-HASH '
                  b'#.(EXT:HASH-TABLE-FILL (MAKE-HASH-TABLE :SIZE 128 :SYNCHRONIZED T '
                  b':WEAKNESS NIL :HASH-FUNCTION NIL :REHASH-SIZE 1.5d0 '
                  b':REHASH-THRESHOLD 0.75 :TEST (QUOTE EQ)) (QUOTE ())) '
                  b':SORTED-TYPES NIL :INLINE-INFORMATION NIL)))')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frozen, mixed = root / 'frozen', root / 'mixed'
            (frozen / 'artifact/logs').mkdir(parents=True)
            (frozen / 'artifact/runtime').mkdir()
            (mixed / 'runtime').mkdir(parents=True)
            (frozen / 'artifact/logs/target-info.lsp').write_bytes(target)
            (mixed / 'original-target-info.lsp').write_bytes(target)
            (mixed / 'instrumented-target-info.lsp').write_bytes(target)
            (mixed / 'instrumentation.json').write_text('{}')
            original_rows, mixed_rows = [], []
            for i in range(79):
                name = 'libecl.so' if i == 0 else 'asset-' + str(i)
                before = wasm(['a', 'b', 'a']) if i == 0 else b'unchanged'
                after = wasm(['b', 'a', 'a'], ['run', 'ctm_trace']) if i == 0 else before
                (frozen / 'artifact/runtime' / name).write_bytes(before)
                (mixed / 'runtime' / name).write_bytes(after)
                original_rows.append({'path': name, **STAGE.record(before)})
                mixed_rows.append({'path': name, **STAGE.record(after)})
            manifest = frozen / 'artifact/manifest.json'
            manifest.write_text(json.dumps({'runtimeAssets': original_rows}))
            flags = {'diagnosticOnly': True, 'acceptance': False, 'productionAdmission': False}
            (mixed / 'manifest.json').write_text(json.dumps({**flags, 'runtimeAssets': mixed_rows}))
            before, after, comparison = STAGE.preserve_interfaces(
                frozen / 'artifact/runtime/libecl.so', mixed / 'runtime/libecl.so', root / 'interfaces')
            proof = {**flags, 'parentArtifact': 1, 'parentArchiveSha256': 'test-parent',
                     'onlyChangedRuntimeAsset': 'libecl.so', 'targetInfoMatches': True,
                     'targetInfoComparison': runner.compare_target_info(target, target),
                     'sourcePatchReport': runner.record(mixed / 'instrumentation.json'),
                     'parentManifest': runner.record(manifest), 'runtimeAssets': mixed_rows,
                     'moduleInterfaceShapeMatches': True, 'originalInterface': before,
                     'instrumentedInterface': after, 'moduleInterfaceComparison': comparison,
                     'originalModule': comparison['originalModule'],
                     'instrumentedModule': comparison['instrumentedModule']}
            path = mixed / 'diagnostic-provenance.json'
            path.write_text(json.dumps(proof))
            helper = SimpleNamespace(FROZEN=frozen, RUNTIME='artifact',
                                     SPEC={'id': 1, 'sha256': 'test-parent'}, safe_path=lambda path: None)
            with patch.object(runner, 'MIXED', mixed):
                runner.verify_mixed(helper)
                for key in ('moduleInterfaceComparison', 'originalInterface', 'instrumentedModule'):
                    changed = copy.deepcopy(proof)
                    changed[key] = {}
                    path.write_text(json.dumps(changed))
                    with self.subTest(tamper=key), self.assertRaisesRegex(ValueError, 'interface evidence|identities changed'):
                        runner.verify_mixed(helper)


if __name__ == '__main__':
    unittest.main()
