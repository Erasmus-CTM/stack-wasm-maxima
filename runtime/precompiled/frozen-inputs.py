#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Recover explicitly frozen diagnostic inputs; never current-head acceptance."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = 'Erasmus-CTM/stack-wasm-maxima'
API = 'https://api.github.com/repos/' + REPO
SPECS = {
    'baseline': {'id': 12523375986, 'run': 39989733394, 'workflow': 393419291,
        'name': 'owned-runtime-b95268be9743439e0f69e286af82ebfdd83e93e1',
        'head': 'f112f5ce47744125b21c2453f0bca84092992ec4', 'conclusion': 'success',
        'sha256': '789f03b3bae6141259352118c6b6854ec480aa25cb791f5afc7d1a476af65fe5',
        'prefix': '.cache/runtime-build/artifact/'},
    'probe': {'id': 12527328042, 'run': 40005689823, 'workflow': 394101239,
        'name': 'precompiled-stack-probe-c752992cb6b9debd9feb4c99cd43f4ab107c4777',
        'head': '4d9e4c1db35b04bc640b1a2ef1f064cc79aafc3e', 'conclusion': 'failure',
        'sha256': '4accefaf5e1b7efc2786a99cb3eef6aac533d2bada53e15321f4f6791009892e',
        'prefix': '.cache/precompiled-stack/'},
}
MAX_ZIP = 1024**3
MAX_TOTAL = 2 * 1024**3


def digest(body):
    return hashlib.sha256(body).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(path, download=False):
    request = urllib.request.Request(API + path, headers={
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if not download or error.code != 302:
            raise
        url = error.headers['Location']
        parsed = urllib.parse.urlsplit(url)
        assert parsed.scheme == 'https' and not parsed.username and not parsed.password
        assert parsed.hostname.endswith(('.blob.core.windows.net', '.githubusercontent.com', '.s3.amazonaws.com'))
        # Do not forward the GitHub token to artifact storage.
        with urllib.request.urlopen(url, timeout=120) as response:
            body = response.read(MAX_ZIP + 1)
        assert len(body) <= MAX_ZIP
        return body


def metadata(spec):
    run = api('/actions/runs/' + str(spec['run']))
    assert run['repository']['full_name'] == run['head_repository']['full_name'] == REPO
    for key, expected in [('head_sha', spec['head']), ('workflow_id', spec['workflow']),
                          ('run_attempt', 1), ('status', 'completed'), ('conclusion', spec['conclusion'])]:
        assert run[key] == expected, key
    artifact = api('/actions/artifacts/' + str(spec['id']))
    assert artifact['id'] == spec['id'] and not artifact['expired']
    assert artifact['name'] == spec['name']
    assert artifact['digest'] == 'sha256:' + spec['sha256']
    assert artifact['workflow_run']['id'] == spec['run'] and artifact['workflow_run']['head_sha'] == spec['head']
    assert artifact['created_at'] >= run['run_started_at']
    return run, artifact


def unpack(body, spec, output):
    assert digest(body) == spec['sha256'], 'Frozen archive hash differs'
    output.mkdir(parents=True, exist_ok=False)
    inventory, seen, total = [], set(), 0
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        assert len(archive.infolist()) <= 25000
        for member in archive.infolist():
            name = member.filename
            path = PurePosixPath(name)
            assert name not in seen and not path.is_absolute() and '..' not in path.parts and chr(92) not in name
            seen.add(name)
            assert not member.flag_bits & 1 and not stat.S_ISLNK(member.external_attr >> 16)
            assert member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            assert member.file_size <= 512 * 1024**2
            assert member.file_size <= max(1024**2, member.compress_size * 2000)
            total += member.file_size
            assert total <= MAX_TOTAL
            if member.is_dir():
                continue
            selected = name.startswith(spec['prefix'])
            target = output / name
            assert target.resolve().is_relative_to(output.resolve())
            if selected:
                target.parent.mkdir(parents=True, exist_ok=True)
            stream = target.open('xb') if selected else None
            hasher, size = hashlib.sha256(), 0
            try:
                with archive.open(member) as source:
                    while chunk := source.read(1024**2):
                        size += len(chunk)
                        assert size <= member.file_size
                        hasher.update(chunk)
                        if stream:
                            stream.write(chunk)
            finally:
                if stream:
                    stream.close()
            assert size == member.file_size
            inventory.append({'path': name, 'bytes': size, 'sha256': hasher.hexdigest(), 'selected': selected})
    assert any(row['selected'] for row in inventory)
    return inventory


if __name__ == '__main__':
    root = Path('.cache/precompiled-frozen-inputs')
    root.mkdir(parents=True, exist_ok=False)
    result = {'schema': 1, 'diagnosticOnly': True,
        'scope': 'Frozen separately built baseline runtime and older entry bundle; no fresh-build or current-head parity clearance',
        'inputs': {}}
    for name, spec in SPECS.items():
        before = metadata(spec)
        body = api('/actions/artifacts/' + str(spec['id']) + '/zip', download=True)
        assert metadata(spec) == before, 'Frozen artifact metadata changed'
        inventory = unpack(body, spec, root / name)
        result['inputs'][name] = {'spec': spec, 'run': before[0], 'artifact': before[1], 'inventory': inventory}
    (root / 'provenance.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'diagnosticOnly': True, 'artifacts': [s['id'] for s in SPECS.values()]}))
