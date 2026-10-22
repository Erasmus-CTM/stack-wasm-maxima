#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Use the already pinned SDK Node archive, verifying before fresh extraction."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/runtime-compression'

def main():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('Pinned compression toolchain targets Linux x86_64')
    pins = json.loads((ROOT / 'runtime/build/pins.json').read_text())
    pin = next(row for row in pins['toolchainArchives'] if row['name'] == 'sdk-node-linux-x86_64')
    archive = WORK / 'downloads' / pin['file']
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        temporary = archive.with_suffix('.partial')
        with urllib.request.urlopen(pin['url'], timeout=180) as response, temporary.open('wb') as output:
            count = 0
            while part := response.read(1024 * 1024):
                count += len(part)
                if count > pin['bytes']:
                    raise ValueError('Node archive exceeds its pinned size')
                output.write(part)
        candidate = temporary
    else:
        candidate = archive
    digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    if candidate.stat().st_size != pin['bytes'] or digest != pin['sha256']:
        raise ValueError('Node archive size/hash mismatch before extraction')
    if candidate != archive:
        candidate.replace(archive)
    target = (WORK / 'node').resolve()
    if target.parent != WORK.resolve() or (WORK / 'node').is_symlink():
        raise ValueError('Unsafe extraction directory')
    if target.exists():
        shutil.rmtree(target)
    target.mkdir()
    with tarfile.open(archive, 'r:xz') as package:
        package.extractall(target, filter='data')
    executable = next(target.glob('*/bin/node'))
    licence = executable.parent.parent / 'LICENSE'
    metadata = {**pin, 'verified':True, 'executableSha256':hashlib.sha256(executable.read_bytes()).hexdigest(),
                'licenceSha256':hashlib.sha256(licence.read_bytes()).hexdigest()}
    shutil.copy2(licence, WORK / 'NODE-TOOL-LICENSE')
    (WORK / 'node-provenance.json').write_text(json.dumps(metadata, indent=2)+'\n')
    if destination := os.environ.get('GITHUB_PATH'):
        with open(destination, 'a') as output:
            output.write(str(executable.parent)+'\n')
    print(json.dumps(metadata))

if __name__ == '__main__':
    main()
