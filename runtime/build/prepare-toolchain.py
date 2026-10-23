#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Verify actual SDK/Node archive bytes before the installer can extract/use them."""
import hashlib
import json
from pathlib import Path
import platform
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/runtime-build'

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()

def main():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('This pinned SDK binary set targets Linux x86_64 only')
    pins = json.loads((ROOT / 'runtime/build/pins.json').read_text())
    sdk = (WORK / 'sources/emsdk').resolve()
    if not sdk.is_relative_to(WORK.resolve()):
        raise ValueError('SDK directory escapes build workspace')
    downloads = sdk / 'downloads'
    downloads.mkdir(parents=True, exist_ok=True)
    observed = []
    try:
        for pin in pins['toolchainArchives']:
            target = downloads / pin['file']
            if not target.is_file():
                temporary = target.with_suffix(target.suffix + '.partial')
                with urllib.request.urlopen(pin['url'], timeout=180) as response, temporary.open('wb') as output:
                    count = 0
                    while part := response.read(1024 * 1024):
                        count += len(part)
                        if count > pin['bytes']:
                            raise ValueError('Tool archive exceeds pinned byte count: ' + pin['name'])
                        output.write(part)
                candidate = temporary
            else:
                candidate = target
            record = {**pin, 'observedBytes':candidate.stat().st_size, 'observedSha256':digest(candidate)}
            record['verified'] = record['observedBytes'] == pin['bytes'] and record['observedSha256'] == pin['sha256']
            observed.append(record)
            if not record['verified']:
                raise ValueError('Tool archive hash/size mismatch: ' + pin['name'])
            if candidate != target:
                candidate.replace(target)
            print(json.dumps(record), flush=True)
        # Cache only verified compressed archives, not extracted executable trees.
        # Force a fresh extraction on every run, including local reruns/cache hits.
        for name in ('upstream', 'node'):
            target = sdk / name
            if not sdk.is_relative_to(WORK.resolve()) or target.parent != sdk or target.is_symlink():
                raise ValueError('Unsafe SDK extraction cleanup path')
            if target.exists():
                shutil.rmtree(target)
    finally:
        logs = WORK / 'logs'
        logs.mkdir(parents=True, exist_ok=True)
        (logs / 'toolchain-archives.json').write_text(json.dumps({'schema':1,'archives':observed}, indent=2) + '\n')

if __name__ == '__main__':
    main()
