"""Post-failure observer only; does not change the validation verdict."""
from pathlib import Path
import json,hashlib
p=Path('site/native/engine.js');body=p.read_bytes();s=body.decode()
a="      this.emit({event:'native-evaluate', operation, question:question.name, expression, result});"
b=a+'''
      if (operation === 'validate' && JSON.stringify(result).includes('Native STACK could not evaluate this expression')) {
        let condition;try { condition=this.session.evaluate('errormsgtostring()'); }catch(error){condition=String(error);}
        this.emit({event:'diagnostic-source-validation-condition',question:question.name,expression,condition});
      }'''
assert s.count(a)==1;s=s.replace(a,b);p.write_text(s)
Path('source-ui-derivation.json').write_text(json.dumps({'diagnosticOnly':True,'acceptance':False,'file':str(p),'originalSha256':hashlib.sha256(body).hexdigest(),'derivedSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'scope':'One post-verdict diagnostic query on generic CAS validation failure; the original result and test assertion are unchanged.'},indent=2)+'\n')
