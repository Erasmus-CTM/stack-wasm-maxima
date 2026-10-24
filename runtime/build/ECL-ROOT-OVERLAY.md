# Exact ECL target root-scanner overlay

The target runtime carries an exact overlay for a demonstrated hazard in ECL's
use of the collector's root-scanning API. The standalone native regression
establishes that hazard and the repair's limits; it does not identify the caller
responsible for a particular browser abort. Runtime acceptance separately
requires fresh builds, full parity and independent review at the integrated
revision. No precompiled speedup is established.

The descriptor `patches/ecl-root-scanner.json` binds ECL commit
`e4bdb2e5b1e444e1773032a53650773848f4d6cd`, the original Git blob and SHA-256,
derived SHA-256, exact patch SHA-256 and target. `pins.json` and the runtime
configuration bind the descriptor itself. The patch replaces the seven
`GC_push_all` calls and the locked-cblock `GC_push_conditional(..., 1)` call in
`ecl_mark_env` and `stacks_scanner` with public `GC_push_all_eager`. It retains
every bound, null guard, locked-cblock mark-bit operation and previous callback
invocation. A dated source comment identifies the CTM modification. ECL's
original notices and licence apply to the modified source and patch.

`build.sh` first checks all original tracked Maxima/ECL source bytes and builds
the native ECL32 host using the unchanged upstream recipe. It records and tests
that executable before the applicator runs. The applicator checks the original
source again, records a host source checkpoint and inventories the installed
native host files, then changes exactly `src/c/alloc_2.d`. The upstream target
recipe removes the native ECL build directory before target configuration and
compilation. Its native-host target has no source prerequisites; the installed
native host remains unchanged, verified again after building and packaging.

Source verification admits the overlay only with `after --target-overlay` and
the recorded application and native-host evidence. Before and host reports
contain original bytes. Target after rows contain the actual derived hash and
Git blob plus a separate original Git blob. All other paths in the existing
after scope must match their original rows. That scope remains the tracked
`.lisp`, `.lsp`, `.mac`, `.asd`, `.c`, `.h`, `.d` files plus the three Maxima build
inputs; generated configuration/build support is still excluded explicitly.
There is no general dirty-source allowance or arbitrary patch list.

Native-only fixture and translation modes still demand original source.
Reused native fixtures and browser cross compilation explicitly check the
target overlay while verifying that their native host remains unchanged.
`wasm/Makefile`, `wasm/build.lisp` and `src/maxima.asd` are preserved exactly.
The `upstreamRecipe.verifiedFilesUnmodified` claim applies only to those three
Maxima inputs. The separate `sourceIntegrity.allVerifiedFilesUnmodified` value
is false and lists the exact ECL derivation.

Packaging rechecks source bytes, the installed native host and committed recipe
inputs. The application revision must equal the actual checkout HEAD and the
packaged recipe revision. Untracked or uncommitted overlay helpers, patch or
descriptor cannot be labelled with an existing commit. Every original ECL and
Maxima source row is reconstructed independently from the hash-pinned canonical
archives, so jointly changing or deleting report rows is rejected. The only
archive-to-Git conversion is CRLF to LF for the four named pinned libffi Visual
Studio files whose `.gitattributes` requires CRLF archive output.

Original archives remain unchanged in `sources/`. `source-overlays/ecl/`
contains the descriptor, patch, derived source, unchanged ECL licence and a
reproduction notice. The complete recipe includes the helper and verifier code.
Acceptance, cold-build admission and compression replay the complete archive,
report and patch checks. Runtime preparation checks the current overlay identity
in addition to pins/configuration; that preparation gate does not replace full
acceptance. Historical comparator admission remains an explicit separate path.

`test-source-overlay.py` covers original native mode, the explicit target
transition, host executable and library changes, missing application evidence,
descriptor/patch/source tampering, unrelated source edits, omitted coverage,
stale recipe revisions, original archive/notice tampering and consistent forged
source reports. Both runtime-reader fixtures reject unchanged older artifacts
and manifests relabelled with current pins/configuration but lacking the current
source-integrity identity. These are provenance tests, not collector correctness
or browser parity tests.

The canonical archives are reproducible from anonymous exact-pin GitLab fetches.
Their existing hash pins cover all 5,062 Maxima and 2,600 ECL original source
records. Patch replay must reproduce the descriptor's exact derived bytes.
These checks establish source provenance; browser correctness and performance
require their separate runtime evidence.
