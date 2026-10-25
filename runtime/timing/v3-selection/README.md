# Flattened production candidate selection

This workflow is separate from the frozen original Oz selection. It times no
compiled STACK and rebuilds no runtime. It requires an immutable successful
production-profile run and complete acceptance/packaging/compiler/STACK evidence.
`candidate-binding.json` remains blocked until those artifact identities and the
review are populated. Benchmark GitHub identity is never reassigned.

The original guarded producer verifier admits the frozen ecl-oz control. The new
candidate is admitted independently against its exact trusted checkout and full
acceptance evidence. Both are then staged with the same current source integration
and pinned STACK/checker sources; their runtime bytes remain unchanged. The new
accepted candidate's captured rational prepare/validate/PRT programs are the shared benchmark
workload, with their provenance retained separately from each producer's controller
capture. This compares the compiler/runtime profiles under matched integration,
not the byte-identical public v2 archive.

The driver preserves fresh worker/buffer, correctness, startup-fatal, termination,
reload and late-event controls. Ten balanced AB/BA pairs run per profile, first at
full speed and then under aggregate systemd CPUQuota=25%, on one runner. Raw
samples and hashes are retained. No results from the unflattened candidate are
relabeled as measurements of the repaired build.
