#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exercise opt-in selection and rejection before any asset can be staged."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prepare_runtime', ROOT / 'scripts/milestone-two/prepare-runtime.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Substitution(unittest.TestCase):
    def test_inventory_rejections(self):
        self.assertIsNone(module.owned_runtime_source(None, set()))
        work = ROOT / '.cache/runtime-build/tests'
        work.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=work) as directory:
            root = Path(directory)
            record = {'path': 'asset.wasm', 'bytes': 4, 'sha256': 'a' * 64}
            manifest = {'schema': 1, 'sourcePins': json.loads((ROOT / 'runtime/build/pins.json').read_text()), 'runtimeAssets': [record]}
            def check(value):
                (root / 'manifest.json').write_text(json.dumps(value))
                return module.owned_runtime_source(root, {module.BASE + 'asset.wasm'})
            self.assertEqual(check(manifest)['records']['asset.wasm'], record)
            for invalid in (None, {'bytes': True}, {'path': '../asset.wasm'}, {'sha256': 'bad'}, {'bytes': -1}):
                rows = [invalid if invalid is None else {**record, **invalid}]
                with self.assertRaises(ValueError):
                    check({**manifest, 'runtimeAssets': rows})
            with self.assertRaises(ValueError):
                check({**manifest, 'runtimeAssets': [record, record]})
            with self.assertRaises(ValueError):
                check({**manifest, 'sourcePins': {}})

if __name__ == '__main__':
    unittest.main()
