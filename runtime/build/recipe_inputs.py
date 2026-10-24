# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared tracked recipe scope for packaging and source-artifact verification."""
import hashlib
import json
import os
import subprocess


def recipe_files(repository):
    spec = json.loads((repository / 'runtime/build/recipe-inputs.json').read_text())
    assert spec['schema'] == 1
    paths = subprocess.check_output(['git','ls-files','-z','--',*spec['directories'],*spec['files']],cwd=repository).decode().split('\0')
    return sorted(path for path in paths if path)


def recipe_records(repository):
    return [{'path':path,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()} for path in recipe_files(repository) for body in [(repository / path).read_bytes()]]


def committed_recipe(repository):
    """Do not label changed or omitted recipe inputs with an existing commit."""
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repository, text=True).strip()
    assert os.environ.get('GITHUB_SHA', revision) == revision, 'Recipe revision differs from checkout HEAD'
    records = recipe_records(repository)
    scope = json.loads((repository / 'runtime/build/recipe-inputs.json').read_text())
    untracked = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z', '--',
                                        *scope['directories'], *scope['files']], cwd=repository)
    assert not untracked, 'Untracked recipe inputs cannot be omitted from provenance'
    required = {'runtime/build/source_overlay.py', 'runtime/build/source_state.py',
                'runtime/build/apply-target-overlay.py', 'runtime/build/patches/ecl-root-scanner.json',
                'runtime/build/patches/ecl-root-scanner.patch'}
    assert required <= {row['path'] for row in records}, 'Overlay recipe inputs must be tracked'
    for row in records:
        original = subprocess.check_output(['git', 'show', revision + ':' + row['path']], cwd=repository)
        assert original == (repository / row['path']).read_bytes(), 'Uncommitted recipe input: ' + row['path']
    return revision, records
