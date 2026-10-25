"""Preserve original sample bytes and derive phase-aligned trace diagnostics."""
from pathlib import Path
import json,shutil,hashlib,collections
from cpu import summarize
raw=Path('raw');out=Path('compact');out.mkdir(exist_ok=True)
inventory=[]
for p in raw.rglob('*'):
 if not p.is_file():continue
 rel=p.relative_to(raw)
 if len(rel.parts)==4 and rel.parts[0]=='staged' and rel.parts[1] in ('ecl-oz','ecl-oz-maxima-oz') and rel.parts[2:] == ('maxima-runtime','maxima.js'):
  dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest)
  inventory.append({'path':str(rel),'originalBytes':p.stat().st_size,'originalSha256':hashlib.sha256(p.read_bytes()).hexdigest()})
  continue
 if 'staged' in rel.parts or 'tool-sources' in rel.parts:continue
 if p.name.startswith('trace-') and p.suffix=='.json':
  d=json.loads(p.read_bytes());events=d['traceEvents'];counts=collections.Counter(e['name'] for e in events)
  markers=[e for e in events if e['name']=='clock_sync']
  wasm=[e for e in events if any(x in e['name'].lower() for x in ('wasm','compile','gc','clock_sync'))]
  if any(e['name']=='ProfileChunk' for e in events):
   summary=summarize(events,raw,d.get('calibration'))
   (out/(p.stem+'-cpu-summary.json')).write_text(json.dumps(summary,indent=2)+'\n')
   print(json.dumps({'cpuTrace':str(rel),'windows':[(w['sample'],w['contexts'],w['leafFrames'][:5]) for w in summary['windows']]}))
  value={'pair':d['pair'],'counts':dict(counts),'clockSync':markers,'events':wasm}
  dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(value))
  print(json.dumps({'trace':str(rel),'counts':counts.most_common(30),'clockSync':markers}))
 elif p.name in ('report.json','sample.json','partial.json','admission.json','identity.json','runner-hardware.json','bindings.json','admission-failure.json') or p.name.endswith('admission.json'):
  dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest)
  if p.name=='report.json':
   d=json.loads(p.read_bytes());print(json.dumps({'report':str(rel),'passed':d.get('passed'),'failure':d.get('failure'),'samples':len(d.get('samples',[])),'summary':d.get('summary')}))
 else:continue
 inventory.append({'path':str(rel),'originalBytes':p.stat().st_size,'originalSha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(out/'original-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
