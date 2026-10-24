# Possible mark-stack overflow from lazy root-range pushes in ECL's BDWGC callbacks

We found a reproducible collector API hazard while investigating an `Unexpected mark stack overflow` abort in an ECL/Maxima WebAssembly application. I would appreciate advice on whether ECL's root callbacks should use eager range scanning, or a different collector-compatible approach.

The evidence below separates an isolated collector reproducer from the original application failure: we have not established which callback caused that particular browser abort.

## Tested versions and upstream source check

- ECL Emscripten fork: https://gitlab.com/mgerbershagen/ecl
- Exact tested revision: `e4bdb2e5b1e444e1773032a53650773848f4d6cd` (reports ECL 26.3.27).
- Unmodified bundled BDWGC 8.2.8, `src/bdwgc`.
- Reproducer tested on Linux, native 32-bit and 64-bit; collector threads and parallel marking disabled, GC assertions enabled.
- Full collections tested with incremental mode both disabled and enabled. This does not test mutations between incremental marking steps.

I also checked upstream `develop` at `ff5c6abbe73e3b3e95608e32721ce0be232c1987`. `ecl_mark_env` and `stacks_scanner` still use the lazy range-push pattern:
https://gitlab.com/embeddable-common-lisp/ecl/-/blob/ff5c6abbe73e3b3e95608e32721ce0be232c1987/src/c/alloc_2.d

That is a source inspection only; the reproducer below is pinned to the tested fork and its bundled collector, not a completed build of current upstream ECL.

## Observed behavior

The fixture installs an ECL-style root callback and uses real `GC_push_all` calls on valid zero-containing ranges to leave two mark-stack entries free. Additional lazy range pushes then terminate the process with SIGABRT and:

```text
Unexpected mark stack overflow
```

The observed initial capacity is 4096 entries; the callback reaches the test precondition at 4094 used entries. This is deliberate near-full stress, not a claim that ordinary ECL workloads always reach this state.

Using `GC_push_all_eager` for the modeled ECL-owned ranges, with the synthetic previous callback also scanning eagerly, preserves the required atomic referents without increasing mark-stack capacity. Separate pointerful graph cases exercise ordinary collector overflow recovery and retain their roots as the collector grows its worklist through its unchanged recovery algorithm.

The fixture follows ECL's `GC_set_all_interior_pointers(0)` plus registered displacement one. Root-survival, withdrawn-root, unlocked-block, transitive-child and previous-callback controls are included.

## Reproducer

Requirements: Linux, Python 3, GCC and GNU make; a working multilib C toolchain for the 32-bit run. Outputs must be new directories outside the collector source tree.

```sh
git clone https://github.com/Erasmus-CTM/stack-wasm-maxima.git stack-root-regression
git -C stack-root-regression checkout 35a668be94898c300392863e4e98cb895a104b1e

git clone https://gitlab.com/mgerbershagen/ecl.git ecl-root-test
git -C ecl-root-test checkout e4bdb2e5b1e444e1773032a53650773848f4d6cd

python3 stack-root-regression/runtime/diagnostics/gc-root-regression.py \
  --source "$PWD/ecl-root-test/src/bdwgc" \
  --output "$PWD/gc-root-evidence64" --bits 64

python3 stack-root-regression/runtime/diagnostics/gc-root-regression.py \
  --source "$PWD/ecl-root-test/src/bdwgc" \
  --output "$PWD/gc-root-evidence32" --bits 32
```

The driver builds the original collector, verifies its complete source-tree identity before and after testing, and retains `report.json` plus every command's stdout/stderr. It uses private collector headers to observe occupancy; it does not modify collector code, mark-stack limits or its growth algorithm.

There are 16 cases per width. The expected lazy-scanner and unchanged-lazy-previous-callback aborts are negative controls, so a successful overall report still includes those expected SIGABRT outcomes.

- C fixture: https://github.com/Erasmus-CTM/stack-wasm-maxima/blob/35a668be94898c300392863e4e98cb895a104b1e/runtime/diagnostics/gc-root-regression.c
- Driver: https://github.com/Erasmus-CTM/stack-wasm-maxima/blob/35a668be94898c300392863e4e98cb895a104b1e/runtime/diagnostics/gc-root-regression.py
- Fixture documentation: https://github.com/Erasmus-CTM/stack-wasm-maxima/blob/35a668be94898c300392863e4e98cb895a104b1e/runtime/diagnostics/gc-root-regression.md
- Passing 32/64-bit CI: https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40079456120

## Proposed downstream change

In the pinned fork's `src/c/alloc_2.d`, we replaced seven `GC_push_all` calls and one locked-cblock `GC_push_conditional(..., 1)` call in `ecl_mark_env`/`stacks_scanner` with `GC_push_all_eager`.

The patch preserves range bounds, null guards, the locked-cblock mark-bit operation, and the previous root callback. It does not increase stack sizes or change BDWGC itself.

Patch: https://github.com/Erasmus-CTM/stack-wasm-maxima/blob/35a668be94898c300392863e4e98cb895a104b1e/runtime/build/patches/ecl-root-scanner.patch

This patch is against our pinned fork. Current upstream has an additional `ecl_core` root range, so it should be reviewed and adapted rather than applied blindly.

## Limits and questions

- The standalone fixture models the callback pattern; it does not execute ECL's actual scanner or prove the original browser abort's caller.
- An unchanged previous callback that makes excessive lazy pushes can still abort. Fixing ECL-owned ranges does not protect arbitrary chained callbacks.
- Eager scanning retains an otherwise unregistered interior-pointer control that lazy scanning rejects. Equivalent retention, memory usage and finalizer timing are not established.
- Native 32/64-bit results are not themselves Wasm32 validation.

Is eager scanning appropriate for these ECL root ranges, including locked cblocks? If broader conservative retention is undesirable, what root-pushing strategy would you recommend under near-full mark-stack pressure?
