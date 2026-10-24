#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Collect frozen-input, changed-libECL diagnostics; never production parity."""
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
from target_info import compare as compare_target_info

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.cache/gc-mark-instrumentation'
MIXED = OUT / 'mixed-runtime'
BASE = '6d3735dd480bd50753d3ba7efc01636c7d269d8a'
ADDITIONS = {
    '.github/workflows/mark-stack-diagnostic.yml',
    'runtime/diagnostics/mark-stack-replay.py',
    '.github/workflows/mark-stack-instrumentation.yml',
    'runtime/diagnostics/instrument-ecl-gc.py',
    'runtime/diagnostics/stage-gc-instrumented.py',
    'runtime/diagnostics/run-gc-instrumentation.py',
    'runtime/diagnostics/target_info.py',
    'runtime/diagnostics/test-target-info.py',
}
FROZEN_HELPER = '373e54a242d2a19d8b9d41af207da1937bcddad8ee0708c0c003ff325019514f'


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def record(path):
    body = path.read_bytes()
    return {'bytes': len(body), 'sha256': digest(body)}


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def frozen_helper():
    path = ROOT / 'runtime/diagnostics/mark-stack-replay.py'
    require(record(path)['sha256'] == FROZEN_HELPER, 'Reviewed frozen helper changed')
    spec = importlib.util.spec_from_file_location('frozen_gc_inputs', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def checkout_binding():
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    require(not os.environ.get('GITHUB_SHA') or os.environ['GITHUB_SHA'] == head, 'Wrong CI checkout')
    changes = subprocess.check_output(['git', 'diff', '--name-status', BASE, 'HEAD'], cwd=ROOT, text=True)
    require(set(changes.splitlines()) == {'A\t' + path for path in ADDITIONS},
            'Instrumentation checkout must add exactly eight diagnostic files')
    require(subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=ROOT).returncode == 0,
            'Tracked checkout changed')
    return {'diagnosticRevision': head, 'productRevision': BASE,
            'tree': subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT, text=True).strip()}


def download():
    f = frozen_helper()
    f.OUT.mkdir(parents=True, exist_ok=False)
    proof = {'schema': 1, 'diagnosticOnly': True, 'acceptance': False,
             'spec': f.SPEC, 'downloadComplete': False}
    try:
        proof['checkout'] = checkout_binding()
        proof['before'] = f.metadata()
        body = f.api('/actions/artifacts/' + str(f.SPEC['id']) + '/zip', download=True)
        proof['after'] = f.metadata()
        require(proof['before'] == proof['after'], 'Frozen input metadata changed')
        proof['inventory'] = f.unpack(body)
        f.verify_inputs(proof['inventory'])
        proof['downloadComplete'] = True
    except Exception as error:
        proof['failure'] = str(error)
    save(f.OUT / 'provenance.json', proof)
    print(json.dumps({'downloadComplete': proof['downloadComplete'], 'failure': proof.get('failure')}), flush=True)
    return 0 if proof['downloadComplete'] else 1


def verify_mixed(f):
    proof_path = MIXED / 'diagnostic-provenance.json'
    proof = json.loads(proof_path.read_text())
    require(proof['diagnosticOnly'] is True and proof['acceptance'] is False
            and proof['productionAdmission'] is False, 'Mixed input could imply admission')
    require(proof['parentArtifact'] == f.SPEC['id']
            and proof['parentArchiveSha256'] == f.SPEC['sha256'], 'Wrong mixed parent')
    require(proof['onlyChangedRuntimeAsset'] == 'libecl.so' and proof['targetInfoMatches'] is True
            and proof['moduleInterfaceShapeMatches'] is True, 'Incomplete module-shape/config checks')
    original_target = (f.FROZEN / f.RUNTIME / 'logs/target-info.lsp').read_bytes()
    require((MIXED / 'original-target-info.lsp').read_bytes() == original_target,
            'Mixed original target-info differs from the frozen input')
    target_comparison = compare_target_info(original_target, (MIXED / 'instrumented-target-info.lsp').read_bytes())
    require(proof['targetInfoComparison'] == target_comparison, 'Target-info comparison evidence changed')
    require(record(MIXED / 'instrumentation.json') == proof['sourcePatchReport'], 'Patch evidence changed')
    original = json.loads((f.FROZEN / f.RUNTIME / 'manifest.json').read_text())
    require(record(f.FROZEN / f.RUNTIME / 'manifest.json') == proof['parentManifest'], 'Parent manifest changed')
    manifest = json.loads((MIXED / 'manifest.json').read_text())
    require(manifest['diagnosticOnly'] is True and manifest['acceptance'] is False
            and manifest['productionAdmission'] is False, 'Missing diagnostic manifest labels')
    require(manifest['runtimeAssets'] == proof['runtimeAssets'], 'Mixed asset manifest changed')
    before = {row['path']: row for row in original['runtimeAssets']}
    after = {row['path']: row for row in manifest['runtimeAssets']}
    require(len(before) == len(after) == 79 and set(before) == set(after), 'Runtime closure changed')
    require({path for path in before if before[path] != after[path]} == {'libecl.so'}, 'More than one runtime asset changed')
    for path, row in after.items():
        f.safe_path(path)
        asset = MIXED / 'runtime' / path
        require(asset.resolve().is_relative_to((MIXED / 'runtime').resolve()) and not asset.is_symlink(),
                'Mixed asset escapes staging')
        require(record(asset) == {'bytes': row['bytes'], 'sha256': row['sha256']}, 'Mixed asset bytes changed')
    return {'proof': record(proof_path), 'manifest': record(MIXED / 'manifest.json')}


def compiler_evidence():
    f = frozen_helper()
    checkout_binding()
    sys.path.insert(0, str(ROOT / 'runtime/build'))
    from compiler_evidence import derive
    profile = json.loads((ROOT / 'runtime/build/compiler-profiles.json').read_text())['profiles']['baseline']
    logs = OUT / 'logs'
    maxima_trace = f.FROZEN / f.RUNTIME / 'logs/maxima-cross-build.log'
    observed = derive((logs / 'ecl-config.log').read_bytes(), (logs / 'target-info.lsp').read_bytes(),
                      (logs / 'ecl-cross-build.log').read_bytes(), maxima_trace.read_bytes(), profile)
    proof = {'schema': 1, 'diagnosticOnly': True, 'acceptance': False, 'productionAdmission': False,
             'compilerScopePassed': True, 'profile': profile, 'observed': observed,
             'newEclTrace': record(logs / 'ecl-cross-build.log'), 'frozenMaximaTrace': record(maxima_trace),
             'scope': 'New instrumented ECL target trace plus the original frozen Maxima trace. Maxima was not rebuilt; no production compiler/build admission.'}
    save(logs / 'compiler-evidence.json', proof)
    print(json.dumps({'diagnosticOnly': True, 'compilerScopePassed': True,
                      'eclCoreRecords': len(observed['eclCore']), 'eclLispRecords': len(observed['eclGeneratedLisp']),
                      'frozenMaximaRecords': len(observed['maximaGeneratedUnits'])}), flush=True)
    return 0


def replay():
    f = frozen_helper()
    report = {'schema': 1, 'diagnosticOnly': True, 'acceptance': False,
              'productionAdmission': False, 'evidenceComplete': False, 'parityPassed': False,
              'instrumentationObservedInEveryOutcome': False,
              'attempts': [], 'plan': [{'name': name, 'compiled': mode, 'pins': list(f.PINS)} for name, mode in f.PLAN],
              'scope': 'Frozen failed baseline with only libecl.so rebuilt for collector instrumentation. Fixed compiled/source/compiled official invocations, both pins each. Original roots, capacity, abort, trace, transport, cases and watchdog retained. No production acceptance or frequency/performance claim.',
              'limitations': ['Instrumentation adds C frames, small globals and logging and may perturb the failure.',
                              'Module import/export shape and unchanged source/config are not a complete binary ABI proof.',
                              'Passing instrumented cases cannot exonerate the original failed runtime.']}
    scratch = ROOT / 'test-results/milestone-one'
    try:
        report['checkout'] = checkout_binding()
        require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'), 'Browser inherited API token')
        require(subprocess.check_output(['node', '--version'], text=True).strip() == 'v22.16.0', 'Wrong Node')
        parser = ROOT / '.ctm-checkers-source'
        require(subprocess.check_output(['git', '-C', str(parser), 'rev-parse', 'HEAD'], text=True).strip() == f.CTM_PIN,
                'Wrong official parser pin')
        require(subprocess.run(['git', '-C', str(parser), 'diff', '--quiet', 'HEAD', '--']).returncode == 0,
                'Official parser changed')
        provenance = json.loads((f.OUT / 'provenance.json').read_text())
        require(provenance['downloadComplete'] is True and provenance['spec'] == f.SPEC, 'Incomplete frozen download')
        _, index = f.verify_inputs(provenance['inventory'])
        report['frozenProvenance'] = record(f.OUT / 'provenance.json')
        report['mixedRuntime'] = verify_mixed(f)
        compiler_path = OUT / 'logs/compiler-evidence.json'
        compiler = json.loads(compiler_path.read_text())
        require(compiler['diagnosticOnly'] is True and compiler['compilerScopePassed'] is True
                and compiler['productionAdmission'] is False, 'Missing scoped compiler evidence')
        report['compilerEvidence'] = record(compiler_path)
        mixed_manifest = json.loads((MIXED / 'manifest.json').read_text())
        expected_module = next(row for row in mixed_manifest['runtimeAssets'] if row['path'] == 'libecl.so')
        report['expectedInstrumentedModule'] = expected_module
        index_path = OUT / 'rebased-probe-index.json'
        save(index_path, f.rebase_index(index))
        report['rebasedIndex'] = record(index_path)
        env = {key: value for key, value in os.environ.items() if key not in ('GH_TOKEN', 'GITHUB_TOKEN')}
        env.update(CTM_MAXIMA_RUNTIME_SOURCE=str(MIXED), CTM_ECL_COMPILER_PROFILE='baseline')
        preflight = "import {readFile} from 'node:fs/promises';import {compiledProbeInputs} from './runtime/precompiled/probe-inputs.mjs';import {loadOwnedRuntime} from './runtime/build/runtime-source.mjs';await loadOwnedRuntime(process.env.CTM_MAXIMA_RUNTIME_SOURCE,process.cwd());const x=await compiledProbeInputs(process.argv[1],await readFile(process.argv[2]));if(x.size!==2)throw Error('Wrong pin count');"
        report['preflight'] = f.execute(['node', '--input-type=module', '-e', preflight, str(index_path), str(f.FROZEN / f.PREPARED)],
                                        OUT / 'preflight', env, 120)
        require(report['preflight']['exitCode'] == 0, 'Mixed diagnostic preflight failed')
        require(not scratch.exists(), 'Official output already exists')
        for name, compiled in f.PLAN:
            directory = OUT / 'attempts' / name
            attempt = {'name': name, 'compiled': compiled, 'evidenceComplete': False, 'parityPassed': False}
            print(json.dumps({'starting': name, 'instrumented': True, 'pins': f.PINS}), flush=True)
            try:
                f.verify_inputs(provenance['inventory'])
                require(verify_mixed(f) == report['mixedRuntime'], 'Mixed runtime changed')
                scratch.mkdir(parents=True)
                for path in (f.PREPARED, *f.NATIVES):
                    shutil.copyfile(f.FROZEN / path, scratch / Path(path).name)
                current = {**env, 'MILESTONE_ONE_REPORT_ROOT': str(directory / 'comparison')}
                if compiled:
                    current['CTM_PRECOMPILED_PROBE_INDEX'] = str(index_path)
                else:
                    current.pop('CTM_PRECOMPILED_PROBE_INDEX', None)
                attempt['browserCommand'] = f.execute(['node', 'scripts/milestone-one/run.mjs'], directory / 'browser-process', current, f.OUTER_TIMEOUT)
                attempt['comparisonCommand'] = f.execute([sys.executable, 'scripts/milestone-one/compare.py'], directory / 'compare-process', current, 60)
                shutil.copytree(scratch, directory / 'results')
                comparison = json.loads((directory / 'comparison/latest.json').read_text())
                require(tuple(row['stackRevision'] for row in comparison['versions']) == f.PINS, 'Missing pin comparisons')
                outcomes = []
                for pin in f.PINS:
                    path = directory / 'results' / ('browser-' + pin[:7] + '.json')
                    console = directory / 'results' / ('console-' + pin[:7] + '.log')
                    result = json.loads(path.read_text())
                    require(console.is_file() and result['stackRevision'] == pin and type(result['ok']) is bool
                            and result['sourceRevision'] == report['checkout']['diagnosticRevision'], 'Incomplete browser evidence')
                    require(('compiledStack' in result) == compiled, 'Wrong replay mode')
                    require(result.get('runtimeBuild', {}).get('manifestSha256') == report['mixedRuntime']['manifest']['sha256'],
                            'Browser did not bind the diagnostic runtime manifest')
                    served = [row for row in result.get('servedAssets', []) if row.get('path') == '/libecl.so']
                    require(all(row.get('sha256') == expected_module['sha256']
                                and row.get('fileBytes') == expected_module['bytes']
                                and row.get('pinVerified') is True for row in served),
                            'Browser served a different libecl module')
                    console_text = console.read_text()
                    failures = f.runtime_failures(result, console_text)
                    raw = str(result.get('stdout', '')) + '\n' + console_text
                    events = re.findall(r'CTM-GC-DIAG\|event=([^|\r\n]+)', raw)
                    event_counts = {event: events.count(event) for event in sorted(set(events))}
                    outcomes.append({'stackRevision': pin, 'ok': result['ok'], 'error': result.get('error'),
                                     **failures, 'instrumentedModuleServed': bool(served),
                                     'servedInstrumentedModule': served, 'gcDiagnosticEventCounts': event_counts,
                                     'instrumentationObserved': bool(served) and bool(events),
                                     'browserReport': record(path), 'console': record(console)})
                attempt['outcomes'] = outcomes
                attempt['comparison'] = record(directory / 'comparison/latest.json')
                attempt['parityPassed'] = (attempt['browserCommand']['exitCode'] == 0
                                          and attempt['comparisonCommand']['exitCode'] == 0
                                          and comparison['status'] == 'passed'
                                          and all(row['passed'] is True for row in comparison['versions'])
                                          and all(row['ok'] and not row['fatalRuntimeFailure']
                                                  and row['instrumentedModuleServed'] for row in outcomes))
                require(not attempt['browserCommand']['outerTimeout'], 'Outer replay deadline expired')
                f.verify_inputs(provenance['inventory'])
                require(verify_mixed(f) == report['mixedRuntime'] and record(index_path) == report['rebasedIndex'], 'Diagnostic inputs changed')
                require(checkout_binding() == report['checkout'], 'Checkout changed')
                attempt['evidenceComplete'] = True
            except Exception as error:
                attempt['collectorFailure'] = str(error)
                if scratch.exists() and not (directory / 'results').exists():
                    shutil.copytree(scratch, directory / 'results')
            finally:
                if scratch.exists():
                    shutil.rmtree(scratch)
                report['attempts'].append(attempt)
                save(OUT / 'report.json', report)
                print(json.dumps({'finished': name, 'evidenceComplete': attempt['evidenceComplete'], 'parityPassed': attempt['parityPassed']}), flush=True)
        report['evidenceComplete'] = len(report['attempts']) == len(f.PLAN) and all(row['evidenceComplete'] for row in report['attempts'])
        report['parityPassed'] = report['evidenceComplete'] and all(row['parityPassed'] for row in report['attempts'])
        report['instrumentationObservedInEveryOutcome'] = report['evidenceComplete'] and all(
            row['instrumentationObserved'] for attempt in report['attempts'] for row in attempt['outcomes'])
    except Exception as error:
        report['collectorFailure'] = str(error)
    report['files'] = [{'path': path.relative_to(OUT).as_posix(), **record(path)}
                       for path in sorted(OUT.rglob('*')) if path.is_file() and path != OUT / 'report.json']
    save(OUT / 'report.json', report)
    print(json.dumps({key: report[key] for key in ('diagnosticOnly', 'evidenceComplete', 'parityPassed', 'acceptance')}), flush=True)
    return 0 if report['evidenceComplete'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('download', 'compiler', 'replay'))
    args = parser.parse_args()
    raise SystemExit({'download': download, 'compiler': compiler_evidence, 'replay': replay}[args.phase]())
