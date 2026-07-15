# Historical accuracy eval — Qwen 3.5 and Gemma E4B

This page preserves the 2026-06-07 Qwen 3.5/WebLLM and Gemma E4B/LiteRT result.
Neither model is selectable in the current product. Bouncer now ships Gemma 4
E2B as its sole production model; see the
[current E2B decision and contemporaneous comparison](e2b-evaluation.md).

The eval measures classification quality for one deliberately narrow filter
boundary: rage bait / outrage farming vs. ordinary negativity.

It is not a statistical benchmark. The corpus is intentionally small and
hand-auditable so prompt/filter changes can be judged from concrete examples
rather than intuition.

## Historical TL;DR from the 2026-06-07 run

On Apple Silicon, the then-shipped **Gemma E4B baseline was stronger than the
then-shipped Qwen baseline** on this corpus: 92.5% accuracy, 0.92 F1, and 2/18
ambiguous-negative false positives.

For Qwen, the baseline over-filters ordinary frustration. The intent-aware
prompt fixes that boundary in this run: 95.0% accuracy, 0.94 F1, 0/18
ambiguous-negative false positives, and recall improves from 83.3% to 88.9%.
The narrower `outrage farming` filter text alone was not a good candidate.

The 2026-07-15 contemporaneous, counterbalanced E2B/E4B runs produced 95.0%
accuracy and 0.944 F1 for E2B, versus 92.5% and 0.919 for E4B; both were
deterministic with no malformed verdicts. Qwen's tuned result here is important
context: removing Qwen is a product-simplification decision, not a universal
claim that the model family cannot classify well.

## Corpus policy

- Synthetic tweet-like posts only: no scraped posts, real handles, PII, URLs, or
  real people.
- The corpus is text-only.
- No slurs, hate speech, protected-class targeting, or extreme content.
- Positive class means "should hide": the post is engineered to farm outrage,
  invite a pile-on, or amplify anger.
- Ambiguous negatives include sincere frustration, fair criticism, personal
  hardship, civic participation, sarcasm, and calm pessimism.

The current corpus has 40 rows:

| Kind | Count | Meaning |
|------|------:|---------|
| `pos` | 18 | Rage bait / outrage farming; should hide |
| `neg-easy` | 4 | Clearly unrelated; should allow |
| `neg-amb` | 18 | Legit-but-spicy boundary cases; should allow |

## Variant matrix

The historical benchmark page ran all variants for each selected ready model:

| Variant | Filter text | Prompt mode |
|---------|-------------|-------------|
| `baseline` | `rage bait` | then-shipped prompt |
| `filter-outrage-farming` | `outrage farming` | then-shipped prompt |
| `prompt-intent` | `rage bait` | intent-aware dev prompt |
| `combined-intent-outrage-farming` | `outrage farming` | intent-aware dev prompt |

The intent-aware prompt defines rage bait as engineered anger or pile-on
amplification, and tells the model not to match sincere frustration, fair
criticism, personal hardship, civic participation, ordinary sarcasm, or calm
pessimism unless the post is also trying to farm outrage.

## Metrics

Headline metrics:

- accuracy
- precision
- recall
- F1
- specificity
- false-positive rate
- confusion matrix

Stress metrics:

- per-kind slices for `pos`, `neg-easy`, and `neg-amb`
- ambiguous-negative false positives
- unstable rows where repeated runs disagree

For Qwen, the eval used 3 runs per post and majority vote to expose stochastic
variance. Gemma was deterministic in practice, but it used the same repeated-run
shape so exports are comparable.

## Conservative ship bar

This historical eval pass did not change production behavior automatically.

A variant was only eligible for a separate production follow-up if:

- positive recall does not drop relative to baseline; and
- ambiguous-negative false positives decrease relative to baseline.

If results tie or trade off precision and recall, the correct conclusion is
"no clear winner."

## Results: 2026-06-07 Apple Silicon

Environment:

| | |
|---|---|
| GPU | Apple Silicon (`apple / metal-3`) |
| Browser | Chrome 149, macOS |
| Date | 2026-06-07 |
| Corpus | 40 rows: 18 `pos`, 4 `neg-easy`, 18 `neg-amb` |
| Runs | 3 per post, majority vote |

| Model | Variant | Acc | Precision | Recall | F1 | Specificity | TP/FP/FN/TN | Ambiguous FP | Unstable | Bar |
|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|
| Qwen 3.5 4B | `baseline` | 77.5% | 71.4% | 83.3% | 0.77 | 72.7% | 15/6/3/16 | 6/18 | 4 | baseline |
| Qwen 3.5 4B | `filter-outrage-farming` | 82.5% | 100.0% | 61.1% | 0.76 | 100.0% | 11/0/7/22 | 0/18 | 2 | no |
| Qwen 3.5 4B | `prompt-intent` | 95.0% | 100.0% | 88.9% | 0.94 | 100.0% | 16/0/2/22 | 0/18 | 2 | yes |
| Qwen 3.5 4B | `combined-intent-outrage-farming` | 95.0% | 100.0% | 88.9% | 0.94 | 100.0% | 16/0/2/22 | 0/18 | 5 | yes |
| Gemma 4 E4B | `baseline` | 92.5% | 89.5% | 94.4% | 0.92 | 90.9% | 17/2/1/20 | 2/18 | 0 | baseline |
| Gemma 4 E4B | `filter-outrage-farming` | 90.0% | 85.0% | 94.4% | 0.89 | 86.4% | 17/3/1/19 | 3/18 | 0 | no |
| Gemma 4 E4B | `prompt-intent` | 95.0% | 100.0% | 88.9% | 0.94 | 100.0% | 16/0/2/22 | 0/18 | 0 | no |
| Gemma 4 E4B | `combined-intent-outrage-farming` | 95.0% | 100.0% | 88.9% | 0.94 | 100.0% | 16/0/2/22 | 0/18 | 0 | no |

The conservative bar is model-relative: a non-baseline variant must reduce
ambiguous-negative false positives without reducing recall compared with that
model's own baseline. That is why the Gemma intent variants do not pass despite
their higher accuracy and 0 ambiguous false positives.

Findings:

- **Do not ship `outrage farming` as a filter-only wording change.** It removes
  Qwen's false positives but drops Qwen recall to 61.1%, and it increases
  Gemma's ambiguous-negative false positives from 2 to 3.
- **Qwen benefits from the intent prompt.** It removes all 6 ambiguous-negative
  false positives from baseline and improves positive recall by one row.
- **Gemma E4B baseline was the strongest then-shipped behavior under the
  conservative bar.** The intent variants removed false positives, but they
  missed 2 positives instead of baseline's 1.
- **`p15` and `p18` need label review.** Both intent variants miss them for both
  models, which suggests they may be too subtle for the current positive
  definition unless the eval deliberately wants CTA-light outrage examples.
- **`a5` and `a8` are useful trap cases.** They are ordinary frustration and
  sarcasm, and both are baseline false positives for Gemma while also appearing
  in Qwen's baseline false-positive set.

## Reproduction status

The current production tree intentionally no longer contains WebLLM/Qwen, so
it cannot reproduce this exact historical model matrix. The raw export below
is the source of truth for the 2026-06-07 result; do not re-add a retired engine
to production merely to replay it.

For the current, counterbalanced E2B/E4B accuracy run, use the localhost Gemma
comparison procedure in [`e2b-evaluation.md`](e2b-evaluation.md#reproduce-the-comparison).
The dev-only extension `benchmark.html` can separately exercise the sole E2B
model through the actual MV3 background/offscreen path.

## Raw data

- [`data/accuracy-2026-06-07-apple-silicon.json`](data/accuracy-2026-06-07-apple-silicon.json) — full per-model, per-variant, per-run eval export
- [`data/e2b-e4b-2026-07-15-e2b-first.json`](data/e2b-e4b-2026-07-15-e2b-first.json) — final-parser E2B-first report
- [`data/e2b-e4b-2026-07-15-e4b-first.json`](data/e2b-e4b-2026-07-15-e4b-first.json) — final-parser E4B-first report
