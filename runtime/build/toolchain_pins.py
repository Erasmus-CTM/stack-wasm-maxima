# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pins for the selected Emscripten toolchain; only pins.json can be released."""
import copy
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def effective_pins(repository=ROOT):
    """CTM_EMSDK names the toolchain; unset means pins.json exactly as released."""
    pins = json.loads((Path(repository) / 'runtime/build/pins.json').read_text())
    version = os.environ.get('CTM_EMSDK')
    if not version:
        return pins
    pinned = next(pin['version'] for pin in pins['sources'] if pin['name'] == 'emsdk')
    if version == pinned:
        return pins
    experiments = json.loads((Path(repository) / 'runtime/build/toolchains.json').read_text())['experimental']
    if version not in experiments:
        raise ValueError('Unknown Emscripten toolchain: ' + version)
    chosen = experiments[version]
    result = copy.deepcopy(pins)
    if not set(chosen['sources']) <= {pin['name'] for pin in result['sources']}:
        raise ValueError('Toolchain overrides an unpinned source')
    for pin in result['sources']:
        if pin['name'] in chosen['sources']:
            pin.update(chosen['sources'][pin['name']])
    result['toolchainArchives'] = chosen['toolchainArchives']
    result['experimentalToolchain'] = {'emsdk': version, 'replaces': pinned}
    return result


def emsdk_version(repository=ROOT):
    return next(pin['version'] for pin in effective_pins(repository)['sources'] if pin['name'] == 'emsdk')


def emcc_flags(repository=ROOT):
    """Flags a toolchain needs on every emcc call; the pinned one needs none."""
    chosen = effective_pins(repository).get('experimentalToolchain')
    if not chosen:
        return ''
    experiments = json.loads((Path(repository) / 'runtime/build/toolchains.json').read_text())['experimental']
    return experiments[chosen['emsdk']].get('emccFlags', '')


if __name__ == '__main__':
    import sys
    print(emcc_flags() if sys.argv[1:] == ['--emcc-flags'] else emsdk_version())
