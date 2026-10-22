# Wasm loader investigation, 21 October 2026

The native CTM oracle completed all 22 selected cases at both STACK pins. The unadapted browser loader reached Maxima's prompt, then exceeded the 90-second batch limit. Those CI runs remain in branch history and the per-run evidence directory.

A bounded local Chromium diagnostic sampled the active worker for five seconds. Almost all samples were in `___syscall_ioctl`; a debugger inspection identified `fd=3`, operation `21531` (FIONREAD), on `/share/maxima/branch_5_49_base_90_g813903d33/share/stringproc/stringproc.mac`, position 25. The parent stack included ECL's `cl_read_char_no_hang` and `ecl_listen_stream`. This is regular-file availability probing, not terminal input. A terminal-stream experiment did not resolve it and is not part of the runner.

The worker compatibility adapter implements FIONREAD for regular virtual files with the remaining byte count. All other ioctl operations retain their upstream behavior. A second sample then identified repeated MEMFS missing-path error construction. The adapter reuses the ordinary ENOENT error object in MEMFS's always-missing lookup fallback; existing nodes are still resolved by Emscripten before this fallback. It changes exception stack provenance for those expected misses, not the missing-file error code.

Neither STACK source files nor answer-test functions are patched. The native comparison remains mandatory. A short local probe progressed past the earlier loader position and exposed another linked library, `libgnuplot.so`; its bytes and SHA-256 are pinned in the dependency supplement. The core and all nine optional Wasm modules' `dylink.0` dependencies were enumerated, including that plotting dependency.

[CI run 39669805961](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39669805961) verified both pinned library end-of-file version declarations and all 22 result rows at each pin. A Maxima prompt, a printed marker, or a successful HTTP request alone does not meet that acceptance condition. Timings remain diagnostic local-serving timings, not a cold Quarto page benchmark.

## Interrupt transport correction and completed milestone

The first full run after the filesystem fixes loaded both libraries. The newer STACK pin matched all 22 native observations. The older pin lost two result rows: its stdout showed two adjacent batch commands merged into a syntax error.

The pinned upstream transport resets its stdin cursor when ECL's garbage collector checks for interrupts. Its main-thread response also overwrote the pending input buffer. The wrapper now keeps an independent stdin cursor and a separate interrupt-control buffer. It installs these transport functions immediately before importing the unmodified pinned runtime; mathematical sources are unchanged.

The accepted run injects interrupt checks after characters 37, 511 and 1003. Both workers executed all three injected checks, along with ordinary runtime interrupt checks (31 total on the older pin, 26 on the newer pin). All 33 input lines were delivered and all 22 native result records matched at both pins. Missing or extra protocol records remain fatal; the comparison was not weakened.

| STACK pin | Native comparisons | Runtime ready | STACK ready | Entire check |
|---|---:|---:|---:|---:|
| 10d3233 | 22/22 | 2.51 s | 81.05 s | 84.55 s |
| 3338304 | 22/22 | 2.34 s | 78.09 s | 81.38 s |

The remaining 22-case batch took 3.50 seconds on the older pin and 3.29 seconds on the newer pin, including protocol overhead, an additional lazy share load and injected checks. These are single-run CI observations, not per-question grading benchmarks. The native reference is Maxima 5.46.0; the Wasm runtime identifies itself as branch_5_49_base_90_g813903d33 with ECL 26.3.27. Chromium was 141.0.7390.37.

Each worker requested 69 unique runtime asset URLs totalling 41,013,867 decoded file bytes. STACK's separately mounted 77 source files added 874,701 bytes (older pin) or 898,867 bytes (newer pin). The server used uncompressed local HTTP responses; these totals are not the public deployment's encoded download size. The successful comparison establishes the selected direct answer-test layer, rather than full question input-controller, PRT, Quarto frontend or PythonChecker parity.

The next target is the existing documentation's 19 live cards / 27 variants, listed with exact XML, checker and site dependency pins in [demos/manifest.json](../demos/manifest.json). The new block is `::: {.stack-maxima}`; its frontend renderer and runtime backend wiring remain the next milestone.
