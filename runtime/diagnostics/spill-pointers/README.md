# Binaryen `--spill-pointers` misses pointers on the Wasm value stack

Boehm GC on Emscripten cannot scan Wasm locals or the Wasm value stack. Code
that relies on conservative collection, such as ECL and therefore Maxima on
Wasm, links with `-sBINARYEN_EXTRA_PASSES=--spill-pointers` so that pointers
are stored to the shadow stack the collector scans. This fixture shows that the
pass leaves one case unprotected: a call result that waits on the value stack
as an earlier operand of an enclosing call. A collection in the nested call can
free it. Running `--flatten` immediately before `--spill-pointers` removes the
loss.

The fixture is standalone: one C file, an unmodified bdwgc, and Node from the
SDK. It does not use ECL, Maxima or this repository's runtime.

## Tested versions

| Component | Versions |
|---|---|
| Emscripten SDK | 4.0.10 (`62a853cd`, Binaryen `version_123-168`), 6.0.13 (`35659964`, Binaryen `version_133-96`) |
| bdwgc | 8.2.8 bundled in the ECL Emscripten fork at `e4bdb2e5`, `src/bdwgc`; upstream 8.2.12 (`4fab5386`) |
| Optimization | `-O0`, `-O2`, `-Oz` |

The collector is built single-file from `extra/gc.c` with default settings.

## Observed behavior

Each case runs 2,000 rounds; each round forces one full collection.
Results were the same for both SDKs and both collector versions:

| Optimization | Plain `--spill-pointers` | `--flatten,--spill-pointers` |
|---|---|---|
| `-O0` | 0 lost | 0 lost |
| `-O2` | 2,000 lost | 0 lost |
| `-Oz` | 1,999 lost | 0 lost |

Two further observations, recorded but not used as controls:

- With Emscripten 6.0.13, `--spill-pointers` fails to build a module without a
  name section: `Fatal: getStackSpace: failed to find the stack pointer`. The
  fixture therefore adds `--profiling-funcs`. Emscripten 4.0.10 builds either way.
- Without any spill pass, `-O2` and `-Oz` lost 1 object in 2,000. This retention
  is not explained here; the fixture asserts only the plain-spill and flattened
  outcomes.

## Mechanism

`main` evaluates `intact(make(id), churn(id), id)` through function pointers,
so Binaryen cannot inline the calls. In the optimized plain-spill build, the
disassembly (`O2-spill-names.wat`, here from SDK 4.0.10 with ECL's bdwgc) shows `make()`'s result set into a temporary
local that is never stored to the shadow stack before `churn()` collects:

```wat
(local.set $7 (call_indirect (type $1) (local.get $13) (local.get $14)))   ;; make(id)
... spill stores of $0, $2, $3, $4 only ...
(local.set $8 (call_indirect (type $1) (local.get $11) (local.get $12)))   ;; churn(id)
(call_indirect (type $5) (local.get $7) (local.get $8) ...)                ;; intact(...)
```

In `SpillPointers.cpp`, liveness is computed over the function's existing
locals. A call result used directly as an operand of a later call is not a
local, so it is not spilled. When the pass rewrites a call, it moves that call's
operands into new temporary locals; those temporaries are not spilled either.
The pass logic is unchanged between `version_123` and Binaryen `main` of
2026-10-23. `--flatten` turns every such value into a local before liveness is
computed.

## Reproducer

Requirements: Linux, Python 3, Git; the SDK supplies clang, Binaryen and Node.

```sh
git clone https://github.com/emscripten-core/emsdk.git
emsdk/emsdk install 6.0.13 && emsdk/emsdk activate 6.0.13
git clone https://github.com/ivmai/bdwgc.git && git -C bdwgc checkout v8.2.12
python3 runtime/diagnostics/spill-pointers/run.py --emsdk "$PWD/emsdk" \
  --gc "$PWD/bdwgc" --output "$PWD/spill-evidence"
```

The driver writes `report.json` with every build and run command, its exit code
and output, and fails unless the flattened builds lose nothing, `-O0` plain
spilling loses nothing, and optimized plain spilling loses objects (the
negative controls). The workflow `.github/workflows/spill-pointers.yml` runs
both SDKs against both collectors.

## Limits

- The fixture forces the pattern with indirect calls and a collection in every
  round. It shows that the pass can miss such a value, not how often real code
  produces this pattern.
- `--flatten` increases local counts; large modules then need local
  simplification (for example `--simplify-locals-notee-nostructure --vacuum
  --coalesce-locals --reorder-locals`) to stay below V8's limit of 50,000 locals
  per function. Those passes are not needed for this small fixture.
- The application failure that led here (Maxima's generated C at `-Oz`; see
  `measurements/2026-10-25-maxima-oz-selection/gc-root-cause/` on branch
  `runtime/promote-maxima-oz`) is consistent with this mechanism; this fixture
  is the independent demonstration.
