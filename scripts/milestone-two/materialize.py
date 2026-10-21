#!/usr/bin/env python3
"""Materialize a matched Quarto project from pinned CTM source checkouts.

Implementation sources and UI assets keep their existing homes. This script
copies their pinned versions into an ignored build directory and applies three
guarded frontend descriptor substitutions. It never fetches runtime binaries.
"""
from __future__ import annotations

import argparse
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / "demos/manifest.json"
QUESTION_BLOCK = re.compile(r"```\{([^\n]*)\}\r?\n([\s\S]*?)\r?\n```", re.M)
SOURCE_PANEL = re.compile(
    r'(<summary>Show source</summary>\s*<pre><code class="language-markdown">)([\s\S]*?)(</code></pre>)'
)


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def pinned_checkout(folder: Path, expected: str) -> None:
    actual = subprocess.check_output(
        ["git", "-C", str(folder), "rev-parse", "HEAD"], text=True
    ).strip()
    if actual != expected:
        raise ValueError(f"Wrong source revision in {folder}: expected {expected}, got {actual}")


def checked_bytes(folder: Path, relative: str, expected: str) -> bytes:
    path = folder / relative
    data = path.read_bytes()
    actual = blob_sha(data)
    if actual != expected:
        raise ValueError(f"Source blob mismatch for {path}: expected {expected}, got {actual}")
    return data


def copy_tree(source: Path, target: Path) -> None:
    if not source.is_dir():
        raise ValueError(f"Required source directory is missing: {source}")
    shutil.copytree(source, target, dirs_exist_ok=True)


def options(text: str) -> dict:
    found = {}
    for line in text.splitlines():
        match = re.fullmatch(r"#\|\s*([\w-]+):\s*(.*?)\s*", line)
        if match:
            found[match[1]] = match[2]
        elif line.strip():
            raise ValueError("Question option block contains non-option text")
    return found


def patch_frontend(extension: Path) -> list[dict]:
    path = extension / "stack-sympy.js"
    original = path.read_bytes()
    text = original.decode("utf-8")
    replacements = [
        (
            "  var workerURL = new URL('worker.js', current.src);",
            "  var backendDescriptor = window.CTMStackBackend || {};\n"
            "  var workerURL = backendDescriptor.workerURL ?\n"
            "    new URL(backendDescriptor.workerURL, document.baseURI) : new URL('worker.js', current.src);",
        ),
        (
            "loadTimeout: runtime.loadTimeout };",
            "loadTimeout: backendDescriptor.loadTimeout || runtime.loadTimeout };",
        ),
        (
            "type === 'grade' ? 'Checking with SymPy…' :",
            "type === 'grade' ? 'Checking with ' + (backendDescriptor.label || 'SymPy') + '…' :",
        ),
    ]
    for before, after in replacements:
        count = text.count(before)
        if count != 1:
            raise ValueError(f"Frontend descriptor seam changed: expected one {before!r}, found {count}")
        text = text.replace(before, after)
    result = text.encode("utf-8")
    path.write_bytes(result)
    return [{
        "path": "_extensions/stack-sympy/stack-sympy.js",
        "sourceSha256": digest(original), "materializedSha256": digest(result),
        "substitutions": [before for before, _ in replacements],
    }]


def documentation_links(text: str) -> str:
    # The matched prototype renders the two exercise pages only. Their teacher
    # documentation remains the original site's documentation, not a local copy.
    return re.sub(
        r"\]\(((?:docs/[^)\s#]+|corpus)\.qmd)(#[^)\s]+)?\)",
        lambda m: "](https://erasmus-ctm.github.io/stack-sympy/"
        + m[1][:-4] + ".html" + (m[2] or "") + ")",
        text,
    )


def paired_page(source: str, demos: list[dict], maxima: bool) -> tuple[str, dict]:
    index = 0
    authored = {}

    def replace(match):
        nonlocal index
        attributes, body = match.groups()
        if ".stack-question" not in attributes.split():
            return match[0]
        if index >= len(demos):
            raise ValueError("More live question blocks than the manifest")
        demo = demos[index]
        index += 1
        if options(body) != demo["options"]:
            raise ValueError(f"Authored options differ from manifest for {demo['id']}")
        if maxima:
            attributes = attributes.replace(".stack-question", ".stack-maxima")
            block = "::: {" + attributes + "}\n" + body + "\n:::"
            authored[demo["id"]] = block
        else:
            block = match[0]
        # This outer marker is for paired verification; CTM card markup stays
        # untouched and its original identifier remains unchanged.
        return (':::: {.ctm-demo-card data-demo-id="' + demo["id"] + '"}\n\n'
                + block + "\n\n::::")

    result = QUESTION_BLOCK.sub(replace, source)
    if index != len(demos):
        raise ValueError(f"Expected {len(demos)} live question blocks; found {index}")
    return documentation_links(result), authored


def materialize(args, manifest: dict) -> None:
    output = args.output.resolve()
    try:
        relative = output.relative_to(ROOT.resolve())
    except ValueError as exc:
        raise ValueError("The generated project must stay inside this repository") from exc
    if not relative.parts:
        raise ValueError("The generated project cannot replace the repository root")
    sympy = args.stack_sympy_source.resolve()
    checkers = args.ctm_checkers_source.resolve()
    libs = args.ctm_libs_source.resolve()
    pinned_checkout(sympy, manifest["stackSympyRevision"])
    pinned_checkout(checkers, manifest["questionSourceRevision"])
    pinned_checkout(libs, manifest["ctmDependencies"]["ctm-libs"]["commit"])
    output.mkdir(parents=True, exist_ok=True)
    copy_tree(sympy / "_extensions/stack-sympy", output / "_extensions/stack-sympy")
    copy_tree(checkers / "_extensions/ctm-checkers", output / "_extensions/ctm-checkers")
    copy_tree(libs / "_extensions/ctm-libs", output / "_extensions/ctm-libs")
    copy_tree(ROOT / "prototype/quarto", output / "_extensions/stack-maxima")
    copy_tree(sympy / "feedback", output / "feedback")
    patches = patch_frontend(output / "_extensions/stack-sympy")
    source_records = []
    for demo in manifest["demos"]:
        for entry in (demo["questionSource"], demo.get("pythonCheckerSource")):
            if not entry:
                continue
            data = checked_bytes(checkers, entry["path"], entry["gitBlobSha"])
            source_records.append({**entry, "sha256": digest(data), "bytes": len(data)})
    # Copy the same example tree the original site uses, retaining its download
    # and license/provenance files. Golden-only probe/supplement directories are
    # omitted exactly as in stack-sympy's own pre-render script.
    examples = checkers / "examples/stack"
    for backend in ("sympy", "maxima"):
        shutil.copytree(examples, output / backend / "questions", dirs_exist_ok=True,
                        ignore=lambda directory, names: {"probes", "supplement"} & set(names)
                        if Path(directory) == examples else ())
    authored_blocks = {}
    for page in ("index.qmd", "examples.qmd"):
        demos = [d for d in manifest["demos"] if d["sourcePage"] == page]
        raw = checked_bytes(sympy, page, demos[0]["sourcePageGitBlobSha"])
        for backend in ("sympy", "maxima"):
            text, authored = paired_page(raw.decode("utf-8"), demos, backend == "maxima")
            (output / backend / page).write_text(text, encoding="utf-8")
            authored_blocks.update(authored)
    # The root owns these assets; copying here is convenient for local reruns.
    # Missing runtime assets are supplied by prepare-runtime.py before render.
    for directory in ("backend", "runtime"):
        source = ROOT / "prototype" / directory
        if source.is_dir():
            copy_tree(source, output / directory)
    (output / "_quarto.yml").write_text(PROJECT_YAML, encoding="utf-8")
    (output / "index.qmd").write_text(LANDING, encoding="utf-8")
    record = {
        "schema": 1, "sourcePins": {
            "stack-sympy": manifest["stackSympyRevision"],
            "ctm-checkers": manifest["questionSourceRevision"],
            "ctm-libs": manifest["ctmDependencies"]["ctm-libs"]["commit"],
        }, "frontendPatches": patches,
        "questionSources": list({r["path"]: r for r in source_records}.values()),
        "authoredMaximaBlocks": authored_blocks,
        "cards": len(manifest["demos"]),
        "variants": sum(int(d["options"].get("variants", 1)) for d in manifest["demos"]),
        "pythonCheckerCards": sum("pythonCheckerSource" in d for d in manifest["demos"]),
    }
    write_json(output / "MATERIALIZATION.json", record)
    print(json.dumps({"project": str(output), "cards": record["cards"],
                      "variants": record["variants"], "pythonCheckerCards": record["pythonCheckerCards"]}))


class Cards(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.div_depth = 0
        self.wrapper = None
        self.wrapper_depth = None
        self.capture = None
        self.found = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "div":
            self.div_depth += 1
            if "data-demo-id" in attrs:
                if self.wrapper is not None:
                    raise ValueError("Nested paired-demo markers")
                self.wrapper, self.wrapper_depth = attrs["data-demo-id"], self.div_depth
        if tag == "script" and "stack-sympy-data" in attrs.get("class", "").split():
            if self.wrapper is None:
                raise ValueError("CTM question payload has no paired-demo marker")
            self.capture = []

    def handle_data(self, data):
        if self.capture is not None:
            self.capture.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.capture is not None:
            self.found.append((self.wrapper, json.loads("".join(self.capture))))
            self.capture = None
        if tag == "div":
            if self.div_depth == self.wrapper_depth:
                self.wrapper = self.wrapper_depth = None
            self.div_depth -= 1


def collect(args, manifest: dict) -> None:
    site = args.collect_site.resolve()
    provenance_path = site / "MATERIALIZATION.json"
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    expected = {d["id"]: d for d in manifest["demos"]}
    results = {}
    for backend in ("sympy", "maxima"):
        cards = {}
        for page in ("index", "examples"):
            path = site / backend / (page + ".html")
            text = path.read_text(encoding="utf-8")
            parser = Cards()
            parser.feed(text)
            ids = [d["id"] for d in manifest["demos"] if d["sourcePage"] == page + ".qmd"]
            if [identifier for identifier, _ in parser.found] != ids:
                raise ValueError(f"Rendered card order/count mismatch on {backend}/{page}.html")
            for identifier, payload in parser.found:
                if identifier in cards:
                    raise ValueError(f"Duplicate card {identifier}")
                count = int(expected[identifier]["options"].get("variants", 1))
                if len(payload.get("variants", [])) != count:
                    raise ValueError(f"Frozen variant count mismatch for {identifier}")
                cards[identifier] = payload
            if backend == "maxima":
                replacements = iter(provenance["authoredMaximaBlocks"][identifier] for identifier in ids)
                def source_panel(match):
                    return match[1] + html.escape(next(replacements), quote=False) + match[3]
                text, count = SOURCE_PANEL.subn(source_panel, text)
                if count != len(ids):
                    raise ValueError(f"Expected {len(ids)} source panels on {path}; found {count}")
                path.write_text(text, encoding="utf-8")
        if cards.keys() != expected.keys():
            raise ValueError(f"Incomplete {backend} question inventory")
        results[backend] = cards
    if results["sympy"] != results["maxima"]:
        different = [key for key in expected if results["sympy"][key] != results["maxima"][key]]
        raise ValueError("Paired frozen payloads differ: " + ", ".join(different))
    frozen = []
    for identifier, payload in results["sympy"].items():
        serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        frozen.append({"demoId": identifier, "payloadSha256": digest(serialized), "payload": payload})
    record = {"schema": 1, "sourcePins": provenance["sourcePins"],
              "pairedPayloadsIdentical": True, "cards": len(frozen),
              "variants": sum(len(row["payload"]["variants"]) for row in frozen), "demos": frozen}
    target = args.payload_output or site.parent / "frozen-payloads.json"
    write_json(target, record)
    print(json.dumps({"pairedPayloadsIdentical": True, "cards": record["cards"],
                      "variants": record["variants"], "payloadFile": str(target)}))


PROJECT_YAML = """project:
  type: website
  output-dir: _site
  render:
    - index.qmd
    - sympy/index.qmd
    - sympy/examples.qmd
    - maxima/index.qmd
    - maxima/examples.qmd
  resources:
    - backend/**
    - runtime/**
    - maxima-runtime/**
    - stack-sources.json
    - sympy/questions/**
    - maxima/questions/**
    - MATERIALIZATION.json

website:
  title: "STACK backend comparison"
  navbar:
    left:
      - href: maxima/index.qmd
        text: Maxima
      - href: maxima/examples.qmd
        text: Maxima questions
      - href: sympy/index.qmd
        text: SymPy
      - href: sympy/examples.qmd
        text: SymPy questions

format:
  html:
    theme: cosmo
    toc: true
    html-math-method: mathjax
    code-copy: true

filters:
  - stack-maxima
  - stack-sympy

ai-feedback:
  policy-files: feedback/course.yml
  project-policy:
    math-exercise: course-mathematics
"""

LANDING = """---
title: "The same questions with two grading backends"
---

Choose a backend, then try the same questions and variants.

| Backend | Landing-page question | Worked questions |
|---|---|---|
| Maxima | [Try Maxima](maxima/index.qmd) | [Open Maxima questions](maxima/examples.qmd) |
| SymPy | [Try SymPy](sympy/index.qmd) | [Open SymPy questions](sympy/examples.qmd) |
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--stack-sympy-source", type=Path)
    parser.add_argument("--ctm-checkers-source", type=Path)
    parser.add_argument("--ctm-libs-source", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / ".cache/milestone-two/demo")
    parser.add_argument("--collect-site", type=Path, help="Check rendered pair and collect its actual frozen payloads")
    parser.add_argument("--payload-output", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if args.collect_site:
        collect(args, manifest)
    else:
        if not all((args.stack_sympy_source, args.ctm_checkers_source, args.ctm_libs_source)):
            parser.error("materialization requires all three pinned source checkouts")
        materialize(args, manifest)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
