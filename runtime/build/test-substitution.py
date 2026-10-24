#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exercise opt-in selection and rejection before any asset can be staged."""
import importlib.util
import json
import os
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
            profiles=json.loads((ROOT / 'runtime/build/compiler-profiles.json').read_text())['profiles']
            compiler = profiles[os.environ.get('CTM_ECL_COMPILER_PROFILE','baseline')]
            manifest = {'schema': 1,'compilerProfile':compiler, 'sourcePins': json.loads((ROOT / 'runtime/build/pins.json').read_text()), 'runtimeAssets': [record], 'configuration':config, 'startupAdapter':{'content':(ROOT / 'runtime/build/no-plot.mac').read_text().strip()+'\n','sha256':config['startupSha256']}}
            manifest['sourceIntegrity'] = {'schema':1,'allVerifiedFilesUnmodified':False,
                'overlays':[json.loads((ROOT / 'runtime/build/patches/ecl-root-scanner.json').read_bytes())],
                'originalArchives':[{'path':'sources/'+p['name']+'.tar','sha256':p['archive']['sha256']}
                                    for p in manifest['sourcePins']['sources'] if p['name'] in ('maxima','ecl')],
                'beforeSha256':'0'*64,'hostSourceSha256':'1'*64,'afterSha256':'2'*64,'applicationSha256':'3'*64}
            def check(value):
                (root / 'manifest.json').write_text(json.dumps(value))
                return module.owned_runtime_source(root, {module.BASE + 'asset.wasm'})
            self.assertEqual(check(manifest)['records']['asset.wasm'], record)
            old_pins={k:v for k,v in manifest['sourcePins'].items() if k!='buildPatches'}
            old_config={k:v for k,v in config.items() if k!='targetSourceOverlaySha256'}
            with self.assertRaises(ValueError):
                check({**manifest,'sourcePins':old_pins,'configuration':old_config,'sourceIntegrity':None})
            with self.assertRaises(AssertionError):
                check({**manifest,'sourceIntegrity':None})
            with self.assertRaises(AssertionError):
                check({**manifest,'sourceIntegrity':{**manifest['sourceIntegrity'],'allVerifiedFilesUnmodified':True}})
            alternate=next(profile for profile in profiles.values() if profile['name']!=compiler['name'])
            optimized={**manifest,'compilerProfile':alternate}
            with self.assertRaises(ValueError):check(optimized)
            (root/'manifest.json').write_text(json.dumps(optimized))
            self.assertEqual(module.owned_runtime_source(root,{module.BASE+'asset.wasm'},compiler_profile_name=alternate['name'])['records']['asset.wasm'],record)
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
