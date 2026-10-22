#!/usr/bin/env python3
"""Publish the verified accepted Quarto exercises with the comparison landing page."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
ACCEPTED_SHA256 = "bee2255220f31b3e4b681cce6baa170c01ee843d36818bd239baddf52b92e7e1"
PREFIX = ".cache/milestone-two/demo/_site/"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accepted-artifact", type=Path, required=True)
    parser.add_argument("--comparison-html", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    archive_hash = digest(args.accepted_artifact.read_bytes())
    if archive_hash != ACCEPTED_SHA256:
        raise ValueError("Accepted artifact checksum does not match run 39721228518")
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use an empty output directory; existing publication is preserved")
    output.mkdir(parents=True, exist_ok=True)
    accepted_files = []
    with ZipFile(args.accepted_artifact) as archive:
        for member in archive.infolist():
            if member.is_dir() or not member.filename.startswith(PREFIX):
                continue
            relative = PurePosixPath(member.filename[len(PREFIX):])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe artifact path")
            data = archive.read(member)
            target = output.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            accepted_files.append({"path": str(relative), "bytes": len(data), "sha256": digest(data)})
    required = ["sympy/index.html", "sympy/examples.html", "maxima/index.html", "maxima/examples.html",
                "backend/worker.js", "runtime/maxima-child.js", "maxima-runtime/maxima.wasm", "MATERIALIZATION.json"]
    if len(accepted_files) != 275 or any(not (output / item).is_file() for item in required):
        raise ValueError("Accepted interactive site is incomplete")
    shutil.copyfile(args.comparison_html, output / "index.html")
    shutil.copyfile(ROOT / "comparison/_headers", output / "_headers")
    files = [{"path": str(path.relative_to(output)), "bytes": path.stat().st_size,
              "sha256": digest(path.read_bytes())} for path in sorted(output.rglob("*")) if path.is_file()]
    record = {"schema": 1, "accepted_browser_run": 39721228518,
              "accepted_executable_source": "2493268c2bf3eb9941407f376d20a07fb5da4ec9",
              "accepted_artifact_sha256": archive_hash, "accepted_site_files": accepted_files,
              "publication_changes": ["index.html replaced by comparison Quarto page", "_headers added for cross-origin isolation"],
              "files": files}
    (output / "PUBLICATION.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"output": str(output), "files": len(files) + 1,
                      "bytes": sum(item["bytes"] for item in files), "accepted_artifact_sha256": archive_hash}))


if __name__ == "__main__":
    main()
