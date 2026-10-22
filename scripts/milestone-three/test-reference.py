#!/usr/bin/env python3
"""Guard the runtime replay comparator and its failure envelopes."""
# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_reference", Path(__file__).with_name("native-reference.py"))
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


class ComparisonTests(unittest.TestCase):
    def test_large_exact_integers_cannot_pass_by_relative_tolerance(self):
        for number in (10**12, -(10**12), 10**1000):
            with self.subTest(number=str(number)[:25]):
                self.assertEqual(reference.differences(number, number), [])
                self.assertTrue(reference.differences(number, number + 1))
        self.assertTrue(reference.differences(10**1000, 1.0))

    def test_float_roundoff_is_bounded_and_strings_remain_exact(self):
        self.assertEqual(reference.differences(0.25, 0.25000000000001), [])
        self.assertEqual(reference.differences(1, 1.0), [])
        self.assertTrue(reference.differences(0.25, 0.25000001))
        self.assertTrue(reference.differences("17.50", "17.5"))
        self.assertTrue(reference.differences("1000000000000", "1000000000001"))
        self.assertTrue(reference.differences({"latex": r"\(x+1\)"}, {"latex": r"\(x-1\)"}))

    def test_verdict_types_keys_and_collection_order_are_strict(self):
        self.assertTrue(reference.differences(True, 1))
        self.assertTrue(reference.differences(False, 0))
        self.assertTrue(reference.differences({"valid": True}, {}))
        self.assertTrue(reference.differences([1, 2], [2, 1]))
        mismatch = reference.differences({"teacher": {"source": "2/4"}}, {"teacher": {"source": "1/2"}})
        self.assertEqual(mismatch[0]["path"], "$.teacher.source")

    def test_nonfinite_json_constants_and_overflow_are_rejected(self):
        for text in ("NaN", "Infinity", "-Infinity", "1e999", "-1e999", '{"nested":[Infinity]}', '[1,1e999]'):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "Non-finite JSON"):
                reference.load_json(text)
        self.assertEqual(reference.load_json('{"finite":1e-300,"source":"NaN + Infinity"}'),
                         {"finite": 1e-300, "source": "NaN + Infinity"})
        for number in (float("inf"), -float("inf"), float("nan")):
            for expected, actual in ((number, number), (1, number), (number, 1)):
                with self.subTest(expected=expected, actual=actual), self.assertRaisesRegex(ValueError, "non-finite"):
                    reference.differences({"nested": expected}, {"nested": actual})


class PresentationTests(unittest.TestCase):
    @staticmethod
    def feedback(argument, key="ATList_wrongentries"):
        return "stack_trans('" + key + "' , !quot!" + argument + "!quot! ); !NEWLINE!"

    def assert_presentation(self, expected, actual, reason):
        result = reference.compare_results(expected, actual)
        self.assertTrue(result["passed"])
        self.assertEqual(result["comparison"], "presentation-equivalent")
        self.assertTrue(result["differences"], "Raw differences must never be hidden")
        self.assertEqual(result["unacceptedDifferences"], [])
        for raw, accepted in zip(result["differences"], result["presentationDifferences"]):
            self.assertEqual({key: accepted[key] for key in raw}, raw)
            self.assertEqual(accepted["reason"], reason)
        return result

    def assert_unaccepted(self, expected, actual):
        result = reference.compare_results(expected, actual)
        self.assertFalse(result["passed"])
        self.assertEqual(result["comparison"], "unaccepted")
        self.assertTrue(result["unacceptedDifferences"])
        return result

    def test_exact_text_content_under_full_latex_containers_only(self):
        # Exact JSON text from the two 399c validation differences.
        content = '[{"x":1.7488583469009577e-7,"y":0.9999999999999993,"color":"black"}]'
        left, right = r"\mbox{ " + content + " }", r"\text{" + content + "}"
        for expected, actual in ((left, right), (right, left)):
            self.assert_presentation({"ans1": {"latex": expected}}, {"ans1": {"latex": actual}}, "latex-text-container")
        self.assert_presentation({"latex": r"\mbox{  a  }"}, {"latex": r"\text{ a }"}, "latex-text-container")
        for expected, actual in ((r"\mbox{ X }", r"\text{Y}"), (r"\mbox{ X  }", r"\text{X}"),
                                 (r"\mbox{X}", r"\text{X}"), (r"a+\mbox{ X }", r"a+\text{X}"),
                                 (r"\mbox{ X }", r"\text{ X }")):
            with self.subTest(expected=expected, actual=actual):
                self.assert_unaccepted({"latex": expected}, {"latex": actual})
        for field in ("source", "note", "feedback", "value"):
            with self.subTest(field=field):
                self.assert_unaccepted({field: left}, {field: right})

    def test_actual_399c_list_and_matrix_math_wraps_keep_raw_values(self):
        # Exact display fragments from 399c observations 93, 116 and 127.
        list_tex = r"\[\left[ {\color{red}{\underline{2\,x}}} , {\color{red}{\underline{2}}} \right] \]"
        wrapped_list = list_tex.replace(r"\underline{2}", "\\underline{2\n }")
        matrix_tex = r"\[\left[\begin{array}{cc} 1 & {\color{red}{\underline{1}}} \\ 0 & 1 \end{array}\right]\]"
        wrapped_matrix = matrix_tex.replace(r"\[\left", "\\[\n \\left")
        for plain, wrapped, key in ((list_tex, wrapped_list, "ATList_wrongentries"),
                                    (matrix_tex, wrapped_matrix, "ATMatrix_wrongentries")):
            for expected, actual in ((plain, wrapped), (wrapped, plain)):
                with self.subTest(key=key, reverse=expected is wrapped):
                    self.assert_presentation({"events": [{"nativeFeedback": self.feedback(expected, key)}]},
                                             {"events": [{"nativeFeedback": self.feedback(actual, key)}]},
                                             "native-feedback-math-line-wrap")

    def test_changed_math_protocol_notes_sources_and_meaningful_whitespace_fail(self):
        base = self.feedback(r"\(x+{2}\)")
        candidates = [self.feedback("\\(x+{3\n }\\)"), self.feedback(r"\(x+{2}\)", key="ATSet_wrongentries"),
                      base.replace(" );", "\n );"), self.feedback(r"\(x +{2}\)"),
                      self.feedback("\\(x\n +{2}\\)"), self.feedback("\\(\\text{a\n }\\)"),
                      self.feedback("\\(\\mbox{a\n }\\)"), self.feedback("a\n }"),
                      base + " extra", base.replace("!NEWLINE!", "!NEWLINE!\n")]
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                self.assert_unaccepted({"nativeFeedback": base}, {"nativeFeedback": candidate})
        for command in ("text", "mbox", "textrm"):
            left = self.feedback("\\(\\" + command + "{a}\\)")
            right = self.feedback("\\(\\" + command + "{a\n }\\)")
            with self.subTest(command=command):
                self.assert_unaccepted({"nativeFeedback": left}, {"nativeFeedback": right})
        for field in ("source", "note", "answerNote", "value"):
            with self.subTest(field=field):
                self.assert_unaccepted({field: base}, {field: base.replace("2}", "2\n }")})
        self.assert_unaccepted({"notes": ["A B"]}, {"notes": ["AB"]})
        self.assert_unaccepted({"score": 0.5}, {"score": 0.75})

    def test_only_math_arguments_change_and_late_unaccepted_fields_are_not_truncated(self):
        prefix = "stack_trans('Subst' , !quot!unchanged literal text!quot! ); !NEWLINE!"
        self.assert_presentation({"nativeFeedback": prefix + self.feedback(r"\(x+{2}\)")},
                                 {"nativeFeedback": prefix + self.feedback("\\(x+{2\n }\\)")},
                                 "native-feedback-math-line-wrap")
        self.assert_unaccepted({"nativeFeedback": prefix + self.feedback(r"\(x+{2}\)")},
                               {"nativeFeedback": prefix.replace("literal text", "literal  text") + self.feedback("\\(x+{2\n }\\)")})
        left = [{"latex": r"\mbox{ X }"} for _ in range(25)] + [{"source": "2/4"}]
        right = [{"latex": r"\text{X}"} for _ in range(25)] + [{"source": "1/2"}]
        result = self.assert_unaccepted(left, right)
        self.assertEqual(len(result["differences"]), 26)
        self.assertEqual(len(result["presentationDifferences"]), 25)
        self.assertEqual(result["unacceptedDifferences"][0]["path"], "$[25].source")


class ReplayEnvelopeTests(unittest.TestCase):
    def replay(self, *, passed=True, payload=None, alter_output=None, native_exit=0,
               runtime=None, modified_source=False, extra_source=False, results=None, native_results=None):
        results = ["17.50"] * 3 if results is None else results
        native_results = results if native_results is None else native_results
        programs = [{"operation": operation, "expression": '"17.50"', "result": result}
                    for operation, result in zip(("prepare", "validate", "prt"), results)]
        browser = {"passed": passed, "programs": programs, "runtime": runtime if runtime is not None else
                   {"stackRevision": reference.STACK_SHA, "stackLibraryVersion": "2026101500"}}
        if payload is None:
            payload = json.dumps(browser)
        lines = ["CTMNATIVE-VERSION|5.47.0|2026101500"]
        lines += [f"CTMNATIVE-REFERENCE|{index}|" + json.dumps([True, result])
                  for index, result in enumerate(native_results)]
        lines += ["CTMNATIVE-END|3"]
        if alter_output:
            lines = alter_output(lines)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "stack"
            (source / "stack/maxima").mkdir(parents=True)
            original = b"/* pinned STACK CAS fixture */\n"
            (source / "stack/maxima/fixture.mac").write_bytes(b"/* modified */\n" if modified_source else original)
            if extra_source:
                (source / "stack/maxima/untracked.mac").write_bytes(b"/* unpinned extra file */\n")
            report_path = root / "browser.json"
            report_path.write_text(payload, encoding="utf-8")
            output = root / "results"
            arguments = ["native-reference.py", "--browser-report", str(report_path),
                         "--stack-source", str(source), "--output", str(output)]
            def check_output(command, **kwargs):
                if command[0] != "git":
                    return "Maxima 5.47.0\n"
                if "rev-parse" in command:
                    return reference.STACK_SHA + "\n"
                if "ls-tree" in command:
                    return "stack/maxima/fixture.mac\n"
                if "show" in command:
                    return original
                raise AssertionError("Unexpected git command: " + repr(command))
            result = subprocess.CompletedProcess([], native_exit, "\n".join(lines) + "\n", "")
            with patch.object(sys, "argv", arguments), patch.object(reference.subprocess, "check_output", side_effect=check_output), \
                    patch.object(reference.shutil, "which", return_value="/mock/maxima"), \
                    patch.object(reference.subprocess, "run", return_value=result), patch("builtins.print"):
                status = reference.main()
            report = json.loads((output / "native-reference.json").read_text(encoding="utf-8"))
            return status, report

    def test_complete_success_and_failed_source_report(self):
        status, report = self.replay()
        self.assertEqual(status, 0)
        self.assertTrue(report["passed"])
        self.assertEqual(report["summary"]["programs"], 3)
        self.assertIn("ordered aggregate", report["executionIsolation"])
        status, report = self.replay(passed=False)
        self.assertEqual(status, 1)
        self.assertFalse(report["passed"])
        self.assertIn("partial evidence", report["failure"])

    def test_incomplete_duplicate_failed_and_nonfinite_native_envelopes(self):
        alterations = {
            "missing": lambda lines: [line for line in lines if "REFERENCE|1|" not in line],
            "duplicate": lambda lines: lines + [lines[1]],
            "cas_failure": lambda lines: [line.replace('[true, "17.50"]', '[false, "CAS evaluation failed"]') for line in lines],
            "nonfinite": lambda lines: [line.replace('[true, "17.50"]', '[true, Infinity]') for line in lines],
            "overflow": lambda lines: [line.replace('[true, "17.50"]', '[true, 1e999]') for line in lines],
        }
        for name, alteration in alterations.items():
            with self.subTest(name=name):
                status, report = self.replay(alter_output=alteration)
                self.assertEqual(status, 1)
                self.assertFalse(report["passed"])
        status, report = self.replay(native_exit=1)
        self.assertEqual(status, 1)
        self.assertIn("exited 1", report["failure"])

    def test_nonfinite_browser_json_is_not_accepted_as_evidence(self):
        for payload in ('{"passed":true,"runtime":NaN}', '{"passed":true,"runtime":1e999}'):
            with self.subTest(payload=payload):
                status, report = self.replay(payload=payload)
                self.assertEqual(status, 1)
                self.assertIn("Non-finite JSON", report["failure"])

    def test_runtime_and_loaded_cas_sources_must_match_the_pins(self):
        for runtime in ({"stackRevision": "wrong", "stackLibraryVersion": "2026101500"},
                        {"stackRevision": reference.STACK_SHA}):
            with self.subTest(runtime=runtime):
                status, report = self.replay(runtime=runtime)
                self.assertEqual(status, 1)
                self.assertIn("Browser evidence", report["failure"])
        status, report = self.replay(alter_output=lambda lines: [line.replace("5.47.0|2026101500", "5.47.0|2026101501") for line in lines])
        self.assertEqual(status, 1)
        self.assertIn("library version differs", report["failure"])
        status, report = self.replay(modified_source=True)
        self.assertEqual(status, 1)
        self.assertIn("modified from its pinned git blob", report["failure"])
        status, report = self.replay(extra_source=True)
        self.assertEqual(status, 1)
        self.assertIn("inventory differs", report["failure"])

    def test_native_shim_preserves_source_strings_and_checks_outer_error_map(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()
            expression = 'block([simp:false],string(17.50))'
            batch = reference.make_batch(root / "source", home, [{"expression": expression}])
            self.assertIn(expression, batch)
            self.assertIn('%ERR:["stack_map"],%NOTES:["stack_map"],%FEEDBACK:["stack_map"]', batch)
            self.assertIn('else if length(%ERR)>1', batch)

    def test_report_separates_exact_presentation_equivalent_and_unaccepted(self):
        results = [{"source": "17.50"}, {"latex": r"\mbox{ X }"}, {"note": "original"}]
        native = [{"source": "17.50"}, {"latex": r"\text{X}"}, {"note": "changed"}]
        status, report = self.replay(results=results, native_results=native)
        self.assertEqual(status, 1)
        self.assertEqual([row["comparison"] for row in report["observations"]], ["exact", "presentation-equivalent", "unaccepted"])
        self.assertEqual({key: report["summary"][key] for key in ("exact", "presentationEquivalent", "unaccepted")},
                         {"exact": 1, "presentationEquivalent": 1, "unaccepted": 1})
        self.assertEqual(report["summary"]["rawDifferenceFields"], 2)
        self.assertEqual(report["summary"]["acceptedPresentationFields"], 1)
        self.assertEqual(report["summary"]["unacceptedDifferenceFields"], 1)
        display = report["observations"][1]
        self.assertEqual(display["differences"][0]["expected"], results[1]["latex"])
        self.assertEqual(display["presentationDifferences"][0]["actual"], native[1]["latex"])
        self.assertIn("not a claim of byte equality", report["comparisonPolicy"]["exact"])
        native[2] = results[2]
        status, report = self.replay(results=results, native_results=native)
        self.assertEqual(status, 0)
        self.assertEqual(report["summary"]["exact"], 2)
        self.assertEqual(report["summary"]["presentationEquivalent"], 1)
        self.assertEqual(report["summary"]["unaccepted"], 0)


if __name__ == "__main__":
    unittest.main()
