"""Summarize every attempted sample without dropping failed or slow observations."""
import argparse,json,statistics,hashlib
from pathlib import Path

parser=argparse.ArgumentParser();parser.add_argument('root',type=Path);parser.add_argument('output',type=Path);args=parser.parse_args()
args.output.mkdir(parents=True,exist_ok=True)
rows=[];sources=[]
for condition,path in [('unrestricted',args.root/'report.json'),('CPUQuota=25%',args.root/'cpu-quarter/report.json')]:
 body=path.read_bytes();report=json.loads(body)
 assert report['passed'] is True and report['repetitions']==10 and len(report['samples'])==40
 assert report['plannedMeasurements']==40 and all(s['ok'] for s in report['samples'])
 assert not report['skipped'] and not report.get('pairFailures') and not report['lateTelemetryFailed']
 sources.append({'condition':condition,'path':str(path),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'benchmark':report['benchmark'],'browser':report['browser'],'admission':report['admission']})
 for sample in report['samples']:
  assert sample['candidate']=='source' and sample['startupGuardPassed'] and sample['termination']['ok']
  rows.append({'condition':condition,**sample})
summary=[]
for condition in ('unrestricted','CPUQuota=25%'):
 for mode in ('cold','warm-profile-reload'):
  for profile in ('ecl-oz','ecl-oz-maxima-oz'):
   samples=sorted([r for r in rows if (r['condition'],r['mode'],r['profile'])==(condition,mode,profile)],key=lambda r:r['repetition'])
   assert [r['repetition'] for r in samples]==list(range(1,11))
   metrics={}
   for key in samples[0]['timings']:
    values=[r['timings'][key]/1000 for r in samples]
    q1,_,q3=statistics.quantiles(values,n=4,method='inclusive')
    metrics[key]={'n':10,'medianSeconds':statistics.median(values),'q1Seconds':q1,'q3Seconds':q3,'minSeconds':min(values),'maxSeconds':max(values),'sampleStdevSeconds':statistics.stdev(values),'rawSeconds':values}
   summary.append({'condition':condition,'mode':mode,'profile':profile,'metrics':metrics})
result={'schema':1,'sources':sources,'summary':summary,'samples':rows,'producerScopeCorrection':'The inherited producer scope prose still describes its original six-cell n3 matrix. The selection run is its explicit n10, source-only 20-pair plan: two profiles and 40 measurements per CPU condition. No FAS sample was timed in this selection.', 'scope':'Source STACK only. n10 per profile/mode/CPU condition, same runner, alternating AB/BA pairs (five each). Cold is a fresh browser/profile, not a cleared host OS cache. Warm-profile reload follows acknowledged prior worker termination. IQR uses inclusive linear interpolation. Times in seconds; no samples omitted.'}
(args.output/'results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(summary,indent=2))
