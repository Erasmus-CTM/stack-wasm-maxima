#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
import importlib.util
import io
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('frozen_inputs', Path(__file__).with_name('frozen-inputs.py'))
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)


class FrozenArchives(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / 'out'

    def archive(self, members, compression=zipfile.ZIP_DEFLATED):
        target = io.BytesIO()
        with zipfile.ZipFile(target, 'w', compression=compression) as archive:
            for name, body in members:
                archive.writestr(name, body)
        return target.getvalue()

    def unpack(self, body):
        return inputs.unpack(body, {'sha256': inputs.digest(body), 'prefix': 'selected/'}, self.output)

    def test_valid_selected_and_unselected_members(self):
        rows = self.unpack(self.archive([('selected/raw', b'payload'), ('other/log', b'evidence')]))
        self.assertEqual((self.output / 'selected/raw').read_bytes(), b'payload')
        self.assertFalse((self.output / 'other').exists())
        self.assertEqual(rows[1]['sha256'], inputs.digest(b'evidence'))

    def test_zip_hash_before_any_extraction(self):
        body = self.archive([('selected/raw', b'payload')])
        with self.assertRaises(AssertionError): inputs.unpack(body, {'sha256': '0' * 64, 'prefix': 'selected/'}, self.output)
        self.assertFalse(self.output.exists())

    def test_traversal(self):
        with self.assertRaises(AssertionError): self.unpack(self.archive([('../escaped', b'bad')]))

    def test_single_backslash(self):
        with self.assertRaises(AssertionError): self.unpack(self.archive([('selected/' + chr(92) + 'escaped', b'bad')]))

    def test_symlink(self):
        info = zipfile.ZipInfo('selected/link')
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(AssertionError): self.unpack(self.archive([(info, b'../outside')]))

    def test_duplicate(self):
        with self.assertWarns(UserWarning): body = self.archive([('selected/raw', b'one'), ('selected/raw', b'two')])
        with self.assertRaises(AssertionError): self.unpack(body)

    def test_unsupported_compression(self):
        with self.assertRaises(AssertionError): self.unpack(self.archive([('selected/raw', b'data')], zipfile.ZIP_BZIP2))

    def test_total_limit(self):
        with patch.object(inputs, 'MAX_TOTAL', 3):
            with self.assertRaises(AssertionError): self.unpack(self.archive([('selected/raw', b'data')]))

    def test_missing_selected_input(self):
        with self.assertRaises(AssertionError): self.unpack(self.archive([('other/log', b'data')]))


if __name__ == '__main__':
    unittest.main()
