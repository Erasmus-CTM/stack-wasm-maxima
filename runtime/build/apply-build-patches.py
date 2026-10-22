#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Apply separately pinned build-only patches after original source verification."""
import hashlib
import json
from pathlib import Path
import subprocess
import shutil

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
            subprocess.run(['git','diff','--exit-code','HEAD','--'], cwd=source, check=True)
            path = (ROOT / patch['path']).resolve()
            if not path.is_relative_to((ROOT / 'runtime/build/patches').resolve()):
                raise ValueError('Patch path escapes the separate build-patches directory')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != patch['sha256']:
                raise ValueError('Build patch hash differs')
            changed = [row.split('\t')[-1] for row in subprocess.check_output(['git','apply','--numstat',str(path)], cwd=source, text=True).splitlines()]
            if changed != ['wasm/Makefile']:
                raise ValueError('This patch may change only the port build Makefile')
            # Derive a separate recipe. Maxima configure uses git describe --dirty;
            # leave the verified source tree untouched while recording the patch.
            derived = WORK / 'build-recipes' / patch['source']
            derived.mkdir(parents=True, exist_ok=False)
            (derived / 'wasm').mkdir()
            original = (source / 'wasm/Makefile').read_bytes()
            shutil.copyfile(source / 'wasm/Makefile', derived / 'wasm/Makefile')
            subprocess.run(['git','apply','--no-index','--check',str(path)], cwd=derived, check=True)
            subprocess.run(['git','apply','--no-index',str(path)], cwd=derived, check=True)
            if [p.relative_to(derived).as_posix() for p in derived.rglob('*') if p.is_file()] != ['wasm/Makefile']:
                raise ValueError('Unexpected derived recipe files')
            subprocess.run(['git','diff','--exit-code','HEAD','--'], cwd=source, check=True)
            if (source / 'wasm/Makefile').read_bytes() != original:
                raise ValueError('Original source Makefile changed')
            body = (derived / 'wasm/Makefile').read_bytes()
            record = {**patch, 'sourceCommit':revision, 'applied':True, 'sourceFilesUnmodified':True,
                      'originalFile':{'path':'wasm/Makefile','bytes':len(original),'sha256':hashlib.sha256(original).hexdigest()},
                      'derivedRecipe':{'path':(derived / 'wasm/Makefile').relative_to(WORK).as_posix(),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}}
            observed.append(record)
            print(json.dumps(record), flush=True)
    finally:
        (WORK / 'logs').mkdir(parents=True, exist_ok=True)
        (WORK / 'logs/build-patches.json').write_text(json.dumps({'schema':1,'patches':observed}, indent=2)+'\n')

if __name__ == '__main__':
    main()
