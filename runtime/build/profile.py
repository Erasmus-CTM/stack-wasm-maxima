#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Explicit experiment configuration; upstream source and baseline pins stay fixed."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/runtime-build'


def configuration(name=None):
    name = name or os.environ.get('CTM_RUNTIME_PROFILE', 'baseline')
    return json.loads((ROOT / 'runtime/build/profiles.json').read_text())['profiles'][name]


def startup(profile):
    if profile['capabilities']['plotting']:
        return ''
    # Replace ECL autoload functions before STACK sets its two legacy options.
    # No STACK or Maxima source changes. Other plot-module entry points remain
    # unavailable; absent owned files fail closed in the hash-bound HTTP server.
    return (ROOT / 'runtime/build/profiles/no-plot.lisp').read_text().strip() + '\n'


def main():
    profile = configuration()
    recipe = WORK / 'build-recipes/maxima/wasm/Makefile'
    before = recipe.read_bytes()
    if profile['patch']:
        source = WORK / 'sources/ecl'
        derived = WORK / 'build-sources/ecl'
        subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--'], cwd=source, check=True)
        shutil.copytree(source, derived, ignore=shutil.ignore_patterns('.git'))
        patch = ROOT / profile['patch']['path']
        assert hashlib.sha256(patch.read_bytes()).hexdigest() == profile['patch']['sha256']
        changed = subprocess.check_output(['git','apply','--numstat',str(patch)],cwd=source,text=True)
        assert [line.split('\t')[-1] for line in changed.splitlines()] == ['src/aclocal.m4','src/configure']
        subprocess.run(['git', 'apply', '--no-index', '--check', str(patch)], cwd=derived, check=True)
        subprocess.run(['git', 'apply', '--no-index', str(patch)], cwd=derived, check=True)
        subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--'], cwd=source, check=True)
        for path in source.rglob('*'):
            if path.is_file() and '.git' not in path.relative_to(source).parts:
                file = path.relative_to(source).as_posix()
                if file not in ['src/aclocal.m4','src/configure']:
                    assert path.read_bytes() == (derived / file).read_bytes(), file
        for file in ['src/aclocal.m4','src/configure']:
            target = WORK / 'build-recipes/ecl' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(derived / file, target)
    after = recipe.read_bytes()
    record = {'schema': 1, 'configuration': profile,
              'inputRecipeSha256': hashlib.sha256(before).hexdigest(),
              'effectiveRecipeSha256': hashlib.sha256(after).hexdigest(),
              'derivedEclFiles': [{ 'path': file, 'sha256': hashlib.sha256((WORK / 'build-recipes/ecl' / file).read_bytes()).hexdigest()} for file in ['src/aclocal.m4','src/configure']] if profile['patch'] else [],
              'originalSourcesUnmodified': True,
              'startup': startup(profile)}
    (WORK / 'logs/profile.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record), flush=True)


if __name__ == '__main__':
    main()
