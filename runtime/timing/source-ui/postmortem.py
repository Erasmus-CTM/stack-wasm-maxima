"""Observe only after the original validation has already returned unexpected invalid."""
from pathlib import Path
import hashlib,json
p=Path('site/native/engine.js');body=p.read_bytes();s=body.decode()
snapshotLisp=json.loads(Path('benchmark/runtime/timing/validation-probe/postmortem-expression.json').read_text())['lisp']
helper=' '.join(line.strip() for line in Path('benchmark/runtime/timing/source-ui/validation-trace.lisp').read_text().splitlines())
anchor='      const result = this.session.evaluate(expression);'
assert s.count(anchor)==1
addition='''
      if (operation === 'validate' && question.name === 'A graphical PythonChecker' &&
          expression.includes('eval_string("[1,1]")') && result.ans?.valid === false &&
          result.ans.feedback === 'Native STACK could not evaluate this expression') {
        const postmortem = {scope:'Retained Maxima frame backing storage after original result serialization; unwound entries may be stale. Diagnostic executes only after the unexpected invalid result.'};
        try {
          this.session.write(COMMAND, 60000);
          postmortem.frames = this.session.evaluate('ctm_postmortem_snapshot');
          postmortem.condition = this.session.evaluate('errormsgtostring()');
          this.session.write(HOOK, 60000);
          postmortem.diagnosticReevaluations = [];
          for (let attempt=0; attempt<5; attempt++) {
            const repeat = this.session.evaluate(expression);
            const trace = this.session.evaluate('ctm_validation_trace');
            postmortem.diagnosticReevaluations.push({attempt,result:repeat,trace});
            if (repeat.ans?.valid === false && trace !== 'not captured') break;
          }
        } catch (error) { postmortem.error = String(error); }
        result.ans.postmortem = postmortem;
      }'''.replace('COMMAND',json.dumps(':lisp (setf maxima::$ctm_postmortem_snapshot '+snapshotLisp+')\n')).replace('HOOK',json.dumps(':lisp '+helper+'\n'))
s=s.replace(anchor,anchor+addition);p.write_text(s)
manifest=Path('site/stack-sources.json').read_bytes()
Path('source-ui-derivation.json').write_text(json.dumps({'diagnosticOnly':True,'acceptance':False,'file':str(p),'originalSha256':hashlib.sha256(body).hexdigest(),'derivedSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'startupManifestSha256':hashlib.sha256(manifest).hexdigest(),'scope':'No startup or generated validation program changes. Only after the original exact-case generic-invalid result, snapshot retained frame storage and current error. Original validity verdict unchanged. Later instrumented re-evaluations are diagnostic only and never replace it.'},indent=2)+'\n')
