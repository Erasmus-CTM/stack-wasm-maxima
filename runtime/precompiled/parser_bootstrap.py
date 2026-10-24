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
PINNED_SOURCES = {
    PIN: SOURCE_SHA256,
    '10d323311b7f39fb7b092dd10ce75f7d8632f525':
        '2d69d86e3ae2e097f254a69da322b9bc6117d40dab2451ab8f9d62c353143864',
}
DECLARATIONS = b'''nary("nounand", 65)$
nary("nounor", 61)$
prefix("nounnot", 70)$

declare("nounand", commutative)$
declare("nounand", lassociative)$

declare("nounor", commutative)$
declare("nounor", lassociative)$
'''
DECLARATIONS_BY_PIN = {
    PIN: DECLARATIONS,
    '10d323311b7f39fb7b092dd10ce75f7d8632f525': DECLARATIONS.replace(
        b'declare("nounand", lassociative)$',
        b'declare("nounand", lassociative)$\ndeclare("nounand", rassociative)$'
    ).replace(
        b'declare("nounor", lassociative)$',
        b'declare("nounor", lassociative)$\ndeclare("nounor", rassociative)$'
    ),
}


def digest(body):
    return hashlib.sha256(body).hexdigest()


def extract(body, pin=PIN):
    block = DECLARATIONS_BY_PIN.get(pin)
    if block is None or digest(body) != PINNED_SOURCES[pin] or body.count(block) != 1:
        raise ValueError('Pinned assessment source/declaration bytes differ')
    start = body.index(block)
    return block, start


def prepare(stack, output, pin=PIN):
    revision = subprocess.check_output(['git', '-C', str(stack), 'rev-parse', 'HEAD'], text=True).strip()
    if pin not in PINNED_SOURCES or revision != pin:
        raise ValueError('Wrong pinned STACK checkout for parser bootstrap')
    source = (stack / SOURCE).read_bytes()
    if source != subprocess.check_output(['git', '-C', str(stack), 'show', f'{pin}:{SOURCE}']):
        raise ValueError('Assessment checkout differs from pinned Git bytes')
    block, start = extract(source, pin)
    target = output / 'parser-declarations.mac'
    metadata = output / 'parser-declarations.json'
    if target.exists() or metadata.exists():
        raise ValueError('Refusing stale parser bootstrap outputs')
    output.mkdir(parents=True, exist_ok=True)
    target.write_bytes(block)
    report = {'schema': 1, 'stackRevision': pin,
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
    parser.add_argument('--pin', choices=PINNED_SOURCES, default=PIN)
    args = parser.parse_args()
    print(json.dumps(prepare(args.stack_source, args.output, args.pin)))
