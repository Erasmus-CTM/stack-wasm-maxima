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

    def test_mixed_coordinate_nodes_guard_the_complete_list_shape(self):
        body = compiler.authored_question("Mixed", compiler.POINT_PROMPT, "[2,2]", mixed=True, python="positive_x")
        q = compiler.compile_question(body, importer, "mixed", python=True)
        nodes = q["prts"][0]["nodes"]
        for node, axis in ((nodes[0], 2), (nodes[2], 1)):
            self.assertRegex(node["student"], r"^if listp\(ans\) then \(if length\(ans\)=2 then ans\[" + str(axis) + r"\] else 0\) else 0$")
            self.assertEqual(node["teacher"], "target")
        self.assertEqual(json.loads(nodes[1]["options"]), {"checker": "positive_x"})
        self.assertEqual([test["expected"]["prt1"]["score"] for test in q["qtests"]], [1, .5, 0])

    def test_mixed_feedback_local_is_used_before_and_after_python_and_in_feedback(self):
        body = compiler.authored_question("Mixed", compiler.POINT_PROMPT, "[2,2]", mixed=True, python="positive_x")
        q = compiler.compile_question(body, importer, "mixed", python=True)
        prt = q["prts"][0]
        self.assertEqual(prt["feedbackvariables"], "target:2;")
        self.assertEqual(prt["locals"], ["target"])
        self.assertEqual([prt["nodes"][at]["teacher"] for at in (0,2)], ["target", "target"])
        labels = ("Native y target", "Python target", "Native x target")
        for node, label in zip(prt["nodes"], labels):
            for branch in ("true", "false"):
                template = node[branch]["feedback"]
                self.assertIn(label + ": @@CTM_NATIVE_", template)
                identifier = re.search(r"@@CTM_NATIVE_([^@]+)@@", template)[1]
                token = next(token for token in q["native"]["tokens"] if token["id"] == identifier)
                self.assertEqual((token["source"], token["phase"], token["format"]), ("target", "feedback", "source"))

    def test_graphical_initial_coordinate_is_a_prepared_native_token(self):
        prompt = compiler.POINT_PROMPT.replace("[-1,-1]", "[{#startx#},-1]")
        body = compiler.authored_question("Seeded board", prompt, "[2,2]", variables="startx:rand(3)-2;", python="positive_point")
        q = compiler.compile_question(body, importer, "seeded-board", python=True)
        self.assertEqual(q["variables"], "startx:rand(3)-2;")
        self.assertEqual(q["inputs"][0]["teacher"], "[2,2]")
        token = next(token for token in q["native"]["tokens"] if token["source"] == "startx")
        self.assertEqual((token["phase"], token["context"]), ("prepare", "javascript"))
        self.assertIn("[@@CTM_NATIVE_" + token["id"] + "@@,-1]", q["native"]["boards"][0]["code"])

    def test_feedback_randomness_fails_at_build_but_literals_and_question_randomness_do_not(self):
        body = compiler.authored_question("Random", "[[input:ans]]", "value", variables="value:rand(3)+1;")
        root = ET.fromstring(body)
        prt = root.find("question/prt")
        feedback = compiler.subelement(compiler.subelement(prt, "feedbackvariables", ""), "text", "later:rand_with_step(1,4,1);")
        with self.assertRaisesRegex(ValueError, r"prt\[prt1\]/feedbackvariables: random feedback variables"):
            compiler.compile_question(ET.tostring(root), importer, "random")
        feedback.text = 'message:"rand(3)"; /* rand_with_step(1,4,1) */'
        question = compiler.compile_question(ET.tostring(root), importer, "random")
        self.assertEqual(question["native"]["locals"], ["value"])
        self.assertEqual(question["prts"][0]["locals"], ["message"])

    def test_rng_helper_prefix_is_rejected_in_every_response_tree_expression(self):
        for helper in ("rand", "random", "rand_with_prohib", "random_subset", "RAND_INTEGER", "multiselqnalpha", "MULTISELQNDISPLAY"):
            for field in ("sans", "tans", "testoptions", "feedbackvariables", "feedback-token"):
                with self.subTest(helper=helper, field=field):
                    root = ET.fromstring(compiler.authored_question("Random tree", "[[input:ans]]", "2"))
                    expression = helper + "(3)"
                    if field == "feedbackvariables":
                        compiler.subelement(compiler.subelement(root.find("question/prt"), field, ""), "text", "later:" + expression + ";")
                    elif field == "feedback-token":
                        root.find("question/prt/node/truefeedback/text").text = "<p>{@" + expression + "@}</p>"
                    else:
                        root.find("question/prt/node/" + field).text = expression
                    with self.assertRaisesRegex(ValueError, r"random (?:feedback variables|response-tree expressions)"):
                        compiler.compile_question(ET.tostring(root), importer, "random-tree")

    def test_prepared_rng_helpers_are_frozen_once_and_inert_names_are_not_calls(self):
        root = ET.fromstring(compiler.authored_question("Frozen draws", "<p>{@random_subset([1,2],1)@}</p>[[input:ans]]", "rand_integer(1,3)",
                                                      variables="value:rand_with_prohib(1,3,[2]);"))
        root.find("question/qtest/testinput/value").text = "random(3)"
        compiler.subelement(compiler.subelement(root.find("question/prt"), "feedbackvariables", ""), "text",
                            'message:"random_subset([1,2],1)"; /* RAND_INTEGER(1,3) */')
        root.find("question/prt/node/tans").text = "brand + random_variable /* random(3) */"
        q = compiler.compile_question(ET.tostring(root), importer, "frozen-draws")
        self.assertEqual(q["variables"], "value:rand_with_prohib(1,3,[2]);")
        self.assertEqual(q["native"]["tokens"][0]["phase"], "prepare")
        self.assertEqual(q["qtests"][0]["inputs"]["ans"], "random(3)")

    def test_rng_state_mutators_are_rejected_even_in_prepared_expressions(self):
        for helper in ("set_random_state", "make_random_state", "STACK_RANDSEED"):
            for field in ("questionvariables", "input-teacher", "prepare-token", "qtest", "feedbackvariables", "sans", "feedback-token"):
                with self.subTest(helper=helper, field=field):
                    root = ET.fromstring(compiler.authored_question("RNG state", "[[input:ans]]", "2"))
                    expression = helper + "(3)"
                    if field == "questionvariables":
                        root.find("question/questionvariables/text").text = "value:" + expression + ";"
                    elif field == "input-teacher":
                        root.find("question/input/tans").text = expression
                    elif field == "prepare-token":
                        root.find("question/questiontext/text").text += "{@" + expression + "@}"
                    elif field == "qtest":
                        root.find("question/qtest/testinput/value").text = expression
                    elif field == "feedbackvariables":
                        compiler.subelement(compiler.subelement(root.find("question/prt"), field, ""), "text", "value:" + expression + ";")
                    elif field == "feedback-token":
                        root.find("question/prt/node/truefeedback/text").text = "{@" + expression + "@}"
                    else:
                        root.find("question/prt/node/" + field).text = expression
                    with self.assertRaisesRegex(ValueError, "RNG state-mutating calls"):
                        compiler.compile_question(ET.tostring(root), importer, "rng-state")

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

    def test_matrix_binding_and_ignored_board_options_fail_at_build(self):
        body = compiler.authored_question("Matrix binding", compiler.POINT_PROMPT, "matrix([1,0],[0,1])", input_type="matrix", matrix=True)
        with self.assertRaisesRegex(ValueError, "matrix input bindings"):
            compiler.compile_question(body, importer, "matrix-binding")
        for option in ('version="cdn-1.12.2"', 'aspect-ratio="1/1"'):
            body = compiler.authored_question("Board options", compiler.POINT_PROMPT.replace('[[jsxgraph ', '[[jsxgraph '+option+' '), "[2,2]")
            with self.assertRaisesRegex(ValueError, "attributes outside the compatibility subset"):
                compiler.compile_question(body, importer, "board-option")

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
