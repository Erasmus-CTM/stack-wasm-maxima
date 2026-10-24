#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Require fresh full-library source/translated-entry parity in native Maxima.

Build inputs are local outputs of the unchanged pinned native workflow. Each
probe uses a fresh process and complete STACK startup. No warning is cleared,
filtered or disabled, and no operator/function is replaced for observation.
"""
from __future__ import annotations

import argparse
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
WORKDIRS = {
    '33383047af39c204bf4442802a058f8b918b2b1b': '.cache/precompiled-stack',
    '10d323311b7f39fb7b092dd10ce75f7d8632f525': '.cache/precompiled-stack-10d3233',
}
MAXIMA = ROOT / '.cache/runtime-build/sources/maxima'
NATIVE = MAXIMA / 'wasm/maxima-ecl-combined/bin/maxima'
PROTOCOL_CASE = 'first-call-logical-validation'
REPOSITORY_INPUTS = (
    'runtime/precompiled/full-entry-check.py',
    'scripts/milestone-three/native-reference.py',
    'runtime/precompiled/assignment-adapter.lisp',
    'runtime/precompiled/display2d-bridge.lisp',
    'runtime/precompiled/parser_bootstrap.py',
    'runtime/precompiled/translate-and-cross-compile.sh',
    'runtime/precompiled/native-fixtures.sh',
    'runtime/precompiled/restart-checks.json',
    'runtime/build/pins.json',
    '.github/workflows/precompiled-fixtures.yml',
    '.github/workflows/precompiled-stack.yml',
)
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
    elif case['kind'] == 'protocol':
        setup = []
        # Evaluate the exact reviewed browser expression, without substituting
        # its locals, capture path or result schema. Retain outer stdout too.
        work = ['with_stdout(' + path + ',_ctm_v:(' + case['expression'] + '))']
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
    elif case['kind'] == 'protocol':
        value = '_ctm_v'
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


def run_case(reference, output, arm, tree, case, env, expected_version, helper):
    directory = output / 'processes' / arm / case['id']
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
            if case['kind'] != 'protocol' and not isinstance(value, dict):
                raise ValueError('Malformed probe result')
            if case['kind'] == 'validation':
                if (set(value) != {'valid', 'feedback', 'latex', 'source'} or type(value['valid']) is not bool
                        or not all(isinstance(value[k], str) for k in ('feedback', 'latex', 'source'))):
                    raise ValueError('Malformed validation fields')
            elif case['kind'] == 'direct' and (set(value) != {'value', 'capturedLines'} or not isinstance(value['value'], str)
                  or not isinstance(value['capturedLines'], list)
                  or not all(isinstance(line, str) for line in value['capturedLines'])):
                raise ValueError('Malformed direct result fields')
        before, after = observation['before']['nounor'], observation['after']['nounor']
        for phase in ('before', 'after'):
            target = observation[phase]['target']
            if arm == 'compiled':
                if not target['fbound']:
                    raise ValueError('Translated entry target lost its Lisp function binding')
            elif target['fbound'] or not target['mexpr']:
                raise ValueError('Source entry target is not interpreted')
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


def require(condition, message):
    if not condition:
        raise ValueError(message)


def strict_equal(left, right):
    """Exact JSON comparison, including Boolean versus numeric types."""
    return (json.dumps(left, sort_keys=True, allow_nan=False)
            == json.dumps(right, sort_keys=True, allow_nan=False))


def expected_result(case, row):
    if not row.get('evidenceComplete'):
        return False
    observation = row['observation']
    if not observation['evaluationSucceeded'] or observation['errors'] != '["stack_map"]':
        return False
    value = observation['result']
    if case['kind'] == 'protocol':
        return row['capturedStdout'] == '' and strict_equal(value, case['expected'])
    if case['id'] == 'validate-neq-inequality':
        # This is an ordinary invalid input, not a warning to suppress. Preserve
        # its exact source feedback, including the final space and newline.
        feedback = "stack_trans('ATAlgEquiv_SA_not_inequality'); !NEWLINE! "
        return (row['capturedStdout'] == feedback + '\n'
                and strict_equal(value, {'valid': False, 'feedback': feedback, 'latex': '', 'source': ''}))
    if row['capturedStdout'] != '':
        return False
    if case['kind'] == 'validation':
        return (value['valid'] is True and value['feedback'] == ''
                and bool(value['latex']) and bool(value['source']))
    expected = {'direct-remove': 'x < 0 nounor x > 0',
                'direct-solver': 'realset(x,%union(oo(0,inf),oo(-inf,0)))'}
    return strict_equal(value, {'value': expected[case['id']], 'capturedLines': []})


def compare_cases(cases, observations):
    require(len(observations) == 2 * len(cases), 'Missing fresh-process observations')
    comparisons = []
    for case in cases:
        rows = [row for row in observations if row['case']['id'] == case['id']]
        require(len(rows) == 2 and {row['arm'] for row in rows} == {'source', 'compiled'},
                'Missing or duplicate arm for ' + case['id'])
        left, right = rows
        complete = all(row['evidenceComplete'] for row in rows)
        equal = complete and all(strict_equal(left['observation'][key], right['observation'][key])
                                 for key in ('evaluationSucceeded', 'result', 'errors'))
        capture_equal = complete and left['capturedStdout'] == right['capturedStdout']
        warning_free = complete and all(
            not row['observation'][phase]['nounor'][key]
            for row in rows for phase in ('before', 'after')
            for key in ('warned', 'undefinedWarned', 'puntNilWarned'))
        expected = all(expected_result(case, row) for row in rows)
        comparisons.append({'case': case['id'], 'evidenceComplete': complete,
                            'resultEqual': equal, 'capturedStdoutEqual': capture_equal,
                            'noNounorWarningBeforeOrAfter': warning_free,
                            'expectedResultsBothArms': expected,
                            'parityPassed': bool(equal and capture_equal and warning_free and expected)})
    return comparisons


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pin', required=True, choices=WORKDIRS)
    parser.add_argument('--workdir', type=Path, help='Existing translation outputs and upstream-stack checkout')
    args = parser.parse_args()
    pin = args.pin
    build = (args.workdir or ROOT / WORKDIRS[pin]).resolve()
    stack = build / 'upstream-stack'
    output = ROOT / '.cache/precompiled-fixtures' / ('full-entry-' + pin)
    output.mkdir(parents=True, exist_ok=False)
    report = {'schema': 1, 'sourceRevision': os.environ.get('GITHUB_SHA'),
              'stackRevision': pin, 'evidenceComplete': False, 'parityPassed': False,
              'acceptance': False,
              'scope': 'Fresh native full-library source versus translated-entry Lisp execution. No Wasm FAS, browser, raw reset or performance acceptance.',
              'isolation': 'A separate fresh native process and home for every arm/case; no warning history reset or runtime function replacement.',
              'observations': []}
    try:
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        require(not os.environ.get('GITHUB_SHA') or os.environ['GITHUB_SHA'] == head,
                'CI revision differs from checked-out HEAD')
        report['sourceRevision'] = head
        report['sourceTree'] = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT, text=True).strip()
        inputs = output / 'inputs'
        inputs.mkdir()
        repository_inputs = []
        for name in REPOSITORY_INPUTS:
            path = ROOT / name
            original = subprocess.check_output(['git', 'show', head + ':' + name], cwd=ROOT)
            require(path.read_bytes() == original, 'Repository input differs from current Git bytes: ' + name)
            target = inputs / 'repository' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(original)
            repository_inputs.append(record(path))
        report['repositoryInputs'] = repository_inputs
        spec = importlib.util.spec_from_file_location('native_reference', ROOT / 'scripts/milestone-three/native-reference.py')
        reference = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reference)
        # checked_stack_files uses this explicit revision for every git blob.
        # The startup generator itself is unchanged for both supported pins.
        reference.STACK_SHA = pin
        require(subprocess.check_output(['git', '-C', str(stack), 'rev-parse', 'HEAD'], text=True).strip() == pin,
                'Wrong STACK checkout revision')
        originals = reference.checked_stack_files(stack)
        original_inventory = [{**row, 'bytes': (stack / row['path']).stat().st_size} for row in originals]
        entry = stack / 'stack/maxima/stackmaxima.mac'
        expected_version = re.search(r'stackmaximaversion:(\d+)', entry.read_text())[1]
        initialized = build / 'source-initialized'
        require((initialized / 'stackmaxima.mac').read_bytes() == entry.read_bytes(), 'Translated input is not the pinned entry')
        require((initialized / 'stackmaxima.LISP').read_bytes() == (initialized / 'stackmaxima.lisp').read_bytes(),
                'Translated entry aliases differ')
        translation_log = build / 'logs/translate-initialized.log'
        require(re.findall(r'^CTM-TRANSLATION-OK\|(\d+)$', translation_log.read_text(), re.M) == ['232'],
                'Missing complete readable entry translation')
        generated_paths = [initialized / name for name in (
            'stackmaxima.mac', 'stackmaxima.LISP', 'stackmaxima.lisp', 'display2d-bridge.lisp',
            'parser-declarations.mac', 'parser-declarations.json')] + [build / 'assignment-adapter.lisp']
        manifest = build / 'logs/initialized-source.sha256'
        hashes = {}
        for line in manifest.read_text().splitlines():
            match = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
            require(match is not None and match[2] not in hashes, 'Malformed or duplicate initialized input hash')
            hashes[match[2]] = match[1]
        require(set(hashes) == {str(path) for path in generated_paths}, 'Unexpected initialized input inventory')
        for path in generated_paths:
            require(record(path)['sha256'] == hashes[str(path)], 'Initialized input hash mismatch: ' + str(path))
        generated_paths += [manifest, translation_log, build / 'initialized-translate-driver.lisp',
                            initialized / ('ctm-stackmaxima-' + pin[:7] + '.asd')]
        for path in generated_paths:
            target = inputs / 'translation' / path.relative_to(build)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        for name in ('display2d-bridge.lisp', 'assignment-adapter.lisp'):
            path = initialized / name if name == 'display2d-bridge.lisp' else build / name
            require(path.read_bytes() == (ROOT / 'runtime/precompiled' / name).read_bytes(),
                    'Translation used a different reviewed adapter: ' + name)
        bootstrap_spec = importlib.util.spec_from_file_location('parser_bootstrap', ROOT / 'runtime/precompiled/parser_bootstrap.py')
        bootstrap = importlib.util.module_from_spec(bootstrap_spec)
        bootstrap_spec.loader.exec_module(bootstrap)
        declarations, start = bootstrap.extract((stack / bootstrap.SOURCE).read_bytes(), pin)
        require((initialized / 'parser-declarations.mac').read_bytes() == declarations, 'Wrong translation parser bootstrap')
        metadata = reference.load_json((initialized / 'parser-declarations.json').read_text())
        require(metadata['stackRevision'] == pin and metadata['source']['start'] == start
                and metadata['source']['end'] == start + len(declarations)
                and metadata['source']['sha256'] == bootstrap.PINNED_SOURCES[pin]
                and metadata['file']['sha256'] == hashlib.sha256(declarations).hexdigest(),
                'Wrong parser bootstrap provenance')
        protocol = reference.load_json((ROOT / 'runtime/precompiled/restart-checks.json').read_text())
        require(protocol['checks'][0]['name'] == PROTOCOL_CASE
                and sum(check['name'] == PROTOCOL_CASE for check in protocol['checks']) == 1,
                'Logical validation must be the first browser protocol case')
        check = protocol['checks'][0]
        require(isinstance(check['expression'], str) and check['expression'] and 'expected' in check,
                'Missing exact browser protocol expression or expected result')
        cases = [*CASES, {'id': PROTOCOL_CASE, 'kind': 'protocol',
                         'expression': check['expression'], 'expected': check['expected']}]
        require(len(cases) == 7 and len({case['id'] for case in cases}) == 7, 'Incomplete fresh-case inventory')
        report['cases'] = cases
        helper = inputs / 'observe-state.lisp'
        helper.write_text(STATE_LISP)
        report['inputs'] = [record(path) for path in sorted(inputs.rglob('*')) if path.is_file()]
        report['translationInputs'] = [record(path) for path in generated_paths]
        report['originalStackFiles'] = original_inventory
        report['originalStackFileCount'] = len(originals)
        ecl = MAXIMA / 'wasm/ecl-host/bin/ecl'
        report['executables'] = [record(NATIVE), record(ecl)]
        env = {**os.environ, 'ECL_SRCDIR': str(ROOT / '.cache/runtime-build/sources/ecl'),
               'ECL_TO_RUN': str(ecl), 'MAXIMA_PREFIX': str(MAXIMA / 'wasm/maxima-ecl-combined'), 'LC_ALL': 'C'}
        report['runtimeEnvironment'] = {key: env[key] for key in ('ECL_SRCDIR', 'ECL_TO_RUN', 'MAXIMA_PREFIX', 'LC_ALL')}
        report['arms'] = {}
        for arm in ('source', 'compiled'):
            tree = output / 'trees' / arm
            for row in originals:
                target = tree / row['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(stack / row['path'], target)
            (tree / 'tmp').mkdir()
            overlay = None
            if arm == 'compiled':
                loader = tree / LOADER
                body = loader.read_text()
                require(body.count(OLD_LOAD) == 1, 'Expected exactly one original entry load')
                replacement = ('load(' + literal(str(inputs / 'translation/source-initialized/display2d-bridge.lisp')) + ')$\n'
                               + 'load(' + literal(str(inputs / 'translation/source-initialized/stackmaxima.lisp')) + ')$')
                loader.write_text(body.replace(OLD_LOAD, replacement))
                overlay = {'path': LOADER, 'original': record(stack / LOADER),
                           'derived': record(loader), 'old': OLD_LOAD, 'new': replacement,
                           'scope': 'One loader statement replaced: reviewed assignment bridge, then complete translated entry; all dependencies retain source loading.'}
            inventory = []
            for row in originals:
                current = record(tree / row['path'])
                if arm == 'source' or row['path'] != LOADER:
                    require(current['sha256'] == row['sha256'], 'Unexpected source overlay')
                inventory.append({**current, 'path': row['path']})
            report['arms'][arm] = {'files': inventory, 'loaderOverlay': overlay}
            for case in cases:
                row = run_case(reference, output, arm, tree, case, env, expected_version, helper)
                report['observations'].append(row)
                save(output / 'report.json', report)
            for row in inventory:
                require(record(tree / row['path'])['sha256'] == row['sha256'], 'Arm source changed during execution')
            report['arms'][arm]['originalInventoryUnchangedAfter'] = True
        require(reference.checked_stack_files(stack) == originals, 'Original STACK checkout changed')
        for row in [*report['inputs'], *report['repositoryInputs'], *report['translationInputs'], *report['executables']]:
            require(record(Path(row['path'])) == row, 'Input changed during execution: ' + row['path'])
        report['originalCheckoutUnchangedAfter'] = True
        report['allInputsUnchangedAfter'] = True
        report['comparisons'] = compare_cases(cases, report['observations'])
        report['evidenceComplete'] = all(row['evidenceComplete'] for row in report['observations'])
        report['parityPassed'] = report['evidenceComplete'] and all(row['parityPassed'] for row in report['comparisons'])
        report['acceptance'] = report['parityPassed']
    except Exception as error:
        report['failure'] = str(error)
    report['files'] = [record(path) for path in sorted(output.rglob('*')) if path.is_file() and path.name != 'report.json']
    save(output / 'report.json', report)
    print(json.dumps({key: report.get(key) for key in ('stackRevision', 'evidenceComplete', 'parityPassed', 'acceptance', 'failure')}), flush=True)
    return 0 if report['acceptance'] is True else 1


if __name__ == '__main__':
    raise SystemExit(main())
