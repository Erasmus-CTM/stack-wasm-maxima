This diagnostic reuses admitted baseline and Oz runtime bytes. It does not compile C, Lisp or Wasm, alter PR13, promote a default, or establish a speedup. `prepare.py` admits the immutable full-job packages; the harness requires its successful admission receipt and checks every original staged file, compiler profile and package-manifest identity before making separate copies.

Invocation after admission:

```sh
node run.mjs --trusted-root /absolute/trusted --profiles-root /absolute/profiles --output /absolute/evidence --admission /absolute/evidence/admission.json --repetitions 3 --cpu-profile
```

The six adjacent runtime files are `run.mjs`, `stage.mjs`, `cdp-profile.mjs`, `child-hooks.js`, `load-hooks.lisp` and `probe-worker.js`. The workflow places them under the trusted checkout so the pinned Playwright dependency resolves normally. No token reaches the profiling runner.

Three repetitions cover both compiler profiles, source and precompiled STACK, and clean versus instrumented arms:24 trials. Each trial gets a fresh Chromium process/profile. Candidate, compiler-profile and arm order alternate across repetitions; OS cache and runner contention remain uncontrolled. Every trial retains the300-second watchdog. Initialization keeps the existing240-second limit and individual calls the existing60-second limit.

Clean controls use the original child wrapper and original timed source/FAS manifest, with no Worker replacement, load hooks or CPU sampler. Instrumented copies record original/derived hashes, preserve all runtime asset bytes and embedded STACK file bytes, and prepend Lisp observers only to a separate diagnostic startup manifest.

Existing evidence already separates preload, Wasm-ready, entry into STACK load, STACK load and readiness. These are elapsed measurements; they cannot attribute CPU to dependency loads. Existing full-job grade calls occurred after other checks and warmups. `existing-phase-evidence.json` retains the current n2 observations and their source hashes.

New observers split preload decode/hash, FAS fetch/hash, Emscripten preInit, file mounting, importScripts and asynchronous WebAssembly calls. The long-lived synchronous runtime import can remain an open span: it enters the persistent CAS loop. Successful FS opens record resolved paths and counts. FS-open duration is not full file-load duration.

Lisp wrappers observe calls through the function cells of Maxima `$LOAD`, Common Lisp `LOAD` and Maxima `$COMPILE`. They preserve argument lists, multiple return values and nonlocal unwinding. Their original output stream bypasses dynamically captured question feedback; all ordinary output remains present. At completion they restore only function cells still containing their own wrappers. Compiled direct calls may bypass these observers, so coverage is explicit rather than assumed exhaustive.512 Lisp frames and4,096 total events bound collection; overflow/error/missing-finish flags invalidate instrumented completeness.

Each Lisp frame retains parent/depth and real/run ticks. The report derives inclusive and direct-child-subtracted exclusive elapsed durations; inclusive nested values must not be summed. Exact argument names and resolved FS paths are reported separately. Startup clock baselines and a small positive-work calibration detect a nonadvancing ECL run clock. Nonadvancing values become unavailable, not zero CPU. Even an advancing ECL clock is labelled implementation-unvalidated. No numeric value from that clock is promoted to exact process CPU.

Optional CDP sampling attaches recursively before worker startup, including the outer probe and nested Maxima child. Raw CPU profiles persist, and the main report includes top30 sampled leaf frames per context. Opaque Wasm names remain opaque. Coverage or protocol failure is reported as unavailable/partial and does not discard other observations. Only instrumented arms poll Chrome cumulative process CPU counters; these include renderer/browser/utility work and can undercount short-lived processes. Host Node CPU is a separate server/harness observation. Neither sample weights nor elapsed load durations are exact function CPU time.

The first logical-validation regression runs before grading, policy checks or warmups. Then the harness measures first positive and first negative grades, ten repeated grades, ten arithmetic calls, the remaining nine unchanged semantic checks and pinned STACK policy. FAS mounting/hash/open and zero-source-fallback checks remain strict. The combined first-use summary is `readyPlusFirstLogicalAndFirstPositiveMs`, the sum of those three measured blocks, not full UI latency.

`report.json` is saved after every attempt and contains separate clean/instrumented medians and paired differences. Those differences include uncontrolled runner/cache effects as well as observer cost. Per-trial partial/sample JSON, raw CPU profiles and process CPU snapshots survive failures. No browser, Maxima, ECL or artifact program ran during source preparation; `test-harness.mjs` uses synthetic trusted mocks only. Actual Lisp hook and nested-CDP behavior require the separate diagnostic CI run and must be inspected before interpreting its results.
