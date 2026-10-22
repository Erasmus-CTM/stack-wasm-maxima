#!/usr/bin/env python3
"""Materialize a matched Quarto project from pinned CTM source checkouts.

Implementation sources and UI assets keep their existing homes. This script
copies their pinned versions into an ignored build directory and applies a
guarded per-card backend seam. It never fetches runtime binaries.
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
MAXIMA_DIV = re.compile(r"^:::\s*\{([^}\n]*\.stack-maxima[^}\n]*)\}\r?\n([\s\S]*?)^:::\s*$", re.M)
SOURCE_PANEL = re.compile(
    r'(<summary>Show source</summary>\s*<pre><code class="language-markdown">)([\s\S]*?)(</code></pre>)'
)
OBSOLETE_POLYFILL = re.compile(
    r'^[ \t]*<script src="https://cdnjs\.cloudflare\.com/polyfill/v3/polyfill\.min\.js\?features=es6"></script>\n?',
    re.M,
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
    from frontend import patch_frontend as apply_backend_routing
    return apply_backend_routing(extension)


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


def prepare_existing(args, manifest: dict) -> None:
    """Stage pinned dependencies for tracked Quarto source without rewriting it."""
    output = args.prepare_existing.resolve()
    source = output / "maxima/examples.qmd"
    if not source.is_file():
        raise ValueError("The tracked reviewer source is missing: " + str(source))
    sympy = args.stack_sympy_source.resolve()
    checkers = args.ctm_checkers_source.resolve()
    libs = args.ctm_libs_source.resolve()
    pinned_checkout(sympy, manifest["stackSympyRevision"])
    pinned_checkout(checkers, manifest["questionSourceRevision"])
    pinned_checkout(libs, manifest["ctmDependencies"]["ctm-libs"]["commit"])

    text = source.read_text(encoding="utf-8")
    maxima = MAXIMA_DIV.findall(text)
    sympy_blocks = [(attributes, body) for attributes, body in QUESTION_BLOCK.findall(text)
                    if ".stack-question" in attributes.split()]
    demos = [demo for demo in manifest["demos"] if demo["sourcePage"] == "examples.qmd"]
    pair_ids = re.findall(r'^:::::\s*\{\.backend-pair\s+data-demo-id="([^"]+)"\}', text, re.M)
    if pair_ids != [demo["id"] for demo in demos]:
        raise ValueError("Tracked question pairs must match the accepted manifest order")
    pairs = []
    for backend, blocks in (("sympy", sympy_blocks), ("maxima", maxima)):
        if len(blocks) != len(demos):
            raise ValueError(f"Expected {len(demos)} tracked {backend} blocks; found {len(blocks)}")
        for (attributes, body), demo in zip(blocks, demos):
            if options(body) != demo["options"]:
                raise ValueError("Tracked options differ from the accepted manifest for " + demo["id"])
            if "#" + backend + "-" + demo["id"] not in attributes.split():
                raise ValueError("Missing unique backend card identifier for " + demo["id"])
    for index, demo in enumerate(demos):
        pairs.append({"demoId": demo["id"], "sympyId": "sympy-" + demo["id"],
                      "maximaId": "maxima-" + demo["id"],
                      "acceptedPayloadId": demo.get("authoredIdentifier") or "stack-sympy-" + str(index + 1)})

    copy_tree(sympy / "_extensions/stack-sympy", output / "_extensions/stack-sympy")
    copy_tree(checkers / "_extensions/ctm-checkers", output / "_extensions/ctm-checkers")
    copy_tree(libs / "_extensions/ctm-libs", output / "_extensions/ctm-libs")
    copy_tree(ROOT / "prototype/quarto", output / "_extensions/stack-maxima")
    copy_tree(sympy / "feedback", output / "feedback")
    examples = checkers / "examples/stack"
    shutil.copytree(examples, output / "maxima/questions", dirs_exist_ok=True,
                    ignore=lambda directory, names: {"probes", "supplement"} & set(names)
                    if Path(directory) == examples else ())
    patches = patch_frontend(output / "_extensions/stack-sympy")
    shutil.copy2(ROOT / "scripts/public-demo/isolation.js", output / "ctm-isolation.js")
    shutil.copy2(ROOT / "scripts/public-demo/isolation-worker.js", output / "ctm-isolation-worker.js")
    write_json(output / "MATERIALIZATION.json", {
        "schema": 1,
        "sourcePins": {
            "stack-sympy": manifest["stackSympyRevision"],
            "ctm-checkers": manifest["questionSourceRevision"],
            "ctm-libs": manifest["ctmDependencies"]["ctm-libs"]["commit"],
        },
        "frontendPatches": patches,
        "trackedPage": str(source.relative_to(ROOT)),
        "trackedPageSha256": digest(source.read_bytes()),
        "backends": ["sympy", "maxima"],
        "pairs": pairs,
        "cards": 2 * len(demos),
        "variants": 2 * sum(int(demo["options"].get("variants", 1)) for demo in demos),
        "pythonCheckerCards": 2 * sum("pythonCheckerSource" in demo for demo in demos),
    })
    print(json.dumps({"project": str(output), "trackedPage": str(source),
                      "pairs": len(demos), "cards": 2 * len(demos),
                      "variants": 2 * sum(int(demo["options"].get("variants", 1)) for demo in demos)}))


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
    page_patches = []
    for backend in ("sympy", "maxima"):
        cards = {}
        for page in ("index", "examples"):
            path = site / backend / (page + ".html")
            text = path.read_text(encoding="utf-8")
            original = text
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
            # Quarto 1.8.27's template injects this obsolete ES6 polyfill on
            # pages with static mathematics. It lacks compatible COEP/CORP
            # headers. Both Wasm runtimes require modern browsers already;
            # remove the identical optional shim from both rendered routes.
            text, removed = OBSOLETE_POLYFILL.subn("", text)
            if removed > 1:
                raise ValueError(f"Unexpected duplicate template polyfill on {path}")
            path.write_text(text, encoding="utf-8")
            page_patches.append({"path": path.relative_to(site).as_posix(),
                                 "sourceSha256": digest(original.encode()),
                                 "materializedSha256": digest(text.encode()),
                                 "obsoleteEs6PolyfillRemoved": removed})
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
    provenance["renderedPagePatches"] = page_patches
    write_json(provenance_path, provenance)
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
    parser.add_argument("--prepare-existing", type=Path,
                        help="Stage pinned dependencies for an existing tracked Quarto project")
    parser.add_argument("--collect-site", type=Path, help="Check rendered pair and collect its actual frozen payloads")
    parser.add_argument("--payload-output", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if args.collect_site:
        collect(args, manifest)
    elif args.prepare_existing:
        if not all((args.stack_sympy_source, args.ctm_checkers_source, args.ctm_libs_source)):
            parser.error("preparing tracked source requires all three pinned source checkouts")
        prepare_existing(args, manifest)
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
