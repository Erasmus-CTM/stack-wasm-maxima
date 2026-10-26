#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Build spill-gap.c against one collector with one Emscripten SDK; check outcomes."""
import argparse
import json
from pathlib import Path
import shlex
import subprocess

HERE = Path(__file__).resolve().parent
PASSES = {'none': None, 'spill': '--spill-pointers', 'flatten-spill': '--flatten,--spill-pointers'}


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
    parser.add_argument('--gc', type=Path, required=True, help='bdwgc source root containing extra/gc.c')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--rounds', type=int, default=2000)
    args = parser.parse_args()
    env = sdk_environment(args.emsdk)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {'schema': 1, 'emcc': run(['emcc', '--version'], env, args.output)['stdout'].splitlines()[0],
              'wasmOpt': run([str(args.emsdk / 'upstream/bin/wasm-opt'), '--version'], env, args.output)['stdout'].strip(),
              'gc': str(args.gc), 'rounds': args.rounds, 'cases': [], 'failures': []}
    for names in ('names', 'stripped'):
        for opt in ('-O0', '-O2', '-Oz'):
            for kind, passes in PASSES.items():
                if names == 'stripped' and kind != 'spill':
                    continue
                name = f'{opt[1:]}-{kind}-{names}'
                argv = ['emcc', opt, '-I', str(args.gc / 'include'), str(HERE / 'spill-gap.c'), str(args.gc / 'extra/gc.c'),
                        '-sSTACK_SIZE=33554432', '-sALLOW_MEMORY_GROWTH', '-o', name + '.js']
                if names == 'names':
                    # Binaryen 133 cannot find the stack pointer for --spill-pointers in a stripped module.
                    argv.insert(2, '--profiling-funcs')
                if passes:
                    argv.append('-sBINARYEN_EXTRA_PASSES=' + passes)
                case = {'name': name, 'optimization': opt, 'passes': kind, 'names': names, 'build': run(argv, env, args.output)}
                if case['build']['exitCode'] == 0:
                    case['run'] = run(['node', name + '.js', str(args.rounds)], env, args.output)
                    case['result'] = json.loads(case['run']['stdout'].strip().splitlines()[-1])
                report['cases'].append(case)
                summary = case.get('result', {'build': 'failed: ' + (case['build']['stderr'].strip().splitlines() or [''])[0][:160]})
                print(name, json.dumps(summary), flush=True)
    by = {case['name']: case for case in report['cases']}
    def lost(name):
        return by[name].get('result', {}).get('lost')
    expectations = [(f'{opt}-flatten-spill-names', lambda value: value == 0, 'flattening before spilling keeps every object')
                    for opt in ('O0', 'O2', 'Oz')]
    expectations += [('O0-spill-names', lambda value: value == 0, 'unoptimized code keeps pointers in linear memory'),
                     ('O2-spill-names', lambda value: value and value > 0, 'negative control: optimized plain spilling loses objects'),
                     ('Oz-spill-names', lambda value: value and value > 0, 'negative control: optimized plain spilling loses objects')]
    # 'none' and 'stripped' cases are recorded only: unexplained retention without
    # any spill pass, and SDK-dependent build failure without a name section.
    for name, check, meaning in expectations:
        if not check(lost(name)):
            report['failures'].append({'case': name, 'lost': lost(name), 'expected': meaning})
    report['passed'] = not report['failures']
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    # Evidence: main() of the optimized plain-spill build, where make()'s result
    # is moved to a temporary local that is never stored to the shadow stack.
    dis = run([str(args.emsdk / 'upstream/bin/wasm-dis'), 'O2-spill-names.wasm', '-o', 'O2-spill-names.wat'], env, args.output)
    print(json.dumps({'passed': report['passed'], 'failures': report['failures'], 'disassembly': dis['exitCode'] == 0}))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
