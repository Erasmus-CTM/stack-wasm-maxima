from pathlib import Path
p=Path('.cache/full-timing-table-guarded/tools/run.mjs');s=p.read_text();s=s.replace("categories:'v8,wasm,devtools.timeline,disabled-by-default-v8.wasm.detailed'", "categories:'v8,wasm,devtools.timeline,disabled-by-default-v8.wasm.detailed,disabled-by-default-v8.cpu_profiler'")
p.write_text(s)
