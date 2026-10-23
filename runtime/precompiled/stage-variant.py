#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stage an explicit opt-in compiled STACK manifest beside the source control."""
import argparse
import copy
import hashlib
import json
import subprocess
from pathlib import Path

PIN = "33383047af39c204bf4442802a058f8b918b2b1b"
ENTRY = "stack/maxima/stackmaxima.mac"
LOADER = "stack/maxima/stacklocallinux.mac"
OLD = 'load("stackmaxima.mac")$'
NEW = 'load("/ctm/moodle-qtype_stack-master/stack/maxima/stackmaxima.fas")$'
ASSET = "stackmaxima.fas"
START_LOAD = 'load("/ctm/moodle-qtype_stack-master/stack/maxima/stacklocallinux.mac")$'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def exact_file(manifest, stack, path):
    matches = [row for row in manifest["files"] if row["path"] == path]
    if len(matches) != 1:
        raise ValueError("Expected one STACK file: " + path)
    row = matches[0]
    actual = (stack / path).read_bytes()
    if (row["content"].encode("utf-8") != actual or row["bytes"] != len(actual)
            or row["sha256"] != digest(actual)):
        raise ValueError("STACK manifest/source mismatch: " + path)
    return row, actual


def stage(site, stack, bundle, translated):
    if subprocess.check_output(["git", "-C", str(stack), "rev-parse", "HEAD"], text=True).strip() != PIN:
        raise ValueError("STACK checkout differs from the exact compiled source pin")
    original_path = site / "stack-sources.json"
    original = json.loads(original_path.read_text(encoding="utf-8"))
    if original.get("schema") != 1 or original.get("stackRevision") != PIN or "compiledStack" in original:
        raise ValueError("Expected the original source-loaded STACK manifest")
    if original["startup"].count(START_LOAD) != 1:
        raise ValueError("Expected one exact STACK startup command")
    _, source = exact_file(original, stack, ENTRY)
    loader, loader_source = exact_file(original, stack, LOADER)
    if loader["content"].count(OLD) != 1:
        raise ValueError("Pinned loader does not contain one exact STACK entry load")
    binary = bundle.read_bytes()
    lisp = translated.read_bytes()
    adapter = translated.parent / "display2d-bridge.lisp"
    adapter_bytes = adapter.read_bytes()
    reviewed_adapter = Path(__file__).with_name("display2d-bridge.lisp").read_bytes()
    if not adapter_bytes or adapter_bytes != reviewed_adapter:
        raise ValueError("Compiled assignment bridge differs from the reviewed source")
    if not binary or not lisp:
        raise ValueError("Compiled bundle and translation must be nonempty")
    target = site / "maxima-runtime" / ASSET
    if target.exists():
        raise ValueError("Refusing to replace an existing runtime file")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(binary)
    timed = copy.deepcopy(original)
    timed["startup"] = timed["startup"].replace(START_LOAD,
        'm2_emit("CTMSTACK-LOAD-BEGIN")$\n' + START_LOAD + '\nm2_emit("CTMSTACK-LOAD-END")$')
    timed_output = site / "stack-sources-timed-source.json"
    if timed_output.exists():
        raise ValueError("Refusing to replace an existing timed source manifest")
    timed_output.write_text(json.dumps(timed, ensure_ascii=False) + "\n", encoding="utf-8")
    variant = copy.deepcopy(timed)
    replacement = loader["content"].replace(OLD, NEW)
    changed = next(row for row in variant["files"] if row["path"] == LOADER)
    changed.update({"content": replacement, "bytes": len(replacement.encode("utf-8")),
                    "sha256": digest(replacement.encode("utf-8"))})
    variant["compiledStack"] = {
        "schema": 1, "mode": "entry-fas", "stackRevision": PIN,
        "sourcePath": ENTRY, "sourceSha256": digest(source),
        "translatedLispSha256": digest(lisp),
        "translationAdapter": {"mode": "symbolic-assignment-hooks+packagefile", "path": adapter.name,
                               "fileBytes": len(adapter_bytes), "sha256": digest(adapter_bytes)},
        "originalLoaderSha256": digest(loader_source),
        "overlayLoaderSha256": changed["sha256"],
        "asset": {"path": ASSET, "fileBytes": len(binary), "sha256": digest(binary)},
    }
    output = site / "stack-sources-precompiled.json"
    if output.exists():
        raise ValueError("Refusing to replace an existing compiled manifest")
    output.write_text(json.dumps(variant, ensure_ascii=False) + "\n", encoding="utf-8")
    return variant["compiledStack"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", type=Path, required=True)
    parser.add_argument("--stack-source", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--translated", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(stage(args.site, args.stack_source, args.bundle, args.translated), indent=2))
