#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fetch exact upstream sources and verify canonical/source archive SHA-256."""
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/runtime-build'
PINS = json.loads((ROOT / 'runtime/build/pins.json').read_text())

def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

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
        run('git', 'fetch', '--depth=256' if name == 'maxima' else '--depth=1', 'origin', pin['commit'], cwd=target)
        run('git', 'checkout', '--detach', pin['commit'], cwd=target)
        assert run('git', 'rev-parse', 'HEAD', cwd=target) == pin['commit']
        if name == 'maxima':
            tag = pin['tag']
            run('git', 'fetch', '--depth=256', 'origin', f"refs/tags/{tag['name']}:refs/tags/{tag['name']}", cwd=target)
            assert run('git', 'rev-parse', tag['name'], cwd=target) == tag['object']
            run('git', 'config', 'core.abbrev', '9', cwd=target)
            assert run('git', 'describe', cwd=target).replace('-', '_') == pin['version']
        spec = pin['archive']
        archive = archives / (name + ('.tar' if spec['format'] == 'git-archive-tar' else '.tar.gz'))
        if spec['format'] == 'git-archive-tar':
            run('git', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', '--prefix=' + spec['prefix'], '--output=' + str(archive), pin['commit'], cwd=target)
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
