# Separate build patches

`maxima-gnuplot-cross-host.patch` changes only `wasm/Makefile` at pinned
Maxima commit `813903d33f5ccca09cbe3086dbfe5e228521da52`. It declares gnuplot's
Emscripten host and Linux build tuples, matching the adjacent ECL cross recipe.
No mathematical source changes. The original source archive remains unchanged;
the patch has its own SHA-256 pin and is copied into the artifact's recipe.
Application records the source revision and resulting Makefile hash.

Evidence: CI run [39865663672](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39865663672)
built native ECL (ELF32/i386, 29-bit positive fixnum) and native Maxima but
gnuplot Autoconf exited 77 with `cannot run C compiled programs` and explicitly
requested `--host`. Its `emconfigure ./configure` command omitted that flag;
the pinned ECL configure command already uses the tuple added here.

The earlier workflow did not retain gnuplot's `config.log`; that diagnostic
gap is corrected by preserving every subbuild `config.log` on future attempts.
The original failed Actions log and a structured summary are retained.

Upstream offer: prepared, not yet posted. The intended destination is
`gitlab.com/mgerbershagen/maxima` (the port). A noninteractive credential check
found no GitLab authentication. The available browser reaches GitLab sign-in
and its security verification; no authenticated session or legitimate GitHub
mirror was available. No challenge was bypassed and no account was created.
The public patch is ready in [PR 7](https://github.com/Erasmus-CTM/stack-wasm-maxima/pull/7),
but an upstream issue/MR has **not** been posted. This remains an explicit
limitation pending authenticated access, not a claim that upstream received it.
