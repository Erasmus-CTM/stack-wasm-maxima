# Runtime-v3 against the same profile on Emscripten 6.0.11

**Decision: no runtime-v4.** Built with Emscripten 6.0.11 instead of 4.0.10, the
runtime-v3 compiler profile (`ecl-oz-maxima-oz`) is not faster on the native
questions page. Start-up is 2–4% slower and checks are within run-to-run
variation. The AGENTS.md rule asks for a sustained gain of about 3% or more, so
runtime-v3 stays the served runtime.

## What was compared

| | runtime-v3 (served) | Trial |
|---|---|---|
| Compiler profile | `ecl-oz-maxima-oz` | `ecl-oz-maxima-oz` |
| Emscripten | 4.0.10 | 6.0.11 |
| Source | `runtime/release.json` → `runtime-v3` | runtime-build run [40323133024](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40323133024), commit `779a5d4a6e9ef338e6d238eeeb787582f0fe9691` |
| Artifact | release asset | `owned-runtime-ecl-oz-maxima-oz-779a5d4…`, id 12666332321, `sha256:f435d7c987f52687b24d4b53ae2711a8c9e25fcbcafebf4474bf8e716f87c77b`, expires 2027-01-24 |
| Acceptance | released | every runtime-build acceptance gate passed |

Measured by `page-timings-owned.yml` run
[40359127907](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40359127907)
at commit `3226c47`, on one `ubuntu-24.04` runner. That run was started by a push, with
these trial values as workflow defaults; the workflow on main takes them as
dispatch inputs instead. Each column is the committed
native questions page rendered locally with that runtime, except "Live public
page", which loads https://erasmus-ctm.github.io/stack-wasm-maxima/maxima/native.html
(runtime-v3) over the network. The workload is the rational-equivalence question,
clicked through the page UI by `scripts/measure-native-page-timings.mjs`.
Values are medians (min–max) of 3 fresh browser starts. The quarter-CPU
pass runs the browser under `systemd-run -p CPUQuota=25%`. That is a
test-machine setting, not a model of any laptop. Python-checked rows are skipped
there (`TIMING_SKIP_PYTHON=1`).

## Results, run 40359127907

### Full speed

| | Live public page | PoC1 (deployed runtime) | runtime-v2 | runtime-v3 | ecl-oz-maxima-oz on 6.0.11 (trial) |
|---|---:|---:|---:|---:|---:|
| First Validate click (includes Maxima + STACK start-up) | 11.2 s (10.2 s–11.4 s) | 30.8 s (30.7 s–31.0 s) | 16.4 s (16.3 s–16.5 s) | 9.3 s (9.0 s–9.7 s) | 9.5 s (9.3 s–10.2 s) |
| …of which Maxima + STACK start-up | 11.1 s (10.1 s–11.3 s) | 30.6 s (30.5 s–30.9 s) | 16.3 s (16.2 s–16.4 s) | 9.2 s (8.9 s–9.6 s) | 9.4 s (9.2 s–10.1 s) |
| Later Validate | 68 ms (66 ms–101 ms) | 110 ms (106 ms–115 ms) | 80 ms (76 ms–85 ms) | 67 ms (64 ms–99 ms) | 69 ms (65 ms–72 ms) |
| First Check | 238 ms (233 ms–242 ms) | 352 ms (351 ms–354 ms) | 304 ms (302 ms–319 ms) | 232 ms (230 ms–233 ms) | 241 ms (238 ms–241 ms) |
| Later Check | 227 ms (223 ms–276 ms) | 344 ms (337 ms–421 ms) | 261 ms (253 ms–308 ms) | 221 ms (218 ms–261 ms) | 222 ms (215 ms–262 ms) |
| First Python-checked grade (includes Python start-up) | 6.1 s (6.1 s–6.3 s) | 6.2 s (6.1 s–6.3 s) | 6.2 s (6.2 s–6.2 s) | 6.1 s (6.0 s–6.1 s) | 6.0 s (6.0 s–6.1 s) |
| …of which Python start-up | 5.8 s (5.8 s–6.0 s) | 5.9 s (5.8 s–5.9 s) | 5.9 s (5.9 s–6.0 s) | 5.8 s (5.8 s–5.9 s) | 5.8 s (5.8 s–5.8 s) |
| Later Python-checked grade | 228 ms (222 ms–262 ms) | 335 ms (327 ms–413 ms) | 262 ms (257 ms–295 ms) | 221 ms (217 ms–256 ms) | 221 ms (218 ms–257 ms) |

### Quarter of one CPU

| | PoC1 (deployed runtime) | runtime-v2 | runtime-v3 | ecl-oz-maxima-oz on 6.0.11 (trial) |
|---|---:|---:|---:|---:|
| First Validate click (includes Maxima + STACK start-up) | 149.9 s (148.3 s–150.3 s) | 81.5 s (80.9 s–82.4 s) | 50.5 s (50.5 s–51.5 s) | 52.4 s (51.6 s–53.0 s) |
| …of which Maxima + STACK start-up | 149.1 s (147.2 s–149.3 s) | 80.8 s (80.3 s–81.7 s) | 50.0 s (50.0 s–50.9 s) | 51.8 s (51.0 s–52.6 s) |
| Later Validate | 601 ms (495 ms–995 ms) | 501 ms (381 ms–596 ms) | 387 ms (316 ms–571 ms) | 401 ms (314 ms–611 ms) |
| First Check | 1.8 s (1.8 s–1.9 s) | 1.4 s (1.4 s–1.5 s) | 1.3 s (1.2 s–1.4 s) | 1.3 s (1.2 s–1.4 s) |
| Later Check | 1.7 s (1.6 s–2.0 s) | 1.3 s (1.2 s–1.5 s) | 1.1 s (999 ms–1.3 s) | 1.1 s (1.0 s–1.2 s) |

The live page was measured at full speed only.

### Trial against runtime-v3

Positive = the trial is slower.

| Medians | Full speed | Quarter CPU |
|---|---:|---:|
| Maxima + STACK start-up | 9.2 → 9.4 s (+2%) | 50.0 → 51.8 s (+4%) |
| First Check | 232 → 241 ms (+4%) | 1.3 → 1.3 s (0%) |
| Later Check | 221 → 222 ms (0%) | 1.1 → 1.1 s (0%) |
| Later Validate | 67 → 69 ms (+3%) | 387 → 401 ms (+4%) |

Only start-up separates the two outside the min–max ranges, and it favours
runtime-v3.

## Earlier runs on the same workflow

Absolute times differ between runners, so compare columns only within one run.

- **Run [40352568243](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40352568243) (commit `6698ee1`).** It compared plain `ecl-oz` on 6.0.11, without `maxima-oz`. Start-up was 8.9 s for v3 against 10.4 s for that build at full speed, and 47.4 s against 57.0 s at a quarter CPU. Later Check was 220 ms against 257 ms.
- **Run [40339054529](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40339054529).** At a quarter CPU, start-up was 30.5 s for v3 against 36.9 s for the same plain `ecl-oz` 6.0.11 build. That runner was 1.6 times faster than run 40359127907's.

The 6.0.11 speed-ups seen earlier in the compiler trials were measured against
the slower baseline profile. Once both toolchains use runtime-v3's profile,
6.0.11 adds nothing. The trial build remains usable if 4.0.10 has to be
replaced for other reasons.

## Reproducing

Dispatch `.github/workflows/page-timings-owned.yml` with `runtimes: poc1 v2 v3 trial`,
`trial_run_id: 40323133024`, `trial_artifact_id: 12666332321`,
`trial_profile: ecl-oz-maxima-oz` and `trial_emsdk: 6.0.11`. Each run uploads
`page-timings-owned-<sha>` with every `summary.json`.

Timings on real devices are collected with the start-up page,
https://erasmus-ctm.github.io/stack-wasm-maxima/maxima/startup.html.
