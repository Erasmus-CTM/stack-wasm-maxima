#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Synthetic controls for executed STACK optimization and packaged FAS binding."""
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from stack_compiler_evidence import (NAME, ROOT, PROOF, compiler_profile, derive,
                                     describe, successful_tools, verify)
from bundle_provenance import describe as bundle, record
from parser_bootstrap import PINNED_SOURCES

spec = importlib.util.spec_from_file_location('runtime_fixtures', ROOT / 'runtime/build/test-compiler-evidence.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


def traces(pin, base='/repo/.cache/runtime-build'):
    cc = base + '/sources/emsdk/upstream/emscripten/emcc'
    clang = base + '/sources/emsdk/upstream/bin/clang'
    opt = base + '/sources/emsdk/upstream/bin/wasm-opt'
    cache = str(Path(base).parent)
    directory = cache + ('/precompiled-stack' if pin.startswith('3338304') else '/precompiled-stack-10d3233')
    directory += '/source-initialized/wasm32-emscripten/'
    printed, executed = [], []
    def command(argv, prefix=''):
        printed.append(prefix + shlex.join(argv))
        pid = str(100 + len(executed))
        executed.append(f'{pid} execve({json.dumps(argv[0])}, {json.dumps(argv)}, 0x123 /* 50 vars */) = 0\n{pid} exit_group(0) = ?')
    for source in [directory+'display2d-bridge.c', directory+'stackmaxima.c', '/tmp/eclinitABC.c']:
        output = source.removesuffix('.c') + '.o'
        command([cc, '-O0', '-O2', '-c', source, '-o', output], ';;; ')
        command([clang, '-Oz', '-c', source, '-o', output])
    for output in [directory+'display2d-bridge-tmpX.fas', directory+'stackmaxima-tmpY.fas',
                   directory+'ctm-stackmaxima-'+pin[:7]+'.fasb']:
        command([cc, '-o', output, '-sSIDE_MODULE', '-sSTACK_SIZE=33554432',
                 '-sBINARYEN_EXTRA_PASSES=--spill-pointers', 'unit.o'], ';;; ')
        command([opt, '--spill-pointers', output, '-o', output])
    config = fixtures.CONFIG.replace(b'/repo', base.encode())
    return config, fixtures.TARGET, ('\n'.join(printed)+'\n').encode(), ('\n'.join(executed)+'\n').encode()


class StackCompilerEvidence(unittest.TestCase):
    def setUp(self):
        self.profile = compiler_profile(NAME)
        self.pins = list(PINNED_SOURCES)

    def test_both_pins_require_executed_oz_and_the_exact_delivered_link(self):
        for pin in self.pins:
            result = derive(*traces(pin), self.profile, pin)
            self.assertEqual(len(result['successfulToolProcesses']), 12)
            actual = [r for r in result['generatedCompiles'] if r['executed']]
            self.assertEqual(len(actual), 3)
            self.assertTrue(all(r['optimization']=='-Oz' for r in actual))
            self.assertTrue(result['deliveredOutput'].endswith(pin[:7]+'.fasb'))

    def test_wrong_optimization_and_printed_only_claims_fail(self):
        pin = self.pins[0]
        config, target, printed, execution = traces(pin)
        cases = [(printed, b''), (printed, execution.replace(b'"-Oz"', b'"-O2"')),
                 (printed.replace(b'-Oz', b'-O3'), execution),
                 (printed, b'\n'.join(line for line in execution.splitlines() if b'/clang"' not in line))]
        for left, right in cases:
            with self.assertRaises(AssertionError):
                derive(config, target, left, right, self.profile, pin)

    def test_missing_or_failed_process_exit_fails_even_with_successful_exec(self):
        pin = self.pins[0]
        config, target, printed, execution = traces(pin)
        for bad in [execution.replace(b'exit_group(0)', b'exit_group(1)', 1),
                    execution.replace(b'100 exit_group(0) = ?', b''),
                    execution.replace(b') = 0', b') = -1 ENOENT')]:
            with self.assertRaises(AssertionError):
                derive(config, target, printed, bad, self.profile, pin)

    def test_missing_driver_spill_stack_or_cross_pin_target_fails(self):
        pin = self.pins[0]
        config, target, printed, execution = traces(pin)
        cases = [execution.replace(b'"--spill-pointers"', b'"--strip-debug"'),
                 execution.replace(b'33554432', b'16777216'),
                 execution.replace(('ctm-stackmaxima-'+pin[:7]).encode(), b'ctm-stackmaxima-wrong'),
                 b'\n'.join(line for line in execution.splitlines() if b'/emcc"' not in line)]
        for bad in cases:
            with self.assertRaises(AssertionError):
                derive(config, target, printed, bad, self.profile, pin)

    def test_raw_printed_source_association_is_still_required(self):
        pin = self.pins[0]
        config, target, printed, execution = traces(pin)
        with self.assertRaises(AssertionError):
            derive(config, target, b'\n'.join(line for line in printed.splitlines() if not line.startswith(b';;; ')), execution, self.profile, pin)

    def test_distinct_exact_directory_intermediates_cannot_be_replaced_by_final_links(self):
        for pin in self.pins:
            config, target, printed, execution = traces(pin)
            final = ('ctm-stackmaxima-' + pin[:7] + '.fasb').encode()
            cases = [
                [(b'display2d-bridge-tmpX.fas', final), (b'stackmaxima-tmpY.fas', final)],
                [(b'display2d-bridge-tmpX.fas', b'stackmaxima-tmpY.fas')],
                [(b'display2d-bridge-tmpX.fas', b'../display2d-bridge-tmpX.fas')],
                [(b'stackmaxima-tmpY.fas', b'stackmaxima-tmp.fas')],
            ]
            for replacements in cases:
                left, right = printed, execution
                for original, replacement in replacements:
                    left, right = left.replace(original, replacement), right.replace(original, replacement)
                with self.assertRaisesRegex(AssertionError, 'Missing required intermediate STACK target link'):
                    derive(config, target, left, right, self.profile, pin)

    def test_unfinished_resumed_exec_and_truncation(self):
        execution = traces(self.pins[0])[3]
        resumed = execution.replace(b'], 0x123', b'] <unfinished ...>\n100 <... execve resumed>, 0x123', 1)
        self.assertEqual(successful_tools(execution), successful_tools(resumed))
        for bad in [resumed.splitlines()[0]+b'\n', execution.replace(b'"-Oz"', b'...', 1)]:
            with self.assertRaises((AssertionError, ValueError, SyntaxError)):
                successful_tools(bad)

    @unittest.skipUnless(shutil.which('strace'), 'Builder requires strace')
    def test_real_strace_process_exit_format(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tool = root/'clang'; tool.symlink_to(sys.executable)
            log = root/'exec.log'
            for code in [0, 7]:
                subprocess.run(['strace','-f','-qq','-e','trace=execve,exit_group','-e','signal=none',
                                '-s','1048576','-o',str(log),str(tool),'-c',f'raise SystemExit({code})'],
                               check=False, stdout=subprocess.DEVNULL)
                if code == 0:
                    self.assertEqual(successful_tools(log.read_bytes())[0]['exitCode'], 0)
                else:
                    with self.assertRaises(AssertionError): successful_tools(log.read_bytes())

    def test_bundle_trace_and_rehashed_claim_tampering_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); pin = self.pins[0]
            work = root/('precompiled-stack' if pin.startswith('3338304') else 'precompiled-stack-10d3233')
            logs = root/'runtime/logs'; logs.mkdir(parents=True)
            (work/'logs').mkdir(parents=True)
            initialized = work/'source-initialized'; generated=initialized/'wasm32-emscripten'
            generated.mkdir(parents=True)
            values = {'stackmaxima.mac': b'entry', 'stackmaxima.lisp': b'translated',
                      'display2d-bridge.lisp': b'bridge', 'parser-declarations.mac': b'parser',
                      'parser-declarations.json': b'{}', 'ctm-stackmaxima-'+pin[:7]+'.asd': b'asdf'}
            for path, body in values.items(): (initialized/path).write_bytes(body)
            for path in ['stackmaxima.c','display2d-bridge.c']: (generated/path).write_bytes(b'generated C')
            binary=b'fixture wasm'; adapter=b'adapter'
            (work/'stackmaxima.fas').write_bytes(binary)
            (work/'assignment-adapter.lisp').write_bytes(adapter)
            (generated/('ctm-stackmaxima-'+pin[:7]+'.fasb')).write_bytes(binary)
            descriptor=bundle(pin,b'entry',b'translated',b'bridge',adapter,b'parser',b'{}',binary)
            (work/'stackmaxima.fas.json').write_text(json.dumps(descriptor))
            config,target,printed,execution=traces(pin,str(root/'runtime-build'))
            for path,body in [('cross-compile.log',printed),('cross-compile-exec.log',execution)]:
                (work/'logs'/path).write_bytes(body)
            for path,body in [('ecl-config.log',config),('target-info.lsp',target),
                              ('compiler-experiment.json',json.dumps({'passed':True,'profile':self.profile}).encode()),
                              ('environment.json',json.dumps({'compilerProfile':self.profile,'buildIdentity':{'runId':'123'}}).encode())]:
                (logs/path).write_bytes(body)
            expected=describe(work,logs,pin)
            (work/'logs'/PROOF).write_text(json.dumps(expected))
            artifact=logs.parent
            (artifact/'manifest.json').write_text(json.dumps({'compilerProfile':self.profile}))
            # Isolate FAS replay/binding; runtime packaged replay is independently
            # covered by test-compiler-evidence.py and the actual workflow call.
            with patch('stack_compiler_evidence.verify_packaged'):
                self.assertTrue(verify(work,artifact,pin)['passed'])
                original=(work/'stackmaxima.fas').read_bytes()
                (work/'stackmaxima.fas').write_bytes(b'copied other bundle')
                with self.assertRaises(AssertionError): verify(work,artifact,pin)
                (work/'stackmaxima.fas').write_bytes(original)
                expected['observed']['generatedCompiles'][0]['optimization']='-O2'
                (work/'logs'/PROOF).write_text(json.dumps(expected))
                with self.assertRaises(AssertionError): verify(work,artifact,pin)
                expected=describe(work,logs,pin)
                (work/'logs'/PROOF).write_text(json.dumps(expected))
                # Matching fresh proof cannot reclassify a changed runtime.
                (logs/'compiler-experiment.json').write_text(json.dumps({'passed':True,'profile':compiler_profile('ecl-oz')}))
                with self.assertRaises(AssertionError): verify(work,artifact,pin)


if __name__ == '__main__':
    unittest.main()
