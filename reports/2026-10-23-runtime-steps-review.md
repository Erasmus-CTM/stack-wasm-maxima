# Review of the runtime work: step 0, step 1 and compression

23 October 2026. Read-only review of three stacked pull requests:

| PR | Branch | Head | Base |
|---|---|---|---|
| [#5](https://github.com/Erasmus-CTM/stack-wasm-maxima/pull/5) Step 0: direct ECL call entry with the deployed runtime | `runtime/2026-10-callentry-spike` | `434fee9` | `main` |
| [#7](https://github.com/Erasmus-CTM/stack-wasm-maxima/pull/7) Step 1: reproduce the Maxima/ECL Wasm runtime from pinned sources | `runtime/2026-10-owned-build` | `a47f78b` | #5 |
| [#8](https://github.com/Erasmus-CTM/stack-wasm-maxima/pull/8) Pre-step 2: lossless gzip/Brotli sidecars | `runtime/2026-10-runtime-compression` | `1313ae0` | #7 |

Context: the system design audit (`reports/2026-10-22-system-design-audit.md`,
§6 and §8, D3) and the Codex prompt (`plans/2026-10-codex-runtime-steps-0-1.md`).
AC authorized step 1 and the compression measurements to proceed without a
separate approval checkpoint after step 0.

**Method.** I read the code, workflows, pins and committed reports on each
branch. I checked CI run conclusions and step durations through the GitHub API.
I did not download the Actions artifacts or rerun builds, so every result
quoted below is as reported by CI and the PR evidence.

## Verdict

These are careful pieces of work. None has a blocking finding. Recommended merge
order: #5 (after merging `main` into it), then #7, then #8; all three are
currently mergeable without conflicts. Four findings need a decision by AC
(F-4, F-6, F-7, F-8); the others are small follow-ups.

## What was achieved

- **Step 0 (#5).** The deployed binary runs without cross-origin isolation.
  After STACK has loaded, `main()` returns (EOF route; `to-lisp` as fallback)
  and ECL's `si_safe_eval` evaluates programs directly.
  - [CI run 39861698997](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39861698997)
    shows:
    - 28 programs identical to the current stdin transport;
    - 22/22 frozen native probes;
    - `native-rational` prepare, validate and grade at full score;
    - Unicode and CASText round trips.
  - The Unicode bug found in review is fixed: non-ASCII characters are rebuilt
    with Lisp `code-char`.
  - Recovery in the same worker works after a CAS error, a Lisp error, a
    malformed program and unbounded recursion.
  - 300 consecutive calls kept a stable Wasm stack pointer and 128 MiB linear
    memory capacity. That is capacity, not the live heap.
  - Running without isolation (audit F-2) therefore no longer waits for an own
    build.
- **Step 1 (#7).** Maxima `813903d33`, ECL `e4bdb2e5` (26.3.27) and Emscripten
  4.0.10 are built in CI from hash-verified sources and toolchain archives.
  - Results ([run 39870918765](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39870918765);
    build step about 26 minutes, whole run about 44):
    - 22/22 probes at both STACK pins match the deployed runtime;
    - the native browser checks pass;
    - 316/316 programs agree with Ubuntu's Maxima (307 exact);
    - 316/316 agree with a desktop Maxima built from the same source
      (310 exact, 6 presentation-only).

    The same-source oracle closes the 5.46/5.49 version mismatch (audit F-9).
  - Owned runtime size: 81 files, 56.58 MB, against 57.08 MB deployed.
  - Readiness is about 38.7 s, against 38.2 s for the deployed runtime, as
    expected with unchanged compiler flags.
  - The owned runtime is opt-in; the default and the published site are
    unchanged.
- **Compression (#8).** Lossless gzip-9 and Brotli-11 sidecars of the owned
  runtime, with every encoded file decoded and hash-checked. Brotli goes to
  ordinary fetches, gzip to lazily loaded files and identity to byte ranges.
  - Runtime bytes a native page actually received
    ([run 39875818721](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39875818721)):
    **8.43 MB** with the mixed policy and 10.51 MB with gzip only, against
    about 42 MB uncompressed. The audit's estimate was 8–10 MB.
  - Parity: the browser checks and the 316-program replay pass under both
    policies. A preload-disabled probe confirmed the lazy-loading and
    byte-range behaviour.

## Findings

### Step 1 (#7)

**F-1. The build environment is not fully pinned.** Sources and the
Emscripten/Node archives are exact-pinned and hash-verified. The build
environment is not:

- the `ubuntu-24.04` runner image;
- the apt packages `gcc-multilib`, `autoconf`, `automake`, `libtool`,
  `texinfo`, `bison`, `flex` and `gettext`.

They affect the output:

- the 32-bit host ECL is compiled by Ubuntu's GCC;
- `libtoolize --copy` generates part of gnuplot's build from Ubuntu's libtool.

Proposal: record `dpkg-query -W` versions and the runner image version in the
artifact now. For release builds, use a digest-pinned container image, or
Ubuntu's snapshot archive.

**F-2. Reproducibility is not demonstrated.** One build exists. Run the build
twice from cold caches and compare file hashes. Either outcome is useful: the
documentation should then say "reproducible" or "rebuildable with equivalent
behaviour", and list which files differ.

**F-3. The cached host ECL executes unverified.** The SDK archives are
hash-checked on every cache restore. The cached 32-bit host ECL executable is
only checked for ELF format and fixnum width before it runs and compiles the
cross ECL. Proposal: record its SHA-256 at first build and verify it on
restore, or rebuild it without the cache for release builds.

**F-4. gnuplot is the weak spot, and it is optional (decision for AC).**

- It is the only component that needs a CTM build patch: host tuple, PIC and a
  side-module link.
- Its source pin (`525fa748`) is a reconstructed candidate; the binary does not
  attest it.
- The owned library differs in size from the deployed one (3.41 vs 3.94 MB).
- No test exercises plotting, so it is functionally unverified.

The audit already treats `plot()` as legacy and plans to leave the plot module
and gnuplot out (§3.4, §8). Recommendation: decide now to drop plot and gnuplot
in step 2, with a lightweight `set_plot_option` for STACK's load-time call.
That removes the only patch, the unattested pin, the gnuplot licence question
and the pending upstream offer (F-5) at once, and saves about 5 MB.

**F-5. The upstream patch offer is not posted.** Codex has no GitLab account.
If gnuplot stays, posting the patch to `gitlab.com/mgerbershagen/maxima` needs
AC; if it is dropped (F-4), the offer is unnecessary.

**F-6. The owned runtime expires with its artifact (decision for AC).**

- The binaries, source bundle and evidence exist only as Actions artifacts,
  kept for 90 days (until about 21 January 2027).
- Nothing is published.

After #7 merges, the next decision is a release: a tag created by AC, with a
workflow that attaches the artifact with its manifest, sources and licence
texts to a GitHub Release (audit §6).

### Compression (#8)

**F-7. The policy cannot be deployed on GitHub Pages (decision for AC).**
GitHub Pages cannot serve precompressed sidecars or choose the
`Content-Encoding` per file. So the tested policy only applies to servers we
run ourselves: exam and offline servers, and colleagues' offline tests. Its
home is therefore step 5's offline server and asset lock in ctm-assessment.
Proposals:

- carry the sidecars and the policy into the asset lock;
- document an nginx/Apache configuration (`gzip_static`, `brotli_static`,
  identity for ranges, `Vary: Accept-Encoding`);
- measure what GitHub Pages currently sends for `.wasm`, `.so` and `.fas`
  files, which still decides the public site's transfer size.

**F-8. The page HTML is now the largest download.** The native page is 16.9 MB
of HTML, about 6.0 MB gzipped: nine copies of a base64 board page that embeds
JSXGraph twice. That compares with 8.4 MB for the compressed runtime. The audit's
"one board template per question" remedy (L6) is now the largest remaining
transfer saving, and it matters for any course with boards.

**F-9. Brotli everywhere is possible later.** Brotli is limited to five files
because Emscripten's lazy loader recognizes only gzip when it asks the server
for a decoded file length. A production call-entry worker could take file
lengths from the runtime manifest instead of `HEAD` requests, which would allow
Brotli for all files (all-Brotli sidecars: 9.13 MB packaging total).

### Step 0 (#5)

**F-10. The branch is behind `main`.** It is 9 commits behind `main`, because
#4 and #6 merged after it branched. It merges without conflicts, but the merge
protocol requires every branch to be up to date with its base. Merge `main`
into it before AC merges, and refresh the stacked branches afterwards. The PR
text that says the licence PR "should land first" is now out of date.

**F-11. Definitions persist between programs.** The recursion test defines
`_ctm_spike_recurse` globally, and the definition stays in the session. That is
harmless in the spike, but a production worker needs per-question isolation or
reset (audit §4, general namespace isolation). This is a known later item, not
a defect of this PR.

**F-12. Recovery is shown for one trap kind.** Unbounded recursion was caught
by Maxima's `errcatch` and the worker recovered. Other Wasm traps (memory
exhaustion, an unreachable instruction) are not exercised. The PR states this
correctly; the production error taxonomy should keep "replace the worker" as
the outcome for anything that is not a CAS result.

## Not yet done

- **Warm-profile reload measurement** (audit §3.2, added in #6). Every timing
  so far uses fresh browser profiles.
- **Step 2:** trims, using F-4 for plot and gnuplot. The next steps are
  precompiled STACK, the call entry in the production worker and the memory
  snapshot, which now has its precondition (control returns to JavaScript
  after startup).
