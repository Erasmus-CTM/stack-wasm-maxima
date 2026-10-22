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
PRESENTATION_POLICY = {
    "schema": 1,
    "scope": "Version-dependent TeX display comparison only; no grading, source, state or note normalization",
    "exact": "No differences under strict field/string comparison and finite floating-point tolerance; not a claim of byte equality",
    "rules": {
        "latex-text-container": "Only a full .latex value: \\mbox{ X } versus \\text{X}, with exactly one container padding space removed per side and byte-identical X",
        "native-feedback-math-line-wrap": "Only !quot!-delimited stack_trans mathematical TeX arguments; remove LF plus spaces/tabs immediately before } or backslash; no text/mbox blocks; all protocol text and other arguments stay exact",
    },
}


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def literal(value: str) -> str:
    return json.dumps(value, ensure_ascii=True)


def finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON number: " + value)
    return number


def reject_constant(value: str):
    raise ValueError("Non-finite JSON constant: " + value)


def load_json(value):
    # Python's defaults accept NaN/Infinity and overflow 1e999 to infinity.
    # Neither is an actual JSON value accepted by the browser transport.
    return json.loads(value, parse_float=finite_float, parse_constant=reject_constant)


def checked_stack_files(source: Path) -> list[dict]:
    """Read only original pinned CAS files, including sparse-checkout checks."""
    tracked = subprocess.check_output(
        ["git", "-C", str(source), "ls-tree", "-r", "--name-only", STACK_SHA, "--", "stack/maxima"], text=True)
    expected = {path for path in tracked.splitlines() if Path(path).suffix in {".mac", ".lisp"}}
    actual = {path.relative_to(source).as_posix() for path in (source / "stack/maxima").rglob("*")
              if path.is_file() and path.suffix in {".mac", ".lisp"}}
    if not expected or expected != actual:
        raise ValueError("Native STACK CAS file inventory differs from the pinned git tree: "
                         + json.dumps({"missing": sorted(expected - actual), "extra": sorted(actual - expected)}))
    records = []
    for path in sorted(expected):
        original = subprocess.check_output(["git", "-C", str(source), "show", f"{STACK_SHA}:{path}"])
        content = (source / path).read_bytes()
        if content != original:
            raise ValueError("Native STACK CAS file is modified from its pinned git blob: " + path)
        records.append({"path": path, "sha256": sha256(content)})
    return records


def differences(expected, actual, path="$", *, limit=None):
    """Compare all fields; tolerate only JSON floating-point roundoff."""
    if any(type(value) is float and not math.isfinite(value) for value in (expected, actual)):
        raise ValueError("Cannot compare non-finite JSON numbers at " + path)
    if type(expected) is not type(actual):
        numeric = (type(expected) in {int, float} and type(actual) in {int, float})
        if not numeric:
            return [{"path": path, "expected": expected, "actual": actual}]
    if type(expected) in {int, float} and type(actual) in {int, float}:
        equal = expected == actual
        # Exact integers must remain exact, even at magnitudes where a unit
        # difference would fall under the floating-point relative tolerance.
        if not equal and (type(expected) is float or type(actual) is float):
            try:
                equal = math.isclose(expected, actual, rel_tol=1e-12, abs_tol=1e-12)
            except OverflowError:
                # An arbitrary-size JSON integer cannot be rounded to a
                # floating infinity just to compare it with a finite float.
                equal = False
        if equal:
            return []
        return [{"path": path, "expected": expected, "actual": actual}]
    if isinstance(expected, dict) and isinstance(actual, dict):
        if expected.keys() != actual.keys():
            return [{"path": path, "expectedKeys": sorted(expected), "actualKeys": sorted(actual)}]
        result = []
        for key in expected:
            result.extend(differences(expected[key], actual[key], f"{path}.{key}", limit=limit))
            if limit is not None and len(result) >= limit:
                break
        return result if limit is None else result[:limit]
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [{"path": path, "expectedLength": len(expected), "actualLength": len(actual)}]
        result = []
        for index, (left, right) in enumerate(zip(expected, actual)):
            result.extend(differences(left, right, f"{path}[{index}]", limit=limit))
            if limit is not None and len(result) >= limit:
                break
        return result if limit is None else result[:limit]
    return [] if expected == actual else [{"path": path, "expected": expected, "actual": actual}]


def feedback_parts(value: str):
    """Recognize only StackAddFeedback's literal protocol; never execute it."""
    parts = []
    position = last = calls = 0

    def space():
        nonlocal position
        while position < len(value) and value[position].isspace():
            position += 1

    def take(text):
        nonlocal position
        if not value.startswith(text, position):
            raise ValueError("Unsupported feedback protocol")
        position += len(text)

    try:
        if len(value) > 131072:
            return None
        space()
        while position < len(value):
            calls += 1
            if calls > 128:
                return None
            key = re.match(r"stack_trans\('[A-Za-z][A-Za-z0-9_]{0,95}'", value[position:])
            if not key:
                return None
            position += key.end()
            space()
            args = 0
            while position < len(value) and value[position] == ",":
                args += 1
                if args > 8:
                    return None
                position += 1
                space()
                take("!quot!")
                end = value.find("!quot!", position)
                if end < 0:
                    return None
                parts.append(("literal", value[last:position]))
                parts.append(("argument", value[position:end]))
                position = end + len("!quot!")
                last = end
                space()
            take(");")
            space()
            take("!NEWLINE!")
            space()
        if not calls:
            return None
        parts.append(("literal", value[last:]))
        return parts
    except ValueError:
        return None


def math_line_wraps(value: str):
    if not ((value.startswith(r"\[") and value.endswith(r"\]"))
            or (value.startswith(r"\(") and value.endswith(r"\)"))):
        return None
    if re.search(r"\\(?:text[A-Za-z]*|mbox|hbox)\b", value):
        return None
    # Do not delete ordinary spaces, CRs, repeated blank lines or line breaks
    # before symbols. This single pass removes only the specified TeX wrap.
    return re.sub(r"\n[ \t]*(?=[}\\])", "", value)


def presentation_reason(difference):
    path, expected, actual = (difference.get(key) for key in ("path", "expected", "actual"))
    if not isinstance(path, str) or type(expected) is not str or type(actual) is not str:
        return None
    if path.endswith(".latex"):
        for mbox, text in ((expected, actual), (actual, expected)):
            if (mbox.startswith(r"\mbox{ ") and mbox.endswith(" }")
                    and text.startswith(r"\text{") and text.endswith("}")
                    and mbox[len(r"\mbox{ "):-2] == text[len(r"\text{"):-1]):
                return "latex-text-container"
    if path.endswith(".nativeFeedback"):
        left, right = feedback_parts(expected), feedback_parts(actual)
        if left is None or right is None or len(left) != len(right):
            return None
        for (left_kind, left_value), (right_kind, right_value) in zip(left, right):
            if left_kind != right_kind:
                return None
            if left_value == right_value:
                continue
            if left_kind != "argument":
                return None
            left_math, right_math = math_line_wraps(left_value), math_line_wraps(right_value)
            if left_math is None or right_math is None or left_math != right_math:
                return None
        return "native-feedback-math-line-wrap"
    return None


def compare_results(expected, actual):
    raw = differences(expected, actual)
    presentation, unaccepted = [], []
    for difference in raw:
        reason = presentation_reason(difference)
        if reason:
            presentation.append({**difference, "reason": reason})
        else:
            unaccepted.append(difference)
    return {"differences": raw, "presentationDifferences": presentation, "unacceptedDifferences": unaccepted,
            "comparison": "unaccepted" if unaccepted else "presentation-equivalent" if raw else "exact",
            "passed": not unaccepted}


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
            'block([%ERR:["stack_map"],%NOTES:["stack_map"],%FEEDBACK:["stack_map"],%stmt:"ctm-native",'
            + "_m3_reference_value],_m3_reference_value:errcatch("
            + row["expression"] + "),"
            + "if _m3_reference_value=[] then m3_emit(sconcat("
            + marker + ',stackjson_stringify([false,"CAS evaluation failed"]))) '
            + "else if length(%ERR)>1 then m3_emit(sconcat(" + marker
            + ',stackjson_stringify([false,"Native question reported a CAS error"]))) '
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
              "stackRevision": STACK_SHA, "comparisonPolicy": PRESENTATION_POLICY, "passed": False, "observations": []}
    try:
        captured_bytes = args.browser_report.read_bytes()
        captured = load_json(captured_bytes)
        report["browserReport"] = {"path": str(args.browser_report), "sha256": sha256(captured_bytes),
                                   "sourceRevision": captured.get("sourceRevision"), "browserVersion": captured.get("browserVersion"),
                                   "passed": captured.get("passed") is True}
        runtime = captured.get("runtime")
        if not isinstance(runtime, dict) or runtime.get("stackRevision") != STACK_SHA:
            raise ValueError("Browser evidence does not identify the pinned STACK runtime revision")
        stack_version = str(runtime.get("stackLibraryVersion", ""))
        if not re.fullmatch(r"[0-9]+", stack_version):
            raise ValueError("Browser evidence does not identify a STACK library version")
        report["wasmRuntime"] = runtime
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
        report["stackFiles"] = checked_stack_files(source)
        report["operations"] = dict(operations)
        report["executionIsolation"] = (
            "One fresh native process replays the ordered aggregate of captured self-contained build/browser CAS blocks; "
            "original worker/session boundaries are not reconstructed")
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
                    observed[index] = load_json(match[2])
                elif match := VERSION.fullmatch(line):
                    versions.append({"maxima": match[1], "stackLibrary": match[2]})
                elif line.strip() == f"CTMNATIVE-END|{len(programs)}":
                    endings += 1
                elif line.lstrip().startswith(("CTMNATIVE-REFERENCE|", "CTMNATIVE-VERSION|", "CTMNATIVE-END|")):
                    raise ValueError("Malformed native protocol marker: " + line[:200])
            if len(versions) != 1 or endings != 1 or len(observed) != len(programs):
                raise ValueError(f"Incomplete native output: versions={len(versions)}, end={endings}, programs={len(observed)}/{len(programs)}")
            report["nativeRuntime"] = versions[0]
            if versions[0]["stackLibrary"] != stack_version:
                raise ValueError("Native STACK library version differs from the captured Wasm runtime: "
                                 + versions[0]["stackLibrary"] + " != " + stack_version)
            for index, row in enumerate(programs):
                value = observed[index]
                if not isinstance(value, list) or len(value) != 2 or type(value[0]) is not bool:
                    raise ValueError("Malformed native value envelope")
                comparison = compare_results(row["result"], value[1]) if value[0] else {
                    "differences": [{"nativeError": value[1]}], "presentationDifferences": [],
                    "unacceptedDifferences": [{"nativeError": value[1]}], "comparison": "unaccepted", "passed": False}
                report["observations"].append({"index": index, "operation": row.get("operation"),
                    "question": row.get("question"), "expressionSha256": sha256(row["expression"].encode("utf-8")),
                    "wasm": row["result"], "native": value[1], **comparison})
        report["passed"] = captured.get("passed") is True and all(row["passed"] for row in report["observations"])
        if captured.get("passed") is not True:
            report["failure"] = "The source browser run did not complete successfully; replayed partial evidence is diagnostic only"
        observations = report["observations"]
        report["summary"] = {"programs": len(programs), "passed": sum(row["passed"] for row in observations),
                             "different": sum(not row["passed"] for row in observations),
                             "exact": sum(row["comparison"] == "exact" for row in observations),
                             "presentationEquivalent": sum(row["comparison"] == "presentation-equivalent" for row in observations),
                             "unaccepted": sum(row["comparison"] == "unaccepted" for row in observations),
                             "rawDifferenceFields": sum(len(row["differences"]) for row in observations),
                             "acceptedPresentationFields": sum(len(row["presentationDifferences"]) for row in observations),
                             "unacceptedDifferenceFields": sum(len(row["unacceptedDifferences"]) for row in observations)}
    except Exception as error:
        report["failure"] = str(error)
    (args.output / "native-reference.json").write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report.get(key) for key in ("passed", "operations", "summary", "failure")}), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
