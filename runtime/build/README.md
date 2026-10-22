# Owned runtime reproduction (step 1, in progress)

The source/build pins are exact. Maxima and ECL identities are embedded in the
deployed binary. Emscripten 4.0.10 is present in maxima.wasm and the port README.
The gnuplot commit is a reconstructed candidate from the referenced port's
unchanged default branch and matching version, not an embedded binary commit.
Bundled GMP and Boehm GC versions are recorded from the exact ECL tree; libffi
is bundled for host use but the Wasm configure branch explicitly disables it.

GitLab archive HTTP requests returned 406 locally, so those sources use canonical
uncompressed `git archive --format=tar --prefix=NAME/ COMMIT` SHA-256 values.
`core.autocrlf=false` disables Windows conversion, filenames are Git tree order,
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
