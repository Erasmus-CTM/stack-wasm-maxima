# SPDX-License-Identifier: AGPL-3.0-or-later
"""Controlled ECL-only experiments; never edit upstream configure or Lisp policy."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def profiles():
    return json.loads((ROOT / 'runtime/build/compiler-profiles.json').read_text())


def compiler_profile(name=None):
    name = name or os.environ.get('CTM_ECL_COMPILER_PROFILE', 'baseline')
    selected = profiles()['profiles'].get(name)
    if selected is None:
        raise ValueError('Unknown ECL compiler experiment: ' + name)
    return selected


if __name__ == '__main__':
    import sys
    profile = compiler_profile()
    print((profile['injectedEmccFlags'] or '') if len(sys.argv)>1 and sys.argv[1]=='--emcc-flags' else json.dumps(profile))
