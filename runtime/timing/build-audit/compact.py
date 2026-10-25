from pathlib import Path
import json,hashlib,shutil
raw=Path('raw');out=Path('compact');out.mkdir(exist_ok=True);inventory=[]
for p in raw.rglob('*'):
 if not p.is_file():continue
 rel=p.relative_to(raw);name=rel.as_posix()
 selected=(name.startswith(('test-results/milestone-three/','test-results/precompiled-stack/','test-results/milestone-one/','.cache/runtime-build/validation/')) and p.suffix in ('.json','.log')) or name in ('.cache/native-build/prepared.json','.cache/runtime-build/artifact/manifest.json','site/native/build-manifest.json')
 if not selected:continue
 dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest)
 inventory.append({'path':name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
 if p.suffix=='.json':
  d=json.loads(p.read_bytes());d=d if isinstance(d,dict) else {};print(json.dumps({'path':name,'keys':list(d),'passed':d.get('passed'),'failure':d.get('failure'),'error':d.get('error'),'errors':d.get('errors'),'programs':len(d.get('programs',[])) if isinstance(d.get('programs'),list) else d.get('programs'),'summary':d.get('summary')},default=str))
(out/'inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
