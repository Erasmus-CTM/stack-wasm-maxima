#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Apply separately pinned build-only patches after original source verification."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/runtime-build'

def main():
    pins = json.loads((ROOT / 'runtime/build/pins.json').read_text())
    sources = {source['name']: source for source in pins['sources']}
    observed = []
    try:
        for patch in pins.get('buildPatches', []):
            source = WORK / 'sources' / patch['source']
            revision = subprocess.check_output(['git','rev-parse','HEAD'], cwd=source, text=True).strip()
            if revision != sources[patch['source']]['commit']:
                raise ValueError('Build patch source is not its exact pinned revision')
            subprocess.run(['git','diff','--exit-code'], cwd=source, check=True)
            path = (ROOT / patch['path']).resolve()
            if not path.is_relative_to((ROOT / 'runtime/build/patches').resolve()):
                raise ValueError('Patch path escapes the separate build-patches directory')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != patch['sha256']:
                raise ValueError('Build patch hash differs')
            subprocess.run(['git','apply','--check',str(path)], cwd=source, check=True)
            subprocess.run(['git','apply',str(path)], cwd=source, check=True)
            changed = subprocess.check_output(['git','diff','--name-only'], cwd=source, text=True).splitlines()
            if changed != ['wasm/Makefile']:
                raise ValueError('This patch may change only the port build Makefile')
            record = {**patch, 'sourceCommit':revision, 'applied':True, 'changedFiles':[]}
            for name in changed:
                body = (source / name).read_bytes()
                record['changedFiles'].append({'path':name,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()})
            observed.append(record)
            print(json.dumps(record), flush=True)
    finally:
        (WORK / 'logs').mkdir(parents=True, exist_ok=True)
        (WORK / 'logs/build-patches.json').write_text(json.dumps({'schema':1,'patches':observed}, indent=2)+'\n')

if __name__ == '__main__':
    main()
