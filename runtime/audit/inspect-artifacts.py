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
import subprocess
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


def inspect_sidecars(data, spec):
    """Decode data with trusted Node stdlib; no artifact code or paths execute."""
    prefix = '.cache/runtime-compression/artifact/'
    script = r"""
const fs=require('node:fs'),z=require('node:zlib'),c=require('node:crypto');
const [encoding,limitText]=process.argv.slice(1),limit=Number(limitText);
if(!Number.isSafeInteger(limit)||limit<1||limit>1073741824)throw Error('Invalid output bound');
const body=fs.readFileSync(0);
const decoded=encoding==='gzip'?z.gunzipSync(body,{maxOutputLength:limit}):
 encoding==='br'?z.brotliDecompressSync(body,{maxOutputLength:limit}):null;
if(!decoded)throw Error('Unsupported encoding');
process.stdout.write(JSON.stringify({node:process.version,bytes:decoded.length,
 sha256:c.createHash('sha256').update(decoded).digest('hex')}));
"""
    rows = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        manifest = json.loads(archive.read(prefix + 'compression-manifest.json'))
        assert manifest['schema'] == 1 and manifest['files']
        names = set(archive.namelist())
        seen = set()
        for row in manifest['files']:
            raw_path = row['rawPath']
            assert isinstance(raw_path, str) and raw_path and not PurePosixPath(raw_path).is_absolute()
            assert '..' not in PurePosixPath(raw_path).parts and '\\' not in raw_path
            raw = archive.read(prefix + raw_path)
            assert len(raw) == row['bytes'] and sha(raw) == row['sha256']
            for encoding, encoded in row['encodings'].items():
                path = encoded['path']
                assert encoding in ('gzip', 'br') and path.startswith('compressed/')
                assert '..' not in PurePosixPath(path).parts and '\\' not in path
                assert path not in seen
                seen.add(path)
                body = archive.read(prefix + path)
                assert len(body) == encoded['bytes'] and sha(body) == encoded['sha256']
                result = subprocess.run(['node', '-e', script, encoding, str(max(1, len(raw)))],
                                        input=body, capture_output=True, check=True, timeout=120)
                decoded = json.loads(result.stdout)
                assert decoded['bytes'] == len(raw) and decoded['sha256'] == sha(raw)
                assert encoded['decodedBytes'] == len(raw) and encoded['decodedSha256'] == sha(raw)
                rows.append({'path': path, 'encoding': encoding, 'encodedBytes': len(body),
                             'encodedSha256': sha(body), 'decodedBytes': decoded['bytes'],
                             'decodedSha256': decoded['sha256'], 'rawPath': raw_path, 'node': decoded['node']})
        actual = {p.removeprefix(prefix) for p in names if p.startswith(prefix+'compressed/') and not p.endswith('/')}
        assert actual == seen, 'Unmanifested or missing encoded sidecar'
        wasm = archive.read(prefix + 'runtime/maxima.wasm')
        assert len(wasm) >= 108
        return [{'kind': 'sidecar-decoding', 'artifact': spec['id'], 'files': rows,
                 'range': {'path': 'runtime/maxima.wasm', 'start': 17, 'endInclusive': 107,
                           'bytes': 91, 'sha256': sha(wasm[17:108])}}]


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
            if spec.get('verifySidecars', False):
                records += inspect_sidecars(data, spec)
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

