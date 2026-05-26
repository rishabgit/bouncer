# Latency benchmark — Qwen 3.5 vs Gemma

Bouncer classifies every post on-device, so per-post latency is what you *feel* while scrolling. This compares the two local engines — **WebLLM/Qwen 3.5** (the default) and **LiteRT-LM/Gemma** — on identical inputs.

> **This measures speed, not quality.** Qwen costs more because it writes visible reasoning before its verdict; Gemma emits a terse yes/no row. Whether one classifies *better* is a separate question this benchmark does not answer.

## TL;DR

On Apple Silicon, **Gemma is ~2.5× faster per classification** at typical filter counts — e.g. a medium post against 3 filters: **460 ms (Gemma) vs 1170 ms (Qwen)**. The gap is widest with few filters or long posts, and narrows as you add more filters.

| Test cell (post × filters) | Gemma | Qwen 3.5 | Qwen ÷ Gemma |
|---|--:|--:|--:|
| Medium × 1 | 410 ms | 1030 ms | 2.5× |
| Medium × 3 | 460 ms | 1170 ms | 2.5× |
| Medium × 5 | 580 ms | 1290 ms | 2.2× |
| Medium × 10 | 810 ms | 1150 ms | 1.4× |
| Short (~tweet) × 3 | 340 ms | 1055 ms | 3.1× |
| Long (truncation-bound) × 3 | 780 ms | 2030 ms | 2.6× |

*Warm median `inferenceTime` (generate-only). Lower is better.*

## What's measured

- **Headline = `inferenceTime`** — the generate-only span the app already records and reports as `latencyUpdate`, so these numbers are directly comparable to live behaviour.
- **Cold-load**, **first-inference**, and **warm steady-state** are reported separately (the first two are one-off costs).
- The engines expose different instrumentation, so the comparison uses the common denominator (wall-clock) as the headline and layers extra detail where available:
  - **Qwen (WebLLM)** reports a full breakdown via `usage.extra`: prompt/completion tokens, time-to-first-token (≈ prefill), decode tokens/sec.
  - **Gemma (LiteRT)** exposes no per-call stats, so those columns are blank for it.

## Environment

| | |
|---|---|
| GPU | Apple Silicon (`metal-3`) |
| Browser | Chrome 146, macOS |
| Date | 2026-05-26 |

Numbers are hardware-specific — decode throughput on an integrated GPU will look very different. [Reproduce on your own machine](#reproduce) for numbers that mean anything for *you*.

## Method

- **3 warmup runs discarded**, then **20 timed iterations** per cell; the median is the headline.
- Two sweeps share a midpoint (medium post, 3 filters):
  - **filter-count** — medium post against 1 / 3 / 5 / 10 filters
  - **post length** — short / long post against 3 filters
- Inference is driven directly (bypassing the evaluation cache and the per-tab batch queue) so each run is a real, un-cached classification. Text-only throughout.

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

- **The 2.5× gap is the reasoning output.** Qwen's latency reconstructs almost exactly as `TTFT + completion_tokens ÷ decode_rate` — e.g. Long × 3: 1559 ms + 18 tok ÷ 39 tok/s ≈ 2020 ms vs 2030 ms measured. Gemma skips the prose entirely (a 1–3 token verdict), so it has almost nothing to decode.
- **Gemma's lead shrinks as filters grow.** Its output scales with filter count (6 → 30 chars across ×1 → ×10, i.e. one verdict per category), while Qwen's reasoning length stays roughly flat. So the advantage goes 2.5× (×1) → 1.4× (×10).
- **Long posts punish Qwen.** Prefill (TTFT) jumps to 1559 ms on the truncation-bound post — over half the total — versus Gemma's 780 ms.
- **Gemma is deterministic, Qwen jitters.** Gemma runs greedy (σ ≈ 0–6 ms); Qwen samples at temperature 0.7 (σ up to 53 ms, and non-monotonic output length).
- **No cold-start cliff on Apple Silicon.** First-inference ≈ warm (Qwen 1230 vs 1170 ms; Gemma 460 vs 460 ms) — the shader compile is absorbed into cold-load, not the first token. (On integrated GPUs the first call can be far slower.)
- **Prompt-prep overhead is negligible** — full-call wall time tracks `inferenceTime` within ~3 ms, confirming tokenize/truncate isn't a factor.

## Reproduce

The benchmark ships as a **dev-only** page (it is not built into production):

```bash
cd Bouncer
npm run build:dev          # builds dist/benchmark.js (omitted from prod/Firefox builds)
```

1. Load `Bouncer/` unpacked at `chrome://extensions` (Developer mode on).
2. Download the models you want to compare from the extension popup.
3. Open `chrome-extension://<your-extension-id>/benchmark.html`.
4. Run with **no x.com tab actively filtering** (it would contend for the same engine).
5. **Export JSON / CSV** when it finishes.

## Raw data

- [`data/latency-2026-05-26-apple-silicon.csv`](data/latency-2026-05-26-apple-silicon.csv) — per-cell summary
- [`data/latency-2026-05-26-apple-silicon.json`](data/latency-2026-05-26-apple-silicon.json) — full per-sample timings + token stats
