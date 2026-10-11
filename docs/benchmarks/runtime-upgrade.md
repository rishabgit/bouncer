# E2B runtime and prefix-cache verification

The 2026-10-11 implementation upgrades LiteRT-LM from 0.12.1 to exactly
0.17.0 and reuses a prefilled prefix through independent per-post conversation
clones. The production model remains the same revision-pinned Gemma 4 E2B.
The prompts, strict parser, output budgets, greedy sampling, and suggestion-only
malformed-output fallback are unchanged.

The combined runtime/prefix change cleared the existing synthetic quality gate
and improved hot direct-call latency. This result does not isolate the effect
of prefix caching from the runtime upgrade.

## Method and raw evidence

The same localhost harness ran E2B only in Chrome 155 on the target M5 Pro / 64 GB
Mac. Two old-runtime runs preceded two upgraded runs. Each latency cell used
three warmups and twenty timed samples; each of the four 40-row classification
variants ran three times per row. The model URL and revision, corpus, prompt
variants, parser, and workload configuration matched across reports.

Reports preserve every timed sample, raw response, suggestion validation, and
model identity:

- [0.12.1 run 1](data/e2b-runtime-2026-10-11-0.12.1-run1.json)
- [0.12.1 run 2](data/e2b-runtime-2026-10-11-0.12.1-run2.json)
- [0.17.0 run 1](data/e2b-runtime-2026-10-11-0.17.0-run1.json)
- [0.17.0 run 2](data/e2b-runtime-2026-10-11-0.17.0-run2.json)
- [0.12.1 lifecycle smoke](data/e2b-runtime-2026-10-11-0.12.1-smoke.json)
- [0.17.0 lifecycle smoke](data/e2b-runtime-2026-10-11-0.17.0-smoke.json)

The calls include prompt budgeting, truncation, and generation. They exclude
extension messaging, offscreen creation, background scheduling, and real X
timeline contention. Model bytes were already in this origin's Cache Storage.
Power, other applications, and browser/GPU caches were not controlled. The
runtime order was sequential rather than counterbalanced; do not turn these
measurements into an energy claim or a general hardware benchmark.

## Hot latency

Full-call medians in milliseconds:

| Workload | 0.12.1 run 1 | 0.12.1 run 2 | 0.17.0 run 1 | 0.17.0 run 2 |
|---|---:|---:|---:|---:|
| Medium × 1 filter | 121.4 | 120.0 | 41.3 | 40.7 |
| Medium × 3 filters | 219.9 | 215.8 | 111.5 | 110.1 |
| Medium × 5 filters | 267.1 | 266.2 | 197.5 | 196.3 |
| Medium × 10 filters | 420.6 | 431.2 | 322.3 | 317.9 |
| Short × 3 filters | 182.8 | 189.0 | 130.5 | 123.5 |
| Long × 3 filters | 301.5 | 332.1 | 292.9 | 292.5 |

Medium × 3 improved by about 49% in both paired comparisons. The gain is
workload-dependent: about 66% for medium × 1, but only 3–12% for long × 3.
Reuse requires the same exact preface and output ceiling. Changing filters,
prompt mode, or operation can require a new prefill; this is not a promise
that every timeline call takes half as long.

## Classification and suggestions

Both repetitions produced the following scores, with zero unstable rows and
zero malformed classification runs in every variant:

| Variant | 0.12.1 TP / FP / FN / TN | 0.17.0 TP / FP / FN / TN |
|---|---|---|
| Production baseline | 17 / 1 / 1 / 21 | 17 / 1 / 1 / 21 |
| Outrage wording | 16 / 1 / 2 / 21 | 17 / 1 / 1 / 21 |
| Intent prompt | 17 / 0 / 1 / 22 | 17 / 0 / 1 / 22 |
| Combined experimental variant | 17 / 0 / 1 / 22 | 17 / 0 / 1 / 22 |

The production baseline stayed at 95% accuracy and 0.9444 F1, with identical
per-row decisions. Neither false positives nor false negatives increased in
any variant. Only experimental outrage row `p18` changed, from a false negative
to a correct match. No experimental wording was promoted to production.

All five suggestion fixtures passed in each repetition: ten complete flows
per runtime. The old runtime used the strict single-category fallback on the
humblebrag fixture in both runs; the upgraded runtime's batches parsed without
fallback. Suggestion wording changed. Automated checks establish shape and
self-consistency, not human usefulness; broad phrases such as `annoying` still
need user judgment. Suggestions remain user-selected rather than automatically
applied rules.

## Cancellation, cleanup, and startup

The real smoke covered independent posts, category and prompt changes,
suggestion generation followed by classification, two interrupt attempts,
recovery, and unload/reload. All nine classification responses were well formed
on each runtime, and suggestion validation passed.

The old runtime fulfilled a generation after a same-turn setup interrupt
(approximately 217 ms). With the cancellation epoch, that pending request
rejected before work started and interrupt settled in approximately 0.2 ms.
The upgraded 25 ms pending-work interrupt also rejected, settled at roughly
27 ms, and the next classification succeeded. The public runtime API does not
identify prefill versus active decoding, so these timings do not prove the
precise phase reached. Deferred unit fixtures additionally force cancellation
at prefill, clone, retirement, decode, and model-creation boundaries.

The upgraded smoke unloaded in 22.6 ms and reloaded cached weights in 1,054 ms,
then classified successfully. These are direct-runtime observations, not the
extension's 60-second idle-timer test or a live offscreen/tab-navigation test.

Startup varied substantially despite cached weights:

| Runtime/run | Cached engine load | First full inference |
|---|---:|---:|
| 0.12.1 first run | 1,686 ms | 18,126 ms |
| 0.12.1 repeat | 1,240 ms | 237 ms |
| 0.17.0 first run | 13,858 ms | 1,557 ms |
| 0.17.0 repeat | 1,149 ms | 266 ms |

The reports establish first-use variability; they do not establish its exact
cause or a cold-start improvement. Keep the freshly reloaded extension smoke
as an owner verification step.

Successful disposal retains one base and one completed clone, with a transient
third handle during the next clone. Errors or key changes drop that state;
unload drains work and attempts engine deletion. Best-effort disposal failures
preserve the primary error and rely on engine/offscreen teardown for any
remaining native allocations. Existing LocalEngine cancellation deadlines,
force-close, terminal-error fences, and lazy/idle lifecycle remain in place.

## WASM packaging

Chrome 137+ and Firefox 145+ package modern normal/compat pairs; Safari packages
asyncify normal/compat pairs. Loader URLs explicitly choose a packaged script
using the relaxed-SIMD probe. Safari stays on asyncify even when JSPI exists.
All builds retain the same CSP and permissions; missing assets fail the build.

| Asset set | Uncompressed bytes |
|---|---:|
| Old 0.12.1 four-file set | 38,265,137 |
| All 0.17.0 variants | 110,687,283 |
| Chrome/Firefox 0.17.0 selected set | 43,164,560 |
| Safari 0.17.0 selected set | 67,522,723 |

Selection avoids packaging unused new variants. Chrome's selected set is still
about 4.9 MB larger than the old runtime's set. This does not change the 2 GB
E2B model artifact or demonstrate lower inference memory or battery use.

## Reproduce and remaining verification

After `npm run build:dev` in `Bouncer/`, serve that directory on localhost and
open `gemma-comparison.html?model=e2b&autorun=1`. Use
`?model=e2b&scope=smoke&autorun=1` for lifecycle checks. Download the completed
JSON report from the page; reruns clear stale completion/export state.

Automated regression tests and production builds cover all three targets. Real
model verification here covers Chrome's direct runtime. The owner still needs
to reload the unpacked Chrome extension and verify the popup, live X filter
actions, reply behavior, offscreen cancellation, idle unload, and reload.
Firefox/Safari real inference and quantitative energy behavior remain untested.
