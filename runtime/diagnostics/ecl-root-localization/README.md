# ECL root-scanner research handoff

This branch preserves diagnostic evidence for [ECL issue 860](https://gitlab.com/embeddable-common-lisp/ecl/-/work_items/860). It is a research archive, not a proposed production change or upstream contribution.

Start with [HANDOFF.txt](HANDOFF.txt). The [candidate description](README.txt) explains the small C/shell/Lisp experiment. **That candidate has not been executed.** Only shell and inert C syntax checks have run. No ECL-only reproducer or caller of the original browser abort has been established.

## Recorded evidence

The [evidence index](evidence/INDEX.json) records the provenance, byte count and SHA-256 of every retained evidence file.

- [Native collector evidence](evidence/collector/): actual 32/64-bit reports, all case stdout/stderr, build/configuration logs and the independent artifact review. These establish a deliberately constructed collector-capacity mechanism, not natural reachability through ECL.
- [Original failed browser evidence](evidence/original-failure/): locally recovered UTF-8 selections from artifact `12546163663`, run `40051138492`. This is historical failed-run evidence, not runtime acceptance.
- [Frozen replay evidence](evidence/frozen-replay/): all 77 independently audited selections from artifact `12547196937`, run `40059617859`, including reports, provenance, inputs and frozen FAS bytes. The six pin-level replay runs passed and did **not** reproduce the original abort. Their reports explicitly retain `acceptance: false`.
- [Source references](evidence/source/): relevant pristine pinned-fork files, the previously inspected upstream scanner and licences. No source modification is applied here.
- [Upstream discussion](evidence/upstream/): original issue draft, public discussion snapshot and contribution policy. These are snapshots, not a new message posted upstream.

The original artifacts contain additional compiler/runtime binaries. Their identities and limits are recorded in the index and reports; this branch does not claim to duplicate every source ZIP. Retained artifact files were copied and hashed without executing their contents.

## Open question and candidate

ECL's foreign-library loader locks library cblocks. Its actual root scanner queues a lazy range for each locked library. The unexecuted candidate compares repeated loads of one inert library with loads of many distinct copies, followed by ordinary ECL collections. It installs no collector callback and makes no direct libgc call. Any failure still requires a backtrace and occupancy evidence to distinguish scanner capacity from loader or other resource limits.

Eager scanning can retain extra interior pointers; equal memory use and finalizer timing are unproven. Native collector results do not establish Wasm32 behavior. No precompiled STACK speedup is established.

## Research and upstream communication

Keep the work isolated from PR #13. Its base for this archive is `e8ad3d5b8b2ef2327537cd8e7ee50aaf0a8f8d31`; no workflow or production code is changed by this diagnostic commit. This branch does not authorize merging or publishing an upstream reply.

The ECL contribution policy permits AI-assisted analysis/debugging, but requires human-written discussion messages and submitted contributions. This AI-assisted research package is for investigation and understanding; it is not an upstream-ready submission.
