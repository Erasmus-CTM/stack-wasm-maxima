# Runtime sizes and CTM integration assessment, 21 October 2026

## Recommendation

Keep CTM Assessment's Quarto setup, inputs, buttons, previews, feedback panels and variant controls. A Maxima worker can be added behind the existing grading request/result boundary. Prove loading the pinned STACK libraries, grading fidelity, cancellation, startup latency and coexistence with Pyodide before choosing it as the default.

On a Python-heavy course, this adds another runtime. It does not remove the Python packages needed for the course. The main prospective benefit is reduced maintenance of STACK-compatible grading semantics, not a demonstrated speed or resource saving.

## Executable startup dependency discovery

The first executable run requested the additional required ECL shared library `libecl.so` before Maxima could accept input. It is 7.97 MB and was served without HTTP compression. The original 5.18 MB measurement covers four files and is not a complete runtime startup footprint. The separately recorded dependency manifest includes its SHA-256 and the Wasm dependency graph. The known startup set now totals 13.15 MB transferred and 33.36 MB of files, before STACK and additional share libraries.

The subsequent linked-module check also found `libgnuplot.so` (3.94 MB, uncompressed), required by `maxima-plot.fas`. The unmodified STACK loader asks for that plot module even in this non-plotting assessment probe. The known files for that loading path now total **18.22 MB transferred / 38.43 MB of files**, before additional share-source requests and STACK. The full core plus all nine optional modules and both linked libraries is 34.93 MB transferred. These remain asset inventories, not a complete cold-page trace.

## Measured download sizes

All MB below are decimal (1 MB = 1,000,000 bytes). Transfer bytes count encoded HTTP response bodies from fresh GET requests, excluding HTTP/TLS overhead. File bytes are after HTTP decompression; ZIP and wheel contents have not been unpacked. These numbers are not memory usage.

| Selected asset set | Actual transfer MB | File MB |
|---|---:|---:|
| Maxima `maxima.wasm` alone | 4.92 | 23.61 |
| Four Maxima files: Wasm, loader, worker, share-file index (excludes ECL) | 5.18 | 25.39 |
| Required ECL shared library, `libecl.so` | 7.97 | 7.97 |
| Known Maxima startup files including ECL | 13.15 | 33.36 |
| All nine lazy Maxima `.fas` modules identified by its worker | 17.84 | 17.84 |
| Four Maxima files plus those nine modules (excludes ECL) | 23.02 | 43.23 |
| Core plus nine modules and ECL, excluding gnuplot | 30.99 | 51.19 |
| Linked plotting library, `libgnuplot.so` | 3.94 | 3.94 |
| Core plus plotting module and both linked libraries | 18.22 | 38.43 |
| Core plus all nine modules and both linked libraries | 34.93 | 55.13 |
| Pyodide 0.28.3 core: loaders, Wasm, stdlib ZIP, lock | 5.30 | 12.26 |
| SymPy 1.13.3 plus mpmath 1.3.0 | 4.47 | 4.54 |
| Python grading baseline: Pyodide core plus SymPy/mpmath | 9.77 | 16.80 |
| Course Python package set: 18 package archives | 32.42 | 32.93 |
| Course Python core plus package set | 37.73 | 45.19 |
| Course Python set plus known Maxima startup files including ECL | 50.88 | 78.54 |

The course package roots are numpy, scipy, sympy, matplotlib, micropip and pyodide-http. The transitive closure has 18 archives, including libopenblas. Every package's decoded-file hash was checked against the Pyodide 0.28.3 distribution lock. The lock's internal `info.version` says `0.28.0.dev0`; the release URL is explicitly 0.28.3.

The four originally measured Maxima core files were served with Brotli; the required ECL shared library was served without HTTP compression. Its measured local gzip level-9 size is 2.36 MB, so the known startup files could total about 7.55 MB with a corresponding self-hosted encoding configuration. This is a compression estimate, not observed network delivery. The nine `.fas` modules were served without HTTP compression. Their local gzip level-9 sizes total 2.53 MB, recorded separately in the JSON as a self-hosting estimate, not as observed transfer sizes. Combining this local gzip estimate with the observed Brotli core gives 7.71 MB for that selected set, before STACK/share files; a server must actually serve those encodings to achieve it. The all-nine set is illustrative: it is neither a required startup set nor the complete Maxima distribution.

The core measurement excludes STACK's Maxima library, additional Maxima share files requested during grading, question data, CTM checker payloads, and the surrounding frontend. We did not run a browser network trace, so 5.18 MB is not a measured first-grade download. Existing CTM typesetting should be reused; the Maxima demo's UI, MathJax and plotting frontend are not a proposed dependency.

## Does it double static resources and loading time?

It creates two interpreter implementations on pages that need both Python and Maxima. Their runtime assets, initialization and memory costs are additional. It does not duplicate CTM's inputs, course HTML, navigation, typesetting, or Python scientific packages.

For the measured course package set, the known Maxima startup files including ECL add 13.15 MB to 37.73 MB of Python assets, about 35 percent. Grading dependencies add more. If all nine measured lazy modules were also fetched with their current encoding, the combined selected asset set would be about 68.72 MB, before STACK and other share files. These figures do not predict startup latency.

Lazy loading moves first-use costs to the first validation/check. Browser HTTP caching can reuse matching assets across visits and across workers, subject to the cache policy. Runtime instances and their initialized interpreter state remain separate. The current STACK implementation already starts its own Pyodide worker; the comparison therefore depends on architecture:

| Architecture | Consequence |
|---|---|
| Current separate Python exercise and STACK workers | Python runtime files can be cached, but separate interpreters are initialized. |
| One shared Pyodide runtime for exercises and grading | One interpreter may serve both; grading competes with learner code and cancellation/isolation require care. |
| Python exercise worker plus Maxima grading worker | Two runtime asset sets and interpreters; the CAS has independent scheduling, restart and cancellation. |
| Maxima-only practice page | Python can be omitted if that page has no Python exercises or Python custom checkers. |

The inspected Maxima loader configures 134,217,728 bytes (128 MiB) of initial WebAssembly linear memory, with growth permitted. This is a configuration value, not measured process RSS or an exclusive physical-memory estimate. Pyodide has its own heap, filesystem and interpreter; both also have JavaScript and compiled-code overhead.

## Integration boundary

The existing STACK frontend sends `{type, question, variant, answers}` to a disposable worker. The worker supports `validate`, `grade` and `tests`, returns `{id, ok, result}` or `{id, ok:false, error}`, and the UI consumes per-input validity/LaTeX plus question/PRT scores and feedback. These are useful compatibility targets, not a claim that the Maxima adapter exists.

Proposed responsibilities:

1. Build time: retain Quarto authoring; use pinned STACK tooling/native Maxima to prepare supported question variables, compiled PRTs and variants. Evaluate whether existing importer restrictions can be bypassed without losing the supported CTM extensions. Preserve source and compiled-plan provenance.
2. Frontend: collect original text or matrix cell strings, retain validation snapshots, and ignore results from old edits or variants. Avoid passing answers through SymPy before Maxima, because that can erase written form and decimal precision.
3. Adapter: validate input using an explicitly supported grammar and question configuration, construct safely serialized Maxima calls, restore the question environment, run STACK functions/compiled PRTs, and translate results into CTM's existing contract. The Wasm sandbox does not replace semantic input validation or protection of the grader's state.
4. Results: preserve CTM's feedback sanitization. STACK answer-test functions return structured validity/result/note/feedback data; language tags and CASText still need translation and rendering. Use the same backend for the interpretation preview and grading.
5. Python custom checkers: retain their Python execution path. Passing data between backends requires an explicit serializable value contract; Python objects and Lisp/CAS objects are not interchangeable.

Maxima is a separate ECL/Emscripten runtime. The stock build is not a Pyodide package and cannot be added through `pyodide.loadPackage`. Recommended coexistence is two workers coordinated by CTM JavaScript, exchanging JSON-compatible values. Python can call an asynchronous JS bridge when needed, but direct heap or filesystem sharing is not part of this design.

The inspected Maxima worker uses `SharedArrayBuffer`/`Atomics.wait` for input communication. Its deployment sends COOP `same-origin` and COEP `require-corp`. This overlaps the requirements of CTM's planned interruptible/offline Python setup, but is more restrictive than basic Pyodide without interrupt/input support. Test actual hosting, iframe embedding and the exam browser. Reuse one coordinated hosting/isolation setup.

## Why evaluate Maxima despite the added runtime?

The ongoing SymPy work increasingly reproduces STACK's written-form, numerical, input-validation and PRT conventions. Running STACK's Maxima functions can reduce the amount of CAS semantics that CTM must reimplement, and may enable more imported answer tests and author code. It also adopts STACK's native conventions and quirks. Mathematical domain questions documented by the current semantics report still need explicit decisions.

This is an engineering hypothesis, not a completed port or benchmark. The deployed Maxima share directory identifies a `branch_5_49_base_90_g813903d33` build; CTM's native oracle used Maxima 5.46.0. Matching CAS/library versions and proving the selected backend's behavior remain necessary.

## Runs needed

- Load pinned STACK `10d3233` and `3338304` libraries in the Wasm build; record every dependency, failure and version.
- Run the existing native answer-test fixture inventory and a targeted supported subset first; keep unsupported/controller-dependent cases explicit. Compare against the native oracle, including held form, decimal ties, matrices, sets and assumptions.
- Compile/replay representative full PRTs and question tests. Include multiple inputs and PRTs, invalid/blank answers, quiet nodes, score aggregation, variants and translated/sanitized feedback.
- Measure a fresh-browser network trace through first validation and first grading, warmed checks, peak memory, Stop/restart, and repeated question/environment reset. Measure Python and Maxima ready times separately and concurrently.
- Test Chromium, Firefox and WebKit alongside the existing Python course worker, plus the actual offline/exam hosting and browser configuration.
- Build a minimal self-hosted grading package with only the required Maxima/STACK files; measure compressed `.fas` delivery instead of assuming the public demo's encoding is optimal.

No browser runtime, STACK-in-Wasm grading, latency, or memory benchmark is claimed by the current measurements.

## Sources and inspected revisions

- [Deployed Maxima demo](https://maxima-on-wasm.pages.dev/); exact selected file hashes and response metadata are in the measurement JSON. Its [source link](https://gitlab.com/mgerbershagen/maxima/-/tree/emscripten-port-deployed?ref_type=heads) identifies the implementation; no GitLab source checkout was needed for the asset measurement.
- [Pyodide 0.28.3 distribution lock](https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide-lock.json).
- [STACK standalone Maxima sandbox and direct answer tests](https://docs.stack-assessment.org/en/CAS/STACK-Maxima_sandbox/).
- [STACK PRT compiler](https://github.com/maths/moodle-qtype_stack/blob/10d323311b7f39fb7b092dd10ce75f7d8632f525/stack/prt.class.php).
- [stack-sympy worker](https://github.com/Erasmus-CTM/stack-sympy/blob/1b1d50f69fc1e7eb39846b497657d72be325f597/_extensions/stack-sympy/worker.js) and [frontend](https://github.com/Erasmus-CTM/stack-sympy/blob/1b1d50f69fc1e7eb39846b497657d72be325f597/_extensions/stack-sympy/stack-sympy.js).
- [ctm-checkers API](https://github.com/Erasmus-CTM/ctm-checkers/blob/9e042dc5e57a1636be64ca5d08910c9af5ff1371/docs/api.md), [page adapter](https://github.com/Erasmus-CTM/ctm-checkers/blob/9e042dc5e57a1636be64ca5d08910c9af5ff1371/src/ctm_checkers/stack/page.py), [native runner](https://github.com/Erasmus-CTM/ctm-checkers/blob/9e042dc5e57a1636be64ca5d08910c9af5ff1371/tools/stack_native/native_compliance/maxima_runner.py), [semantics](https://github.com/Erasmus-CTM/ctm-checkers/blob/9e042dc5e57a1636be64ca5d08910c9af5ff1371/reports/stack-compliance/semantics.qmd).
- [CTM handoff and approved offline design](https://github.com/Erasmus-CTM/ctm-assessment/tree/handoff/2026-10/docs/consolidation). The earlier course measurements there are corroborated by this fresh distribution-file measurement; no earlier timing results are reused as benchmarks here.
- Open work inspected: [ctm-checkers #10](https://github.com/Erasmus-CTM/ctm-checkers/pull/10), [#11](https://github.com/Erasmus-CTM/ctm-checkers/pull/11), [#12](https://github.com/Erasmus-CTM/ctm-checkers/pull/12), [#13](https://github.com/Erasmus-CTM/ctm-checkers/pull/13), and [stack-sympy #28](https://github.com/Erasmus-CTM/stack-sympy/pull/28). This assessment does not certify or merge those PRs.

## Completed dependency-check observations

[CI run 39669805961](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39669805961) matched all 22 selected direct answer-test observations at each of the two pinned STACK revisions. The unoptimized full library initialization took 78.09–81.05 seconds after starting a fresh worker; the bare Maxima prompt was available after 2.34–2.51 seconds. The subsequent 22-case batch took 3.29–3.50 seconds, including protocol and lazy-load overhead. These are single-run diagnostic observations, not paired Quarto/SymPy benchmarks.

The actual browser path requested 69 unique runtime asset URLs, totalling 41.01 MB of decoded files, including the matrix-algebra module and additional share sources. Separately mounted STACK sources added 0.87–0.90 MB. The local test server did not apply HTTP compression. The 18.22 MB row above describes its named subset, not the full observed public-transfer footprint. A cold question-page network trace and repeated paired timings remain required.
