#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Record effective compiler flags and retain mandatory conservative-GC settings."""
import hashlib
import json
import re
import shutil
from pathlib import Path
from profile import configuration, WORK

profile = configuration()
source = WORK / ('build-sources/ecl' if profile['patch'] else 'sources/ecl')
config = source / 'build/config.log'
text = config.read_text(errors='replace')
flags = re.findall(r"^CFLAGS='(.*)'$", text, re.M)
assert len(flags) == 1, 'Missing final target ECL CFLAGS'
optimization = re.findall(r'(?<!\S)-O(?:[0-3sz]|fast)(?!\S)', flags[0])
assert optimization and optimization[-1] == profile['eclCFlag'], flags
links = dict(re.findall(r"^(LDFLAGS|SHARED_LDFLAGS|BUNDLE_LDFLAGS|PROGRAM_LDFLAGS)='(.*)'$", text, re.M))
assert set(links) == {'LDFLAGS','SHARED_LDFLAGS','BUNDLE_LDFLAGS','PROGRAM_LDFLAGS'}
assert all('--spill-pointers' in row and '-sSTACK_SIZE=33554432' in row for row in links.values()), links
shutil.copy2(config, WORK / 'logs/ecl-config.log')
target = source / 'build/target-info.lsp'
assert target.is_file(), 'Missing actual target-info consumed by cross compilation'
installed_target = WORK / 'sources/maxima/wasm/ecl-emscripten/target-info.lsp'
assert installed_target.read_bytes() == target.read_bytes(), 'Installed cross-compile target-info differs from captured ECL build'
shutil.copy2(target, WORK / 'logs/target-info.lsp')
commands = (WORK / 'logs/build.log').read_text(errors='replace').splitlines()
ecl_commands = [line for line in commands if 'emcc ' in line and ' -c ' in line and 'main.o.c' in line and (' -O' in line) and not line.lstrip().startswith(';;;')]
assert ecl_commands, 'Missing representative target ECL compiler command'
selected = ecl_commands[-1]
observed = re.findall(r'(?<!\S)-O(?:[0-3sz]|fast)(?!\S)', selected)
assert observed[-1] == profile['eclCFlag'], selected
maxima_commands = [line for line in commands if 'emcc ' in line and ' -c ' in line and ' -Demscripten ' in line and '/src/binary-ecl/wasm32-emscripten/' in line]
assert maxima_commands and re.findall(r'(?<!\S)-O(?:[0-3sz]|fast)(?!\S)', maxima_commands[-1])[-1] == '-O2'
command_snapshot = ('\n'.join(line for line in commands if 'emcc ' in line) + '\n').encode()
(WORK / 'logs/compiler-commands.log').write_bytes(command_snapshot)
record = {'schema': 1, 'configuration': profile, 'finalCFlags': flags[0],
          'finalOptimization': optimization[-1], 'linkFlags': links,
          'configLogSha256': hashlib.sha256(config.read_bytes()).hexdigest(),
          'targetInfoSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
          'compilerCommandsSha256': hashlib.sha256(command_snapshot).hexdigest(),
          'representativeEclCompile': selected, 'representativeMaximaCompile': maxima_commands[-1],
          'maximaFinalOptimization': '-O2',
          'scope': 'Final target ECL configuration. Full compiler/link commands remain in build.log; native host flags are not a Wasm optimization result.', 'passed': True}
(WORK / 'logs/effective-flags.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))
