# System design audit: native Maxima in the CTM Assessment framework

22 October 2026. Read-only audit of `main` at `982f405` (merged PR #2, milestone 3)
against CTM's consolidation designs: ctm-assessment `docs/consolidation/` on
`main` (step 2 with its §13 amendments, the stack-sympy audit) and on
`handoff/2026-10` (step 5 offline/exam, variants, `HANDOFF-2026-10.md`),
ctm-checkers `e8ec8d7`, ctm-libs `a1626f6`, stack-sympy `1b1d50f`.

Goal set by AC: the Python (SymPy) and Maxima backends should be as
interchangeable as possible, and the STACK PythonChecker should preferably
reuse math-exercise's checkers.

**Decisions taken in the discussion of this audit (AC, 22 October 2026)** are
recorded in §8 and already applied in the text: the two backends have
distinct roles (SymPy: the light, fast, tested subset in maintenance mode;
Maxima: full STACK, where new capability goes); a course or question uses one
of them, and moves go one way (SymPy → Maxima); each backend generates its
own variants and the Maxima backend reuses Moodle's deployed seeds; CTM owns
the Maxima/ECL Wasm build with exact pins; the hybrid path is a test oracle
only; the December 2026 exam is Pyodide-only (no STACK, no math-exercise).

**Method.** All timings are the frozen measurements in `reports/` (cited per
row); nothing was re-measured. Verified in this session: the code paths cited
as `file:line`, and the composition of the deployed native page (the
`gh-pages` branch, `maxima/native.html`). Statements marked *hypothesis* need
an experiment before they are relied on.

---

## 1. Summary

The prototype proves the hard part: unmodified STACK answer tests, question
preparation, validation and response trees run in browser Maxima, agree with a
desktop Maxima replay on 316 programs, and reuse CTM's card UI and JSXGraph
transport. As a production backend it is not ready, and the obstacles are
architectural rather than incremental:

| # | Finding | Severity |
|---|---|---|
| F-1 | Native startup is **38.6 s** per fresh page (public build, desktop CI runner); every page navigation pays it again. SymPy: 5.7 s | blocking |
| F-2 | Maxima requires cross-origin isolation and **fails closed** without it. Pyodide degrades gracefully; a page embedded cross-origin (LMS iframe, exam system) loses STACK-Maxima entirely | high |
| F-3 | Any CAS-level error in a native program terminates the Maxima child, so the next request restarts it (another ~38 s); STACK itself takes a false branch with a note | high |
| F-4 | Build-time preparation runs Wasm Maxima in headless Chromium driven by Playwright; incompatible with "authors install one package" and local VS Code builds | high |
| F-5 | Three authoring syntaxes (`stack-question`, `stack-maxima`, `stack-native` + `#\| prepared:`), a SHA-gated text patch of `stack-sympy.js` and a side-channel `questions.json` | high |
| F-6 | Two STACK response-tree controllers (Python in ctm-checkers, JavaScript here) and two input-rule implementations at **different STACK pins** | high |
| F-7 | The PythonChecker bridge is built on API v1 (`CHECKERS`, 3-argument), which the approved H1 decision retires; a second Pyodide is loaded inside the Maxima worker | high |
| F-8 | The same seed yields different variants under the two backends (Maxima RNG vs Python `random`); the prototype also seeds differently from STACK, so Moodle's deployed seeds are not reproduced | medium (D1) |
| F-9 | Runtime binaries are fetched from a third-party deployment (`maxima-on-wasm.pages.dev`); Maxima there is a 5.49 development branch, the CTM oracle is 5.46; no CTM build from source, no GPL source offer for redistribution | high |
| F-10 | The native page HTML is **16.9 MB**, 88 % of it eight copies of a 1.86 MB base64 board iframe | medium |
| F-11 | Warm calls cost 104 ms (validate) and 336 ms (grade) versus 12 ms for SymPy; each call rebuilds the whole question environment | medium |
| F-12 | Supported author subset excludes function definitions (`f(x):=…`), `apply`, `define`, random feedback variables and more; real-question compatibility is unmeasured | medium |
| F-13 | One serialized queue for every card on the page; a 60 s timeout and restart blocks all cards | medium |
| F-14 | Offline closure: share files are fetched lazily on first use of a function; an incomplete exam bundle fails only at grading time | medium |
| F-15 | Feedback translation covers 63 English STACK messages; no nb/nn, not on ctm-libs' catalogue | low |
| F-16 | Only Chromium is verified; memory is unmeasured; the hybrid path's string blacklist (`maxima-session.js:10`) is weaker than the native AST admission | low |

**Recommendation in one paragraph.** Treat the two backends as a light one
(SymPy, maintenance mode) and a full one (Maxima). Make the choice a course
setting with a per-question override on the one `stack-question` block, with
one question plan format, build-time capability diagnostics that point a
question outgrowing SymPy to Maxima, and the Maxima backend as the oracle for
SymPy's subset (§4). Implement H1 once in ctm-checkers so both backends call
the same `check(response, symbols)` (§5). Make Maxima viable by owning a
reproducible, exactly pinned Maxima/ECL Wasm build that exposes a call entry
instead of a stdin REPL, drops what the browser cannot use, and starts from
precompiled STACK and a memory snapshot (§3.3, §3.4, §6); without that, F-1,
F-2 and F-9 cannot be fixed from this repository. Keep the hybrid path as a
test oracle only.

---

## 2. Architecture as built

| | SymPy (stack-sympy) | Hybrid Maxima (comparison page) | Native Maxima (native page) |
|---|---|---|---|
| Authoring | `{.stack-question}` code block | `::: {.stack-maxima}` div, converted to the same code block (`prototype/quarto/stack-maxima.lua`) | `::: {.stack-native}` with `#\| prepared: <id>`; questions listed in `site/native/questions.json` |
| Preparation (build) | Python CLI, `ctm_checkers.stack.cli` | same | Wasm Maxima in headless Chromium (`scripts/milestone-three/build-site.mjs`), cards by `render-cards.py`, fragments in `.native-prepared/` |
| Variants | Python `random.Random(seed)` | CTM-frozen (Python) | Maxima `make_random_state(seed)` (`native/engine.js:303`) |
| Input validation | Python, `student_input` (STACK `10d3233` data) | Python | JS `stackmplite.js` + rules (STACK `3338304`), then `stack_validate` in Maxima |
| Response trees | Python `engine.py` | Python, answer tests delegated to Maxima | JS `NativeStackEngine` generating one Maxima program per tree |
| PythonChecker | Python, API v1 | Python, API v1 | pause/resume continuation, Pyodide loaded inside the Maxima backend worker, API v1 |
| Worker | `stack-sympy/worker.js` (Pyodide) | `prototype/backend/worker.js` (Pyodide + Maxima child) | `prototype/native/backend-worker.js` (Maxima child; Pyodide on demand) |
| Frontend | `stack-sympy.js` | `stack-sympy.js`, text-patched by `scripts/milestone-two/frontend.py` (SHA-gated) | same patched frontend |

The Maxima child (`prototype/runtime/maxima-child.js`) runs the upstream
ECL/Maxima REPL. Requests are written into its stdin through a
`SharedArrayBuffer`; the backend worker blocks on `Atomics.wait` until a
`CTMMAXIMA|id|json` line appears on stdout (`maxima-session.js:103-150`).

---

## 3. Load times

### 3.1 What is measured

Public deployment, fresh Chromium 141 profile per sample, GitHub runner
(AMD EPYC, 4 vCPU), medians of 3 cold starts and 15 warm calls
([timings](milestone-three/timings/README.md), run 39831459804 attempt 2):

| Operation | SymPy | Hybrid Maxima | Native Maxima |
|---|---:|---:|---:|
| Runtime initialization | 5.71 s | 5.81 s (Python) + 38.40 s deferred to first Check | **38.60 s** |
| First Validate (UI, includes init) | 5.90 s | 5.99 s | **38.72 s** |
| Warm Validate | 11.8 ms | 12.2 ms | 103.9 ms |
| First Check | 11.3 ms | **38.45 s** | 418 ms |
| Warm Check | 11.7 ms | 42.3 ms | 335.7 ms |
| PythonChecker: Python startup on top | — | — | +5.80 s; first grade 6.13 s |

Encoded transfer per fresh page (milestone 2, gzip localhost): SymPy
10.50–10.52 MB, hybrid 21.21–21.28 MB. The native page's own transfer is not
in the frozen summary; it makes 103–107 requests before Python is needed.

### 3.2 Where the time goes

- **CPU, not network.** The preload package cut requests from 137 to 12, but
  local readiness only moved from 38.57 s to 36.71 s
  ([loading](milestone-three/loading/README.md)); the public 38.6 s is the
  same order. The bare Maxima prompt is ready after 2.3–2.9 s.
- **STACK library loading dominates.** Instrumented: 62.49 s full, 37.81 s
  without the statistics tail; linear algebra 17.29 s and statistics 16.29 s
  inclusive ([startup](milestone-three/startup/README.md)). Tracing inflates
  these; the split, not the totals, is the signal.
- **Startup is per page.** A Quarto course is a multi-page site. Each
  navigation creates a new worker; the HTTP cache saves the download, never the
  38 s of loading. A course page with quizzes in several tabs is fine; a quiz
  spread over pages is not.
- **Slower devices.** The runner is a server CPU. Student laptops and
  Chromebooks are plausibly 1.5–3× slower (*hypothesis*: unmeasured), i.e.
  roughly a minute or more before the first Validate answers.
- **Page weight.** `maxima/native.html` on `gh-pages` is 16,861,138 bytes.
  Four rendered board iframes are `data:text/html;base64` URLs of ~1.86 MB
  each (7.43 MB), and the same board HTML is repeated per variant inside the
  card JSON payloads (`question_html`, 7.47 MB; `native-python-board` alone
  3.72 MB for two variants). Board HTML is rendered per variant
  (`render-cards.py:107-111`). The runtime itself adds `maxima.wasm` 23.6 MB,
  `libecl.so` 7.97 MB and the 4.98 MB base64 JSON preload pack (uncompressed
  file sizes); `native/build-manifest.json` (18.9 MB of build evidence) is
  also published.

### 3.3 Remedies, ranked by expected effect

| # | Remedy | Expected effect | Status / risk |
|---|---|---|---|
| L1 | **Memory snapshot**: run Maxima + STACK load once at build, save Wasm linear memory and the Emscripten FS state, restore it in the browser | 38 s → a few seconds (download + instantiate + copy) | *hypothesis*. ECL cannot dump a Lisp image (no `save-lisp-and-die`), so Moodle's "optimised Maxima image" has no direct analogue; a Wasm-level snapshot is the equivalent (Pyodide ships memory snapshots for the same reason). Needs control of the Emscripten build (F-9); GC and file-descriptor state must survive; gate by the full 316-program replay |
| L2 | **Precompiled STACK libraries** (ECL `.fas` compiled in the same Wasm build, loaded instead of `.mac`/`.lisp` sources) | large share of the 33 s library time | *hypothesis*; startup README lists "reusable compilation caches" as the next experiment; pinned-build parity required |
| L3 | **Start early**: start the Maxima worker when a Maxima card enters the page (idle callback / viewport), with the planned status lamp (step 5, P16) | hides most of the wait while the student reads | cheap; costs CPU and memory on pages where nobody answers |
| L4 | **Load heavy libraries on demand** (statistics etc.) when the compiled plan says a question needs them | 62.5 → 37.8 s instrumented | changes STACK's load order; the exact-directory experiment already failed a library load; parity-gated only |
| L5 | **Binary preload pack** instead of base64 JSON decoded one character at a time (`maxima-child.js:32`) | −33 % of 4.98 MB, less decode CPU | small, safe |
| L6 | **One board template per question**; pass variant data through the binding's initial values; JSXGraph core as one shared, cacheable asset | native page 16.9 MB → ~2 MB | jsxgraph-quarto change or a non-embedded mode; also matters for ctm-demo (variants design measured 72 % of a page in variant data) |
| L7 | **Cross-page persistence** with a `SharedWorker` | saves startup between open tabs only | not reliable across same-tab navigation; Safari support of SAB in shared workers to be tested; low priority |

L1 and L2 together are the only path to SymPy-like startup. Without them, the
Maxima backend fits single-page practice sets where L3 hides the wait, not
course-wide default use.

### 3.4 Startup files, and what an own build can trim

Files a native page loads before the first answer (uncompressed sizes, from the
deployed `previews/research/2026-10-native-stack/stack-sources.json`):

| File | MB | Why |
|---|---:|---|
| `maxima.wasm` | 23.6 | Maxima + ECL core (4.92 MB with Brotli upstream) |
| `libecl.so` | 7.97 | ECL runtime (2.36 MB gzip-9 locally; served uncompressed upstream) |
| `libgnuplot.so` | 3.94 | needed only by `maxima-plot.fas`, which STACK's loader requests |
| preload pack | 3.73 (4.98 as base64 JSON) | `maxima-matrix-algebra.fas`, `maxima-plot.fas`, 64 share sources |
| `maxima.js`, `share_files.js`, `maxima_thread.js` | 1.78 | loader |
| STACK sources | 0.90 | 77 files |

About 42 MB uncompressed, matching the 41 MB observed in milestone 1. Seven
further modules are already lazy and load only when a question reaches them:
integration, limits, number theory, Poisson series, QUADPACK, SLATEC and solve
(16.1 MB together, 1–6 MB each). `solve`, `limit` and `integrate` are common in
STACK questions; today their modules download synchronously in the middle of a
grade.

Trims an own build allows (estimates until measured):

- plot module and `libgnuplot.so` out (−5.1 MB); `plot()` becomes a
  capability diagnostic, since the browser cannot run gnuplot anyway. STACK
  needs neither for grading: its loader only sets plot options at load time
  (`stack/maxima/stackmaxima.mac:1032-1035`, `set_plot_option([plot_format,
  gnuplot])`), which autoloads Maxima's plot module, and the Wasm port links
  that module to a gnuplot compiled to Wasm. A lightweight `set_plot_option`
  in the own build removes the dependency without editing STACK's sources;
- every file served compressed (ECL alone 7.97 → ~2.4 MB);
- size-optimized Wasm (`-Oz`, `wasm-opt`, stripped names): perhaps 10–30 %;
- binary preload pack (L5): −1.25 MB;
- modules no STACK function in the supported set reaches (SLATEC, QUADPACK,
  Poisson series are candidates) left out entirely, after a census.

Plausibly 8–10 MB compressed for startup, against ~21 MB for today's hybrid
page. **Fewer modules do not shorten the 38 s**: that is STACK's own library
loading, addressed only by L1 and L2, both of which also need the own build.
A snapshot is itself a download (the post-load heap, from 128 MiB of mostly
empty initial memory); its compressed size is unknown and must be weighed
against the CPU time it saves.

---

## 4. Findings and redesign

### F-2 Cross-origin isolation is a hard requirement

`MaximaSession.start` throws without `crossOriginIsolated`
(`maxima-session.js:43-45`) because the stdin transport blocks on
`Atomics.wait`. The step-5 design (§8, R2-2) records that an exam system
embedding the course page cross-origin loses isolation whatever the headers,
and that plain http on a LAN loses it too; Python then still runs (only
`input()` and Stop are lost). STACK-Maxima would stop entirely.

**Redesign.** Replace the REPL-over-stdin transport with a **call entry**: the
worker calls an exported function (ECL's safe-eval of one program, returning
the JSON text) for each request. No blocking stdin, so no `SharedArrayBuffer`
is needed for normal operation; isolation then only adds interruption (F-3). This needs a rebuilt runtime (§6). An alternative, JSPI/Asyncify
around `readChar`, also needs a rebuild and JSPI is not in all target
browsers.

### F-3 A CAS error kills the session

`MaximaSession.evaluate` treats every `[false, message]` result, including an
ordinary `errcatch`-reported Maxima error, as fatal: it sets `poisoned`,
signals abort and terminates the child (`maxima-session.js:142-155`). A
response-tree node whose answer test raises a CAS error calls `error(…)`
(`engine.js:478`), which lands there. The backend worker then reinitializes on
the next request (`backend-worker.js:16-20, 68, 93-94`): another ~38 s. STACK (and
ctm-checkers since S-11) takes the false branch with an answer note for errors
caused by valid input.

**Redesign.** Separate three outcomes in the protocol: *CAS result* (including
CAS errors, mapped to STACK's notes and false branches as the reference engine
does), *author error* (question bug: card diagnostic, session kept), and
*runtime failure* (protocol broken, timeout, Wasm trap: restart). Only the last
may terminate the child. Timeouts first try the ECL interrupt that already
exists (`ABORT` slot, `maxima-child.js:91`) and restart only if the session
does not answer after it.

### F-4 Build-time preparation needs a browser

Native preparation runs the actual browser worker in Playwright Chromium with a
local server (`build-site.mjs:47-110`), ~38 s per build before the first seed.
Authors build locally (VS Code) and in GitHub Actions; the variants design runs
generation "at build time only, natively" with a `.quarto/ctm-variants/` cache.

**Redesign.** One build runner for the same Wasm binary without a browser:
Node `worker_threads` or the Deno that Quarto ships (`quarto run`), so the
browser and build use byte-identical Maxima and STACK (*hypothesis*: Deno
workers support `SharedArrayBuffer`/`Atomics.wait`; to be verified, and
unnecessary with the call entry of F-2). Cache plans by (XML hash, seed,
runtime hash, STACK revision) in the variants cache; with L1 the build also
produces the snapshot once.

### F-5 Three authoring syntaxes, a text patch, a side channel

Authors must not see backend plumbing. Today the Maxima editions need a
different block class, the native one an external JSON list and
`#| prepared:` ids; the frontend seam is a regex rewrite of the exact pinned
`stack-sympy.js` (`frontend.py:13, 81-97`); `stack-native.lua:18-31` loads
`_extensions/stack-sympy/ctm-bootstrap.lua` and declares stack-sympy's
dependencies itself.

**Redesign (interchange contract).**

1. **One block, a course setting.** `{.stack-question}` with today's
   options. The CAS is a course (project, then page) setting, proposed as
   `stack: cas: sympy | maxima` (a `stack:` section independent of the
   repository name stack-sympy), with `#| cas:` on a block as an override for
   a few questions. Mixing on one page works (separate workers) but loads both
   runtimes; the build notes it. Default `sympy`; it matters little, since no
   course exists before the package is settled.
2. **Backend registry, not a patch.** stack-sympy's frontend (step 6, when it
   moves onto ctm-libs' runtime and worker) reads a backend descriptor from
   the card: `{id, version, workerURL, assets, capabilities, requires:
   {isolation}}`. The Lua filter writes it at build. No frontend branches per
   backend; the hybrid patch goes away.
3. **Backend-neutral plan.** The card payload keeps the shared parts (inputs,
   display per variant, CASText output, qtests, H1 checker, variant identity)
   and one opaque `backend` section (`{id, planSchema, stackRevision,
   runtimeHash, …}`) that only that backend reads. The native engine already
   binds variants to backend, STACK build and question hash
   (`engine.js:232-241`); make that the general rule.
4. **Capabilities checked at build.** Each backend reports unsupported
   constructs (input types, options, answer tests, author functions) as the
   same author diagnostic, naming file, question and construct. A question that
   one backend cannot run fails the build for that backend; there is never a
   runtime fallback to the other backend (already a principle here). For
   SymPy the diagnostic also names the way out ("needs `cas: maxima`"): the
   path for a question that outgrows the light backend.
5. **One conformance suite, Maxima as oracle.** Generalize the milestone-2
   paired harness: render the questions both backends support under both and
   compare structured results (status, score, PRT notes/paths, validity,
   assessment). The Maxima backend is the reference; a difference is a SymPy
   bug (fixed only if small, per its maintenance status) or a documented
   difference (e.g. S-03 log/abs), each listed once.
6. **Moves go one way.** A question moved from SymPy to Maxima gets new
   variants (different RNG) and its manifest entries need re-approval; the
   documentation says so. Moves back are not supported.

### F-6 Two controllers and two input-rule sets

`NativeStackEngine` reimplements the response-tree controller: traversal,
score modes, notes, quiet nodes, penalties in tests, rounding to 1e-10
(`engine.js:183, 405-553`). ctm-checkers' `engine.py` is the reference used by
the SymPy backend and its goldens. Pending fixes such as S-08 (PRT score to
3 dp) and S-04 (quiet) will change one controller and not the other. Input
admission uses STACK's `stackmplite.js` and security data at STACK `3338304`
(`stage-parser.py:18-24`); ctm-checkers' `student_input` data are from
`10d3233`.

**Redesign.** One STACK pin for the whole stack (exact, D3). With the SymPy
engine in maintenance mode, the reference is STACK itself: the native
controller is checked against desktop STACK/Maxima replays, and the SymPy
engine against the native backend on its subset (F-5 item 5). The S-fixes in
flight finish; new controller semantics (S-08 rounding, S-04 quiet, …) land in
the native controller first, and in the SymPy engine only as bug fixes.
Evaluate STACK's own compiled PRT and CASText code (generated by STACK's PHP
compiler at build/CI time) as the native controller: it would remove CTM's
controller instead of maintaining it, at the price of PHP in CI. The
JavaScript admission is legitimately different (it must run before Maxima);
keep it, but generate its data from the same STACK pin as the Python rules.

### F-8 Variants differ by backend, and from Moodle

Same seed, different RNG: the SymPy port uses Python's `random`, the native
engine `set_random_state(make_random_state(seed))` (`engine.js:303`) and lists
`stack_randseed` among forbidden calls (`engine.js:10`). STACK seeds a question
with its own `stack_randseed`, as far as is known here, so the prototype
probably does not reproduce Moodle's variants.

**Decided (D1).** Each backend generates its own variants; SymPy-graded
questions keep a pure-Python build. The Maxima backend reproduces Moodle's
variants, so a teacher can bring a course whose variants they are happy with:

1. the questions use `cas: maxima`;
2. the variant tools import the XML's `<deployedseed>`s into
   `_variants/<label>.yml` as approved (reason "imported from Moodle") and run
   the XML question tests on each seed like any approved variant;
3. the manifest shows each seed's question note, which the teacher compares
   with Moodle's "Deploy variants" list (STACK: equal notes, equal variants).

Acceptance test for the Maxima backend's variants: seed exactly as STACK's PHP
does; confirm that Maxima's own Mersenne Twister gives the same numbers under
ECL as under the Lisp of a Moodle server (*hypothesis*); and for STACK sample
questions with deployed seeds, require equal question notes from desktop STACK
and from this backend, by extending the desktop replay with notes. The SymPy
backend states that deployed seeds do not carry over.

### F-11 Warm-call cost

Each validate and each response-tree evaluation re-evaluates every question
variable from its frozen string (`restore`, `engine.js:110-116`), writes
validation messages to a virtual file and reads them back
(`engine.js:363-366`), hashes the whole question for the binding check
(`engine.js:237`) and sends a program of up to 300 KB through the Maxima
reader. 336 ms per Check is fine interactively; it matters for build-time
question tests over all approved variants and for pages with many cards.

**Redesign.** Load each (question, variant) once per session into a named
Maxima context or a defined function, then send only the answers; capture
validation messages in a string stream; cache the binding hash per question.

### F-12 Supported author subset

Question and feedback variables must be `name: expression`
(`engine.js:67-76`); `MUTATING_CALL` (`engine.js:10`) also rejects `apply`,
`define`, `push`, `print`, `display`; random calls are rejected in feedback
variables and PRT expressions; `insertstars` only 0/1, no `allowwords`
(`input.js`). Function definitions (`f(x):=…`) and `apply` are common in
published STACK questions. Validation of the supported subset is good; the
coverage is unknown.

**Action.** A compatibility census before any default change: run the
compile step over STACK's `samplequestions/` and ctm-checkers' 35-question
corpus, record per construct how many questions it blocks, then widen the
subset where the Maxima `block` scoping keeps state contained (function
definitions inside `block` with `local`).

### F-13 Queue and cancellation

One backend worker serializes every card on the page
(`backend-worker.js:99`), one Maxima child serves it, calls time out after
60 s and kill the child (`maxima-session.js:125, 194`). The UI already ignores
stale replies, but they are still computed.

**Redesign.** Drop superseded requests of the same card before they reach
Maxima; put interactive Validate/Check ahead of background question tests;
interrupt before restart (F-3).

### F-14, F-9 Offline closure and provenance

The child mounts the preload pack and falls back to Emscripten lazy files for
everything else (`maxima-child.js:122-131`): a share file is fetched when a
function first needs it. The 22 October dependency supplement already records
trigonometry files that were missing from an earlier inventory. In an exam
bundle a missing file fails only when a student's answer reaches that
function.

The binaries come from `maxima-on-wasm.pages.dev` (`fetch-runtime.mjs:4-6`),
identified by hash but not built by CTM. Maxima identifies itself as
`branch_5_49_base_90_g813903d33` with ECL 26.3.27; ctm-checkers' native oracle
is Maxima 5.46. Maxima is GPL-2.0-or-later and ECL LGPL; shipping them in CTM
Assessment or an exam bundle triggers the step-5 rule (copyleft only with a
source offer).

**Redesign.** See §6: an owned, reproducible build pinned to one Maxima
version used by both browser and oracle, the full share tree or a closure
proven by CI request logging (fail on any unlisted request), and licence texts
plus a source offer in the asset lock.

---

## 5. PythonChecker shared with math-exercise (H1)

### 5.1 What is decided

Step 2 §13 (AC, 19 Oct): **H1 = option B.** math-exercise's `#| checker:` /
`#| tests:` and `check(response, symbols)` in the STACK block; the checker is
its own scoring part weighted by `#| checker-value:`; calling it from a PRT
node is optional; `#| python-checkers:`, `CHECKERS` and `checker_api` retire
without an alias. The variants design fixes the keys: `response["variables"]`
(exact SymPy values), `response["teacher"]` (by input name for STACK),
`response["variant"]` (identity only). The handoff orders the work: question
tests PR (done in ctm-checkers `e8ec8d7`), variants, then H1, with the shared
runner `core/custom.py` in ctm-checkers.

### 5.2 Where the prototype stands

The native bridge sends `{descriptor, options, student, teacher, assumptions}`
to `python_bridge.py`, which decodes Maxima `string()` output with the CTM
parser in *student* mode and calls API v1 `invoke` (`python_bridge.py:15-19,
64, 73-85`; `engine.js:459-463, 530-541`). The continuation mechanism is
sound and worth keeping: Maxima pauses at the node with its full state,
Python runs, Maxima resumes, and native → Python → native trees preserve
feedback variables and credit. Three things do not fit H1:

- the v1 contract (`CHECKERS`, `fn(student, teacher, options)`, assessment
  keyed `rows/columns` of the node's student value) is being retired;
- author-derived values (question variables, teacher answers, feedback
  variables) are decoded with the student vocabulary, which rejects author
  functions and nouns;
- `python_bridge.py` is conversion code living in this repository, while the
  no-duplication rule puts checker Python in ctm-checkers.

### 5.3 Proposed contract for both backends

One call, implemented once in ctm-checkers on top of `core/custom.py`, e.g.
`ctm_checkers.browser.call("stack.check", …)`. The request carries *text*,
never Python or Lisp objects; Python builds the SymPy values itself:

```json
{
  "checker": "<the #| checker: source>",
  "inputs":    {"ans1": {"type": "algebraic", "raw": "2*x+1", "canonical": "2*x+1"}},
  "variables": {"a": "3", "M": "matrix([1,2],[3,4])"},
  "teacher":   {"ans1": "2*x+1"},
  "node":      null,
  "assumptions": {"real": false, "positive": false},
  "backend":   "maxima"
}
```

- `raw` is what the student typed; `canonical` is the backend's validated
  written form (Maxima `string()` with `simp:false`, or the SymPy engine's
  written form). Inputs are validated by the selected backend first; an invalid
  answer never reaches the checker.
- `variables`, `teacher` and node values are decoded with the CTM STACK
  parser's **author** vocabulary. For the Maxima backend, frozen variables and
  teacher answers are decoded **at build time** for every deployed variant
  (the same check as D1); a value that does not decode is a build error, not a
  grading-time surprise.
- The checker sees exactly math-exercise's response: `kind`, `raw`,
  `expressions`, `inputs[name]` (matrices with `rows`, `cols`, `matrix`), plus
  `variables`, `teacher`, `variant`. A checker written for math-exercise runs
  unchanged when its field names match the STACK input names.
- The result is math-exercise's normalized result plus `valid: False`
  (invalid attempt, no score, as the prototype's invalid branch already does,
  `engine.js:535-540`) and `assessment` keyed by input name.

**Inside a PRT node (D4).** `<answertest>PythonChecker</answertest>` with
`<testoptions>{"checker": "check"}</testoptions>` calls the block's checker as
a predicate: true when the status is `correct` (score 1), otherwise false;
partial credit belongs to the checker part, not to a node. The node's own
`<sans>`/`<tans>` values are added as `response["node"] = {"sans", "tans",
"options"}` so STACK-aware checkers can use feedback-variable results while
math-exercise checkers ignore the key. Other names in `checker` select library
checkers from `ctm_checkers.matrix` (`basis`, `matrix_property`, `is_hpd`,
moved from `examples/stack/matrix-checkers.py` per H1).

**Authoring example** (same block for either backend):

````markdown
```{.stack-question}
#| file: questions/multiple.xml
#| question: A positive integer multiple
#| cas: maxima
#| checker: |
#|   def check(response, symbols):
#|       n = response["inputs"]["ans"]["expression"]
#|       d = response["variables"]["d"]
#|       ok = n.is_Integer and n > 0 and n % d == 0
#|       return {"correct": bool(ok),
#|               "feedback": "" if ok else "Give a positive whole multiple of the given number."}
#| checker-value: 1
#| tests: ...
```
````

### 5.4 Where Python runs

The native worker imports ctm-libs' runtime and starts its own Pyodide
(`python-bridge.js:41-66`). A page with math-exercise and STACK-Maxima cards
then holds two interpreters. Route checker calls to the page's ctm-libs
Python runtime instead (the planned worker for standalone pages, P13), through
the same `callCheckers` path math-exercise uses, so Pyodide loads once per
page. The interpreter is shared with learner code, which ctm-libs already
guards (`_ctm_guard` snapshot/restore); a long learner cell can delay a check,
which the queue order of F-13 should state. The Maxima continuation stays as
is; only its callback target changes.

### 5.5 Tests

`#| tests:` runs at build time through ctm-checkers `testing` for the selected
backend, with the values that backend froze; the XML qtests run through the
backend's controller. A checker part is therefore tested identically under
both backends, and the conformance suite of F-5 compares the rest.

---

## 6. Runtime ownership, packaging and exams

The fixes for F-1, F-2, F-9 and F-14 have one prerequisite: **CTM controls the
Maxima/ECL Wasm build.**

| Requirement | Why |
|---|---|
| Build from pinned Maxima, ECL and Emscripten sources in CI, reproducibly | provenance; GPL source offer is the build recipe plus sources |
| Same Maxima version for the browser and the desktop oracle | parity evidence measures the shipped engine, not a neighbour |
| Exported call entry (`eval program → JSON text`) | no stdin transport; works without isolation (F-2) |
| Interrupt flag honoured by the call entry when SAB exists | cancellation without restart (F-3, F-13) |
| STACK precompiled, snapshot written after load | startup (L1, L2) |
| Plotting module and `libgnuplot.so` excluded unless a question plots | STACK's loader requests them today (runtime report) |

**Route (D3).** The deployed binary comes from Marius Gerbershagen's
Emscripten port of Maxima (GitLab `mgerbershagen/maxima`, branch
`emscripten-port-deployed`); as far as is known he also develops ECL, which
supports Emscripten upstream. Contribute there rather than fork. Build in
GitHub Actions with exact pins of emsdk, ECL, the Maxima commit and STACK, and
build the desktop oracle's Maxima from the same Maxima source, which resolves
the 5.46/5.49 mismatch by matching rather than downgrading.

**Exact pins** (D3, an approved exception to CTM's "earliest working version
or later" rule): grading, simplification, display and random variants change
between Maxima and STACK versions, a memory snapshot is valid only for the
exact binary and sources that produced it, and parity evidence covers one
version pair. A scheduled tracking job proposes upgrades (rebuild, rerun
parity and timings, open a PR), as step 5 decided for exam assets.

**Order.** (1) Rebuild the deployed runtime from source and pass the existing
316-program replay; bit-identical output is not required. (2) Trims and
compression (§3.4). (3) Precompiled STACK (L2). (4) Snapshot (L1). (5) Call
entry (F-2). Each step is gated by the replay and timed on the public page.
Effort is unknown: Emscripten builds of large Lisp systems tend to need CI
tuning; step 1 shows quickly whether it is days or weeks.

**Packaging.** The Maxima backend is an optional asset set in ctm-assessment's
asset lock (step 5): runtime, snapshot, STACK sources, share-file closure,
licence texts, source offer; precompressed like the Pyodide assets. Pages
without `cas: maxima` cards load none of it (the native path already proves
"no Python assets" for native-only pages; the converse must hold too).

**Exams.** The December 2026 exam is Pyodide-only (no STACK, no
math-exercise; D7), so it sets no constraint here. Before any later exam use of
the Maxima backend: L1/F-2 done, then the step-5 dry run (top-level window,
headers, lockdown browser), with cold starts on wiped machines.

---

## 7. Work plan

The runtime work comes first, because it decides whether the Maxima backend
is usable at all; the selection plumbing is small. The other phases follow the
campaign's existing order (step 6 stack-sympy onto ctm-libs, variants, H1,
step 5 assets). Each is its own PR or stacked set with independent review,
merged by AC.

| Phase | Content | Depends on |
|---|---|---|
| M4c Runtime (first) | owned build reproduced from source with replay parity; trims and compression; precompiled STACK; snapshot; call entry and interrupt; tracking job; remeasure cold/warm on the public build and on a slow laptop | can start now |
| M4a Contracts | `stack: cas:` setting and `#\| cas:` override; card descriptor instead of the frontend patch; one plan format; CAS-error/author-error/runtime-failure protocol (F-3); hybrid path kept as test oracle only; one exact STACK pin | step 6 frontend/worker in stack-sympy |
| M4b Build runner | Wasm Maxima in Node/Deno, no browser; plan cache; conformance suite with Maxima as oracle (F-5, F-6) | M4a, M4c step 1 |
| M4d H1 in both backends | `stack.check` in ctm-checkers; Maxima continuation calls it on the page runtime; delete `python_bridge.py` and v1 usage here | H1 core in ctm-checkers, variants keys |
| M4e Variants | STACK seeding as in Moodle; import of deployed seeds with notes (D1) | variants PRs, M4b |
| M4f Page weight | one board template per question (L6); binary preload (L5) | jsxgraph-quarto |
| M4g Compatibility and language | census (F-12), widen subset; feedback messages through ctm-libs' catalogue with nb/nn (F-15) | M4b |
| M4h Packaging | asset lock entries, licences and source offer, closure check, Firefox/WebKit, memory | M4c, step 5 |

## 8. Decisions

Taken by AC on 22 October 2026, in the discussion of this audit:

- **Backend roles.** SymPy stays: it supports a meaningful STACK subset, is
  faster, tested and reviewed. It gets no further substantial development
  (the S-fixes in flight finish; afterwards bug fixes) and serves small, light
  questions. Maxima is the backend for full STACK. A course or question uses
  one of them; there is no switching back and forth.
- **D1 Variants.** Each backend generates its own variants. The Maxima backend
  reproduces Moodle's deployed seeds, imported as approved variants with their
  question notes (F-8); the SymPy backend states that they do not carry over.
- **D2 Selection.** A course setting with a per-question override; the
  default does not matter, since no course exists before the package is
  settled. Proposed names: `stack: cas: sympy | maxima` and `#| cas:`.
- **D3 Runtime.** CTM owns the Maxima/ECL Wasm build, via the upstream
  Emscripten port, with exact pins of emsdk, ECL, Maxima and STACK and a
  tracking job; first milestone: reproduction from source with replay parity;
  then trims and compression, precompiled STACK, snapshot (§3.4, §6).
- **D6 Hybrid path.** It was only ever meant as a test oracle and stays one.
- **D7 Exam.** The December 2026 exam is Pyodide-only: no STACK, no
  math-exercise.

Still open:

- **D2 names**: `cas:` versus `backend:`, and the `stack:` section name.
- **D4** H1 node semantics: predicate = score 1; full response plus
  `response["node"]` (§5.3).
- **D5** Reference semantics: STACK itself (desktop replay) for the native
  controller, the Maxima backend as oracle for SymPy's subset, and whether to
  evaluate STACK's compiled PRT/CASText code as the native controller (F-6).

## 9. Sources

- This repository: `prototype/runtime/maxima-session.js`, `maxima-child.js`;
  `prototype/native/{engine,backend-worker,input,python-bridge}.js`,
  `python_bridge.py`; `prototype/quarto/*.lua`;
  `scripts/milestone-two/frontend.py`, `fetch-runtime.mjs`;
  `scripts/milestone-three/{build-site.mjs,render-cards.py,stage-parser.py}`;
  reports `2026-10-21-runtime-size-and-integration.md`,
  `2026-10-21-selectable-backends.md`, `milestone-two/2026-10-22-completion.md`,
  `milestone-three/{2026-10-22-completion.md,timings,loading,startup,acceptance}`.
- Deployed page: `gh-pages` branch, `maxima/native.html` (blob `11a75d3`).
- ctm-assessment: `docs/consolidation/2026-10-step2.md` (§2.5, §9, §13),
  `docs/consolidation/stack-sympy-audit-2026-10.md` (§6); branch
  `handoff/2026-10`: `HANDOFF-2026-10.md`,
  `docs/consolidation/2026-10-step5-offline-exam.md` (§8, §11, R2-2),
  `docs/consolidation/2026-10-variants.md` (§2, §3, checker contract).
- ctm-checkers `e8ec8d7`: `docs/api.md`, `src/ctm_checkers/stack/checkers.py`,
  `checker_api.py`, `math_exercise/custom.py`, `stack/engine.py:701`.
