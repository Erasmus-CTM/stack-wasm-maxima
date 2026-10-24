ECL root-scanner localization — UNEXECUTED diagnostic candidate

This directory is self-contained: one inert C library, one POSIX shell preparation
script, and one Lisp script for an installed, unmodified ECL. It needs neither
Python nor our application. No collector callback is installed, no direct libgc
function is called, and no collector size or algorithm is changed.

This is a test hypothesis, not a reproduced ECL defect. It has NOT been executed.
The diagnostic sub-agent was blocked by an automated possible-cybersecurity-risk
flag. Source inspection and preparation continued; no alternate execution route
was used. Existing PR13 CI is separate and continues normally.

Why test loaded libraries?

In the pristine pinned ECL fork e4bdb2e5b1e444e1773032a53650773848f4d6cd:
* src/c/ffi.d, si_load_foreign_module, opens the library and sets cblock.locked.
* src/c/ffi/libraries.d, ecl_library_open, retains open libraries in
  cl_core.libraries. Whether identical-path loads reuse the same block needs
  runtime confirmation; the same-library control tests that assumption.
* src/c/alloc_2.d, stacks_scanner, queues one GC_push_conditional(...,1) range
  for each locked library, followed by core/symbol/environment ranges.
* In bundled BDWGC8.2.8 mark.c, GC_push_all queues an additional descriptor and
  aborts at the current capacity. The default GC_push_conditional(...,1) path
  calls GC_push_all; PROC_VDB/auto-incremental configurations can differ.
* mark_rts.c, GC_push_roots, invokes GC_push_other_roots AFTER register/stack
  traversal and explicitly warns that the callback must handle possible overflow.

Thus many legitimately locked libraries offer a candidate route through ECL's
actual callback without a synthetic near-full prefill. Failure could occur first
in another subsystem (dynamic-library discovery, OS loader limits, etc.). A log
of Unexpected mark stack overflow alone is insufficient to identify ECL's call:
a debugger backtrace or collector/scanner entry instrumentation is required.

Suggested manual Linux procedure, AFTER reviewing these unexecuted files:

  sh prepare.sh /absolute/path/to/new-empty-name 4200
  ECL_ROOT_TEST_DIRECTORY=/absolute/path/to/new-empty-name \
    ECL_ROOT_TEST_COUNT=4200 ECL_ROOT_TEST_SAME_LIBRARY=1 \
    ecl -norc -shell load.lisp > same-library.log 2>&1
  ECL_ROOT_TEST_DIRECTORY=/absolute/path/to/new-empty-name \
    ECL_ROOT_TEST_COUNT=4200 ECL_ROOT_TEST_SAME_LIBRARY=0 \
    ecl -norc -shell load.lisp > distinct-libraries.log 2>&1

Use fresh processes. Limit core-file size if needed. Record exit codes as well as
stdout/stderr. Do not edit collector limits to force a desired result. Preserve
unmodified ECL as the control before testing any eager-scanning patch.

Next evidence required:
1. Confirm scripts run against the exact tested ECL, recording uname, distribution,
   compiler, ECL build/configuration, bundled collector and source revision.
2. Test small counts, the same-path control, then distinct libraries in fresh
   processes. Expected correct behavior: all requested loads and collections
   finish, or an ordinary reported loader/resource limit; no collector abort.
3. If an abort occurs, locate it with a debugger backtrace and inspect the current
   scanner range and mark-stack occupancy. Bisect the library count.
4. Compare pristine and target-only eager variants with identical inputs. Check
   broader conservative retention separately; a crash fix does not prove equal
   memory use/finalizer timing.
5. If this route does NOT reproduce, retain the negative result. Investigate
   pointerful C-stack pressure at callback entry separately. Do not call it proof
   that ECL cannot reach the state.

The older standalone BDWGC fixture only establishes the synthetic collector
mechanism. It does not execute the actual ECL scanner or prove the original
Wasm/browser abort's caller. These limitations still apply.

The ECL maintainer requests human-authored communication and patches. This is
AI-assisted research material for the reporter's review, not a reply to post or
an upstream-ready contribution.
