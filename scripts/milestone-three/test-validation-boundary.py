#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run engine-generated native validation programs in real native Maxima.

Learner domain errors (1/0) must stay invalid inside a working program. Any
other Lisp error inside STACK validation must fail the whole program with the
engine's internal-fault message, so the Wasm session is poisoned and restarted
instead of reporting learner-invalid. The fault is raised by a deliberately
admitted Lisp call; production admission never permits '?'.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("native_reference", ROOT / "scripts/milestone-three/native-reference.py")
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)

GENERATE = r"""
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const scope = {NativeInput:{AdmissionError:class extends Error {},admit:raw => ({raw,source:raw})}};
vm.runInContext(await readFile(process.argv[1],'utf8'),vm.createContext({self:scope,TextEncoder,crypto:webcrypto}));
const question = {name:'Boundary',variables:'startx:-2;',native:{schema:1,id:'boundary',locals:['startx'],tokens:[]},
  inputs:[{name:'ans',type:'algebraic',checkanswertype:true,requirelowestterms:false}],prts:[]};
const variant = {seed:1,env:{startx:'-2'},teachers:{ans:{source:'[2,2]'}}};
const engine = new scope.NativeStackEngine({session:{evaluate(){throw new Error('unused');}}});
const program = (raw,type='algebraic') => engine.validationExpression(
  {...question,inputs:[{...question.inputs[0],type}]},variant,{ans:{raw,source:raw}});
// STACK's validator itself reports algebraic 1/0. The numerical check runs
// after it, so its Maxima error unwinds to the engine's classified boundary.
console.log(JSON.stringify({fault:scope.NativeStackEngine.INTERNAL_FAULT,
  programs:{list:program('[1,1]'),domain:program('1/0'),numericDomain:program('1/0','numerical'),
    internal:program('?car(1)'),after:program('[1,1]')}}));
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-source", type=Path, required=True)
    parser.add_argument("--maxima", default="maxima")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    executable = shutil.which(args.maxima)
    assert executable, "Native Maxima executable unavailable: " + args.maxima
    generated = json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e", GENERATE, str(ROOT / "prototype/native/engine.js")], text=True))
    names = list(generated["programs"])
    with tempfile.TemporaryDirectory(prefix="validation-boundary-") as directory:
        home = Path(directory)
        lines = reference.make_batch(args.stack_source.resolve(), home, []).splitlines()
        assert lines[-2:] == ['m3_emit("CTMNATIVE-END|0")$', "quit()$"]
        lines = lines[:-2]
        for index, name in enumerate(names):
            marker = reference.literal(f"CTMNATIVE-REFERENCE|{index}|")
            # Same outer envelope as MaximaSession.evaluate, retaining the message.
            lines.append('block([%ERR:["stack_map"],%NOTES:["stack_map"],%FEEDBACK:["stack_map"],%stmt:"ctm-native",_r],'
                         "_r:errcatch(" + generated["programs"][name] + "),"
                         "if _r=[] then m3_emit(sconcat(" + marker + ",stackjson_stringify([false,errormsgtostring()]))) "
                         "else m3_emit(sconcat(" + marker + ",stackjson_stringify([true,first(_r)]))))$")
        lines += [f'm3_emit("CTMNATIVE-END|{len(names)}")$', "quit()$"]
        batch = home / "boundary.mac"
        batch.write_text("\n".join(lines) + "\n", encoding="utf-8")
        process = subprocess.run([executable, "--very-quiet", f"--batch={batch}"],
                                 capture_output=True, text=True, timeout=900, check=False)
    output = process.stdout + process.stderr
    assert process.returncode == 0, output[-2000:]
    observed = {}
    for line in output.splitlines():
        if match := reference.MARKER.fullmatch(line):
            observed[names[int(match[1])]] = json.loads(match[2])
    assert set(observed) == set(names), "Incomplete native output: " + output[-2000:]
    valid = {"valid": True, "latex": "\\left[ 1 , 1 \\right] ", "feedback": "", "source": "[1,1]"}
    assert observed["list"] == [True, {"ans": valid}], observed["list"]
    invalid = {"valid": False, "latex": "", "feedback": "Native STACK could not evaluate this expression", "source": ""}
    domain = observed["domain"]
    assert domain[0] is True and domain[1]["ans"]["valid"] is False and domain[1]["ans"]["feedback"].endswith(invalid["feedback"]), domain
    assert observed["numericDomain"] == [True, {"ans": invalid}], observed["numericDomain"]
    assert observed["internal"][0] is False and observed["internal"][1].startswith(generated["fault"]), observed["internal"]
    assert observed["after"] == observed["list"], "A caught internal fault must not alter later validation"
    report = {"schema": 1, "passed": True,
              "sourceRevision": os.environ.get("GITHUB_SHA") or subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "stackRevision": reference.STACK_SHA,
              "classifierSha256": hashlib.sha256(reference.CLASSIFIER.read_bytes()).hexdigest(),
              "engineSha256": hashlib.sha256((ROOT / "prototype/native/engine.js").read_bytes()).hexdigest(), "maxima": subprocess.check_output([executable, "--version"], text=True).strip(),
              "observed": observed,
              "scope": "Engine-generated validation programs in one native Maxima process with pinned STACK source. "
                       "Domain error stays learner-invalid; a Lisp error fails the program as an internal fault."}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": True, "maxima": report["maxima"], "internal": observed["internal"][1][:160]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
