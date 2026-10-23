#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exercise exact blobs despite upstream CRLF checkout/archive conversion."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_sources', Path(__file__).with_name('prepare-sources.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ExactCheckout(unittest.TestCase):
    def test_raw_blob_checkout_and_archive_are_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args, data=None):
                return subprocess.check_output(['git', *args], cwd=root, input=data)
            git('init', '-q')
            git('config', 'core.autocrlf', 'false')
            git('config', 'core.eol', 'lf')
            (root / '.gitattributes').write_bytes(b'* text=auto\n*.sln text eol=crlf\n')
            git('add', '.gitattributes')
            body = b'Microsoft Visual Studio Solution File\noriginal LF blob\n'
            blob = git('hash-object', '-w', '--stdin', data=body).decode().strip()
            git('update-index', '--add', '--cacheinfo', '100644', blob, 'Ffi_staticLib.sln')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Pinned input')
            git('checkout-index', '-f', '-a')
            self.assertNotEqual((root / 'Ffi_staticLib.sln').read_bytes(), body)
            prepare.canonical_git_archive(root, root / 'original.tar', 'fixture/', 'HEAD')
            archive = (root / 'original.tar').read_bytes()
            prepare.preserve_source_blob_bytes(root)
            (root / 'Ffi_staticLib.sln').unlink()
            git('checkout-index', '-f', '-a')
            self.assertEqual((root / 'Ffi_staticLib.sln').read_bytes(), body)
            prepare.canonical_git_archive(root, root / 'verified.tar', 'fixture/', 'HEAD')
            self.assertEqual((root / 'verified.tar').read_bytes(), archive)
            self.assertEqual((root / '.git/info/attributes').read_bytes(), b'* -text\n')
            self.assertEqual(git('show', 'HEAD:Ffi_staticLib.sln'), body)


if __name__ == '__main__':
    unittest.main()
