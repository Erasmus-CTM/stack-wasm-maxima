#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Check archive-cache verification before extracted tools can be reused."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prepare_toolchain', ROOT / 'runtime/build/prepare-toolchain.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ToolchainCache(unittest.TestCase):
    def test_cache_is_verified_before_any_extraction_reuse(self):
        work = ROOT / '.cache/runtime-build/tests'
        work.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=work) as directory:
            root = Path(directory)
            build = root / '.cache/runtime-build'
            sdk = build / 'sources/emsdk'
            downloads = sdk / 'downloads'
            downloads.mkdir(parents=True)
            data = b'fixture archive bytes'
            pin = {'name':'fixture', 'file':'fixture.tar.xz', 'bytes':len(data),
                   'sha256':hashlib.sha256(data).hexdigest(), 'url':'https://invalid.example/not-used'}
            (root / 'runtime/build').mkdir(parents=True)
            (root / 'runtime/build/pins.json').write_text(json.dumps({'toolchainArchives':[pin]}))
            cached = downloads / pin['file']
            cached.write_bytes(b'corrupt')
            extracted = sdk / 'upstream'
            extracted.mkdir()
            sentinel = extracted / 'must-not-execute'
            sentinel.write_text('stale extracted tool')
            with patch.object(module, 'ROOT', root), patch.object(module, 'WORK', build), patch.object(module.platform, 'system', return_value='Linux'), patch.object(module.platform, 'machine', return_value='x86_64'), patch.object(module.urllib.request, 'urlopen', side_effect=AssertionError('Cached fixture must not download')):
                with self.assertRaises(ValueError):
                    module.main()
                self.assertTrue(sentinel.is_file(), 'Rejected archive must stop before executable-tree reuse/removal')
                report = json.loads((build / 'logs/toolchain-archives.json').read_text())
                self.assertFalse(report['archives'][0]['verified'])
                cached.write_bytes(data)
                module.main()
                self.assertFalse(extracted.exists(), 'Verified archive forces fresh extraction instead of trusting stale executables')
                self.assertEqual(cached.read_bytes(), data)
                self.assertTrue(json.loads((build / 'logs/toolchain-archives.json').read_text())['archives'][0]['verified'])

if __name__ == '__main__':
    unittest.main()
