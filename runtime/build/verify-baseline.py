#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Admit only the frozen fully validated step-1 build, including its recipe."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
base = ROOT / '.cache/runtime-build/baseline-run'
artifact = base / '.cache/runtime-build/artifact'
expected = json.loads((ROOT / 'runtime/build/baseline.json').read_text())
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert digest(artifact / 'manifest.json') == expected['manifestSha256']
assert digest(artifact / 'artifact-manifest.json') == expected['artifactManifestSha256']
manifest = json.loads((artifact / 'manifest.json').read_text())
assert manifest['recipe']['revision'] == expected['recipeRevision']
assert manifest['sourcePins'] == expected['sourcePins']
for row in json.loads((artifact / 'artifact-manifest.json').read_text())['files']:
    path = artifact / row['path']
    assert path.resolve().is_relative_to(artifact.resolve())
    assert path.stat().st_size == row['bytes'] and digest(path) == row['sha256'], row['path']
acceptance = json.loads((base / '.cache/runtime-build/validation/acceptance.json').read_text())
assert acceptance['passed'] and acceptance['artifactManifestSha256'] == expected['manifestSha256']
print(json.dumps({**expected, 'passed': True}))
