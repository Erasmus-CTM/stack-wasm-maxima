# Precompiled STACK experiment

The separate `precompiled-browser.yml` diagnostic reuses two immutable, hash-verified
artifacts to test the browser harness without another compiler rebuild. Its source
and compiled trials share the accepted baseline runtime, with the entry FAS from
an older experiment build. The report records both identities and marks these
observations diagnostic-only. Actual compatibility and reset success still require
the browser run. These observations cannot satisfy the fresh current-head parity
gate or establish a precompiled speedup.

The first browser measurement (run 40005689823) failed during the source control's
first reset, before any compiled trial. The repaired harness executes the trusted
reset outside the dynamic question wrapper, then checks its return value and
removal of a disposable variable through a fresh evaluation. All three resets,
full collections, caught-error recovery and regrading remain required.

Frozen diagnostic run 40017911368 reached source readiness and the first reset,
but failed post-reset regrading with a generic CAS error before any compiled
trial. Subsequent diagnostics retain each reset operation and the underlying CAS
error, and attempt the remaining source/compiled samples after a failed sample.
Any failed sample keeps the diagnostic red. The fresh full probe still stops at
its first failed sample. Partial readiness observations cannot clear parity or
establish a precompiled speedup.

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

The full probe requires 22 official answer-test cases against source/native
controls at each of the two pinned STACK revisions. Each pin has its own
translation, ASDF system, bundle and build descriptor. The newer pin additionally
runs the existing 316-program rendered controller/graphical suite, with replay
against independent native Maxima and the same-source ECL build. The older pin
has 22-probe coverage, not 316-program controller coverage. The compiled manifest
is selected before native-page preparation; a source-only preparation cannot
satisfy that gate. The narrow eight-sample timing experiment runs before these
broader gates and cannot establish parity or a performance improvement itself.

`translate-and-cross-compile.sh --native-only STACK_CHECKOUT` runs the same
complete-entry translation controls and source-integrity checks without the
browser cross-build. The native workflow runs it at both pins. Default browser
mode selects the newer pin; `CTM_PRECOMPILED_STACK_PIN` admits only the two exact
pins and assigns separate fixed work directories. The parser bootstrap preserves
each pin's original declarations: 198 bytes at the newer pin, 265 at the older
pin, including its right-associativity declarations.

Staging requires `stackmaxima.fas.json`, produced beside the fresh bundle and
binding its bytes/hash to the exact pin, entry source, translated Lisp, bridge
and parser inputs. Source and compiled official-probe reports are separate.
Filesystem instrumentation records successful read-capable opens after mounting;
mounting writes and failed opens cannot prove selection. Normalized source-entry
opens are rejected. The controller gate binds every captured program and native
replay observation to the selected manifest and actual worker readiness. Raw
runtime files, descriptors and failure reports are retained for independent review.

The exact-head diagnostic run 39978116076 failed closed in both the isolated
`display2d:false` assignment fixture and the full entry translation. Its explicit
failure marker reports that an ECL compiled assignment hook cannot be printed
readably. It did not produce a validated bundle or timing comparison.

Validation retains a minimal translated-function control and compares ordinary
registration with Maxima's packagefile option. Three sentinel-verified resets and
full collections must demonstrate the ordinary removal hazard and package-mode
survival. Browser trials require three real STACK resets, acknowledged full GC,
caught error recovery, arithmetic and regrading. These feasibility checks do not
replace the full parity matrix. Retained generated outputs are rejected.

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


Full candidate run 39996509145 passed the same-build native fixtures but stopped
before cross-compilation: the adapter passed the compiled-hook print error,
then the reader reached `nounor` without its infix declaration. The retained
partial Lisp and logs show the original dependency loads being emitted rather
than executed by translation. No bundle or measurement was produced.

The next candidate retains that no-parser failure and bootstraps only the exact
198-byte noun-logic declaration block from pinned `assessment.mac` in the
translation process. The entire source hash, Git bytes, block bytes and offsets
are checked; upstream files and translator evaluation policy remain unchanged.
Native source/translated fixtures must verify precedence and explicit grouping.
Complete generated entry Lisp must retain the original assessment/logic runtime
loads. The manifest binds both the bridge and parser-bootstrap metadata. These
are further feasibility controls; full runtime parity and speedup remain unproved.
