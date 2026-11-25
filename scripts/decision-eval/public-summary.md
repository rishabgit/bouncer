Decision models return a yes/no probability for each post and filter phrase, avoiding a generated text answer. The selected model for this evaluation is **LiquidAI/d1-2B-GGUF Q8_0 in Llama.app**, using `matches-category` and the frozen cutoff `probability >= 0.290813258948728`. It combines strong original validation with a 1.85 GB text artifact and warm medians of about 47 ms for three filters and 87 ms for ten on an Apple M5 Pro with 64 GB RAM.

- **Original validation:** 72/72 and 119/120 exact filter vectors, with all 192 hide/show decisions correct across the two corpora. These corpora were already used for Gemma; this is bounded comparative evidence.
- **Wording probe:** descriptive labels made 5/940 filter-decision errors, versus 36 and 45 for two short-label variants. This reused existing cases and did not retune the cutoff.
- **Fresh behaviour filters:** on 482 unambiguous decisions across 84 new synthetic posts, guided phrases reduced errors from 141 to 66 and near-miss false hides from 33 to 18. Adding exclusions did not pass its gate; adding a full keep sentence also worsened results.
- **Larger models:** d1-3B, Kev-4B and Clef-Flash made 71, 66 and 39 guided-label errors. None met the preregistered quality-and-speed switch rule, so d1-2B remains the evaluation choice.

To evaluate a future model, add its identity and runtime settings to `scripts/decision-eval/registry.mjs`, start Llama.app with its local API enabled (4096-token context, one slot, text-only), then run from the repository root:

```bash
node scripts/decision-eval/run.mjs all <id>
```

That command records discovery, freezes the template and cutoff, measures three speed repetitions, and updates the report. Register independent validation before using it to justify a model change. The saved results below do not qualify a production extension integration.

Publication note: metadata and hash bindings were normalized for this public copy; scored inputs, labels, probabilities and measurements are unchanged. See [publication provenance](data/decision-publication.json).
