# Codex prompt: own Maxima/ECL Wasm runtime, steps 0 and 1

Run settings (AC): development on 6.1 Sol at medium reasoning (xhigh for hard
build problems); every independent review on Astra at xhigh.

---

You work in `Erasmus-CTM/stack-wasm-maxima`. Read first, in this order:

1. `reports/2026-10-22-system-design-audit.md`: §3.4 (startup files), §4 F-2
   (call entry), F-9/F-14 (provenance, offline closure), §6 (runtime ownership:
   route, exact pins, order, effort), §8 (AC's decisions, especially D3, "own
   build, not a fork", "reporting").
2. `prototype/runtime/maxima-session.js` and `maxima-child.js` (today's
   stdin/`SharedArrayBuffer` transport, preload, the ioctl and MEMFS fixes and
   why they exist: `reports/2026-10-21-wasm-loader-investigation.md`).
3. `scripts/milestone-two/fetch-runtime.mjs`, `prepare-runtime.py` and
   `measurements/2026-10-21-runtime-*.json` (where the current binaries come
   from and their hashes); `.github/workflows/site.yml`,
   `scripts/milestone-three/browser.mjs` and `native-reference.py` (browser
   checks and the 316-program desktop replay).

The runtime today is downloaded from `https://maxima-on-wasm.pages.dev/`
(Marius Gerbershagen's Emscripten port, GitLab `mgerbershagen/maxima`, branch
`emscripten-port-deployed`; Maxima reports `branch_5_49_base_90_g813903d33`,
ECL 26.3.27). AC decided that CTM builds it itself from pinned upstream
sources (not a fork), with exact pins and a tracking job. This run covers
steps 0 and 1 of §6 only. Trims, compression, precompiled STACK, the snapshot
and switching the published site to the new runtime are later steps.

## Step 0: call-entry spike with the existing binary (time-box: 2 working days)

Question: can the worker evaluate one Maxima/STACK program per request by
calling into ECL directly, instead of writing to a REPL's stdin, so that no
`SharedArrayBuffer` and no cross-origin isolation is needed?

Known: the deployed `libecl.so` exports `si_safe_eval`, `cl_eval`,
`si_string_to_object` and `cl_boot`; `maxima.wasm` uses unshared memory (no
threads). Unknown: how to get control back to JavaScript after Maxima and
STACK have loaded (today `main()` stays in the REPL, blocked in `readChar`).
Possible routes, to try in this order and to report on each: stdin pre-filled
with the startup script and EOF afterwards so `main()` returns with the
runtime kept alive, then calls through the exports; an exported entry the
port already has; anything else you find in the port's sources. No rebuild in
step 0.

Done when, or report why not:
- a research prototype (new files under `prototype/runtime-callentry/`, no
  change to the existing transport) runs in a worker on a page **without**
  cross-origin isolation, loads the pinned STACK library, and evaluates
  through the call entry: the 22 milestone-one answer-test probes and one
  native prepare/validate/grade program of `native-rational`, with results
  identical to today's transport;
- a CAS error inside a program returns as a result and leaves the session
  usable (audit F-3);
- it records readiness and per-call times next to today's transport.

A negative result is a valid outcome: report what blocks it and whether the
rebuild in step 1 can remove the blocker.

## Step 1: reproduce today's runtime from source

1. **Identify the sources** exactly: the port commit that produced the
   deployed binaries (check `g813903d33` against the branch history), the ECL
   source and commit, the Emscripten/emsdk version (look for it in
   `maxima.js` and the port's scripts), gnuplot and any other library inside
   `libecl.so` (GMP, Boehm GC, libffi; `strings` on the deployed files), and
   the port's build scripts. Record them in a pins file (for example
   `runtime/build/pins.json`): repository, exact commit or version, archive
   SHA-256, licence. No version ranges: exact pins are AC's decision for this
   runtime.
2. **Build in GitHub Actions** with a new workflow (for example
   `runtime-build.yml`; `workflow_dispatch` plus pull requests touching its
   paths): standard Ubuntu runner, emsdk and the native host ECL (the wasm32
   cross-build needs a 32-bit host ECL) cached by their pins; the build
   configuration as close to the port's as possible. Output: every runtime
   file the current `prepare-runtime.py` stages, plus a manifest (path, bytes,
   SHA-256), a size table against the deployed files, the build log, and the
   licence texts and source manifest. Artifacts only; no release and no tag
   (AC creates tags).
3. **Validate by substitution.** Add an opt-in path (environment variable or
   script option, default unchanged) that stages the self-built files instead
   of downloading from `maxima-on-wasm.pages.dev`, and run with it: the
   milestone-one 22 probes at both STACK pins, the native page's browser checks
   (`browser.mjs`), and the 316-program desktop replay
   (`native-reference.py`) with zero unaccepted differences. Bit-identical
   binaries are not required; behaviour is. Record cold readiness and warm
   call times next to the deployed runtime's.
4. **Oracle from the same source (stretch).** If feasible within step 1, build
   the desktop Maxima of the replay from the same Maxima commit (native ECL),
   so browser and oracle are the same version (audit F-9). Otherwise report
   the effort and leave it for the next step.
5. Note for step 2, without doing it: what could be left out or compressed
   (plot module and `libgnuplot.so`, size optimization, compression per file
   type), with sizes.

## Rules (binding, from AC)

- **AC merges everything**, with merge commits. Never merge, never force-push a
  published branch, never create tags or releases.
- **Commits** are authored and committed as `Andrey Chesnokov
  <aacchhee@gmail.com>`, with a trailer naming the agent and model that did the
  work.
- **One PR per step** (step 0, step 1), each with an independent review by a
  fresh reviewer (Astra, xhigh) until nothing substantive remains, and CI green
  before asking AC to merge.
- **Report to AC at the end of each step**, before starting the next: what was
  done, the evidence (CI runs, parity results, timings, sizes), deviations from
  the audit, and the decisions needed. Step 1 starts only after AC's go for
  step 0's report, unless AC says otherwise.
- Do not modify STACK's sources or Maxima's mathematical sources. Any build
  patch is a separate, documented file with its reason, and is offered
  upstream (port or ECL) if it would otherwise be carried.
- Do not change the published site's runtime or the existing transport in
  these steps; new code goes next to it.
- New code is AGPL-3.0-or-later. Keep upstream licences and notices with every
  built file. A separate PR (`licenses/2026-10-third-party-notices`) adds
  licence texts to the site; build on it, do not duplicate it.
- Public text describes only what our engine does; never describe STACK's
  behaviour on security matters.
- Mark anything not measured as a hypothesis. Never present a failed or
  partial run as success; keep failed attempts' evidence.

## Environment notes

GitHub GraphQL may be blocked: use the REST API (`gh api repos/...`). Downloads
from the sandbox may be restricted; the CI runner is the authority for builds
and browser runs. Quarto 1.8.27, Node 22, Python 3.12 as in the existing
workflows.
