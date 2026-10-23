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
matrix. Generated outputs
from a prior attempt are rejected rather than reused.

The next opt-in candidate keeps the unchanged translation failure as a negative
control, then uses a temporary symbolic bridge for non-symbol assignment hooks
and Maxima's standard `packagefile` translation option. Translation restores every
original hook. The browser-target FAS includes a small dispatcher which calls the
target process's own original hooks; it does not serialize a host function or
change target assignment properties. Its source hash is retained in the opt-in
manifest. Generated entry Lisp must be complete and contain no translated-function
registration in `$props`. Native assignment/reset controls must pass in the same
build before cross-compilation is attempted. Pinned upstream files remain unchanged.

Native fixture evidence from run 39990740727 showed the ordinary reset function
being removed after a verified reset, while `packagefile` survived three resets
and collections. The symbolic assignment bridge produced readable complete Lisp.
The first behavior checker incorrectly used a Lisp catch for a deliberate Maxima
error under `--quit-on-error`; it is corrected to use Maxima's own `errcatch` and
still requires rejection, restoration and subsequent successful evaluation.
These observations do not validate a whole STACK bundle. Initial library version
must match the manifest; post-reset metadata is compared with the source control
because STACK reset can clear ordinary metadata variables.

The next opt-in candidate retains the unchanged translation failure as a negative
control, then temporarily substitutes symbolic assignment hooks and uses Maxima's
standard packagefile option. Translation restores every original property. A
small dispatcher compiled into the FAS invokes the target process's original
hook; target properties and pinned upstream files remain unchanged. Its source
hash is recorded in the opt-in manifest. Complete generated Lisp must contain no
translated-function registration in props. Native assignment/reset controls must
pass in the same build before attempting cross-compilation.

Run 39990740727 showed the ordinary reset function removed after a verified reset,
while packagefile survived three resets and collections. The symbolic bridge
produced complete readable Lisp. The first behavior checker used a Lisp catch
for a deliberate Maxima error under --quit-on-error; it now uses Maxima errcatch
and still requires rejection, restoration and recovery. A whole STACK bundle is
not validated. Initial version must match the manifest, while post-reset metadata
must match the source control because reset can clear ordinary metadata variables.
