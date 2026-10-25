# Production compiler acceptance

`runtime-release.yml` reads `compiler_profile.py --production` and calls
`runtime-build.yml` with that one explicit profile. `runtime-production.yml`
exercises the same call on a PR without creating a tag or release. A build of
`ecl-oz-maxima-oz` must complete both the existing source-runtime acceptance and
the complete STACK suite on that same build before its artifact can be released.

The STACK suite compiles and checks both pinned entry bundles, replays their
compiler evidence against the packaged runtime, runs the native full-entry
controls at both pins, the 22 official probes in source and compiled modes at
both pins, 24 full session restarts across 32 initializations, and the newer-pin
316-program compiled controller with independent and same-source native replays.
It also exercises graphics in Chromium, Firefox and WebKit, desktop and mobile
widths, offline MathJax closure and static hosting.

The compiled controller reports and manifests are preserved separately. The
workflow then restores the tracked site and runs source-loaded STACK through
the existing 316-program source controller, native comparisons, both-pin probes,
GC/error recovery, direct plot policy and authored plot diagnostic. The source
manifest remains the default; a compiled entry still requires explicit opt-in.
`check-acceptance.py` replays and binds the additional STACK evidence through
`stack_acceptance.py`. The release job requires that binding as well.

The legacy three-profile comparison still explicitly selects `baseline`,
`ecl-oz` and `ecl-o2`; changing production does not add an implicit comparison
member. Timing and comparison jobs retain their own explicit profile choices.

The release record remains schema 1. Runtime/source archive member layouts and
the 79-asset runtime closure are unchanged. The acceptance JSON adds
`stackAcceptance` for this profile. `runtime/release.json` continues to select
the site's release independently; AC publishes runtime-v3 after merging, then
the site pin changes in a separate PR.
