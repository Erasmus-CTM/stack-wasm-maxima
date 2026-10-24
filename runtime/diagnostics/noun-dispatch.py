#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Temporary native evidence collection; never merge or treat success as parity.

Build inputs are local outputs of the unchanged pinned native workflow. Each
probe uses a fresh process and complete STACK startup. No warning is cleared,
filtered or disabled, and no operator/function is replaced for observation.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.cache/noun-dispatch'
STACK = ROOT / '.cache/precompiled-stack/upstream-stack'
BUILD = ROOT / '.cache/precompiled-stack'
MAXIMA = ROOT / '.cache/runtime-build/sources/maxima'
NATIVE = MAXIMA / 'wasm/maxima-ecl-combined/bin/maxima'
PIN = '33383047af39c204bf4442802a058f8b918b2b1b'
BASE = '1f59437a304fb6f4270a611f4af91a03fd4d42da'
DIAGNOSTIC_PATHS = {'.github/workflows/noun-dispatch-diagnostic.yml',
                    'runtime/diagnostics/noun-dispatch.py'}
OLD_LOAD = 'load("stackmaxima.mac")$'
LOADER = 'stack/maxima/stacklocallinux.mac'

# Helpers only read the existing runtime. In particular, reading an unbound
# value never invokes trd-msymeval, and warning history is never reset.
STATE_LISP = r'''(in-package :maxima)
(defun ctm-noun-bool (value) (not (null value)))
(defun ctm-noun-string (value)
  (let ((*print-readably* nil) (*print-pretty* nil) (*print-circle* t))
    (prin1-to-string value)))
(defun ctm-noun-map (&rest pairs) (list* '(mlist) "stack_map" pairs))
(defun ctm-noun-pair (name value) (list '(mlist) name value))
(defun ctm-noun-symbol-state (symbol)
  (ctm-noun-map
   (ctm-noun-pair "fbound" (ctm-noun-bool (fboundp symbol)))
   (ctm-noun-pair "mexpr" (ctm-noun-bool (mget symbol 'mexpr)))
   (ctm-noun-pair "mfexpr" (ctm-noun-bool (get symbol 'mfexpr*)))
   (ctm-noun-pair "macro" (ctm-noun-bool (macro-function symbol)))
   (ctm-noun-pair "autoload" (ctm-noun-string (get symbol 'autoload)))
   (ctm-noun-pair "bound" (ctm-noun-bool (boundp symbol)))
   (ctm-noun-pair "value" (if (boundp symbol)
                             (ctm-noun-string (symbol-value symbol)) "<unbound>"))
   (ctm-noun-pair "warned" (ctm-noun-bool (assoc symbol *tr-runtime-warned*)))
   (ctm-noun-pair "warningReason" (ctm-noun-string (cdr (assoc symbol *tr-runtime-warned*))))
   (ctm-noun-pair "undefinedWarned" (ctm-noun-bool (get symbol 'undefined-warnp)))
   (ctm-noun-pair "puntNilWarned" (ctm-noun-bool (get symbol 'punt-nil-warnp)))
   (ctm-noun-pair "properties" (ctm-noun-string (symbol-plist symbol)))))
(defmfun $ctm_noun_state ()
  (ctm-noun-map
   (ctm-noun-pair "nounor" (ctm-noun-symbol-state '$nounor))
   (ctm-noun-pair "nounand" (ctm-noun-symbol-state '$nounand))
   (ctm-noun-pair "nounnot" (ctm-noun-symbol-state '$nounnot))
   (ctm-noun-pair "target" (ctm-noun-symbol-state '$stack_noteq_single_remove))
   (ctm-noun-pair "warningsEnabled" (ctm-noun-bool $tr_warn_bad_function_calls))
   (ctm-noun-pair "allWarningHistory" (ctm-noun-string *tr-runtime-warned*))))
(defmfun $ctm_noun_assert_runtime (compiled)
  (unless (if (eq compiled t)
              (fboundp '$stack_noteq_single_remove)
              (and (not (fboundp '$stack_noteq_single_remove))
                   (mget '$stack_noteq_single_remove 'mexpr)))
    (error "Unexpected source/translated entry function ownership"))
  t)
'''

CASES = [
    {'id': 'direct-remove', 'kind': 'direct',
     'call': 'stack_noteq_single_remove(parse_string("x#0"))'},
    {'id': 'direct-solver', 'kind': 'direct',
     'call': 'stack_single_variable_solver(parse_string("x#0"))'},
    {'id': 'validate-neq-neq', 'kind': 'validation', 'student': 'x#0', 'teacher': 'x#1'},
    {'id': 'validate-neq-inequality', 'kind': 'validation', 'student': 'x#0', 'teacher': 'x>1'},
    {'id': 'validate-logical-neq', 'kind': 'validation',
     'student': '(x#0) nounand (x<2)', 'teacher': '(x<0) nounor ((x>0) nounand (x<2))'},
    {'id': 'validate-ordinary-control', 'kind': 'validation', 'student': 'x>0', 'teacher': 'x>1'},
]


def record(path: Path):
    body = path.read_bytes()
    return {'path': str(path), 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}


def save(path: Path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True, allow_nan=False) + '\n')


def literal(value):
    return json.dumps(value, ensure_ascii=True)


def stack_map(pairs):
    return '["stack_map",' + ','.join('[' + literal(k) + ',' + v + ']' for k, v in pairs) + ']'


def expression(case, capture: Path):
    """The validation decision/capture follows engine.validationExpression.

    Inputs are authored diagnostic expressions, not an admission-layer test.
    Source/TeX fields are produced only when the captured lines and %ERR permit
    validation, just as in the engine. Direct probes report their captured text
    without imposing a guessed expected result.
    """
    local = ('simp:false,assume_pos:false,assume_real:false,%ERR:["stack_map"],'
             '%NOTES:["stack_map"],%FEEDBACK:["stack_map"],%stmt:"ctm-native",'
             '_ctm_before,_ctm_after,_ctm_s,_ctm_t,_ctm_v,_ctm_r,'
             '_ctm_stream,_ctm_line,_ctm_lines,_ctm_good,_ctm_result')
    path = literal(str(capture))
    if case['kind'] == 'validation':
        setup = ['_ctm_t:eval_string(' + literal(case['teacher']) + ')']
        work = ['_ctm_s:eval_string(' + literal(case['student']) + ')',
                'with_stdout(' + path + ',_ctm_v:stack_validate([_ctm_s],false,_ctm_t,0))']
    else:
        setup = []
        work = ['with_stdout(' + path + ',_ctm_v:' + case['call'] + ')']
    # These lines deliberately retain every nonempty captured line. In
    # particular, an untranslated-function warning makes validation invalid.
    work += ['_ctm_stream:openr(' + path + ')', '_ctm_line:readline(_ctm_stream)',
             'while not is(_ctm_line=false) do '
             '(if slength(_ctm_line)>0 then _ctm_lines:endcons(_ctm_line,_ctm_lines),'
             '_ctm_line:readline(_ctm_stream))', 'close(_ctm_stream)',
             'if length(%ERR)>1 then _ctm_lines:endcons("Native STACK could not evaluate this expression",_ctm_lines)',
             '_ctm_good:is(_ctm_lines=[] and length(%ERR)=1)']
    if case['kind'] == 'validation':
        value = stack_map([('valid', '_ctm_good'), ('feedback', 'simplode(_ctm_lines," ")'),
                           ('latex', 'if _ctm_good then tex1(_ctm_s) else ""'),
                           ('source', 'if _ctm_good then string(ev(_ctm_s,simp)) else ""')])
    else:
        value = stack_map([('value', 'string(_ctm_v)'), ('capturedLines', '_ctm_lines')])
    work.append(value)
    commands = ['_ctm_before:ctm_noun_state()', '_ctm_lines:[]', *setup,
                '_ctm_r:errcatch(block([],' + ','.join(work) + '))',
                '_ctm_after:ctm_noun_state()',
                stack_map([('before', '_ctm_before'), ('after', '_ctm_after'),
                           ('evaluationSucceeded', 'is(not(_ctm_r=[]))'),
                           ('result', 'if _ctm_r=[] then "CAS evaluation failed" else first(_ctm_r)'),
                           ('errors', 'string(%ERR)')])]
    return 'block([' + local + '],' + ','.join(commands) + ')'


def run_case(reference, arm, tree, case, env, expected_version, helper):
    directory = OUT / 'processes' / arm / case['id']
    directory.mkdir(parents=True)
    home = directory / 'home'
    home.mkdir()
    capture = directory / 'captured-stdout.txt'
    program = expression(case, capture)
    batch = reference.make_batch(tree, home, [{'expression': program}])
    anchor = 'm3_emit(sconcat("CTMNATIVE-VERSION|",MAXIMA_VERSION_STR,"|",stackmaximaversion))$\n'
    assert batch.count(anchor) == 1
    batch = batch.replace(anchor, anchor + ':lisp (load ' + literal(str(helper)) + ')\n'
                          + 'ctm_noun_assert_runtime(' + ('true' if arm == 'compiled' else 'false') + ')$\n')
    batch_path = directory / 'driver.mac'
    batch_path.write_text(batch)
    (directory / 'expression.mac').write_text(program + '$\n')
    row = {'arm': arm, 'case': case, 'batch': record(batch_path),
           'expression': program, 'freshProcess': True, 'evidenceComplete': False}
    started = time.monotonic()
    try:
        result = subprocess.run([str(NATIVE), '--very-quiet', '--quit-on-error', '--batch=' + str(batch_path)],
                                capture_output=True, text=True, env=env, timeout=180)
        (directory / 'stdout.log').write_text(result.stdout)
        (directory / 'stderr.log').write_text(result.stderr)
        row.update(exitCode=result.returncode, elapsedSeconds=time.monotonic() - started)
        if result.returncode:
            raise ValueError('Native process failed; see retained stdout/stderr')
        values, versions, ends = [], [], 0
        for line in result.stdout.splitlines():
            if match := reference.MARKER.fullmatch(line):
                if match[1] != '0':
                    raise ValueError('Unexpected result index')
                values.append(reference.load_json(match[2]))
            elif match := reference.VERSION.fullmatch(line):
                versions.append({'maxima': match[1], 'stackLibrary': match[2]})
            elif line.strip() == 'CTMNATIVE-END|1':
                ends += 1
            elif line.lstrip().startswith(('CTMNATIVE-REFERENCE|', 'CTMNATIVE-VERSION|', 'CTMNATIVE-END|')):
                raise ValueError('Malformed diagnostic protocol')
        if len(values) != 1 or len(versions) != 1 or ends != 1:
            raise ValueError('Incomplete or duplicate diagnostic protocol')
        if versions[0]['stackLibrary'] != expected_version or '813903d33' not in versions[0]['maxima']:
            raise ValueError('Unexpected pinned STACK/Maxima runtime version')
        envelope = values[0]
        if not isinstance(envelope, list) or len(envelope) != 2 or envelope[0] is not True:
            raise ValueError('Diagnostic program failed before returning its observation')
        observation = envelope[1]
        if not isinstance(observation, dict) or set(observation) != {'before', 'after', 'evaluationSucceeded', 'result', 'errors'}:
            raise ValueError('Malformed diagnostic observation')
        if type(observation['evaluationSucceeded']) is not bool or not isinstance(observation['errors'], str):
            raise ValueError('Malformed diagnostic result types')
        for phase in ('before', 'after'):
            if observation[phase]['warningsEnabled'] is not True:
                raise ValueError('Runtime warning policy was disabled')
            for symbol in ('nounor', 'nounand', 'nounnot', 'target'):
                state = observation[phase][symbol]
                for key in ('fbound', 'mexpr', 'mfexpr', 'macro', 'bound', 'warned', 'undefinedWarned', 'puntNilWarned'):
                    if type(state[key]) is not bool:
                        raise ValueError('Malformed runtime state Boolean: ' + phase + '/' + symbol + '/' + key)
                for key in ('autoload', 'value', 'warningReason', 'properties'):
                    if not isinstance(state[key], str):
                        raise ValueError('Malformed runtime state description')
        if observation['evaluationSucceeded']:
            value = observation['result']
            if not isinstance(value, dict):
                raise ValueError('Malformed probe result')
            if case['kind'] == 'validation':
                if (set(value) != {'valid', 'feedback', 'latex', 'source'} or type(value['valid']) is not bool
                        or not all(isinstance(value[k], str) for k in ('feedback', 'latex', 'source'))):
                    raise ValueError('Malformed validation fields')
            elif (set(value) != {'value', 'capturedLines'} or not isinstance(value['value'], str)
                  or not isinstance(value['capturedLines'], list)
                  or not all(isinstance(line, str) for line in value['capturedLines'])):
                raise ValueError('Malformed direct result fields')
        before, after = observation['before']['nounor'], observation['after']['nounor']
        fresh = not any(before[k] for k in ('warned', 'undefinedWarned', 'puntNilWarned'))
        newly_warned = fresh and after['warned']
        row.update(runtime=versions[0], observation=observation, capture=record(capture),
                   capturedStdout=capture.read_text(), freshNounorBeforeProbe=fresh,
                   newNounorWarning=newly_warned,
                   branchEvidence=('new translated nounor warning recorded' if newly_warned else
                                   'direct call requested' if case['id'] == 'direct-remove' else
                                   'no new nounor dispatch warning; branch reach is not established'),
                   evidenceComplete=True)
    except subprocess.TimeoutExpired as error:
        for name, data in [('stdout.log', error.stdout), ('stderr.log', error.stderr)]:
            (directory / name).write_bytes(data if isinstance(data, bytes) else (data or '').encode())
        row['failure'] = 'Native process timed out'
    except Exception as error:
        row['failure'] = str(error)
    save(directory / 'observation.json', row)
    return row


def main():
    OUT.mkdir(parents=True, exist_ok=False)
    report = {'schema': 1, 'sourceRevision': os.environ.get('GITHUB_SHA'),
              'candidateBase': BASE,
              'stackRevision': PIN, 'evidenceComplete': False, 'parityPassed': False,
              'acceptance': False,
              'scope': 'Temporary diagnostic only. Native execution of complete translated Lisp; no Wasm FAS, browser, reset or performance acceptance.',
              'isolation': 'A separate fresh native process and home for every arm/case; no warning history reset or runtime function replacement.',
              'observations': []}
    try:
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        changes = subprocess.check_output(['git', 'diff', '--name-status', BASE, head], cwd=ROOT, text=True).splitlines()
        assert {tuple(line.split('\t')) for line in changes} == {('A', path) for path in DIAGNOSTIC_PATHS}, changes
        subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--'], cwd=ROOT, check=True, capture_output=True)
        assert not os.environ.get('GITHUB_SHA') or os.environ['GITHUB_SHA'] == head
        report['sourceRevision'] = head
        report['candidateBinding'] = {'base': BASE, 'head': head, 'changes': changes,
                                      'onlyTwoDiagnosticAdditions': True}
        spec = importlib.util.spec_from_file_location('native_reference', ROOT / 'scripts/milestone-three/native-reference.py')
        reference = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reference)
        assert reference.STACK_SHA == PIN
        assert subprocess.check_output(['git', '-C', str(STACK), 'rev-parse', 'HEAD'], text=True).strip() == PIN
        originals = reference.checked_stack_files(STACK)
        assert len(originals) == 77
        original_inventory = [{**row, 'bytes': (STACK / row['path']).stat().st_size} for row in originals]
        expected_version = re.search(r'stackmaximaversion:(\d+)', (STACK / 'stack/maxima/stackmaxima.mac').read_text())[1]
        assert (BUILD / 'logs/native-entry-status.txt').read_text().strip() == 'CTM-NATIVE-ENTRY-TRANSLATION-OK'
        assert (BUILD / 'source-initialized/stackmaxima.mac').read_bytes() == (STACK / 'stack/maxima/stackmaxima.mac').read_bytes()
        inputs = OUT / 'inputs'
        inputs.mkdir()
        for name, path in {
            'stackmaxima.lisp': BUILD / 'source-initialized/stackmaxima.lisp',
            'display2d-bridge.lisp': BUILD / 'source-initialized/display2d-bridge.lisp',
            'assignment-adapter.lisp': BUILD / 'assignment-adapter.lisp',
            'parser-declarations.mac': BUILD / 'source-initialized/parser-declarations.mac',
            'parser-declarations.json': BUILD / 'source-initialized/parser-declarations.json',
        }.items():
            shutil.copyfile(path, inputs / name)
        for name in ('display2d-bridge.lisp', 'assignment-adapter.lisp'):
            assert (inputs / name).read_bytes() == (ROOT / 'runtime/precompiled' / name).read_bytes()
        helper = inputs / 'observe-state.lisp'
        helper.write_text(STATE_LISP)
        report['inputs'] = [record(p) for p in sorted(inputs.iterdir())]
        report['originalStackFiles'] = original_inventory
        report['driverSource'] = record(Path(__file__).resolve())
        report['startupReference'] = record(ROOT / 'scripts/milestone-three/native-reference.py')
        ecl = MAXIMA / 'wasm/ecl-host/bin/ecl'
        report['executables'] = [record(NATIVE), record(ecl)]
        env = {**os.environ, 'ECL_SRCDIR': str(ROOT / '.cache/runtime-build/sources/ecl'),
               'ECL_TO_RUN': str(ecl), 'MAXIMA_PREFIX': str(MAXIMA / 'wasm/maxima-ecl-combined'), 'LC_ALL': 'C'}
        report['runtimeEnvironment'] = {key: env[key] for key in ('ECL_SRCDIR', 'ECL_TO_RUN', 'MAXIMA_PREFIX', 'LC_ALL')}
        report['arms'] = {}
        for arm in ('source', 'compiled'):
            tree = OUT / 'trees' / arm
            for row in originals:
                target = tree / row['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(STACK / row['path'], target)
            (tree / 'tmp').mkdir()
            overlay = None
            if arm == 'compiled':
                loader = tree / LOADER
                body = loader.read_text()
                assert body.count(OLD_LOAD) == 1
                replacement = ('load(' + literal(str(inputs / 'display2d-bridge.lisp')) + ')$\n'
                               + 'load(' + literal(str(inputs / 'stackmaxima.lisp')) + ')$')
                loader.write_text(body.replace(OLD_LOAD, replacement))
                overlay = {'path': LOADER, 'original': record(STACK / LOADER),
                           'derived': record(loader), 'old': OLD_LOAD, 'new': replacement,
                           'scope': 'One loader statement replaced: reviewed assignment bridge, then complete translated entry; all dependencies retain source loading.'}
            inventory = []
            for row in originals:
                target = tree / row['path']
                current = record(target)
                if arm == 'source' or row['path'] != LOADER:
                    assert current['sha256'] == row['sha256']
                inventory.append({**current, 'path': row['path']})
            report['arms'][arm] = {'files': inventory, 'loaderOverlay': overlay}
            for case in CASES:
                row = run_case(reference, arm, tree, case, env, expected_version, helper)
                report['observations'].append(row)
                save(OUT / 'report.json', report)
            for row in inventory:
                assert record(tree / row['path'])['sha256'] == row['sha256']
            report['arms'][arm]['originalInventoryUnchangedAfter'] = True
        assert reference.checked_stack_files(STACK) == originals
        for row in report['inputs']:
            assert record(Path(row['path'])) == row
        report['originalCheckoutUnchangedAfter'] = True
        assert len(report['observations']) == 12 == 2 * len(CASES)
        report['comparisons'] = []
        for case in CASES:
            rows = [r for r in report['observations'] if r['case']['id'] == case['id']]
            left, right = rows
            complete = all(r['evidenceComplete'] for r in rows)
            equal = complete and all(left['observation'][key] == right['observation'][key]
                                     for key in ('evaluationSucceeded', 'result', 'errors'))
            capture_equal = complete and left['capturedStdout'] == right['capturedStdout']
            fresh = complete and all(r['freshNounorBeforeProbe'] for r in rows)
            succeeded = complete and all(r['observation']['evaluationSucceeded'] for r in rows)
            report['comparisons'].append({'case': case['id'], 'evidenceComplete': complete,
                                          'resultEqual': equal, 'capturedStdoutEqual': capture_equal,
                                          'freshNounorBeforeBothProbes': fresh,
                                          'parityPassed': bool(equal and capture_equal and fresh and succeeded)})
        report['evidenceComplete'] = all(r['evidenceComplete'] for r in report['observations'])
        report['parityPassed'] = report['evidenceComplete'] and all(r['parityPassed'] for r in report['comparisons'])
    except Exception as error:
        report['failure'] = str(error)
    report['files'] = [record(p) for p in sorted(OUT.rglob('*')) if p.is_file() and p.name != 'report.json']
    save(OUT / 'report.json', report)
    print(json.dumps({k: report.get(k) for k in ('evidenceComplete', 'parityPassed', 'acceptance', 'failure')}), flush=True)
    # An unequal observation is successful evidence collection, never acceptance.
    # Missing startup/protocol/capture evidence is an actual diagnostic job failure.
    return 0 if report['evidenceComplete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
