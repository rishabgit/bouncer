# Historical latency benchmark — Qwen 3.5 vs Gemma E4B

This page preserves the 2026-05-26 comparison of the then-shipped local
engines: **WebLLM/Qwen 3.5** and **LiteRT-LM/Gemma E4B**. Both have since been
removed from the product catalog. Bouncer now ships Gemma 4 E2B through
LiteRT-LM as its sole production model; see the
[current E2B decision](e2b-evaluation.md).

> **This historical run measures speed, not quality.** Qwen cost more partly
> because it wrote visible reasoning before its verdict; E4B emitted a terse
> yes/no row. Use the [historical accuracy eval](accuracy.md) for that model
> matrix and the E2B decision for current evidence.

## Historical TL;DR

On Apple Silicon, **Gemma E4B was ~2.5× faster per classification** at typical
filter counts — e.g. a medium post against 3 filters: **460 ms (E4B) vs 1,170
ms (Qwen)**. The gap was widest with few filters or long posts and narrowed as
filters were added.

The later counterbalanced run found production E2B faster again: about 213–229
ms for the medium × 3 cell versus 536–537 ms for E4B, while its artifact was
32.35% smaller.

| Test cell (post × filters) | Gemma | Qwen 3.5 | Qwen ÷ Gemma |
|---|--:|--:|--:|
| Medium × 1 | 410 ms | 1030 ms | 2.5× |
| Medium × 3 | 460 ms | 1170 ms | 2.5× |
| Medium × 5 | 580 ms | 1290 ms | 2.2× |
| Medium × 10 | 810 ms | 1150 ms | 1.4× |
| Short (~tweet) × 3 | 340 ms | 1055 ms | 3.1× |
| Long (truncation-bound) × 3 | 780 ms | 2030 ms | 2.6× |

*Warm median `inferenceTime` (generate-only). Lower is better.*

## What was measured

- **Headline = `inferenceTime`** — the generate-only span recorded by the app's inference wrapper, making these numbers comparable to live generation behavior at the time.
- **Cold-load**, **first-inference**, and **warm steady-state** were reported separately (the first two were one-off costs).
- The engines exposed different instrumentation, so the comparison used wall-clock time as the common denominator and added detail where available:
  - **Qwen (WebLLM)** reported prompt/completion tokens, time-to-first-token (approximately prefill), and decode tokens/second through `usage.extra`.
  - **Gemma E4B (LiteRT)** exposed no per-call stats, so those columns were blank.

## Environment

| | |
|---|---|
| GPU | Apple Silicon (`metal-3`) |
| Browser | Chrome 146, macOS |
| Date | 2026-05-26 |

These numbers describe this historical machine/browser run and should not be
generalized. The current tree cannot rerun the exact retired matrix; see
[Reproduction status](#reproduction-status).

## Method

- **3 warmup runs were discarded**, followed by **20 timed iterations** per cell; the median was the headline.
- Two sweeps shared a midpoint (medium post, 3 filters):
  - **filter-count** — medium post against 1 / 3 / 5 / 10 filters
  - **post length** — short / long post against 3 filters
- Inference was driven directly, bypassing the evaluation cache and per-tab batch queue, so every sample was a real uncached classification. The run was text-only.

## Results

**Qwen 3.5 4B** — WebLLM · cold-load 2279 ms · first-inference 1230 ms

| Cell | median | p90 | σ | out tokens | TTFT | decode tok/s |
|---|--:|--:|--:|--:|--:|--:|
| Medium × 1 | 1030 ms | 1060 | 16.3 | 13.1 | 747 ms | 45.6 |
| Medium × 3 | 1170 ms | 1210 | 25.3 | 19.7 | 749 ms | 46.3 |
| Medium × 5 | 1290 ms | 1330 | 22.9 | 23.9 | 782 ms | 46.5 |
| Medium × 10 | 1150 ms | 1180 | 33.7 | 15.7 | 795 ms | 45.1 |
| Short × 3 | 1055 ms | 1100 | 52.8 | 19.6 | 629 ms | 47.2 |
| Long × 3 | 2030 ms | 2050 | 44.2 | 18.1 | 1559 ms | 39.4 |

**Gemma 4 E4B** — LiteRT · cold-load 1205 ms · first-inference 460 ms

| Cell | median | p90 | σ | out chars |
|---|--:|--:|--:|--:|
| Medium × 1 | 410 ms | 410 | 2.2 | 6 |
| Medium × 3 | 460 ms | 470 | 4.6 | 9 |
| Medium × 5 | 580 ms | 580 | 0.0 | 15 |
| Medium × 10 | 810 ms | 820 | 4.8 | 30 |
| Short × 3 | 340 ms | 340 | 4.6 | 9 |
| Long × 3 | 780 ms | 790 | 6.5 | 9 |

## Findings

- **Reasoning output materially contributed to the 2.5× gap.** Qwen's latency reconstructs almost exactly as `TTFT + completion_tokens ÷ decode_rate` — e.g. Long × 3: 1559 ms + 18 tok ÷ 39 tok/s ≈ 2020 ms vs 2030 ms measured. E4B skipped the prose entirely (a 1–3 token verdict), so it had almost nothing to decode. Because the run changed both model and engine, it cannot attribute every remaining millisecond to one cause.
- **Gemma's lead shrinks as filters grow.** Its output scales with filter count (6 → 30 chars across ×1 → ×10, i.e. one verdict per category), while Qwen's reasoning length stays roughly flat. So the advantage goes 2.5× (×1) → 1.4× (×10).
- **Long posts punish Qwen.** Prefill (TTFT) jumps to 1559 ms on the truncation-bound post — over half the total — versus Gemma's 780 ms.
- **Gemma is deterministic, Qwen jitters.** Gemma runs greedy (σ ≈ 0–6 ms); Qwen samples at temperature 0.7 (σ up to 53 ms, and non-monotonic output length).
- **This run had no cold-start cliff.** First-inference ≈ warm (Qwen 1230 vs 1170 ms; E4B 460 vs 460 ms). That was not a general Apple Silicon guarantee: a preliminary E2B pass later observed a multi-second first-use outlier before browser shader caches were warm.
- **Prompt-prep overhead is negligible** — full-call wall time tracks `inferenceTime` within ~3 ms, confirming tokenize/truncate isn't a factor.

## Reproduction status

The current production tree intentionally no longer contains WebLLM/Qwen, so
it cannot reproduce this exact historical engine/model matrix. The raw exports
below are the source of truth for the 2026-05-26 result.

Use the localhost procedure in
[`e2b-evaluation.md`](e2b-evaluation.md#reproduce-the-comparison) for the current
counterbalanced E2B/E4B comparison. The current dev-only extension
`benchmark.html` separately measures E2B through the actual MV3
service-worker/offscreen path.

## Raw data

- [`data/latency-2026-05-26-apple-silicon.csv`](data/latency-2026-05-26-apple-silicon.csv) — per-cell summary
- [`data/latency-2026-05-26-apple-silicon.json`](data/latency-2026-05-26-apple-silicon.json) — full per-sample timings + token stats
- [`data/e2b-e4b-2026-07-15-e2b-first.json`](data/e2b-e4b-2026-07-15-e2b-first.json) — final-parser E2B-first samples
- [`data/e2b-e4b-2026-07-15-e4b-first.json`](data/e2b-e4b-2026-07-15-e4b-first.json) — final-parser E4B-first samples
