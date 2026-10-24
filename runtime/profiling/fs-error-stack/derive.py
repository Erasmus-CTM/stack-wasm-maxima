#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Derive a diagnostic JS copy as data; never execute the generated runtime."""
import argparse,hashlib,json
from pathlib import Path

SOURCE_BYTES=1239434
SOURCE_SHA='385763ca1038fac02e8f7d247a8d808997238b03ba1919ce2f4dcec482fdb101'
CLASS_START=b'  ErrnoError:class extends Error {'
CLASS_END=b'\n  FSStream:class {'
CLASS_SHA='6b26c61341385fb323fc0a5abaa9fd805e302d9213fec0e7a7751b9d89cd91de'
ANCHOR=b"          super(runtimeInitialized ? strError(errno) : '');"
HERE=Path(__file__).resolve().parent


def record(body):return {'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}


def derive(original):
 assert record(original)=={'bytes':SOURCE_BYTES,'sha256':SOURCE_SHA},'Unexpected original generated JavaScript'
 assert original.count(CLASS_START)==original.count(ANCHOR)==1,'Constructor anchor must be unique'
 start=original.index(CLASS_START);end=original.index(CLASS_END,start)
 original_class=original[start:end]
 assert record(original_class)['sha256']==CLASS_SHA,'Constructor contract changed'
 offset=original.index(ANCHOR);assert start<offset<end
 replacement=(HERE/'errno-stack-body.jsfrag').read_bytes().rstrip(b'\n')
 assert replacement and replacement.count(b'super(ctmErrnoMessage)')==2
 receipt=(HERE/'errno-stack-receipt.jsfrag').read_bytes().rstrip(b'\n')
 tail=b'        }\n      },'
 assert original_class.count(tail)==1
 changed_class=original_class.replace(ANCHOR,replacement).replace(tail,receipt+b'\n'+tail)
 result=original[:start]+changed_class+original[end:]
 assert result[:start]+original_class+result[start+len(changed_class):]==original
 return result,{'schema':1,'kind':'derived-diagnostic-javascript','acceptedUnchangedRuntime':False,
                'original':record(original),'derived':record(result),
                'edit':{'offset':start,'original':record(original_class),'replacement':record(changed_class),
                        'superCallOffset':offset,'stackBody':record(replacement),'receiptBody':record(receipt),
                        'originalConstructor':{'offset':start,**record(original[start:end])}},
                'policy':{'numericErrnos':[44,54],'requiresStringMessage':True,
                          'requiresOwnWritableFiniteNumericStackLimit':True,
                          'messageComputedBeforeSuppression':True,'descriptorRestoredInFinally':True,
                          'classPrototypeAndConstructorUnreplaced':True,
                          'otherErrnosCaptureNormally':True,
                          'actualChildReceipt':'Once on first numeric44/54 construction, after original errno/code assignments and descriptor restoration; Module namespace collision and observer errors produce missing receipt, never alter filesystem errors'},
                'limitations':['Expected error stacks lose call frames; unexpected errors with the same errno also lose frames but remain errors with unchanged errno/message/code.',
                               'The native Error stack-limit setting changes synchronously only around super(message); this is an explicitly derived counterfactual, not an unchanged accepted runtime.',
                               'Sampled profiler intervals and observed FS elapsed time are not predicted recoverable CPU time or a speedup claim.']}


if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--original',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--proof',type=Path,required=True);args=parser.parse_args()
 result,proof=derive(args.original.read_bytes())
 args.output.parent.mkdir(parents=True,exist_ok=True);args.proof.parent.mkdir(parents=True,exist_ok=True)
 with args.output.open('xb') as f:f.write(result)
 with args.proof.open('x') as f:f.write(json.dumps(proof,indent=2)+'\n')
 print(json.dumps({'original':proof['original'],'derived':proof['derived'],'scope':'Data-only derivation; generated JavaScript was not executed'}))
