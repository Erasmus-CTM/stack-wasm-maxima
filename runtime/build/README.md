# Owned runtime reproduction (step 1, in progress)

The source/build pins are exact. Maxima and ECL identities are embedded in the
deployed binary. Emscripten 4.0.10 is present in maxima.wasm and the port README.
The gnuplot commit is a reconstructed candidate from the referenced port's
unchanged default branch and matching version, not an embedded binary commit.
Bundled GMP and Boehm GC versions are recorded from the exact ECL tree; libffi
is bundled for host use but the Wasm configure branch explicitly disables it.

GitLab archive HTTP requests returned 406 locally, so those sources use canonical
uncompressed `git archive --format=tar --prefix=NAME/ COMMIT` SHA-256 values.
`core.autocrlf=false` and `core.eol=lf` fix checkout/archive text conversion; filenames are Git tree order,
and archive timestamps/comment derive from the pinned commit. CI validates the
same bytes; a mismatch fails rather than bypassing the pin. GitHub SDK/source
archives have independently downloaded tar.gz hashes. Existing upstream tags
are fetched for Maxima versioning; no tags are created. core.abbrev=9 preserves
the deployed version/share directory spelling without a source patch.

The initial workflow is an actionable build experiment, not a completion claim.
It uses the port's own Makefile to build 32-bit host ECL, cross ECL, Maxima and all
nine modules including plotting. No mathematical source is edited. It stages
exactly today's asset inventory, with all bytes/hashes and deployed size
comparisons. Complete source archives and original notices accompany the runtime;
the prepared licence PR is read at its exact commit rather than duplicated.

Substitution parity, the two STACK pins, browser checks, native replay and timings
are wired into the build workflow and remain acceptance gates until that workflow passes.
No site publication, tags, releases, trims or compression are performed here.

The first CI source check (run 39863489271, before any compiler execution)
rejected the original Windows ECL archive hash. Its 2,890 tar entries describe
the same pinned tree: 2,452 contents are identical and 438 entries under
`ecl/src/libffi/` differ only by CRLF versus LF. Bundled libffi's `text=auto`
attributes use native EOL unless `core.eol=lf` is explicit. The LF archive is
36,106,240 bytes with SHA-256 `fafd6275264c33dd4d8562703752f709bf992b29c40fd766d1351782f4c507b0`,
matching Ubuntu exactly. Maxima and gnuplot hashes are unchanged with this
configuration. This is staging configuration, not an upstream source patch.
The failed run remains in GitHub Actions; subsequent attempts preserve source
logs, partial archives and per-source verification progress even on failure.

The executed Linux SDK and Node binary archives are separately size/hash pinned
and verified before emsdk extraction, including cache hits. Only compressed SDK
archives are cached; extracted executables are recreated from verified bytes.
The host must be ELF32/i386 with a 29-bit positive fixnum, and the output module
must declare unshared wasm32 memory. Packaging records build-recipe hashes and
its Git revision alongside upstream source and actual toolchain evidence.
Owned artifacts carry a build-specific notice; the licence PR's original site
notice is labelled as historical site context, and licence texts are unchanged.

The second CI attempt (39865240495) verified every source archive and both
executed SDK archives, then stopped in gnuplot bootstrap because `ltmain.sh`
was absent. The recipe now invokes `libtoolize --copy` before upstream
`./prepare`, generating build support without changing mathematical sources.
It also restores `EMSDK_PATH` after emsdk's environment script clears it,
because the port Makefile requires that variable. Tool version logs use the
actual bundled clang and SDK Node executables, not similarly named tools on
Ubuntu's default PATH. Failed build logs are retained as Actions artifacts.

## Opt-in validation

`python scripts/milestone-two/prepare-runtime.py --runtime-source ARTIFACT ...`
(or `CTM_MAXIMA_RUNTIME_SOURCE=ARTIFACT`) selects an owned artifact containing
`manifest.json` and `runtime/`. Without that option the existing deployed
runtime remains the default. Every owned request must have a manifest hash;
there is no fallback download or discovery of unhashed owned share files.
The current 81-file inventory is required exactly during staging. Integrity
fixtures cover changed pins, malformed inventories, duplicate/traversal paths,
size/hash mismatches and post-manifest tampering.

The CI acceptance path stages the owned files into an unpublished site, runs
its actual native browser checks, and replays exactly 316 captured programs
against both Ubuntu's independent Maxima and the already-installed native
Maxima from the same upstream commit/ECL32 build. It then runs the same 22
fixtures at each of the two STACK pins with deployed and owned Wasm, preserving
the generated batches, raw results, desktop comparisons and explicit parity.
A final assertion rejects missing/partial evidence or any unaccepted replay
difference. Compilation alone is not acceptance.

`measure.mjs` records two alternating-order trials per runtime, with fresh
Chromium process/profile/worker and uncompressed local HTTP for each trial,
then ten simple `6*7` overhead-control calls and actual captured native-rational
prepare/validate/PRT programs in that worker, with result equality checks. Readiness includes STACK. HTTP caches start
fresh; OS/filesystem/process warming is uncontrolled. The baseline and owned
results are retained side by side without a statistical performance claim.
The existing published transport and page are not switched.

The separate upstream workflow writes a weekly/manual read-only drift artifact
for the three port branches and the pinned tool tags. It never rewrites pins,
creates an upgrade PR, merges, tags or publishes. A changed branch is evidence
for an exact candidate decision and the full build/substitution workflow;
release discovery and automatic tested upgrade proposals remain later tracking
work as described after the runtime steps in audit section 6.

Verified SDK archives and validated host ECL are saved to their caches before
later job failure can discard them. The upstream host-ECL Makefile target has
no prerequisites: an existing cached executable skips compilation, then the
ELF/fixnum assertions still execute. Cache readiness is emitted only after
archive verification or successful host assertions, respectively.
Acceptance binds the browser's asset inventory and staged manifest to the
actual owned artifact digest, each native replay to the exact browser JSON
hash, the same-source oracle to the observed/pinned Maxima version, and the
probe/timing provenance to the same artifact. Raw failed probe evidence is
always uploaded even when its comparator exits before the usual copy step.

## Later size experiments (not applied in step 1)

The deployed comparison inventory is 57,083,412 bytes across 81 files. Its
`maxima-plot.fas` (1,135,430 bytes) and `libgnuplot.so` (3,937,451 bytes) total
5,072,881 bytes; omitting them is a later capability/coverage decision, not a
claim that the current test suite exercises plotting. Slatec (6,182,186 bytes)
and quadpack (3,714,554 bytes) also merit dependency measurements before any
removal. The owned artifact's generated `sizes.md` supplies the corresponding
rebuilt sizes once compilation succeeds.

A separate authorized compression experiment can compare Brotli/gzip for
Wasm, side modules and JavaScript, preserving each decoded SHA-256, MIME type,
range/lazy-loader behavior and all substitution checks. The largest deployed
inputs are `maxima.wasm` (23,611,995 bytes) and `libecl.so` (7,966,927 bytes).
Compiler size optimization is a separate experiment: this reproduction keeps
the port's flags, including ECL's O0 and Binaryen spill-pointers behavior.
No module, source or runtime file is trimmed or compressed by this build.

The first native compiler attempt (39865663672) built ECL32 and native Maxima,
then gnuplot configure exited 77 because the port recipe did not declare a
cross host. `patches/maxima-gnuplot-cross-host.patch` is a separate SHA-pinned
build-only patch adding the same wasm32/Linux host/build tuples used by ECL.
The applicator checks the exact source commit, clean tree and patch hash,
permits only `wasm/Makefile` changes, and records the resulting file hash.
Original source archives remain unchanged and the full patch accompanies the
artifact. An isolated checkout application check passed. No mathematical
source changes. See patches/README.md for the failed run and upstream offer:
the patch is publicly ready in PR 7 but has NOT been posted to GitLab because
no authenticated session or credential is available. All subbuild config logs
are now preserved to close the diagnostic gap in the failed attempt.

The next compiler attempt (39868037264) confirmed gnuplot cross configure now
works, but stock libtool disables shared libraries for the wasm32 host. It
installed only libgnuplot.a, so the original .so copy failed. The separate build
patch now compiles PIC and links that complete archive as a real Emscripten
SIDE_MODULE=1. It is applied to an external derived Makefile; original sources
remain clean, preserving the pinned version and share paths without hiding the
patch from provenance. gnuplot builds before the longer host/Maxima phases to
fail early. All original/effective recipe hashes are retained. The notices
checkout is refreshed to licence PR 4 commit
b34bfc8af10cd80b6130baabe88a47c9a32c0333; its texts are copied unchanged.
