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


class ReplayEnvelopeTests(unittest.TestCase):
    def replay(self, *, passed=True, payload=None, alter_output=None, native_exit=0,
               runtime=None, modified_source=False, extra_source=False):
        programs = [{"operation": operation, "expression": '"17.50"', "result": "17.50"}
                    for operation in ("prepare", "validate", "prt")]
        browser = {"passed": passed, "programs": programs, "runtime": runtime if runtime is not None else
                   {"stackRevision": reference.STACK_SHA, "stackLibraryVersion": "2026101500"}}
        if payload is None:
            payload = json.dumps(browser)
        lines = ["CTMNATIVE-VERSION|5.47.0|2026101500"]
        lines += [f"CTMNATIVE-REFERENCE|{index}|" + json.dumps([True, row["result"]])
                  for index, row in enumerate(programs)]
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


if __name__ == "__main__":
    unittest.main()
