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

## Wasm target

The same abort occurs in ECL alone built for `wasm32-unknown-emscripten`.
`aclocal.m4` forces `enable_threads='no'` for that target and compiles it at
`-O0` with Binaryen's `--spill-pointers` pass, which writes pointer locals to
the shadow stack that BDWGC scans eagerly.

Build used (25 October 2026): the pinned fork with `upstream-bundle/root-occupancy.patch`, a
diagnostic-only line that prints the free mark stack slots just before
`GC_push_other_roots` and changes nothing else. emsdk 4.0.10 and a 32-bit host
ECL built from the same commit, configured exactly as the Maxima port's
`wasm/Makefile` does, with `--profiling-funcs` added to `LDFLAGS` for function
names in traces:

```sh
ECL_TO_RUN=/path/to/host32/bin/ecl CFLAGS="-O0 -DECLDIR='' -Wno-macro-redefined" \
LDFLAGS="-sINITIAL_MEMORY=134217728 -sALLOW_MEMORY_GROWTH -sSTACK_OVERFLOW_CHECK=0 -sEXPORTED_RUNTIME_METHODS=dynCall --profiling-funcs" \
emconfigure ./configure --host=wasm32-unknown-emscripten --build=x86_64-pc-linux-gnu \
  --with-cross-config=$PWD/src/util/wasm32-unknown-emscripten.cross_config \
  --with-tcp=no --with-cmp=no --with-bytecmp=builtin --with-asdf=no
emmake make && cp build/libecl.so build/bin/
sh upstream-bundle/run-wasm.sh build/bin 200 440
```

The wasm ECL has no C compiler, and `deep-bc.lisp` exhausts ECL's 32 MB C stack
limit (about 440 levels, roughly 70 KB per level) before it fills the mark
stack. `upstream-bundle/deep-wasm.lisp` recurses through `map` instead and leaves about 16
pointers per level. Under Node 22 it aborted at depths 234, 268, 302, 336,
370, 404 and 438 out of 200–440. That is exactly every 34 levels, repeatably,
since wasm has no address randomisation. The other 234 depths returned the
correct sum. At depth 234, ECL's callback started with 4 free slots, and
the trace is:

```text
Unexpected mark stack overflow
RuntimeError: Aborted(native code called abort())
    at libecl.so.GC_push_all
    at libecl.so.ecl_mark_env
    at libecl.so.stacks_scanner
    at libecl.so.GC_push_roots
    at libecl.so.GC_mark_some
    at libecl.so.GC_stopped_mark
    at libecl.so.GC_try_to_collect_inner
```

This shows the hazard on the target the Maxima runtime uses. It does not prove
that the earlier browser abort while loading STACK came from this path, but
it matches: deep call chains during loading, an intermittent abort (about 1%
per overflowing collection), and a risk that falls once the mark stack has
grown.

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
