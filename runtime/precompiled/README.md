# Precompiled STACK experiment

This separate, opt-in experiment starts with the exact STACK source pin used
by the browser site and the accepted unoptimized Maxima/ECL build recipe. It
translates `stackmaxima.mac` using that build's native Maxima, then asks the
pinned ECL cross-compiler to produce a browser-target FAS bundle. The source
file, generated Lisp, bundle and compiler logs are retained with hashes.

This first gate checks translation and cross-compilation, then stages an opt-in
manifest that hash-checks and loads the entry FAS in a real browser worker.
It compares source and compiled startup, transfer and warm calls on the same
runner, and checks one native answer-test case. STACK dependencies referenced
by the translated entry module still load from source. This is an entry-only
compilation experiment, not a complete precompiled STACK distribution.

No speedup or broad parity is claimed from this narrow gate. Both STACK pins,
the full browser/native and same-source replays, forced-GC and error recovery,
graphical checks, and independent artifact review remain required before any
runtime selection. The shipped runtime and default source-loaded startup are
unchanged.

The exact-head diagnostic run 39978116076 failed closed in both the isolated
`display2d:false` assignment fixture and the full entry translation. Its explicit
failure marker reports that an ECL compiled assignment hook cannot be printed
readably. It did not produce a validated bundle or timing comparison.

The next validation retains a separate minimal translated-function fixture,
loads its generated Lisp in a fresh native process, and checks it after three
`kill(allbut[functions])` resets and full ECL collections. Failure blocks
cross-compilation. If a browser bundle becomes feasible, both source and compiled
trials must also survive three real STACK resets, forced collections, deliberate
caught errors, subsequent arithmetic and grading, and unchanged STACK version.
These are additional feasibility gates, not substitutes for the full parity
matrix. No adapter or translation workaround is selected here. Generated outputs
from a prior attempt are rejected rather than reused.
