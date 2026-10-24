The collector root-capacity fixture builds the unmodified BDWGC 8.2.8 bundled
at ECL commit `e4bdb2e5b1e444e1773032a53650773848f4d6cd`. Its driver verifies the
complete 321-file collector tree before and after execution. It requires Linux,
Python 3, GCC, make, and the pristine `src/bdwgc` directory from that pin.

```sh
python runtime/diagnostics/gc-root-regression.py \
  --source /path/to/pinned-ecl/src/bdwgc \
  --output /path/to/new-evidence-directory --bits 64
```

Use `--bits 32` with an installed 32-bit C toolchain. Compilation fails if the
requested architecture is unavailable; the driver never silently substitutes
another architecture. Native results do not establish Wasm32 correctness.

Each case runs in a fresh process. The fixture matches ECL's disabled general
interior-pointer recognition plus registered displacement one. System-allocated
root storage contains six ECL-style ranges, a locked block and a chained root
callback. Weak links verify unique sentinels, dead and unlocked controls, and
release after roots are withdrawn. Four collections must retain the live roots.

For the near-full case, real `GC_push_all` calls queue valid zero-containing
ranges until two entries remain. The original lazy scanner must terminate with
SIGABRT and `Unexpected mark stack overflow`. The eager scanner must retain
atomic sentinels without growing the mark stack. Atomic sentinels deliberately
separate the root-descriptor capacity defect from ordinary object-worklist
overflow recovery. Separate ordinary-pressure cases exercise transitive object
graphs through both scanners. A separate near-full pointerful graph case must
exercise BDWGC's normal recoverable overflow and preserve every required root.
It records both initial and final capacity, maximum capacity and recovery
callbacks. Growth remains bounded by sixteen times initial capacity over four
collections. The collector itself performs that growth through its unchanged
recovery algorithm; the fixture never changes the capacity or configured limit.

The synthetic previous callback has its own independent `lazy` or `eager` mode.
It scans three separate ranges. Both scanner variants retain these roots at
ordinary pressure with the exact same lazy previous callback. At near-full
pressure the eager ECL-style scanner with an unchanged lazy callback must still
abort: three lazy descriptors cannot fit the remaining two slots. This negative
control documents the limit of the proposed repair. Successful near-full cases
use the explicitly cooperative eager callback; they do not establish protection
for arbitrary unchanged callbacks. The actual collector's original callback,
when present, is also invoked unchanged and its presence is recorded. The
synthetic callback does not establish the original browser callback's identity.

An unregistered offset-two pointer is retained by eager scanning and rejected by
the lazy control. This explicitly demonstrates broader conservative retention;
the fixture makes no claim of equivalent memory use or finalizer timing.
Each case runs with incremental mode disabled and enabled. The requested mode
must be available and remain active; unavailable modes fail rather than skip.
These are explicit full `GC_gcollect` collections with incremental mode enabled,
not tests of mutations between incremental marking steps. A failed soft-dirty
`/proc` probe may warn even when BDWGC successfully falls back to mprotect;
the fixture checks `GC_is_incremental_mode()` directly. The report retains all
command, stdout and stderr evidence, including expected negative controls.

This is a standalone collector API regression. It does not execute the actual
ECL scanner or identify the caller responsible for the browser failure, and
does not authorize a production collector patch. `acceptance` remains false.
