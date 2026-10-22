"""Admission/contract checks; the callback is mocked, not a CAS oracle."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

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

    def test_collection_feedback_uses_native_positions_and_shared_formatting(self):
        cases = [
            ("AlgEquiv", "[2*x,6]", "[6,2*x]", False, "(ATList_wrongentries 1, 2). ",
             "Check list positions: 1, 2."),
            ("AlgEquiv", "[[2*x,6],{1,{2,3}},[]]", "[[6,2*x],{1,{2,3}},[]]", False,
             "(ATList_wrongentries 1: (ATList_wrongentries 1, 2)). ", "Check list positions: 1."),
            ("AlgEquiv", "[[2,1],9,[4,3]]", "[[1,2],9,[3,4]]", False,
             "(ATList_wrongentries 1: (ATList_wrongentries 1, 2), 3: (ATList_wrongentries 1, 2)). ",
             "Check list positions: 1, 3."),
            ("AlgEquiv", "[1,2,3]", "[1,2]", False, "ATList_wronglen. ",
             "The list has the wrong number of entries."),
            ("AlgEquiv", "{1}", "{1,2}", False, "ATSet_wrongsz. ",
             "The set has the wrong number of elements."),
            ("AlgEquiv", "matrix([2,1])", "matrix([1,2])", False, "ATMatrix_wrongentries. ",
             "Check the entries of the matrix."),
            ("AlgEquiv", "matrix([1])", "matrix([1,2])", False, "ATMatrix_wrongsz_columns. ",
             "The matrix has the wrong number of columns."),
            ("Sets", "{6,2*x,2*x}", "{6,2*x}", True, "ATSets_duplicates. ",
             "Repeated elements were removed from the set."),
            ("Sets", "{6,3*x}", "{6,2*x}", False, "ATSets_wrongentries. ATSets_missingentries. ",
             "Extra elements: 3*x. Missing elements: 2*x."),
            ("Sets", "{6}", "{6,2*x}", False, "ATSets_missingentries. ", "Missing elements: 2*x."),
            ("Sets", "{[2*x,6]}", "{[6,2*x]}", False, "ATSets_wrongentries. ATSets_missingentries. ",
             "Extra elements: [2*x,6]. Missing elements: [6,2*x]."),
        ]
        response, calls = {}, []

        def native(text):
            calls.append(json.loads(text))
            return json.dumps(response)

        adapter.install(native)
        with patch.object(adapter.assessment, "answer_test", side_effect=AssertionError("SymPy grading fallback")):
            for name, student, teacher, correct, note, expected_feedback in cases:
                with self.subTest(name=name, note=note):
                    response.update(cas_valid=True, correct=correct, answer_note=note, feedback="")
                    before = len(calls)
                    result = engine.answer_test(name, student, teacher)
                    self.assertEqual(len(calls), before + 1, "Feedback must not add CAS grading calls")
                    self.assertEqual(result["feedback"], expected_feedback)
                    self.assertEqual(result["note"], note)
                    self.assertEqual(result["correct"], correct)
                    self.assertTrue(result["cas_valid"])

    def test_collection_feedback_inconsistency_fails_explicitly(self):
        response = {"cas_valid": True, "correct": False, "answer_note": "ATSets_wrongentries. ", "feedback": ""}
        adapter.install(lambda text: json.dumps(response))
        with self.assertRaisesRegex(RuntimeError, "disagrees with the native verdict"):
            engine.answer_test("Sets", "{1,2}", "{1,2}")
        with self.assertRaisesRegex(RuntimeError, "disagrees with the native diagnostic"):
            engine.answer_test("Sets", "{1}", "{1,2}")
        response["answer_note"] = "(ATList_wrongentries 3). "
        with self.assertRaisesRegex(RuntimeError, "positions do not match"):
            engine.answer_test("AlgEquiv", "[1,3]", "[1,2]")


if __name__ == "__main__":
    unittest.main()
