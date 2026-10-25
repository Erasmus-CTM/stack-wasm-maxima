# SPDX-License-Identifier: AGPL-3.0-or-later
"""Derive effective optimization from actual Emscripten subprocess traces."""
import hashlib
import json
from pathlib import PurePosixPath
import re
import shlex
import ast

LINK_FIELDS = {'LDFLAGS','SHARED_LDFLAGS','BUNDLE_LDFLAGS','PROGRAM_LDFLAGS'}


def digest(body):
    return hashlib.sha256(body).hexdigest()


def optimization(tokens):
    flags = [token for token in tokens if re.fullmatch(r'-O(?:[0-3sz]|fast)',token)]
    assert flags, 'No observed optimization flag'
    return flags[-1]


def config_assignments(text, names):
    """Decode complete Autoconf shell assignments, including escaped apostrophes.

    config.log shell-quotes values for replay. Removing only the outer quotes
    corrupts values such as -DECLDIR='' encoded with shell quote transitions.
    Never execute the assignments; shlex only decodes their quoting layer.
    """
    values = {}
    for line in text.splitlines():
        name, separator, _ = line.partition('=')
        if not separator or name not in names:
            continue
        assert name not in values, 'Duplicate configure assignment: '+name
        try:
            tokens = shlex.split(line)
        except ValueError as error:
            raise AssertionError('Malformed configure assignment: '+name) from error
        assert len(tokens)==1 and tokens[0].startswith(name+'='), 'Ambiguous configure assignment: '+name
        values[name]=tokens[0][len(name)+1:]
    assert set(values)==set(names), 'Missing configure assignments: '+str(sorted(set(names)-set(values)))
    return values


def commands(body):
    result = []
    pending = {}
    for line in body.decode(errors='replace').splitlines():
        stripped = line.lstrip()
        executed=False
        # strace writes outside ECL's captured child stderr. Parse only
        # successful execve argv; no environment values are recorded by the
        # configured trace. Parallel unfinished/resumed syscalls retain PID.
        traced=re.match(r'^(\d+)\s+(.*)$',stripped)
        if traced:
            pid,stripped=traced.groups()
            if stripped.endswith(' <unfinished ...>') and stripped.startswith('execve('):
                assert pid not in pending, 'Overlapping unfinished execve'
                pending[pid]=stripped.removesuffix(' <unfinished ...>')
                continue
            if stripped.startswith('<... execve resumed>'):
                assert pid in pending, 'Unmatched resumed execve'
                stripped=pending.pop(pid)+stripped.removeprefix('<... execve resumed>')
        if stripped.startswith('execve('):
            match=re.fullmatch(r'execve\(("(?:[^"\\]|\\.)*"), (\[.*\]), .*\)\s+= 0',stripped)
            if not match:
                assert not stripped.rstrip().endswith('= 0'), 'Malformed successful execve'
                continue
            executable_path=ast.literal_eval(match[1])
            if PurePosixPath(executable_path).name not in ['clang','clang++','wasm-opt','emcc','em++']:
                continue
            tokens=ast.literal_eval(match[2])
            assert tokens and all(isinstance(token,str) for token in tokens), 'Truncated execution argv'
            assert PurePosixPath(tokens[0]).name==PurePosixPath(executable_path).name, 'Execution argv identity mismatch'
            tokens[0]=executable_path
            stripped=shlex.join(tokens)
            executed=True
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
            result.append({'command':stripped,'tokens':tokens,'executable':executable,'generatedLisp':generated,'executed':executed})
    assert not pending, 'Incomplete execution trace'
    return result


def output_of(row):
    outputs=[]
    for i,token in enumerate(row['tokens']):
        if token=='-o':
            assert i+1<len(row['tokens']), 'Missing output argument: '+row['command']
            outputs.append(row['tokens'][i+1])
        elif token.startswith('-o'):
            outputs.append(token[2:])
    assert len(outputs)==1 and outputs[0], 'Missing/ambiguous output: '+row['command']
    return outputs[0]


def c_compiles(rows, executables):
    for row in rows:
        if row['executable'] not in executables or '-c' not in row['tokens']:
            continue
        inputs = [token for token in row['tokens'][1:] if not token.startswith('-') and token.endswith('.c')]
        if len(inputs)==1:
            # Compile-only C invocations without -o use basename.o in the
            # current directory; links still require an explicit output.
            output=output_of(row) if any(t.startswith('-o') for t in row['tokens']) else str(PurePosixPath(inputs[0]).with_suffix('.o').name)
            yield {**row,'input':inputs[0],'output':output,'optimization':optimization(row['tokens']) if any(re.fullmatch(r'-O(?:[0-3sz]|fast)',t) for t in row['tokens']) else None}


def same_source(left,right):
    # clang receives the compile-only input/output argv directly in pinned emcc.
    # Absolute paths may spell the same relative input; never match only basename.
    left,right = str(PurePosixPath(left)),str(PurePosixPath(right))
    return left==right or (not left.startswith('/') and right.startswith('/') and right.endswith('/'+left)) or (not right.startswith('/') and left.startswith('/') and left.endswith('/'+right))


def sdk_input(row,sdk_source):
    """Recognize SDK sources, retaining the original execution argv unchanged.

    Pinned tools/system_libs.py batches paths relative to its cache build
    directory and emits both source-root prefix maps plus this debug directory.
    The cache directory depth differs between SDK versions (../../.. in 4.0.10,
    ../../../../.. in 6.0.11); the relative prefix must equal the mapped one.
    A relative spelling alone cannot exempt a target compilation.
    """
    import posixpath
    source=posixpath.normpath(row['input'])
    if source.startswith(sdk_source+'/'):
        return source
    relative=re.match(r'((?:\.\./)+)system/',source)
    if not relative:
        return None
    up=relative.group(1)
    anchors={f'-ffile-prefix-map={sdk_source}=/emsdk/emscripten',
             f'-ffile-prefix-map={up.removesuffix("/")}=/emsdk/emscripten',
             '-fdebug-compilation-dir=/emsdk/emscripten'}
    if anchors<=set(row['tokens']):
        canonical=posixpath.normpath(sdk_source+'/'+source.removeprefix(up))
        if canonical.startswith(sdk_source+'/system/'):
            return canonical
    return None


def relevant_compiles(rows,sdk_source,allow_ecl_core_fallback=False):
    observed = []
    excluded = []
    for row in c_compiles(rows,['clang','clang++']):
        if re.fullmatch(r'conftest[0-9]*\.c',PurePosixPath(row['input']).name):
            excluded.append({**row,'reason':'explicit configure conftest'})
        elif sdk_input(row,sdk_source):
            excluded.append({**row,'reason':'verified SDK source, outside ECL/Maxima targets','canonicalSource':sdk_input(row,sdk_source)})
        else:
            observed.append(row)
    raw = list(c_compiles(rows,['emcc','em++']))
    printed = [row for row in raw if not row['executed']]
    for row in observed:
        matching = [r for r in printed if same_source(r['input'],row['input']) and same_source(r['output'],row['output'])]
        if not matching and allow_ecl_core_fallback and row['input'].endswith('.o.c'):
            # Parallel make diagnostics can corrupt a printed command line.
            # Only verified ECL DPP core units may use the complete successful
            # driver execve as their source-class/input/output association.
            include='-I'+sdk_source.removesuffix('/sources/emsdk/upstream/emscripten')+'/sources/ecl/src/c'
            matching=[r for r in raw if r['executed'] and '-DECL_BUILD' in r['tokens'] and include in r['tokens'] and same_source(r['input'],row['input']) and same_source(r['output'],row['output'])]
            if matching:
                row['sourceClassEvidence']='executed ECL DPP core driver; printed make output absent/corrupted'
        assert matching, 'Missing raw target compile association: '+row['input']
        assert len({r['generatedLisp'] for r in matching})==1, 'Ambiguous source class: '+row['input']
        row['generatedLisp']=matching[0]['generatedLisp']
        row['rawCompileCommands']=[r['command'] for r in matching]
    for row in raw:
        if re.fullmatch(r'conftest[0-9]*\.c',PurePosixPath(row['input']).name) or sdk_input(row,sdk_source):
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
    assignments=config_assignments(text,LINK_FIELDS|{'CC','CFLAGS'})
    flags=assignments['CFLAGS']
    assert optimization(shlex.split(flags))=='-O0', 'Upstream raw configure CFLAGS changed'
    links = {name:assignments[name] for name in LINK_FIELDS}
    assert all('--spill-pointers' in value and '-sSTACK_SIZE=33554432' in value for value in links.values())
    cc=assignments['CC']
    assert cc.endswith('/sources/emsdk/upstream/emscripten/emcc'), 'Missing pinned compiler location'
    work=cc.removesuffix('/sources/emsdk/upstream/emscripten/emcc')
    sdk_source=cc.removesuffix('/emcc')
    ecl_cwd=work+'/sources/ecl/build'
    maxima_cwd=work+'/sources/maxima/wasm'
    maxima_output=work+'/sources/maxima/src/binary-ecl/wasm32-emscripten'
    assert target, 'Missing target-info actually installed for Maxima'
    ecl_rows, maxima_rows = commands(ecl_trace), commands(maxima_trace)
    ecl_c,ecl_excluded=relevant_compiles(ecl_rows,sdk_source,allow_ecl_core_fallback=True)
    maxima,maxima_excluded=relevant_compiles(maxima_rows,sdk_source)
    core = [row for row in ecl_c if not row['generatedLisp']]
    generated = [row for row in ecl_c if row['generatedLisp']]
    assert any(PurePosixPath(row['input']).name=='main.o.c' for row in core), 'Missing actual ECL core main compile'
    assert any('/src/binary-ecl/wasm32-emscripten/' in row['input'] for row in maxima), 'Missing actual generated Maxima unit compile'
    for name, rows, expected in [('ECL core',core,profile['eclCoreOptimization']),('ECL generated Lisp',generated,profile['eclGeneratedLispOptimization']),('Maxima generated C',maxima,profile['maximaGeneratedOptimization'])]:
        assert rows and all(row['optimization']==expected for row in rows), 'Missing/wrong actual clang compilation: '+name
    return {'rawConfigureCFlags':flags,'rawConfigureOptimization':'-O0','namedLinkFlags':links,
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
