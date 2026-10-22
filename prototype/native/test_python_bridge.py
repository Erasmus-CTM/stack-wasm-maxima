"""Native value transport must preserve the existing PythonChecker API."""
# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

import json
from pathlib import Path
import unittest

from ctm_checkers.stack.checkers import CheckerError, source_descriptor

import python_bridge as bridge


def value(source, kind="scalar"):
    return {"source": source, "type": kind}


def request(student, teacher, body="return student == teacher", *, options=None):
    return {"descriptor": {"api_version": 1,
                           "source": "def check(student,teacher,options):\n    " + body + "\nCHECKERS={'check':check}\n"},
            "options": json.dumps({"checker": "check", "options": options or {}}),
            "student": student, "teacher": teacher}


class NativePythonBridgeTests(unittest.TestCase):
    def test_exact_rational_and_complex_values(self):
        r = request(value("1/3+%i/7"), value("1/3+%i/7"),
                    "return bool(student == teacher and student.as_real_imag()[0] == __import__('sympy').Rational(1,3))")
        self.assertTrue(bridge.call(r)["correct"])

    def test_public_immutable_collection_equation_and_logic_vocabulary(self):
        examples = [("[1,[2/3,4]]", "list", "ListValue"),
                    ("{1,1,2}", "set", "SetValue"),
                    ("x=2", "equation", "Equation"),
                    ("x=2 nounor x=3", "logical", "Logical")]
        for source, kind, public_type in examples:
            with self.subTest(kind=kind):
                r = request(value(source, kind), value(source, kind), "return isinstance(student," + public_type + ")")
                r["descriptor"]["source"] = "from ctm_checkers.stack.checker_api import *\n" + r["descriptor"]["source"]
                self.assertTrue(bridge.call(r)["correct"])
        self.assertTrue(bridge.call(request(value("true", "logical"), value("true", "logical"),
                                            "return student is __import__('sympy').true"))["correct"])

    def test_existing_matrix_checker_and_vector_assessment(self):
        root = Path(__file__).resolve().parents[2]
        source = root / ".m2-sources/ctm-checkers/examples/stack/matrix-checkers.py"
        r = request(value("matrix([-2],[1],[0])", "matrix"), value("matrix([1,2,3],[0,0,0])", "matrix"))
        r["descriptor"] = source_descriptor(source)
        r["options"] = json.dumps({"checker": "basis", "options": {"space": "nullspace"}})
        result = bridge.call(r)
        self.assertTrue(result["valid"])
        self.assertFalse(result["correct"])
        self.assertEqual(result["assessment"], {"columns": ["correct"]})
        self.assertEqual(result["implementation"], "python-checker-v1")

    def test_result_stays_a_verdict_for_native_prt_scoring(self):
        r = request(value("matrix([1,0],[0,1])", "matrix"), value("true", "logical"),
                    "return {'valid':True,'correct':False,'feedback':'One dependent column','assessment':{'columns':['correct','dependent']}}")
        result = bridge.call(r)
        self.assertEqual(result["assessment"], {"columns": ["correct", "dependent"]})
        self.assertNotIn("score", result)
        self.assertFalse(result["correct"])

    def test_json_options_are_literal_and_registry_does_not_leak(self):
        r = request(value("2"), value("2"), "return count == 1 and options['text'] == '__import__(bad)'",
                    options={"text": "__import__(bad)"})
        r["descriptor"]["source"] = "count=0\n" + r["descriptor"]["source"].replace(
            "    return", "    global count\n    count+=1\n    return")
        for _ in range(3):
            self.assertTrue(bridge.call(r)["correct"])

    def test_native_type_mismatch_and_json_do_not_coerce(self):
        for bad in (value("[1,2]", "matrix"), value("matrix([1,2])", "list"),
                    value('"{\\\"x\\\":1}"', "scalar"), {"type": "json", "source": '{"x":1}'}):
            with self.subTest(bad=bad), self.assertRaises(CheckerError):
                bridge.call(request(bad, value("1")))

    def test_bad_source_nonfinite_and_author_functions_fail_explicitly(self):
        for source in ("1/0", "load(x)", "__import__(x)", "rand(10)", "x;kill(all)", "1" * 1300):
            with self.subTest(source=source[:30]), self.assertRaises(CheckerError):
                bridge.call(request(value(source), value("1")))

    def test_exceptions_and_malformed_checker_results_do_not_become_false(self):
        for body in ("raise ValueError('callback failure')", "return {'valid':False,'correct':True}", "return {'score':1}"):
            with self.subTest(body=body), self.assertRaises(CheckerError):
                bridge.call(request(value("1"), value("1"), body))

    def test_request_is_consumed_on_failure(self):
        namespace = {bridge.REQUEST_VARIABLE: json.dumps(request(value("[1]", "matrix"), value("1")))}
        with self.assertRaises(CheckerError):
            bridge.call_from_globals(namespace)
        self.assertNotIn(bridge.REQUEST_VARIABLE, namespace)

    def test_json_round_trip_preserves_normalized_result_and_rejects_constants(self):
        r = request(value("1"), value("1"), "return {'valid':True,'correct':False,'feedback':'Use <two> columns'}")
        self.assertEqual(json.loads(bridge.call_json(json.dumps(r)))["feedback"], "Use <two> columns")
        for text in ("{}", "NaN", "[1]", "{" ):
            with self.subTest(text=text), self.assertRaises(CheckerError):
                bridge.call_json(text)


if __name__ == "__main__":
    unittest.main()
