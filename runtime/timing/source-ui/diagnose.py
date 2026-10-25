"""Capture the caught condition inside the failing validation, only for its exact case."""
from pathlib import Path
import json,hashlib
p=Path('site/native/engine.js');body=p.read_bytes();s=body.decode()
a="        const learnerChecks = ["
b="""        const targetDiagnostic = question.name === 'A graphical PythonChecker' && admitted[input.name].source.replace(/\\s/g,'') === '[1,1]';
        const learnerChecks = ["""
assert s.count(a)==1;s=s.replace(a,b)
a="            ['feedback','simplode(_ctm_lines,\" \")'], ['source','if _ctm_good then string(ev(_ctm_s,simp)) else \"\"']])"
b="""            ['feedback','simplode(_ctm_lines," ")'], ['source','if _ctm_good then string(ev(_ctm_s,simp)) else ""'],
            ...(targetDiagnostic ? [['diagnostic','if _ctm_good then false else [errormsgtostring(),string(%ERR),string(%NOTES),_ctm_validation_stage]']] : [])])"""
assert s.count(a)==1;s=s.replace(a,b)
a="        checks.push([input.name, block(['_ctm_s'"
b="""        const observedChecks = targetDiagnostic ? learnerChecks.flatMap((check,index)=>['_ctm_validation_stage:'+quote('step-'+index),check]) : learnerChecks;
        checks.push([input.name, block(['_ctm_s'"""
assert s.count(a)==1;s=s.replace(a,b)
a="          '%ERR:[\"stack_map\"]','%NOTES:[\"stack_map\"]','%FEEDBACK:[\"stack_map\"]'], ["
b="""          '%ERR:["stack_map"]','%NOTES:["stack_map"]','%FEEDBACK:["stack_map"]',
          ...(targetDiagnostic ? ['_ctm_validation_stage:"before-student"'] : [])], ["""
assert s.count(a)==1;s=s.replace(a,b)
a="          '_ctm_r:errcatch(' + block([],learnerChecks) + ')',"
b="          '_ctm_r:errcatch(' + block([],observedChecks) + ')',"
assert s.count(a)==1;s=s.replace(a,b)
a="            ['feedback','\"Native STACK could not evaluate this expression\"'],['source','\"\"']]) + ' else first(_ctm_r)'"
b="""            ['feedback','"Native STACK could not evaluate this expression"'],['source','""'],
            ...(targetDiagnostic ? [['diagnostic','[errormsgtostring(),string(%ERR),string(%NOTES),_ctm_validation_stage]']] : [])]) + ' else first(_ctm_r)'"""
assert s.count(a)==1;s=s.replace(a,b);p.write_text(s)
Path('source-ui-derivation.json').write_text(json.dumps({'diagnosticOnly':True,'acceptance':False,'file':str(p),'originalSha256':hashlib.sha256(body).hexdigest(),'derivedSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'scope':'Only the exact failing PythonChecker [1,1] validation records its current caught condition and last operation. Other validations are unchanged; original validity verdict remains authoritative.'},indent=2)+'\n')
