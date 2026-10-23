# Scoped ECL compiler experiments â€” local draft

This experiment is stacked on [PR9](https://github.com/Erasmus-CTM/stack-wasm-maxima/pull/9),
whose two cold builds and independent artifact review passed in
[run 39926639402](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39926639402).
Full compiler-experiment CI and independent review are pending. There is no
measured optimization benefit and no selected replacement runtime.

The capability inventory, source pins, mathematical sources, STACK sources,
startup adapter and Lisp optimization policy stay the same for all profiles.
The unchanged upstream Makefile's standalone `ecl-emscripten` target receives
`EMCC_CFLAGS` only in its own subprocess. The override is unset before compiling
Maxima main and all eight optional modules. No ECL configure patch is carried.

| Profile | Injected ECL target flags | Actual ECL core C expected | Actual generated ECL Lisp C expected | Actual generated Maxima C expected |
|---|---|---|---|---|
| baseline | none | `-O0` | `-O2` | `-O2` |
| ecl-oz | `-Oz` | `-Oz` | `-Oz` | `-O2` |
| ecl-o2 | `-O2` | `-O2` | `-O2` | `-O2` |

ECL's pinned wasm32 configuration intentionally appends `-O0`: its source
comment says nonzero levels seemed slower with Binaryen's spill-pointers pass.
Both candidates can therefore regress. The injection also affects ECL target
link invocations; this is an ECL target experiment, not a claim that every Wasm
component uses one optimization level. Original configure flags and installed
target-info remain unchanged and are preserved alongside the effective traces.

`EMCC_VERBOSE=1` records actual clang and wasm-opt subprocess commands without
debug mode's large retained temporary trees. `VERBOSE=1` exposes ECL core make
commands. Separate ECL and Maxima phase logs distinguish raw make/emcc argv
from effective clang flags after Emscripten appends `EMCC_CFLAGS`. Acceptance
derives its claims again from manifested snapshots, checks the installed
target-info bytes, all four named GC link fields, target links' stack/spill
settings, actual spill-pass execution, ECL core/generated-Lisp clang flags and
all observed generated Maxima unit flags. Missing evidence fails the trial.

Every cold profile retains the complete 22 probes at both STACK pins, native
browser 316, independent and same-source native replays with zero unaccepted
results, authored plot build diagnostic, direct plot diagnostics, warm reload
and the 100-call forced-GC/live-object/error-recovery smoke. Failed jobs retain
their logs and artifacts; the matrix does not cancel the other profiles and
never silently substitutes baseline flags.

After all three jobs pass, a separate runner verifies every delivered byte,
current source pins, exact current recipe inventory/bytes, compiler evidence,
acceptance hash binding, same run/attempt/head and exact native workload before
staging any comparison. It then measures all three accepted runtimes on that
same machine using the identical worker, gzip-6 policy, alternating trials and
cold/reload separation. Reports retain actual encodings/transfer bytes and
decoded runtime sizes. OS/process/filesystem warming remains uncontrolled;
two samples per mode are observations, not a statistical claim. Regressions
remain visible and no profile is promoted automatically.

The prior no-gnuplot PR owns its two-cold-build reproducibility report: ten
binaries differed in hash while all file sizes matched; the builds were
behavior equivalent in the tested corpus, not byte reproducible. This
matrix has one fresh build of each compiler profile. An authoritative compiler
comparison requires the same run and attempt for all profiles; rerun the whole
workflow if a retry would mix attempts.

Local validation covers accepted profiles and rejection of wrong/missing
effective flags, leaked Maxima flags, missing generated units, missing named
GC settings/spill execution, altered snapshots and rehashed fabricated claims.
It does not replace Ubuntu compilation, runtime parity or independent review.

Initial run 39936262034 retained a fixture-selection failure: the Oz/O2 jobs
correctly rejected synthetic manifests hard-coded as baseline. Fixtures now
select their matrix profile and still test different/unknown-profile rejection.
This changed no production admission gate or compiler configuration. Sidecar
run 39936262129 selected historical step-1 artifact 12467529817 without a new
successful compiler baseline; exact current pin admission correctly rejected it.

Source review of 8a6c342 found incomplete compiler target/unit coverage and
a missing timing-workload hash binding. The corrected gate associates each
observed target C input/output with raw and actual clang commands, checks all
relevant target units, requires the delivered ECL/main/eight-module links, and
matches every observed link to its own actual spill-pass input/output. The
corrected timing gate binds the timing report hash and rederives the three
programs from the accepted browser report, including all twelve sample records.
Missing-target/pass, wrong-other-unit, workload substitution and stale/missing
report fixtures retain these cases. Run 39936823520 remains pre-fix evidence.
