#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reject flag claims unsupported by effective commands and manifested snapshots."""
import json
from pathlib import Path
import tempfile
import unittest
from compiler_profile import profiles
from compiler_evidence import derive, digest, verify_packaged

GC = '-sSTACK_SIZE=33554432 -sBINARYEN_EXTRA_PASSES=--spill-pointers'
CONFIG = ("CFLAGS='-O0 -DECL_C_COMPATIBLE_VARIADIC_DISPATCH -O0'\n"+''.join(f"{key}='{GC}'\n" for key in ['LDFLAGS','SHARED_LDFLAGS','BUNDLE_LDFLAGS','PROGRAM_LDFLAGS'])).encode()
TARGET = b'(:cc "emcc" :cflags "-O0")'


def traces(profile):
    # Emscripten EMCC_VERBOSE prints subprocess argv after EMCC_CFLAGS parsing;
    # raw make/emcc lines retain upstream flags and cannot prove optimization.
    ecl = ('emcc -O0 -c main.o.c -o main.o.o\n'+
           f' /sdk/upstream/bin/clang -O0 {profile["eclCoreOptimization"]} -c main.o.c -o main.o.o\n'+
           f' /sdk/upstream/bin/clang -O0 -O2 {profile["eclGeneratedLispOptimization"]} -c eclinitABC.c -o init.o\n'+
           f';;; emcc -o libecl.so {GC} c/all.o\n'+
           ' /sdk/bin/wasm-opt libecl.so -o libecl.so --spill-pointers\n').encode()
    maxima = (';;; emcc -O0 -O2 -c /repo/src/binary-ecl/wasm32-emscripten/maxima/residu.c -o residu.o\n'+
              ' /sdk/upstream/bin/clang -O0 -O2 -c /repo/src/binary-ecl/wasm32-emscripten/maxima/residu.c -o residu.o\n'+
              f';;; emcc -o solve.fasb {GC} solve.o\n'+
              ' /sdk/bin/wasm-opt solve.fasb -o solve.fasb --spill-pointers\n').encode()
    return ecl,maxima


def packaged(root, profile):
    ecl,maxima = traces(profile)
    record = {'schema':1,'passed':True,'profile':profile,'observed':derive(CONFIG,TARGET,ecl,maxima,profile)}
    bodies = {'compiler-experiment.json':json.dumps(record).encode(),'ecl-config.log':CONFIG,
              'target-info.lsp':TARGET,'ecl-cross-build.log':ecl,'maxima-cross-build.log':maxima}
    logs = root/'logs';logs.mkdir()
    for name,body in bodies.items():
        (logs/name).write_bytes(body)
    inventory = [{'path':'logs/'+name,'bytes':len(body),'sha256':digest(body)} for name,body in bodies.items()]
    (root/'artifact-manifest.json').write_text(json.dumps({'files':inventory}))
    return record


class CompilerEvidence(unittest.TestCase):
    def test_all_profiles_and_real_effective_flags(self):
        for profile in profiles()['profiles'].values():
            ecl,maxima = traces(profile)
            observed = derive(CONFIG,TARGET,ecl,maxima,profile)
            self.assertEqual(observed['rawConfigureOptimization'],'-O0')
            self.assertEqual(observed['eclCore'][0]['optimization'],profile['eclCoreOptimization'])
            self.assertEqual(observed['maximaGeneratedUnits'][0]['optimization'],'-O2')

    def test_missing_wrong_and_leaked_effective_flags(self):
        profile = profiles()['profiles']['ecl-oz'];ecl,maxima = traces(profile)
        cases = [(ecl.replace(b'/sdk/upstream/bin/clang',b'/sdk/emcc'),maxima),
                 (ecl.replace(b'-Oz',b'-O0'),maxima),
                 (ecl,maxima.replace(b'-O2',b'-Oz')),
                 (ecl.replace(b'eclinitABC.c',b'other.c'),maxima),
                 (ecl,maxima.replace(b'/repo/src/binary-ecl/wasm32-emscripten/',b'/tmp/')),
                 (ecl.replace(b'--spill-pointers',b'--strip-debug'),maxima),
                 (ecl,maxima.replace(b'--spill-pointers',b'--strip-debug'))]
        for left,right in cases:
            with self.assertRaises(AssertionError):derive(CONFIG,TARGET,left,right,profile)
        with self.assertRaises(AssertionError):derive(CONFIG.replace(b'PROGRAM_LDFLAGS=',b'OTHER='),TARGET,ecl,maxima,profile)
        with self.assertRaises(AssertionError):derive(CONFIG.replace(b'-O0',b'-Oz'),TARGET,ecl,maxima,profile)

    def test_artifact_byte_binding_and_rehashed_fabricated_claim(self):
        profile = profiles()['profiles']['baseline']
        fixture_root=Path(__file__).resolve().parents[2]/'.cache/compiler-fixtures'
        fixture_root.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=fixture_root) as tmp:
            root = Path(tmp);record = packaged(root,profile)
            verify_packaged(root,profile)
            record['observed']['eclCore'][0]['optimization']='-Oz'
            (root/'logs/compiler-experiment.json').write_text(json.dumps(record))
            with self.assertRaises(AssertionError):verify_packaged(root,profile)
            with self.assertRaises(AssertionError):verify_packaged(root,profiles()['profiles']['ecl-oz'])
            rows = json.loads((root/'artifact-manifest.json').read_bytes())
            body = (root/'logs/compiler-experiment.json').read_bytes()
            row = next(r for r in rows['files'] if r['path']=='logs/compiler-experiment.json')
            row.update(bytes=len(body),sha256=digest(body))
            (root/'artifact-manifest.json').write_text(json.dumps(rows))
            with self.assertRaises(AssertionError):verify_packaged(root,profile)


if __name__=='__main__':unittest.main()
