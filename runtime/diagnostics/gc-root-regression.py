#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Build and test the real pinned collector; never confer runtime acceptance."""
import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import resource
import signal
import stat
import subprocess
import sys
import time

ECL_PIN = 'e4bdb2e5b1e444e1773032a53650773848f4d6cd'
# All 321 bundled BDWGC files match the independently recovered, hash-verified
# source-state-before.json from source run40051138504/artifact12545214476.
# Canonical sorted path/bytes/SHA256 records bind the complete collector input.
SOURCE_FILES = 321
SOURCE_TREE_SHA256 = '650b27cc8162b6c6c17fb858aa4cc77e8ca144f6ab30944588fb185965f79daa'
FIXTURE = Path(__file__).with_suffix('.c')
# The fourth value controls the synthetic previous callback independently.
MODES = [('lazy', 'nearfull', 'atomic', 'eager'),
         ('eager', 'nearfull', 'atomic', 'eager'),
         ('lazy', 'ordinary', 'graph', 'eager'),
         ('eager', 'ordinary', 'graph', 'eager'),
         ('eager', 'nearfull', 'graph', 'eager'),
         ('lazy', 'ordinary', 'graph', 'lazy'),
         ('eager', 'ordinary', 'graph', 'lazy'),
         ('eager', 'nearfull', 'atomic', 'lazy')]


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def record(path):
    body = path.read_bytes()
    return {'bytes': len(body), 'sha256': sha(body)}


def source_records(source):
    rows = []
    for path in sorted(source.rglob('*')):
        require(not path.is_symlink(), 'Collector source contains a symlink')
        if path.is_dir():
            continue
        require(stat.S_ISREG(path.stat().st_mode), 'Collector source contains a special file')
        rows.append({'path': path.relative_to(source).as_posix(), **record(path)})
    identity = sha(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode())
    require(len(rows) == SOURCE_FILES and identity == SOURCE_TREE_SHA256,
            'Collector sources differ from the complete pinned tree')
    return rows


def execute(command, cwd, env, output, label, timeout):
    stdout, stderr = output / (label + '.stdout'), output / (label + '.stderr')
    started = time.monotonic()
    with stdout.open('wb') as out, stderr.open('wb') as err:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=out, stderr=err,
                                   start_new_session=True,
                                   preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_CORE, (0, 0)))
        timed_out = False
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait(timeout=10)
    return {'command': command, 'exitCode': code, 'timedOut': timed_out,
            'elapsedSeconds': time.monotonic() - started,
            'stdout': {'path': stdout.name, **record(stdout)},
            'stderr': {'path': stderr.name, **record(stderr)}}


def protocol(text, prefix):
    lines = [line for line in text.splitlines() if line.startswith(prefix + '|')]
    require(len(lines) == 1, 'Missing or duplicated ' + prefix)
    return dict(field.split('=', 1) for field in lines[0].split('|')[1:])


def check_case(result, output, args, bits):
    stdout = (output / result['stdout']['path']).read_text()
    stderr = (output / result['stderr']['path']).read_text()
    require(not result['timedOut'], 'Collector fixture exceeded its deadline')
    start = protocol(stdout, 'CTM-GC-ROOT-START')
    require(int(start['pointerBits']) == bits and int(start['incremental']) == int(args[3])
            and start['chain'] == args[4] and int(start['chainRanges']) == 3
            and start['previousCollectorCallback'] in ('0', '1'),
            'Actual pointer width, incremental mode or callback configuration differs')
    capacity = int(start['capacity'])
    recovery_case = args[:3] == ['eager', 'nearfull', 'graph']
    nearfull = re.findall(r'^CTM-GC-ROOT-NEARFULL\|used=(\d+)\|capacity=(\d+)$', stderr, re.M)
    recoveries = re.findall(r'^CTM-GC-ROOT-RECOVERY\|used=(\d+)\|capacity=(\d+)$', stderr, re.M)
    chain = re.findall(r'^CTM-GC-ROOT-CHAIN\|mode=(lazy|eager)\|ranges=(\d+)\|used=(\d+)\|capacity=(\d+)$', stderr, re.M)
    if args[1] == 'nearfull':
        require(nearfull and all(int(used) == int(cap) - 2
                                and capacity <= int(cap) <= capacity * (16 if recovery_case else 1)
                                for used, cap in nearfull)
                and int(nearfull[0][1]) == capacity, 'Near-full precondition differs')
    else:
        require(not nearfull and not chain, 'Ordinary-pressure control was prefilled')
    original_abort = args[:3] == ['lazy', 'nearfull', 'atomic']
    unchanged_chain_abort = args[:3] == ['eager', 'nearfull', 'atomic'] and args[4] == 'lazy'
    if original_abort or unchanged_chain_abort:
        require(result['exitCode'] == -signal.SIGABRT
                and 'Unexpected mark stack overflow' in stderr
                and 'CTM-GC-ROOT-PASS|' not in stdout,
                'Lazy callback did not reproduce the actual collector abort')
        if unchanged_chain_abort:
            require(chain == [('lazy', '3', str(capacity - 2), str(capacity))],
                    'Failure was not reached through the unchanged lazy callback')
            return 'expected-unchanged-lazy-chain-abort'
        require(not chain, 'Original scanner unexpectedly reached the previous callback')
        return 'expected-original-abort'
    require(result['exitCode'] == 0 and 'Unexpected mark stack overflow' not in stderr,
            'Root-survival fixture failed')
    end = protocol(stdout, 'CTM-GC-ROOT-PASS')
    require(end['mode'] == args[0] and end['pressure'] == args[1] and end['objects'] == args[2]
            and int(end['pointerBits']) == bits and int(end['incremental']) == int(args[3])
            and int(end['capacity']) == capacity and int(end['collections']) == 4
            and int(end['callbacks']) >= 5 and end['rootsReleased'] == '1'
            and end['chain'] == args[4] and end['chainCallbacks'] == end['callbacks']
            and end['arbitraryInteriorRetained'] == str(int(args[0] == 'eager')),
            'Fixture did not establish the required capacity/root/retention contract')
    if recovery_case:
        require(recoveries and int(end['recoveries']) == len(recoveries)
                and capacity < int(end['finalCapacity']) <= int(end['maxCapacity']) <= capacity * 16
                and int(end['callbacks']) > 5,
                'Pointerful case did not exercise bounded ordinary overflow recovery')
        return 'root-survival-with-ordinary-recovery-passed'
    require(not recoveries and int(end['recoveries']) == 0
            and int(end['finalCapacity']) == capacity and int(end['maxCapacity']) == capacity,
            'Fixed-capacity control grew the mark stack')
    return 'root-survival-passed'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Pristine pinned ECL src/bdwgc directory')
    parser.add_argument('--output', type=Path, required=True, help='New evidence/build directory outside source')
    parser.add_argument('--bits', type=int, choices=(32, 64), default=64)
    parser.add_argument('--cc', default='gcc', help='One compiler executable, without flags')
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    require(sys.platform.startswith('linux'), 'Fixture requires a Linux native build')
    require(source.is_dir() and not output.exists() and source != output
            and source not in output.parents, 'Use a new output directory outside source')
    output.mkdir(parents=True)
    report = {'schema': 2, 'kind': 'pinned-collector-root-capacity-regression',
              'acceptance': False, 'productionPatch': False, 'passed': False,
              'eclCommit': ECL_PIN, 'collectorVersion': '8.2.8', 'sourceTreeSha256': SOURCE_TREE_SHA256,
              'requestedPointerBits': args.bits, 'fixture': record(FIXTURE),
              'driver': record(Path(__file__)), 'commands': [], 'cases': [],
              'host': {'platform': platform.platform(), 'machine': platform.machine(),
                       'python': platform.python_version()},
              'scope': 'Standalone native collector API/ownership regression, not ECL integration, Wasm32 validation, or proof of the original browser caller. Original collector sources, algorithm and configured limits remain unchanged. Near-full atomic controls retain original capacity; a separate pointerful near-full case exercises bounded ordinary collector recovery and records intrinsic capacity growth. Independent previous-callback controls explicitly show that fixing ECL-owned ranges does not fix an unchanged unsafe lazy callback. Eager conservatively recognizes extra interior pointers; no equivalent finalizer-timing claim. Incremental-enabled cases perform full GC_gcollect collections, not mutation-between-incremental-step coverage.'}
    try:
        report['sourceFiles'] = source_records(source)
        build = output / 'build'
        build.mkdir()
        env = {key: value for key, value in os.environ.items() if not key.startswith('GC_')}
        env.update(CC=args.cc, CFLAGS=f'-O2 -g -m{args.bits}', CPPFLAGS='', LDFLAGS=f'-m{args.bits}')
        commands = [
            ([args.cc, '--version'], 'compiler-version', 10),
            (['make', '--version'], 'make-version', 10),
            ([str(source / 'configure'), '--disable-shared', '--enable-static', '--disable-threads',
              '--disable-parallel-mark', '--enable-gc-assertions'], 'configure', 120),
            (['make', '-j2', 'libgc.la'], 'build', 180),
            ([args.cc, '-O2', '-g', f'-m{args.bits}', '-DHAVE_CONFIG_H',
              '-I' + str(build / 'include'), '-I' + str(source / 'include'), str(FIXTURE),
              str(build / '.libs/libgc.a'), '-ldl', '-o', str(build / 'gc-root-regression')], 'fixture-build', 60),
        ]
        for command, label, timeout in commands:
            result = execute(command, build, env, output, label, timeout)
            report['commands'].append(result)
            require(result['exitCode'] == 0 and not result['timedOut'], label + ' failed')
        report['binary'] = record(build / 'gc-root-regression')
        report['collectorLibrary'] = record(build / '.libs/libgc.a')
        report['configuration'] = record(build / 'include/config.h')
        for incremental in ('0', '1'):
            for mode in MODES:
                case_args = [*mode[:3], incremental, mode[3]]
                label = '-'.join(case_args)
                result = execute([str(build / 'gc-root-regression'), *case_args], build, env, output, label, 20)
                report['cases'].append({'arguments': case_args, **result})
                # Preserve every run even when its assertions fail.
                try:
                    report['cases'][-1]['outcome'] = check_case(result, output, case_args, args.bits)
                except Exception as error:
                    report['cases'][-1]['failure'] = str(error)
        require(source_records(source) == report['sourceFiles'], 'Collector source changed during build/test')
        require(all('failure' not in case for case in report['cases']), 'A collector regression case failed')
        report['incrementalEvidence'] = 'full-collections-with-incremental-enabled-passed'
        report['passed'] = True
    except Exception as error:
        report['failure'] = str(error)
    (output / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
    print(json.dumps({key: report.get(key) for key in ('passed', 'requestedPointerBits',
          'incrementalEvidence', 'acceptance', 'failure')}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
