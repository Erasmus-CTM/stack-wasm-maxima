#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exercise exact blobs despite upstream CRLF checkout/archive conversion."""
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare_sources', Path(__file__).with_name('prepare-sources.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ExactCheckout(unittest.TestCase):
    def test_interrupted_fetch_retries_the_same_exact_request(self):
        interrupted = subprocess.CalledProcessError(
            128, ['git', 'fetch'], stderr='fatal: early EOF')
        with patch.object(prepare.subprocess, 'check_output',
                          side_effect=[interrupted, 'done\n']) as command, \
                patch.object(prepare.time, 'sleep') as sleep:
            self.assertEqual(prepare.fetch_source(Path('/fixture'), '--depth=1',
                                                 'origin', 'a' * 40), 'done')
            self.assertEqual(command.call_count, 2)
            self.assertEqual(command.call_args_list[0], command.call_args_list[1])
            sleep.assert_called_once_with(2)

    def test_fetch_failure_is_bounded_and_never_uses_stale_sources(self):
        for diagnostic, attempts in [('fatal: early EOF', 3),
                                     ('remote: HTTP 403 Forbidden', 1),
                                     ('fatal: could not read Username', 1),
                                     ('fatal: not our ref', 1)]:
            with self.subTest(diagnostic=diagnostic):
                failure = subprocess.CalledProcessError(
                    128, ['git', 'fetch'], stderr=diagnostic)
                with patch.object(prepare.subprocess, 'check_output',
                                  side_effect=failure) as command, \
                        patch.object(prepare.time, 'sleep'), \
                        patch.object(prepare.sys, 'stderr', new_callable=io.StringIO) as stderr:
                    with self.assertRaises(subprocess.CalledProcessError):
                        prepare.fetch_source(Path('/fixture'), 'origin', 'a' * 40)
                    self.assertEqual(command.call_count, attempts)
                    self.assertIn(diagnostic, stderr.getvalue())

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
