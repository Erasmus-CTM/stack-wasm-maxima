#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Link embed-gap.c against an installed Emscripten ECL (libecl.a); check outcomes."""
import argparse
import json
from pathlib import Path
import shlex
import subprocess

HERE = Path(__file__).resolve().parent
# ECL's own wasm32 link flags (src/aclocal.m4), and the same list with --flatten first.
PASSES = {'ecl': '--spill-pointers,--strip-debug', 'flatten': '--flatten,--spill-pointers,--strip-debug'}


def sdk_environment(emsdk):
    out = subprocess.run(['bash', '-c', f'source {shlex.quote(str(emsdk))}/emsdk_env.sh >/dev/null 2>&1 && env -0'],
                         check=True, capture_output=True).stdout
    return dict(line.split('=', 1) for line in out.decode().split('\0') if '=' in line)


def run(argv, env, cwd):
    process = subprocess.run(argv, env=env, cwd=cwd, capture_output=True, text=True)
    return {'argv': argv, 'exitCode': process.returncode, 'stdout': process.stdout[-4000:], 'stderr': process.stderr[-4000:]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--emsdk', type=Path, required=True)
    parser.add_argument('--ecl', type=Path, required=True, help='ECL install prefix built for wasm32 with --disable-shared')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--rounds', type=int, default=2000)
    args = parser.parse_args()
    env = sdk_environment(args.emsdk)
    args.output.mkdir(parents=True, exist_ok=False)
    # The cross configuration installs libraries and headers at the prefix root.
    roots = [args.ecl, args.ecl / 'lib', args.ecl / 'include']
    include = next(root for root in roots if (root / 'ecl/ecl.h').is_file())
    libraries = []
    for name in ('libecl.a', 'libeclgc.a', 'libeclgmp.a'):
        found = [root / name for root in roots if (root / name).is_file()]
        assert found, 'Missing ' + name + '; build ECL with --disable-shared'
        libraries.append(str(found[0]))
    report = {'schema': 1, 'emcc': run(['emcc', '--version'], env, args.output)['stdout'].splitlines()[0],
              'ecl': str(args.ecl), 'libraries': libraries, 'rounds': args.rounds, 'cases': [], 'failures': []}
    for opt in ('-O0', '-O2', '-Oz'):
        for kind, passes in PASSES.items():
            name = f'{opt[1:]}-{kind}'
            argv = ['emcc', opt, str(HERE / 'embed-gap.c'), '-I', str(include), *libraries,
                    '-sSTACK_SIZE=33554432', '-sALLOW_MEMORY_GROWTH', '--profiling-funcs',
                    '-sBINARYEN_EXTRA_PASSES=' + passes, '-o', name + '.js']
            case = {'name': name, 'optimization': opt, 'passes': passes, 'build': run(argv, env, args.output)}
            if case['build']['exitCode'] == 0:
                case['run'] = run([env.get('EMSDK_NODE', 'node'), '--stack-size=65500', name + '.js', str(args.rounds)], env, args.output)
                lines = [line for line in case['run']['stdout'].splitlines() if line.startswith('{')]
                if lines:
                    case['result'] = json.loads(lines[-1])
            report['cases'].append(case)
            summary = case.get('result') or {'failed': (case.get('run') or case['build'])['stderr'].strip()[-300:]}
            print(name, json.dumps(summary), flush=True)
    by = {case['name']: case for case in report['cases']}
    def lost(name):
        return by[name].get('result', {}).get('lost')
    def field(name, key):
        return by[name].get('result', {}).get(key)
    rounds = args.rounds
    expectations = []
    for opt in ('O0', 'O2', 'Oz'):
        expectations += [
            (f'{opt}-flatten', 'freed', lambda value: value == 0, 'flattening before spilling keeps every cons'),
            (f'{opt}-flatten', 'spilledRounds', lambda value: value == rounds, 'the cons is spilled into main\'s frame'),
            (f'{opt}-flatten', 'staleRounds', lambda value: value == 0, 'no stale copy confounds the case')]
    for opt in ('O2', 'Oz'):
        expectations += [
            (f'{opt}-ecl', 'freed', lambda value: value == rounds, 'negative control: plain spilling frees the live cons'),
            (f'{opt}-ecl', 'spilledRounds', lambda value: value == 0, 'no spill of the waiting operand'),
            (f'{opt}-ecl', 'staleRounds', lambda value: value == 0, 'no stale copy confounds the case')]
    # Recorded only: -O0 plain spilling (toolchain-dependent code shape), 'lost'
    # (whether a freed block is reused within the round), and any other cases.
    for name, key, check, meaning in expectations:
        if not check(field(name, key)):
            report['failures'].append({'case': name, key: field(name, key), 'expected': meaning})
    report['passed'] = not report['failures']
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'failures': report['failures']}))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
