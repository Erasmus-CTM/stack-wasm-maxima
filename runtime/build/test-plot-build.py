#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Prove an authored XML plot becomes an actionable actual-Wasm build diagnostic."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/runtime-build/plot-diagnostic'
SITE = WORK / 'site'
WORK.mkdir(parents=True, exist_ok=False)
shutil.copytree(ROOT / 'site', SITE)
spec = importlib.util.spec_from_file_location('compile_native', ROOT / 'scripts/milestone-three/compile.py')
compiler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler)
checkers = compiler.checked_revision(ROOT / '.site-sources/ctm-checkers', compiler.CHECKERS_REVISION)
spec = importlib.util.spec_from_file_location('plot_fixture_importer', checkers / 'src/ctm_checkers/stack/importer.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)
importer.TESTS.add('PythonChecker')
tree = ET.fromstring((SITE / 'maxima/native-questions/native-rational.xml').read_bytes())
variables = tree.find('.//questionvariables/text')
assert variables is not None
variables.text = (variables.text or '') + '\nctm_legacy_plot:plot(x,[x,0,1]);\n'
body = ET.tostring(tree, encoding='utf-8')
(WORK / 'authored-plot-question.xml').write_bytes(body)
identifier = 'authored-plot-diagnostic'
question = compiler.compile_question(body, importer, identifier)
assert 'ctm_legacy_plot:plot(x,[x,0,1]);' in question['variables']
data = json.loads((SITE / 'native/questions.json').read_text())
data['questions'] = [{'id':identifier,'title':'Legacy plot requires JSXGraph','seeds':[1], 'question':question,'graph':None,'probes':[]}]
(SITE / 'native/questions.json').write_text(json.dumps(data)+'\n')
command = ['node','scripts/milestone-three/build-site.mjs','--site',str(SITE),'--work',str(WORK / 'preparation'),
           '--stack-source','.site-sources/stack','--ctm-checkers-source','.site-sources/ctm-checkers','--jsxgraph-source','.site-sources/jsxgraph-quarto']
result = subprocess.run(command,cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=420)
(WORK / 'build.log').write_text(result.stdout)
failure_path = WORK / 'preparation/build-failure.json'
failure = json.loads(failure_path.read_text())
assert result.returncode != 0 and identifier in failure['error']
assert 'CTM plotting unavailable; use JSXGraph.' in failure['error'], failure['error']
staged = json.loads((SITE / 'stack-sources.json').read_text())
report = {'schema':1,'passed':True,'expectedBuildFailure':True,'question':identifier,
          'authoredXmlSha256':hashlib.sha256(body).hexdigest(),'buildFailureSha256':hashlib.sha256(failure_path.read_bytes()).hexdigest(),
          'runtimeBuild':staged['runtimeBuild'],'diagnostic':failure['error'],
          'scope':'Original authored XML changed only by adding a plot assignment, passed through the existing XML compiler and actual native build preparation. No text-pattern admission rule.'}
(ROOT / '.cache/runtime-build/validation/plot-diagnostic.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
