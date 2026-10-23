#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Compare compiled source bytes with pinned Git blobs, excluding generated support."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/runtime-build'
phase = sys.argv[1]
assert phase in ['before','after']
pins = json.loads((ROOT / 'runtime/build/pins.json').read_text())
critical = {'wasm/Makefile','wasm/build.lisp','src/maxima.asd'}
mathematical_suffixes = {'.lisp','.lsp','.mac','.asd','.c','.h','.d'}
observed = []
for pin in pins['sources']:
    if pin['name'] not in ['maxima','ecl']:
        continue
    source = WORK / 'sources' / pin['name']
    revision = subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
    assert revision == pin['commit']
    tree = subprocess.check_output(['git','ls-tree','-r','-z','HEAD'],cwd=source)
    checked = []
    for entry in tree.split(b'\0'):
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t',1)
        mode, kind, blob = metadata.decode().split()
        assert kind == 'blob', 'Unexpected submodule source input'
        path = raw_path.decode()
        if phase == 'after' and Path(path).suffix not in mathematical_suffixes and not (pin['name']=='maxima' and path in critical):
            continue
        file = source / path
        body = os.fsencode(os.readlink(file)) if mode == '120000' else file.read_bytes()
        assert hashlib.sha1(b'blob '+str(len(body)).encode()+b'\0'+body).hexdigest() == blob, pin['name']+'/'+path
        if pin['name']=='maxima' and path in critical:
            target = WORK / 'build-recipes/maxima' / path
            if phase == 'before':
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(body)
            assert target.read_bytes() == body
        checked.append({'path':path,'gitBlob':blob,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()})
    assert checked
    observed.append({'name':pin['name'],'revision':revision,'files':checked})
report = {'schema':1,'phase':phase,'passed':True,'sources':observed,
          'scope':'Before: every tracked Maxima/ECL input byte. After: tracked .lisp/.lsp/.mac/.asd/.c/.h/.d files and the three Maxima build inputs; generated configuration/build support is excluded from the after claim.'}
output = WORK / 'logs' / ('source-state-'+phase+'.json')
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'phase':phase,'passed':True,'files':sum(len(row['files']) for row in observed)}))
