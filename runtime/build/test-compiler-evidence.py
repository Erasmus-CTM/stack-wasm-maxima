#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reject flag claims unsupported by effective commands and manifested snapshots."""
import json
from pathlib import Path
import tempfile
import unittest
import shlex
import shutil
import subprocess
import sys
from compiler_profile import profiles
from compiler_evidence import derive, digest, verify_packaged, MODULES, commands, config_assignments

REQUIRE_STRACE='--require-strace' in sys.argv
if REQUIRE_STRACE:
    sys.argv.remove('--require-strace')
    assert shutil.which('strace'), 'The build requires OS execution tracing'

GC = '-sSTACK_SIZE=33554432 -sBINARYEN_EXTRA_PASSES=--spill-pointers'
CONFIG = ("CC='/repo/sources/emsdk/upstream/emscripten/emcc'\nCFLAGS='-O0 -DECL_C_COMPATIBLE_VARIADIC_DISPATCH -O0'\n"+''.join(f"{key}='{GC}'\n" for key in ['LDFLAGS','SHARED_LDFLAGS','BUNDLE_LDFLAGS','PROGRAM_LDFLAGS'])).encode()
TARGET = b'(:cc "emcc" :cflags "-O0")'


def traces(profile):
    cc='/repo/sources/emsdk/upstream/emscripten/emcc'
    clang='/repo/sources/emsdk/upstream/bin/clang'
    def compile(source,output,raw,actual,generated=False):
        return ((';;; ' if generated else '')+f'{cc} {raw} -c {source} -o {output}\n'+
                f' {clang} {actual} -c {source} -o {output}\n')
    def link(output,wasm):
        side='-sSIDE_MODULE' if output.endswith(('.so','.fas','.fasb')) else ''
        return f';;; {cc} -o {output} {GC} {side} unit.o\n /sdk/bin/wasm-opt --spill-pointers {wasm} -o {wasm}\n'
    ecl=compile('main.o.c','main.o.o','-O0',profile['eclCoreOptimization'])
    ecl+=compile('other-core.o.c','other-core.o','-O0',profile['eclCoreOptimization'])
    ecl+=compile('eclinitABC.c','init.o','-O0 -O2',profile['eclGeneratedLispOptimization'],True)
    ecl+=compile('lsp/arraylib.c','lsp/arraylib.o','-O0 -O2',profile['eclGeneratedLispOptimization'],True)
    ecl+=f' {clang} -O2 -c /repo/sources/emsdk/upstream/emscripten/system/lib/sdk.c -o sdk.o\n'
    ecl+=f' {clang} -O2 -c conftest.c -o conftest.o\n'
    ecl+=link('libecl.so','libecl.so')+link('bin/ecl.html','bin/ecl.wasm')
    for auxiliary in ['ecl-cdb.fas','ecl-help.fas','serve-event.fas','package-locks.fas']:
        ecl+=link(auxiliary,auxiliary)
    prefix='/repo/sources/maxima/src/binary-ecl/wasm32-emscripten'
    maxima=compile(prefix+'/maxima/residu.c','residu.o','-O0 -O2','-O2',True)
    maxima+=compile('/tmp/eclinitMAX.c','init-max.o','-O0 -O2','-O2',True)
    maxima+=link(prefix+'/maxima.html',prefix+'/maxima.wasm')
    for module in MODULES:
        maxima+=link(prefix+'/maxima/'+module+'.fasb',prefix+'/maxima/'+module+'.fasb')
    maxima+=link(prefix+'/residu-tmpABC.fas',prefix+'/residu-tmpABC.fas')
    return ecl.encode(),maxima.encode()


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
    def test_autoconf_shell_quote_transitions(self):
        value="-O0 -DECLDIR='' -Wno-macro-redefined -DECL_C_COMPATIBLE_VARIADIC_DISPATCH -O0 -fPIC "
        assignment="CFLAGS='"+value.replace("'","'\\''")+"'"
        self.assertEqual(config_assignments(assignment,{'CFLAGS'})['CFLAGS'],value)
        config=CONFIG.replace("CFLAGS='-O0 -DECL_C_COMPATIBLE_VARIADIC_DISPATCH -O0'".encode(),assignment.encode())
        for profile in profiles()['profiles'].values():
            ecl,maxima=traces(profile)
            self.assertEqual(derive(config,TARGET,ecl,maxima,profile)['rawConfigureCFlags'],value)
            for bad in [config.replace(b"-fPIC '",b"-fPIC -Oz '"),config+b"CFLAGS='-O0'\n",config.replace(b"-fPIC '",b'-fPIC '),config.replace(b"-fPIC '",b"-fPIC ' extra")]:
                with self.assertRaises(AssertionError):derive(bad,TARGET,ecl,maxima,profile)

    def test_joined_and_implicit_compile_outputs(self):
        for profile in profiles()['profiles'].values():
            ecl,maxima=traces(profile)
            ecl=ecl.replace(b' -o main.o.o',b'').replace(b' -o other-core.o',b' -oother-core.o')
            derive(CONFIG,TARGET,ecl,maxima,profile)
            with self.assertRaises(AssertionError):
                derive(CONFIG,TARGET,ecl.replace(b'-oother-core.o',b'-owrong.o',1),maxima,profile)

    def test_os_execution_trace_and_corruptions(self):
        def os_trace(body):
            lines=[]
            for line in body.decode().splitlines():
                if '/clang ' in line or '/wasm-opt ' in line:
                    argv=shlex.split(line)
                    lines.append('123 execve('+json.dumps(argv[0])+', '+json.dumps(argv)+', 0x123 /* 50 vars */) = 0')
                else:lines.append(line)
            return ('\n'.join(lines)+'\n').encode()
        for profile in profiles()['profiles'].values():
            ecl,maxima=map(os_trace,traces(profile))
            derive(CONFIG,TARGET,ecl,maxima,profile)
            with self.assertRaises(AssertionError):derive(CONFIG,TARGET,ecl,maxima.replace(b') = 0',b') = -1 ENOENT'),profile)
        complete=b'123 execve("/sdk/clang", ["clang", "-O0"], 0x123 /* 50 vars */) = 0\n'
        resumed=complete.replace(b'], 0x123',b'] <unfinished ...>\n123 <... execve resumed>, 0x123')
        self.assertEqual(commands(complete),commands(resumed))
        for bad in [complete.replace(b'["clang", "-O0"]',b'["clang", ...]'),resumed.splitlines()[0]+b'\n']:
            with self.assertRaises((AssertionError,ValueError,SyntaxError)):commands(bad)

    @unittest.skipUnless(shutil.which('strace'),'OS tracing integration runs on the Ubuntu builder')
    def test_actual_strace_output(self):
        fixture_root=Path(__file__).resolve().parents[2]/'.cache/compiler-fixtures'
        fixture_root.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=fixture_root) as tmp:
            root=Path(tmp).resolve();launcher=root/'clang';launcher.symlink_to(sys.executable)
            trace=root/'exec.log'
            subprocess.run(['strace','-f','-qq','-e','trace=execve','-e','signal=none','-s','1048576','-o',str(trace),sys.executable,'-c',f'import subprocess; subprocess.run([{str(launcher)!r}, "-c", "pass"], check=True)'],check=True)
            rows=commands(trace.read_bytes())
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]['tokens'],[str(launcher),'-c','pass'])

    def test_all_profiles_and_real_effective_flags(self):
        for profile in profiles()['profiles'].values():
            ecl,maxima = traces(profile)
            observed = derive(CONFIG,TARGET,ecl,maxima,profile)
            self.assertEqual(observed['rawConfigureOptimization'],'-O0')
            self.assertEqual(observed['eclCore'][0]['optimization'],profile['eclCoreOptimization'])
            self.assertEqual(observed['maximaGeneratedUnits'][0]['optimization'],'-O2')

    def test_missing_wrong_and_leaked_effective_flags(self):
        profile = profiles()['profiles']['ecl-oz'];ecl,maxima = traces(profile)
        cases = [(ecl.replace(b'/upstream/bin/clang',b'/upstream/bin/emcc'),maxima),
                 (ecl.replace(b'-Oz',b'-O0'),maxima),
                 (ecl,maxima.replace(b'-O2',b'-Oz')),
                 (ecl.replace(b'-Oz -c other-core.o.c',b'-O0 -c other-core.o.c'),maxima),
                 (ecl.replace(b'-Oz -c lsp/arraylib.c',b'-O0 -c lsp/arraylib.c'),maxima),
                 (ecl,maxima.replace(b'-O2 -c /tmp/eclinitMAX.c',b'-Oz -c /tmp/eclinitMAX.c')),
                 (ecl.replace(b'--spill-pointers',b'--strip-debug'),maxima),
                 (ecl,maxima.replace(b'--spill-pointers',b'--strip-debug'))]
        for left,right in cases:
            with self.assertRaises(AssertionError):derive(CONFIG,TARGET,left,right,profile)
        with self.assertRaises(AssertionError):derive(CONFIG.replace(b'PROGRAM_LDFLAGS=',b'OTHER='),TARGET,ecl,maxima,profile)
        with self.assertRaises(AssertionError):derive(CONFIG.replace(b'-O0',b'-Oz'),TARGET,ecl,maxima,profile)
        with self.assertRaises(AssertionError):derive(CONFIG.replace(b"CC=",b"OTHER="),TARGET,ecl,maxima,profile)

    def test_each_delivered_target_requires_its_own_spill_execution(self):
        profile=profiles()['profiles']['baseline'];ecl,maxima=traces(profile)
        for target in ['maxima.wasm']+['maxima/'+module+'.fasb' for module in MODULES]:
            lines=maxima.decode().splitlines()
            without_pass=('\n'.join(line for line in lines if not ('wasm-opt' in line and '/'+target+' ' in line))+'\n').encode()
            with self.assertRaises(AssertionError):derive(CONFIG,TARGET,ecl,without_pass,profile)
            target_output='maxima.html' if target=='maxima.wasm' else target
            without_link=('\n'.join(line for line in lines if not ('/emcc -o ' in line and '/'+target_output+' ' in line))+'\n').encode()
            with self.assertRaises(AssertionError):derive(CONFIG,TARGET,ecl,without_link,profile)
        wrong_ecl=ecl.replace(b'--spill-pointers libecl.so -o libecl.so',b'--spill-pointers /unrelated/libecl.so -o /unrelated/libecl.so')
        with self.assertRaises(AssertionError):derive(CONFIG,TARGET,wrong_ecl,maxima,profile)
        wrong_output=ecl.replace(b'--spill-pointers libecl.so -o libecl.so',b'--spill-pointers libecl.so -o other.so')
        with self.assertRaises(AssertionError):derive(CONFIG,TARGET,wrong_output,maxima,profile)
        # Deleting actual execution while leaving a raw compile also fails.
        missing_clang=('\n'.join(line for line in ecl.decode().splitlines() if not ('/clang ' in line and 'other-core.o.c' in line))+'\n').encode()
        with self.assertRaises(AssertionError):derive(CONFIG,TARGET,missing_clang,maxima,profile)

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
