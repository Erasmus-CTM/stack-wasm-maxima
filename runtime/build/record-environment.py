#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Record the observed build environment; this is not an image pin."""
import json
import os
from pathlib import Path
import platform
import subprocess

ROOT = Path(__file__).resolve().parents[2]
output = ROOT / '.cache/runtime-build/logs/environment.json'
packages = subprocess.check_output(['dpkg-query','-W','-f=${binary:Package}\t${Version}\n'], text=True)
record = {'schema':1,'runnerImage':{key:os.environ.get(key) for key in ['ImageOS','ImageVersion','RUNNER_OS','RUNNER_ARCH']},
          'buildIdentity':{'runId':os.environ.get('GITHUB_RUN_ID'),'runAttempt':os.environ.get('GITHUB_RUN_ATTEMPT'),'sourceRevision':os.environ.get('GITHUB_SHA'),'coldBuild':os.environ.get('CTM_COLD_BUILD')},
          'kernel':platform.platform(),'dpkgPackages':packages,'runnerContext':{key:os.environ.get(key) for key in ['GITHUB_ACTIONS','RUNNER_ENVIRONMENT']},'coldBuild':{'observedGithubHostedRun':os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted','configuredWorkflowPolicy':{'restoreHostCache':False,'restoreSdkCache':False,'useCcache':False}},
          'scope':'Observed environment and package versions. Ubuntu runner/package versions are not fully pinned; digest-pinned release build environment remains future work.'}
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({key:value for key,value in record.items() if key!='dpkgPackages'}))
