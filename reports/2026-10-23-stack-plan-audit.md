# Audit of the STACK backend plan

23 October 2026. Read-only audit of the work plan and decisions in
[`2026-10-22-system-design-audit.md`](2026-10-22-system-design-audit.md)
(§7, §8; "the plan"), checked against what has happened since and the
documents it depends on: this repository at `main` `9d6bf6f` with open PRs #13
and #16; ctm-assessment `main` `15b0b23` and `handoff/2026-10`; ctm-checkers
`main` `76ec14e` and the S-fix chain #10–#13; stack-sympy `main` `a0c45d1` and
#28.

**Method.** Documents and Git history read; PR descriptions and their CI
summaries as reported. Nothing was rebuilt or re-measured. Timings quoted from
PRs are their own figures, mostly two samples on one runner.

## Verdict

The plan's direction holds: two backends with distinct roles, one block and
one result contract, an owned exactly pinned runtime, desktop STACK as the
reference. Two things need attention before the next phase starts:

- **The runtime evidence has moved past the plan.** Its startup model ("only
  a snapshot or precompiled STACK can shorten the 38 s") is contradicted by
  the compiler result, and its preferred remedy (L2) has not yet shown a gain.
  The order in §6 and §7 needs re-planning with an explicit go/no-go target
  (A-1, A-2, A-3).
- **M4a and M4d depend on work that has no design.** Step 6 ("stack-sympy onto
  the shared runtime") is not started and has no design document, and the
  documents the plan calls binding are not on ctm-assessment `main` (A-4,
  A-5).

The other findings are consistency fixes and ordering risks. None argues
against the plan's direction.

| # | Finding | Severity |
|---|---|---|
| A-1 | ECL compiled with `-Oz` halved cold start (38.3/38.8 s → 20.0/20.0 s); the plan's startup model and remedy ranking predate this | high |
| A-2 | Precompiled STACK (L2) has shown no gain so far (entry FAS 39.3 s against source 36.2/37.8 s, diagnostic run with failed reset checks) | high |
| A-3 | No measurable acceptance target or go/no-go point for the Maxima backend; the snapshot (L1) "may fail" and the plan has no branch for that | high |
| A-4 | M4a depends on step 6, which is not started and has no design; checker routing (§5.4) depends on P13, also undesigned | high |
| A-5 | The binding documents (variants with decision 20, step 5 offline/exam) exist only on `handoff/2026-10`; ctm-assessment `main`'s step table is stale and numbers steps differently | medium |
| A-6 | D5 is now due: M4c step 1 is done, so STACK's compiled PRT should be evaluated before M4a ports the JavaScript controller | medium |
| A-7 | Instant validation (trial) can ship before S-12 (long-running inputs) and F-13 (cancellation) | medium |
| A-8 | D1 does not address Moodle seeds made under another STACK version than CTM's single pin; "one STACK pin" is still two | medium |
| A-9 | Internal inconsistencies: "pure-Python build" vs Deno at build; the D2 default; D2 recorded twice; the open amendment item is stale | low |
| A-10 | The S-fix order omits S-03, which still needs an owner decision; S-14 to S-19 have no home in the plan | low |
| A-11 | The delivery estimate assumes precompressed serving, which GitHub Pages cannot do (runtime review F-7) | low |

## Findings

### A-1 The compiler result changes the startup picture

The plan (§3.4) says: "Fewer modules do not shorten the 38 s: that is STACK's
own library loading, addressed only by L1 and L2". PR #12 (merged 23 Oct)
measured the ECL core built at `-O0` in the baseline. With `-Oz` scoped to
ECL, two cold samples gave 19.95/20.02 s against 38.30/38.79 s, and `libecl.so`
shrank from 7.97 to 5.28 MB. The 316-program replays, the 22 probes at both
STACK pins and the browser checks passed for every profile.

That is two samples on one runner, not a statistical estimate. Even so, it is
the largest startup gain measured so far, and it comes from a build flag, not
from L1 or L2. Consequences:

- §1 F-1 ("38.6 s, blocking") and §3.3's ranking are out of date. The remedy
  table needs a row for compiler optimisation, ranked first.
- `-Oz` is not the default and is not published. Promoting it needs a
  decision and the same gates as the other runtime steps.
- The rest of the startup time should be profiled again on the `-Oz` build
  before more effort goes into L1 or L2. The 62.5 s instrumented split in
  §3.2 was measured on the `-O0` build.

**Recommendation.** Add an M4c step "compiler profile": promote `-Oz` (or
`-O2`) after a few more samples, including one on a slower machine. Then
re-profile, and re-rank L1, L2 and L4 on the new numbers.

### A-2 Precompiled STACK has not paid off yet

PR #13 (draft) compiles STACK's entry module to a browser-target FAS. Its
latest frozen diagnostic (run 40018888353) observed 39.25/39.26 s cold for the
compiled entry against 36.15/37.81 s for the source. Every sample failed the
first reset check, so the PR itself says these runs establish neither a
speedup nor parity. That is the right reading. It also means that after a day
of work, L2 has no positive evidence and has a correctness problem (state
after a reset). The plan treats L2 as one of the two "only path[s] to
SymPy-like startup" and estimates it at "about a week".

**Recommendation.** Give L2 a time box and an exit criterion: for example, a
gain of at least 20 % over the `-Oz` source build with all reset checks
passing. If it doesn't meet that, park it. A-1 suggests the time may be
better spent on profiling and L4 (load statistics and linear algebra on
demand, 62.5 → 37.8 s instrumented).

### A-3 No acceptance target and no fallback

The plan says what Maxima must reach ("SymPy-like startup") only in prose,
and says the snapshot "may fail" without saying what follows. AC's decisions
already make Maxima the backend for full STACK. If startup stays at 15–20 s,
that role is limited to single pages, and §3.3 already says the backend then
fits "single-page practice sets where L3 hides the wait, not course-wide
default use".

**Recommendation.** Record a target and a decision point in §8. For example:
cold readiness on a reference student laptop under *X* s, and a warm-profile
revisit under *Y* s. Measure both before the snapshot is started. State what
the Maxima backend is used for if the target is missed: opt-in per question,
L3 preload, with a notice on the card. The warm-profile reload measurement
the plan asks for (§3.2) is still not done (runtime review, "Not yet done").
It may change the urgency of L1 more than anything else.

### A-4 M4a and M4d rest on undesigned steps

- M4a "depends on: step 6 frontend/worker in stack-sympy". The handoff
  (`HANDOFF-2026-10.md`, row 6) records step 6 as "not started", and
  ctm-assessment has no step-6 design. The backend descriptor (F-5 item 2),
  the plan format, the error protocol and the rename to ctm-stack all land
  in that undesigned step.
- §5.4 routes checker calls to "the planned worker for standalone pages,
  P13". P13 is step 5 in ctm-assessment `main`'s table, which also has no
  design.
- M4d's other prerequisite is closer than the plan says:
  `ctm_checkers/core/custom.py` now exists on ctm-checkers `main` (the
  shared runner of step-2 §9). §5.1's "does not exist yet" is out of date.

**Recommendation.** Write the step-6 design next, before any M4a code. It
should cover the descriptor, the plan format, the error protocol (F-3), the
rename, and how SymPy cards move onto ctm-libs' worker. Review it like steps
1–4. Fold P13 into it, or say that M4d uses the Maxima worker's own Pyodide
until P13 exists (F-7's "second Pyodide" then stays as a known cost).

### A-5 The binding documents are not on `main`

The plan cites the variants design (decisions 13 and 20) and the step-5
offline/exam design as binding. Both, and the variants review, exist only on
ctm-assessment `handoff/2026-10`. The amendment the plan lists as open
("Amendment PR in ctm-assessment for the variants design") was written and
merged as #49, but into `handoff/2026-10`, not `main`. ctm-checkers' variants
docs link to the handoff branch.

ctm-assessment `main`'s consolidation table still ends at "5 | Worker for
standalone pages (P13), preload and status lamp (P16)". The plan meanwhile
says "step 5 offline/exam" and "step 6 stack-sympy onto ctm-libs". The handoff
uses yet another list. The same step number now names different work in
different documents.

**Recommendation.** Merge the design documents from `handoff/2026-10` into
ctm-assessment `main`, and update the README table to one numbering: steps 5
and 6, P13/P16, variants, H1 and the M4 phases. Then update this plan's
references and §8's open item.

### A-6 D5's evaluation is now due

D5 evaluates STACK's compiled PRT and CASText code "as the native controller
after the first runtime milestone (M4c step 1)". Step 1 (#7) is merged. M4a
says the native code "moves in … written against the new descriptor". If M4a
starts first, the JavaScript `NativeStackEngine` (F-6, a second controller)
is rewritten into ctm-stack and may then be replaced.

**Recommendation.** Run the D5 evaluation as a short spike before M4a. Can
STACK's PHP compiler emit PRT and CASText code at the exact pin in CI? Does
that code run under the call entry? What does PHP in CI cost? Port the
JavaScript controller only if the answer is no.

### A-7 Instant validation needs its guards first

The "No Validate button" trial runs CAS validation automatically after a
typing pause. Under the SymPy backend, S-12 (inputs that run for minutes)
lands late in the S-fix order (fifth). Under Maxima, F-13 (dropping
superseded requests, interrupt before restart) is in M4a's scope but not
ordered before the trial. Automatic validation turns these from rare events
into ones a student can trigger by typing. A timeout then blocks every card on
the page (F-13), or on a shared runtime every component (S-12).

**Recommendation.** Make the trial depend on S-12's budgets for SymPy and on
F-13's cancellation for Maxima. Until both exist, keep the default at
`validation: button`.

*Applied 23 October*, per backend (AC): each backend uses `button` until its
guard exists; `instant` stays the intended default (plan §7 M4a, §8).

### A-8 Moodle seeds and the single STACK pin

D1 reproduces Moodle's deployed variants. The acceptance test checks the
seed path and Maxima's Mersenne Twister under ECL. A course's
`<deployedseed>`s were generated by that Moodle's STACK version, while CTM
runs one exact pin. A change to a STACK random function or question-variable
evaluation between those versions changes the variant without any RNG
difference.

Meanwhile "one exact STACK pin" (M4a, D3) is still two. #13 builds for
`3338304` and `10d3233`, and ctm-checkers' `student_input` still uses
`10d3233`.

**Recommendation.** Record the source STACK version in the import (it is in
the Moodle export's metadata or known per site). Compare question notes,
which the plan already does, and report a mismatch as "different STACK
version", not as an import failure. Choose the one pin before M4a and record
it in §8.

*Applied 23 October* (AC): the pin is STACK 4.14.0 (`3338304`), plan §8 D3a,
which lists what moves from `10d3233`. A seed whose note differs is reported
as "different STACK version" and not approved automatically (§8 D1, F-8).
The move itself (ctm-checkers' oracle, fixtures, goldens and corpus) is
still to do.

### A-9 Inconsistencies in the text

- F-8 says "SymPy-graded questions keep a pure-Python build". §8 (one input
  admission) says "SymPy-graded STACK questions need Deno at build, not only
  Python". Probably F-8 means variant generation only. Say so.
- §8 D2 says "the default does not matter". F-5 item 1 says "Default
  `sympy` … keeps [ctm-demo] unchanged". Keep the reason and state the default
  once.
- D2 appears twice in §8 (selection, then names). Merge the two entries.
- "Open after the independent review: amendment PR in ctm-assessment" is done
  (#49, see A-5).
- §1 F-2's mitigation is done: step 0 (#5) runs without cross-origin isolation
  through the call entry. §1 should note it as solved in principle, pending
  the production worker.

*Applied 23 October* in the plan, with the stale items of A-1 (F-1, L0 in
§3.3, §3.4), A-4 (`core/custom.py`), A-5 (the amendment) and the licence
notices, plus a runtime status line in §6. AC left the default CAS open; D2
says so.

### A-10 S-fix list

§8 lists S-07, S-05, S-10, S-11, S-12, S-04, S-08, S-09, S-06. S-01, S-02 and
S-13 are merged (handoff). Missing from the list:

- **S-03** (log/root/abs equivalence) needs an owner decision between
  following STACK and keeping principal branches with a notice. The step-2
  design gives it a `Semantics` switch. Under the backend roles, "SymPy
  differs from STACK here; use `cas: maxima`" is an option worth stating.
- **S-14 to S-19** (source panel on course pages, P22 without AI feedback,
  the second Pyodide, English-only UI, accessibility, small answer-test
  differences) belong to step 6 or M4g. They should be listed there so they
  are not lost.

The first four fixes are in flight as ctm-checkers #10–#13 plus stack-sympy
#28. #10 is on hold for fresh CI and a final review. Each of the reconciled
heads is now a `.dev0` version above the recorded 0.7.0–0.10.0 releases.
stack-sympy #28 still pins the 0.10.0 release commit `75284f7`, which is in
the chain's history.

### A-11 Delivery size assumes compression the host can't do

§6 estimates "about 8–10 MB compressed" for loading the runtime from the
course site. #8 confirmed 8.43 MB with precompressed sidecars. GitHub Pages,
where the courses are hosted, cannot serve those sidecars or choose the
encoding per file (runtime review F-7). Pages may apply its own gzip to some
types; that is still unmeasured. Until it is measured, the public-site figure
is unknown. It lies somewhere between 8.4 MB and about 42 MB.

## What is on track

- Steps 0 and 1 of the runtime are done and gated: call entry without
  isolation, an owned build from pinned sources, replay parity with a
  same-source desktop oracle (closing F-9's version mismatch), and lossless
  compression. gnuplot is removed (F-4 of the runtime review).
- Licence notices for the deployed site are merged
  (`licenses/2026-10-third-party-notices`), the "Now" action of F-9/F-14.
- D7 (December exam Pyodide-only) keeps the Maxima work out of the exam's
  critical path.
- The H1 shared runner exists in ctm-checkers, and D4's scoring matches the
  step-2 H1 decision and variants decision 13.

## Suggested revised order

1. Re-plan M4c on the new evidence: promote a compiler profile, re-profile
   startup, add the warm-profile measurement, and set the target and decision
   point (A-1, A-3). Give L2 a time box (A-2). Snapshot afterwards.
2. In parallel, documents only: the step-6 design (A-4), the D5 spike's
   question list (A-6), merging the handoff designs to `main` with one step
   numbering (A-5), and the one STACK pin (A-8).
3. M4a after the step-6 design and D5, with instant validation behind S-12
   and F-13 (A-7).
4. M4b, M4d, M4e, M4f, M4g and M4h as in the plan.

## Sources

- This repository: `reports/2026-10-22-system-design-audit.md`,
  `reports/2026-10-23-runtime-steps-review.md`,
  `reports/2026-10-23-runtime-review-followups.md`, PRs #5, #7, #8, #12 (merged)
  and #13 (draft).
- ctm-assessment: `docs/consolidation/README.md` and `stack-sympy-audit-2026-10.md`
  on `main`; `HANDOFF-2026-10.md`, `docs/consolidation/2026-10-variants.md` and
  `2026-10-step5-offline-exam.md` on `handoff/2026-10`; PR #49.
- ctm-checkers: `src/ctm_checkers/core/custom.py` on `main`; PRs #10–#13.
- stack-sympy: PR #28.
