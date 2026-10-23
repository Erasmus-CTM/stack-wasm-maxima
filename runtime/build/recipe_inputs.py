# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared tracked recipe scope for packaging and source-artifact verification."""
import hashlib
import json
import subprocess


def recipe_files(repository):
    spec = json.loads((repository / 'runtime/build/recipe-inputs.json').read_text())
    assert spec['schema'] == 1
    paths = subprocess.check_output(['git','ls-files','-z','--',*spec['directories'],*spec['files']],cwd=repository).decode().split('\0')
    return sorted(path for path in paths if path)


def recipe_records(repository):
    return [{'path':path,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()} for path in recipe_files(repository) for body in [(repository / path).read_bytes()]]
