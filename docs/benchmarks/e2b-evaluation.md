# Gemma 4 E2B production decision

**Decision (2026-07-15): ship Gemma 4 E2B through LiteRT-LM as Bouncer's sole
production model.** Remove the WebLLM/Qwen, vision, custom-model, and product
model-picker paths. Retain the `LocalBackend` lifecycle seam, with LiteRT-LM as
its only implementation. Keep Gemma 4 E4B only in the dev localhost benchmark
harness.

This is a one-model product, not a permanent two-model pipeline. E4B is neither
shown in the popup nor loaded by normal filtering.

## Why this question existed

Upstream Bouncer had already replaced WebLLM/Qwen in its desktop local path
with LiteRT/Gemma and added E2B alongside E4B in its local catalog. E2B was
therefore not an overlooked model that upstream's authors had declined to use.
Upstream still retains cloud providers and both Gemma sizes; making E2B the
only production model is this personal fork's stronger simplification. The
fork had retained its older WebLLM/Qwen architecture while exposing E4B and
had not yet supplied its own quantitative E2B comparison. This work closes
that evidence gap on the only machine the fork needs to optimize for.

## Artifacts

| | Gemma 4 E2B | Gemma 4 E4B |
|---|---:|---:|
| Role after decision | Sole production model | Dev-only comparator |
| Artifact bytes | 2,008,432,640 | 2,969,059,328 |
| GiB | 1.870 | 2.765 |
| Difference | 960,626,688 bytes smaller | — |
| Relative difference | 32.35% smaller | — |

The E2B artifact is pinned to
`litert-community/gemma-4-E2B-it-litert-lm@9262660a1676eed6d0c477ab1a86344430854664`
(`gemma-4-E2B-it-web.litertlm`, LFS SHA-256
`3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5`).
The production URL still points to that revision-pinned upstream repository;
it has **not yet been copied to a fork-owned mirror**.

## Test environment and method

| | |
|---|---|
| Machine | MacBook Pro |
| Processor | Apple M5 Pro, 18 cores |
| Memory | 64 GB |
| Browser | Chrome on macOS |
| Power during comparison | AC power; battery near full, not charging |
| Date | 2026-07-15 |

The dev-only normal-page runner instantiated the same LiteRT runtime and reused
the production prompt builders, output-budget logic, strict parser, latency
corpus, accuracy corpus, and suggestion flow. It used three discarded warmups
and twenty timed latency samples per cell. Model order was counterbalanced:
one full run loaded E2B first and one loaded E4B first. Both artifacts were in
the browser's localhost Cache Storage before hot measurements.

Full structured reports, including every timed sample and model response, are
tracked for the [E2B-first run](data/e2b-e4b-2026-07-15-e2b-first.json) and the
[E4B-first run](data/e2b-e4b-2026-07-15-e4b-first.json).

The reported `fullCallMs` includes prompt budgeting, truncation, and generation,
but deliberately excludes the MV3 service-worker/offscreen IPC used by the
extension. The ordinary extension benchmark remains the check for that product
path. No X tab was actively filtering during the direct comparison.

## Latency results

Counterbalanced hot medians stayed strongly in E2B's favor:

| Cell | E2B-first run: E2B | E2B-first run: E4B | E4B-first run: E4B | E4B-first run: E2B |
|---|---:|---:|---:|---:|
| Medium × 1 filter | 118.8 ms | 333.8 ms | 333.9 ms | 127.8 ms |
| Medium × 3 filters | 213.2 ms | 537.0 ms | 536.2 ms | 229.3 ms |
| Medium × 5 filters | 261.1 ms | 574.4 ms | 572.8 ms | 289.6 ms |
| Medium × 10 filters | 408.8 ms | 832.9 ms | 832.9 ms | 435.9 ms |
| Short × 3 filters | 178.9 ms | 421.4 ms | 420.8 ms | 194.1 ms |
| Long × 3 filters | 298.6 ms | 791.0 ms | 763.1 ms | 350.7 ms |

E2B's second-position run was modestly slower, which is exactly why the test
was counterbalanced. It remained much faster in every cell.

Load and first-inference observations:

| Order | Model | Cached load | First inference |
|---|---|---:|---:|
| E2B first | E2B | 1,226 ms | 237 ms |
| E2B first | E4B | 2,087 ms | 544 ms |
| E4B first | E4B | 1,970 ms | 772 ms |
| E4B first | E2B | 1,314 ms | 234 ms |

These are hot browser-cache observations, not cold-start guarantees. A
preliminary pass before the final tracked parser build observed a one-off
multi-second first E2B inference consistent with shader compilation; browser
shader caches then survived attempts to reproduce a symmetric fresh-cache
comparison. That exploratory observation is retained as startup risk, but is
not mixed into the two final report tables.

## Classification results

The 40-row synthetic rage-bait boundary corpus ran three times per post. Both
models were deterministic in these runs and produced no malformed verdicts.

| Model | Accuracy | Precision | Recall | F1 | TP / FP / FN / TN | Unstable rows | Malformed runs |
|---|---:|---:|---:|---:|---|---:|---:|
| Gemma 4 E2B | 95.0% | 94.4% | 94.4% | 0.944 | 17 / 1 / 1 / 21 | 0 | 0 |
| Gemma 4 E4B | 92.5% | 89.5% | 94.4% | 0.919 | 17 / 2 / 1 / 20 | 0 | 0 |

This is evidence for one narrow, hand-auditable boundary, not a general model
benchmark. E2B nevertheless clears the practical adoption question: it did not
trade the size and speed gains for weaker measured classification.

## “Bounce this tweet” suggestion flow

Five synthetic tweet-like fixtures covered disgust/pile-on, crypto FOMO,
celebrity drama, AI hype, and humblebrag content. Each model had to generate
nine unique one-to-three-word candidates and pass those candidates through the
same strict self-validation used by the product.

| Model | Complete product flows | Mean generation + validation time | Fallback behavior |
|---|---:|---:|---|
| Gemma 4 E2B | 10 / 10 | ~1.23 s | Two malformed batches retried safely per category |
| Gemma 4 E4B | 10 / 10 | ~2.03 s | No malformed final flow |

In each order, E2B omitted labels in one batch response. The parser did not
guess or turn that into “all no”; production-equivalent fallback checked
candidates sequentially through the one-category path and stopped once three
were accepted. That behavior is part of the result, not a benchmark-only
parser exception.

Manual inspection found useful accepted phrases across all five E2B fixtures,
though not every phrase was equally polished. The automated gate only verifies
shape and model self-consistency; semantic usefulness still requires human
review. Five synthetic prompts are sufficient for this product decision, not a
claim about open-ended generation quality.

## Historical Qwen context

The previously shipped Qwen 3.5/WebLLM baseline scored 77.5% accuracy, 0.77 F1,
and four unstable rows on the same rage-bait corpus. A historical medium × 3
classification took about 1,170 ms, versus about 460 ms for the then-current
E4B/LiteRT path. A tuned Qwen intent prompt reached 95% accuracy, so these data
do **not** establish that Qwen or WebLLM is universally worse. They establish
that retaining that extra engine, model catalog, vision branch, cache format,
and picker did not earn its complexity in this personal text-only fork.

The historical Qwen/E4B run changed model, runtime, prompt shape, and output
length together; it does not isolate LiteRT as an intrinsically faster engine.
The E2B/E4B run controls the runtime but compares two Gemma sizes. The decision
therefore concerns the measured end-to-end stacks on the target Mac, which is
the product question that matters here, rather than a universal engine ranking.

## Battery and memory interpretation

No numeric energy claim is supported. The comparison ran on AC power, and
browser inference spans multiple GPU/process components that a simple per-tab
CPU sample does not capture. E2B's smaller artifact proves lower download and
storage cost; its lower latency means less active inference time; production
also loads the model lazily. Those are good reasons to prefer it for a laptop
that is sometimes on battery, but not a measured battery-life percentage.

The observed models fit without swap during the run, but whole-system memory
pressure was high and noisy because other applications were active. A future
energy result should use an unplugged, counterbalanced whole-system AB/BA
run with the same workload and integrated battery current/voltage over time.

## Reproduce the comparison

```bash
cd Bouncer
npm run build:dev
python3 -m http.server 8123 --bind 127.0.0.1
```

Open both orders in Chrome, one at a time, with no X tab actively filtering:

```text
http://127.0.0.1:8123/gemma-comparison.html?order=e2b-first
http://127.0.0.1:8123/gemma-comparison.html?order=e4b-first
```

Add `&autorun=1` to start automatically. The first run downloads both artifacts
into that localhost origin's Cache Storage; later runs use the cache. The page
places its structured report in `globalThis.__BOUNCER_GEMMA_REPORT__` and also
renders it in the page.

The localhost surface exists because browser automation cannot control another
extension's `chrome-extension://` pages. It has no extension privileges and
does not weaken the production extension's security boundary.

## Residual follow-ups

- Mirror the exact pinned E2B artifact into a fork-owned repository if independent availability becomes important.
- Manually reload the unpacked extension after this migration and smoke-test the popup plus injected X UI; automation cannot reload or inspect another extension's popup.
- Run an unplugged, quiet-system energy comparison before making a battery-life claim.
- Add separate capability fixtures before relying on the model for any future structured feedback or filter-interpretation feature.
