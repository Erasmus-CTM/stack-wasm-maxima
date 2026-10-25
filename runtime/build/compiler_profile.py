# SPDX-License-Identifier: AGPL-3.0-or-later
"""Explicit compiler experiments; never edit upstream configure or Lisp policy."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def profiles():
    return json.loads((ROOT / 'runtime/build/compiler-profiles.json').read_text())


def production_name():
    """The profile runtime releases use; experiments still choose explicitly."""
    name = profiles()['production']
    if name not in profiles()['profiles']:
        raise ValueError('Production names an unknown ECL compiler profile: ' + name)
    return name


def compiler_profile(name=None):
    name = name or os.environ.get('CTM_ECL_COMPILER_PROFILE', 'baseline')
    catalog = profiles()
    assert not (set(catalog['profiles']) & set(catalog.get('experimentalProfiles', {})))
    selected = {**catalog['profiles'], **catalog.get('experimentalProfiles', {})}.get(name)
    if selected is None:
        raise ValueError('Unknown ECL compiler experiment: ' + name)
    return selected


def spill_passes_setting(profile):
    """Complete Binaryen GC pass list for a profile, or None for upstream.

    Upstream ECL configure links with BINARYEN_EXTRA_PASSES=--spill-pointers.
    That pass spills only pointer locals live across a call; an optimized call
    result waiting on the Wasm value stack for an enclosing call is invisible
    to the collector. --flatten first moves every such value into a local.
    Emscripten appends EMCC_CFLAGS last, so this later setting is effective.
    """
    passes = profile.get('gcSpillPasses')
    if passes is None:
        return None
    names = passes.split(',')
    assert names[:2] == ['flatten', 'spill-pointers'] and all(names), 'GC passes must flatten immediately before spilling'
    return '-sBINARYEN_EXTRA_PASSES=' + passes


def emcc_flags(profile, key):
    flags = [profile.get(key)] if profile.get(key) else []
    setting = spill_passes_setting(profile)
    if setting:
        flags.append(setting)
    return ' '.join(flags)


if __name__ == '__main__':
    import sys
    profile = compiler_profile()
    if len(sys.argv) > 1 and sys.argv[1] == '--production':
        print(production_name())
    elif len(sys.argv) > 1 and sys.argv[1] == '--maxima-emcc-flags':
        print(emcc_flags(profile, 'maximaInjectedEmccFlags'))
    else:
        print(emcc_flags(profile, 'injectedEmccFlags') if len(sys.argv)>1 and sys.argv[1]=='--emcc-flags' else json.dumps(profile))
