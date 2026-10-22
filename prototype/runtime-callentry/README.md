# Deployed-binary call-entry research (step 0)

This research adapter uses the existing, hash-pinned deployed Maxima/ECL
runtime. It does not rebuild or patch Maxima, ECL, STACK, the current transport,
or the published site. It is an internal trusted-program interface, not a
student input parser or a production runtime replacement.

## Routes

1. `eof`: prefill the original STACK startup script, return -1 from the port's
   browser stream after its last character, and keep Emscripten alive. The
   deployed binary returns from `main`; `postRun` can install an ordinary
   worker message handler. A repeated EOF read is bounded as a diagnostic.
2. Exported entry: `resolveGlobalSymbol` resolves the existing dynamic ECL
   exports. The adapter creates a Lisp string with
   `ecl_make_constant_base_string`, reads it with `si_string_to_object`, and
   invokes `si_safe_eval`. Its environment and error fallback use this
   runtime's ECL NIL representation (1). Emscripten lowers the C variadic
   optional error argument to a pointer: a temporary Wasm stack slot contains
   NIL, and its address is passed to `si_safe_eval`. The Lisp expression calls
   `maxima::$eval_string`, with the same per-program `errcatch` and STACK error
   maps as the existing session. JSON is emitted synchronously to an ordinary
   JS string. Each call restores the Emscripten temporary stack in `finally`.
   Worker requests are serialized; no stdin writes happen after readiness.
3. `to-lisp`: an alternative found in the port source explicitly throws to
   Maxima's `to-lisp` catch after startup, then uses the same exports. The
   runner tests it independently. A second `cl_boot` is unnecessary and is
   deliberately not called on an already booted ECL runtime.

The inspected port commit is
`813903d33f5ccca09cbe3086dbfe5e228521da52` on
[`emscripten-port-deployed`](https://gitlab.com/mgerbershagen/maxima/-/tree/813903d33f5ccca09cbe3086dbfe5e228521da52).
`src/ecl-port.lisp` implements the browser stream, `src/init-cl.lisp` has the
`cl-user::run` catch, and `src/maxima.system` uses that run function as the
ECL program epilogue. This source commit matches the deployed version suffix;
this spike does not claim a complete reproducible-build provenance chain.

The preload verification, regular-file FIONREAD adapter and MEMFS ENOENT
reuse are carried from the existing child because their original loader
reasons still apply. `maxima_thread.js` is unchanged: it creates typed views
on ordinary ArrayBuffers before an import hook replaces its transport
callbacks. The direct worker never constructs a SharedArrayBuffer or calls
Atomics. The Wasm memory itself is unshared.

## Reproduce

Stage the existing runtime with `scripts/milestone-two/prepare-runtime.py`,
then run `stage-parser.py` and `compile.py` from milestone three against the
same pinned sources, as shown in `runtime-callentry.yml`. Run:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
node prototype/runtime-callentry/run.mjs .cache/callentry test-results/runtime-callentry
```

`CALLENTRY_CHROME` optionally selects an installed Chrome executable;
`CALLENTRY_MODULE_ROOT` optionally selects an existing Node package directory.
They are local convenience overrides, absent in CI. Windows Git archive users
must disable `core.autocrlf` for binary-exact staging; the runner checks every
runtime asset and every STACK source hash before execution.

The workflow stages files only in `.cache`, preserves its evidence as an
artifact even on failure, and has no publication, tag, release or merge step.
It intentionally uses only the newer STACK pin
`33383047af39c204bf4442802a058f8b918b2b1b` (library `2026101500`).

The harness serves its direct-call pages without COOP/COEP and asserts
`crossOriginIsolated === false` and `SharedArrayBuffer === undefined`.
A separate isolated page runs the unchanged stdin session as the comparison.
Each runs the 22 milestone-one fixtures, including numeric default-option
preparation, and actual native-rational preparation, validation and grading
through `NativeStackEngine`. It compares full transport results exactly and
also compares the probes' validity/correctness/notes against the frozen
independent native reference. The rational teacher answer must validate and
score 1. Per-program source, result and duration are retained; readiness is
recorded alongside each route. These are single-run local/CI observations,
not cold public-page medians.

Ordinary CAS errors return `[false, message]`. The direct suite evaluates an
intentional `error(...)` and then `6*7` in the same worker; the runner also
checks two separate postMessage requests without recreating that worker.
It additionally exercises a Lisp-level `error`, checks ECL safe-eval's NIL
fallback, then verifies a marker from the next Lisp request. Internal and
external recovery evidence are kept separately.
Runtime exceptions/protocol failures remain failures. This is not yet the
production CAS/author/runtime outcome taxonomy or a cancellation adapter.

## Evidence and limits

`reports/runtime-callentry/attempts` preserves failed development runs rather
than treating partial results as success. The first full attempt omitted the
existing numeric-option parse fallback. The second passed all direct CAS
programs, then failed a harness assertion that incorrectly expected
`validate().valid` rather than `validate().status`. Earlier setup diagnostics
found Git's Windows newline conversion changed a preload JSON byte count,
which the existing hash check rejected; a stale Playwright browser path also
failed to launch. Corrected staging uses exact blob bytes and installed
Chrome locally; CI installs its pinned Playwright browser.

No startup acceleration is attempted. Cancellation, Firefox/WebKit, memory
retention over long sessions, broader native questions, the old STACK pin and
the complete 316-program replay remain outside this spike. Any assumption
about their behaviour is unmeasured. The pending licence-notices PR remains a
base-branch dependency ([PR #4](https://github.com/Erasmus-CTM/stack-wasm-maxima/pull/4));
its files do not overlap this change, and this step does not duplicate its licence texts.
Independent review caught an incorrect direct optional argument in the initial
safe-eval adapter: ordinary Maxima errcatch success did not exercise ECL's error
fallback. The real varargs stack slot and explicit Lisp-level recovery checks
address that gap. It also prompted strict timeout/failure/message-completeness
checks before any route is marked passed.
