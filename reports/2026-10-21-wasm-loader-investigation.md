# Wasm loader investigation, 21 October 2026

The native CTM oracle completed all 22 selected cases at both STACK pins. The unadapted browser loader reached Maxima's prompt, then exceeded the 90-second batch limit. Those CI runs remain in branch history and the per-run evidence directory.

A bounded local Chromium diagnostic sampled the active worker for five seconds. Almost all samples were in `___syscall_ioctl`; a debugger inspection identified `fd=3`, operation `21531` (FIONREAD), on `/share/maxima/branch_5_49_base_90_g813903d33/share/stringproc/stringproc.mac`, position 25. The parent stack included ECL's `cl_read_char_no_hang` and `ecl_listen_stream`. This is regular-file availability probing, not terminal input. A terminal-stream experiment did not resolve it and is not part of the runner.

The worker compatibility adapter implements FIONREAD for regular virtual files with the remaining byte count. All other ioctl operations retain their upstream behavior. A second sample then identified repeated MEMFS missing-path error construction. The adapter reuses the ordinary ENOENT error object in MEMFS's always-missing lookup fallback; existing nodes are still resolved by Emscripten before this fallback. It changes exception stack provenance for those expected misses, not the missing-file error code.

Neither STACK source files nor answer-test functions are patched. The native comparison remains mandatory. A short local probe progressed past the earlier loader position and exposed another linked library, `libgnuplot.so`; its bytes and SHA-256 are pinned in the dependency supplement. The core and all nine optional Wasm modules' `dylink.0` dependencies were enumerated, including that plotting dependency.

The next full CI run verifies both pinned library end-of-file version declarations and all 22 result rows. A Maxima prompt, a printed marker, or a successful HTTP request alone does not meet that acceptance condition. Timings remain diagnostic local-serving timings, not a cold Quarto page benchmark.
