#!/usr/bin/env python3
"""Compare browser output using CTM's existing strict native parser."""
import importlib
import json
import os
import re
from pathlib import Path
import shutil
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "test-results/milestone-one"
REPORT = Path(os.environ.get("MILESTONE_ONE_REPORT_ROOT", str(ROOT / "reports/milestone-one")))
REPORT.mkdir(parents=True, exist_ok=True)
ARCHIVE = REPORT / "runs" / os.environ.get("GITHUB_RUN_ID", "local")
ARCHIVE.mkdir(parents=True, exist_ok=True)
summary = {
    "schema": 1, "recordedAt": datetime.now(timezone.utc).isoformat(),
    "sourceRevision": os.environ.get("GITHUB_SHA"),
    "runURL": ("https://github.com/" + os.environ.get("GITHUB_REPOSITORY", "") + "/actions/runs/" + os.environ.get("GITHUB_RUN_ID", "")),
    "status": "failed", "versions": [], "errors": [],
    "scope": "Selected direct STACK answer-test functions; not PHP/controller, PRT, Quarto UI or PythonChecker parity.",
}
try:
    prepared = json.loads((OUT / "prepared.json").read_text())
    sys.path.insert(0, str(ROOT / ".ctm-checkers-source/tools/stack_native"))
    runner = importlib.import_module("native_compliance.maxima_runner")
    summary["ctmCheckersRevision"] = prepared["ctmCheckersRevision"]
    summary["fixtureSha256"] = prepared["fixtureSha256"]
    summary["cases"] = prepared["cases"]
    for version in prepared["versions"]:
        sha = version["stackRevision"]
        item = {"stackRevision": sha, "passed": False, "differences": []}
        try:
            result = json.loads((OUT / f"browser-{sha[:7]}.json").read_text())
            item.update(browser=result.get("browser"), readyMs=result.get("readyMs"), totalMs=result.get("totalMs"), stackReadyMs=result.get("stackReadyMs"),
                        interruptChecks=result.get("interruptChecks"), injectedInterruptChecks=result.get("injectedInterruptChecks"),
                        servedAssetCount=len(result.get("servedAssets", [])),
                        sourceFileCount=len(result.get("files", [])))
            if result.get("injectedInterruptChecks") != 3:
                raise RuntimeError("The mid-input interrupt transport checks did not all execute")
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "Browser execution did not finish")
            version_match = re.search(r"^M1META\|([^|\r\n]+)\|([^\r\n]+)", result["stdout"], re.M)
            if not version_match or version_match[1] != version["stackLibraryVersion"]:
                raise RuntimeError("STACK library did not reach its pinned end-of-file version declaration")
            item["wasmMaximaVersion"] = version_match[2]
            if result.get("serverErrors"):
                raise RuntimeError("Runtime asset server recorded errors")
            observed = runner.parse_output(result["stdout"], prepared["cases"], 0)
            native = version["native"]["observations"]
            if len(observed) != len(native) or any(row["status"] != "ok" for row in native):
                raise RuntimeError("Incomplete native reference")
            fields = ("status", "cas_valid", "correct", "answer_note")
            for left, right in zip(observed, native):
                if left["case_id"] != right["case_id"] or any(left.get(k) != right.get(k) for k in fields):
                    item["differences"].append({"browser": left, "native": right})
            item["comparisonCount"] = len(observed)
            item["passed"] = not item["differences"]
            item["nativeMetadata"] = version["native"]["metadata"]
        except Exception as error:
            item["error"] = str(error)
        summary["versions"].append(item)
    summary["status"] = "passed" if len(summary["versions"]) == 2 and all(v["passed"] for v in summary["versions"]) else "failed"
except Exception as error:
    summary["errors"].append(str(error))
for path in OUT.glob("*"):
    if path.name != "prepared.json" and path.suffix in (".json", ".log"):
        shutil.copy2(path, REPORT / path.name)
        shutil.copy2(path, ARCHIVE / path.name)
(REPORT / "latest.json").write_text(json.dumps(summary, indent=2) + "\n")
(ARCHIVE / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
lines = ["# Milestone 1: recorded browser/native experiment", "",
         f"Status: **{summary['status']}**.", "",
         f"Source commit: {summary['sourceRevision']}.", "",
         f"Workflow evidence: {summary['runURL']}", "",
         "The same selected CTM official fixtures and native parser are used for both execution paths.",
         "A fresh Wasm worker is used for each STACK revision; the selected cases share that session.", "",
         "| STACK revision | Result | Compared rows | Runtime ready ms | STACK ready ms | Total check ms |",
         "|---|---|---:|---:|---:|---:|"]
for item in summary["versions"]:
    lines.append(f"| {item['stackRevision'][:7]} | {'pass' if item['passed'] else 'fail'} | {item.get('comparisonCount', 0)} | {item.get('readyMs', '')} | {item.get('stackReadyMs', '')} | {item.get('totalMs', '')} |")
lines.extend(["", "Timings describe this CI dependency check with predownloaded local runtime files, not cold course-page loading.",
              "Detailed differences, raw output, dependency hashes and failures are in the JSON/log files beside this report.",
              "", "## Runs needed", "",
              "- Resolve every recorded loader/runtime failure before extending scope." if summary["status"] != "passed" else "- Run the matching documentation demos through the CTM frontend.",
              "- Implement the requested stack-maxima Quarto entry point and paired demo timings.",
              "- Establish full input validation, PRT and PythonChecker integration, isolation/reset, and broader browser coverage.",
              "", "Selected fixture data originates in STACK (GPL-3.0-or-later); see THIRD-PARTY-NOTICES.md."])
(REPORT / "latest.md").write_text("\n".join(lines) + "\n")
(ARCHIVE / "summary.md").write_text("\n".join(lines) + "\n")
print(json.dumps(summary, indent=2))
sys.exit(0 if summary["status"] == "passed" else 1)
