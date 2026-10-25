#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Require executed compiler/link/spill evidence for the explicit Maxima-Oz FAS."""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'runtime/build'))
from compiler_profile import compiler_profile
from compiler_evidence import (commands, config_assignments, c_compiles, digest,
                               gc_passes, link_evidence, relevant_compiles, same_source,
                               verify_packaged, LINK_FIELDS)
from bundle_provenance import record
from parser_bootstrap import PINNED_SOURCES

NAME = 'ecl-oz-maxima-oz'
PROOF = 'stack-compiler-evidence.json'


def successful_tools(body):
    """Each recognized successful exec must also finish with exit_group(0).

    Reuse the strict argv parser; add only PID/exit binding here. Printed
    commands cannot satisfy this check, and incomplete traces fail closed.
    """
    commands(body)  # Includes strict unfinished/resumed and argv checks.
    pending, executed, exits = {}, {}, {}
    for line in body.decode().splitlines():
        match = re.fullmatch(r'(\d+)\s+(.*)', line.strip())
        if not match:
            continue
        pid, value = match.groups()
        if value.startswith('execve(') and value.endswith(' <unfinished ...>'):
            assert pid not in pending
            pending[pid] = value.removesuffix(' <unfinished ...>')
            continue
        if value.startswith('<... execve resumed>'):
            assert pid in pending
            value = pending.pop(pid) + value.removeprefix('<... execve resumed>')
        rows = commands((pid + ' ' + value + '\n').encode())
        for row in rows:
            assert row['executed'], 'Printed command masquerades as a process'
            executed.setdefault(pid, []).append(row['command'])
        ending = re.fullmatch(r'exit_group\((\d+)\)\s+= \?', value)
        if ending:
            assert pid not in exits, 'Duplicate process exit'
            exits[pid] = int(ending[1])
    assert not pending and executed, 'Missing complete successful tool executions'
    assert all(exits.get(pid) == 0 for pid in executed), 'Compiler/link/spill process did not exit successfully'
    return [{'pid': pid, 'exitCode': exits[pid], 'commands': executed[pid]}
            for pid in sorted(executed, key=int)]


def derive(config, target, printed, execution, profile, pin):
    assert pin in PINNED_SOURCES and profile == compiler_profile(NAME)
    assert target, 'Missing unchanged target-info'
    assignments = config_assignments(config.decode(), LINK_FIELDS | {'CC', 'CFLAGS'})
    cc = assignments['CC']
    assert cc.endswith('/sources/emsdk/upstream/emscripten/emcc')
    build = cc.removesuffix('/sources/emsdk/upstream/emscripten/emcc')
    cache = str(PurePosixPath(build).parent)
    work = cache + ('/precompiled-stack' if pin.startswith('3338304') else '/precompiled-stack-10d3233')
    generated = work + '/source-initialized/wasm32-emscripten/'
    system = 'ctm-stackmaxima-' + pin[:7]
    delivered = generated + system + '.fasb'
    rows = commands(printed) + commands(execution)
    assert not any(r['executed'] for r in commands(printed)), 'Execution log must be independently retained'
    assert all(r['executed'] for r in commands(execution)), 'Execution trace contains printed tool claims'
    process_exits = successful_tools(execution)
    observed, excluded = relevant_compiles(rows, cc.removesuffix('/emcc'))
    actual = [row for row in observed if row['executed']]
    assert actual and all(row['optimization'] == profile['stackGeneratedOptimization'] for row in observed), 'Wrong/missing STACK optimization'
    expected = {generated + 'stackmaxima.c', generated + 'display2d-bridge.c'}
    assert expected <= {r['input'] for r in actual}, 'Missing executed translated STACK or assignment bridge'
    assert any(re.fullmatch(r'/tmp/eclinit[^/]+\.c', row['input']) for row in actual), 'Missing executed bundle initializer'
    assert all(row['input'] in expected or re.fullmatch(r'/tmp/eclinit[^/]+\.c', row['input']) for row in actual), 'Unexpected target compilation in STACK phase'
    raw = list(c_compiles(rows, ['emcc', 'em++']))
    for row in observed:
        assert any(r['executed'] and same_source(r['input'], row['input']) and same_source(r['output'], row['output']) for r in raw), 'Missing executed compiler driver'
        assert any(same_source(r['input'], row['input']) and same_source(r['output'], row['output']) for r in actual), 'Printed clang has no successful execution'
    links = link_evidence([r for r in rows if r['executed']], build + '/sources/maxima/wasm', [delivered], gc_passes(profile))
    outputs = {row['wasmOutput'] for row in links['targetLinks']}
    # The final bundle cannot stand in for either intermediate. Require both
    # distinct source-specific temporary outputs in this exact target directory.
    for stem in ['display2d-bridge', 'stackmaxima']:
        pattern = re.escape(generated + stem) + r'-tmp[A-Za-z0-9]+\.fas'
        assert any(re.fullmatch(pattern, output) for output in outputs), 'Missing required intermediate STACK target link: ' + stem
    return {'configSha256': digest(config), 'targetInfoSha256': digest(target),
            'printedTrace': record(printed), 'executionTrace': record(execution),
            'generatedCompiles': observed, 'excludedNonTargetCompiles': excluded,
            'successfulToolProcesses': process_exits, 'links': links,
            'deliveredOutput': delivered}


def describe(work, runtime_logs, pin):
    profile = compiler_profile(NAME)
    runtime = json.loads((runtime_logs / 'compiler-experiment.json').read_bytes())
    environment = json.loads((runtime_logs / 'environment.json').read_bytes())
    assert runtime['passed'] is True and runtime['profile'] == profile
    assert environment['compilerProfile'] == profile
    descriptor = json.loads((work / 'stackmaxima.fas.json').read_bytes())
    assert descriptor['stackRevision'] == pin
    binary = (work / 'stackmaxima.fas').read_bytes()
    assert descriptor['bundle'] == {'path': 'stackmaxima.fas', **record(binary)}
    observed = derive((runtime_logs / 'ecl-config.log').read_bytes(),
                      (runtime_logs / 'target-info.lsp').read_bytes(),
                      (work / 'logs/cross-compile.log').read_bytes(),
                      (work / 'logs/cross-compile-exec.log').read_bytes(), profile, pin)
    generated = work / 'source-initialized/wasm32-emscripten'
    assert (generated / ('ctm-stackmaxima-' + pin[:7] + '.fasb')).read_bytes() == binary
    inputs = ['stackmaxima.fas', 'stackmaxima.fas.json', 'assignment-adapter.lisp',
              'source-initialized/stackmaxima.mac', 'source-initialized/stackmaxima.lisp',
              'source-initialized/display2d-bridge.lisp', 'source-initialized/parser-declarations.mac',
              'source-initialized/parser-declarations.json',
              'source-initialized/ctm-stackmaxima-' + pin[:7] + '.asd',
              'source-initialized/wasm32-emscripten/stackmaxima.c',
              'source-initialized/wasm32-emscripten/display2d-bridge.c']
    for key, path in [('translatedLisp', inputs[4]), ('assignmentBridge', inputs[5]),
                      ('parserDeclarations', inputs[6]), ('parserMetadata', inputs[7])]:
        assert descriptor[key] == record((work / path).read_bytes())
    assert descriptor['entry']['sha256'] == digest((work / inputs[3]).read_bytes())
    assert descriptor['processAdapter'] == {'path': 'assignment-adapter.lisp', **record((work / inputs[2]).read_bytes())}
    return {'schema': 1, 'passed': True, 'profile': profile, 'stackRevision': pin,
            'buildIdentity': environment['buildIdentity'],
            'runtimeCompilerEvidence': record((runtime_logs / 'compiler-experiment.json').read_bytes()),
            'inputs': {path: record((work / path).read_bytes()) for path in inputs},
            'observed': observed,
            'scope': 'Successful compiler driver, clang and spill-pass process exits with exact translated inputs and FAS bytes. Unchanged configure/target-info and runtime compilation are checked separately by the packaged runtime verifier. No timing or semantic conclusion.'}


def verify(work, artifact, pin):
    profile = compiler_profile(NAME)
    verify_packaged(artifact, profile)
    manifest = json.loads((artifact / 'manifest.json').read_bytes())
    assert manifest['compilerProfile'] == profile
    proof = json.loads((work / 'logs' / PROOF).read_bytes())
    assert proof == describe(work, artifact / 'logs', pin), 'STACK proof differs from raw inputs/traces'
    return {'schema': 1, 'passed': True, 'stackRevision': pin, 'compilerProfile': profile,
            'runtimeManifest': record((artifact / 'manifest.json').read_bytes()),
            'stackCompilerEvidence': record((work / 'logs' / PROOF).read_bytes()),
            'bundle': record((work / 'stackmaxima.fas').read_bytes())}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--pin', choices=PINNED_SOURCES, required=True)
    parser.add_argument('--runtime-artifact', type=Path)
    args = parser.parse_args()
    if args.runtime_artifact:
        proof = verify(args.work, args.runtime_artifact, args.pin)
        output = args.work / 'logs/stack-compiler-package-binding.json'
    else:
        assert compiler_profile() == compiler_profile(NAME), 'Explicit candidate selection required'
        proof = describe(args.work, ROOT / '.cache/runtime-build/logs', args.pin)
        output = args.work / 'logs' / PROOF
    with output.open('x') as stream:
        stream.write(json.dumps(proof, indent=2) + '\n')
    print(json.dumps({'passed': True, 'pin': args.pin, 'output': str(output)}))
