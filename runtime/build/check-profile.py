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
links = re.findall(r"^(?:LDFLAGS|SHARED_LDFLAGS|BUNDLE_LDFLAGS|PROGRAM_LDFLAGS)='(.*)'$", text, re.M)
assert links and all('--spill-pointers' in row and '-sSTACK_SIZE=33554432' in row for row in links), links
target = source / 'build/target-info.lsp'
assert target.is_file(), 'Missing actual target-info consumed by cross compilation'
shutil.copy2(target, WORK / 'logs/target-info.lsp')
commands = (WORK / 'logs/build.log').read_text(errors='replace').splitlines()
ecl_commands = [line for line in commands if 'emcc ' in line and ' -c ' in line and '/ecl/src/' in line and (' -O' in line)]
assert ecl_commands, 'Missing representative target ECL compiler command'
selected = ecl_commands[-1]
observed = re.findall(r'(?<!\S)-O(?:[0-3sz]|fast)(?!\S)', selected)
assert observed[-1] == profile['eclCFlag'], selected
maxima_commands = [line for line in commands if 'emcc ' in line and ' -c ' in line and ' -Demscripten ' in line]
assert maxima_commands and re.findall(r'(?<!\S)-O(?:[0-3sz]|fast)(?!\S)', maxima_commands[-1])[-1] == '-O2'
record = {'schema': 1, 'configuration': profile, 'finalCFlags': flags[0],
          'finalOptimization': optimization[-1], 'linkFlags': links,
          'configLogSha256': hashlib.sha256(config.read_bytes()).hexdigest(),
          'targetInfoSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
          'representativeEclCompile': selected, 'representativeMaximaCompile': maxima_commands[-1],
          'maximaFinalOptimization': '-O2',
          'scope': 'Final target ECL configuration. Full compiler/link commands remain in build.log; native host flags are not a Wasm optimization result.', 'passed': True}
(WORK / 'logs/effective-flags.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))
