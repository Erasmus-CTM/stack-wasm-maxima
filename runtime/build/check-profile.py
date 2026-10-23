#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Record effective compiler flags and retain mandatory conservative-GC settings."""
import json
import shutil
from profile import configuration, WORK

profile = configuration()
source = WORK / ('build-sources/ecl' if profile['patch'] else 'sources/ecl')
config = source / 'build/config.log'
target = source / 'build/target-info.lsp'
assert target.is_file(), 'Missing actual target-info consumed by cross compilation'
installed_target = WORK / 'sources/maxima/wasm/ecl-emscripten/target-info.lsp'
assert installed_target.read_bytes() == target.read_bytes(), 'Installed cross-compile target-info differs from captured ECL build'
shutil.copy2(config, WORK / 'logs/ecl-config.log')
shutil.copy2(target, WORK / 'logs/target-info.lsp')
commands = (WORK / 'logs/build.log').read_text(errors='replace').splitlines()
command_snapshot = ('\n'.join(line for line in commands if 'emcc ' in line) + '\n').encode()
(WORK / 'logs/compiler-commands.log').write_bytes(command_snapshot)
from flag_evidence import derive_flags
fields = derive_flags(config.read_bytes(), target.read_bytes(), command_snapshot, profile)
record = {'schema': 1, 'configuration': profile, **fields,
          'scope': 'Final target ECL core C configuration and actual compiler commands. Generated Maxima C retains final -O2; native host flags are not a Wasm optimization result.', 'passed': True}
(WORK / 'logs/effective-flags.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))
