#!/usr/bin/env python3
"""Repeated probe preparation preserves the same batch without reusing an oracle home."""
import contextlib
import importlib
import io
import json
from pathlib import Path
import runpy
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PINS = ('10d323311b7f39fb7b092dd10ce75f7d8632f525', '33383047af39c204bf4442802a058f8b918b2b1b')
CTM = '9e042dc5e57a1636be64ca5d08910c9af5ff1371'

class RepeatedPreparation(unittest.TestCase):
    def test_two_runs_with_existing_legacy_homes_emit_identical_batches(self):
        script = Path(__file__).with_name('prepare.py').read_text()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            copied = root / 'scripts/milestone-one/prepare.py'
            copied.parent.mkdir(parents=True); copied.write_text(script)
            fixtures = root / '.ctm-checkers-source/tests/stack/native_compliance/fixtures.json'
            fixtures.parent.mkdir(parents=True)
            cases = []
            for matrix in (False, True):
                for score in (1, 0):
                    cases.append({'id': str(len(cases)), 'test':'AlgEquiv', 'expected_score':score,
                        'student':'matrix([1])' if matrix else '1', 'teacher':'matrix([2])' if matrix else '2',
                        'options':'', 'ordinal':len(cases)})
            fixtures.write_text(json.dumps({'cases':cases}))
            for pin in PINS:
                source = root / '.stack-upstream' / pin / 'stack/maxima'
                source.mkdir(parents=True); (source/'stackmaxima.mac').write_text('stackmaximaversion:123$')
                legacy = root / '.cache' / ('wasm-home-' + pin[:7])
                legacy.mkdir(parents=True)
                (legacy/'moodle-qtype_stack-master').symlink_to(source.parent.parent, target_is_directory=True)
                (legacy/'sentinel').write_text('preserve existing evidence')
            homes = []
            def make_batch(source, selected, home, seed):
                # The pinned oracle's exclusive symlink creation is the actual
                # failing filesystem operation; do not make it idempotent here.
                (home/'moodle-qtype_stack-master').symlink_to(source, target_is_directory=True)
                homes.append(home)
                return f'home:"{home.resolve()}"$\nsource:"{source.resolve()}"$\ndisplay2d:false$\nlinel:10000$\nquit()$'
            runner = SimpleNamespace(TESTS=['AlgEquiv'], _unavailable=lambda case:None,
                run_native=lambda *args,**kwargs:{'observations':[]}, make_batch=make_batch)
            original_import = importlib.import_module
            def module(name, *args, **kwargs):
                return runner if name=='native_compliance.maxima_runner' else original_import(name,*args,**kwargs)
            def revision(command, **kwargs):
                repo = Path(command[2])
                return (CTM if repo.name=='.ctm-checkers-source' else repo.name)+'\n'
            outputs = []
            with patch('importlib.import_module', side_effect=module), patch('subprocess.check_output', side_effect=revision):
                for _ in range(2):
                    with contextlib.redirect_stdout(io.StringIO()): runpy.run_path(str(copied), run_name='__main__')
                    outputs.append((root/'test-results/milestone-one/prepared.json').read_bytes())
            self.assertEqual(outputs[0], outputs[1])
            self.assertEqual(len(set(homes)), 4)
            self.assertTrue(all(not home.exists() for home in homes))
            for version in json.loads(outputs[0])['versions']:
                self.assertIn('/ctm/moodle-qtype_stack-master', version['batch'])
                self.assertNotIn(str(root), version['batch'])
            for pin in PINS:
                legacy = root/'.cache'/('wasm-home-'+pin[:7])
                self.assertEqual((legacy/'sentinel').read_text(),'preserve existing evidence')
                self.assertTrue((legacy/'moodle-qtype_stack-master').is_symlink())

if __name__=='__main__': unittest.main()
