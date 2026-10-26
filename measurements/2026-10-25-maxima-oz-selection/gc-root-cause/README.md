# Source validation failure: collector-invisible pointers

Date: 25 October 2026. Diagnostic evidence for the blocker described in
`../VALIDATION-INVESTIGATION.md`. Raw results: `stress-results.json`.

## Confirmed

- **The failure is a garbage-collector use-after-free in the Wasm runtime.**
  Raising Boehm GC frequency with `GC_FREE_SPACE_DIVISOR=1000` makes a local
  cold build of the candidate fail the exact captured validation ([1,1]
  against [2,2]) in 11 of 750 iterations (three runs), at the same step as the
  CI failures: inside `stack_validate`, after the `ATList_wrongentries` note.
  The errors are corrupted heap structure, not one fixed Lisp bug: `CAR` of
  `SUBR`, of `#\,`, of `$EX`, of `1`; `BOUNDP` of `(MLIST SIMP)` and of a
  source-located `MCOND` form header; once an ordinary-looking Maxima error,
  `assignment: cannot assign to (false)`.
- **The cause is Binaryen's spill pass, not STACK, Maxima, the PythonChecker or
  the error boundary.** ECL configures every target link with
  `BINARYEN_EXTRA_PASSES=--spill-pointers`, the only way pointers held in Wasm
  locals become visible to Boehm GC on Emscripten (bdwgc scans neither static
  data, `DATASTART == DATAEND`, nor Wasm locals). In the exact pinned Binaryen
  (`version_123-168-g8c82b6884`), `SpillPointers` spills only pointer locals
  live after a call. A call result waiting on the Wasm value stack as an
  earlier operand of an enclosing call, `g(f(), h())`, is never spilled; a
  collection inside `h()` can free `f()`'s result. Post-processing the same
  built modules with `--flatten` before `--spill-pointers` (flattening moves
  every such value into a local) removed every failure: 0 of 600 iterations
  with a comparable collection count (6,483 versus 3,715 per 300). Only the
  post-processed modules were fetched during that run.
- **Maxima's own interrupt finalizer is not the cause.** The Wasm port re-arms
  a finalizer on every collection (`ecl-port.lisp`, `init-cl.lisp`). Disabling
  the re-arm still failed 5 of 300. Native ECL with threads disabled at the
  same pins ran the program 3,000 times under heavy collection (6,362
  finalizer runs) without failure, with and without the finalizer.
- **Production `ecl-oz` did not fail on this path**: 0 of 1,200 iterations
  and about 17,000 collections (divisors 1000 and 5000). It differs from the
  candidate only in Maxima's generated C (`-O2` instead of `-Oz`), so the
  exposed call sites on this path come from Maxima compiled at `-Oz`.
- **The previous catch-all converted heap corruption into learner-invalid.**
  It concealed the fault but did not cause it.

## Why passing reruns were not evidence

ECL's `get-internal-real-time` measures microseconds since start; Maxima reads
it around every toplevel input. On wasm32 the value exceeds a fixnum after
about 537 seconds and is allocated as a bignum, so wall time changes allocation
and therefore when collections happen. Identical CAS histories can still differ
in collection points. Collections forced between calls, as in the previous
stress runs, never meet a pointer in flight.

## Hypotheses, not established

- That `-Oz` exposes more value-stack temporaries than `-O2` is consistent with
  the profiles' results but was not measured by static counting.
- Production `ecl-oz` uses the same incomplete spill pass for its `-Oz` ECL
  core and `-O2` Maxima code. No failure was observed; a latent hazard on
  other paths is not excluded.

## Repair

The candidate profile selects the complete pass list with `gcSpillPasses`
(`flatten,spill-pointers,simplify-locals-notee-nostructure,vacuum,
coalesce-locals,reorder-locals`). It reaches every Emscripten invocation through
the existing profile-injected `EMCC_CFLAGS`, after upstream ECL's own setting,
so upstream configure is unchanged. Compiler evidence requires, for every
delivered target, an executed `wasm-opt` with this exact contiguous sequence
after the optimization passes and no other spill pass. The simplification
passes after spilling only reduce local counts (V8 rejects a flattened function
with more than 50,000 locals); spill stores are memory writes placed before each
call and are not removed or reordered.

Independently, validation now distinguishes learner-domain errors (Maxima errors
and Lisp arithmetic errors, such as 1/0, stay invalid without restarting) from
internal Lisp faults, which fail the request so the session's existing
poison/restart path discards the worker. This boundary cannot detect every
corruption (one surfaced as an ordinary Maxima error); the pass list is the
repair.

## Regressions

- `runtime/build/test-compiler-evidence.py` and
  `runtime/precompiled/test-stack-compiler-evidence.py`: plain, reordered,
  incomplete, re-optimized or duplicated spill passes are rejected per target.
- `scripts/milestone-three/test-validation-boundary.py`: real native Maxima
  (packaged and same-source ECL) keeps 1/0 invalid and fails a Lisp type error
  as an internal fault.
- `scripts/milestone-three/gc-stress.mjs`: the built Wasm runtime replays the
  exact validation 400 times and all 316 captured programs once under
  `GC_FREE_SPACE_DIVISOR=1000`, in both the compiled and source-loaded phases;
  `runtime/build/stack_acceptance.py` requires zero deviations. On the unfixed
  candidate the harness failed at iteration 225 of 300; on the post-processed
  build it passed 300 of 300.
