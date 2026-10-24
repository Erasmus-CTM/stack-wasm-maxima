# Explicit Maxima-Oz and matching STACK experiment

`ecl-oz-maxima-oz` keeps the production `ecl-oz` ECL settings and separately
injects `EMCC_CFLAGS=-Oz` while compiling Maxima main, its eight optional
modules, and each pinned translated STACK bundle. The original configure,
target-info, Lisp policy, GC root-scanner overlay, spill pass and 32 MiB stack
settings remain unchanged. The three ordinary profiles and production choice
are unchanged. The new profile lives in `experimentalProfiles`, so ordinary
three-profile comparisons do not silently acquire a fourth build.

`.github/workflows/experiment-maxima-oz.yml` runs only on an explicit push to
`experiment/e8ad-maxima-oz`. Its one candidate job has a 240-minute budget and
retains every full precompiled-workflow validation: both exact STACK pins,
native translation/reset/parser controls, full-library native cases, official
source and compiled probes, first logical/warning checks, complete restart
semantics, independent and same-source native controller replays, and graphics
and plot-policy checks. Worker timeouts and correctness criteria are unchanged.
It uploads raw partial evidence on failure and never deploys or promotes a
runtime. This branch has no pull request trigger for the legacy build matrix.

The runtime uses the unchanged strict `compiler_evidence.py` parser to require
actual generated Maxima clang flags at `-Oz`. For each STACK pin, a separate
`cross-compile-exec.log` records tool argv and process exits without environment
values. `stack_compiler_evidence.py` requires printed source association plus
successful driver and clang executions at the expected optimization, and
successful linker and Binaryen spill executions for the delivered bundle and
intermediate target links. Every recognized tool process must exit zero.
Generated STACK/bridge C, translated inputs, descriptor and final FAS bytes are
hash-bound. Proofs are recomputed against the packaged runtime before browser
staging; matching-looking claims without raw traces cannot pass. Source code,
workflow, proof checker and translator inputs are included in the packaged
recipe inventory.

No candidate runtime has yet passed CI or been timed. Local synthetic tests do
not establish runtime parity, performance, full raw-reset safety, F11 browser
semantics or PHP equivalence. The existing full-suite timing is an initial
source-versus-compiled observation on the new runtime, not a matched comparison
against older artifacts.

After complete successful CI and independent artifact review, a separate
no-rebuild comparison must bind the new run/attempt/head/tree, artifact ID/name,
ZIP byte length and SHA-256, complete package/runtime closure, both pinned FAS
proofs and exact manifests. It must also independently admit the existing
accepted ECL-Oz/Maxima-O2 control. Stage exact archived bytes for each route on
one fresh runner, alternate route order, retain separate startup/restart/first
question/warm-call timings, preserve correctness and 300-second watchdogs,
and report repetitions, raw samples, absolute/relative differences and spread.
Use at least three balanced repetitions (ten for a selection decision), clean
uninstrumented arms, and separately labeled optional CPU profiling. Old build
identity remains distinct from fresh benchmark identity. Never insert a new
candidate row into a results table as measured before those bindings exist.
