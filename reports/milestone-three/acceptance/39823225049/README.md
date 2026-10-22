# Acceptance evidence for source 15fa332

The paired browser replay, native browser replay and desktop Maxima oracle checks passed for source `15fa33299d68d64e122a2661a2868feb30130edb` in [push run 39823225049](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39823225049), [job 119979644740](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39823225049/job/119979644740). This is a summary of desktop replay aggregates. It does not establish Moodle/PHP compatibility or acceptance of the public deployed page.

| Check | Observed result |
| --- | --- |
| Paired backend replay | 36 cards in 18 pairs; each backend covered 24 variants, 112 authored test rows and 6 PythonChecker cards; zero differences |
| Native replay | 9 cards, 11 variants, 24 authored rows, 3 PythonChecker cards, 4 graphics, 316 programs |
| Boundary and negative probes | 10 boundary fixtures, 4 invalid probes and 19 probes without full credit |
| Desktop Maxima oracle | 19 prepare + 135 validate + 162 PRT operations; all 316 passed |
| Oracle equality | 307 exact programs and 9 with accepted presentation equivalences; zero unaccepted programs |
| Field differences | 12 raw differing fields, all accepted presentation differences; zero unaccepted fields |

The tested-site job completed successfully. At the time these functional results were collected, publication job 119993878416 was still running. Publication subsequently passed, including deployed browser checks and independent byte-hash verification of all three public pages; see [public verification](public-verification.md). These functional and oracle aggregates remain separate from that public-page evidence.

## Original artifact provenance

Read-only artifact metadata verified on 22 October 2026 gives repository ID `1428812079` for both the workflow repository and source repository, and the same full source revision above for all three artifacts.

| Evidence | Original artifact | Reported ZIP SHA-256 |
| --- | --- | --- |
| Built reviewer site | [12448045201](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39823225049/artifacts/12448045201) | `d32eb0462a485b9b29c279ffc1b300db23f5f5b10b3ff7becea7efdd51174ebc` |
| Native replay and oracle | [12448020213](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39823225049/artifacts/12448020213) | `02e30538c15f6dbd1b97699acb541df572c4be0a7fea053eca32759275dcc869` |
| Paired replay | [12448060115](https://github.com/Erasmus-CTM/stack-wasm-maxima/actions/runs/39823225049/artifacts/12448060115) | `f8a35bb037739c1a42554f9a7e9fb774dc0d0bed1999673f523852f5f06918ff` |

Raw evidence remains in the original Actions artifacts. Downloads may require GitHub authentication, and artifacts may expire; these are currently scheduled to expire on 20 January 2027 at 17:29:59 UTC. The hashes above are GitHub-reported ZIP digests, not a fresh download verification. No raw payload, source text or screenshots are included here.

[summary.json](summary.json) records the aggregate counts, verification scope and original provenance in machine-readable form.
