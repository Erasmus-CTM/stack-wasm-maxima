"""Admission/contract checks; the callback is mocked, not a CAS oracle."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import unittest

from ctm_checkers.stack import engine
from ctm_checkers.stack.expressions import InvalidAnswer

spec = importlib.util.spec_from_file_location("native_adapter", Path(__file__).with_name("native_adapter.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class NativeAdapterBoundary(unittest.TestCase):
    def setUp(self):
        self.original_answer_test = engine.answer_test
        self.original_invoke = adapter.checkers.invoke
        adapter._installed = False

    def tearDown(self):
        engine.answer_test = self.original_answer_test
        adapter.checkers.invoke = self.original_invoke
        adapter._installed = False

    def test_written_form_and_decimal_spelling_survive_admission(self):
        request = adapter.request_for("EqualComAss", "x+x", "2*x")
        self.assertEqual(request["student"], "(x+x)")
        decimal = adapter.request_for("NumDecPlaces", "1.50", "3/2", "2")
        self.assertEqual(decimal["student"], "1.50")
        self.assertEqual(decimal["raw"], "1.50")

    def test_constants_aliases_and_frozen_bindings(self):
        import sympy as sp
        request = adapter.request_for("AlgEquiv", "ln(x)+i", "ta", env={"ta": sp.log(sp.Symbol("x")) + sp.I})
        self.assertEqual(request["student"], "(log(x)+%i)")
        self.assertIn("%i", request["teacher"])

    def test_unchecked_commands_are_rejected(self):
        for source in ('x;kill(all)', 'load("file")', 'system(1)'):
            with self.assertRaises(InvalidAnswer):
                adapter.request_for("AlgEquiv", source, "x")

    def test_native_error_is_not_a_wrong_grade(self):
        response = {"cas_valid": False, "correct": False, "answer_note": "ATAlgEquiv_STACKERROR_TAns. ", "feedback": ""}
        adapter.install(lambda text: json.dumps(response))
        with self.assertRaisesRegex(RuntimeError, "answer-test error"):
            engine.answer_test("AlgEquiv", "x", "y")
        # Inapplicability on an ordinary wrong comparison is different.
        response["answer_note"] = "ATEqualComAss (AlgEquiv-false). "
        result = engine.answer_test("EqualComAss", "x", "y")
        self.assertTrue(result["valid"])
        self.assertFalse(result["correct"])

    def test_native_decimal_diagnostic_uses_existing_ctm_wording(self):
        note = "ATNumDecPlaces_Wrong_DPs. ATNumDecPlaces_Equiv. "
        native_feedback = "stack_trans('ATNumDecPlaces_Wrong_DPs'); !NEWLINE!"
        response = {"cas_valid": True, "correct": False, "answer_note": note,
                    "feedback": "", "native_feedback": native_feedback}
        adapter.install(lambda text: json.dumps(response))
        for native_note in (note, ["ATNumDecPlaces_Wrong_DPs. ", "ATNumDecPlaces_Equiv. "]):
            response["answer_note"] = native_note
            result = engine.answer_test("NumDecPlaces", "1.5", "1.5", "2")
            self.assertEqual(result["feedback"], "Incorrect number of decimal places")
            self.assertEqual(result["note"], native_note)
            self.assertFalse(result["correct"])
            self.assertTrue(result["cas_valid"])
        self.assertEqual(response["native_feedback"], native_feedback)

    def test_decimal_feedback_needs_exact_native_note_and_wrong_verdict(self):
        response = {"cas_valid": True, "correct": False, "answer_note": "", "feedback": ""}
        adapter.install(lambda text: json.dumps(response))
        for note in ("prefix_ATNumDecPlaces_Wrong_DPs. ", "ATNumDecPlaces_Wrong_DPs_extra. ",
                     "ATNumDecPlaces_Correct. ATNumDecPlaces_Not_equiv. "):
            response["answer_note"] = note
            self.assertEqual(engine.answer_test("NumDecPlaces", "1.5", "1.5", "2")["feedback"], "")
        response["answer_note"] = "ATNumDecPlaces_Wrong_DPs. "
        response["correct"] = True
        self.assertEqual(engine.answer_test("NumDecPlaces", "1.5", "1.5", "2")["feedback"], "")
        response["correct"] = False
        self.assertEqual(engine.answer_test("AlgEquiv", "1.5", "1.5")["feedback"], "")


if __name__ == "__main__":
    unittest.main()
