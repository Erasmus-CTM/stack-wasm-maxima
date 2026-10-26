# Why the first positive grade changes by about tenfold

The speedup is a real first-use runtime effect, dominated by Emscripten's generated
JavaScript filesystem error path. It is not evidence that algebra or warmed
STACK grading becomes ten times faster.

The `ecl-oz` control compiles generated Maxima C at `-O2`, but its delivered
`maxima.js` contains the assertions-enabled `ErrnoError` class: it extends
JavaScript `Error`, calls `super(runtimeInitialized ? strError(errno) : '')`,
and searches `ERRNO_CODES` for the symbolic code. The candidate's admitted
`maxima.js` instead contains:

```js
ErrnoError:class{name="ErrnoError";constructor(errno){this.errno=errno}}
```

This is an ordinary compiler output difference. `EMCC_CFLAGS=-Oz` reaches the
final Maxima Emscripten link as well as compilation. At the pinned Emscripten
commit, [optimized links default ASSERTIONS to zero](https://github.com/emscripten-core/emscripten/blob/b7dc6e5747465580df5984e723b9d1f10d8e804b/tools/link.py#L695),
and [`libfs.js` selects these two constructor forms with ASSERTIONS](https://github.com/emscripten-core/emscripten/blob/b7dc6e5747465580df5984e723b9d1f10d8e804b/src/lib/libfs.js#L63).
The profile therefore includes optimized JS glue and the usual optimized-link
diagnostic defaults, alongside the generated-C optimization change. It is not
a change confined to the mathematical C routines.

A separate, calibrated [CPU capture](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40171592095)
recorded three cold and three reload first grades for each profile. In all six
control samples, the `ErrnoError` leaf accounts for about 2.05–2.10 seconds of
an instrumented 2.40–2.46-second first grade. In the candidate it is below the
retained top-80 leaf frames (less than 0.6 ms in each sample); those grades take
0.26–0.32 seconds under profiling. Most of the large first-grade difference is
thus located in that assertions-only error-construction path. This does not
separate the costs of message resolution, Error construction and symbolic-code
lookup; it does not claim that stack capture alone explains the gap.

The separate [LOAD/V8 diagnostic](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40169523214)
passed all 12 complete source-runtime samples. Both profiles load `genut.mac`
during the first positive grade: roughly 0.10–0.16 seconds in the control and
0.03 seconds in the candidate. V8 baseline-tier Wasm compilation during that grade is
about 2.4–2.6 ms on cold loads, and absent on reloads, for both profiles. An
O2-only lazy Wasm module load or compilation pause does not explain the gap.

The profiler was enabled only around the first positive grade, after the same
first logical check. Clock synchronization is independently checked against
Chrome's `Performance.Timestamp`. Profile chunks are associated by process and
profile ID, since their emitting thread differs from the sampled thread. The
waiting parent `assess` frame and idle main thread are not added to CAS execution.
These sampled wall weights are diagnostic, not additive CPU-time measurements.
The initial full-session CPU capture lacked a retained clock marker and was
excluded from phase attribution.

[First-grade evidence](first-grade-cause.json) retains the exact admitted loader
hashes and constructor snippets, all 12 CPU observations, all 12 LOAD observations,
clock records and source references. The extraction read the loaders as data
and checked their hashes against artifact admission. Diagnostic edits are not
part of the production change. Performance estimates come from the separate
uninstrumented-by-TRACE/CPU n10 selection, not these diagnostic timings; its
shared startup stdout guard is documented with that selection.
