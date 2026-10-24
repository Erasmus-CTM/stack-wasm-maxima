#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Collect bounded exact-artifact replays; never confer production acceptance."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.cache/mark-stack-replay'
FROZEN = OUT / 'frozen'
REPO = 'Erasmus-CTM/stack-wasm-maxima'
API = 'https://api.github.com/repos/' + REPO
BASE = '6d3735dd480bd50753d3ba7efc01636c7d269d8a'
TESTED = '580019b25ae0be764fae181066c932ff499c0865'
CTM_PIN = '9e042dc5e57a1636be64ca5d08910c9af5ff1371'
PINS = ('10d323311b7f39fb7b092dd10ce75f7d8632f525',
        '33383047af39c204bf4442802a058f8b918b2b1b')
ADDITIONS = {'.github/workflows/mark-stack-diagnostic.yml',
             'runtime/diagnostics/mark-stack-replay.py'}
SPEC = {'id': 12546163663, 'run': 40051138492, 'workflow': 394101239,
        'head': BASE, 'attempt': 1, 'conclusion': 'failure',
        'name': 'precompiled-stack-probe-baseline-' + TESTED,
        'bytes': 213107042,
        'sha256': 'bcefb37577cbe56d30086551d1192198be6427eac1206e5784074899c2ea2647'}
RUNTIME = '.cache/runtime-build/artifact'
PROBES = '.cache/precompiled-probes'
PREPARED = 'test-results/milestone-one/prepared.json'
NATIVES = tuple('test-results/milestone-one/native-' + pin[:7] + '.json' for pin in PINS)
PROBE_FILES = {PROBES + '/index.json'} | {
    PROBES + '/' + pin + '/' + name for pin in PINS for name in
    ('stack-sources.json', 'stack-sources-timed-source.json',
     'stack-sources-precompiled.json', 'maxima-runtime/stackmaxima.fas')}
EXACT_FILES = PROBE_FILES | {PREPARED, *NATIVES}
ORIGINAL_ROOT = '/home/runner/work/stack-wasm-maxima/stack-wasm-maxima/'
MAX_ZIP = 512 * 1024**2
MAX_TOTAL = 2 * 1024**3
MAX_MEMBER = 512 * 1024**2
# Unchanged run.mjs opens a fresh browser, then one fresh context/worker per pin.
# Its two-pin prepared/index contract is deliberately retained in every run.
PLAN = (('01-compiled', True), ('02-source', False), ('03-compiled', True))
OUTER_TIMEOUT = 400  # Two existing 180-second per-pin watchdogs plus teardown.


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def record(path):
    body = path.read_bytes()
    return {'bytes': len(body), 'sha256': digest(body)}


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def safe_path(name):
    path = PurePosixPath(name)
    require(isinstance(name, str) and name and '\\' not in name and '\0' not in name
            and not path.is_absolute() and ':' not in name
            and all(part not in ('', '.', '..') for part in name.rstrip('/').split('/'))
            and path.as_posix() == name.rstrip('/'), 'Unsafe archive path: ' + repr(name))
    return path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(path, download=False):
    request = urllib.request.Request(API + path, headers={
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
        'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=120) as response:
            body = response.read(4 * 1024**2 + 1)
            require(len(body) <= 4 * 1024**2, 'Oversize API metadata')
            require(not download, 'Expected a separate artifact-storage redirect')
            return json.loads(body)
    except urllib.error.HTTPError as error:
        if not download or error.code != 302:
            raise
        url = error.headers['Location']
        parsed = urllib.parse.urlsplit(url)
        require(parsed.scheme == 'https' and not parsed.username and not parsed.password
                and parsed.port in (None, 443) and parsed.hostname
                and parsed.hostname.endswith(('.blob.core.windows.net', '.githubusercontent.com', '.s3.amazonaws.com')),
                'Unapproved artifact storage redirect')
        # This new request has no API authorization header; further redirects fail.
        with opener.open(urllib.request.Request(url), timeout=120) as response:
            body = response.read(MAX_ZIP + 1)
        require(len(body) <= MAX_ZIP, 'Oversize artifact archive')
        return body


def metadata():
    run = api('/actions/runs/' + str(SPEC['run']))
    require(run['repository']['full_name'] == run['head_repository']['full_name'] == REPO,
            'Wrong source repository')
    for key, expected in [('id', SPEC['run']), ('head_sha', BASE), ('workflow_id', SPEC['workflow']),
                          ('run_attempt', 1), ('status', 'completed'), ('conclusion', 'failure')]:
        require(run[key] == expected, 'Wrong frozen run ' + key)
    artifact = api('/actions/artifacts/' + str(SPEC['id']))
    for key, expected in [('id', SPEC['id']), ('name', SPEC['name']), ('expired', False),
                          ('size_in_bytes', SPEC['bytes']), ('digest', 'sha256:' + SPEC['sha256'])]:
        require(artifact[key] == expected, 'Wrong frozen artifact ' + key)
    require(artifact['workflow_run']['id'] == SPEC['run']
            and artifact['workflow_run']['head_sha'] == BASE, 'Wrong artifact run binding')
    require(artifact['created_at'] >= run['run_started_at'], 'Artifact predates this run')
    return {'run': {key: run[key] for key in ('id', 'head_sha', 'workflow_id', 'run_attempt',
                                             'status', 'conclusion', 'run_started_at')},
            'artifact': {key: artifact[key] for key in ('id', 'name', 'expired', 'size_in_bytes',
                                                       'digest', 'created_at', 'workflow_run')}}


def checkout_binding():
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    require(not os.environ.get('GITHUB_SHA') or os.environ['GITHUB_SHA'] == head,
            'CI revision differs from checkout')
    changes = subprocess.check_output(['git', 'diff', '--name-status', BASE, 'HEAD'], cwd=ROOT, text=True)
    require(set(changes.splitlines()) == {'A\t' + name for name in ADDITIONS},
            'Diagnostic must add only its two files to the frozen product head')
    require(subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=ROOT).returncode == 0,
            'Tracked checkout changed')
    return {'diagnosticRevision': head, 'productRevision': BASE, 'testedMerge': TESTED,
            'tree': subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT, text=True).strip()}


def unpack(body):
    require(len(body) == SPEC['bytes'] and digest(body) == SPEC['sha256'], 'Frozen ZIP identity differs')
    FROZEN.mkdir(parents=True, exist_ok=False)
    inventory, seen, total = [], set(), 0
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        require(len(archive.infolist()) <= 25000, 'Too many archive entries')
        for member in archive.infolist():
            name = member.filename
            path = safe_path(name)
            require(member.orig_filename == name and path.as_posix() not in seen, 'Duplicate or truncated ZIP path')
            seen.add(path.as_posix())
            mode = stat.S_IFMT(member.external_attr >> 16)
            require(mode in (0, stat.S_IFREG, stat.S_IFDIR) and not member.flag_bits & 1,
                    'Special or encrypted ZIP member')
            require(member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'Unknown ZIP compression')
            require(member.file_size <= MAX_MEMBER
                    and member.file_size <= max(1024**2, member.compress_size * 2000), 'ZIP member expansion limit')
            total += member.file_size
            require(total <= MAX_TOTAL, 'ZIP total expansion limit')
            if member.is_dir():
                require(member.file_size == 0, 'Directory contains data')
                continue
            selected = name.startswith(RUNTIME + '/') or name in EXACT_FILES
            target = FROZEN / path
            require(target.resolve().is_relative_to(FROZEN.resolve()), 'Escaping extraction path')
            if selected:
                target.parent.mkdir(parents=True, exist_ok=True)
            output = target.open('xb') if selected else None
            hasher, size = hashlib.sha256(), 0
            try:
                with archive.open(member) as source:
                    while chunk := source.read(1024**2):
                        size += len(chunk)
                        require(size <= member.file_size, 'Unexpected ZIP length')
                        hasher.update(chunk)
                        if output:
                            output.write(chunk)
            finally:
                if output:
                    output.close()
            require(size == member.file_size, 'Incomplete ZIP member')
            inventory.append({'path': name, 'bytes': size, 'sha256': hasher.hexdigest(), 'selected': selected})
    require(EXACT_FILES <= {row['path'] for row in inventory if row['selected']}, 'Missing frozen probe inputs')
    return inventory


def verify_inputs(inventory):
    selected = {row['path']: row for row in inventory if row['selected']}
    actual = {p.relative_to(FROZEN).as_posix() for p in FROZEN.rglob('*') if p.is_file()}
    require(actual == set(selected), 'Frozen extracted inventory differs')
    for name, row in selected.items():
        require(record(FROZEN / name) == {key: row[key] for key in ('bytes', 'sha256')}, 'Changed frozen input: ' + name)
    runtime = FROZEN / RUNTIME
    delivered = json.loads((runtime / 'artifact-manifest.json').read_text())['files']
    require(len({row['path'] for row in delivered}) == len(delivered), 'Duplicate delivered runtime record')
    require({row['path'] for row in delivered} == {
        p.relative_to(runtime).as_posix() for p in runtime.rglob('*')
        if p.is_file() and p != runtime / 'artifact-manifest.json'}, 'Incomplete runtime artifact')
    for row in delivered:
        safe_path(row['path'])
        require(record(runtime / row['path']) == {key: row[key] for key in ('bytes', 'sha256')}, 'Runtime manifest mismatch')
    manifest = json.loads((runtime / 'manifest.json').read_text())
    require(manifest['recipe']['revision'] == TESTED and manifest['compilerProfile']['name'] == 'baseline',
            'Wrong frozen runtime recipe/profile')
    for row in manifest['recipe']['files']:
        safe_path(row['path'])
        require(record(ROOT / row['path']) == {key: row[key] for key in ('bytes', 'sha256')},
                'Product recipe differs from the failed run: ' + row['path'])
    prepared = json.loads((FROZEN / PREPARED).read_text())
    require(prepared['ctmCheckersRevision'] == CTM_PIN and len(prepared['cases']) == 22
            and tuple(v['stackRevision'] for v in prepared['versions']) == PINS, 'Wrong frozen official cases/pins')
    for version, native in zip(prepared['versions'], NATIVES, strict=True):
        require(version['native'] == json.loads((FROZEN / native).read_text()), 'Frozen native reference differs')
        require(':lisp (trace maxima::$load)\n' in version['batch'], 'Original load tracing was changed')
    index = json.loads((FROZEN / PROBES / 'index.json').read_text())
    require(index['officialPrepared'] == record(FROZEN / PREPARED), 'Prepared-byte binding differs')
    require(index['schema'] == 1 and tuple(row['stackRevision'] for row in index['pins']) == PINS,
            'Wrong original compiled index pins')
    for row in index['pins']:
        pin = row['stackRevision']
        manifest_name = PROBES + '/' + pin + '/stack-sources-precompiled.json'
        bundle_name = PROBES + '/' + pin + '/maxima-runtime/stackmaxima.fas'
        require(row['manifest']['path'] == ORIGINAL_ROOT + manifest_name
                and row['bundlePath'] == ORIGINAL_ROOT + bundle_name, 'Unexpected original index filesystem path')
        require(record(FROZEN / manifest_name) == {key: row['manifest'][key] for key in ('bytes', 'sha256')},
                'Compiled manifest bytes differ')
        asset = row['compiledStack']['asset']
        require(record(FROZEN / bundle_name) == {'bytes': asset['fileBytes'], 'sha256': asset['sha256']},
                'Frozen FAS bytes differ')
    return prepared, index


def rebase_index(index):
    """Return only a filesystem-path derivation, preserving all original bindings.

    Other isolated diagnostics may call metadata(), api(..., download=True),
    unpack(), verify_inputs() and this function under their own checkout guard.
    They must retain the original provenance/inventory and identify any later
    runtime substitution separately; default download/replay permits none.
    """
    derived = json.loads(json.dumps(index))
    require(tuple(row['stackRevision'] for row in derived['pins']) == PINS, 'Wrong index pins')
    for row in derived['pins']:
        relative = PROBES + '/' + row['stackRevision']
        manifest = relative + '/stack-sources-precompiled.json'
        bundle = relative + '/maxima-runtime/stackmaxima.fas'
        require(row['manifest']['path'] == ORIGINAL_ROOT + manifest
                and row['bundlePath'] == ORIGINAL_ROOT + bundle, 'Unexpected index path for rebasing')
        row['manifest']['path'] = str(FROZEN / manifest)
        row['bundlePath'] = str(FROZEN / bundle)
    return derived


def download():
    OUT.mkdir(parents=True, exist_ok=False)
    provenance = {'schema': 1, 'diagnosticOnly': True, 'spec': SPEC, 'downloadComplete': False}
    try:
        provenance['checkout'] = checkout_binding()
        provenance['before'] = metadata()
        body = api('/actions/artifacts/' + str(SPEC['id']) + '/zip', download=True)
        provenance['after'] = metadata()
        require(provenance['before'] == provenance['after'], 'Frozen run/artifact metadata changed')
        provenance['inventory'] = unpack(body)
        verify_inputs(provenance['inventory'])
        provenance['downloadComplete'] = True
    except Exception as error:
        provenance['failure'] = str(error)
    save(OUT / 'provenance.json', provenance)
    print(json.dumps({'downloadComplete': provenance['downloadComplete'], 'failure': provenance.get('failure')}), flush=True)
    return 0 if provenance['downloadComplete'] else 1


def execute(command, directory, env, timeout):
    directory.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with (directory / 'stdout.log').open('wb') as stdout, (directory / 'stderr.log').open('wb') as stderr:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        timed_out = False
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait(timeout=15)
    return {'command': command, 'exitCode': code, 'outerTimeout': timed_out,
            'elapsedSeconds': time.monotonic() - started,
            'stdout': record(directory / 'stdout.log'), 'stderr': record(directory / 'stderr.log')}


def runtime_failures(result, console_text):
    """Retain fatal evidence even if a protocol marker preceded a late abort."""
    raw = result.get('stdout', '') + '\n' + str(result.get('error') or '') + '\n' + console_text
    mark_overflow = 'Unexpected mark stack overflow' in raw
    native_abort = mark_overflow or bool(re.search(r'native code called abort|Aborted\(', raw))
    fatal = native_abort or any(text in raw for text in (
        'RuntimeError: unreachable', 'memory access out of bounds', 'Maximum call stack size exceeded'))
    return {'markStackOverflow': mark_overflow, 'nativeAbort': native_abort, 'fatalRuntimeFailure': fatal}


def replay():
    report = {'schema': 1, 'diagnosticOnly': True, 'evidenceComplete': False,
              'parityPassed': False, 'acceptance': False, 'attempts': [],
              'plan': [{'name': name, 'compiled': compiled, 'pins': list(PINS)} for name, compiled in PLAN],
              'scope': 'Frozen failed baseline artifact, unchanged official two-pin harness and 180-second per-pin watchdog. Three fixed fresh-browser invocations; each pin uses a fresh context/worker. Native controls were prepared in the original run. No rebuild, production acceptance, statistical frequency estimate or speedup claim.',
              'trustBoundaries': ['The source artifact comes from a failed workflow; its exact bytes are diagnostic inputs, not an accepted runtime.',
                                  'The only derived input is the index filesystem-path rebasing; prepared/source/manifest/FAS bytes and load tracing stay exact.',
                                  'Every planned attempt is retained. A successful collector means complete evidence, even if every compiled replay fails.',
                                  'Original messageTrace is bounded by the unchanged harness; raw stdout and browser console logs are retained.']}
    scratch = ROOT / 'test-results/milestone-one'
    try:
        report['checkout'] = checkout_binding()
        require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'), 'Browser stage inherited a GitHub token')
        require(subprocess.check_output(['node', '--version'], text=True).strip() == 'v22.16.0', 'Wrong Node runtime')
        require(subprocess.check_output(['git', '-C', str(ROOT / '.ctm-checkers-source'), 'rev-parse', 'HEAD'], text=True).strip() == CTM_PIN,
                'Wrong official native parser checkout')
        require(subprocess.run(['git', '-C', str(ROOT / '.ctm-checkers-source'), 'diff', '--quiet', 'HEAD', '--']).returncode == 0,
                'Official native parser checkout changed')
        provenance = json.loads((OUT / 'provenance.json').read_text())
        require(provenance['downloadComplete'] is True and provenance['spec'] == SPEC, 'Incomplete frozen download')
        prepared, index = verify_inputs(provenance['inventory'])
        report['provenanceSha256'] = record(OUT / 'provenance.json')['sha256']
        report['originalIndex'] = record(FROZEN / PROBES / 'index.json')
        index_path = OUT / 'inputs/rebased-probe-index.json'
        save(index_path, rebase_index(index))
        report['rebasedIndex'] = record(index_path)
        report['frozenRuntimeManifest'] = record(FROZEN / RUNTIME / 'manifest.json')
        report['officialPrepared'] = record(FROZEN / PREPARED)
        report['bundles'] = [{'stackRevision': row['stackRevision'], **row['compiledStack']['asset']}
                             for row in index['pins']]
        env = {key: value for key, value in os.environ.items() if key not in ('GH_TOKEN', 'GITHUB_TOKEN')}
        env.update(CTM_MAXIMA_RUNTIME_SOURCE=str(FROZEN / RUNTIME), CTM_ECL_COMPILER_PROFILE='baseline')
        # Invoke the same production input validators before starting any browser.
        preflight = "import {readFile} from 'node:fs/promises';import {compiledProbeInputs} from './runtime/precompiled/probe-inputs.mjs';import {loadOwnedRuntime} from './runtime/build/runtime-source.mjs';await loadOwnedRuntime(process.env.CTM_MAXIMA_RUNTIME_SOURCE,process.cwd());const p=await readFile(process.argv[2]);const result=await compiledProbeInputs(process.argv[1],p);if(result.size!==2)throw Error('Expected two pins');console.log('CTM-FROZEN-PREFLIGHT-OK');"
        report['preflight'] = execute(['node', '--input-type=module', '-e', preflight, str(index_path), str(FROZEN / PREPARED)],
                                      OUT / 'preflight', env, 60)
        require(report['preflight']['exitCode'] == 0, 'Frozen input preflight failed')
        require(not scratch.exists(), 'Refuse to overwrite existing official-probe output')
        for name, compiled in PLAN:
            directory = OUT / 'attempts' / name
            attempt = {'name': name, 'compiled': compiled, 'evidenceComplete': False, 'parityPassed': False}
            print(json.dumps({'starting': name, 'pins': PINS, 'perPinWatchdogMs': 180000}), flush=True)
            try:
                verify_inputs(provenance['inventory'])
                scratch.mkdir(parents=True)
                for path in (PREPARED, *NATIVES):
                    shutil.copyfile(FROZEN / path, scratch / Path(path).name)
                attempt_env = dict(env)
                attempt_env['MILESTONE_ONE_REPORT_ROOT'] = str(directory / 'comparison')
                if compiled:
                    attempt_env['CTM_PRECOMPILED_PROBE_INDEX'] = str(index_path)
                else:
                    attempt_env.pop('CTM_PRECOMPILED_PROBE_INDEX', None)
                attempt['browserCommand'] = execute(['node', 'scripts/milestone-one/run.mjs'],
                                                    directory / 'browser-process', attempt_env, OUTER_TIMEOUT)
                attempt['comparisonCommand'] = execute([sys.executable, 'scripts/milestone-one/compare.py'],
                                                       directory / 'compare-process', attempt_env, 60)
                shutil.copytree(scratch, directory / 'results')
                comparison = json.loads((directory / 'comparison/latest.json').read_text())
                require(len(comparison['versions']) == 2 and tuple(row['stackRevision'] for row in comparison['versions']) == PINS,
                        'Comparison did not retain both pin outcomes')
                outcomes = []
                for pin in PINS:
                    result = json.loads((directory / 'results' / ('browser-' + pin[:7] + '.json')).read_text())
                    console_path = directory / 'results' / ('console-' + pin[:7] + '.log')
                    require(console_path.is_file() and result['stackRevision'] == pin
                            and type(result['ok']) is bool and result['sourceRevision'] == report['checkout']['diagnosticRevision'],
                            'Incomplete browser evidence')
                    require(('compiledStack' in result) == compiled, 'Wrong replay mode')
                    outcomes.append({'stackRevision': pin, 'ok': result['ok'], 'error': result.get('error'),
                                     **runtime_failures(result, console_path.read_text()),
                                     'browserReport': record(directory / 'results' / ('browser-' + pin[:7] + '.json')),
                                     'console': record(console_path)})
                attempt['outcomes'] = outcomes
                attempt['comparison'] = record(directory / 'comparison/latest.json')
                attempt['parityPassed'] = (attempt['browserCommand']['exitCode'] == 0
                                          and attempt['comparisonCommand']['exitCode'] == 0
                                          and comparison['status'] == 'passed'
                                          and all(row['passed'] is True for row in comparison['versions'])
                                          and all(row['ok'] is True and not row['fatalRuntimeFailure'] for row in outcomes))
                require(not attempt['browserCommand']['outerTimeout'], 'Outer replay deadline expired')
                verify_inputs(provenance['inventory'])
                require(record(index_path) == report['rebasedIndex'], 'Rebased index changed during replay')
                require(checkout_binding() == report['checkout'], 'Diagnostic checkout changed during replay')
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
                print(json.dumps({'finished': name, 'evidenceComplete': attempt['evidenceComplete'],
                                  'parityPassed': attempt['parityPassed'], 'collectorFailure': attempt.get('collectorFailure')}), flush=True)
        report['evidenceComplete'] = len(report['attempts']) == len(PLAN) and all(x['evidenceComplete'] for x in report['attempts'])
        report['parityPassed'] = report['evidenceComplete'] and all(x['parityPassed'] for x in report['attempts'])
    except Exception as error:
        report['collectorFailure'] = str(error)
    report['files'] = [{'path': p.relative_to(OUT).as_posix(), **record(p)} for p in sorted(OUT.rglob('*'))
                       if p.is_file() and p != OUT / 'report.json']
    save(OUT / 'report.json', report)
    print(json.dumps({key: report[key] for key in ('diagnosticOnly', 'evidenceComplete', 'parityPassed', 'acceptance')}), flush=True)
    return 0 if report['evidenceComplete'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('download', 'replay'))
    args = parser.parse_args()
    raise SystemExit(download() if args.phase == 'download' else replay())
