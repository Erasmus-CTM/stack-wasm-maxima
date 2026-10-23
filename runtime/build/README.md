This draft compiler experiment is described in [COMPILER-EXPERIMENTS.md](COMPILER-EXPERIMENTS.md).
Its scoped ECL flags are experimental; the preceding no-gnuplot report below
describes the parent configuration. No optimized runtime has been accepted.

# Owned Maxima/ECL runtime: first step-2 change

AC's 23 October decision removes external gnuplot completely before compiler
optimization or any other trim. This branch removes its source pin/archive,
source checkout, build/bootstrap commands, delivered library, plot module and
the old derived Makefile patch/applicator. The pending upstream patch offer is
closed because that patch is no longer carried. Historical failed runs remain
available; no old evidence is presented as a result of this configuration.

Maxima, ECL, Emscripten, SDK archives, both STACK revisions and notices remain
exactly pinned. `pins.json` has no gnuplot source and no build patch. Original
Maxima/ECL mathematical sources and STACK sources are unchanged.

## Build and artifact

The unchanged upstream Makefile builds native ECL32, native Maxima, cross ECL,
main Wasm, share/index and loader files. Its optional-module targets impose an
artificial plot prerequisite. Their actual ASDF systems depend only on
`maxima/core`, so `build.sh` invokes the pinned upstream
`cross-compile-maxima-module` directly for the eight nonplot modules and copies
the resulting Wasm bundles. It creates no placeholder plot target and changes
no upstream recipe. Browser plot/gnuplot outputs and external source/archive
paths must be absent.

Two jobs run on independent fresh Ubuntu hosted runners without source, SDK,
host or ccache restores. Each rebuilds the native host, records the installed
host SHA-256 before using it for cross compilation, and verifies it again.
Bootstrap ECL necessarily executes during its own build. Environment evidence
records runner image/kernel and `dpkg-query -W` versions. This is observation,
not a fully pinned release environment. SDK binary archives are still verified
before extraction and execution.

Every artifact includes the current 79-file closure, original source archives,
unchanged notices, original Makefile and current orchestration recipe, hashes,
logs and manifests. The old site's notice is labelled historical site context;
the active licence bundle omits the unused gnuplot text. The comparison job
checks actual runtime bytes from both successful cold builds. Its report states
either byte-reproducible runtime or rebuildable with equivalent behaviour and
lists every differing file. Successful compilation alone is never acceptance.

## Plot capability and acceptance

A hash-pinned startup adapter replaces ECL's plot autoload functions before
unchanged STACK startup. The five plot-option names used by both STACK loaders
are accepted as no-ops. Other plotting operations produce
`CTM plotting unavailable; use JSXGraph.` Current candidate admission requires
this exact configuration, adapter and closure; stale omitted files are rejected.
An actual authored XML question with a plot assignment goes through the normal
XML compiler and real Wasm build preparation and must fail with its question ID
and that actionable diagnostic. No regex-based function-name admission is added.
Direct plot calls and STACK `plot()` must produce the same diagnostic and leave
a subsequent caught-error/success path usable in that worker.

Each cold build retains all 22 probes at both STACK pins, native browser checks
and both independent/same-source native replays of exactly 316 captured programs
with zero unaccepted differences. The default/published runtime is unchanged.
No module besides plotting is removed. Compiler flags and conservative-GC
spill-pointers are unchanged; compiler optimization follows in a separate PR.

## Measurements and comparator isolation

The old fully validated owned build is frozen by exact manifest/artifact hashes
and original pins in `baseline.json`. Every manifested byte and its acceptance
record are checked. Only the explicit comparator staging option admits that
historical pin set; current candidates must match current pins/configuration.

Two alternating-order trials on each runner compare deployed, historical owned
and current runtimes under the same gzip-6 local server policy. Every trial
records a fresh profile and a page reload in the same profile/context and live
origin with a new worker/session. Reload request deltas/readiness are separate
from warm calls. Real captured native-rational prepare/validate/PRT programs
and simple call controls retain result equality checks. A retained-object/forced
GC smoke is additional evidence; Wasm linear-memory capacity is not live heap.
No internet-performance or statistical speed claim follows from these trials.

`measure-pages.mjs` independently observes the public Pages preview's actual
response encodings and encoded body sizes for .wasm/.so/.fas. Pages' own
automatic compression is distinct from the tested CTM sidecar negotiation,
which is a server/offline policy and is not deployed by this PR. No page,
frontend, hosting, tag or release is published. AC merges and creates tags.

## Retained historical build failures

Step-1 runs 39863489271 (Windows/LF archive mismatch), 39865240495 (missing
libtool bootstrap file), 39865663672 (gnuplot cross host), and 39868037264
(gnuplot shared-library emission) remain diagnostic history. The final historical
owned build was 39870918765. The removed patch solved those old gnuplot failures;
this configuration avoids that external dependency entirely.

PWA delivery is a later production task: a service worker with versioned asset
caching can avoid repeat transfers during semester reuse. A new Maxima worker
still performs startup, measured separately by the warm-profile reload samples.
This build change does not implement PWA caching.

Focused run 39920599300 stopped before compilation when the strict Git-blob
source check caught upstream libffi `eol=crlf` checkout conversion. Source
preparation now disables text conversion only in repository-local Git metadata
for Maxima/ECL compilation checkouts. Canonical archive generation temporarily
omits that override, preserving the original archive policy and pinned hashes.
The fixture reproduces forced CRLF checkout and verifies both exact working
blob bytes and unchanged canonical archives. The failed run is retained.

Run 39921294914 completed both no-gnuplot builds and packaging, then stopped
at the unchanged STACK version gate. Retained-runtime browser A/B diagnosis
found the adapter's leading Maxima comment prevented `:lisp` command dispatch;
removing that exposed an unquoted `$done` Lisp return. The corrected adapter
starts directly with `:lisp`, retains SPDX inside a Lisp block comment, and
returns the quoted Maxima atom. Local diagnosis confirmed exact STACK version
2026101500 plus all four plot diagnostics and same-worker success afterward.
That local diagnosis is not the required fresh cold-build parity acceptance.
The timing-only forced-GC helper also returns the quoted atom. The actual
generated timing worker passed local diagnosis with all 100 full-GC checks,
retained and temporary objects, deliberate CAS error recovery and four plot
diagnostics. Captured native programs and cold/reload measurements still await
the fresh CI run; local diagnostic timings are not reported as performance.
