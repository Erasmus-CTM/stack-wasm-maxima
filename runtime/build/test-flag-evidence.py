#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reject stale manifests, fabricated flag claims and compiler evidence gaps."""
import json
from pathlib import Path
import tempfile
import unittest
from flag_evidence import derive_flags, verify_artifact_flags, digest
from profile import ROOT, configuration


class Flags(unittest.TestCase):
    def fixture(self, root, name='baseline'):
        profile = configuration(name)
        flag = profile['eclCFlag']
        config = (f"CFLAGS='-O0 -DECL_C_COMPATIBLE_VARIADIC_DISPATCH {flag} -fPIC'\n" +
                  '\n'.join(f"{key}='-sSTACK_SIZE=33554432 -sBINARYEN_EXTRA_PASSES=--spill-pointers'" for key in ['LDFLAGS','SHARED_LDFLAGS','BUNDLE_LDFLAGS','PROGRAM_LDFLAGS']) + '\n').encode()
        commands = (f"/sdk/emcc -O0 {flag} -fPIC -c -o main.o main.o.c\n"
                    f";;; /sdk/emcc -O0 {flag} -Demscripten -O2 -c /maxima/src/binary-ecl/wasm32-emscripten/residu.c -o residu.o\n"
                    f";;; /sdk/emcc -I/ecl/src/c -O0 {flag} -O2 -c /tmp/eclinitABC.c -o init.o\n").encode()
        target = b'((c::*cc-flags* . "fixture-target-info"))\n'
        fields = derive_flags(config, target, commands, profile)
        record = {'schema':1,'configuration':profile,'passed':True,**fields}
        logs = root / 'logs'
        logs.mkdir()
        for filename, body in {'ecl-config.log':config,'compiler-commands.log':commands,'target-info.lsp':target,'effective-flags.json':json.dumps(record).encode()}.items():
            (logs / filename).write_bytes(body)
        self.manifest(root)
        return profile

    def manifest(self, root):
        records = [{'path':p.relative_to(root).as_posix(),'bytes':p.stat().st_size,'sha256':digest(p.read_bytes())} for p in (root / 'logs').iterdir()]
        (root / 'artifact-manifest.json').write_text(json.dumps({'schema':1,'files':records}))

    def test_valid_profiles_and_lisp_initializer_not_misidentified(self):
        for name in ['baseline','ecl-oz','ecl-o2']:
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=self.work) as tmp:
                root = Path(tmp)
                profile = self.fixture(root,name)
                record = verify_artifact_flags(root, profile)
                self.assertIn('main.o.c',record['representativeEclCompile'])
                self.assertIn('/wasm32-emscripten/residu.c',record['representativeMaximaCompile'])

    def test_stale_manifest_and_fabricated_claims(self):
        for update_manifest in [False, True]:
            with self.subTest(update_manifest=update_manifest), tempfile.TemporaryDirectory(dir=self.work) as tmp:
                root = Path(tmp); profile = self.fixture(root)
                path = root / 'logs/effective-flags.json'; record = json.loads(path.read_text())
                del record['linkFlags']; del record['representativeEclCompile']
                path.write_text(json.dumps(record))
                if update_manifest:
                    self.manifest(root)
                with self.assertRaises((AssertionError, KeyError)):
                    verify_artifact_flags(root, profile)

    def test_missing_core_compile_or_gc_link_setting(self):
        for filename, before, after in [('ecl-config.log','PROGRAM_LDFLAGS','REMOVED_LINK_FLAG'),('ecl-config.log','--spill-pointers','--removed-pass'),('compiler-commands.log','main.o.c','unrelated.c')]:
            with self.subTest(before=before), tempfile.TemporaryDirectory(dir=self.work) as tmp:
                root = Path(tmp); profile = self.fixture(root)
                path = root / 'logs' / filename
                path.write_text(path.read_text().replace(before, after))
                self.manifest(root)
                with self.assertRaises(AssertionError):
                    derive_flags((root / 'logs/ecl-config.log').read_bytes(), (root / 'logs/target-info.lsp').read_bytes(), (root / 'logs/compiler-commands.log').read_bytes(), profile)
                with self.assertRaises(AssertionError):
                    verify_artifact_flags(root, profile)

    @classmethod
    def setUpClass(cls):
        cls.work = ROOT / '.cache/runtime-build/tests'
        cls.work.mkdir(parents=True, exist_ok=True)


if __name__ == '__main__':
    unittest.main()
