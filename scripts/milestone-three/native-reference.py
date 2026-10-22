#!/usr/bin/env python3
"""Replay captured trusted native programs in an independent Maxima process.

This checks the Wasm runtime against native execution of the same generated CAS
programs and unmodified pinned STACK library. It is not an independent Moodle
PHP parser/controller implementation or a mathematical correctness oracle.
"""
# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

STACK_SHA = "33383047af39c204bf4442802a058f8b918b2b1b"
MARKER = re.compile(r"^\s*CTMNATIVE-REFERENCE\|([0-9]+)\|(.+?)\s*$")
VERSION = re.compile(r"^\s*CTMNATIVE-VERSION\|([^|]+)\|([0-9]+)\s*$")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def literal(value: str) -> str:
    return json.dumps(value, ensure_ascii=True)


def differences(expected, actual, path="$", *, limit=20):
    """Compare all fields; tolerate only JSON floating-point roundoff."""
    if type(expected) is not type(actual):
        numeric = (type(expected) in {int, float} and type(actual) in {int, float})
        if not numeric:
            return [{"path": path, "expected": expected, "actual": actual}]
    if type(expected) in {int, float} and type(actual) in {int, float}:
        if expected == actual or math.isclose(expected, actual, rel_tol=1e-12, abs_tol=1e-12):
            return []
        return [{"path": path, "expected": expected, "actual": actual}]
    if isinstance(expected, dict) and isinstance(actual, dict):
        if expected.keys() != actual.keys():
            return [{"path": path, "expectedKeys": sorted(expected), "actualKeys": sorted(actual)}]
        result = []
        for key in expected:
            result.extend(differences(expected[key], actual[key], f"{path}.{key}", limit=limit))
            if len(result) >= limit:
                break
        return result[:limit]
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [{"path": path, "expectedLength": len(expected), "actualLength": len(actual)}]
        result = []
        for index, (left, right) in enumerate(zip(expected, actual)):
            result.extend(differences(left, right, f"{path}[{index}]", limit=limit))
            if len(result) >= limit:
                break
        return result[:limit]
    return [] if expected == actual else [{"path": path, "expected": expected, "actual": actual}]


def make_batch(source: Path, home: Path, programs: list[dict]) -> str:
    (home / "moodle-qtype_stack-master").symlink_to(source, target_is_directory=True)
    for directory in ("tmp", "plots", "obj"):
        (home / directory).mkdir()
    loader = home / "moodle-qtype_stack-master/stack/maxima/stacklocallinux.mac"
    lines = ["display2d:false$", f"maxima_userdir:{literal(str(home))}$",
             f"load({literal(str(loader))})$", "display2d:false$", "linel:1000000$",
             'm3_emit(s):=printf(true,"~%~a~%",s)$',
             'm3_emit(sconcat("CTMNATIVE-VERSION|",MAXIMA_VERSION_STR,"|",stackmaximaversion))$']
    for index, row in enumerate(programs):
        marker = literal(f"CTMNATIVE-REFERENCE|{index}|")
        # The program is authored, generated source captured by the harness.
        # Learner answers were structurally admitted by the tested input layer.
        lines.append(
            "block([_m3_reference_value],_m3_reference_value:errcatch("
            + row["expression"] + "),"
            + "if _m3_reference_value=[] then m3_emit(sconcat("
            + marker + ',stackjson_stringify([false,"CAS evaluation failed"]))) '
            + "else m3_emit(sconcat(" + marker
            + ",stackjson_stringify([true,first(_m3_reference_value)]))))$")
    lines.extend([f'm3_emit("CTMNATIVE-END|{len(programs)}")$', "quit()$"])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser-report", type=Path, required=True)
    parser.add_argument("--stack-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("test-results/milestone-three/native-reference"))
    parser.add_argument("--maxima", default="maxima")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--require-operations", nargs="+", default=["prepare", "validate", "prt"])
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    source = args.stack_source.resolve()
    report = {"schema": 1, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "scope": "Independent native runtime replay of generated CAS programs; not Moodle/PHP controller parity or proof of mathematical grading correctness",
              "stackRevision": STACK_SHA, "passed": False, "observations": []}
    try:
        captured_bytes = args.browser_report.read_bytes()
        captured = json.loads(captured_bytes)
        report["browserReport"] = {"path": str(args.browser_report), "sha256": sha256(captured_bytes),
                                   "sourceRevision": captured.get("sourceRevision"), "browserVersion": captured.get("browserVersion"),
                                   "passed": captured.get("passed") is True}
        report["wasmRuntime"] = captured.get("runtime", {})
        programs = captured.get("programs", [])
        if not isinstance(programs, list) or not programs:
            raise ValueError("Browser report contains no actual native program evidence")
        if len(programs) > 10000:
            raise ValueError("Native replay inventory is unexpectedly large")
        for row in programs:
            if (not isinstance(row, dict) or not isinstance(row.get("expression"), str)
                    or not row["expression"].strip() or len(row["expression"]) > 512 * 1024
                    or "result" not in row):
                raise ValueError("Every captured program needs bounded source and an actual Wasm result")
        operations = Counter(row.get("operation", "unknown") for row in programs)
        if missing := set(args.require_operations) - operations.keys():
            raise ValueError("Missing native program coverage: " + ", ".join(sorted(missing)))
        actual_sha = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        if actual_sha != STACK_SHA:
            raise ValueError(f"Expected pinned STACK {STACK_SHA}, got {actual_sha}")
        executable = shutil.which(args.maxima)
        if not executable:
            raise ValueError(f"Native Maxima executable unavailable: {args.maxima}")
        report["nativeExecutableVersion"] = subprocess.check_output([executable, "--version"], text=True, timeout=30).strip()
        report["stackFiles"] = [{"path": path.relative_to(source).as_posix(), "sha256": sha256(path.read_bytes())}
                                for path in sorted((source / "stack/maxima").rglob("*"))
                                if path.is_file() and path.suffix in {".mac", ".lisp"}]
        report["operations"] = dict(operations)
        report["executionIsolation"] = "One fresh native process; program order matches the persistent Wasm worker"
        with tempfile.TemporaryDirectory(prefix="native-reference-", dir=args.output.resolve()) as directory:
            home = Path(directory)
            batch = make_batch(source, home, programs)
            batch_path = home / "reference.mac"
            batch_path.write_text(batch, encoding="utf-8")
            report["batchSha256"] = sha256(batch.encode("utf-8"))
            started = time.monotonic()
            process = subprocess.run([executable, "--very-quiet", f"--batch={batch_path}"],
                                     capture_output=True, text=True, timeout=args.timeout, check=False)
            report["elapsedSeconds"] = time.monotonic() - started
            output = process.stdout + process.stderr
            (args.output / "native.log").write_text(output, encoding="utf-8")
            (args.output / "reference.mac").write_text(batch, encoding="utf-8")
            report["exitCode"] = process.returncode
            if process.returncode:
                raise ValueError(f"Native Maxima exited {process.returncode}: {output[-2000:]}")
            observed = {}
            versions = []
            endings = 0
            for line in output.splitlines():
                if match := MARKER.fullmatch(line):
                    index = int(match[1])
                    if index in observed or not 0 <= index < len(programs):
                        raise ValueError("Duplicate or unexpected native result marker")
                    observed[index] = json.loads(match[2])
                elif match := VERSION.fullmatch(line):
                    versions.append({"maxima": match[1], "stackLibrary": match[2]})
                elif line.strip() == f"CTMNATIVE-END|{len(programs)}":
                    endings += 1
                elif line.lstrip().startswith(("CTMNATIVE-REFERENCE|", "CTMNATIVE-VERSION|", "CTMNATIVE-END|")):
                    raise ValueError("Malformed native protocol marker: " + line[:200])
            if len(versions) != 1 or endings != 1 or len(observed) != len(programs):
                raise ValueError(f"Incomplete native output: versions={len(versions)}, end={endings}, programs={len(observed)}/{len(programs)}")
            report["nativeRuntime"] = versions[0]
            for index, row in enumerate(programs):
                value = observed[index]
                if not isinstance(value, list) or len(value) != 2 or type(value[0]) is not bool:
                    raise ValueError("Malformed native value envelope")
                diff = differences(row["result"], value[1]) if value[0] else [{"nativeError": value[1]}]
                report["observations"].append({"index": index, "operation": row.get("operation"),
                    "question": row.get("question"), "expressionSha256": sha256(row["expression"].encode("utf-8")),
                    "wasm": row["result"], "native": value[1], "differences": diff, "passed": not diff})
        report["passed"] = captured.get("passed") is True and all(row["passed"] for row in report["observations"])
        if captured.get("passed") is not True:
            report["failure"] = "The source browser run did not complete successfully; replayed partial evidence is diagnostic only"
        report["summary"] = {"programs": len(programs), "passed": sum(row["passed"] for row in report["observations"]),
                             "different": sum(not row["passed"] for row in report["observations"])}
    except Exception as error:
        report["failure"] = str(error)
    (args.output / "native-reference.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report.get(key) for key in ("passed", "operations", "summary", "failure")}), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
