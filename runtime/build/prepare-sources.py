#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fetch exact upstream sources and verify canonical/source archive SHA-256."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

from toolchain_pins import effective_pins

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/runtime-build'
PINS = effective_pins(ROOT)

def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

def fetch_source(target, *args):
    """Retry interrupted transfers, preserving exact refs and later hash checks."""
    transient = ('early eof', 'unexpected disconnect', 'connection reset',
                 'remote end hung up', 'operation timed out',
                 'requested url returned error: 500',
                 'requested url returned error: 502',
                 'requested url returned error: 503',
                 'requested url returned error: 504')
    for attempt in range(3):
        try:
            return subprocess.check_output(
                ['git', 'fetch', *args], cwd=target, text=True,
                stderr=subprocess.PIPE).strip()
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or '').lower()
            # Authentication, access denial, and missing refs need diagnosis,
            # not repeated requests. Never fall back to an existing checkout.
            if attempt == 2 or not any(marker in detail for marker in transient):
                if error.stderr:
                    print(error.stderr, file=sys.stderr, end='' if error.stderr.endswith('\n') else '\n', flush=True)
                raise
            print(f'Interrupted source fetch; retry {attempt + 2}/3', flush=True)
            time.sleep(2 ** (attempt + 1))

def preserve_source_blob_bytes(target):
    # Upstream eol=crlf attributes can rewrite LF blobs even on Linux. Keep
    # compiled Maxima/ECL inputs byte-identical to Git, without editing sources.
    attributes = target / '.git/info/attributes'
    attributes.parent.mkdir(parents=True, exist_ok=True)
    attributes.write_text('* -text\n', encoding='utf-8', newline='\n')

def canonical_git_archive(target, archive, prefix, commit):
    # git archive applies EOL attributes too. Preserve the original pinned
    # archive policy separately from the exact-blob compilation checkout.
    attributes = target / '.git/info/attributes'
    override = attributes.read_bytes() if attributes.exists() else None
    if override is not None:
        assert override == b'* -text\n'
        attributes.unlink()
    try:
        run('git', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', '--prefix=' + prefix, '--output=' + str(archive), commit, cwd=target)
    finally:
        if override is not None:
            attributes.write_bytes(override)

def main():
    archives = WORK / 'source-archives'
    archives.mkdir(parents=True, exist_ok=True)
    progress = {'schema': 1, 'sources': []}
    (WORK / 'source-progress.json').write_text(json.dumps(progress, indent=2) + '\n')
    for pin in PINS['sources']:
        name = pin['name']
        target = WORK / 'sources' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not (target / '.git').is_dir():
            target.mkdir(exist_ok=True)
            run('git', 'init', str(target))
            run('git', 'remote', 'add', 'origin', pin['repository'], cwd=target)
        run('git', 'config', 'core.autocrlf', 'false', cwd=target)
        run('git', 'config', 'core.eol', 'lf', cwd=target)
        if name in ['maxima', 'ecl']:
            preserve_source_blob_bytes(target)
        fetch_source(target, '--depth=256' if name == 'maxima' else '--depth=1', 'origin', pin['commit'])
        run('git', 'checkout', '--detach', pin['commit'], cwd=target)
        if name in ['maxima', 'ecl']:
            run('git', 'checkout-index', '-f', '-a', cwd=target)
        assert run('git', 'rev-parse', 'HEAD', cwd=target) == pin['commit']
        if name == 'maxima':
            tag = pin['tag']
            fetch_source(target, '--depth=256', 'origin', f"refs/tags/{tag['name']}:refs/tags/{tag['name']}")
            assert run('git', 'rev-parse', tag['name'], cwd=target) == tag['object']
            run('git', 'config', 'core.abbrev', '9', cwd=target)
            assert run('git', 'describe', cwd=target).replace('-', '_') == pin['version']
        spec = pin['archive']
        archive = archives / (name + ('.tar' if spec['format'] == 'git-archive-tar' else '.tar.gz'))
        if spec['format'] == 'git-archive-tar':
            canonical_git_archive(target, archive, spec['prefix'], pin['commit'])
        elif not archive.is_file():
            with urllib.request.urlopen(spec['url'], timeout=180) as response:
                archive.write_bytes(response.read(256 * 1024 * 1024 + 1))
        assert archive.stat().st_size <= 256 * 1024 * 1024
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        progress['sources'].append({'name': name, 'commit': pin['commit'], 'bytes': archive.stat().st_size, 'expectedSha256': spec['sha256'], 'observedSha256': digest, 'verified': digest == spec['sha256']})
        (WORK / 'source-progress.json').write_text(json.dumps(progress, indent=2) + '\n')
        if digest != spec['sha256']:
            raise ValueError(f'{name} source archive hash differs: {digest} != {spec["sha256"]}')
        print(json.dumps({'source': name, 'commit': pin['commit'], 'archiveSha256': digest}), flush=True)
    (WORK / 'source-manifest.json').write_text(json.dumps(PINS, indent=2) + '\n')

if __name__ == '__main__':
    main()
