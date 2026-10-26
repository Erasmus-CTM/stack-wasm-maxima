# Review of Claude's Emscripten 6.0.11 experiment

**Recommendation: keep runtime-v3 / PR #28 on the accepted 4.0.10 build. Reuse the 6.0.11 work for a successor candidate with the same compiler profile and all v3 gates.** No production code, release pin, tag or release was changed by this review.

Reviewed branch `claude/elegant-maxwell-3tv01e`, commit `3ef575fe8e43f1fa45347002cafdaf264ea15dbf`. The [trial run](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40266518267) has successful baseline, ecl-oz and ecl-o2 build/acceptance jobs; its legacy timing comparison was still running at review time. The inspected [manifest](manifest.json) confirms actual SDK/Emscripten 6.0.11, with unchanged Maxima and ECL source revisions. Version 6.0.11 names the Emscripten toolchain, not a new Maxima/ECL release.

The ecl-oz [acceptance](acceptance.json) passes 316 captured programs against both independent and same-source native runtimes with zero unaccepted differences. The payload has 79 assets totalling 48,121,956 bytes, about 2.5% below the archived 4.0.10 ecl-oz profile's 49,348,838 bytes. This is a historical same-profile size indication, not a new matched timing comparison. Its two cold acceptance samples are 10.698 and 10.935 s, and reload samples 9.100 and 9.362 s ([raw timings](acceptance-timings.json)). These use a different runner and profile from PR #28; they do not establish an advantage over v3's paired n10 results.

Useful work to retain:

- Pinned experimental SDK selection, including source/binary hashes, consistent Python/JavaScript admission, and release protection that still requires the production pins.
- Preserving names with `--emit-symbol-map` so Binaryen's spill pass can find the stack pointer under 6.0.11.
- Mounting preloaded MEMFS bytes without calling `FS.write` before the heap exists during `preInit`.
- Avoiding lazy nodes for unserved share files; otherwise a stat can fetch a 404 and abort under 6.0.11. The probe worker and runtime child both need this compatibility rule.
- Compiler-evidence recognition of the deeper SDK system-library cache paths, with matching-prefix guards and regression coverage.

The candidate is not yet the v3 configuration. Its profile is ECL `-Oz` with Maxima `-O2`, while PR #28 uses Maxima `-Oz` too. The branch does not include #28's full compiled-STACK, during-call GC-stress and internal-fault-boundary gates. Its legacy comparison times baseline versus ecl-oz within one toolchain, not SDK4 versus SDK6 with the same ecl-oz-maxima-oz profile. The queued second dispatch cannot fill that profile/coverage gap by itself.

Integration also needs the SDK flags in the translated STACK compiler path: PR #28's `translate-and-cross-compile.sh` clears `EMCC_CFLAGS`, sets the profile's exact flag string and asserts it. The new SDK's symbol-name flag must be composed there and covered by compiler evidence, as well as in `build.sh`; changing the main SDK pin alone is insufficient.

An SDK upgrade has not been demonstrated to fix the GC root gap. The [standalone reproducer](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40231542637) still fails with plain spilling on 6.0.13. Keep flatten-before-spill and the local cleanup when evaluating 6.0.11.

To reconsider the base, build the same fixed profile on 6.0.11, pass every production gate (both source and compiled STACK pins, native316 comparisons, restarts, graphics, plot policy, GC stress and fault boundaries), and compare accepted SDK4/SDK6 artifacts without rebuilding: ten balanced source-STACK repetitions per cold/reload/CPU condition on one runner. Retain medians, spread and all raw samples. The existing 20-second D8 wish remains separate from correctness acceptance.

[Review metadata](review.json) records immutable artifact IDs and hashes. [Artifact extraction](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/40275943680) preserves the actual packaged records. Focused SDK pin, runtime admission, archive and compiler-evidence tests passed locally in an isolated checkout.
