"""Record that the complete source UI uses the original engine bytes."""
from pathlib import Path
import json,hashlib
p=Path('site/native/engine.js');body=p.read_bytes();original=Path('prototype/native/engine.js').read_bytes()
assert body==original
Path('source-ui-derivation.json').write_text(json.dumps({'diagnosticOnly':True,'acceptance':False,'file':str(p),'originalSha256':hashlib.sha256(body).hexdigest(),'derivedSha256':hashlib.sha256(body).hexdigest(),'scope':'No engine or session observer modification. Full original UI and original validation verdicts.'},indent=2)+'\n')
