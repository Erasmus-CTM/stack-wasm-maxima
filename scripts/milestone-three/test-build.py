#!/usr/bin/env python3
"""Structural/compiler tests; mathematical/native evidence is browser CI's."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import unittest
from xml.etree import ElementTree as ET

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CHECKERS_SOURCE = Path(os.environ.get("CTM_CHECKERS_SOURCE", ROOT / ".m3-sources/ctm-checkers")).resolve()
STACK_SOURCE = Path(os.environ.get("STACK_SOURCE", ROOT / ".m3-sources/stack")).resolve()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


compiler = module("native_build_compiler", HERE / "compile.py")
renderer = module("native_build_renderer", HERE / "render-cards.py")
importer = module("native_structural_reader", CHECKERS_SOURCE / "src/ctm_checkers/stack/importer.py")


class NativeBuild(unittest.TestCase):
    def test_python_nodes_preserve_options_edges_and_authored_scores(self):
        body = compiler.authored_question("Mixed", compiler.POINT_PROMPT, "[2,2]", mixed=True, python="positive_x")
        q = compiler.compile_question(body, importer, "mixed", python=True)
        nodes = q["prts"][0]["nodes"]
        self.assertEqual([node["test"] for node in nodes], ["AlgEquiv", "PythonChecker", "AlgEquiv"])
        self.assertEqual(json.loads(nodes[1]["options"]), {"checker": "positive_x"})
        self.assertEqual([node["true"]["next"] for node in nodes], [1, 2, -1])
        self.assertEqual([test["expected"]["prt1"]["score"] for test in q["qtests"]], [1, .5, 0])

    def test_dangling_native_or_python_edges_fail_before_build(self):
        body = compiler.authored_question("Mixed", compiler.POINT_PROMPT, "[2,2]", mixed=True, python="positive_x")
        root = ET.fromstring(body)
        root.find("question/prt/node/truenextnode").text = "37"
        with self.assertRaisesRegex(ValueError, "dangling next node"):
            compiler.compile_question(ET.tostring(root), importer, "broken", python=True)

    def test_escaped_upstream_source_stays_inert_and_board_is_live(self):
        path = compiler.UPSTREAM + "4_JSON_and_complex_binding.xml"
        body = compiler.source_bytes(STACK_SOURCE, path)
        q = compiler.compile_question(body, importer, "json")
        self.assertEqual(len(q["native"]["boards"]), 1)
        self.assertEqual(q["inputs"][0]["type"], "string")
        self.assertIn("&#91;&#91;jsxgraph", q["questiontext"])
        output = renderer.render_html(q["questiontext"], q, {"tokenValues": {}},
                                      {"json-v1-b0": '<iframe data-test="stock-renderer"></iframe>'}, "json", 0)
        self.assertEqual(output.count('<iframe data-test="stock-renderer">'), 1)
        self.assertIn("&#91;&#91;jsxgraph", output)
        self.assertNotIn("[[jsxgraph", output)
        self.assertIn('class="stack-answer" data-name="ans1"', output)

    def test_unsupported_board_reference_is_a_build_error(self):
        body = compiler.authored_question("Wrong reference", compiler.POINT_PROMPT.replace('input-ref-ans=', 'input-ref-other='), "[2,2]")
        with self.assertRaisesRegex(ValueError, "unknown input"):
            compiler.compile_question(body, importer, "bad-ref")

    def test_native_display_strings_cannot_create_html(self):
        q = {"name": "Display", "inputs": [], "prts": [], "native": {"tokens": [{"id": "t0", "format": "source"}]}}
        output = renderer.render_html('<p>@@CTM_NATIVE_t0@@</p>', q,
                                      {"tokenValues": {"t0": {"format": "source", "value": '<img src=x onerror="bad()">', "string": True}}}, {}, "display", 0)
        self.assertNotIn("<img", output)
        self.assertIn("&lt;img", output)
        with self.assertRaisesRegex(ValueError, "unsupported HTML"):
            renderer.render_html('<p onclick="bad()">No</p>', q, {"tokenValues": {}}, {}, "display", 0)

    def test_matrix_ui_uses_native_teacher_dimensions(self):
        body = compiler.authored_question("Matrix", "[[input:ans]]", "matrix([1,0],[0,1])", input_type="matrix", matrix=True)
        q = compiler.compile_question(body, importer, "matrix")
        rendered = renderer.render_html(q["questiontext"], q, {"tokenValues": {}, "teachers": {"ans": {"shape": [2, 2]}}}, {}, "matrix", 0)
        self.assertIn("stack-matrix", rendered)
        match = re.search(r'data-matrix-spec="([^"]+)"', rendered)
        import html
        config = json.loads(html.unescape(match[1]))
        self.assertEqual(config["rows"], {"auto": False, "initial": 2, "min": 2, "max": 2})
        self.assertEqual(config["cols"], config["rows"])


if __name__ == "__main__":
    unittest.main()
