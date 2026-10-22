#!/usr/bin/env python3
"""Restore both authored block syntaxes on the same-page backend comparison."""
from __future__ import annotations

import argparse
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/milestone-two"))
# Remove only the same optional template shim admitted by the accepted renderer.
from materialize import MAXIMA_DIV, OBSOLETE_POLYFILL, QUESTION_BLOCK, SOURCE_PANEL, digest, options


class ScopedCards(HTMLParser):
    VOID = frozenset("area base br col embed hr img input link meta param source track wbr".split())

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.stack = []
        self.cards = []
        self.pairs = []
        self.copies = []
        self.capture = None

    def ancestor(self, key):
        return next((attrs[key] for _, attrs in reversed(self.stack) if key in attrs), None)

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        classes = attrs.get("class", "").split()
        if "backend-pair" in classes:
            self.pairs.append(attrs.get("data-demo-id"))
        if "backend-copy" in classes:
            self.copies.append((self.ancestor("data-demo-id"), attrs.get("data-backend")))
        if tag == "section" and "stack-sympy" in classes:
            self.cards.append({"demoId": self.ancestor("data-demo-id"),
                               "backend": self.ancestor("data-backend"),
                               "nativeWrapper": self.ancestor("data-stack-backend"),
                               "presentationId": attrs.get("data-stack-id")})
        if tag == "script" and "stack-sympy-data" in classes:
            if not self.cards or not any(t == "section" and "stack-sympy" in a.get("class", "").split() for t, a in self.stack):
                raise ValueError("Question payload must be inside its scoped CTM card")
            self.capture = []
        if tag not in self.VOID:
            self.stack.append((tag, attrs))

    def handle_data(self, text):
        if self.capture is not None:
            self.capture.append(text)

    def handle_endtag(self, tag):
        if tag == "script" and self.capture is not None:
            self.cards[-1]["payloadText"] = "".join(self.capture)
            self.capture = None
        for at in range(len(self.stack) - 1, -1, -1):
            if self.stack[at][0] == tag:
                self.stack = self.stack[:at]
                break


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=ROOT / "site")
    project = parser.parse_args().project.resolve()
    output = project / "_site"
    source = project / "maxima/examples.qmd"
    target = output / "maxima/examples.html"
    provenance_path = project / "MATERIALIZATION.json"
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    source_bytes = source.read_bytes()
    source_hash = digest(source_bytes)
    if source_hash != provenance["trackedPageSha256"]:
        raise ValueError("Tracked QMD changed after staging; restage before rendering")
    manifest = json.loads((ROOT / "demos/manifest.json").read_text(encoding="utf-8"))
    demos = [demo for demo in manifest["demos"] if demo["sourcePage"] == "examples.qmd"]
    expected_pairs = [{"demoId": demo["id"], "sympyId": "sympy-" + demo["id"],
                       "maximaId": "maxima-" + demo["id"],
                       "acceptedPayloadId": demo.get("authoredIdentifier") or f"stack-sympy-{at + 1}"}
                      for at, demo in enumerate(demos)]
    if provenance["pairs"] != expected_pairs or provenance["cards"] != 2 * len(demos):
        raise ValueError("Staged pair identities/card counts differ from accepted worked questions")
    expected_order = [(demo["id"], backend) for demo in demos for backend in ("sympy", "maxima")]
    source_text = source_bytes.decode("utf-8")
    authored = [(match.start(), "maxima", match) for match in MAXIMA_DIV.finditer(source_text)]
    authored += [(match.start(), "sympy", match) for match in QUESTION_BLOCK.finditer(source_text)
                 if ".stack-question" in match[1].split()]
    authored.sort(key=lambda item: item[0])
    if len(authored) != len(expected_order):
        raise ValueError("Each worked question needs its ordinary and native authored block")
    blocks, block_records = [], []
    for (_, backend, match), (demo_id, expected_backend) in zip(authored, expected_order):
        demo = next(demo for demo in demos if demo["id"] == demo_id)
        presentation_id = backend + "-" + demo_id
        identifiers = re.findall(r"(?:^|\s)#([A-Za-z0-9_-]+)(?=\s|$)", match[1])
        if backend != expected_backend or identifiers != [presentation_id] or options(match[2]) != demo["options"]:
            raise ValueError("Authored paired options, backend order or presentation ID changed for " + demo_id)
        block = match[0].rstrip("\r\n")
        blocks.append(block)
        block_records.append({"demoId": demo_id, "backend": backend, "presentationId": presentation_id,
                              "sourceSha256": digest(block.encode("utf-8"))})

    original = target.read_bytes()
    text = original.decode("utf-8")
    before = ScopedCards()
    before.feed(text)
    if before.pairs != [demo["id"] for demo in demos] or before.copies != expected_order:
        raise ValueError("Rendered backend-pair/copy scopes must match QMD order exactly")
    if [(card["demoId"], card["backend"]) for card in before.cards] != expected_order:
        raise ValueError("Every copy must contain exactly one scoped question card")
    for card in before.cards:
        expected_id = card["backend"] + "-" + card["demoId"]
        if card["presentationId"] != expected_id or json.loads(card["payloadText"])["id"] != expected_id:
            raise ValueError("Each copy needs its unique namespaced presentation ID")
        if card["nativeWrapper"] != ("maxima" if card["backend"] == "maxima" else None):
            raise ValueError("Only Maxima copies may inherit the native backend wrapper")
    if re.search(r"window\.CTMStackBackend\b", text):
        raise ValueError("A page-wide backend default would hide the SymPy comparison")
    descriptors = re.findall(r"window\.CTMStackBackends\.maxima\s*=\s*(\{[^<]*?\});", text)
    if len(descriptors) != 1 or not re.search(r'workerURL\s*:\s*["\']\.\./backend/worker\.js["\']', descriptors[0]):
        raise ValueError("Expected one named Maxima worker descriptor")

    replacements = iter(blocks)
    def source_panel(match):
        try:
            block = next(replacements)
        except StopIteration as exc:
            raise ValueError("Too many rendered source panels") from exc
        return match[1] + html.escape(block, quote=False) + match[3]

    text, source_panels = SOURCE_PANEL.subn(source_panel, text)
    if source_panels != len(blocks):
        raise ValueError(f"Expected {len(blocks)} source panels; found {source_panels}")
    text, removed = OBSOLETE_POLYFILL.subn("", text)
    if removed > 1:
        raise ValueError("Unexpected duplicate optional Quarto template polyfill")
    if [html.unescape(match[1]) for match in SOURCE_PANEL.findall(text)] != blocks:
        raise ValueError("Source panels must preserve ordinary code and native div blocks exactly")
    after = ScopedCards()
    after.feed(text)
    if after.cards != before.cards or after.pairs != before.pairs or after.copies != before.copies:
        raise ValueError("Post-rendering must preserve all frozen payloads and backend scopes")
    materialized = text.encode("utf-8")
    provenance["renderedPagePatches"] = [{
        "path": target.relative_to(output).as_posix(), "sourceSha256": digest(original),
        "materializedSha256": digest(materialized), "obsoleteEs6PolyfillRemoved": removed,
        "sourcePanelCount": source_panels, "authoredBlocks": block_records,
        "payloads": [{"demoId": card["demoId"], "backend": card["backend"],
                      "presentationId": card["presentationId"],
                      "payloadTextSha256": digest(card["payloadText"].encode("utf-8"))} for card in before.cards],
    }]
    provenance["postRender"] = {
        "script": "scripts/site/post-render.py", "scriptSha256": digest(Path(__file__).read_bytes()),
        "trackedPageSha256": source_hash, "renderedCards": len(blocks), "renderedPairs": len(demos),
        "renderedSourcePanels": source_panels, "namedBackendDescriptors": ["maxima"],
        "backendCards": {"sympy": len(demos), "maxima": len(demos)},
    }
    record = json.dumps(provenance, ensure_ascii=False, indent=2) + "\n"
    target.write_bytes(materialized)
    provenance_path.write_text(record, encoding="utf-8")
    (output / "MATERIALIZATION.json").write_text(record, encoding="utf-8")
    print(json.dumps({"page": str(target), "cards": len(blocks), "pairs": len(demos),
                      "sourcePanels": source_panels, "obsoleteEs6PolyfillRemoved": removed,
                      "sha256": digest(materialized)}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
