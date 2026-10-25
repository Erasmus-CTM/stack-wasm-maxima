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


if __name__ == '__main__':
    import sys
    profile = compiler_profile()
    if len(sys.argv) > 1 and sys.argv[1] == '--production':
        print(production_name())
    elif len(sys.argv) > 1 and sys.argv[1] == '--maxima-emcc-flags':
        print(profile.get('maximaInjectedEmccFlags') or '')
    else:
        print((profile['injectedEmccFlags'] or '') if len(sys.argv)>1 and sys.argv[1]=='--emcc-flags' else json.dumps(profile))
