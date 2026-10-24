# Precompiled STACK experiment

The full fresh-build workflow now tests both `baseline` and `ecl-oz`. The latter
selects the existing scoped `EMCC_CFLAGS=-Oz` ECL experiment; Maxima compilation
flags remain unchanged. Each profile independently builds its runtime and both
entry bundles, then runs the same strict source/compiled timing and full parity
gates. Artifacts include the profile in their names. Source and compiled timings
within a profile share one runtime build and runner; different matrix runners
must not be treated as a controlled baseline-versus-Oz timing comparison. This
does not change the shipped runtime or establish an optimized precompiled speedup.

## Full session restart contract

The browser benchmark validates the product's supported **full session restart**:
terminate the old `MaximaSession` and create a new session with a fresh CAS worker
and three new shared buffers. Each of eight cold/reload trials performs three
sequential restarts: 32 CAS initializations and 24 separately reported restart
costs. Inner restarts keep the page/profile and warm HTTP caches. The next page
reload follows four initializations, so its cache history differs from earlier
single-initialization reports. `lifecycleEncodedBodyBytes` sums server-accounted
response-body bytes over the whole trial. The server records queued bodies before
response finish, so this total does not prove completed wire transfer and is not
an initial-startup transfer measurement.
A short frozen diagnostic can select one cold trial per loading mode (eight
initializations) only with explicit diagnostic provenance. That abbreviated run
cannot clear the fresh-build 8-trial/32-initialization matrix or timing claims.

Every generation verifies its complete manifest hash, pinned Maxima/STACK versions,
and the actual compiled-entry hash/mount/read with zero source-entry reads. Restart
checks prove old variable, private-function, property and assumption state is gone,
that the terminated session rejects calls, and that the worker/buffers are distinct.
Pinned library defaults and ten semantic checks must succeed in all 32
initializations (320 results). The first checks captured logical validation before
warm calls, grading or other semantic work can consume a once-only warning. The
previous nine noun, parser, ±, direct-call and display checks remain unchanged.
These checks run after initialization and do not enter readiness timing.
Three full GC/error/arithmetic/regrading checks remain
mandatory. A bounded lifecycle watchdog retains partial progress. No library
functions/defaults are restored, no builtin tables are resnapshotted, and no source
fallback repairs a compiled session.

This explicitly corrects the earlier assistant-added whole-STACK same-worker raw
`stack_reset` acceptance gate. At the exact upstream pin,
[`cassession2.class.php`](https://github.com/maths/moodle-qtype_stack/blob/33383047af39c204bf4442802a058f8b918b2b1b/stack/cas/cassession2.class.php)
assumes the CAS process is not reused, and
[`connector.linux.class.php`](https://github.com/maths/moodle-qtype_stack/blob/33383047af39c204bf4442802a058f8b918b2b1b/stack/cas/connector.linux.class.php)
starts a process and quits after the call. The browser backend reuses healthy
sessions and replaces poisoned sessions; it has no raw reset API. Restart testing
does not mean every question gets a new process and does not resolve general
healthy-session per-question isolation (the existing F11 follow-up).

**Raw same-worker reset remains unresolved.** Failed run 40022723472 and frozen
artifacts 12532734569/12535530715 retain the original recursion/helper-removal
failures. Artifact 12536206985 adds the seven-helper experiment: all eight
first raw resets/GC/error checks complete, but `FORBIDDEN_SYMBOLS_SET` is lost,
noun equivalence changes, ± replacement/unary rewriting fail, and regrading fails.
Parser shape and TeX display still pass in those observations; matching failures
are not parity. Every pre-reset semantic check succeeds in both loading modes.
Temporary diagnostic PR #19 tests narrow registration experiments;
these are not production changes and must never merge. The raw collector below
remains diagnostic evidence, not a replacement for restart or full parity gates.
Native translated-function fixtures still require three genuine same-worker raw
resets/full collections to demonstrate packagefile survival. Every both-pin22,
newer-pin316/controller/graphical, independent-native and same-source replay gate
remains required, followed by independent Astra artifact reviews. No precompiled
speedup is established.

## Earlier raw reset diagnostics

The manually dispatched frozen browser workflow collects reset-isolation evidence from
fresh source/compiled sessions. It compares the unchanged original reset before
grading with a hash-bound marked diagnostic copy before/after grading. Markers
identify whether `kill` returns and which later statement is reached. A successful
collector exit only means evidence collection finished; copied-body observations
cannot satisfy the real reset or full parity gates.

The separate `precompiled-browser.yml` diagnostic reuses two immutable, hash-verified
artifacts to test the browser harness without another compiler rebuild. It is
`workflow_dispatch` only and does not run automatically on pull requests. Fixed
artifacts expire; missing or expired inputs intentionally fail provenance checks.
Use the fresh full workflow for acceptance. The diagnostic's source
and compiled trials share the accepted baseline runtime, with the entry FAS from
an older experiment build. The report records both identities and marks these
observations diagnostic-only. Actual compatibility and reset success still require
the browser run. These observations cannot satisfy the fresh current-head parity
gate or establish a precompiled speedup.

The first browser measurement (run 40005689823) failed during the source control's
first reset, before any compiled trial. The later repaired raw-reset harness executed the trusted
reset outside the dynamic question wrapper, then checked its return value and
removal of a disposable variable through a fresh evaluation. That experiment required three raw resets,
full collections, caught-error recovery and regrading; it failed as recorded below.

Frozen diagnostic run 40017911368 reached source readiness and the first reset,
but failed post-reset regrading with a generic CAS error before any compiled
trial. Subsequent raw-reset diagnostics retained each reset operation and the underlying CAS
error, and attempted the remaining source/compiled samples after a failed sample.
Any failed sample kept that diagnostic red. The fresh full probe still stops at
its first failed sample. Partial readiness observations cannot clear parity or
establish a precompiled speedup.

Frozen run 40018888353 produced eight diagnostic startup observations. Cold
source readiness was 36.15/37.81 seconds and entry-FAS readiness 39.25/39.26;
same-profile reloads were 36.56/36.59 and 38.06/38.29 seconds respectively.
Initial grading passed in all samples; all compiled samples opened the FAS once
and the source entry zero times. Every sample failed its first reset acknowledgment.
Independent Astra verified the complete report/provenance/runtime evidence; these
failed, separately built inputs establish neither parity nor a speedup.
The subsequent diagnostic separated the raw reset return, sentinel state and error text
using a top-level error catch, without restoring variables or reloading libraries.

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
binding its bytes/hash to the exact pin, entry source, translated Lisp, bridge,
translation-process adapter and parser inputs. Source and compiled official-probe reports are separate.
Fresh bundles require descriptor schema 2; historical frozen diagnostic inputs
retain their original provenance and cannot satisfy fresh staging.
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
survival. Browser trials now require three full session restarts, acknowledged
full GC, caught error recovery, arithmetic and regrading, as defined above. These feasibility checks do not
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
These observations do not validate a whole STACK bundle. Library version must match the manifest after every full session initialization.
Historical raw-reset metadata comparison did not establish preserved library state.


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

Run 40035963125 passed the full startup/restart measurement but failed controller
parity: the valid list `[2*x,2]` triggered an untranslated-function warning from
a compiled `texcolor` call, contaminating the validator's captured output. Native
replay confirmed the validation difference. This is independent of raw reset.

The translation-process adapter now delegates calls to `texcolor`,
`texcolorplain` and `nounor` to Maxima's standard `apply` translator, with the original
operator quoted. Arguments still translate normally; ordinary function lookup
and dynamic author aliases retain their runtime behavior. All three temporary
translation properties are restored, including their original absence, after
success or failure. No warning filtering or validation relaxation is used.
Native fixtures must demonstrate the warning in a fresh control process and
require silent source/compiled parity for ordinary constructors and dynamic
bindings. Their printer check uses the four exact colour-printer forms from
hash-verified `stacktex.lisp`; full STACK rendering remains a browser gate.
The exact adapter bytes are bound to each fresh bundle. These checks
supplement the full controller, both-pin official-probe and lifecycle gates;
they establish no precompiled speedup on their own.

Fresh full-startup diagnostic run 40048884292 exposed a separate logical
validation regression in the colour-fixed candidate. The student expression
`(x#0) nounand (x<2)`, compared with
`(x<0) nounor ((x>0) nounand (x<2))`, validates silently from source. The translated
`stack_noteq_single_remove` called `nounor` through `mfunction-call`, printed an
undefined-function warning and made the same validation invalid. Simple
non-equality cases did not expose this branch. Direct removal and solver probes
preserved their mathematical values but also printed the warning. The diagnostic
used twelve fresh processes; its successful collection status did not mean parity.

The scoped apply adapter covers this one additional constructor. Full native
entry checks at both pins must compare fresh source/translated startup, direct
calls and actual captured validation, and execute the exact new browser protocol
expression. The browser matrix repeats the logical first-call check in every
initialization. Warning history is never cleared and unrelated warnings remain
enabled. These native checks supplement actual Wasm/FAS selection, full controller
and official-probe parity; they do not establish whole-library raw reset or speedup.
