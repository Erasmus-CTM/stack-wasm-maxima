#!/usr/bin/env python3
"""Stage board MathJax through the canonical CTM asset producer, not a new lock.

SPDX-License-Identifier: AGPL-3.0-or-later
The caller pins the assessment and library source checkouts in its workflow.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def revision(root):
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()


def stage(assessment_source, site, cache, worker_preloader, library=None,
          include_mathjax3=False):
    assessment_source, site, cache = map(Path, (assessment_source, site, cache))
    worker_preloader = Path(worker_preloader)
    sys.path.insert(0, str(assessment_source / "scripts"))
    import ctm_assets as assets
    import ctm_board_assets as boards

    metadata_path = assessment_source / "integration/assets-board-metadata.json"
    pins = assessment_source / "_extensions/ctm-assessment/jsxgraph-pins.yml"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    # Reuse archive integrity, complete runtime selection, font copyright/member
    # evidence and all licence checks. JSXGraph is packaged from the exact stock
    # renderer by package-boards.mjs, so do not ship another copy in this bundle.
    lock = boards.produce_board_lock(metadata, pins, cache,
                                     licence_root=assessment_source)
    lock["archives"] = [a for a in lock["archives"] if a["id"] != "jsxgraph"]
    lock["versions"].pop("jsxgraph")
    lock["scope"] = sorted(lock["versions"])
    lock["kind"] = "native-board-mathjax-assets-lock"
    if include_mathjax3:
        if library is None:
            raise ValueError("MathJax 3 requires the canonical ctm-libs source")
        # Reuse the complete canonical npm producer, including its generated
        # Source Sans Pro CSS and licence verification. Publish only the two
        # parent presentation packages; unrelated npm packages stay in cache.
        npm_metadata = json.loads((assessment_source / "integration/assets-metadata.json").read_text())
        npm = assets.produce_npm_lock(npm_metadata, Path(library), cache)
        selected = {"mathjax3", "source-sans-pro"}
        lock["archives"].extend(a for a in npm["archives"] if a["id"] in selected)
        lock["versions"].update({name: npm["versions"][name] for name in selected})
        lock.setdefault("generated", []).extend(npm["generated"])
        lock["provenance"]["parentNpm"] = {**npm["provenance"],
            "libraryRevision": revision(Path(library)), "selected": sorted(selected)}
        lock["scope"] = sorted(lock["versions"])
    lock["files"] = assets.derive_lock_files(lock, cache)
    destination = site / "native/boards/mathjax"
    assets.build_from_lock(lock, destination, cache)

    # This is an explicit consumer of the reviewed canonical component, without
    # changing the site's existing CTM runtime or maintaining a second copy.
    preloader_bytes = worker_preloader.read_bytes()
    if not preloader_bytes or worker_preloader.is_symlink():
        raise ValueError("A regular canonical opaque-worker pre-loader is required")
    preloader_hash = hashlib.sha256(preloader_bytes).hexdigest()
    preloader_path = "native/boards/assets/" + preloader_hash + ".js"
    staged_preloader = site / preloader_path
    staged_preloader.parent.mkdir(parents=True, exist_ok=True)
    staged_preloader.write_bytes(preloader_bytes)
    licence_source = worker_preloader.parents[3] / "LICENSE"
    licence_bytes = licence_source.read_bytes()
    if not licence_bytes or licence_source.is_symlink():
        raise ValueError("The canonical CTM source licence is required")
    (staged_preloader.parent / "CTM-LICENSE.txt").write_bytes(licence_bytes)
    prefix = "native/boards/mathjax/"
    version4 = lock["versions"]["mathjax4"]
    font_version = lock["versions"]["mathjax-newcm-font"]
    base4 = prefix + "npm/mathjax@" + version4 + "/"
    font = prefix + "npm/@mathjax/mathjax-newcm-font@" + font_version + "/"
    url_map = {
        "https://cdn.jsdelivr.net/npm/mathjax@4/tex-mml-svg.js": base4 + "tex-mml-svg.js",
        "https://cdn.jsdelivr.net/npm/mathjax@" + version4 + "/tex-mml-svg.js": base4 + "tex-mml-svg.js",
    }
    bases = {"mathjax4": base4, "font": font}
    if include_mathjax3:
        version3 = lock["versions"]["mathjax3"]
        bases["mathjax3"] = prefix + "npm/mathjax@" + version3 + "/es5/"
        for component in ("tex-chtml.js", "tex-mml-chtml.js", "tex-chtml-full.js", "tex-mml-svg.js"):
            for v in ("3", version3):
                url_map["https://cdn.jsdelivr.net/npm/mathjax@" + v + "/es5/" + component] = bases["mathjax3"] + component
        # Quarto emits Bootstrap CSS two levels below the output root.
        (site / "native/parent-assets.scss").write_text(
            '/*-- scss:defaults --*/\n$web-font-path: "../../' + prefix +
            'fonts/source-sans-pro.css";\n', encoding="utf-8")
    result = {
        "schema": 1, "bases": bases, "urlMap": url_map,
        "bundleRoot": prefix.rstrip("/"),
        "preloader": preloader_path,
        "preloaderLicence": "native/boards/assets/CTM-LICENSE.txt",
        "parentMathjax": bases.get("mathjax3", "") + "tex-chtml.js" if include_mathjax3 else None,
        "parentFontCss": prefix + "fonts/source-sans-pro.css" if include_mathjax3 else None,
        "config": {
            "loader": {"paths": {"mathjax": base4.rstrip("/"),
                                   "sre": base4 + "sre", "mathmaps": base4 + "sre/mathmaps"}},
            "svg": {"fontPath": font.rstrip("/")},
            "chtml": {"fontPath": font.rstrip("/"), "fontURL": font + "chtml/woff2"},
        },
        "provenance": {
            "assessmentRevision": revision(assessment_source),
            "metadataSha256": assets.digest(metadata_path.read_bytes()),
            "pinsSha256": assets.digest(pins.read_bytes()),
            "versions": lock["versions"],
            "archives": [{k: a.get(k) for k in ("id", "url", "integrity", "licence")}
                         for a in lock["archives"]],
            "preloaderSha256": preloader_hash,
            "preloaderSource": str(worker_preloader),
            "bundleFiles": len(lock["files"]),
            "parentNpm": lock["provenance"].get("parentNpm"),
        },
    }
    # Retain source/provenance alongside the canonical bundle, not inside each
    # board or variant. This report is small and contains no question bodies.
    (site / "native/board-mathjax.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assessment-source", type=Path, required=True)
    parser.add_argument("--site", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--worker-preloader", type=Path, required=True)
    parser.add_argument("--library", type=Path)
    parser.add_argument("--include-mathjax3", action="store_true")
    args = parser.parse_args()
    # Canonical construction diagnostics belong on stderr; stdout is the one
    # machine-readable mapping consumed by the native build script.
    with contextlib.redirect_stdout(sys.stderr):
        result = stage(args.assessment_source, args.site, args.cache,
                       args.worker_preloader, args.library, args.include_mathjax3)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
