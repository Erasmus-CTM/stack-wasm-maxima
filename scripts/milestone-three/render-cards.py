#!/usr/bin/env python3
"""Render native prepared values through the existing CTM card shell."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
from pathlib import Path
import re
from unittest.mock import patch

from ctm_checkers.stack import checkers, cli, rendering


class NativeHTML(rendering._Sanitizer):
    """The ordinary CTM HTML allowlist plus two upstream teaching styles."""
    def handle_starttag(self, tag, attrs):
        styles = [(key, value) for key, value in attrs if key == "style"]
        ordinary = [(key, value) for key, value in attrs if key != "style"]
        if styles:
            if len(styles) != 1 or not re.fullmatch(r"\s*(?:display\s*:\s*none|line-height\s*:\s*(?:\d+(?:\.\d*)?|\.\d+))\s*;?\s*", styles[0][1] or ""):
                raise ValueError(f"{self.question}: unsupported upstream style on {tag}")
            super().handle_starttag(tag, ordinary)
            self.parts[-1] = self.parts[-1][:-1] + ' style="' + html.escape(styles[0][1], quote=True) + '">'
        else:
            super().handle_starttag(tag, ordinary)


def display_tokens(template, values, tokens):
    def replace(match):
        identifier = match[1]
        spec = next(token for token in tokens if token["id"] == identifier)
        value = values[identifier]
        text = html.escape(str(value.get("value", "")), quote=False)
        if spec["format"] == "latex" and not value.get("string"):
            return r"\(" + text + r"\)" if spec.get("wrap", True) else "{" + text + "}"
        return text
    return re.sub(r"@@CTM_NATIVE_([A-Za-z0-9_]+)@@", replace, template)


def render_html(template, question, variant, board_html, question_id, variant_at):
    # Private placeholders are inserted only after sanitizing authored markup.
    # Native scalar display output is escaped, and board markup comes from the
    # pinned Quarto extension's actual HTML renderer. Board entries contain a
    # reusable template URL and variant-specific data-only init descriptors.
    saved = {}
    def keep(value):
        key = f"CTMNATIVEREPLACEMENT{len(saved)}END"
        saved[key] = value
        return key
    template = display_tokens(template, variant["tokenValues"], question["native"]["tokens"])

    def board(match):
        key = f"{question_id}-v{variant_at + 1}-{match[1]}"
        if key not in board_html:
            raise ValueError(f"Missing Quarto board {key}")
        return keep(board_html[key])
    template = re.sub(r"@@CTM_BOARD_([A-Za-z0-9_]+)@@", board, template)
    input_map = {inp["name"]: inp for inp in question["inputs"]}
    prts = {prt["name"] for prt in question["prts"]}
    def directive(match):
        kind, name = match.groups()
        escaped = html.escape(name, quote=True)
        if kind in {"input", "validation"} and name not in input_map or kind == "feedback" and name not in prts:
            raise ValueError(f"Unknown native display placeholder {match[0]}")
        if kind == "input":
            inp = input_map[name]
            if inp["type"] == "matrix":
                shape = variant["teachers"][name].get("shape")
                if not isinstance(shape, list) or len(shape) != 2 or min(shape) < 1 or max(shape) > 16 or shape[0] * shape[1] > 64:
                    raise ValueError(f"{question_id}: native matrix teacher needs bounded positive shape")
                axes = inp.get("matrix") or {axis: {"auto":False,"initial":n,"min":n,"max":n} for axis,n in zip(("rows","cols"),shape)}
                spec = html.escape(json.dumps({"name":name, **axes}), quote=True)
                value = f'<span class="stack-answer stack-matrix" data-name="{escaped}" data-matrix-spec="{spec}" role="group" aria-label="Answer {escaped}"></span>'
            else:
                size = min(max(inp.get("boxsize",15),1),60)
                input_type = html.escape(inp["type"], quote=True)
                value = f'<input class="stack-answer" data-name="{escaped}" data-stack-input-type="{input_type}" aria-label="Answer {escaped}" size="{size}" autocomplete="off">'
        elif kind == "validation":
            value = f'<span class="stack-validation" data-name="{escaped}" aria-live="polite"></span>'
        else:
            value = f'<span class="stack-feedback" data-name="{escaped}"></span>'
        return keep(value)
    template = re.sub(r"\[\[(input|validation|feedback):([A-Za-z][A-Za-z0-9_]*)\]\]", directive, template)
    if "[[" in template or "@@CTM_" in template:
        raise ValueError(f"{question_id}: unsupported display marker remains")
    safe = NativeHTML(question["name"], "native display")
    safe.feed(template)
    safe.close()
    result = "".join(safe.parts)
    for marker, value in saved.items():
        result = result.replace(marker, value)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared",type=Path,required=True)
    parser.add_argument("--boards",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--manifest",type=Path,required=True)
    args = parser.parse_args()
    report = json.loads(args.prepared.read_text(encoding="utf-8"))
    boards = json.loads(args.boards.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True,exist_ok=True)
    for item in report["questions"]:
        question, variants = item["question"], item["variants"]
        for at, variant in enumerate(variants):
            for field in ("questiontext","generalfeedback","specificfeedback","questionnote"):
                target = {"questiontext":"question_html","generalfeedback":"generalfeedback_html","specificfeedback":"specificfeedback_html","questionnote":"questionnote_html"}[field]
                variant[target] = render_html(question[field],question,variant,boards,item["id"],at)
        by_seed = {v["seed"]:v for v in variants}
        if item["seeds"] != list(range(item["seeds"][0],item["seeds"][0]+len(variants))):
            raise ValueError("The shared CTM card renderer requires consecutive selected seeds")
        # Reuse the exact pinned card shell. Its usual preparation callbacks
        # receive already computed native variants; no SymPy instantiation or
        # grading occurs here. Browser tests execute native authored tests.
        with patch.object(cli,"import_xml",return_value=[question]), patch.object(cli,"instantiate",side_effect=lambda _q,seed:by_seed[seed]), patch.object(checkers,"preflight",return_value=None):
            fragment = cli.render("<native-prepared>",question["name"],item["id"],count=len(variants),seed=item["seeds"][0],review=bool(question.get("qtests")))
        fragment = '<div class="stack-native-backend" data-stack-backend="maxima-native">' + fragment + '</div>'
        target = args.output / (item["id"]+".html")
        target.write_text(fragment,encoding="utf-8")
        item["cardSha256"] = hashlib.sha256(fragment.encode("utf-8")).hexdigest()
        item["payload"] = {"version":1,"id":item["id"],"question":question,"variants":variants,"review":bool(question.get("qtests"))}
    report["rendering"] = {"cardShell":"ctm_checkers.stack.cli.render","nativeValuesComputedBy":"Maxima Wasm worker during build","jsxgraphRenderer":"jsxgraph/jsxgraph-quarto at " + report["jsxgraphQuartoRevision"]}
    args.manifest.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"cards":len(report["questions"]),"variants":sum(len(item["variants"]) for item in report["questions"]),"manifest":str(args.manifest)}))


if __name__ == "__main__":
    main()
