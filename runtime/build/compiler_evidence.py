# SPDX-License-Identifier: AGPL-3.0-or-later
"""Derive effective optimization from actual Emscripten subprocess traces."""
import hashlib
import json
from pathlib import PurePosixPath
import re
import shlex

LINK_FIELDS = {'LDFLAGS','SHARED_LDFLAGS','BUNDLE_LDFLAGS','PROGRAM_LDFLAGS'}


def digest(body):
    return hashlib.sha256(body).hexdigest()


def optimization(tokens):
    flags = [token for token in tokens if re.fullmatch(r'-O(?:[0-3sz]|fast)',token)]
    assert flags, 'No observed optimization flag'
    return flags[-1]


def commands(body):
    result = []
    for line in body.decode(errors='replace').splitlines():
        stripped = line.lstrip().removeprefix(';;;').lstrip()
        try:
            tokens = shlex.split(stripped)
        except ValueError:
            continue
        if not tokens:
            continue
        executable = PurePosixPath(tokens[0]).name
        if executable in ['clang','clang++','emcc','em++','wasm-opt']:
            result.append({'command':stripped,'tokens':tokens,'executable':executable})
    return result


def compiled(rows):
    for row in rows:
        if row['executable'] not in ['clang','clang++'] or '-c' not in row['tokens']:
            continue
        inputs = [token for token in row['tokens'][1:] if not token.startswith('-') and token.endswith('.c')]
        if len(inputs)==1:
            yield {**row,'input':inputs[0],'optimization':optimization(row['tokens'])}


def link_evidence(rows):
    links = []
    for row in rows:
        tokens = row['tokens']
        if row['executable'] not in ['emcc','em++'] or '-c' in tokens or '-o' not in tokens:
            continue
        output = tokens[tokens.index('-o')+1]
        if not output.endswith(('.wasm','.js','.so','.fas','.fasb')) or 'conftest' in output:
            continue
        assert '--spill-pointers' in row['command'], 'Missing GC spill setting on target link: '+output
        assert '-sSTACK_SIZE=33554432' in row['command'], 'Changed target stack setting: '+output
        links.append({'output':output,'command':row['command']})
    assert links, 'Missing actual emcc target link commands'
    passes = [row['command'] for row in rows if row['executable']=='wasm-opt' and '--spill-pointers' in row['tokens']]
    assert passes, 'Missing actual Binaryen spill-pointers execution'
    return {'targetLinks':links,'observedSpillPassCommands':passes}


def derive(config, target, ecl_trace, maxima_trace, profile):
    text = config.decode(errors='replace')
    flags = re.findall(r"^CFLAGS='(.*)'$",text,re.M)
    assert len(flags)==1 and optimization(shlex.split(flags[0]))=='-O0', 'Upstream raw configure CFLAGS changed'
    links = dict(re.findall(r"^(LDFLAGS|SHARED_LDFLAGS|BUNDLE_LDFLAGS|PROGRAM_LDFLAGS)='(.*)'$",text,re.M))
    assert set(links)==LINK_FIELDS, 'Missing named GC link configuration'
    assert all('--spill-pointers' in value and '-sSTACK_SIZE=33554432' in value for value in links.values())
    assert target, 'Missing target-info actually installed for Maxima'
    ecl_rows, maxima_rows = commands(ecl_trace), commands(maxima_trace)
    ecl_c = list(compiled(ecl_rows))
    core = [row for row in ecl_c if PurePosixPath(row['input']).name=='main.o.c']
    generated = [row for row in ecl_c if PurePosixPath(row['input']).name.startswith('eclinit')]
    maxima = [row for row in compiled(maxima_rows) if '/src/binary-ecl/wasm32-emscripten/' in row['input']]
    for name, rows, expected in [('ECL core',core,profile['eclCoreOptimization']),('ECL generated Lisp',generated,profile['eclGeneratedLispOptimization']),('Maxima generated units',maxima,profile['maximaGeneratedOptimization'])]:
        assert rows and all(row['optimization']==expected for row in rows), 'Missing/wrong actual clang compilation: '+name
    return {'rawConfigureCFlags':flags[0],'rawConfigureOptimization':'-O0','namedLinkFlags':links,
            'configSha256':digest(config),'installedTargetInfoSha256':digest(target),
            'eclTraceSha256':digest(ecl_trace),'maximaTraceSha256':digest(maxima_trace),
            'eclCore':core,'eclGeneratedLisp':generated,'maximaGeneratedUnits':maxima,
            'eclLinks':link_evidence(ecl_rows),'maximaLinks':link_evidence(maxima_rows)}


def verify_packaged(artifact, profile):
    rows = json.loads((artifact/'artifact-manifest.json').read_bytes())['files']
    records = {row['path']:row for row in rows}
    assert len(records)==len(rows)
    snapshots = {}
    for name in ['compiler-experiment.json','ecl-config.log','target-info.lsp','ecl-cross-build.log','maxima-cross-build.log']:
        body = (artifact/'logs'/name).read_bytes()
        row = records['logs/'+name]
        assert len(body)==row['bytes'] and digest(body)==row['sha256'], 'Changed compiler evidence: '+name
        snapshots[name]=body
    record = json.loads(snapshots['compiler-experiment.json'])
    assert record['passed'] is True and record['profile']==profile
    expected = derive(snapshots['ecl-config.log'],snapshots['target-info.lsp'],snapshots['ecl-cross-build.log'],snapshots['maxima-cross-build.log'],profile)
    assert record['observed']==expected, 'Compiler claims differ from raw subprocess evidence'
    return record
