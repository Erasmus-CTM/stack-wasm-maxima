#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Retain effective subprocess evidence without modifying any upstream source."""
import json
from pathlib import Path
from compiler_profile import compiler_profile
from compiler_evidence import derive

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT/'.cache/runtime-build'
logs = WORK/'logs'
source = WORK/'sources/ecl'
config = (source/'build/config.log').read_bytes()
target = (source/'build/target-info.lsp').read_bytes()
assert target == (WORK/'sources/maxima/wasm/ecl-emscripten/target-info.lsp').read_bytes()
(logs/'ecl-config.log').write_bytes(config)
(logs/'target-info.lsp').write_bytes(target)
profile = compiler_profile()
observed = derive(config,target,(logs/'ecl-cross-build.log').read_bytes(),(logs/'maxima-cross-build.log').read_bytes(),profile)
record = {'schema':1,'passed':True,'profile':profile,'observed':observed,
          'scope':'Actual clang subprocess optimization in separate ECL/Maxima build phases, plus raw unchanged configure flags and mandatory GC link settings. Each phase uses the explicitly selected profile; upstream configure and Lisp policy remain unchanged. No performance conclusion.'}
(logs/'compiler-experiment.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'passed':True,'profile':profile,'actualEclCoreCompiles':len(observed['eclCore']),
                  'actualEclGeneratedLispCompiles':len(observed['eclGeneratedLisp']),
                  'actualMaximaUnitCompiles':len(observed['maximaGeneratedUnits'])}))
