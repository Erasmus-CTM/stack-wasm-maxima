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
        stripped = line.lstrip()
        generated = stripped.startswith(';;;')
        stripped = stripped.removeprefix(';;;').lstrip()
        for prefix in ['libtool: compile:','libtool: link:']:
            stripped = stripped.removeprefix(prefix).lstrip()
        try:
            tokens = shlex.split(stripped)
        except ValueError:
            continue
        if not tokens:
            continue
        executable = PurePosixPath(tokens[0]).name
        if executable in ['clang','clang++','emcc','em++','wasm-opt']:
            result.append({'command':stripped,'tokens':tokens,'executable':executable,'generatedLisp':generated})
    return result


def output_of(row):
    positions = [i for i,token in enumerate(row['tokens']) if token=='-o']
    assert len(positions)==1 and positions[0]+1<len(row['tokens']), 'Missing/ambiguous output: '+row['command']
    return row['tokens'][positions[0]+1]


def c_compiles(rows, executables):
    for row in rows:
        if row['executable'] not in executables or '-c' not in row['tokens']:
            continue
        inputs = [token for token in row['tokens'][1:] if not token.startswith('-') and token.endswith('.c')]
        if len(inputs)==1:
            yield {**row,'input':inputs[0],'output':output_of(row),'optimization':optimization(row['tokens']) if any(re.fullmatch(r'-O(?:[0-3sz]|fast)',t) for t in row['tokens']) else None}


def same_source(left,right):
    # clang receives the compile-only input/output argv directly in pinned emcc.
    # Absolute paths may spell the same relative input; never match only basename.
    left,right = str(PurePosixPath(left)),str(PurePosixPath(right))
    return left==right or (not left.startswith('/') and right.endswith('/'+left)) or (not right.startswith('/') and left.endswith('/'+right))


def relevant_compiles(rows,sdk_source):
    observed = []
    excluded = []
    for row in c_compiles(rows,['clang','clang++']):
        if re.fullmatch(r'conftest[0-9]*\.c',PurePosixPath(row['input']).name):
            excluded.append({**row,'reason':'explicit configure conftest'})
        elif row['input'].startswith(sdk_source+'/'):
            excluded.append({**row,'reason':'verified SDK source, outside ECL/Maxima targets'})
        else:
            observed.append(row)
    raw = list(c_compiles(rows,['emcc','em++']))
    for row in observed:
        matching = [r for r in raw if same_source(r['input'],row['input']) and same_source(r['output'],row['output'])]
        assert matching, 'Missing raw target compile association: '+row['input']
        assert len({r['generatedLisp'] for r in matching})==1, 'Ambiguous source class: '+row['input']
        row['generatedLisp']=matching[0]['generatedLisp']
        row['rawCompileCommands']=[r['command'] for r in matching]
    for row in raw:
        if re.fullmatch(r'conftest[0-9]*\.c',PurePosixPath(row['input']).name) or row['input'].startswith(sdk_source+'/'):
            continue
        assert any(same_source(row['input'],r['input']) and same_source(row['output'],r['output']) for r in observed), 'Missing actual clang execution: '+row['input']
    return observed,excluded


MODULES = ['slatec','quadpack','solve','poisson-series','matrix-algebra','number-theory','limits','integration']


def normalized(path,cwd):
    import posixpath
    return posixpath.normpath(path if path.startswith('/') else str(cwd)+'/'+path)


def link_evidence(rows,cwd,required):
    passes = []
    for row in rows:
        if row['executable']!='wasm-opt' or '--spill-pointers' not in row['tokens'] or '-o' not in row['tokens']:
            continue
        outindex=row['tokens'].index('-o')
        assert outindex>1 and not row['tokens'][outindex-1].startswith('-'), 'Missing actual Binaryen input'
        passes.append({'command':row['command'],'input':normalized(row['tokens'][outindex-1],cwd),'output':normalized(output_of(row),cwd)})
    links = []
    for row in rows:
        tokens = row['tokens']
        if row['executable'] not in ['emcc','em++'] or '-c' in tokens or '-o' not in tokens:
            continue
        output = output_of(row)
        if not output.endswith(('.wasm','.js','.html','.so','.fas','.fasb')) or 'conftest' in output:
            continue
        assert '--spill-pointers' in row['command'], 'Missing GC spill setting on target link: '+output
        assert '-sSTACK_SIZE=33554432' in row['command'], 'Changed target stack setting: '+output
        # Pinned Emscripten emits secondary .wasm beside JS/HTML; SIDE_MODULE
        # outputs are themselves Wasm with their original .so/.fas/.fasb name.
        if output.endswith(('.js','.html')):
            wasm=str(PurePosixPath(output).with_suffix('.wasm'))
        else:
            wasm=output
            if not output.endswith('.wasm'):
                assert any(re.fullmatch(r'-sSIDE_MODULE(?:=[12])?',token) for token in tokens), 'Missing SIDE_MODULE identity: '+output
        wasm=normalized(wasm,cwd)
        matching=[p for p in passes if p['input']==wasm and p['output']==wasm]
        assert matching, 'No actual spill-pointers execution for target: '+wasm
        links.append({'output':normalized(output,cwd),'wasmOutput':wasm,'command':row['command'],'spillPasses':matching})
    observed={row['wasmOutput'] for row in links}
    assert set(required)<=observed, 'Missing required delivered link targets: '+str(sorted(set(required)-observed))
    return {'targetLinks':links,'requiredTargets':required}


def derive(config, target, ecl_trace, maxima_trace, profile):
    text = config.decode(errors='replace')
    flags = re.findall(r"^CFLAGS='(.*)'$",text,re.M)
    assert len(flags)==1 and optimization(shlex.split(flags[0]))=='-O0', 'Upstream raw configure CFLAGS changed'
    links = dict(re.findall(r"^(LDFLAGS|SHARED_LDFLAGS|BUNDLE_LDFLAGS|PROGRAM_LDFLAGS)='(.*)'$",text,re.M))
    assert set(links)==LINK_FIELDS, 'Missing named GC link configuration'
    assert all('--spill-pointers' in value and '-sSTACK_SIZE=33554432' in value for value in links.values())
    cc=re.findall(r"^CC='(.*)'$",text,re.M)
    assert len(cc)==1 and cc[0].endswith('/sources/emsdk/upstream/emscripten/emcc'), 'Missing pinned compiler location'
    work=cc[0].removesuffix('/sources/emsdk/upstream/emscripten/emcc')
    sdk_source=cc[0].removesuffix('/emcc')
    ecl_cwd=work+'/sources/ecl/build'
    maxima_cwd=work+'/sources/maxima/wasm'
    maxima_output=work+'/sources/maxima/src/binary-ecl/wasm32-emscripten'
    assert target, 'Missing target-info actually installed for Maxima'
    ecl_rows, maxima_rows = commands(ecl_trace), commands(maxima_trace)
    ecl_c,ecl_excluded=relevant_compiles(ecl_rows,sdk_source)
    maxima,maxima_excluded=relevant_compiles(maxima_rows,sdk_source)
    core = [row for row in ecl_c if not row['generatedLisp']]
    generated = [row for row in ecl_c if row['generatedLisp']]
    assert any(PurePosixPath(row['input']).name=='main.o.c' for row in core), 'Missing actual ECL core main compile'
    assert any('/src/binary-ecl/wasm32-emscripten/' in row['input'] for row in maxima), 'Missing actual generated Maxima unit compile'
    for name, rows, expected in [('ECL core',core,profile['eclCoreOptimization']),('ECL generated Lisp',generated,profile['eclGeneratedLispOptimization']),('Maxima generated C',maxima,profile['maximaGeneratedOptimization'])]:
        assert rows and all(row['optimization']==expected for row in rows), 'Missing/wrong actual clang compilation: '+name
    return {'rawConfigureCFlags':flags[0],'rawConfigureOptimization':'-O0','namedLinkFlags':links,
            'configSha256':digest(config),'installedTargetInfoSha256':digest(target),
            'eclTraceSha256':digest(ecl_trace),'maximaTraceSha256':digest(maxima_trace),
            'eclCore':core,'eclGeneratedLisp':generated,'maximaGeneratedUnits':maxima,
            'excludedNonTargetCompiles':{'ecl':ecl_excluded,'maxima':maxima_excluded},
            'eclLinks':link_evidence(ecl_rows,ecl_cwd,[ecl_cwd+'/libecl.so']),
            'maximaLinks':link_evidence(maxima_rows,maxima_cwd,[maxima_output+'/maxima.wasm']+[maxima_output+'/maxima/'+module+'.fasb' for module in MODULES])}


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
