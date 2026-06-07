# Accuracy eval — rage bait boundary

This dev-only eval measures classification quality for one deliberately narrow
filter boundary: rage bait / outrage farming vs. ordinary negativity.

It is not a statistical benchmark. The corpus is intentionally small and
hand-auditable so prompt/filter changes can be judged from concrete examples
rather than intuition.

## Corpus policy

- Synthetic tweet-like posts only: no scraped posts, real handles, PII, URLs, or
  real people.
- Text-only for v1.
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

The benchmark page runs all variants for each selected ready model:

| Variant | Filter text | Prompt mode |
|---------|-------------|-------------|
| `baseline` | `rage bait` | current shipped prompt |
| `filter-outrage-farming` | `outrage farming` | current shipped prompt |
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

For Qwen, the eval uses 3 runs per post and majority vote to expose stochastic
variance. Gemma is deterministic in practice, but it uses the same repeated-run
shape so exports are comparable.

## Conservative ship bar

This eval pass does not change production behavior automatically.

A variant is only eligible for a separate production follow-up if:

- positive recall does not drop relative to baseline; and
- ambiguous-negative false positives decrease relative to baseline.

If results tie or trade off precision and recall, the correct conclusion is
"no clear winner."

## Reproduce

```bash
cd Bouncer
npm run build:dev
```

Then load the unpacked extension from `Bouncer/` in Chrome and open:

```text
chrome-extension://<actual-extension-id>/benchmark.html
```

Manual run steps:

1. Select Qwen 3.5 and Gemma if both are downloaded.
2. Click **Run accuracy eval**.
3. Click **Export eval JSON**.
4. Use the exported JSON as the source of truth for interpretation.

Codex cannot currently drive `chrome-extension://` pages through Chrome
automation, so browser execution is a manual checkpoint.
