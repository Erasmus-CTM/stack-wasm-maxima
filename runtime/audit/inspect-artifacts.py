#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Read pinned GitHub artifact ZIPs; emit hash-bound evidence, never execute it."""
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import PurePosixPath, Path
import secrets
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = 'Erasmus-CTM/stack-wasm-maxima'
API = 'https://api.github.com/repos/' + REPO
MAX_ZIP = 2 * 1024**3
MAX_TOTAL = 4 * 1024**3
MAX_ENTRY = 1024**3
MAX_LOG = 12 * 1024**2


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(path, redirect=False):
    request = urllib.request.Request(API + path, headers={
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'})
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if redirect and error.code == 302:
            url = error.headers['Location']
            parsed = urllib.parse.urlsplit(url)
            assert parsed.scheme == 'https' and not parsed.username and not parsed.password
            assert parsed.hostname.endswith(('.blob.core.windows.net', '.githubusercontent.com', '.s3.amazonaws.com'))
            # Deliberately create a second request without the GitHub token.
            with urllib.request.urlopen(url, timeout=120) as response:
                data = response.read(MAX_ZIP + 1)
                assert len(data) <= MAX_ZIP, 'Oversized ZIP'
                return data
        raise


def sha(body):
    return hashlib.sha256(body).hexdigest()


def validate_metadata(spec):
    run = api('/actions/runs/' + str(spec['run']))
    assert run['repository']['full_name'] == REPO
    assert run['head_repository']['full_name'] == REPO
    for key, expected in [('head_sha', spec['head']), ('workflow_id', spec['workflow']),
                          ('run_attempt', spec['attempt']), ('status', 'completed'),
                          ('conclusion', spec['conclusion'])]:
        assert run[key] == expected, (key, run[key], expected)
    artifact = api('/actions/artifacts/' + str(spec['id']))
    assert artifact['id'] == spec['id'] and artifact['name'] == spec['name']
    assert not artifact['expired'] and artifact['digest'] == 'sha256:' + spec['sha256']
    assert artifact['workflow_run']['id'] == spec['run']
    assert artifact['workflow_run']['head_sha'] == spec['head']
    assert artifact['created_at'] >= run['run_started_at']
    return run, artifact


def inspect_zip(data, spec):
    assert sha(data) == spec['sha256'], 'ZIP digest mismatch'
    found = set()
    inventory = []
    payloads = []
    total = 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        assert len(entries) <= 25000
        for entry in entries:
            path = PurePosixPath(entry.filename)
            assert entry.filename not in found, 'Duplicate ZIP path'
            found.add(entry.filename)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in entry.filename
            assert not entry.flag_bits & 1, 'Encrypted entry'
            assert not stat.S_ISLNK(entry.external_attr >> 16), 'Symlink entry'
            assert entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            assert entry.file_size <= MAX_ENTRY
            assert entry.file_size <= max(1024**2, entry.compress_size * 2000), 'Excessive compression ratio'
            total += entry.file_size
            assert total <= MAX_TOTAL
            if entry.is_dir():
                continue
            hasher = hashlib.sha256()
            body = bytearray() if entry.filename in spec['files'] else None
            with archive.open(entry) as source:
                while chunk := source.read(1024**2):
                    hasher.update(chunk)
                    if body is not None:
                        assert len(body) + len(chunk) <= 16 * 1024**2, 'Evidence entry too large'
                        body.extend(chunk)
            row = {'path': entry.filename, 'bytes': entry.file_size, 'sha256': hasher.hexdigest()}
            inventory.append(row)
            if body is not None:
                if entry.filename.endswith('.json'):
                    json.loads(body)
                payloads.append({**row, 'gzipBase64': base64.b64encode(gzip.compress(bytes(body), mtime=0)).decode()})
    assert set(spec['files']) <= {row['path'] for row in inventory}, 'Required evidence missing: ' + json.dumps(sorted(set(spec['files']) - {row['path'] for row in inventory}))
    records = [{'kind': 'inventory', 'artifact': spec['id'], 'files': inventory}]
    records += [{'kind': 'file', 'artifact': spec['id'], **row} for row in payloads]
    return records


def main():
    specs = json.loads(Path(sys.argv[1]).read_text())
    output_bytes = 0
    token = secrets.token_hex(24)
    print('::stop-commands::' + token, flush=True)
    try:
        for spec in specs:
            run, artifact = validate_metadata(spec)
            data = api('/actions/artifacts/' + str(spec['id']) + '/zip', redirect=True)
            records = inspect_zip(data, spec)
            after_run, after_artifact = validate_metadata(spec)
            assert after_run['run_attempt'] == run['run_attempt']
            assert after_artifact == artifact
            provenance = {'kind': 'provenance', **spec, 'zipBytes': len(data),
                          'runStartedAt': run['run_started_at'], 'artifactCreatedAt': artifact['created_at']}
            for record in [provenance, *records]:
                line = json.dumps(record, separators=(',', ':'))
                output_bytes += len(line.encode())
                assert output_bytes <= MAX_LOG, 'Evidence exceeds complete log limit'
                print('CTM-AUDIT|' + line, flush=True)
        print('CTM-AUDIT-COMPLETE', flush=True)
    finally:
        print('::' + token + '::', flush=True)


if __name__ == '__main__':
    main()
