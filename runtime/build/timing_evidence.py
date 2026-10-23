# SPDX-License-Identifier: AGPL-3.0-or-later
"""Bind benchmark programs to the exact accepted native browser capture."""
import hashlib
import json


def digest(body):
    return hashlib.sha256(body).hexdigest()


def captured_workload(browser):
    assert browser['passed'] is True and len(browser['programs'])==316
    questions=[q for q in browser['manifest']['questions'] if q['id']=='native-rational']
    assert len(questions)==1
    name=questions[0]['question']['name']
    assert isinstance(name,str) and name
    result=[]
    for operation in ['prepare','validate','prt']:
        rows=[p for p in browser['programs'] if p.get('question')==name and p.get('operation')==operation]
        assert rows and isinstance(rows[0]['expression'],str) and rows[0]['expression']
        row=rows[0]
        result.append({'operation':operation,'question':name,'expression':row['expression'],'expected':row['result']})
    return result


def validate_workload(timing,browser):
    expected=captured_workload(browser)
    assert timing['passed'] is True and timing['nativePrograms']==expected, 'Timing workload differs from accepted browser capture'
    assert len(timing['samples'])==12, 'Incomplete accepted timing samples'
    assert {(s['candidate'],s['repetition'],s['mode']) for s in timing['samples']}=={(candidate,n,mode) for candidate in ['baseline','deployed','owned'] for n in [1,2] for mode in ['cold','warm-profile-reload']}
    for sample in timing['samples']:
        assert sample['ok'] is True
        calls=sample['nativeCalls']
        assert [{key:call[key] for key in ['operation','question','expression','expected']} for call in calls]==expected, 'Sample substituted native programs'
        assert all(call['result']==call['expected'] for call in calls)
    return expected


def verify_workload_files(timing_path,browser_path,acceptance,manifest_sha):
    timing_bytes=timing_path.read_bytes()
    browser_bytes=browser_path.read_bytes()
    assert acceptance['timingReportSha256']==digest(timing_bytes), 'Changed/stale timing report'
    assert acceptance['browserReportSha256']==digest(browser_bytes), 'Changed/stale browser report'
    timing,browser=json.loads(timing_bytes),json.loads(browser_bytes)
    assert timing['owned']['runtimeBuild']['manifestSha256']==manifest_sha
    return validate_workload(timing,browser)
