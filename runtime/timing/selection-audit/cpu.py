"""Phase-align sampled CPU leaf frames; never interpret diagnostic times as selection medians."""
from collections import defaultdict
import json,statistics
from pathlib import Path

def summarize(events, raw):
 markers=[e for e in events if e['name']=='clock_sync' and str(e.get('args',{}).get('sync_id','')).startswith('epoch-')]
 assert markers, [e for e in events if 'clock' in e['name'].lower()][:10]
 offsets=[float(e['args']['sync_id'][6:])-e['ts']/1000 for e in markers]
 assert max(offsets)-min(offsets)<2, [(e.get('args'),e['ts']) for e in markers]
 offset=statistics.median(offsets)
 windows=[]
 for p in raw.glob('trials/*/sample.json'):
  s=json.loads(p.read_bytes())
  phase=next(x for x in s['result']['phases'] if x['name']=='first-positive-grade')
  windows.append({'sample':p.parent.name,'startEpochMs':phase['startEpochMs'],'endEpochMs':phase['endEpochMs'],'elapsedMs':phase['elapsedMs']})
 profiles={};preview=[]
 for e in events:
  if e['name'] not in ('Profile','ProfileChunk'):continue
  if len(preview)<2:preview.append(str(e)[:2500])
  key=(e['pid'],e['tid'],e.get('id'))
  p=profiles.setdefault(key,{'nodes':{},'samples':[],'deltas':[]})
  data=e.get('args',{}).get('data',{})
  if e['name']=='Profile':p['startTime']=data.get('startTime',e['ts'])
  cpu=data.get('cpuProfile',{})
  for node in cpu.get('nodes',[]):p['nodes'][node['id']]=node
  p['samples'].extend(cpu.get('samples',[]));p['deltas'].extend(data.get('timeDeltas',[]))
 result=[]
 for w in windows:
  groups=defaultdict(lambda:{'sampledMs':0,'samples':0});contexts=[]
  for key,p in profiles.items():
   assert len(p['samples'])==len(p['deltas']),(key,len(p['samples']),len(p['deltas']))
   if 'startTime' not in p:continue
   t=p['startTime']/1000+offset;count=0;total=0
   for nodeid,delta in zip(p['samples'],p['deltas']):
    end=t+delta/1000;overlap=max(0,min(end,w['endEpochMs'])-max(t,w['startEpochMs']))
    if overlap:
     node=p['nodes'][nodeid];frame=node.get('callFrame',{});name=(frame.get('functionName',''),frame.get('url',''))
     groups[name]['sampledMs']+=overlap;groups[name]['samples']+=1;count+=1;total+=overlap
    t=end
   if count:contexts.append({'pid':key[0],'tid':key[1],'id':key[2],'selectedSamples':count,'sampledMs':total,'nodes':len(p['nodes'])})
  result.append({**w,'contexts':contexts,'leafFrames':sorted([{'functionName':k[0],'url':k[1],**v} for k,v in groups.items()],key=lambda v:-v['sampledMs'])[:80]})
 return {'schema':1,'diagnosticOnly':True,'method':'Chrome Profile/ProfileChunk startTime plus cumulative timeDeltas, calibrated to one recorded epoch clock_sync marker. Each delta interval is clipped to the measured first-positive-grade wall window. Leaf-frame weights are sampled wall intervals per CPU context, not additive CPU time across threads. Instrumented n3 only.','profileFormatPreview':preview,'windows':result}
