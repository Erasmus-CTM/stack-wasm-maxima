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
            config = json.loads((ROOT / 'runtime/build/configuration.json').read_text())
            compiler = json.loads((ROOT / 'runtime/build/compiler-profiles.json').read_text())['profiles']['baseline']
            manifest = {'schema': 1,'compilerProfile':compiler, 'sourcePins': json.loads((ROOT / 'runtime/build/pins.json').read_text()), 'runtimeAssets': [record], 'configuration':config, 'startupAdapter':{'content':(ROOT / 'runtime/build/no-plot.mac').read_text().strip()+'\n','sha256':config['startupSha256']}}
            def check(value):
                (root / 'manifest.json').write_text(json.dumps(value))
                return module.owned_runtime_source(root, {module.BASE + 'asset.wasm'})
            self.assertEqual(check(manifest)['records']['asset.wasm'], record)
            optimized={**manifest,'compilerProfile':json.loads((ROOT / 'runtime/build/compiler-profiles.json').read_text())['profiles']['ecl-oz']}
            with self.assertRaises(ValueError):check(optimized)
            (root/'manifest.json').write_text(json.dumps(optimized))
            self.assertEqual(module.owned_runtime_source(root,{module.BASE+'asset.wasm'},compiler_profile_name='ecl-oz')['records']['asset.wasm'],record)
            for invalid in (None, {'bytes': True}, {'path': '../asset.wasm'}, {'sha256': 'bad'}, {'bytes': -1}):
                rows = [invalid if invalid is None else {**record, **invalid}]
                with self.assertRaises(ValueError):
                    check({**manifest, 'runtimeAssets': rows})
            with self.assertRaises(ValueError):
                check({**manifest, 'runtimeAssets': [record, record]})
            with self.assertRaises(ValueError):
                check({**manifest, 'sourcePins': {}})
            with self.assertRaises(ValueError):
                check({**manifest, 'compilerProfile': None})
            with self.assertRaises(ValueError):
                module.owned_runtime_source(root,{module.BASE+'asset.wasm'},compiler_profile_name='unknown')
            with self.assertRaises(ValueError):
                check({**manifest, 'configuration': None})
            with self.assertRaises(ValueError):
                check({**manifest, 'startupAdapter': None})
            (root / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                module.owned_runtime_source(root, {module.BASE + 'asset.wasm'}, baseline_comparator=True)
            with self.assertRaises(ValueError):
                check({**manifest, 'configuration': {'name':'no-gnuplot','omittedRuntimePaths':['asset.wasm']}})

if __name__ == '__main__':
    unittest.main()
