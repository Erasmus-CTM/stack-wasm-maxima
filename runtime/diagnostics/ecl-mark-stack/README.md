# ECL-only reproducer for `Unexpected mark stack overflow`

Plain ECL, without threads, aborts in a full collection when the C stack holds
enough distinct heap objects. No foreign code calls the collector: the fatal
push is ECL's own `GC_push_all` in `ecl_mark_env`, called from
`stacks_scanner`. Reproduced on unmodified upstream `develop`
(`ff5c6abbe73e3b3e95608e32721ce0be232c1987`, ECL 26.5.5) and on the pinned
Emscripten fork (`e4bdb2e5b1e444e1773032a53650773848f4d6cd`), native x86-64.
Both bundle the same collector marking code.

## Mechanism

In a build without threads, BDWGC's `GC_push_roots` pushes roots in this order:

1. static root sets, lazily;
2. the C stack, eagerly, because ECL disables interior pointers
   (`GC_push_all_stack_part_eager_sections`). Each pointerful object found is
   pushed. If the mark stack fills, `GC_signal_mark_stack_overflow` drops
   `GC_MARK_STACK_DISCARDS` (512) entries and pushing continues, which is
   recoverable. The top therefore ends anywhere in the last 512 slots;
3. `GC_push_other_roots`, which ECL sets to `stacks_scanner`. It makes 7 lazy
   `GC_push_all` calls on upstream (`ecl_core`, `cl_core`, `cl_symbols`, and
   the env's run, frs and bds stacks plus the env itself), or 6 on the fork,
   which has no `ecl_core`. `GC_push_all` aborts when the mark stack is full.

If step 2 leaves fewer free slots than step 3 needs, ECL aborts. BDWGC's own
comment before that call warns that "lots of stuff may have been pushed
already" when interior pointers are off. In a threaded build, BDWGC scans the
stacks inside the default `GC_push_other_roots`, which ECL calls *after* its
own pushes, so the stack is nearly empty when ECL pushes.

## Running it

```sh
sh run.sh /path/to/ecl compiled 3600 4700        # needs ECL's C compiler
sh run.sh /path/to/ecl interpreted 700 1500      # bytecode only
NOASLR=1 sh run.sh /path/to/ecl compiled 3600 4700
```

`run.sh` starts a fresh process per depth and lists the depths that abort.
`deep.lisp` keeps one fresh cons per compiled frame. `deep-bc.lisp` runs as
bytecode and recurses through `mapcar`, whose C frame holds fresh lists.
Address randomisation changes stale stack contents, so the aborting depths
move from run to run; `NOASLR=1` makes them repeatable. `occupancy.gdb` prints
the mark stack occupancy whenever `stacks_scanner` starts and gives the
backtrace at the abort.

## Results (native x86-64, 25 October 2026)

| ECL build | compiled, aborting depths (ASLR off) | interpreted 700–1300 | free slots when `stacks_scanner` starts |
|---|---|---|---|
| upstream, `--disable-threads` | 4031–4037 (7 consecutive) | 1006, 1134, 1262, 1263 | 6 at depth 4016 under gdb; 1024 at depth 3000 |
| fork, `--disable-threads` | 4030–4035 (6 consecutive) | not run | not measured |
| upstream with `eager-root-scanning.patch` | none (3990–4110) | none | n/a |
| upstream, `--enable-threads` | none (3990–4110) | none | about 4070 |

With ASLR on, compiled depths 3500–6000 (one run each) aborted 26 of 2501
times on the unmodified upstream build, about 1%, and never on the patched or
threaded builds.

The width of the window equals the number of lazy pushes in `stacks_scanner`.
With ASLR on, the unmodified build aborted at depth 4013 in one sweep and
completed at the same depth in three repeat runs. Under gdb the backtrace is
`GC_push_all` ← `ecl_mark_env` (`alloc_2.d:1175`) ← `stacks_scanner` ←
`GC_mark_some` ← `GC_try_to_collect_inner`. The patched build returns the
correct result at every depth tested.

The CI workflow `.github/workflows/ecl-mark-stack.yml` repeats all three
upstream builds on 64-bit and 32-bit. In
[run 40177761129](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40177761129)
both unmodified non-threaded builds aborted in both modes (32-bit: 13 compiled
depths in 3600–4700 and 11 interpreted depths in 700–1500). The threaded and
patched builds never aborted, on either width.

## Relation to the browser abort

This is not yet confirmed. The wasm target is consistent with the mechanism:
`aclocal.m4` forces `enable_threads='no'` for `wasm32-unknown-emscripten`, and
the target is compiled at `-O0` with Binaryen's `--spill-pointers` pass, which
writes pointer locals to the shadow stack that BDWGC scans eagerly. Loading
STACK runs deep Lisp call chains. With roughly 6 of 512 final positions fatal,
an overflowing collection has about a 1% chance of aborting. The mark stack
doubles after an overflow, so the risk falls once the runtime has grown it.
That matches an intermittent abort early in loading. Confirming it needs the
occupancy at `stacks_scanner` entry, or the abort backtrace, from the wasm
runtime.

## Fix options

- **Eager scanning of ECL's ranges** (`eager-root-scanning.patch`, rebased on
  `develop`): uses the public `GC_push_all_eager`, which marks and pushes
  objects one by one and recovers from overflow. The cost is that these
  ranges are treated like a stack: interior pointers into objects are
  accepted, whereas lazy scanning accepts only displacements 0 and 1. This
  can retain more memory and change finalization timing.
- **Registering the fixed ranges as static roots**: `ecl_core`, `cl_core` and
  `cl_symbols` could be added once with `GC_add_roots`, so they are pushed in
  step 1. This removes three of the seven lazy pushes, but the per-env stacks
  change size and remain, so on its own it only narrows the window.
- **Lazy while there is room, eager when nearly full**: BDWGC's internal
  `GC_push_all_stack` does this, but the public API has no way to read
  occupancy, so it would need a new BDWGC API.
