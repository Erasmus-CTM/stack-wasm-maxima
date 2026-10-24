#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""DIAGNOSTIC ONLY: observe the pinned ECL/Boehm root push; never repair it.

Build the unchanged native host before applying this target-only overlay.  The
resulting libecl.so is a changed diagnostic input, not an admitted production
runtime.  All original root ranges, push calls, capacity and aborts remain.
"""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import subprocess


PIN = "e4bdb2e5b1e444e1773032a53650773848f4d6cd"
EXPECTED = {
    "src/bdwgc/mark.c": "adb98ba158942ff19a8e5afa4f7628dbc5f2fc1168752e91d52fb3867e5f0d9c",
    "src/bdwgc/mark_rts.c": "99d93298978b592a0aa61d4a4506b38d1e2c1e035afc9d90b1be45d23ace9078",
    "src/c/alloc_2.d": "d7492e257e5dc9a143bb86461686b6f3e030b1d741c93c31ab645a9f74d2f5d7",
}
PHASES = {
    0: "outside-root-pass",
    10: "static-roots",
    20: "collector-internal-roots",
    30: "C-registers-and-stack",
    40: "before-custom-root-callback",
    50: "ECL-stacks-scanner-entry",
    51: "ECL-locked-library-cblock",
    52: "ECL-core",
    53: "ECL-core-symbols",
    54: "ECL-environment-run-stack",
    55: "ECL-environment-frame-stack",
    56: "ECL-environment-binding-stack",
    57: "ECL-environment-thread-bindings",
    58: "ECL-environment-structure",
    59: "ECL-chained-original-root-callback",
    60: "ECL-stacks-scanner-exit",
    90: "root-pass-exit",
}

# These two new C symbols only carry diagnostics within the rebuilt ECL module.
# Existing ABI symbols, object layouts and collector policy are unchanged.
DECLARATIONS = r'''
/* CTM DIAGNOSTIC MODIFICATION: root-push occupancy only; not a GC fix. */
#ifndef __EMSCRIPTEN__
# error "Build the unchanged native host before applying CTM GC diagnostics"
#endif
extern void GC_ctm_diag_set_phase(unsigned phase);
extern void GC_ctm_diag_checkpoint(unsigned phase);
'''

LOGGER = r'''
/* CTM DIAGNOSTIC MODIFICATION: root-push occupancy only; not a GC fix. */
#ifndef __EMSCRIPTEN__
# error "Build the unchanged native host before applying CTM GC diagnostics"
#endif
static unsigned GC_ctm_diag_phase;
static unsigned long GC_ctm_diag_root_pass;

void GC_ctm_diag_set_phase(unsigned phase)
{
    GC_ctm_diag_phase = phase;
    if (phase == 10) ++GC_ctm_diag_root_pass;
}

static void GC_ctm_diag_emit(const char *event, void *bottom, void *top)
{
    /* GC_err_printf uses its bounded C-stack buffer and write path.
       No Lisp calls, managed allocations, or collector calls are added. */
    GC_err_printf("CTM-GC-DIAG|event=%s|pass=%lu|phase=%u|used=%lu|capacity=%lu"
                  "|base=%p|top=%p|limit=%p|bottom=%p|end=%p\n",
                  event, GC_ctm_diag_root_pass, GC_ctm_diag_phase,
                  (unsigned long)((word)GC_mark_stack_top + sizeof(mse)
                                  - (word)GC_mark_stack) / sizeof(mse),
                  (unsigned long)((word)GC_mark_stack_limit
                                  - (word)GC_mark_stack) / sizeof(mse),
                  (void *)GC_mark_stack, (void *)GC_mark_stack_top,
                  (void *)GC_mark_stack_limit, bottom, top);
}

void GC_ctm_diag_checkpoint(unsigned phase)
{
    GC_ctm_diag_set_phase(phase);
    GC_ctm_diag_emit("checkpoint", NULL, NULL);
}
'''


def sha(data):
    return hashlib.sha256(data).hexdigest()


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("Pinned instrumentation anchor is not unique: " + repr(old[:100]))
    return text.replace(old, new, 1)


def derive(originals):
    """Pure transformation; each complete source input is hash constrained."""
    for path, digest in EXPECTED.items():
        if sha(originals[path]) != digest:
            raise ValueError("Unexpected original ECL bytes: " + path)
    result = {}
    text = originals["src/bdwgc/mark.c"].decode()
    text = replace_once(text, '#include <stdio.h>\n', '#include <stdio.h>\n' + LOGGER)
    old = '''    GC_mark_stack_top++;
    if ((word)GC_mark_stack_top >= (word)GC_mark_stack_limit) {
        ABORT("Unexpected mark stack overflow");
    }
'''
    new = '''    /* CTM diagnostics observe the original pre-push state. */
    if ((word)(GC_mark_stack_top + 1) >= (word)(GC_mark_stack_limit - 32))
        GC_ctm_diag_emit("push-all-near-capacity", bottom, top);
    GC_mark_stack_top++;
    if ((word)GC_mark_stack_top >= (word)GC_mark_stack_limit) {
        GC_ctm_diag_emit("push-all-abort", bottom, top);
        ABORT("Unexpected mark stack overflow");
    }
'''
    text = replace_once(text, old, new)
    result["src/bdwgc/mark.c"] = text.encode()

    text = originals["src/bdwgc/mark_rts.c"].decode()
    text = replace_once(text, '#include <stdio.h>\n', '#include <stdio.h>\n' + DECLARATIONS)
    text = replace_once(text, '    unsigned kind;\n\n    /* Next push static data.',
                        '    unsigned kind;\n\n    GC_ctm_diag_set_phase(10);\n\n    /* Next push static data.')
    text = replace_once(text, '    /* Mark all free list header blocks,',
                        '    GC_ctm_diag_set_phase(20);\n\n    /* Mark all free list header blocks,')
    text = replace_once(text, '    /* Now traverse stacks, and mark from register contents.',
                        '    GC_ctm_diag_set_phase(30);\n\n    /* Now traverse stacks, and mark from register contents.')
    text = replace_once(text, '    if (GC_push_other_roots != 0) {',
                        '    GC_ctm_diag_checkpoint(40);\n    if (GC_push_other_roots != 0) {')
    text = replace_once(text, '        (*GC_push_other_roots)();\n    }\n}',
                        '        (*GC_push_other_roots)();\n    }\n    GC_ctm_diag_checkpoint(90);\n    GC_ctm_diag_set_phase(0);\n}')
    result["src/bdwgc/mark_rts.c"] = text.encode()

    text = originals["src/c/alloc_2.d"].decode()
    text = replace_once(text, '#include <gc/gc_mark.h>\n', '#include <gc/gc_mark.h>\n' + DECLARATIONS)
    # Braces only group each added phase assignment with its original guard.
    for guard, call, phase in (
        ('env->run_stack.org', 'GC_push_all((void *)env->run_stack.org, (void *)env->run_stack.top);', 54),
        ('env->frs_stack.org', 'GC_push_all((void *)env->frs_stack.org, (void *)(env->frs_stack.top+1));', 55),
        ('env->bds_stack.org', 'GC_push_all((void *)env->bds_stack.org, (void *)(env->bds_stack.top+1));', 56),
        ('env->bds_stack.tl_bindings', 'GC_push_all((void *)env->bds_stack.tl_bindings,\n                (void *)(env->bds_stack.tl_bindings + env->bds_stack.tl_bindings_size));', 57),
    ):
        text = replace_once(text, f'  if ({guard})\n    {call}',
                            f'  if ({guard}) {{\n    GC_ctm_diag_set_phase({phase});\n    {call}\n  }}')
    text = replace_once(text, '  GC_push_all((void *)env, (void *)(env + 1));',
                        '  GC_ctm_diag_set_phase(58);\n  GC_push_all((void *)env, (void *)(env + 1));')
    text = replace_once(text, '  cl_object l = cl_core.libraries;\n  loop_for_on_unsafe(l)',
                        '  cl_object l = cl_core.libraries;\n  GC_ctm_diag_checkpoint(50);\n  loop_for_on_unsafe(l)')
    for call, phase in (
        ('      GC_push_conditional((void *)dll, (void *)(&dll->cblock + 1), 1);', 51),
        ('  GC_push_all((void *)(&cl_core), (void *)(&cl_core + 1));', 52),
        ('  GC_push_all((void *)cl_symbols, (void *)(cl_symbols + cl_num_symbols_in_core));', 53),
    ):
        indent = call[:len(call) - len(call.lstrip())]
        text = replace_once(text, call, f'{indent}GC_ctm_diag_set_phase({phase});\n' + call)
    text = replace_once(text, '  if (old_GC_push_other_roots)\n    (*old_GC_push_other_roots)();\n}',
                        '  if (old_GC_push_other_roots) {\n    GC_ctm_diag_set_phase(59);\n    (*old_GC_push_other_roots)();\n  }\n  GC_ctm_diag_checkpoint(60);\n}')
    result["src/c/alloc_2.d"] = text.encode()
    return result


def git(source, *args):
    return subprocess.check_output(['git', '-C', str(source), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Clean pinned ECL checkout; mutated explicitly')
    parser.add_argument('--evidence', type=Path, required=True, help='New directory outside the source checkout')
    args = parser.parse_args()
    source, evidence = args.source.resolve(), args.evidence.resolve()
    if evidence == source or source in evidence.parents:
        raise ValueError('Evidence must be outside the ECL source tree')
    if evidence.exists():
        raise ValueError('Refusing to overwrite previous diagnostic evidence')
    if git(source, 'rev-parse', 'HEAD').decode().strip() != PIN:
        raise ValueError('Wrong ECL source commit')
    if git(source, 'status', '--porcelain', '--untracked-files=no').strip():
        raise ValueError('ECL tracked inputs must be clean before instrumentation')
    originals = {}
    for path in EXPECTED:
        originals[path] = (source / path).read_bytes()
        if originals[path] != git(source, 'show', PIN + ':' + path):
            raise ValueError('ECL source bytes differ from their pinned Git blob: ' + path)
    derived = derive(originals)
    evidence.mkdir(parents=True)
    report = {
        'schema': 1, 'kind': 'diagnostic-gc-root-occupancy', 'productionAdmission': False,
        'diagnosticOnly': True, 'acceptance': False,
        'eclCommit': PIN, 'sourcePin': PIN, 'helperSha256': sha(Path(__file__).read_bytes()),
        'phases': PHASES, 'nearCapacityRemainingEntries': 32,
        'changesCollectorPolicy': False, 'changesRootRanges': False,
        'preservesOriginalAbort': True, 'applied': False, 'files': [],
        'limitations': [
            'Instrumentation adds C frames, small globals and logging; it may perturb the failure.',
            'Phase identifies a source path category, not a captured native backtrace.',
            'Passing instrumented runs do not exonerate the original failed runtime.',
            'A rebuilt module requires an explicit diagnostic asset manifest and ABI checks.',
        ],
    }
    patches = []
    for path in EXPECTED:
        for directory, data in [('original', originals[path]), ('derived', derived[path])]:
            target = evidence / directory / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        patches.extend(difflib.unified_diff(originals[path].decode().splitlines(True),
                                           derived[path].decode().splitlines(True),
                                           fromfile='a/' + path, tofile='b/' + path))
        report['files'].append({'path': path,
                                'original': {'bytes': len(originals[path]), 'sha256': sha(originals[path])},
                                'derived': {'bytes': len(derived[path]), 'sha256': sha(derived[path])}})
    patch = ''.join(patches).encode()
    (evidence / 'instrumentation.patch').write_bytes(patch)
    report['patchSha256'] = sha(patch)
    report['patchBytes'] = len(patch)
    report_path = evidence / 'instrumentation.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    # All source anchors and hashes were checked before any source mutation.
    for path, data in derived.items():
        (source / path).write_bytes(data)
    changed = set(git(source, 'diff', '--name-only').decode().splitlines())
    if changed != set(EXPECTED):
        raise ValueError('Unexpected diagnostic source change inventory: ' + repr(changed))
    for path, data in derived.items():
        if (source / path).read_bytes() != data:
            raise ValueError('Derived source bytes changed during instrumentation')
    report['applied'] = True
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'kind': report['kind'], 'eclCommit': PIN,
                      'evidence': str(evidence), 'patchSha256': report['patchSha256'],
                      'productionAdmission': False, 'applied': True}))


if __name__ == '__main__':
    main()
