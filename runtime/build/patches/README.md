# Separate build patches

`maxima-gnuplot-cross-host.patch` derives a build Makefile from the original at
Maxima commit `813903d33f5ccca09cbe3086dbfe5e228521da52`. Only the gnuplot recipe
changes: explicit wasm32/Linux host/build tuples, PIC compilation, an explicit
static archive, and a genuine `emcc -sSIDE_MODULE=1` link using the complete
archive. No mathematical source changes or exports are intentionally removed.
Stock libtool reports no shared-library support for this host, so its installed
`libgnuplot.a` is linked directly rather than copying a nonexistent `.so`.

The patch is applied to a separate external Makefile, not to the source checkout.
GNU make runs it from the original `wasm/` directory; `INSTALL_DIR` derives from
that working directory and `-f` is not inherited by recursive submakes. The
original source tree remains clean, so Maxima's `git describe --dirty` reports
the exact upstream version without suppressing an integrity check. Original,
patch and effective recipe SHA-256 values are recorded, and the effective file
is included in the artifact. An actual isolated derivation check preserved
`branch-5_49-base-90-g813903d33` with a clean tree.

Failures retained in reports/runtime-build/attempts.json:

- Run 39865663672: the original gnuplot configure command omitted `--host`, so
  Autoconf attempted to execute Wasm and exited 77.
- Run 39868037264: host tuples fixed configure, but libtool produced only a
  static archive and the old `.so` copy failed. Applying the earlier patch in
  the source tree also caused `_dirty` version/layout drift. The external
  recipe and direct side-module link address these independent build issues.

The link flags follow the pinned port's `libgnuplot_la_SOURCES` and existing
`-sSIDE_MODULE` intention. PIC and SIDE_MODULE=1/whole-archive behavior were
checked against the exact Emscripten 4.0.10 source. This is build glue, not a
mathematical fork; successful compilation and substitution CI remain required.

Upstream offer: **NOT POSTED**. The intended destination is
`gitlab.com/mgerbershagen/maxima`. A noninteractive credential check found no
GitLab authentication; the available browser reaches sign-in/security
verification and no legitimate GitHub mirror was found. No challenge was
bypassed or account created. The public patch is ready in
[PR 7](https://github.com/Erasmus-CTM/stack-wasm-maxima/pull/7), but upstream has
not been notified. This remains an explicit limitation pending authenticated
access, not a claim that upstream received it.
