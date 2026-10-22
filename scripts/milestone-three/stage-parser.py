#!/usr/bin/env python3
"""Stage the pinned STACK-MP-lite recognizer and STACK input-security data.

Only the ES module export is adapted for a classic worker. No parser grammar,
AST behavior, or STACK security data is edited. This is a bounded browser input
controller, not a claim of Moodle PHP corrective-parser parity.
"""
# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

STACK_REVISION = "33383047af39c204bf4442802a058f8b918b2b1b"
SOURCES = {
    "corsscripts/stackmplite.js": "6c9bddd5edd62bb29b138f2729b35acf1ee52254a6487252c102d98d4a549463",
    "stack/cas/security-map.json": "6a0435870103287eb3ed2f4048e58f76be0e9abc81c0bde9afe76292978bfd58",
    "stack/maximaparser/unicode/symbols-stack.json": "dcdf658aa7d23d0767eeafa4249e166469d5ab2e37cbe8010a279b870aa5ea43",
    "stack/maximaparser/unicode/letters-stack.json": "38983ed0f7b43213fe59f09497601629007b4b6434b24f0b047b06bda2d044b7",
}


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stage(source: Path, output: Path) -> dict:
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if revision != STACK_REVISION:
        raise ValueError(f"Expected STACK {STACK_REVISION}, got {revision}")
    original = {}
    for path, expected in SOURCES.items():
        # Reading the committed blob also works with the existing sparse
        # checkout and cannot accidentally consume a modified local file.
        value = subprocess.check_output(["git", "-C", str(source), "show", f"{STACK_REVISION}:{path}"])
        if digest(value) != expected:
            raise ValueError("Pinned STACK source hash mismatch: " + path)
        original[path] = value
    parser_source = original["corsscripts/stackmplite.js"].decode("utf-8")
    export = re.search(r"\nexport \{(?P<names>[\s\S]*?)\};\s*\Z", parser_source)
    if not export:
        raise ValueError("Pinned STACK-MP-lite export block changed")
    names = [name.strip() for name in export["names"].split(",") if name.strip()]
    if not names or any(not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name) for name in names):
        raise ValueError("Unsupported STACK-MP-lite export declaration")
    parser = ("(function (scope) {\n" + parser_source[:export.start()] +
              "\nscope.StackMaximaParser = Object.freeze({" + ",".join(names) + "});\n})(self);\n").encode("utf-8")
    security = json.loads(original["stack/cas/security-map.json"])
    symbols = json.loads(original["stack/maximaparser/unicode/symbols-stack.json"])
    letters = json.loads(original["stack/maximaparser/unicode/letters-stack.json"])

    def level(entry):
        return entry.get("constant", entry.get("variable", "-"))

    records = [{"path": path, "sha256": digest(body), "bytes": len(body)} for path, body in original.items()]
    rules = {
        "schema": 1, "stackRevision": STACK_REVISION,
        "license": "GPL-3.0-or-later", "sourceFiles": records,
        "readable": sorted(k for k, v in security.items() if level(v) == "s"),
        "unreadable": sorted(k for k, v in security.items() if level(v) == "f" or
                             (("keyword" in v or "operator" in v) and "specialallowvariable" not in v)),
        "callable": sorted(k for k, v in security.items() if v.get("function") == "s"),
        "functions": [k for k, v in security.items() if "function" in v],
        "variables": [k for k, v in security.items() if "variable" in v or "constant" in v],
        "globallyForbidden": sorted(k for k, v in security.items() if v.get("globalyforbiddenvariable")),
        "replacements": list(symbols.items()) + list(letters.items()),
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "stack-parser.js").write_bytes(parser)
    rules_bytes = (json.dumps(rules, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    (output / "input-rules.json").write_bytes(rules_bytes)
    record = {
        "schema": 1, "stackRevision": STACK_REVISION, "sourceFiles": records,
        "parser": {"path": "stack-parser.js", "sha256": digest(parser), "bytes": len(parser),
                   "transformation": "Wrap unchanged parser body and replace terminal ES export with self.StackMaximaParser"},
        "rules": {"path": "input-rules.json", "sha256": digest(rules_bytes), "bytes": len(rules_bytes)},
        "scope": "Bounded admission for native Maxima; STACK-MP-lite recognizes syntax, Maxima determines operator precedence",
    }
    (output / "input-provenance.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="Native asset directory")
    args = parser.parse_args()
    print(json.dumps(stage(args.stack_source.resolve(), args.output.resolve())))


if __name__ == "__main__":
    main()
