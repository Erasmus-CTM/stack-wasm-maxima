#!/usr/bin/env python3
"""Reuse the pinned CTM fixture inventory, native oracle and batch generator."""
import hashlib
import importlib
import json
import re
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "test-results/milestone-one"
OUT.mkdir(parents=True, exist_ok=True)
CTM = ROOT / ".ctm-checkers-source"
PIN = "9e042dc5e57a1636be64ca5d08910c9af5ff1371"
if subprocess.check_output(["git", "-C", str(CTM), "rev-parse", "HEAD"], text=True).strip() != PIN:
    raise RuntimeError("Wrong ctm-checkers source revision")
sys.path.insert(0, str(CTM / "tools/stack_native"))
runner = importlib.import_module("native_compliance.maxima_runner")
fixture_path = CTM / "tests/stack/native_compliance/fixtures.json"
fixture = json.loads(fixture_path.read_text())
cases = fixture["cases"]
selected = []
for family in runner.TESTS:
    for score in (1, 0):
        eligible = [c for c in cases if c["test"] == family and c["expected_score"] == score
                    and runner._unavailable(c) is None
                    and max(len(c[k]) for k in ("student", "teacher", "options")) <= 200]
        eligible.sort(key=lambda c: (sum(len(c[k]) for k in ("student", "teacher", "options")), c["ordinal"]))
        if not eligible:
            raise RuntimeError(f"No eligible {family}/{score} fixture")
        selected.append(eligible[0])
for score in (1, 0):
    eligible = [c for c in cases if c["test"] == "AlgEquiv" and c["expected_score"] == score
                and "matrix(" in c["student"] and "matrix(" in c["teacher"]
                and runner._unavailable(c) is None]
    eligible.sort(key=lambda c: (len(c["student"]) + len(c["teacher"]), c["ordinal"]))
    if not eligible:
        raise RuntimeError(f"No matrix/{score} fixture")
    if eligible[0]["id"] not in {c["id"] for c in selected}:
        selected.append(eligible[0])
prepared = {
    "ctmCheckersRevision": PIN,
    "fixtureSha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
    "selection": "shortest eligible positive/negative per CTM family plus matrix AlgEquiv pair",
    "cases": selected,
    "versions": [],
}
for sha in ("10d323311b7f39fb7b092dd10ce75f7d8632f525", "33383047af39c204bf4442802a058f8b918b2b1b"):
    source = ROOT / ".stack-upstream" / sha
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if actual != sha:
        raise RuntimeError("Wrong STACK source revision")
    # The oracle has one expected source pin. Configure that pin explicitly
    # for this run, without modifying the pinned source or its preparation.
    runner.STACK_SHA = sha
    native = runner.run_native(selected, source, jobs=2, timeout=180)
    (OUT / f"native-{sha[:7]}.json").write_text(json.dumps(native, indent=2) + "\n")
    home = ROOT / ".cache" / ("wasm-home-" + sha[:7])
    home.mkdir(parents=True, exist_ok=True)
    batch = runner.make_batch(source, selected, home, 0)
    batch = batch.replace(str(home.resolve()), "/ctm").replace(str(source.resolve()), "/ctm/moodle-qtype_stack-master")
    batch = batch.replace("quit()$", 'print(sconcat("M1META|",stackmaximaversion,"|",MAXIMA_VERSION_STR))$')
    version_match = re.search(r"stackmaximaversion:(\d+)", (source / "stack/maxima/stackmaxima.mac").read_text())
    if not version_match:
        raise RuntimeError("Missing STACK library version")
    # printf writes protocol records to the character stream; print may use
    # the browser-specific displayOutput hook instead of stdout.
    batch = "m1_print(ex):=printf(true,\"~a~%\",ex)$\n" + batch.replace("print(", "m1_print(")
    sources = []
    for path in sorted((source / "stack/maxima").rglob("*")):
        if path.is_file() and path.suffix in (".mac", ".lisp"):
            data = path.read_bytes()
            sources.append({
                "path": path.relative_to(source).as_posix(),
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
                "content": data.decode("utf-8"),
            })
    prepared["versions"].append({
        "stackRevision": sha, "stackLibraryVersion": version_match[1], "native": native, "batch": batch, "files": sources,
        "transportAdaptations": ["filesystem path rebasing", "terminal quit replaced with version marker", "protocol print routed through printf"],
    })
(OUT / "prepared.json").write_text(json.dumps(prepared, indent=2) + "\n")
print(f"Prepared {len(selected)} official fixtures at {len(prepared['versions'])} STACK revisions")
