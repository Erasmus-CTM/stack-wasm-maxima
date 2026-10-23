# SPDX-License-Identifier: AGPL-3.0-or-later
"""Derive compiler claims from retained command/configuration bytes."""
import hashlib
import json
import re


def digest(body):
    return hashlib.sha256(body).hexdigest()


def optimization(command):
    flags = re.findall(r'(?<!\S)-O(?:[0-3sz]|fast)(?!\S)', command)
    assert flags, 'No effective optimization flag'
    return flags[-1]


def derive_flags(config, target, commands, profile):
    text = config.decode(errors='replace')
    flags = re.findall(r"^CFLAGS='(.*)'$", text, re.M)
    assert len(flags) == 1 and optimization(flags[0]) == profile['eclCFlag']
    links = dict(re.findall(r"^(LDFLAGS|SHARED_LDFLAGS|BUNDLE_LDFLAGS|PROGRAM_LDFLAGS)='(.*)'$", text, re.M))
    assert set(links) == {'LDFLAGS','SHARED_LDFLAGS','BUNDLE_LDFLAGS','PROGRAM_LDFLAGS'}
    assert all('--spill-pointers' in row and '-sSTACK_SIZE=33554432' in row for row in links.values())
    lines = commands.decode(errors='replace').splitlines()
    ecl = [line for line in lines if 'emcc ' in line and ' -c ' in line and 'main.o.c' in line and not line.lstrip().startswith(';;;')]
    assert ecl and optimization(ecl[-1]) == profile['eclCFlag'], 'Missing or incorrectly optimized actual ECL core compile'
    maxima = [line for line in lines if 'emcc ' in line and ' -c ' in line and ' -Demscripten ' in line and '/src/binary-ecl/wasm32-emscripten/' in line]
    assert maxima and optimization(maxima[-1]) == '-O2', 'Missing or changed Maxima generated-unit compile'
    assert target, 'Empty installed target-info snapshot'
    return {'finalCFlags': flags[0], 'finalOptimization': optimization(flags[0]), 'linkFlags': links,
            'configLogSha256': digest(config), 'targetInfoSha256': digest(target),
            'compilerCommandsSha256': digest(commands), 'representativeEclCompile': ecl[-1],
            'representativeMaximaCompile': maxima[-1], 'maximaFinalOptimization': '-O2'}


def verify_artifact_flags(artifact, profile):
    inventory = json.loads((artifact / 'artifact-manifest.json').read_text())['files']
    records = {row['path']: row for row in inventory}
    assert len(records) == len(inventory), 'Duplicate artifact evidence paths'
    snapshots = {}
    for name in ['effective-flags.json','ecl-config.log','target-info.lsp','compiler-commands.log']:
        body = (artifact / 'logs' / name).read_bytes()
        row = records['logs/' + name]
        assert len(body) == row['bytes'] and digest(body) == row['sha256'], 'Changed delivered compiler evidence: ' + name
        snapshots[name] = body
    observed = json.loads(snapshots['effective-flags.json'])
    assert observed['passed'] is True and observed['configuration'] == profile
    expected = derive_flags(snapshots['ecl-config.log'], snapshots['target-info.lsp'], snapshots['compiler-commands.log'], profile)
    assert {key: observed[key] for key in expected} == expected, 'Compiler claims differ from actual retained snapshots'
    return observed
