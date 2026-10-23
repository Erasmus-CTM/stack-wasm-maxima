#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reject benchmark substitution even when all trials share the same fake code."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from timing_evidence import captured_workload,digest,verify_workload_files


class WorkloadEvidence(unittest.TestCase):
    def test_browser_binding_and_substitutions(self):
        base=Path(__file__).resolve().parents[2]/'.cache/timing-fixtures'
        base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as folder:
            root=Path(folder);timing_path=root/'timings.json';browser_path=root/'browser.json'
            browser={'passed':True,'manifest':{'questions':[{'id':'native-rational','question':{'name':'Pinned rational'}}]},
                     'programs':[{'operation':op,'question':'Pinned rational','expression':'captured_'+op+'(real_question)','result':[op,42]} for op in ['prepare','validate','prt']]}
            browser['programs'] += [{'operation':'other'} for _ in range(313)]
            programs=captured_workload(browser)
            timing={'passed':True,'owned':{'runtimeBuild':{'manifestSha256':'a'*64}},'nativePrograms':programs,
                    'samples':[{'candidate':candidate,'repetition':n,'mode':mode,'ok':True,'nativeCalls':[{**row,'result':row['expected'],'elapsedMs':1} for row in programs]} for candidate in ['baseline','deployed','owned'] for n in [1,2] for mode in ['cold','warm-profile-reload']]}
            def save(t=timing,b=browser):
                timing_path.write_text(json.dumps(t));browser_path.write_text(json.dumps(b))
                return {'timingReportSha256':digest(timing_path.read_bytes()),'browserReportSha256':digest(browser_path.read_bytes())}
            accepted=save();self.assertEqual(verify_workload_files(timing_path,browser_path,accepted,'a'*64),programs)
            substituted=copy.deepcopy(timing)
            for row in substituted['nativePrograms']:row.update(expression='6*7',expected=42)
            for sample in substituted['samples']:
                for row in sample['nativeCalls']:row.update(expression='6*7',expected=42,result=42)
            timing_path.write_text(json.dumps(substituted))
            with self.assertRaises(AssertionError):verify_workload_files(timing_path,browser_path,accepted,'a'*64)
            rehashed=save(substituted)
            with self.assertRaises(AssertionError):verify_workload_files(timing_path,browser_path,rehashed,'a'*64)
            changed_sample=copy.deepcopy(timing);changed_sample['samples'][0]['nativeCalls'][0]['expression']='6*7'
            rehashed=save(changed_sample)
            with self.assertRaises(AssertionError):verify_workload_files(timing_path,browser_path,rehashed,'a'*64)
            missing_samples=copy.deepcopy(timing);missing_samples['samples']=[]
            rehashed=save(missing_samples)
            with self.assertRaises(AssertionError):verify_workload_files(timing_path,browser_path,rehashed,'a'*64)
            accepted=save();browser_path.write_text(json.dumps({**browser,'passed':False}))
            with self.assertRaises(AssertionError):verify_workload_files(timing_path,browser_path,accepted,'a'*64)
            accepted=save();browser_path.unlink()
            with self.assertRaises(FileNotFoundError):verify_workload_files(timing_path,browser_path,accepted,'a'*64)
            accepted=save();timing_path.unlink()
            with self.assertRaises(FileNotFoundError):verify_workload_files(timing_path,browser_path,accepted,'a'*64)
            accepted=save();del accepted['timingReportSha256']
            with self.assertRaises(KeyError):verify_workload_files(timing_path,browser_path,accepted,'a'*64)


if __name__=='__main__':unittest.main()
