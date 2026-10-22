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


if __name__ == "__main__":
    unittest.main()
