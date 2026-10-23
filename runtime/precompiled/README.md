# Precompiled STACK experiment

This separate, opt-in experiment starts with the exact STACK source pin used
by the browser site and the accepted unoptimized Maxima/ECL build recipe. It
translates `stackmaxima.mac` using that build's native Maxima, then asks the
pinned ECL cross-compiler to produce a browser-target FAS bundle. The source
file, generated Lisp, bundle and compiler logs are retained with hashes.

This first gate only establishes whether the translator and cross-compiler can
produce a browser bundle. It does **not** load that bundle in Wasm, replace
source loading, show parity, or claim a speedup. Those are separate required
gates before any runtime selection: explicit bundle loading with source-hash
checks, both STACK pins, browser/native and same-source replays, forced-GC and
error recovery, measured cold and warm startup and transfer, and independent
artifact review. The shipped runtime and source-loaded startup are unchanged.
