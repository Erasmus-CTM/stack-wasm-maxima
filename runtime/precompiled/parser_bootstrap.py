#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Copy only pinned noun-logic declarations for the translation-process reader."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

PIN = '33383047af39c204bf4442802a058f8b918b2b1b'
SOURCE = 'stack/maxima/assessment.mac'
SOURCE_SHA256 = 'd45f18db6bbb0b85fee9e2724276cfa1f92998f9d1db3c4115b5ab05835f9978'
DECLARATIONS = b'''nary("nounand", 65)$
nary("nounor", 61)$
prefix("nounnot", 70)$

declare("nounand", commutative)$
declare("nounand", lassociative)$

declare("nounor", commutative)$
declare("nounor", lassociative)$
'''


def digest(body):
    return hashlib.sha256(body).hexdigest()


def extract(body):
    if digest(body) != SOURCE_SHA256 or body.count(DECLARATIONS) != 1:
        raise ValueError('Pinned assessment source/declaration bytes differ')
    start = body.index(DECLARATIONS)
    return DECLARATIONS, start


def prepare(stack, output):
    revision = subprocess.check_output(['git', '-C', str(stack), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != PIN:
        raise ValueError('Wrong pinned STACK checkout for parser bootstrap')
    source = (stack / SOURCE).read_bytes()
    if source != subprocess.check_output(['git', '-C', str(stack), 'show', f'{PIN}:{SOURCE}']):
        raise ValueError('Assessment checkout differs from pinned Git bytes')
    block, start = extract(source)
    target = output / 'parser-declarations.mac'
    metadata = output / 'parser-declarations.json'
    if target.exists() or metadata.exists():
        raise ValueError('Refusing stale parser bootstrap outputs')
    output.mkdir(parents=True, exist_ok=True)
    target.write_bytes(block)
    report = {'schema': 1, 'stackRevision': PIN,
              'scope': 'Translation-process parser declarations only; target dependency loads and upstream files are unchanged',
              'source': {'path': SOURCE, 'bytes': len(source), 'sha256': digest(source),
                         'start': start, 'end': start + len(block)},
              'file': {'path': target.name, 'bytes': len(block), 'sha256': digest(block)}}
    metadata.write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stack-source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.stack_source, args.output)))
