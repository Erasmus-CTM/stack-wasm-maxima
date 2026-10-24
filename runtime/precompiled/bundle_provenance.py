#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Bind a fresh cross-compiler output to its exact translation inputs."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from parser_bootstrap import PINNED_SOURCES

ENTRY = 'stack/maxima/stackmaxima.mac'
PROCESS_ADAPTER = 'assignment-adapter.lisp'
TRANSLATION_MODE = ('symbolic-assignment-hooks+packagefile+pinned-parser-declarations+'
                    'targeted-texcolor-texcolorplain-nounor-apply-dispatch')


def record(body):
    return {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}


def describe(pin, source, translated, bridge, process_adapter, declarations, metadata, binary):
    if pin not in PINNED_SOURCES:
        raise ValueError('Unsupported bundle source pin')
    return {'schema': 2, 'stackRevision': pin, 'translationMode': TRANSLATION_MODE,
            'entry': {'path': ENTRY, **record(source)},
            'translatedLisp': record(translated), 'assignmentBridge': record(bridge),
            'processAdapter': {'path': PROCESS_ADAPTER, **record(process_adapter)},
            'parserDeclarations': record(declarations), 'parserMetadata': record(metadata),
            'bundle': {'path': 'stackmaxima.fas', **record(binary)}}


def produce(stack, work, pin):
    if pin not in PINNED_SOURCES or subprocess.check_output(
            ['git', '-C', str(stack), 'rev-parse', 'HEAD'], text=True).strip() != pin:
        raise ValueError('Bundle checkout differs from its claimed source pin')
    source = (stack / ENTRY).read_bytes()
    if source != subprocess.check_output(['git', '-C', str(stack), 'show', f'{pin}:{ENTRY}']):
        raise ValueError('Bundle entry source differs from pinned Git bytes')
    initialized = work / 'source-initialized'
    if (initialized / 'stackmaxima.mac').read_bytes() != source:
        raise ValueError('Translated entry differs from pinned source')
    binary = (work / 'stackmaxima.fas').read_bytes()
    if not binary:
        raise ValueError('Empty compiler output')
    process_adapter = (work / PROCESS_ADAPTER).read_bytes()
    if not process_adapter or process_adapter != Path(__file__).with_name(PROCESS_ADAPTER).read_bytes():
        raise ValueError('Translation-process adapter differs from the reviewed source')
    descriptor = describe(pin, source, (initialized / 'stackmaxima.lisp').read_bytes(),
                          (initialized / 'display2d-bridge.lisp').read_bytes(),
                          process_adapter,
                          (initialized / 'parser-declarations.mac').read_bytes(),
                          (initialized / 'parser-declarations.json').read_bytes(), binary)
    # Exclusive creation prevents a retained descriptor from blessing new bytes.
    with (work / 'stackmaxima.fas.json').open('x') as stream:
        stream.write(json.dumps(descriptor, indent=2) + '\n')
    return descriptor


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stack-source', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--pin', choices=PINNED_SOURCES, required=True)
    args = parser.parse_args()
    print(json.dumps(produce(args.stack_source, args.work, args.pin)))
