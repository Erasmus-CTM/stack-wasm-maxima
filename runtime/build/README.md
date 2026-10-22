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
remain acceptance gates to implement/run as the first source build executes.
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
