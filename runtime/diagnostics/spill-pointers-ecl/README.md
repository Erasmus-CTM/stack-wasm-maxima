# ECL on Wasm: a live cons is collected while it waits on the value stack

ECL on Emscripten relies on Binaryen's `--spill-pointers` pass to make stack
pointers visible to Boehm GC, which cannot scan Wasm locals or the Wasm value
stack. This fixture embeds ECL as INSTALL describes ("Build an external program
linked against libecl.a") and links with ECL's own flags from
`src/aclocal.m4`:

```
--profiling-funcs -sBINARYEN_EXTRA_PASSES='--spill-pointers,--strip-debug'
```

A cons returned by one call is collected, and its cell reused, while the program
evaluates the next argument of the same call:

```c
intact(make(id), churn(id), id);   /* make() returns a fresh cons; churn() runs si_gc */
```

ECL-compiled Lisp has this shape whenever a call's argument allocates and a
later argument can collect, for example `(f (cons a b) (g))`. Running `--flatten`
immediately before `--spill-pointers` removes the loss.

The companion fixture `../spill-pointers/` shows the same gap with plain C and
bdwgc, without ECL.

## Tested versions

| ECL | Emscripten SDK | Binaryen |
|---|---|---|
| upstream `develop` at `ff5c6abb` | 6.0.11 (the version its INSTALL names) | `version_133` |
| fork `mgerbershagen/ecl` at `e4bdb2e5` (used by the Maxima Wasm build) | 4.0.10 | `version_123` |

ECL is built exactly as INSTALL describes: `--disable-shared --with-tcp=no
--with-cmp=no`, with a 32-bit host ECL as `ECL_TO_RUN`. ECL's configure builds
the library at `-O0`. The fixture is compiled at `-O0`, `-O2` and `-Oz`.

## Observed behavior

Each case runs 2,000 rounds; each round forces one full collection (`si_gc`).

- **freed**: the collector cleared a disappearing link registered on the cons,
  so it reclaimed an object that was still live.
- **overwritten**: the cons no longer held its original `car` and `cdr` when the
  call ran.
- **spilled**: rounds in which the shadow stack inside `main`'s frame held the
  cons address at the collection.

Upstream ECL, emsdk 6.0.11:

| Fixture | ECL flags: freed / overwritten / spilled | `--flatten` first: freed / overwritten / spilled |
|---|---|---|
| `-O0` | 2,000 / 1,999 / 0 | 0 / 0 / 2,000 |
| `-O2` | 2,000 / 1,999 / 0 | 0 / 0 / 2,000 |
| `-Oz` | 2,000 / 1,999 / 0 | 0 / 0 / 2,000 |

ECL fork, emsdk 4.0.10:

| Fixture | ECL flags: freed / overwritten / spilled | `--flatten` first: freed / overwritten / spilled |
|---|---|---|
| `-O0` | 0 / 0 / 2,000 | 0 / 0 / 2,000 |
| `-O2` | 2,000 / 1,999 / 0 | 0 / 0 / 2,000 |
| `-Oz` | 2,000 / 1,999 / 0 | 0 / 0 / 2,000 |

At `-O0` the outcome depends on clang, as in the C fixture: clang from SDK
4.0.10 stores `make()`'s result in a stack slot of `main`, which the collector
scans; clang from SDK 6.0.11 leaves it on the value stack, so ECL's documented
`-O0` does not avoid the gap there. The driver records `-O0` with ECL's flags
but does not assert it.

No round had a copy of the address anywhere else on the shadow stack, so no
stale word kept the cons alive by chance. The fixture pads and scrubs the stack
below `churn()` so this holds.

## Mechanism

Binaryen's `SpillPointers` pass computes liveness over the function's existing
locals and spills those live across a call. `make()`'s result is not a local: it
is an operand of the enclosing `intact()` call, held on the value stack while
`churn()` runs. When the pass rewrites a call, it moves that call's operands
into new temporary locals; those temporaries are not spilled either. The cons is
therefore in no scanned memory during the collection. `--flatten` turns every
such value into a local before liveness is computed, so the pass spills it.

## Reproducer

Requirements: Linux x86-64 with a 32-bit C toolchain (`gcc-multilib`),
Python 3, Git. The SDK supplies clang, Binaryen and Node.

```sh
git clone https://github.com/emscripten-core/emsdk.git
emsdk/emsdk install 6.0.11 && emsdk/emsdk activate 6.0.11
git clone https://gitlab.com/embeddable-common-lisp/ecl.git && cd ecl
git checkout ff5c6abbe73e3b3e95608e32721ce0be232c1987
cp -a . ../ecl-host && (cd ../ecl-host && ./configure ABI=32 CFLAGS=-m32 LDFLAGS=-m32 \
  --prefix="$HOME/ecl-host32" && make && make install)
source ../emsdk/emsdk_env.sh
export ECL_TO_RUN="$HOME/ecl-host32/bin/ecl"
emconfigure ./configure --host=wasm32-unknown-emscripten --build=x86_64-pc-linux-gnu \
  --with-cross-config="$PWD/src/util/wasm32-unknown-emscripten.cross_config" \
  --prefix="$PWD/ecl-emscripten" --disable-shared --with-tcp=no --with-cmp=no
emmake make && emmake make install
cd ..
python3 runtime/diagnostics/spill-pointers-ecl/run.py --emsdk "$PWD/emsdk" \
  --ecl "$PWD/ecl/ecl-emscripten" --output "$PWD/ecl-spill-evidence"
```

The driver links `embed-gap.c` with `libecl.a`, `libeclgc.a` and `libeclgmp.a`
from the prefix and writes `report.json` with every command, exit code and
output. It fails unless, at every optimization level, the flattened build frees
no cons and spills it in every round, and, at `-O2` and `-Oz`, ECL's flags free
it in every round with no spill. The workflow
`.github/workflows/spill-pointers-ecl.yml` builds both ECL versions from source
and runs the driver.

The fixture uses `-sSTACK_SIZE=33554432`, `ECL_OPT_C_STACK_SIZE` of 16 MiB and
`node --stack-size=65500`, because flattening the statically linked ECL
enlarges its frames. Without these, the flattened build stops early with ECL's
C-stack overflow error.

## Limits

- The fixture forces the pattern with indirect calls and a collection in every
  round. It shows that the documented configuration can collect a live object;
  it does not show how often real ECL programs produce the pattern. In real
  programs a stale stack word often keeps the object alive, so failures are
  intermittent.
- The libraries are built at `-O0` with the same pass. The fixture shows the gap
  in the embedding program; the same pass runs over ECL's own code in the same
  link.
- `--flatten` raises local counts. Large modules then need local simplification
  (for example `--simplify-locals-notee-nostructure --vacuum --coalesce-locals
  --reorder-locals`) to stay below V8's limit of 50,000 locals per function.
