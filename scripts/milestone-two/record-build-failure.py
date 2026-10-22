"""Preserve build failures without inventing browser checks or measurements."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
directory = root / "reports/milestone-two"
directory.mkdir(parents=True, exist_ok=True)
target = directory / "latest.json"
revision = os.environ["GITHUB_SHA"]
if target.is_file() and json.loads(target.read_text()).get("sourceRevision") == revision:
    raise SystemExit(0)  # The browser launcher has already recorded this run.
record = {
    "schema": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
    "sourceRevision": revision,
    "runURL": f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
    "passed": False, "status": "build failed before browser report",
    "steps": json.loads(os.environ.get("MILESTONE_STEPS", "{}")),
    "timings": [], "verifiedBrowserVariants": 0,
    "sourceFiles": subprocess.check_output(["git", "ls-tree", "-r", revision], cwd=root, text=True).splitlines(),
    "runsNeeded": ["Complete build and frozen-payload collection", "Execute both browser backends and collect measurements"],
}
target.write_text(json.dumps(record, indent=2) + "\n")
(directory / "latest.md").write_text(
    "# Milestone 2: build failure\n\nStatus: **failed before browser reporting**.\n\n"
    f"Source commit: `{revision}`.\n\nWorkflow evidence: {record['runURL']}\n\n"
    "No completed browser coverage or timings are claimed. See the JSON step outcomes and workflow logs.\n"
)
