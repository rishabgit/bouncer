# Decision-model evaluation

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

## Detailed recorded evidence: phase 1b and phase 2

**Recorded evidence: 9/9 variants have frozen discovery selections and all three speed repetitions.** Generated from recorded JSON only; report generation performs no inference.

The phase-1b comparison is exploratory discovery, not production qualification. The 40 rage and 48 broad cases tune one template and shared `probability >= cutoff` threshold per variant. Leave-one-out selection repeats that tuning without each held-out discovery case. It estimates selection optimism on this small corpus; it is not independent decision-model validation. Both later validation corpora were previously used to qualify Gemma, so neither is globally untouched. Recorded phase-2 validation status and preregistered gates appear below.

`ggml-org/d1-Omni-2B-GGUF` is the `lfm3` LFM3 Omni 2B checkpoint. Ollama `d1:2b` is the different `lfm3_vl` Liquid d1-2B checkpoint, paired here with `LiquidAI/d1-2B-GGUF`. The 600M Omni checkpoint is separate again. Similar names do not establish a same-checkpoint comparison. `filter-decision` never won phase 1 and is omitted from phase 1b; the remaining templates are `matches-category` and `category-applies`.

| Variant | Format | Disk GB | Steady RSS / footprint GiB | Warm ×3 p50 / p90 ms (n) | Warm ×10 p50 / p90 ms (n) | Cold ms | Discovery exact: chosen; 0.5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gemma 4 E2B Browser / LiteRT-LM 0.17.0 (historical) | LiteRT-LM text-only | 2.008 | 2.121 / 3.000 increment | 173.95 / 187.10 (60) | 400.30 / 411.50 (60) | 1437.90 | 78/88 (historical prompt) |
| Gemma 4 E2B original combined QAT / Ollama (historical) | gguf Q4_0 | 4.336 | 4.339 / 1.157 | 136.35 / 145.70 (60) | 271.70 / 286.80 (60) | 2766.00 | 73/88 (historical prompt) |
| Gemma 4 E2B original NVFP4 / Ollama MLX (historical) | safetensors nvfp4 | 7.477 | 1.468 / 7.113 | 127.20 / 131.10 (60) | 147.35 / 152.70 (60) | 3846.90 | 60/88 (historical prompt) |
| llama-kev-q8 | GGUF Q8_0 | 0.812 | 1.265 / 0.398 | 97.11 / 116.50 (60) | 332.59 / 432.66 (60) | 1377.05 | 82/88; 62/88 |
| ollama-kev-q8 | GGUF Q8_0 | 0.812 | 1.615 / 0.770 | 81.10 / 100.90 (60) | 212.03 / 248.70 (60) | 615.96 | 82/88; 62/88 |
| ollama-kev-mxfp8 | MLX MXFP8 | 1.038 | 1.021 / 2.097 | 32.37 / 37.62 (60) | 83.76 / 89.58 (60) | 355.89 | 81/88; 64/88 |
| llama-d1omni2b-q8 | GGUF Q8_0 | 1.846 | 2.009 / 0.178 | 49.19 / 56.21 (60) | 103.98 / 105.89 (60) | 1428.78 | 84/88; 81/88 |
| llama-d1-2b-q8 | GGUF Q8_0 | 1.846 | 2.007 / 0.175 | 46.69 / 50.57 (60) | 87.31 / 90.19 (60) | 1340.97 | 86/88; 78/88 |
| llama-d1-2b-q4km | GGUF Q4_K_M | 1.100 | 1.312 / 0.175 | 48.81 / 49.60 (60) | 91.97 / 107.16 (60) | 1301.55 | 87/88; 79/88 |
| ollama-d1-2b-mxfp8 | MLX MXFP8 | 2.434 | 2.459 / 2.399 | 40.22 / 53.97 (60) | 70.05 / 139.97 (60) | 655.23 | 86/88; 79/88 |
| ollama-d1-2b-nvfp4 | MLX NVFP4 | 1.747 | 1.827 / 1.763 | 37.31 / 43.26 (60) | 71.97 / 94.35 (60) | 555.45 | 86/88; 79/88 |
| llama-d1omni600m-q8 | GGUF Q8_0 | 0.407 | 0.625 / 0.150 | 50.24 / 52.48 (60) | 157.73 / 167.90 (60) | 1347.85 | 75/88; 61/88 |

Historical Gemma rows come from the [recorded baseline file](data/decision-baselines.json), which names their aggregate and raw evidence sources. Browser used a 1024-token budget; original Ollama Gemma QAT and MLX requested 1024 but allocated 2048. The QAT reference is the original combined package, not the later text-only import. Historical memory uses a loaded-model increment for Browser and the serving process tree for Ollama; current decision rows all use 4096 tokens and one slot. Historical prompts have no probability cutoff.

| Variant | Model | Format | Logical / allocated GB | Disk scope | Projector |
| --- | --- | --- | --- | --- | --- |
| llama-kev-q8 | ggml-org/Kev-0.8B-GGUF:Q8_0 | GGUF Q8_0 | 0.812 / 0.812 | Primary text GGUF only; projector excluded (no-mmproj) | false |
| ollama-kev-q8 | bouncer-eval-kev-q8-ctx4096:v1 | GGUF Q8_0 | 0.812 / 0.812 | Full derived-alias package; any vision/projector tensors included; shared blobs charged fully | package components retained; no image requests |
| ollama-kev-mxfp8 | bouncer-eval-kev-mxfp8-ctx4096:v1 | MLX MXFP8 | 1.038 / 1.040 | Full derived-alias package; any vision/projector tensors included; shared blobs charged fully | package components retained; no image requests |
| llama-d1omni2b-q8 | ggml-org/d1-Omni-2B-GGUF:Q8_0 | GGUF Q8_0 | 1.846 / 1.846 | Primary text GGUF only; projector excluded (no-mmproj) | false |
| llama-d1-2b-q8 | LiquidAI/d1-2B-GGUF:Q8_0 | GGUF Q8_0 | 1.846 / 1.862 | Primary text GGUF only; projector excluded (no-mmproj) | false |
| llama-d1-2b-q4km | LiquidAI/d1-2B-GGUF:Q4_K_M | GGUF Q4_K_M | 1.100 / 1.107 | Primary text GGUF only; projector excluded (no-mmproj) | false |
| ollama-d1-2b-mxfp8 | bouncer-eval-d1-2b-mxfp8-ctx4096:v1 | MLX MXFP8 | 2.434 / 2.436 | Full derived-alias package; any vision/projector tensors included; shared blobs charged fully | package components retained; no image requests |
| ollama-d1-2b-nvfp4 | bouncer-eval-d1-2b-nvfp4-ctx4096:v1 | MLX NVFP4 | 1.747 / 1.752 | Full derived-alias package; any vision/projector tensors included; shared blobs charged fully | package components retained; no image requests |
| llama-d1omni600m-q8 | LiquidAI/d1-omni-600M-GGUF:Q8_0 | GGUF Q8_0 | 0.407 / 0.419 | Primary text GGUF only; projector excluded (no-mmproj) | false |

Llama GGUF rows account for the primary text weights with no projector. Native-package rows account for all manifest blobs, including any bundled projector, even when only text is submitted. Shared blobs are charged fully per variant; runtime binaries and unrelated artifacts are excluded. Logical GB are decimal; memory GiB are binary.

| Variant | Template / cutoff and equivalent interval | Rage hide correct; F1 | Broad hide correct; exact vectors | All exact vectors | FH / MH | New FH / new MH vs Browser |
| --- | --- | --- | --- | --- | --- | --- |
| Browser Gemma (historical) | Historical prompt; no tuned cutoff | 38/40; F1 0.9444 | 47/48; F1 0.9870; E 40/48 | 78/88 | 1 / 2 | 0 / 0 (self) |
| llama-kev-q8 | category-applies ≥ 0.2572612698276897; {"lower":0.25177443662341864,"upper":0.26274810303196083,"width":0.010973666408542193,"lowerInclusive":false,"upperInclusive":true} | 37/40; F1 0.9091 | 47/48; F1 0.9873; E 45/48 | 82/88 | 1 / 3 | 1 / 2 |
| llama-kev-q8 | Same template at 0.5 | 22/40; F1 — | 47/48; F1 0.9870; E 40/48 | 62/88 | 0 / 19 | 0 / 18 |
| llama-kev-q8 | Leave-one-out selection | 36/40; F1 0.8824 | 47/48; F1 0.9873; E 45/48 | 81/88 | 2 / 3 | 2 / 2 |
| ollama-kev-q8 | category-applies ≥ 0.25732378754453744; {"lower":0.25177999579519106,"upper":0.26286757929388377,"width":0.01108758349869271,"lowerInclusive":false,"upperInclusive":true} | 37/40; F1 0.9091 | 47/48; F1 0.9873; E 45/48 | 82/88 | 1 / 3 | 1 / 2 |
| ollama-kev-q8 | Same template at 0.5 | 22/40; F1 — | 47/48; F1 0.9870; E 40/48 | 62/88 | 0 / 19 | 0 / 18 |
| ollama-kev-q8 | Leave-one-out selection | 36/40; F1 0.8824 | 47/48; F1 0.9873; E 45/48 | 81/88 | 2 / 3 | 2 / 2 |
| ollama-kev-mxfp8 | matches-category ≥ 0.24635; {"lower":0.2341,"upper":0.2586,"width":0.024499999999999994,"lowerInclusive":false,"upperInclusive":true} | 36/40; F1 0.8750 | 48/48; F1 1.0000; E 45/48 | 81/88 | 0 / 4 | 0 / 3 |
| ollama-kev-mxfp8 | Same template at 0.5 | 24/40; F1 0.2000 | 48/48; F1 1.0000; E 40/48 | 64/88 | 0 / 16 | 0 / 15 |
| ollama-kev-mxfp8 | Leave-one-out selection | 34/40; F1 0.8235 | 47/48; F1 0.9873; E 44/48 | 78/88 | 3 / 4 | 3 / 3 |
| llama-d1omni2b-q8 | category-applies ≥ 0.3673823582338168; {"lower":0.319075137843794,"upper":0.4156895786238397,"width":0.09661444078004572,"lowerInclusive":false,"upperInclusive":true} | 37/40; F1 0.9091 | 48/48; F1 1.0000; E 47/48 | 84/88 | 0 / 3 | 0 / 2 |
| llama-d1omni2b-q8 | Same template at 0.5 | 34/40; F1 0.8000 | 48/48; F1 1.0000; E 47/48 | 81/88 | 0 / 6 | 0 / 5 |
| llama-d1omni2b-q8 | Leave-one-out selection | 36/40; F1 0.8824 | 48/48; F1 1.0000; E 46/48 | 82/88 | 1 / 3 | 0 / 2 |
| llama-d1-2b-q8 | matches-category ≥ 0.290813258948728; {"lower":0.24152816538963,"upper":0.34009835250782594,"width":0.09857018711819593,"lowerInclusive":false,"upperInclusive":true} | 38/40; F1 0.9412 | 48/48; F1 1.0000; E 48/48 | 86/88 | 0 / 2 | 0 / 2 |
| llama-d1-2b-q8 | Same template at 0.5 | 34/40; F1 0.8000 | 48/48; F1 1.0000; E 44/48 | 78/88 | 0 / 6 | 0 / 5 |
| llama-d1-2b-q8 | Leave-one-out selection | 38/40; F1 0.9412 | 48/48; F1 1.0000; E 47/48 | 85/88 | 0 / 2 | 0 / 2 |
| llama-d1-2b-q4km | matches-category ≥ 0.19309390962744738; {"lower":0.19069574028747055,"upper":0.19549207896742424,"width":0.004796338679953688,"lowerInclusive":false,"upperInclusive":true} | 39/40; F1 0.9714 | 48/48; F1 1.0000; E 48/48 | 87/88 | 0 / 1 | 0 / 1 |
| llama-d1-2b-q4km | Same template at 0.5 | 35/40; F1 0.8387 | 48/48; F1 1.0000; E 44/48 | 79/88 | 0 / 5 | 0 / 4 |
| llama-d1-2b-q4km | Leave-one-out selection | 37/40; F1 0.9143 | 48/48; F1 1.0000; E 48/48 | 85/88 | 1 / 2 | 1 / 2 |
| ollama-d1-2b-mxfp8 | matches-category ≥ 0.27881950546494283; {"lower":0.2050145141967262,"upper":0.35262449673315943,"width":0.14760998253643323,"lowerInclusive":false,"upperInclusive":true} | 38/40; F1 0.9412 | 48/48; F1 1.0000; E 48/48 | 86/88 | 0 / 2 | 0 / 2 |
| ollama-d1-2b-mxfp8 | Same template at 0.5 | 35/40; F1 0.8387 | 48/48; F1 1.0000; E 44/48 | 79/88 | 0 / 5 | 0 / 4 |
| ollama-d1-2b-mxfp8 | Leave-one-out selection | 38/40; F1 0.9412 | 48/48; F1 1.0000; E 47/48 | 85/88 | 0 / 2 | 0 / 2 |
| ollama-d1-2b-nvfp4 | matches-category ≥ 0.32208209372244256; {"lower":0.2915396907117257,"upper":0.35262449673315943,"width":0.061084806021433735,"lowerInclusive":false,"upperInclusive":true} | 38/40; F1 0.9412 | 48/48; F1 1.0000; E 48/48 | 86/88 | 0 / 2 | 0 / 2 |
| ollama-d1-2b-nvfp4 | Same template at 0.5 | 35/40; F1 0.8387 | 48/48; F1 1.0000; E 44/48 | 79/88 | 0 / 5 | 0 / 4 |
| ollama-d1-2b-nvfp4 | Leave-one-out selection | 38/40; F1 0.9412 | 47/48; F1 0.9873; E 45/48 | 83/88 | 1 / 2 | 1 / 2 |
| llama-d1omni600m-q8 | category-applies ≥ 0.18632284005027672; {"lower":0.18571860057504924,"upper":0.18692707952550416,"width":0.001208478950454922,"lowerInclusive":false,"upperInclusive":true} | 32/40; F1 0.7778 | 48/48; F1 1.0000; E 43/48 | 75/88 | 4 / 4 | 4 / 4 |
| llama-d1omni600m-q8 | Same template at 0.5 | 25/40; F1 0.2857 | 44/48; F1 0.9459; E 36/48 | 61/88 | 0 / 19 | 0 / 18 |
| llama-d1omni600m-q8 | Leave-one-out selection | 32/40; F1 0.7778 | 47/48; F1 0.9873; E 41/48 | 73/88 | 5 / 4 | 5 / 4 |

FH/MH are false hides/missed hides. New FH and new MH count regressions only against a known Browser-correct decision on the same exact case; unavailable paired evidence is —, never zero. Exact vectors require every ordered category answer to match. Undefined ratios are —. Discovery results are stored scores, not recomputed by this renderer.

| Variant | Warm ×3 p50 / p90 ms (n) | ×3 input tokens mean (min–max) | Warm ×10 p50 / p90 ms (n) | ×10 input tokens mean (min–max) | Cold median ms | Identical repeated probabilities |
| --- | --- | --- | --- | --- | --- | --- |
| Browser Gemma (historical) | 173.95 / 187.10 (60) | different tokenizer | 400.30 / 411.50 (60) | different tokenizer | 1437.90 | not a probability API |
| llama-kev-q8 | 97.11 / 116.50 (60) | 424.7 (404–440) | 332.59 / 432.66 (60) | 1418.0 (1349–1469) | 1377.05 | yes (5 × 3 controls) |
| ollama-kev-q8 | 81.10 / 100.90 (60) | 424.7 (404–440) | 212.03 / 248.70 (60) | 1418.0 (1349–1469) | 615.96 | yes (5 × 3 controls) |
| ollama-kev-mxfp8 | 32.37 / 37.62 (60) | 391.7 (371–407) | 83.76 / 89.58 (60) | 1308.0 (1239–1359) | 355.89 | yes (5 × 3 controls) |
| llama-d1omni2b-q8 | 49.19 / 56.21 (60) | 252.4 (243–257) | 103.98 / 105.89 (60) | 593.4 (584–598) | 1428.78 | yes (5 × 3 controls) |
| llama-d1-2b-q8 | 46.69 / 50.57 (60) | 219.4 (210–224) | 87.31 / 90.19 (60) | 483.4 (474–488) | 1340.97 | yes (5 × 3 controls) |
| llama-d1-2b-q4km | 48.81 / 49.60 (60) | 219.4 (210–224) | 91.97 / 107.16 (60) | 483.4 (474–488) | 1301.55 | yes (5 × 3 controls) |
| ollama-d1-2b-mxfp8 | 40.22 / 53.97 (60) | 219.4 (210–224) | 70.05 / 139.97 (60) | 483.4 (474–488) | 655.23 | yes (5 × 3 controls) |
| ollama-d1-2b-nvfp4 | 37.31 / 43.26 (60) | 219.4 (210–224) | 71.97 / 94.35 (60) | 483.4 (474–488) | 555.45 | yes (5 × 3 controls) |
| llama-d1omni600m-q8 | 50.24 / 52.48 (60) | 486.7 (457–505) | 157.73 / 167.90 (60) | 1626.0 (1527–1687) | 1347.85 | yes (5 × 3 controls) |

Each primary cell pools 20 unchanged medium posts across three repetitions (60 samples), with a fresh model child and distinct warmups before each cell. P90 is nearest rank. Cold is the median unloaded-to-first-answer wall time with downloaded weights and uncontrolled OS file cache. Per-row input-token counts remain in the receipts. No input truncation is permitted. Serial execution uses one loaded benchmark model and one request in flight; all phase-1b effective contexts are pinned to 4096 and parallelism to one. These are configured-stack timings, not extension lifecycle or concurrent-serving measurements.

| Variant: common matches-category template | Parity ×3 p50 / p90 ms (n) | ×3 input tokens mean (min–max) | Parity ×10 p50 / p90 ms (n) | ×10 input tokens mean (min–max) |
| --- | --- | --- | --- | --- |
| llama-kev-q8 | 95.96 / 116.37 (60) | 391.7 (371–407) | 309.76 / 415.93 (60) | 1308.0 (1239–1359) |
| ollama-kev-q8 | 77.18 / 80.78 (60) | 391.7 (371–407) | 199.33 / 280.65 (60) | 1308.0 (1239–1359) |
| llama-d1-2b-q8 | 46.92 / 48.50 (60) | 219.4 (210–224) | 87.51 / 108.37 (60) | 483.4 (474–488) |
| llama-d1-2b-q4km | 48.65 / 50.11 (60) | 219.4 (210–224) | 91.99 / 104.13 (60) | 483.4 (474–488) |
| ollama-d1-2b-mxfp8 | 37.59 / 41.43 (60) | 219.4 (210–224) | 68.43 / 78.58 (60) | 483.4 (474–488) |
| ollama-d1-2b-nvfp4 | 37.22 / 39.39 (60) | 219.4 (210–224) | 70.26 / 86.58 (60) | 483.4 (474–488) |

Parity cells compare Kev Q8 across runtimes and the Liquid d1-2B GGUF Q8/Q4_K_M pair against Ollama MXFP8/NVFP4 using the same category template. Shared text and categories do not guarantee identical token counts. Recorded discrepancies and checkpoint bindings are in the [parity receipt](data/decision-1b-parity.json).

| Variant | Steady RSS GiB | Steady physical footprint GiB | Full-run peak RSS GiB | Full-run peak physical footprint GiB |
| --- | --- | --- | --- | --- |
| Browser Gemma (historical increment) | 2.064–2.185 | 1.957–3.001 | 2.408 | 3.290 |
| llama-kev-q8 | 1.265 | 0.398 | 1.267 | 0.468 |
| ollama-kev-q8 | 1.615 | 0.770 | 1.616 | 0.837 |
| ollama-kev-mxfp8 | 1.021 | 2.097 | 1.051 | 6.571 |
| llama-d1omni2b-q8 | 2.009 | 0.178 | 2.013 | 0.245 |
| llama-d1-2b-q8 | 2.007 | 0.175 | 2.009 | 0.241 |
| llama-d1-2b-q4km | 1.312 | 0.175 | 1.314 | 0.242 |
| ollama-d1-2b-mxfp8 | 2.459 | 2.399 | 2.489 | 3.376 |
| ollama-d1-2b-nvfp4 | 1.827 | 1.763 | 1.850 | 2.527 |
| llama-d1omni600m-q8 | 0.625 | 0.150 | 0.627 | 0.216 |

Steady values are medians of three five-second loaded-idle process-tree medians. Peaks cover the full run, including cold initialization, warmup, timed cells and controls. RSS and physical footprint answer different questions: memory-mapped GGUF weights can appear in RSS without being charged to physical footprint; MLX weights are generally charged to footprint. Neither metric alone gives a fair cross-format model-size comparison. Peak RSS and footprint need not occur at the same sample. Sampling every 200 ms may miss shorter spikes; raw sample lists are archived rather than embedded in public summaries.

Historical Browser reference: loaded-model physical-footprint increment 1.957–3.001 GiB, rather than whole shared-Chrome memory. Its original medium-post warm medians were 173.95 / 400.30 ms for three/ten filters. Browser uses the separately pinned Gemma artifact and historical prompt; these normal-page results do not qualify current MV3/offscreen/download/switching behavior. Historical native results remain in [portable baselines](data/decision-baselines.json), with their own corpus and runtime provenance.

| Variant | Runtime | Version | Build | Effective context | Parallel | Batch / ubatch | Runner | Quantization | Alias definition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llama-kev-q8 | llama | 0.49.0 | b12652-212c547fe | 4096 | 1 | 2048 / 512 | llamacpp | Q8_0 | — |
| ollama-kev-q8 | ollama | 0.40.18 | official-v0.40.18 | 4096 | 1 | — / — | llamacpp | Q8_0 | {"model":"bouncer-eval-kev-q8-ctx4096:v1","from":"kev:0.8b-q8_0","sourceDigest":"a2f47e09befbeaf7548572310d46f794b05c010a20ea5e64e9947eb479c23b31","parameters":{"num_ctx":4096}} |
| ollama-kev-mxfp8 | ollama | 0.40.18 | official-v0.40.18 | 4096 | 1 | — / — | mlx | MXFP8 | {"model":"bouncer-eval-kev-mxfp8-ctx4096:v1","from":"kev:0.8b-mxfp8","sourceDigest":"e414a229c2b8b6438d4d71eda4eb3e7c275e5ee107efc5afd3f7798f36a03ead","parameters":{"num_ctx":4096}} |
| llama-d1omni2b-q8 | llama | 0.49.0 | b12652-212c547fe | 4096 | 1 | 4096 / 4096 | llamacpp | Q8_0 | — |
| llama-d1-2b-q8 | llama | 0.49.0 | b12652-212c547fe | 4096 | 1 | 4096 / 4096 | llamacpp | Q8_0 | — |
| llama-d1-2b-q4km | llama | 0.49.0 | b12652-212c547fe | 4096 | 1 | 4096 / 4096 | llamacpp | Q4_K - Medium | — |
| ollama-d1-2b-mxfp8 | ollama | 0.40.18 | official-v0.40.18 | 4096 | 1 | — / — | mlx | MXFP8 | {"model":"bouncer-eval-d1-2b-mxfp8-ctx4096:v1","from":"d1:2b-mxfp8","sourceDigest":"52dfb1fc6ba698290ccbbb7c20dc1f20b883c0bf4ca28ec14b55760b2ccfb943","parameters":{"num_ctx":4096}} |
| ollama-d1-2b-nvfp4 | ollama | 0.40.18 | official-v0.40.18 | 4096 | 1 | — / — | mlx | NVFP4 | {"model":"bouncer-eval-d1-2b-nvfp4-ctx4096:v1","from":"d1:2b-nvfp4","sourceDigest":"82c19b76395aa3e625ae28dc9e8ab390351ac3cc41056be7b4fc9865c593953d","parameters":{"num_ctx":4096}} |
| llama-d1omni600m-q8 | llama | 0.49.0 | b12652-212c547fe | 4096 | 1 | 4096 / 4096 | llamacpp | Q8_0 | — |

The d1 Llama.app runs required a manual text-only override: batch and ubatch 4096, automatic projector disabled, context 4096 and one slot. The three LiquidAI presets also needed explicit matching `hf-repo` keys before loading worked; the [resolved host-setup receipt](data/decision-1b-blocker.json) records that repair. This is integration friction a Bouncer user would encounter. Their memory is measured with those text-only settings, excluding projector files.

Context is read from each loaded runner; Llama slots and projector state come from `/props`, and explicit batch limits come from router arguments. Kev retains llama.cpp defaults of batch 2048 / ubatch 512. Ollama parallelism is the host launch contract `OLLAMA_NUM_PARALLEL=1`, with one request in flight; its API does not expose batch/ubatch, so those fields stay —. Llama.app version 0.49.0 and the official Ollama build provenance were established by the host; llama.cpp build and Ollama version are read back. Native quantization labels are bound to the package identity, not inferred from latency. Artifact identity, discovery bytes, frozen choice and these normalized runtime settings are bound by receipts.

[Historical phase-1 summary](data/decision-phase1.json) retains the retired Laya variants and original d1 integration friction; those runs do not join the normalized phase-1b comparison.

| Retired phase-1 Laya variant | Format | Disk GB | Rage correct /40 | Broad hide /48; exact /48 | New FH | Warm ×3 /×10 median ms |
| --- | --- | --- | --- | --- | --- | --- |
| llama-laya-q8 | GGUF Q8_0 | 0.449 | 35 | 46; 33 | 3 | 38.08 / 130.21 |
| llama-laya-bf16 | GGUF BF16 | 0.844 | 35 | 46; 33 | 3 | 38.75 / 131.49 |
| ollama-laya-bf16 | GGUF BF16 | 0.844 | 35 | 46; 33 | 3 | 39.00 / 130.80 |
| ollama-laya-fp16 | MLX FP16 | 0.846 | 35 | 46; 33 | 3 | 38.18 / 111.45 |

These historical Laya results retain the original phase-1 settings and edge cutoffs. They are recorded rejected candidates, not phase-1b midpoint or 4096-token measurements.

The ignored raw evidence archive combines phase-1 and phase-1b logs and 200 ms samples. [Public archive descriptor](data/decision-1b-archive.json): 10448896 bytes, SHA-256 `0620dfa944e2341fa76b87fecf32fd8338e5b1377792232b423572eadec4f3fe`.

Historical Gemma baselines were recorded on the same machine in October 2026 and are included in `decision-baselines.json`. The current native text-only QAT contract has separate [qualification](ollama-qualification.md); no later quality score is combined with historical timing or memory.

## Phase 2: preregistered validation

**2/2 candidates have complete results on both corpora.** Each candidate passes only when G1, G2 and G3 pass on both corpora at its frozen template, cutoff and runtime settings. Failed or incomplete attempts cannot pass and are not retried.

Both validation corpora were previously used to qualify Gemma; neither is globally untouched. These are independent of decision-model discovery selection, and do not establish extension or production qualification.

Preregistration: [recorded plan](data/decision-preregistration.json), SHA-256 `804e8f2ed5ce151e4cc71429e0652600f23ebf5f78c023585b4b747b4d6b0561`. Results below are recorded evidence. This renderer checks recorded bindings and gate consistency and performs no inference, scoring, selection or retuning.

| Candidate | Overall | Isolation | Migration | Attempt status |
| --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | PASS | PASS (complete) | PASS (complete) | complete |
| ollama-d1-2b-nvfp4 | PASS | PASS (complete) | PASS (complete) | complete |

| Candidate | Attempt receipt | Run ID | Status | Started | Finished | Recorded error |
| --- | --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | [attempt](data/decision-validation-attempt-llama-d1-2b-q8.json) | 071bd7a5-e252-4c6f-a7cd-538900b1fbb0 | complete | 2026-11-24T19:24:47.964Z | 2026-11-24T19:25:00.032Z | — |
| ollama-d1-2b-nvfp4 | [attempt](data/decision-validation-attempt-ollama-d1-2b-nvfp4.json) | 233ec8c7-5f27-4077-ac36-fb527aedd09e | complete | 2026-11-24T19:25:00.108Z | 2026-11-24T19:25:07.907Z | — |

| Candidate | Corpus | Gate | Actual | Required | Result |
| --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | isolation | G1: newFalseHides | 0 | ≤ 1 | PASS |
| llama-d1-2b-q8 | isolation | G2: exactVectors | 72 | ≥ 60 | PASS |
| llama-d1-2b-q8 | isolation | G3: correctHideDecisions | 72 | ≥ 68 | PASS |
| llama-d1-2b-q8 | migration | G1: newFalseHides | 0 | ≤ 1 | PASS |
| llama-d1-2b-q8 | migration | G2: exactVectors | 119 | ≥ 110 | PASS |
| llama-d1-2b-q8 | migration | G3: correctHideDecisions | 120 | ≥ 117 | PASS |
| ollama-d1-2b-nvfp4 | isolation | G1: newFalseHides | 0 | ≤ 1 | PASS |
| ollama-d1-2b-nvfp4 | isolation | G2: exactVectors | 70 | ≥ 60 | PASS |
| ollama-d1-2b-nvfp4 | isolation | G3: correctHideDecisions | 71 | ≥ 68 | PASS |
| ollama-d1-2b-nvfp4 | migration | G1: newFalseHides | 0 | ≤ 1 | PASS |
| ollama-d1-2b-nvfp4 | migration | G2: exactVectors | 119 | ≥ 110 | PASS |
| ollama-d1-2b-nvfp4 | migration | G3: correctHideDecisions | 120 | ≥ 117 | PASS |

G1 counts new false hides against Browser-correct SHOW decisions. G2 compares exact ordered filter vectors. G3 compares correct hide/show decisions with Browser minus one. New missed hides, fixed-0.5 results, rage-bait F1 and the migration text-only QAT comparison are reported without gates.

| Model / candidate | Corpus | Operating point | Exact vectors | Correct hide/show | FH / MH | New FH / new MH vs Browser | Rage hide F1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | isolation | Frozen ≥ 0.290813258948728 | 72/72 | 72/72 | 0 / 0 | 0 / 0 | 1.0000 |
| llama-d1-2b-q8 | isolation | Fixed ≥ 0.5 (not gated) | 66/72 | 72/72 | 0 / 0 | 0 / 0 | 1.0000 |
| Browser Gemma 4 E2B | isolation | Historical baseline | 60/72 | 69/72 | 2 / 1 | 0 / 0 | 0.9600 |
| llama-d1-2b-q8 | migration | Frozen ≥ 0.290813258948728 | 119/120 | 120/120 | 0 / 0 | 0 / 0 | 1.0000 |
| llama-d1-2b-q8 | migration | Fixed ≥ 0.5 (not gated) | 119/120 | 119/120 | 0 / 1 | 0 / 1 | 0.9744 |
| Browser Gemma 4 E2B | migration | Historical baseline | 110/120 | 118/120 | 2 / 0 | 0 / 0 | 0.9756 |
| Text-only QAT Gemma 4 E2B | migration | Historical baseline (not gated) | 115/120 | 119/120 | 0 / 1 | 0 / 0 | 1.0000 |
| ollama-d1-2b-nvfp4 | isolation | Frozen ≥ 0.32208209372244256 | 70/72 | 71/72 | 1 / 0 | 0 / 0 | 1.0000 |
| ollama-d1-2b-nvfp4 | isolation | Fixed ≥ 0.5 (not gated) | 66/72 | 72/72 | 0 / 0 | 0 / 0 | 1.0000 |
| Browser Gemma 4 E2B | isolation | Historical baseline | 60/72 | 69/72 | 2 / 1 | 0 / 0 | 0.9600 |
| ollama-d1-2b-nvfp4 | migration | Frozen ≥ 0.32208209372244256 | 119/120 | 120/120 | 0 / 0 | 0 / 0 | 1.0000 |
| ollama-d1-2b-nvfp4 | migration | Fixed ≥ 0.5 (not gated) | 118/120 | 118/120 | 0 / 2 | 0 / 2 | 0.9474 |
| Browser Gemma 4 E2B | migration | Historical baseline | 110/120 | 118/120 | 2 / 0 | 0 / 0 | 0.9756 |
| Text-only QAT Gemma 4 E2B | migration | Historical baseline (not gated) | 115/120 | 119/120 | 0 / 1 | 0 / 0 | 1.0000 |

FH/MH mean false hides/missed hides. Scores are rendered as stored; unavailable paired counts and undefined ratios are —. Browser and current text-only QAT are separate Gemma artifacts and prompts.

| Candidate | Migration text-only QAT baseline | New FH vs QAT | New MH vs QAT | QAT source IDs |
| --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | Ollama 0.40.3; context 1024 tokens | 0 | 0 | textOnlyQat-migration-2026-10-12 |
| ollama-d1-2b-nvfp4 | Ollama 0.40.3; context 1024 tokens | 0 | 0 | textOnlyQat-migration-2026-10-12 |

The migration QAT baseline uses the separately qualified text-only import, Ollama 0.40.3 and a 1024-token context. Its artifact contract is bound in each receipt; it is not the original combined-package QAT discovery/timing reference.

| Candidate | Corpus | Result | Run ID | Template | Frozen cutoff | Selection SHA-256 | Artifact identity hash | Corpus SHA-256 | Baseline-file SHA-256 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | isolation | [receipt](data/decision-validation-llama-d1-2b-q8-isolation.json) | 071bd7a5-e252-4c6f-a7cd-538900b1fbb0 | matches-category | 0.290813258948728 | 8b6d177113c7922c62fdbdeb08b75e7acdc1048d179b5d153744c59717623814 | c29fc69a7e84200aff7966f23d4a0f20b8be0168dfbdf2cbb3778efedde3206f | 18841a6609d9e68493c629880bc03eeaa233eab890245e5cfd5c2eaa9e9d4159 | 6814f37a9dae4c918507533a24087ab6c117a57a8634bf6763ac0834e0731852 |
| llama-d1-2b-q8 | migration | [receipt](data/decision-validation-llama-d1-2b-q8-migration.json) | 071bd7a5-e252-4c6f-a7cd-538900b1fbb0 | matches-category | 0.290813258948728 | 8b6d177113c7922c62fdbdeb08b75e7acdc1048d179b5d153744c59717623814 | c29fc69a7e84200aff7966f23d4a0f20b8be0168dfbdf2cbb3778efedde3206f | 354e80566fdf889e213aec9072387c42f8286a48347379b1142073cba3fa4e27 | 6814f37a9dae4c918507533a24087ab6c117a57a8634bf6763ac0834e0731852 |
| ollama-d1-2b-nvfp4 | isolation | [receipt](data/decision-validation-ollama-d1-2b-nvfp4-isolation.json) | 233ec8c7-5f27-4077-ac36-fb527aedd09e | matches-category | 0.32208209372244256 | a4457e436b69ff11908997360c1edf933cc3e74ec01fa41416b7a725e207d304 | c3b7f91582adeed8238337fe390ac4fc6dbcfa6ba74717a2d26e51916a104d47 | 18841a6609d9e68493c629880bc03eeaa233eab890245e5cfd5c2eaa9e9d4159 | 6814f37a9dae4c918507533a24087ab6c117a57a8634bf6763ac0834e0731852 |
| ollama-d1-2b-nvfp4 | migration | [receipt](data/decision-validation-ollama-d1-2b-nvfp4-migration.json) | 233ec8c7-5f27-4077-ac36-fb527aedd09e | matches-category | 0.32208209372244256 | a4457e436b69ff11908997360c1edf933cc3e74ec01fa41416b7a725e207d304 | c3b7f91582adeed8238337fe390ac4fc6dbcfa6ba74717a2d26e51916a104d47 | 354e80566fdf889e213aec9072387c42f8286a48347379b1142073cba3fa4e27 | 6814f37a9dae4c918507533a24087ab6c117a57a8634bf6763ac0834e0731852 |


## Exploratory: label wording probe

This is exploratory analysis of the existing 280 cases and 940 labeled category decisions, using 3525 recorded requests to `LiquidAI/d1-2B-GGUF:Q8_0`. Existing gold labels remain provisional pending a blind audit. This provides no independent validation and does not retune the frozen template, model, runtime settings or cutoff.

Every operating-point result uses the exact frozen rule `probability >= 0.290813258948728`. The displayed shorthand `0.2908` would change 0 recorded decisions; it is never used to score this probe. Best cutoffs and every equally optimal interval below are descriptive in-sample diagnostics and are never applied.

D uses each original descriptive phrase; K1 and K2 use the recorded short labels. K1 `ragebait` has no definition. K2 `rage bait` explicitly has no definition under the probe override. Rdef adds the rage-bait definition: it is an extra replicate with the same label and definition as D rage, rather than a new wording. X adds exclusion wording for four intents only, so its pooled population differs; each paired X comparison uses the matching D subset.

| Intent (D) | K1 | K2 | X (where tested) |
| --- | --- | --- | --- |
| cryptocurrency investing or promotion | crypto | crypto shilling | cryptocurrency investing or promotion, not news about crypto regulation or prices |
| food and cooking | food | cooking | — |
| rage bait | ragebait | rage bait | — |
| exercise routines and fitness training | fitness | gym | — |
| sports results or commentary | sports | sports talk | — |
| government policy or election politics | politics | elections | government policy or election politics, not personal stories that only mention a policy |
| gossip about famous entertainers or celebrities | celebrity gossip | celebs | — |
| promotion of the author's own product or paid service | self promotion | self promo | promotion of the author's own product or paid service, not recommending someone else's product |
| exaggerated claims that artificial intelligence will solve everything | AI hype | AI | exaggerated claims that artificial intelligence will solve everything, not ordinary news or use of AI |
| requests for likes, reposts, or replies to boost engagement | engagement bait | engagement farming | — |
| personal feuds or public insults between people | drama | beef | — |

Pooled and per-intent category decisions across all three corpora:

| Variant | Intent | n | Gold + / − | AUC | FH / MH | Errors | Correct | In-sample best cutoff | All equally optimal cutoff intervals | Best-cutoff errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D | all | 940 | 275 / 665 | 0.9998 | 2 / 3 | 5 | 935/940 | 0.32136000556063615 | (0.3097652473762188, 0.33295476374505345] | 4 |
| K1 | all | 940 | 275 / 665 | 0.9932 | 17 / 19 | 36 | 904/940 | 0.22586398234844884 | (0.2245829483457561, 0.22714501635114157] | 29 |
| K2 | all | 940 | 275 / 665 | 0.9832 | 19 / 26 | 45 | 895/940 | 0.202362108413925 | (0.20113662476660732, 0.2035875920612427] | 39 |
| Rdef | all | 104 | 50 / 54 | 0.9978 | 0 / 2 | 2 | 102/104 | 0.28535727793375726 | (0.1877006291933904, 0.3830139266741241] | 2 |
| X | all | 337 | 92 / 245 | 0.9989 | 0 / 3 | 3 | 334/337 | 0.3082837715885103 | (0.2338873824048869, 0.3826801607721336] | 3 |
| D | cryptocurrency investing or promotion | 90 | 23 / 67 | 1.0000 | 0 / 0 | 0 | 90/90 | 0.3842042691757908 | (0.04506263325049934, 0.7233459051010822] | 0 |
| K1 | cryptocurrency investing or promotion | 90 | 23 / 67 | 1.0000 | 0 / 0 | 0 | 90/90 | 0.42699151379507494 | (0.14096247825210528, 0.7130205493380446] | 0 |
| K2 | cryptocurrency investing or promotion | 90 | 23 / 67 | 1.0000 | 0 / 0 | 0 | 90/90 | 0.29547163839517804 | (0.06200172145946783, 0.5289415553308883] | 0 |
| X | cryptocurrency investing or promotion | 90 | 23 / 67 | 1.0000 | 0 / 0 | 0 | 90/90 | 0.3720748420505281 | (0.0967822783488053, 0.6473674057522508] | 0 |
| D | food and cooking | 89 | 27 / 62 | 1.0000 | 0 / 0 | 0 | 89/89 | 0.25550470199640063 | (0.17805464024774775, 0.33295476374505345] | 0 |
| K1 | food and cooking | 89 | 27 / 62 | 1.0000 | 0 / 1 | 1 | 88/89 | 0.1936926324424941 | (0.10158151861071946, 0.28580374627426874] | 0 |
| K2 | food and cooking | 89 | 27 / 62 | 1.0000 | 0 / 0 | 0 | 89/89 | 0.19931885838657099 | (0.0652533080009823, 0.33338440877215963] | 0 |
| D | rage bait | 104 | 50 / 54 | 0.9978 | 0 / 2 | 2 | 102/104 | 0.28535727793375726 | (0.1877006291933904, 0.3830139266741241] | 2 |
| K1 | rage bait | 104 | 50 / 54 | 0.9793 | 0 / 16 | 16 | 88/104 | 0.21277781646311683 | (0.20775807886576445, 0.2177975540604692] ∪ (0.2245829483457561, 0.22714501635114157] | 7 |
| K2 | rage bait | 104 | 50 / 54 | 0.9952 | 2 / 4 | 6 | 98/104 | 0.202362108413925 | (0.20113662476660732, 0.2035875920612427] | 3 |
| Rdef | rage bait | 104 | 50 / 54 | 0.9978 | 0 / 2 | 2 | 102/104 | 0.28535727793375726 | (0.1877006291933904, 0.3830139266741241] | 2 |
| D | exercise routines and fitness training | 85 | 23 / 62 | 1.0000 | 0 / 0 | 0 | 85/85 | 0.22578484179540959 | (0.1165664013592924, 0.3350032822315268] | 0 |
| K1 | exercise routines and fitness training | 85 | 23 / 62 | 1.0000 | 0 / 0 | 0 | 85/85 | 0.2995664770879165 | (0.1473629935296738, 0.4517699606461592] | 0 |
| K2 | exercise routines and fitness training | 85 | 23 / 62 | 0.9895 | 2 / 0 | 2 | 83/85 | 0.22899397708976216 | (0.14516800789488052, 0.3128199462846438] | 2 |
| D | sports results or commentary | 84 | 20 / 64 | 1.0000 | 0 / 0 | 0 | 84/84 | 0.2738235058295529 | (0.18810285447047734, 0.3595441571886285] | 0 |
| K1 | sports results or commentary | 84 | 20 / 64 | 0.9898 | 3 / 0 | 3 | 81/84 | 0.3739885799115497 | (0.2592346416198476, 0.4887425182032518] ∪ (0.5064658660167899, 0.5226086994420669] | 3 |
| K2 | sports results or commentary | 84 | 20 / 64 | 0.9922 | 1 / 3 | 4 | 80/84 | 0.23369345376085143 | (0.22775146596879361, 0.23963544155290928] | 2 |
| D | government policy or election politics | 83 | 24 / 59 | 1.0000 | 0 / 1 | 1 | 82/83 | 0.13621851831397475 | (0.09078775076674493, 0.18164928586120455] | 0 |
| K1 | government policy or election politics | 83 | 24 / 59 | 1.0000 | 0 / 0 | 0 | 83/83 | 0.2622405635769103 | (0.12196765055408712, 0.40251347659973347] | 0 |
| K2 | government policy or election politics | 83 | 24 / 59 | 0.9972 | 0 / 5 | 5 | 78/83 | 0.03595197886956544 | (0.03163544389783155, 0.04026851384129934] ∪ (0.14434641927554398, 0.1480395644973344] | 2 |
| X | government policy or election politics | 83 | 24 / 59 | 1.0000 | 0 / 3 | 3 | 80/83 | 0.0919858601046568 | (0.08798423611204202, 0.09598748409727158] | 0 |
| D | gossip about famous entertainers or celebrities | 81 | 19 / 62 | 1.0000 | 1 / 0 | 1 | 80/81 | 0.5471441753659341 | (0.3696220027686656, 0.7246663479632026] | 0 |
| K1 | gossip about famous entertainers or celebrities | 81 | 19 / 62 | 1.0000 | 1 / 0 | 1 | 80/81 | 0.467040529563076 | (0.3519126088371264, 0.5821684502890256] | 0 |
| K2 | gossip about famous entertainers or celebrities | 81 | 19 / 62 | 1.0000 | 1 / 0 | 1 | 80/81 | 0.3120451368213237 | (0.2977504960888329, 0.32633977755381444] | 0 |
| D | promotion of the author's own product or paid service | 83 | 25 / 58 | 1.0000 | 0 / 0 | 0 | 83/83 | 0.41391250274754976 | (0.24020350479296607, 0.5876215007021334] | 0 |
| K1 | promotion of the author's own product or paid service | 83 | 25 / 58 | 0.9938 | 5 / 1 | 6 | 77/83 | 0.49652593078624363 | (0.478256524284617, 0.5147953372878703] | 2 |
| K2 | promotion of the author's own product or paid service | 83 | 25 / 58 | 0.9966 | 5 / 1 | 6 | 77/83 | 0.46802503454619937 | (0.45704226163412615, 0.47900780745827265] | 1 |
| X | promotion of the author's own product or paid service | 83 | 25 / 58 | 1.0000 | 0 / 0 | 0 | 83/83 | 0.5061842378646059 | (0.2338873824048869, 0.7784810933243248] | 0 |
| D | exaggerated claims that artificial intelligence will solve everything | 81 | 20 / 61 | 1.0000 | 0 / 0 | 0 | 81/81 | 0.5117174838924048 | (0.0808373128622431, 0.9425976549225665] | 0 |
| K1 | exaggerated claims that artificial intelligence will solve everything | 81 | 20 / 61 | 1.0000 | 1 / 0 | 1 | 80/81 | 0.6078602040237386 | (0.47171926156711635, 0.744001146480361] | 0 |
| K2 | exaggerated claims that artificial intelligence will solve everything | 81 | 20 / 61 | 0.9549 | 7 / 0 | 7 | 74/81 | 0.3564232436393028 | (0.3401077948139065, 0.372738692464699] | 6 |
| X | exaggerated claims that artificial intelligence will solve everything | 81 | 20 / 61 | 1.0000 | 0 / 0 | 0 | 81/81 | 0.5001826747605752 | (0.09616952530023533, 0.904195824220915] | 0 |
| D | requests for likes, reposts, or replies to boost engagement | 80 | 25 / 55 | 1.0000 | 0 / 0 | 0 | 80/80 | 0.381624462108142 | (0.09279342014351265, 0.6704555040727713] | 0 |
| K1 | requests for likes, reposts, or replies to boost engagement | 80 | 25 / 55 | 0.9956 | 6 / 0 | 6 | 74/80 | 0.557219845596006 | (0.5366617241557938, 0.5777779670362182] | 1 |
| K2 | requests for likes, reposts, or replies to boost engagement | 80 | 25 / 55 | 0.9222 | 1 / 9 | 10 | 70/80 | 0.16673635910523738 | (0.15494279443150488, 0.17852992377896987] | 8 |
| D | personal feuds or public insults between people | 80 | 19 / 61 | 1.0000 | 1 / 0 | 1 | 79/80 | 0.4350621007313594 | (0.3097652473762188, 0.5603589540865] | 0 |
| K1 | personal feuds or public insults between people | 80 | 19 / 61 | 0.9914 | 1 / 1 | 2 | 78/80 | 0.298122483115574 | (0.2731644129313005, 0.3230805532998474] | 2 |
| K2 | personal feuds or public insults between people | 80 | 19 / 61 | 0.9767 | 0 / 4 | 4 | 76/80 | 0.16861239890187352 | (0.16072043368104724, 0.17650436412269976] | 2 |

Corpus-pooled descriptive and keyword results:

| Variant | Corpus | n | Gold + / − | AUC | FH / MH | Errors | Correct | In-sample best cutoff | All equally optimal cutoff intervals | Best-cutoff errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D | discovery | 268 | 103 / 165 | 0.9995 | 0 / 3 | 3 | 265/268 | 0.26420738491651236 | (0.16229912760586682, 0.16680972669527255] ∪ (0.1954600060879713, 0.33295476374505345] | 3 |
| D | migration | 420 | 86 / 334 | 1.0000 | 1 / 0 | 1 | 419/420 | 0.4242775790279536 | (0.3696220027686656, 0.4789331552872417] | 0 |
| D | isolation | 252 | 86 / 166 | 1.0000 | 1 / 0 | 1 | 251/252 | 0.33404694707679344 | (0.3097652473762188, 0.3583286467773681] | 0 |
| K1 | isolation | 252 | 86 / 166 | 0.9912 | 7 / 3 | 10 | 242/252 | 0.2887053862770077 | (0.22125739907671976, 0.23413733505450626] ∪ (0.2592346416198476, 0.264536371610444] ∪ (0.2731644129313005, 0.30424635962271485] | 10 |
| K1 | migration | 420 | 86 / 334 | 0.9962 | 5 / 4 | 9 | 411/420 | 0.27021012699681624 | (0.25871162121521946, 0.281708632778413] | 8 |
| K1 | discovery | 268 | 103 / 165 | 0.9899 | 5 / 12 | 17 | 251/268 | 0.22586398234844884 | (0.2245829483457561, 0.22714501635114157] | 10 |
| K2 | isolation | 252 | 86 / 166 | 0.9671 | 9 / 8 | 17 | 235/252 | 0.20748693214564976 | (0.17533842273839023, 0.23963544155290928] | 15 |
| K2 | discovery | 268 | 103 / 165 | 0.9862 | 5 / 10 | 15 | 253/268 | 0.1292747876971234 | (0.12341114437537117, 0.1351384310188756] | 11 |
| K2 | migration | 420 | 86 / 334 | 0.9891 | 5 / 8 | 13 | 407/420 | 0.24435231130923635 | (0.22775146596879361, 0.26095315664967905] | 11 |

FH/MH mean false hides/missed hides at the frozen cutoff, counted per filter decision rather than per unique post. AUC is — when a population has no positive or no negative gold examples. Interval brackets preserve endpoint inclusion; disconnected equally optimal components are joined by ∪. Rdef covers rage only; X covers its tested subset. These pooled rows should not be compared as if every variant had the same intent population.

Paired differences against D on matching decisions (variant minus D). Positive ΔAUC favors the variant; positive Δerrors means more errors. McNemar p-values are recorded exact conditional two-sided binomial tests of per-decision correctness discordance, with no multiplicity adjustment. Multiple filter decisions on the same post may be dependent, so pooled tests are exploratory and do not establish a confirmatory independent-sample claim or a new winner.

| Variant vs D | Intent | n | ΔAUC | Δerrors | D correct / variant wrong | D wrong / variant correct | Discordant | Exact McNemar p | Decision flips |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K1 | all | 940 | -0.0066 | +31 | 32 | 1 | 33 | 7.916e-9 | 33 |
| K2 | all | 940 | -0.0166 | +40 | 42 | 2 | 44 | 1.127e-10 | 44 |
| Rdef | all | 104 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| X | all | 337 | -0.0010 | +2 | 2 | 0 | 2 | 0.500000 | 2 |
| K1 | cryptocurrency investing or promotion | 90 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| K2 | cryptocurrency investing or promotion | 90 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| X | cryptocurrency investing or promotion | 90 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| K1 | food and cooking | 89 | 0.0000 | +1 | 1 | 0 | 1 | 1.000000 | 1 |
| K2 | food and cooking | 89 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| K1 | rage bait | 104 | -0.0185 | +14 | 14 | 0 | 14 | 0.000122 | 14 |
| K2 | rage bait | 104 | -0.0026 | +4 | 4 | 0 | 4 | 0.125000 | 4 |
| Rdef | rage bait | 104 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| K1 | exercise routines and fitness training | 85 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| K2 | exercise routines and fitness training | 85 | -0.0105 | +2 | 2 | 0 | 2 | 0.500000 | 2 |
| K1 | sports results or commentary | 84 | -0.0102 | +3 | 3 | 0 | 3 | 0.250000 | 3 |
| K2 | sports results or commentary | 84 | -0.0078 | +4 | 4 | 0 | 4 | 0.125000 | 4 |
| K1 | government policy or election politics | 83 | 0.0000 | -1 | 0 | 1 | 1 | 1.000000 | 1 |
| K2 | government policy or election politics | 83 | -0.0028 | +4 | 5 | 1 | 6 | 0.218750 | 6 |
| X | government policy or election politics | 83 | 0.0000 | +2 | 2 | 0 | 2 | 0.500000 | 2 |
| K1 | gossip about famous entertainers or celebrities | 81 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| K2 | gossip about famous entertainers or celebrities | 81 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| K1 | promotion of the author's own product or paid service | 83 | -0.0062 | +6 | 6 | 0 | 6 | 0.031250 | 6 |
| K2 | promotion of the author's own product or paid service | 83 | -0.0034 | +6 | 6 | 0 | 6 | 0.031250 | 6 |
| X | promotion of the author's own product or paid service | 83 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| K1 | exaggerated claims that artificial intelligence will solve everything | 81 | 0.0000 | +1 | 1 | 0 | 1 | 1.000000 | 1 |
| K2 | exaggerated claims that artificial intelligence will solve everything | 81 | -0.0451 | +7 | 7 | 0 | 7 | 0.015625 | 7 |
| X | exaggerated claims that artificial intelligence will solve everything | 81 | 0.0000 | 0 | 0 | 0 | 0 | 1.000000 | 0 |
| K1 | requests for likes, reposts, or replies to boost engagement | 80 | -0.0044 | +6 | 6 | 0 | 6 | 0.031250 | 6 |
| K2 | requests for likes, reposts, or replies to boost engagement | 80 | -0.0778 | +10 | 10 | 0 | 10 | 0.001953 | 10 |
| K1 | personal feuds or public insults between people | 80 | -0.0086 | +1 | 1 | 0 | 1 | 1.000000 | 1 |
| K2 | personal feuds or public insults between people | 80 | -0.0233 | +3 | 4 | 1 | 5 | 0.375000 | 5 |

The [full K1/K2-versus-D flip file](data/decision-wording-probe-flips.json) contains 77 decision flips, including post text, gold, actual labels, probabilities and correctness on both sides. [Summary](data/decision-wording-probe-summary.json) and [raw requests](data/decision-wording-probe-raw.json) retain the full per-corpus and per-intent evidence.

Request cost by variant and mode (pooled across intents and corpora):

| Variant | Mode | Requests | Median wall ms | Median input tokens | Mean input tokens | Input tokens min–max |
| --- | --- | --- | --- | --- | --- | --- |
| D | single | 940 | 30.34 | 82.0 | 93.71 | 67–195 |
| D | multi | 132 | 49.24 | 250.5 | 296.33 | 150–528 |
| K1 | single | 940 | 29.86 | 76.0 | 77.15 | 59–139 |
| K1 | multi | 132 | 47.79 | 225.0 | 263.70 | 140–473 |
| K2 | single | 940 | 29.90 | 75.0 | 76.98 | 58–138 |
| Rdef | single | 104 | 45.67 | 179.0 | 177.98 | 165–195 |
| X | single | 337 | 30.69 | 90.0 | 91.73 | 77–153 |

Latency is exploratory: a shuffled one-pass workload, without repeated stable timing cells. Label token differences are recorded request input-token counts, not a benchmark of steady-state speed or a production latency claim.

Single-versus-multi interference on matching category decisions:

| Style | Intent | n | Median absolute probability Δ | Worst absolute probability Δ | Frozen-cutoff flips |
| --- | --- | --- | --- | --- | --- |
| D | all | 792 | 0.004763 | 0.388076 | 2 |
| K1 | all | 792 | 0.009004 | 0.418283 | 15 |
| D | cryptocurrency investing or promotion | 84 | 0.001465 | 0.235960 | 0 |
| K1 | cryptocurrency investing or promotion | 84 | 0.003312 | 0.190346 | 0 |
| D | food and cooking | 85 | 0.016133 | 0.261843 | 0 |
| K1 | food and cooking | 85 | 0.009910 | 0.277191 | 0 |
| D | exercise routines and fitness training | 81 | 0.013035 | 0.218619 | 0 |
| K1 | exercise routines and fitness training | 81 | 0.018304 | 0.172417 | 1 |
| D | sports results or commentary | 78 | 0.003431 | 0.135693 | 0 |
| K1 | sports results or commentary | 78 | 0.006440 | 0.160764 | 0 |
| D | government policy or election politics | 79 | 0.006276 | 0.388076 | 1 |
| K1 | government policy or election politics | 79 | 0.007473 | 0.227842 | 0 |
| D | gossip about famous entertainers or celebrities | 77 | 0.004530 | 0.119902 | 0 |
| K1 | gossip about famous entertainers or celebrities | 77 | 0.004483 | 0.137555 | 0 |
| D | promotion of the author's own product or paid service | 79 | 0.006585 | 0.340292 | 0 |
| K1 | promotion of the author's own product or paid service | 79 | 0.017013 | 0.243133 | 5 |
| D | exaggerated claims that artificial intelligence will solve everything | 77 | 0.001990 | 0.067317 | 0 |
| K1 | exaggerated claims that artificial intelligence will solve everything | 77 | 0.009147 | 0.078033 | 0 |
| D | requests for likes, reposts, or replies to boost engagement | 76 | 0.007132 | 0.246135 | 0 |
| K1 | requests for likes, reposts, or replies to boost engagement | 76 | 0.012990 | 0.418283 | 7 |
| D | personal feuds or public insults between people | 76 | 0.001955 | 0.259864 | 1 |
| K1 | personal feuds or public insults between people | 76 | 0.011012 | 0.169160 | 2 |

Evidence SHA-256: raw `badf85d3924bd997acb57a4c60df362464e4b0c3e48b8040c4b4fac16c20f50b`; flips `1bb0f0f34f0a52cf18d5427773454c180612a7f772ea1b5bd95ead6376f91ad5`. Frozen selection SHA-256: `8b6d177113c7922c62fdbdeb08b75e7acdc1048d179b5d153744c59717623814`; artifact identity hash: `c29fc69a7e84200aff7966f23d4a0f20b8be0168dfbdf2cbb3778efedde3206f`. Existing discovery, validation, performance and selection evidence was recorded unchanged. This renderer only checks saved bindings and renders stored metrics; it performs no inference, scoring, fitting or selection.


## Fresh-filter test: Bounce label guidance

Status: **complete**. Registration recorded at 2026-11-24T20:49:47.165Z before inference. The fixed model is `LiquidAI/d1-2B-GGUF:Q8_0`, with the `matches-category` template, one 4096-token slot and the exact frozen rule `probability >= 0.290813258948728`.

The fresh synthetic corpus has six intents and 84 posts. Each style has 504 post/filter decisions; 22 ambiguous pairs are excluded from the 482-decision headline population. Labels are short, guided, or guided plus an exclusion. The run is one shuffled pass: 1,512 single-filter requests and 252 six-filter requests, with no retuning, relabeling or rerun.

Preregistered gates use pooled single-filter decisions only. **G_guidance** requires fewer total errors than short labels AND no increase in near-miss false hides. **G_exclusion** requires no increase in near-miss false hides relative to guided labels AND no more than one additional missed hide. Six-filter results cannot satisfy either gate.

For both gates, “near miss” means any post authored as a near-miss with negative gold for the tested filter, excluding ambiguous pairs: 143 eligible pairs per style, including cross-intent negative pairs. Own-filter near-miss counts are also reported separately (24 pairs per style), so the broader interpretation is visible.

Recorded gate outcomes (each gate requires both components to pass):

| Gate | Component | Actual | Comparison | Reference | Component result | Gate result |
| --- | --- | --- | --- | --- | --- | --- |
| guidance | errors | 66 | < | 141 | PASS | SUPPORTED |
| guidance | nearMissFalseHides | 18 | <= | 33 | PASS | SUPPORTED |
| exclusion | nearMissFalseHides | 20 | <= | 18 | FAIL | NOT SUPPORTED |
| exclusion | missedHides | 19 | <= | 21 | PASS | NOT SUPPORTED |

| Intent | Short | Guided | Guided + exclusion |
| --- | --- | --- | --- |
| rudeness | rude posts | posts being deliberately rude or edgy to get attention | posts being deliberately rude or edgy to get attention, not blunt honest criticism |
| humblebrag | humblebrags | posts bragging while pretending to complain or be humble | posts bragging while pretending to complain or be humble, not sharing real good news |
| doom | doomposting | posts saying everything is collapsing and it's hopeless | posts saying everything is collapsing and it's hopeless, not news about specific problems |
| hustle | hustle culture | posts glorifying overwork, 5am routines and grinding | posts glorifying overwork, 5am routines and grinding, not genuine productivity tips |
| dunking | dunking | posts mocking a random person's post or mistake | posts mocking a random person's post or mistake, not criticism of public figures |
| engagement | engagement bait | posts asking questions just to get replies | posts asking questions just to get replies, not genuine questions asking for help |

Single-filter headline results, pooled and by filter. FH/MH are false hides/missed hides per post/filter decision:

| Style | Filter | n | Gold + / − | AUC | FH / MH | Errors | Near-miss FH / n | Own near-miss FH / n | Subtle MH / n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short | all | 482 | 48 / 434 | 0.8039 | 129 / 12 | 141 | 33/143 | 8/24 | 7/18 |
| guided | all | 482 | 48 / 434 | 0.8470 | 46 / 20 | 66 | 18/143 | 9/24 | 12/18 |
| guidedExclusion | all | 482 | 48 / 434 | 0.8593 | 54 / 19 | 73 | 20/143 | 10/24 | 11/18 |
| short | rudeness | 75 | 8 / 67 | 0.8190 | 5 / 4 | 9 | 3/24 | 1/4 | 3/3 |
| guided | rudeness | 75 | 8 / 67 | 0.8526 | 8 / 3 | 11 | 3/24 | 1/4 | 3/3 |
| guidedExclusion | rudeness | 75 | 8 / 67 | 0.8750 | 8 / 2 | 10 | 4/24 | 2/4 | 2/3 |
| short | humblebrag | 81 | 8 / 73 | 0.6404 | 24 / 4 | 28 | 6/24 | 3/4 | 1/3 |
| guided | humblebrag | 81 | 8 / 73 | 0.7312 | 9 / 5 | 14 | 3/24 | 1/4 | 2/3 |
| guidedExclusion | humblebrag | 81 | 8 / 73 | 0.7175 | 9 / 6 | 15 | 3/24 | 1/4 | 2/3 |
| short | doom | 84 | 8 / 76 | 0.8964 | 35 / 1 | 36 | 9/24 | 1/4 | 1/3 |
| guided | doom | 84 | 8 / 76 | 0.8651 | 4 / 3 | 7 | 3/24 | 1/4 | 2/3 |
| guidedExclusion | doom | 84 | 8 / 76 | 0.9178 | 2 / 2 | 4 | 1/24 | 1/4 | 2/3 |
| short | hustle | 83 | 8 / 75 | 0.9183 | 30 / 0 | 30 | 9/24 | 3/4 | 0/3 |
| guided | hustle | 83 | 8 / 75 | 0.8600 | 18 / 2 | 20 | 4/24 | 2/4 | 1/3 |
| guidedExclusion | hustle | 83 | 8 / 75 | 0.8733 | 23 / 2 | 25 | 6/24 | 3/4 | 1/3 |
| short | dunking | 79 | 8 / 71 | 0.7570 | 13 / 3 | 16 | 1/23 | 0/4 | 2/3 |
| guided | dunking | 79 | 8 / 71 | 0.9049 | 4 / 3 | 7 | 2/23 | 1/4 | 2/3 |
| guidedExclusion | dunking | 79 | 8 / 71 | 0.8979 | 10 / 2 | 12 | 4/23 | 1/4 | 2/3 |
| short | engagement | 80 | 8 / 72 | 0.9028 | 22 / 0 | 22 | 5/24 | 0/4 | 0/3 |
| guided | engagement | 80 | 8 / 72 | 0.9323 | 3 / 4 | 7 | 3/24 | 3/4 | 2/3 |
| guidedExclusion | engagement | 80 | 8 / 72 | 0.9375 | 2 / 5 | 7 | 2/24 | 2/4 | 2/3 |

Six-filter headline results (interference diagnostic; excluded from both gates):

| Style | Filter | n | Gold + / − | AUC | FH / MH | Errors | Near-miss FH / n | Own near-miss FH / n | Subtle MH / n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short | all | 482 | 48 / 434 | 0.7922 | 124 / 17 | 141 | 34/143 | 9/24 | 9/18 |
| guided | all | 482 | 48 / 434 | 0.8501 | 47 / 21 | 68 | 16/143 | 8/24 | 10/18 |
| guidedExclusion | all | 482 | 48 / 434 | 0.8603 | 53 / 23 | 76 | 17/143 | 7/24 | 12/18 |
| short | rudeness | 75 | 8 / 67 | 0.8246 | 6 / 4 | 10 | 3/24 | 1/4 | 3/3 |
| guided | rudeness | 75 | 8 / 67 | 0.8433 | 10 / 3 | 13 | 4/24 | 1/4 | 2/3 |
| guidedExclusion | rudeness | 75 | 8 / 67 | 0.8526 | 10 / 3 | 13 | 3/24 | 1/4 | 2/3 |
| short | humblebrag | 81 | 8 / 73 | 0.6010 | 22 / 5 | 27 | 5/24 | 3/4 | 2/3 |
| guided | humblebrag | 81 | 8 / 73 | 0.7140 | 10 / 6 | 16 | 2/24 | 1/4 | 2/3 |
| guidedExclusion | humblebrag | 81 | 8 / 73 | 0.7140 | 7 / 8 | 15 | 2/24 | 1/4 | 3/3 |
| short | doom | 84 | 8 / 76 | 0.8914 | 36 / 1 | 37 | 9/24 | 1/4 | 1/3 |
| guided | doom | 84 | 8 / 76 | 0.8734 | 1 / 3 | 4 | 1/24 | 1/4 | 2/3 |
| guidedExclusion | doom | 84 | 8 / 76 | 0.9589 | 1 / 3 | 4 | 1/24 | 1/4 | 2/3 |
| short | hustle | 83 | 8 / 75 | 0.9167 | 31 / 0 | 31 | 10/24 | 3/4 | 0/3 |
| guided | hustle | 83 | 8 / 75 | 0.8833 | 19 / 2 | 21 | 5/24 | 2/4 | 1/3 |
| guidedExclusion | hustle | 83 | 8 / 75 | 0.8650 | 20 / 2 | 22 | 5/24 | 2/4 | 1/3 |
| short | dunking | 79 | 8 / 71 | 0.7218 | 9 / 6 | 15 | 1/23 | 0/4 | 2/3 |
| guided | dunking | 79 | 8 / 71 | 0.9032 | 3 / 2 | 5 | 1/23 | 0/4 | 2/3 |
| guidedExclusion | dunking | 79 | 8 / 71 | 0.9243 | 14 / 2 | 16 | 5/23 | 1/4 | 2/3 |
| short | engagement | 80 | 8 / 72 | 0.8837 | 20 / 1 | 21 | 6/24 | 1/4 | 1/3 |
| guided | engagement | 80 | 8 / 72 | 0.9392 | 4 / 5 | 9 | 3/24 | 3/4 | 1/3 |
| guidedExclusion | engagement | 80 | 8 / 72 | 0.9392 | 1 / 5 | 6 | 1/24 | 1/4 | 2/3 |

Paired near-miss changes at the frozen cutoff:

| Comparison | Negative near-miss pairs | New false hides | Repaired false hides | Own new false hides | Own repaired false hides |
| --- | --- | --- | --- | --- | --- |
| guided-vs-short | 143 | 10 | 25 | 5 | 4 |
| exclusion-vs-guided | 143 | 5 | 3 | 2 | 1 |

Request cost: pooled and per-filter single requests, plus pooled six-filter requests. Six-filter costs cover all six questions in one request.

| Mode | Style | Filter | Requests | Median wall ms | Median input tokens | Mean input tokens | Input tokens min–max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| single | short | all | 504 | 29.45 | 70.0 | 70.25 | 55–87 |
| single | guided | all | 504 | 29.78 | 77.0 | 76.75 | 60–94 |
| single | guidedExclusion | all | 504 | 30.17 | 83.0 | 82.58 | 67–99 |
| single | short | rudeness | 84 | 29.44 | 69.0 | 69.58 | 55–85 |
| single | guided | rudeness | 84 | 29.79 | 76.0 | 76.58 | 62–92 |
| single | guidedExclusion | rudeness | 84 | 30.06 | 81.0 | 81.58 | 67–97 |
| single | short | humblebrag | 84 | 29.54 | 71.0 | 71.58 | 57–87 |
| single | guided | humblebrag | 84 | 29.78 | 77.0 | 77.58 | 63–93 |
| single | guidedExclusion | humblebrag | 84 | 30.22 | 83.0 | 83.58 | 69–99 |
| single | short | doom | 84 | 29.31 | 70.0 | 70.58 | 56–86 |
| single | guided | doom | 84 | 29.77 | 76.0 | 76.58 | 62–92 |
| single | guidedExclusion | doom | 84 | 30.20 | 82.0 | 82.58 | 68–98 |
| single | short | hustle | 84 | 29.52 | 70.0 | 70.58 | 56–86 |
| single | guided | hustle | 84 | 29.88 | 78.0 | 78.58 | 64–94 |
| single | guidedExclusion | hustle | 84 | 30.21 | 83.0 | 83.58 | 69–99 |
| single | short | dunking | 84 | 29.36 | 69.0 | 69.58 | 55–85 |
| single | guided | dunking | 84 | 29.86 | 76.0 | 76.58 | 62–92 |
| single | guidedExclusion | dunking | 84 | 30.28 | 82.0 | 82.58 | 68–98 |
| single | short | engagement | 84 | 29.44 | 69.0 | 69.58 | 55–85 |
| single | guided | engagement | 84 | 29.72 | 74.0 | 74.58 | 60–90 |
| single | guidedExclusion | engagement | 84 | 30.06 | 81.0 | 81.58 | 67–97 |
| six-filter | short | all | 84 | 63.31 | 263.0 | 263.58 | 249–279 |
| six-filter | guided | all | 84 | 65.34 | 302.0 | 302.58 | 288–318 |
| six-filter | guidedExclusion | all | 84 | 67.24 | 337.0 | 337.58 | 323–353 |

These one-pass timings describe the recorded workload, rather than repeated steady-state latency cells.

Single-versus-six-filter interference, including a separate population retaining the ambiguous pairs:

| Style | Filter | Population | n | Median absolute probability Δ | Worst absolute probability Δ | Frozen-cutoff flips |
| --- | --- | --- | --- | --- | --- | --- |
| short | all | headline | 482 | 0.024432 | 0.172740 | 40 |
| short | all | allIncludingAmbiguous | 504 | 0.024343 | 0.172740 | 41 |
| guided | all | headline | 482 | 0.012474 | 0.339845 | 28 |
| guided | all | allIncludingAmbiguous | 504 | 0.012776 | 0.339845 | 28 |
| guidedExclusion | all | headline | 482 | 0.015872 | 0.372394 | 25 |
| guidedExclusion | all | allIncludingAmbiguous | 504 | 0.016225 | 0.372394 | 29 |
| short | rudeness | headline | 75 | 0.008391 | 0.108427 | 1 |
| short | rudeness | allIncludingAmbiguous | 84 | 0.009152 | 0.108427 | 1 |
| guided | rudeness | headline | 75 | 0.012416 | 0.133287 | 4 |
| guided | rudeness | allIncludingAmbiguous | 84 | 0.011933 | 0.133287 | 4 |
| guidedExclusion | rudeness | headline | 75 | 0.007625 | 0.198066 | 5 |
| guidedExclusion | rudeness | allIncludingAmbiguous | 84 | 0.009079 | 0.198066 | 6 |
| short | humblebrag | headline | 81 | 0.018496 | 0.105957 | 9 |
| short | humblebrag | allIncludingAmbiguous | 84 | 0.018333 | 0.105957 | 9 |
| guided | humblebrag | headline | 81 | 0.021668 | 0.095626 | 4 |
| guided | humblebrag | allIncludingAmbiguous | 84 | 0.021628 | 0.124682 | 4 |
| guidedExclusion | humblebrag | headline | 81 | 0.018298 | 0.178046 | 8 |
| guidedExclusion | humblebrag | allIncludingAmbiguous | 84 | 0.018553 | 0.178046 | 8 |
| short | doom | headline | 84 | 0.025564 | 0.121050 | 3 |
| short | doom | allIncludingAmbiguous | 84 | 0.025564 | 0.121050 | 3 |
| guided | doom | headline | 84 | 0.008359 | 0.199622 | 3 |
| guided | doom | allIncludingAmbiguous | 84 | 0.008359 | 0.199622 | 3 |
| guidedExclusion | doom | headline | 84 | 0.009614 | 0.220212 | 2 |
| guidedExclusion | doom | allIncludingAmbiguous | 84 | 0.009614 | 0.220212 | 2 |
| short | hustle | headline | 83 | 0.036930 | 0.168952 | 9 |
| short | hustle | allIncludingAmbiguous | 84 | 0.037713 | 0.168952 | 9 |
| guided | hustle | headline | 83 | 0.026157 | 0.339845 | 7 |
| guided | hustle | allIncludingAmbiguous | 84 | 0.027350 | 0.339845 | 7 |
| guidedExclusion | hustle | headline | 83 | 0.033737 | 0.372394 | 5 |
| guidedExclusion | hustle | allIncludingAmbiguous | 84 | 0.033669 | 0.372394 | 5 |
| short | dunking | headline | 79 | 0.020049 | 0.109718 | 11 |
| short | dunking | allIncludingAmbiguous | 84 | 0.019704 | 0.109718 | 11 |
| guided | dunking | headline | 79 | 0.014829 | 0.135914 | 6 |
| guided | dunking | allIncludingAmbiguous | 84 | 0.015968 | 0.135914 | 6 |
| guidedExclusion | dunking | headline | 79 | 0.023116 | 0.221810 | 4 |
| guidedExclusion | dunking | allIncludingAmbiguous | 84 | 0.025458 | 0.221810 | 6 |
| short | engagement | headline | 80 | 0.033185 | 0.172740 | 7 |
| short | engagement | allIncludingAmbiguous | 84 | 0.033419 | 0.172740 | 8 |
| guided | engagement | headline | 80 | 0.004613 | 0.248853 | 4 |
| guided | engagement | allIncludingAmbiguous | 84 | 0.005081 | 0.248853 | 4 |
| guidedExclusion | engagement | headline | 80 | 0.007689 | 0.171392 | 1 |
| guidedExclusion | engagement | allIncludingAmbiguous | 84 | 0.008097 | 0.171392 | 2 |

The [full summary JSON](data/decision-guidance-fresh-summary.json) contains all 98 interference flips with post text, gold, probabilities and correctness in each mode.

Own-filter “would the bounced post be caught again?” checks at the frozen cutoff (single-filter requests):

| Style | Filter | Positive bounced posts | Caught again | Missed | Subtle missed |
| --- | --- | --- | --- | --- | --- |
| short | all | 48 | 36 | 12 | 7 |
| guided | all | 48 | 28 | 20 | 12 |
| guidedExclusion | all | 48 | 29 | 19 | 11 |
| short | rudeness | 8 | 4 | 4 | 3 |
| guided | rudeness | 8 | 5 | 3 | 3 |
| guidedExclusion | rudeness | 8 | 6 | 2 | 2 |
| short | humblebrag | 8 | 4 | 4 | 1 |
| guided | humblebrag | 8 | 3 | 5 | 2 |
| guidedExclusion | humblebrag | 8 | 2 | 6 | 2 |
| short | doom | 8 | 7 | 1 | 1 |
| guided | doom | 8 | 5 | 3 | 2 |
| guidedExclusion | doom | 8 | 6 | 2 | 2 |
| short | hustle | 8 | 8 | 0 | 0 |
| guided | hustle | 8 | 6 | 2 | 1 |
| guidedExclusion | hustle | 8 | 6 | 2 | 1 |
| short | dunking | 8 | 5 | 3 | 2 |
| guided | dunking | 8 | 5 | 3 | 2 |
| guidedExclusion | dunking | 8 | 6 | 2 | 2 |
| short | engagement | 8 | 8 | 0 | 0 |
| guided | engagement | 8 | 4 | 4 | 2 |
| guidedExclusion | engagement | 8 | 3 | 5 | 2 |

Missed bounced posts, with their full text (pooled duplicates omitted):

| Style | Filter | Post | Kind | Probability | Label | Text |
| --- | --- | --- | --- | --- | --- | --- |
| short | rudeness | a-rudeness-06 | subtle-positive | 0.008974 | rude posts | Oh wow, another person discovered that coffee exists and wrote nine tweets about it. So brave. Truly. 👏 |
| short | rudeness | a-rudeness-08 | subtle-positive | 0.268844 | rude posts | sorry, I don't speak whatever this is. try again in a full sentence 🙂 |
| short | rudeness | a-rudeness-07 | subtle-positive | 0.176288 | rude posts | Love how people with 40 followers think I owe them a reply. Anyway. |
| short | rudeness | a-rudeness-02 | clear-positive | 0.199152 | rude posts | Not reading your thread. Didn't read the last one either. Nobody did. Stop tagging me. |
| guided | rudeness | a-rudeness-08 | subtle-positive | 0.249335 | posts being deliberately rude or edgy to get attention | sorry, I don't speak whatever this is. try again in a full sentence 🙂 |
| guided | rudeness | a-rudeness-07 | subtle-positive | 0.252747 | posts being deliberately rude or edgy to get attention | Love how people with 40 followers think I owe them a reply. Anyway. |
| guided | rudeness | a-rudeness-06 | subtle-positive | 0.019238 | posts being deliberately rude or edgy to get attention | Oh wow, another person discovered that coffee exists and wrote nine tweets about it. So brave. Truly. 👏 |
| guidedExclusion | rudeness | a-rudeness-06 | subtle-positive | 0.029660 | posts being deliberately rude or edgy to get attention, not blunt honest criticism | Oh wow, another person discovered that coffee exists and wrote nine tweets about it. So brave. Truly. 👏 |
| guidedExclusion | rudeness | a-rudeness-08 | subtle-positive | 0.230504 | posts being deliberately rude or edgy to get attention, not blunt honest criticism | sorry, I don't speak whatever this is. try again in a full sentence 🙂 |
| short | humblebrag | a-humblebrag-05 | clear-positive | 0.209006 | humblebrags | Three job offers in one week and now I'm losing sleep over which one to take. First-world problems, I know. Grateful though 🙏 |
| short | humblebrag | a-humblebrag-06 | subtle-positive | 0.265296 | humblebrags | Wore a hoodie to the conference so nobody would notice me. Still ended up doing four interviews before lunch. |
| short | humblebrag | a-humblebrag-03 | clear-positive | 0.243092 | humblebrags | Nobody warns you how hard it is to park a car this wide. The new one barely fits in the garage at the lake house lol |
| short | humblebrag | a-humblebrag-01 | clear-positive | 0.121144 | humblebrags | ugh so annoying when strangers keep stopping you at the airport for selfies and you nearly miss your flight. can't even get a coffee in peace 😩 |
| guided | humblebrag | a-humblebrag-05 | clear-positive | 0.117666 | posts bragging while pretending to complain or be humble | Three job offers in one week and now I'm losing sleep over which one to take. First-world problems, I know. Grateful though 🙏 |
| guided | humblebrag | a-humblebrag-08 | subtle-positive | 0.289880 | posts bragging while pretending to complain or be humble | Weird how a PhD and two published books still don't help me fold a fitted sheet 🙃 |
| guided | humblebrag | a-humblebrag-06 | subtle-positive | 0.275786 | posts bragging while pretending to complain or be humble | Wore a hoodie to the conference so nobody would notice me. Still ended up doing four interviews before lunch. |
| guided | humblebrag | a-humblebrag-03 | clear-positive | 0.231799 | posts bragging while pretending to complain or be humble | Nobody warns you how hard it is to park a car this wide. The new one barely fits in the garage at the lake house lol |
| guided | humblebrag | a-humblebrag-01 | clear-positive | 0.098187 | posts bragging while pretending to complain or be humble | ugh so annoying when strangers keep stopping you at the airport for selfies and you nearly miss your flight. can't even get a coffee in peace 😩 |
| guidedExclusion | humblebrag | a-humblebrag-05 | clear-positive | 0.083960 | posts bragging while pretending to complain or be humble, not sharing real good news | Three job offers in one week and now I'm losing sleep over which one to take. First-world problems, I know. Grateful though 🙏 |
| guidedExclusion | humblebrag | a-humblebrag-06 | subtle-positive | 0.219965 | posts bragging while pretending to complain or be humble, not sharing real good news | Wore a hoodie to the conference so nobody would notice me. Still ended up doing four interviews before lunch. |
| guidedExclusion | humblebrag | a-humblebrag-02 | clear-positive | 0.274851 | posts bragging while pretending to complain or be humble, not sharing real good news | Still processing that I was picked for the regional 30 under 30 list. I honestly don't know why they chose me, I just show up every day and do the work 🙏 |
| guidedExclusion | humblebrag | a-humblebrag-03 | clear-positive | 0.224880 | posts bragging while pretending to complain or be humble, not sharing real good news | Nobody warns you how hard it is to park a car this wide. The new one barely fits in the garage at the lake house lol |
| guidedExclusion | humblebrag | a-humblebrag-08 | subtle-positive | 0.285535 | posts bragging while pretending to complain or be humble, not sharing real good news | Weird how a PhD and two published books still don't help me fold a fitted sheet 🙃 |
| guidedExclusion | humblebrag | a-humblebrag-01 | clear-positive | 0.099204 | posts bragging while pretending to complain or be humble, not sharing real good news | ugh so annoying when strangers keep stopping you at the airport for selfies and you nearly miss your flight. can't even get a coffee in peace 😩 |
| short | doom | a-doom-06 | subtle-positive | 0.168963 | doomposting | Cute that people are still planting trees like there's going to be a 2050 🌱 |
| guided | doom | a-doom-06 | subtle-positive | 0.013638 | posts saying everything is collapsing and it's hopeless | Cute that people are still planting trees like there's going to be a 2050 🌱 |
| guided | doom | a-doom-08 | subtle-positive | 0.129142 | posts saying everything is collapsing and it's hopeless | Another 'record' summer. See you all at the next one. Back to scrolling, not like any of it matters. |
| guided | doom | a-doom-05 | clear-positive | 0.217396 | posts saying everything is collapsing and it's hopeless | Don't bother saving for retirement. There won't be an economy left by the time you're 60. Spend it now 🔥 |
| guidedExclusion | doom | a-doom-06 | subtle-positive | 0.037565 | posts saying everything is collapsing and it's hopeless, not news about specific problems | Cute that people are still planting trees like there's going to be a 2050 🌱 |
| guidedExclusion | doom | a-doom-08 | subtle-positive | 0.240078 | posts saying everything is collapsing and it's hopeless, not news about specific problems | Another 'record' summer. See you all at the next one. Back to scrolling, not like any of it matters. |
| guided | hustle | b-hustle-03 | clear-positive | 0.093609 | posts glorifying overwork, 5am routines and grinding | Everyone wants the results, nobody wants to miss the birthday parties. Haven't taken a weekend off in 3 years and I'd do it again tomorrow 💪 |
| guided | hustle | b-hustle-06 | subtle-positive | 0.194696 | posts glorifying overwork, 5am routines and grinding | funny how the people who "need balance" are always the same people asking how I got here 🙂 |
| guidedExclusion | hustle | b-hustle-06 | subtle-positive | 0.223148 | posts glorifying overwork, 5am routines and grinding, not genuine productivity tips | funny how the people who "need balance" are always the same people asking how I got here 🙂 |
| guidedExclusion | hustle | b-hustle-03 | clear-positive | 0.158211 | posts glorifying overwork, 5am routines and grinding, not genuine productivity tips | Everyone wants the results, nobody wants to miss the birthday parties. Haven't taken a weekend off in 3 years and I'd do it again tomorrow 💪 |
| short | dunking | b-dunking-07 | subtle-positive | 0.209059 | dunking | Love that this guy's "how I made my first 10k" thread ends with him asking for gas money. Truly inspiring stuff. |
| short | dunking | b-dunking-04 | clear-positive | 0.276078 | dunking | Imagine misspelling your own bakery's name on the sign and then posting it proudly. Sir. SIR. 😂 |
| short | dunking | b-dunking-08 | subtle-positive | 0.155098 | dunking | someone said they "invented" putting ice cream in espresso and I want to gently let them know affogato exists. but I won't. I'll just post it here instead 🙂 |
| guided | dunking | b-dunking-07 | subtle-positive | 0.096149 | posts mocking a random person's post or mistake | Love that this guy's "how I made my first 10k" thread ends with him asking for gas money. Truly inspiring stuff. |
| guided | dunking | b-dunking-08 | subtle-positive | 0.071032 | posts mocking a random person's post or mistake | someone said they "invented" putting ice cream in espresso and I want to gently let them know affogato exists. but I won't. I'll just post it here instead 🙂 |
| guided | dunking | b-dunking-04 | clear-positive | 0.199227 | posts mocking a random person's post or mistake | Imagine misspelling your own bakery's name on the sign and then posting it proudly. Sir. SIR. 😂 |
| guidedExclusion | dunking | b-dunking-08 | subtle-positive | 0.109304 | posts mocking a random person's post or mistake, not criticism of public figures | someone said they "invented" putting ice cream in espresso and I want to gently let them know affogato exists. but I won't. I'll just post it here instead 🙂 |
| guidedExclusion | dunking | b-dunking-07 | subtle-positive | 0.133704 | posts mocking a random person's post or mistake, not criticism of public figures | Love that this guy's "how I made my first 10k" thread ends with him asking for gas money. Truly inspiring stuff. |
| guided | engagement | b-engagement-02 | clear-positive | 0.086134 | posts asking questions just to get replies | You can only eat one for the rest of your life: pizza 🍕 or tacos 🌮. go. |
| guided | engagement | b-engagement-07 | subtle-positive | 0.110313 | posts asking questions just to get replies | unpopular opinion: cereal is a soup. not taking questions but I will be reading every single reply. |
| guided | engagement | b-engagement-08 | subtle-positive | 0.199667 | posts asking questions just to get replies | if you're seeing this you're one of the real ones. curious where everyone's tuning in from tonight 🌙 |
| guided | engagement | b-engagement-01 | clear-positive | 0.223208 | posts asking questions just to get replies | Describe your job badly. Wrong answers only 👇 |
| guidedExclusion | engagement | b-engagement-02 | clear-positive | 0.078216 | posts asking questions just to get replies, not genuine questions asking for help | You can only eat one for the rest of your life: pizza 🍕 or tacos 🌮. go. |
| guidedExclusion | engagement | b-engagement-08 | subtle-positive | 0.181514 | posts asking questions just to get replies, not genuine questions asking for help | if you're seeing this you're one of the real ones. curious where everyone's tuning in from tonight 🌙 |
| guidedExclusion | engagement | b-engagement-01 | clear-positive | 0.211662 | posts asking questions just to get replies, not genuine questions asking for help | Describe your job badly. Wrong answers only 👇 |
| guidedExclusion | engagement | b-engagement-05 | clear-positive | 0.220209 | posts asking questions just to get replies, not genuine questions asking for help | Drop your city and I'll tell you something about it 🙏 let's see how far this goes |
| guidedExclusion | engagement | b-engagement-07 | subtle-positive | 0.202417 | posts asking questions just to get replies, not genuine questions asking for help | unpopular opinion: cereal is a soup. not taking questions but I will be reading every single reply. |

In-sample best cutoffs are diagnostics only. They never replace the frozen operating point or affect the gate conclusions; disconnected equally optimal intervals are joined by ∪:

| Mode | Style | Filter | Best cutoff | Equally optimal intervals | Best-cutoff errors |
| --- | --- | --- | --- | --- | --- |
| single | short | all | 0.8608067475355139 | (0.8480184260938919, 0.8735950689771359] ∪ (0.890970503474356, 0.8934686429390462] | 42 |
| single | guided | all | 0.7150138223417316 | (0.609200295619908, 0.6215144460131334] ∪ (0.7059250024164384, 0.7241026422670248] | 39 |
| single | guidedExclusion | all | 0.6871537840919306 | (0.6809253143978192, 0.6933822537860419] | 39 |
| single | short | rudeness | 0.6007274297169308 | (0.58879652852369, 0.6126583309101716] | 6 |
| single | guided | rudeness | 0.7166027807362056 | (0.609200295619908, 0.6402860394333487] ∪ (0.6999281773766092, 0.7332773840958022] | 5 |
| single | guidedExclusion | rudeness | 0.670868898754801 | (0.6458558686508121, 0.6958819288587899] | 5 |
| single | short | humblebrag | 0.5839232311254163 | (0.5545444459886251, 0.6133020162622076] | 7 |
| single | guided | humblebrag | 0.7774981995223302 | (0.41518630943248114, 0.42642861870168247] ∪ (0.5549963990446606, 1] | 8 |
| single | guidedExclusion | humblebrag | 0.7997062981506001 | (0.5994125963012003, 1] | 8 |
| single | short | doom | 0.755919841074947 | (0.7430317817008136, 0.7688079004490804] | 4 |
| single | guided | doom | 0.8328634142628533 | (0.7628936735442969, 0.9028331549814097] | 4 |
| single | guidedExclusion | doom | 0.8087168180214884 | (0.17660751642030553, 0.2400777454922485] ∪ (0.287576603013787, 0.3273015566828448] ∪ (0.7613699436925725, 0.8560636923504044] | 4 |
| single | short | hustle | 0.9055628486727982 | (0.8480184260938919, 0.8735950689771359] ∪ (0.890970503474356, 0.9201551938712403] | 6 |
| single | guided | hustle | 0.7150138223417316 | (0.7059250024164384, 0.7241026422670248] | 4 |
| single | guidedExclusion | hustle | 0.8095745564867767 | (0.8018840369652376, 0.8172650760083159] | 5 |
| single | short | dunking | 0.3333360764398961 | (0.33330501763476045, 0.33336713524503175] | 7 |
| single | guided | dunking | 0.3164250489261657 | (0.30939343321007057, 0.3234566646422608] | 3 |
| single | guidedExclusion | dunking | 0.5376017613116411 | (0.4694778042518982, 0.47552716956649216] ∪ (0.5271274933238819, 0.5480760292994002] | 4 |
| single | short | engagement | 0.6908156472758497 | (0.6758874420129569, 0.7057438525387424] | 6 |
| single | guided | engagement | 0.21634536204933516 | (0.2094826732764779, 0.22320805082219242] | 6 |
| single | guidedExclusion | engagement | 0.17797959562542612 | (0.1744456539979867, 0.18151353725286554] | 5 |
| six-filter | short | all | 0.8351962927355134 | (0.8324961645062763, 0.8378964209647506] ∪ (0.8486278943076527, 0.8511269502833031] | 43 |
| six-filter | guided | all | 0.7581185249213684 | (0.7529016856571015, 0.7633353641856354] | 36 |
| six-filter | guidedExclusion | all | 0.7030993845762363 | (0.6769986645561783, 0.6850003453960405] ∪ (0.6920483495537754, 0.6927934139121876] ∪ (0.6950060952667768, 0.7111926738856958] | 37 |
| six-filter | short | rudeness | 0.7630192044340484 | (0.594111088073943, 0.6009401337862923] ∪ (0.6749114585847936, 0.8511269502833031] | 7 |
| six-filter | guided | rudeness | 0.7229127881889525 | (0.6824902121922698, 0.7633353641856354] | 5 |
| six-filter | guidedExclusion | rudeness | 0.720288714348051 | (0.6950060952667768, 0.7455713334293252] | 5 |
| six-filter | short | humblebrag | 0.6050571258356138 | (0.6017434135673561, 0.6083708381038715] | 7 |
| six-filter | guided | humblebrag | 0.7296853330904938 | (0.45937066618098743, 1] | 8 |
| six-filter | guidedExclusion | humblebrag | 0.8352287761215947 | (0.6704575522431895, 1] | 8 |
| six-filter | short | doom | 0.7208234153840318 | (0.7087221642909389, 0.7329246664771246] ∪ (0.7360711176356106, 0.7598815324234277] | 4 |
| six-filter | guided | doom | 0.8190663915853206 | (0.2013844002461208, 0.3291965574516096] ∪ (0.7417992393047713, 0.8963335438658698] | 4 |
| six-filter | guidedExclusion | doom | 0.33686917110518344 | (0.17250820580770904, 0.19235617182199125] ∪ (0.2329740901763723, 0.44076425203399455] ∪ (0.8171457728461528, 0.8514371413577818] | 4 |
| six-filter | short | hustle | 0.8351962927355134 | (0.8324961645062763, 0.8378964209647506] | 5 |
| six-filter | guided | hustle | 0.7586450124396371 | (0.7529016856571015, 0.7643883392221729] | 4 |
| six-filter | guidedExclusion | hustle | 0.6924208817329816 | (0.6920483495537754, 0.6927934139121876] | 5 |
| six-filter | short | dunking | 0.7049063213404365 | (0.40981264268087303, 1] | 8 |
| six-filter | guided | dunking | 0.39374382101273 | (0.35886874110066547, 0.42861890092479443] | 3 |
| six-filter | guidedExclusion | dunking | 0.5779892224988321 | (0.5415235234679633, 0.6144549215297008] | 3 |
| six-filter | short | engagement | 0.9243139471538264 | (0.6293961823928033, 0.658157798623846] ∪ (0.6685066684601605, 0.7148930935211034] ∪ (0.8486278943076527, 1] | 8 |
| six-filter | guided | engagement | 0.7112181127967139 | (0.1577306306643607, 0.1697846195432783] ∪ (0.6027356872502992, 0.8197005383431284] | 7 |
| six-filter | guidedExclusion | engagement | 0.5138515934068252 | (0.19757145924113836, 0.19951202750534547] ∪ (0.26786933207286656, 0.31029340373319453] ∪ (0.4835042045249035, 0.5441989822887469] | 6 |

This is a fresh synthetic test of the proposed label guidance, not production or live-feed qualification. AUC and best cutoffs are descriptive; no labels, thresholds, models or runtime settings were changed after registration. [Raw result](data/decision-guidance-fresh-result.json); [summary](data/decision-guidance-fresh-summary.json). Existing protected evidence remains unchanged. The renderer checks recorded provenance and aggregate/gate algebra only; it performs no inference, scoring, fitting or selection.

Evidence SHA-256: result `a9b851601bfa5cb2fcc88a219d258e4b66b751a5d6c67267a454cd86e5247380`; registration `927529a64e62542b099f641bffafe0211de08a399fa37d0563041dd79ab0e04e`; corpus `fe82fe7dcdf8cd96fb828d20624b4ba160dede297c36ddcfa4e57c09f6373cb3`; frozen selection `8b6d177113c7922c62fdbdeb08b75e7acdc1048d179b5d153744c59717623814`; identity `c29fc69a7e84200aff7966f23d4a0f20b8be0168dfbdf2cbb3778efedde3206f`.


## Capacity and description experiment

Status: **complete**. Registration recorded at 2026-11-24T21:10:17.905Z before inference. This experiment compares sentence guidance and full rubrics on d1-2B Q8 with three larger models. It changes no extension engine, model or default.

Part A retains d1-2B Q8’s frozen `matches-category` wrapper and `probability >= 0.290813258948728` cutoff. A sentence label is the guided label plus “. ” and the first complete “Keep…” sentence copied verbatim from its gold rubric; nothing is hand-authored. Full rubrics fill the same category slot in the selected template, rather than adding instructions outside that wrapper. **Full-gold rubric results are an upper bound**, because the definition contains the gold labeling boundary.

Part B selects one of the same two templates and a midpoint cutoff on the original 88-case discovery set, then freezes that choice before either original validation corpus or the fresh short/guided/rubric matrix. Original validation is exploratory: those corpora already helped qualify Gemma. The fresh 84-post corpus has six intents and 504 decisions per style; 22 ambiguous pairs leave 482 headline decisions, including 48 positives and 18 subtle positives.

The independent sentence-guidance rule requires **errors < 66 AND near-miss false hides ≤ 18** on d1-2B’s single-filter decisions. Near misses retain the original population of 143 eligible negative pairs on near-miss-tagged posts, including cross-filter pairs; the 24 own-filter pairs are secondary diagnostics.

The preregistered larger-model switch rule requires **fresh guided errors ≤ 33 AND G1/G2/G3 on BOTH original corpora AND warm ten-filter p50 ≤ 250 ms**. G1 allows at most one new false hide versus Browser, G2 requires at least Browser’s exact vectors, and G3 requires at least Browser’s correct hide/show decisions minus one. Rubric quality, six-filter behavior and in-sample best cutoffs cannot satisfy that rule.

Sentence guidance: **NOT SUPPORTED** by both recorded checks.

| Model | Description check | Actual | Comparison | Reference | Result |
| --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | errors | 114 | < | 66 | FAIL |
| llama-d1-2b-q8 | nearMissFalseHides | 46 | <= | 18 | FAIL |

| Larger model | Switch check | Actual | Comparison | Reference | Result | Overall |
| --- | --- | --- | --- | --- | --- | --- |
| llama-d1-3b-q8 | freshGuidedErrors | 71 | <= | 33 | FAIL | DOES NOT PASS SWITCH RULE |
| llama-d1-3b-q8 | originalValidation | both corpora | all gates | pass | PASS | DOES NOT PASS SWITCH RULE |
| llama-d1-3b-q8 | warm10MedianMs | 705.8718954999931 | <= | 250 | FAIL | DOES NOT PASS SWITCH RULE |
| llama-kev-4b-q8 | freshGuidedErrors | 66 | <= | 33 | FAIL | DOES NOT PASS SWITCH RULE |
| llama-kev-4b-q8 | originalValidation | both corpora | all gates | pass | PASS | DOES NOT PASS SWITCH RULE |
| llama-kev-4b-q8 | warm10MedianMs | 1525.0751455000718 | <= | 250 | FAIL | DOES NOT PASS SWITCH RULE |
| llama-clef-flash-q4km | freshGuidedErrors | 39 | <= | 33 | FAIL | DOES NOT PASS SWITCH RULE |
| llama-clef-flash-q4km | originalValidation | both corpora | all gates | pass | PASS | DOES NOT PASS SWITCH RULE |
| llama-clef-flash-q4km | warm10MedianMs | 1338.657708499988 | <= | 250 | FAIL | DOES NOT PASS SWITCH RULE |

Frozen choices (discovery chooses the operating point; fresh and validation results never retune it):

| Model | Model name | Format | Template | Cutoff | Equivalent interval | Identity SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | LiquidAI/d1-2B-GGUF:Q8_0 | GGUF Q8_0 | matches-category | 0.290813258948728 | (0.24152816538963, 0.34009835250782594] | c29fc69a7e84200aff7966f23d4a0f20b8be0168dfbdf2cbb3778efedde3206f |
| llama-d1-3b-q8 | LiquidAI/d1-3B-GGUF:Q8_0 | GGUF Q8_0 | category-applies | 0.16801175051148398 | (0.16524421521038138, 0.1707792858125866] | 108de3f6bf2c0eff86557ee3137863b2e6ceebf28b8d734461508e97c85f401a |
| llama-kev-4b-q8 | ggml-org/Kev-4B-GGUF:Q8_0 | GGUF Q8_0 | category-applies | 0.3168879112149103 | (0.3128541722537823, 0.32092165017603824] | d9ddb4b9fc0b4c1d856ec6cd90e60e746a0bb2673c3ecb03f5cac00e4b8b572d |
| llama-clef-flash-q4km | ggml-org/Clef-Flash-GGUF:Q4_K_M | GGUF Q4_K_M | category-applies | 0.1057976166900887 | (0.06501780231881457, 0.14657743106136284] | 1a5216390d0c7f7f32f23036a50803550945743fc060feee3fb98c64c59d0360 |

| Intent | Short | Guided | Mechanical sentence | Full gold rubric (upper bound) |
| --- | --- | --- | --- | --- |
| rudeness | rude posts | posts being deliberately rude or edgy to get attention | posts being deliberately rude or edgy to get attention. Keep posts that are blunt but sincere critique of ideas or work, plain disagreement with reasons, posts that criticise or complain about rude behaviour (including quoting it to object), and ordinary posts. | Hide posts where the author is deliberately rude, sneering or contemptuous toward other people as a performance: insulting strangers or repliers, dismissing people as stupid or worthless, or posing as tough or 'unbothered' to get attention or engagement. Sarcastic or understated contempt aimed at people counts. Keep posts that are blunt but sincere critique of ideas or work, plain disagreement with reasons, posts that criticise or complain about rude behaviour (including quoting it to object), and ordinary posts. |
| humblebrag | humblebrags | posts bragging while pretending to complain or be humble | posts bragging while pretending to complain or be humble. Keep open, sincere celebrations of good news, including ones that mention past struggle, real complaints and venting, modest posts about small personal wins that are not dressed up, and posts that mock or criticise humblebragging. | Hide posts that show off an achievement, status, wealth, looks or popularity while presenting it as a complaint, a burden, gratitude, self-deprecation or modesty, so that the brag is the real point. Keep open, sincere celebrations of good news, including ones that mention past struggle, real complaints and venting, modest posts about small personal wins that are not dressed up, and posts that mock or criticise humblebragging. |
| doom | doomposting | posts saying everything is collapsing and it's hopeless | posts saying everything is collapsing and it's hopeless. Keep specific factual reporting of bad news, worried posts that point to action or solutions, critiques of doomism, and personal bad-day hyperbole about the author's own small mishaps. | Hide posts that make sweeping claims that society, the economy, the planet or 'everything' is collapsing or already lost and that nothing can be done, whether said outright or through sarcastic resignation. Keep specific factual reporting of bad news, worried posts that point to action or solutions, critiques of doomism, and personal bad-day hyperbole about the author's own small mishaps. |
| hustle | hustle culture | posts glorifying overwork, 5am routines and grinding | posts glorifying overwork, 5am routines and grinding. Keep posts that criticise or mock hustle culture, sincere burnout or recovery stories, plain descriptions of an early routine or heavy workload that do not hold it up as a moral standard, and people working long hours out of necessity without glorifying it. | Hide posts that glorify or promote overwork as a virtue: bragging about long hours, little sleep, no days off, or pre-dawn routines framed as what separates winners from everyone else, and posts that shame rest or balance. Keep posts that criticise or mock hustle culture, sincere burnout or recovery stories, plain descriptions of an early routine or heavy workload that do not hold it up as a moral standard, and people working long hours out of necessity without glorifying it. |
| dunking | dunking | posts mocking a random person's post or mistake | posts mocking a random person's post or mistake. Keep posts that criticise dunk culture, laugh at the poster's own mistakes, gently correct misinformation without ridicule, and criticise public institutions or officials on the substance of what they did. | Hide posts that mock, ridicule or invite a pile-on against an ordinary, non-public person's post, mistake or behaviour for laughs, including screenshot dunks, sarcastic quote-posts and 'everyone look at this' callouts, whether open or veiled. Keep posts that criticise dunk culture, laugh at the poster's own mistakes, gently correct misinformation without ridicule, and criticise public institutions or officials on the substance of what they did. |
| engagement | engagement bait | posts asking questions just to get replies | posts asking questions just to get replies. Keep real questions where the poster actually needs information or input, posts with real content that end with a natural question, practical requests for replies that serve a concrete purpose, and posts criticising engagement bait. | Hide posts built mainly to get replies rather than to share anything or ask a real question: 'wrong answers only', 'which one are you', 'drop your X below', 'name a Y that Z', this-or-that picks, and vague prompts meant only to fill the replies, whether open or dressed up as casual chat. Keep real questions where the poster actually needs information or input, posts with real content that end with a natural question, practical requests for replies that serve a concrete purpose, and posts criticising engagement bait. |

Fresh headline quality. FH/MH are false hides/missed hides. The single-filter guided row alone contributes fresh quality to the switch gate; six-filter rows measure interference.

| Model | Mode | Style | Filter | n | AUC | FH / MH | Errors | Near-miss FH / n | Own near-miss FH / n | Subtle MH / n | In-sample best cutoff | Best interval | Best errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | single | guided | all | 482 | 0.8470 | 46 / 20 | 66 | 18/143 | 9/24 | 12/18 | 0.715014 | (0.7059250024164384, 0.7241026422670248] | 39 |
| llama-d1-2b-q8 | six-filter | guided | all | 482 | 0.8501 | 47 / 21 | 68 | 16/143 | 8/24 | 10/18 | 0.758119 | (0.7529016856571015, 0.7633353641856354] | 36 |
| llama-d1-2b-q8 | single | guided | rudeness | 75 | 0.8526 | 8 / 3 | 11 | 3/24 | 1/4 | 3/3 | 0.716603 | (0.6999281773766092, 0.7332773840958022] | 5 |
| llama-d1-2b-q8 | six-filter | guided | rudeness | 75 | 0.8433 | 10 / 3 | 13 | 4/24 | 1/4 | 2/3 | 0.722913 | (0.6824902121922698, 0.7633353641856354] | 5 |
| llama-d1-2b-q8 | single | guided | humblebrag | 81 | 0.7312 | 9 / 5 | 14 | 3/24 | 1/4 | 2/3 | 0.777498 | (0.5549963990446606, 1] | 8 |
| llama-d1-2b-q8 | six-filter | guided | humblebrag | 81 | 0.7140 | 10 / 6 | 16 | 2/24 | 1/4 | 2/3 | 0.729685 | (0.45937066618098743, 1] | 8 |
| llama-d1-2b-q8 | single | guided | doom | 84 | 0.8651 | 4 / 3 | 7 | 3/24 | 1/4 | 2/3 | 0.832863 | (0.7628936735442969, 0.9028331549814097] | 4 |
| llama-d1-2b-q8 | six-filter | guided | doom | 84 | 0.8734 | 1 / 3 | 4 | 1/24 | 1/4 | 2/3 | 0.819066 | (0.7417992393047713, 0.8963335438658698] | 4 |
| llama-d1-2b-q8 | single | guided | hustle | 83 | 0.8600 | 18 / 2 | 20 | 4/24 | 2/4 | 1/3 | 0.715014 | (0.7059250024164384, 0.7241026422670248] | 4 |
| llama-d1-2b-q8 | six-filter | guided | hustle | 83 | 0.8833 | 19 / 2 | 21 | 5/24 | 2/4 | 1/3 | 0.758645 | (0.7529016856571015, 0.7643883392221729] | 4 |
| llama-d1-2b-q8 | single | guided | dunking | 79 | 0.9049 | 4 / 3 | 7 | 2/23 | 1/4 | 2/3 | 0.316425 | (0.30939343321007057, 0.3234566646422608] | 3 |
| llama-d1-2b-q8 | six-filter | guided | dunking | 79 | 0.9032 | 3 / 2 | 5 | 1/23 | 0/4 | 2/3 | 0.393744 | (0.35886874110066547, 0.42861890092479443] | 3 |
| llama-d1-2b-q8 | single | guided | engagement | 80 | 0.9323 | 3 / 4 | 7 | 3/24 | 3/4 | 2/3 | 0.216345 | (0.2094826732764779, 0.22320805082219242] | 6 |
| llama-d1-2b-q8 | six-filter | guided | engagement | 80 | 0.9392 | 4 / 5 | 9 | 3/24 | 3/4 | 1/3 | 0.711218 | (0.6027356872502992, 0.8197005383431284] | 7 |
| llama-d1-2b-q8 | single | sentence | all | 482 | 0.7965 | 95 / 19 | 114 | 46/143 | 21/24 | 12/18 | 0.875398 | (0.8665025998926615, 0.884293476778489] | 46 |
| llama-d1-2b-q8 | six-filter | sentence | all | 482 | 0.7749 | 107 / 17 | 124 | 46/143 | 20/24 | 10/18 | 0.860651 | (0.8447961566963618, 0.8765056341032239] | 44 |
| llama-d1-2b-q8 | single | sentence | rudeness | 75 | 0.7388 | 29 / 3 | 32 | 13/24 | 4/4 | 3/3 | 0.856001 | (0.814656471800089, 0.8973463861097838] | 7 |
| llama-d1-2b-q8 | six-filter | sentence | rudeness | 75 | 0.7034 | 26 / 2 | 28 | 12/24 | 4/4 | 2/3 | 0.811885 | (0.8083051535859181, 0.8154652609876524] | 6 |
| llama-d1-2b-q8 | single | sentence | humblebrag | 81 | 0.6695 | 28 / 4 | 32 | 9/24 | 4/4 | 1/3 | 0.873224 | (0.7464478188756755, 1] | 8 |
| llama-d1-2b-q8 | six-filter | sentence | humblebrag | 81 | 0.6233 | 31 / 3 | 34 | 10/24 | 4/4 | 1/3 | 0.896359 | (0.7927186238703675, 1] | 8 |
| llama-d1-2b-q8 | single | sentence | doom | 84 | 0.8586 | 5 / 3 | 8 | 5/24 | 3/4 | 3/3 | 0.651401 | (0.5008314527048351, 0.8019709684433777] | 5 |
| llama-d1-2b-q8 | six-filter | sentence | doom | 84 | 0.8257 | 8 / 3 | 11 | 5/24 | 3/4 | 2/3 | 0.714448 | (0.6589800252704431, 0.7699154360679762] | 5 |
| llama-d1-2b-q8 | single | sentence | hustle | 83 | 0.8450 | 13 / 2 | 15 | 5/24 | 3/4 | 1/3 | 0.909245 | (0.8184895879558569, 1] | 8 |
| llama-d1-2b-q8 | six-filter | sentence | hustle | 83 | 0.8017 | 15 / 3 | 18 | 6/24 | 3/4 | 2/3 | 0.874723 | (0.7494455563882008, 1] | 8 |
| llama-d1-2b-q8 | single | sentence | dunking | 79 | 0.8768 | 12 / 2 | 14 | 7/23 | 3/4 | 2/3 | 0.560607 | (0.5428814699390704, 0.5783333123324139] | 5 |
| llama-d1-2b-q8 | six-filter | sentence | dunking | 79 | 0.8662 | 17 / 2 | 19 | 6/23 | 2/4 | 2/3 | 0.619122 | (0.6153064798130152, 0.6229376856797939] | 5 |
| llama-d1-2b-q8 | single | sentence | engagement | 80 | 0.8507 | 8 / 5 | 13 | 7/24 | 4/4 | 2/3 | 0.965064 | (0.9301275184283172, 1] | 8 |
| llama-d1-2b-q8 | six-filter | sentence | engagement | 80 | 0.8594 | 10 / 4 | 14 | 7/24 | 4/4 | 1/3 | 0.874922 | (0.8447961566963618, 0.9050472120439933] | 7 |
| llama-d1-2b-q8 | single | rubric | all | 482 | 0.8805 | 171 / 4 | 175 | 55/143 | 22/24 | 4/18 | 0.809419 | (0.8041528349460885, 0.814685971337151] | 38 |
| llama-d1-2b-q8 | six-filter | rubric | all | 482 | 0.8600 | 197 / 4 | 201 | 55/143 | 20/24 | 4/18 | 0.889857 | (0.8811236808384273, 0.8985909701833176] | 41 |
| llama-d1-2b-q8 | single | rubric | rudeness | 75 | 0.8526 | 21 / 1 | 22 | 8/24 | 4/4 | 1/3 | 0.649071 | (0.64877095750907, 0.6493711961473275] | 5 |
| llama-d1-2b-q8 | six-filter | rubric | rudeness | 75 | 0.8340 | 25 / 2 | 27 | 7/24 | 4/4 | 2/3 | 0.808203 | (0.7597159934262006, 0.8566892551336109] | 6 |
| llama-d1-2b-q8 | single | rubric | humblebrag | 81 | 0.8185 | 56 / 0 | 56 | 15/24 | 4/4 | 0/3 | 0.820331 | (0.7864074096266545, 0.8542549769145124] | 7 |
| llama-d1-2b-q8 | six-filter | rubric | humblebrag | 81 | 0.7449 | 55 / 0 | 55 | 15/24 | 4/4 | 0/3 | 0.910869 | (0.8217374832577096, 1] | 8 |
| llama-d1-2b-q8 | single | rubric | doom | 84 | 0.9655 | 12 / 1 | 13 | 5/24 | 3/4 | 1/3 | 0.711114 | (0.6959705055950307, 0.726257846073694] | 2 |
| llama-d1-2b-q8 | six-filter | rubric | doom | 84 | 0.9638 | 12 / 1 | 13 | 4/24 | 2/4 | 1/3 | 0.698096 | (0.6531780992614626, 0.7430140133738474] | 3 |
| llama-d1-2b-q8 | single | rubric | hustle | 83 | 0.8917 | 37 / 0 | 37 | 12/24 | 4/4 | 0/3 | 0.946490 | (0.8929795153641334, 1] | 8 |
| llama-d1-2b-q8 | six-filter | rubric | hustle | 83 | 0.8100 | 53 / 0 | 53 | 14/24 | 4/4 | 0/3 | 0.953481 | (0.9069621224087345, 1] | 8 |
| llama-d1-2b-q8 | single | rubric | dunking | 79 | 0.7975 | 24 / 2 | 26 | 7/23 | 3/4 | 2/3 | 0.891969 | (0.783938925200928, 1] | 8 |
| llama-d1-2b-q8 | six-filter | rubric | dunking | 79 | 0.8169 | 27 / 1 | 28 | 6/23 | 2/4 | 1/3 | 0.748972 | (0.7487062378146967, 0.7492374177867471] | 7 |
| llama-d1-2b-q8 | single | rubric | engagement | 80 | 0.9410 | 21 / 0 | 21 | 8/24 | 4/4 | 0/3 | 0.794507 | (0.7743279870362231, 0.814685971337151] | 5 |
| llama-d1-2b-q8 | six-filter | rubric | engagement | 80 | 0.9375 | 25 / 0 | 25 | 9/24 | 4/4 | 0/3 | 0.812093 | (0.795710975989492, 0.8284753179831367] | 3 |
| llama-d1-3b-q8 | single | short | all | 482 | 0.8118 | 62 / 20 | 82 | 24/143 | 11/24 | 9/18 | 0.594127 | (0.5914112485609789, 0.596842137286219] | 39 |
| llama-d1-3b-q8 | six-filter | short | all | 482 | 0.8118 | 62 / 20 | 82 | 24/143 | 11/24 | 9/18 | 0.594127 | (0.5914112485609789, 0.596842137286219] | 39 |
| llama-d1-3b-q8 | single | short | rudeness | 75 | 0.7966 | 7 / 5 | 12 | 4/24 | 1/4 | 3/3 | 0.912584 | (0.8851745542577789, 0.9399940889190317] | 6 |
| llama-d1-3b-q8 | six-filter | short | rudeness | 75 | 0.7966 | 7 / 5 | 12 | 4/24 | 1/4 | 3/3 | 0.912584 | (0.8851745542577789, 0.9399940889190317] | 6 |
| llama-d1-3b-q8 | single | short | humblebrag | 81 | 0.7038 | 9 / 5 | 14 | 3/24 | 3/4 | 1/3 | 0.745369 | (0.49073754428534877, 1] | 8 |
| llama-d1-3b-q8 | six-filter | short | humblebrag | 81 | 0.7038 | 9 / 5 | 14 | 3/24 | 3/4 | 1/3 | 0.745369 | (0.49073754428534877, 1] | 8 |
| llama-d1-3b-q8 | single | short | doom | 84 | 0.9490 | 4 / 2 | 6 | 2/24 | 2/4 | 2/3 | 0.481734 | (0.38041047854619336, 0.5830568414770435] | 3 |
| llama-d1-3b-q8 | six-filter | short | doom | 84 | 0.9490 | 4 / 2 | 6 | 2/24 | 2/4 | 2/3 | 0.481734 | (0.38041047854619336, 0.5830568414770435] | 3 |
| llama-d1-3b-q8 | single | short | hustle | 83 | 0.9183 | 13 / 1 | 14 | 5/24 | 3/4 | 1/3 | 0.729070 | (0.6752537021856725, 0.7828856133997999] | 6 |
| llama-d1-3b-q8 | six-filter | short | hustle | 83 | 0.9183 | 13 / 1 | 14 | 5/24 | 3/4 | 1/3 | 0.729070 | (0.6752537021856725, 0.7828856133997999] | 6 |
| llama-d1-3b-q8 | single | short | dunking | 79 | 0.7588 | 3 / 7 | 10 | 2/23 | 0/4 | 2/3 | 0.528802 | (0.457640860046364, 0.5999631537618736] | 7 |
| llama-d1-3b-q8 | six-filter | short | dunking | 79 | 0.7588 | 3 / 7 | 10 | 2/23 | 0/4 | 2/3 | 0.528802 | (0.457640860046364, 0.5999631537618736] | 7 |
| llama-d1-3b-q8 | single | short | engagement | 80 | 0.9236 | 26 / 0 | 26 | 8/24 | 2/4 | 0/3 | 0.594012 | (0.5380067589107943, 0.6500174310911558] | 4 |
| llama-d1-3b-q8 | six-filter | short | engagement | 80 | 0.9236 | 26 / 0 | 26 | 8/24 | 2/4 | 0/3 | 0.594012 | (0.5380067589107943, 0.6500174310911558] | 4 |
| llama-d1-3b-q8 | single | guided | all | 482 | 0.8563 | 50 / 21 | 71 | 22/143 | 13/24 | 12/18 | 0.934230 | (0.922075877533682, 0.946384633978637] | 44 |
| llama-d1-3b-q8 | six-filter | guided | all | 482 | 0.8563 | 50 / 21 | 71 | 22/143 | 13/24 | 12/18 | 0.934230 | (0.922075877533682, 0.946384633978637] | 44 |
| llama-d1-3b-q8 | single | guided | rudeness | 75 | 0.7575 | 12 / 4 | 16 | 4/24 | 1/4 | 3/3 | 0.934230 | (0.922075877533682, 0.946384633978637] | 6 |
| llama-d1-3b-q8 | six-filter | guided | rudeness | 75 | 0.7575 | 12 / 4 | 16 | 4/24 | 1/4 | 3/3 | 0.934230 | (0.922075877533682, 0.946384633978637] | 6 |
| llama-d1-3b-q8 | single | guided | humblebrag | 81 | 0.7637 | 5 / 8 | 13 | 1/24 | 1/4 | 3/3 | 0.671633 | (0.34326561864457394, 1] | 8 |
| llama-d1-3b-q8 | six-filter | guided | humblebrag | 81 | 0.7637 | 5 / 8 | 13 | 1/24 | 1/4 | 3/3 | 0.671633 | (0.34326561864457394, 1] | 8 |
| llama-d1-3b-q8 | single | guided | doom | 84 | 0.8997 | 6 / 2 | 8 | 4/24 | 3/4 | 2/3 | 0.281850 | (0.26730841303467484, 0.29639166222036656] | 4 |
| llama-d1-3b-q8 | six-filter | guided | doom | 84 | 0.8997 | 6 / 2 | 8 | 4/24 | 3/4 | 2/3 | 0.281850 | (0.26730841303467484, 0.29639166222036656] | 4 |
| llama-d1-3b-q8 | single | guided | hustle | 83 | 0.9067 | 9 / 3 | 12 | 4/24 | 3/4 | 2/3 | 0.670516 | (0.5878358972915859, 0.7531955151115123] | 7 |
| llama-d1-3b-q8 | six-filter | guided | hustle | 83 | 0.9067 | 9 / 3 | 12 | 4/24 | 3/4 | 2/3 | 0.670516 | (0.5878358972915859, 0.7531955151115123] | 7 |
| llama-d1-3b-q8 | single | guided | dunking | 79 | 0.8732 | 8 / 3 | 11 | 4/23 | 1/4 | 2/3 | 0.495973 | (0.42117374155606885, 0.5707720417956923] | 7 |
| llama-d1-3b-q8 | six-filter | guided | dunking | 79 | 0.8732 | 8 / 3 | 11 | 4/23 | 1/4 | 2/3 | 0.495973 | (0.42117374155606885, 0.5707720417956923] | 7 |
| llama-d1-3b-q8 | single | guided | engagement | 80 | 0.8854 | 10 / 1 | 11 | 5/24 | 4/4 | 0/3 | 0.898372 | (0.7967435007724569, 1] | 8 |
| llama-d1-3b-q8 | six-filter | guided | engagement | 80 | 0.8854 | 10 / 1 | 11 | 5/24 | 4/4 | 0/3 | 0.898372 | (0.7967435007724569, 1] | 8 |
| llama-d1-3b-q8 | single | rubric | all | 482 | 0.8690 | 76 / 15 | 91 | 31/143 | 17/24 | 12/18 | 0.716545 | (0.7069062282816378, 0.7261844668763806] | 40 |
| llama-d1-3b-q8 | six-filter | rubric | all | 482 | 0.8690 | 76 / 15 | 91 | 31/143 | 17/24 | 12/18 | 0.716545 | (0.7069062282816378, 0.7261844668763806] | 40 |
| llama-d1-3b-q8 | single | rubric | rudeness | 75 | 0.7817 | 18 / 3 | 21 | 7/24 | 3/4 | 3/3 | 0.894897 | (0.881227762262475, 0.9085664136911719] | 6 |
| llama-d1-3b-q8 | six-filter | rubric | rudeness | 75 | 0.7817 | 18 / 3 | 21 | 7/24 | 3/4 | 3/3 | 0.894897 | (0.881227762262475, 0.9085664136911719] | 6 |
| llama-d1-3b-q8 | single | rubric | humblebrag | 81 | 0.8408 | 4 / 5 | 9 | 2/24 | 2/4 | 2/3 | 0.819747 | (0.6394933671743557, 1] | 8 |
| llama-d1-3b-q8 | six-filter | rubric | humblebrag | 81 | 0.8408 | 4 / 5 | 9 | 2/24 | 2/4 | 2/3 | 0.819747 | (0.6394933671743557, 1] | 8 |
| llama-d1-3b-q8 | single | rubric | doom | 84 | 0.9671 | 3 / 2 | 5 | 2/24 | 2/4 | 2/3 | 0.503768 | (0.37588722151953285, 0.6316480034799447] | 3 |
| llama-d1-3b-q8 | six-filter | rubric | doom | 84 | 0.9671 | 3 / 2 | 5 | 2/24 | 2/4 | 2/3 | 0.503768 | (0.37588722151953285, 0.6316480034799447] | 3 |
| llama-d1-3b-q8 | single | rubric | hustle | 83 | 0.9317 | 12 / 1 | 13 | 5/24 | 4/4 | 1/3 | 0.477665 | (0.4401872319047208, 0.5151421006753595] | 7 |
| llama-d1-3b-q8 | six-filter | rubric | hustle | 83 | 0.9317 | 12 / 1 | 13 | 5/24 | 4/4 | 1/3 | 0.477665 | (0.4401872319047208, 0.5151421006753595] | 7 |
| llama-d1-3b-q8 | single | rubric | dunking | 79 | 0.7764 | 21 / 3 | 24 | 9/23 | 4/4 | 3/3 | 0.913278 | (0.8265554418564226, 1] | 8 |
| llama-d1-3b-q8 | six-filter | rubric | dunking | 79 | 0.7764 | 21 / 3 | 24 | 9/23 | 4/4 | 3/3 | 0.913278 | (0.8265554418564226, 1] | 8 |
| llama-d1-3b-q8 | single | rubric | engagement | 80 | 0.9115 | 18 / 1 | 19 | 6/24 | 2/4 | 1/3 | 0.699159 | (0.6721337579704298, 0.7261844668763806] | 5 |
| llama-d1-3b-q8 | six-filter | rubric | engagement | 80 | 0.9115 | 18 / 1 | 19 | 6/24 | 2/4 | 1/3 | 0.699159 | (0.6721337579704298, 0.7261844668763806] | 5 |
| llama-kev-4b-q8 | single | short | all | 482 | 0.8409 | 138 / 9 | 147 | 50/143 | 12/24 | 7/18 | 0.822215 | (0.8198884026045093, 0.8245425949882396] | 43 |
| llama-kev-4b-q8 | six-filter | short | all | 482 | 0.8409 | 138 / 9 | 147 | 50/143 | 12/24 | 7/18 | 0.822215 | (0.8198884026045093, 0.8245425949882396] | 43 |
| llama-kev-4b-q8 | single | short | rudeness | 75 | 0.8899 | 14 / 2 | 16 | 8/24 | 2/4 | 2/3 | 0.752609 | (0.7474145722923365, 0.7578030371898918] | 4 |
| llama-kev-4b-q8 | six-filter | short | rudeness | 75 | 0.8899 | 14 / 2 | 16 | 8/24 | 2/4 | 2/3 | 0.752609 | (0.7474145722923365, 0.7578030371898918] | 4 |
| llama-kev-4b-q8 | single | short | humblebrag | 81 | 0.8305 | 17 / 2 | 19 | 4/24 | 3/4 | 1/3 | 0.899541 | (0.7990821692032498, 1] | 8 |
| llama-kev-4b-q8 | six-filter | short | humblebrag | 81 | 0.8305 | 17 / 2 | 19 | 4/24 | 3/4 | 1/3 | 0.899541 | (0.7990821692032498, 1] | 8 |
| llama-kev-4b-q8 | single | short | doom | 84 | 0.8076 | 47 / 0 | 47 | 14/24 | 1/4 | 0/3 | 0.909944 | (0.8198884026045093, 1] | 8 |
| llama-kev-4b-q8 | six-filter | short | doom | 84 | 0.8076 | 47 / 0 | 47 | 14/24 | 1/4 | 0/3 | 0.909944 | (0.8198884026045093, 1] | 8 |
| llama-kev-4b-q8 | single | short | hustle | 83 | 0.9550 | 13 / 1 | 14 | 7/24 | 3/4 | 1/3 | 0.700388 | (0.6493153383073934, 0.7514605753325094] | 4 |
| llama-kev-4b-q8 | six-filter | short | hustle | 83 | 0.9550 | 13 / 1 | 14 | 7/24 | 3/4 | 1/3 | 0.700388 | (0.6493153383073934, 0.7514605753325094] | 4 |
| llama-kev-4b-q8 | single | short | dunking | 79 | 0.7183 | 25 / 3 | 28 | 10/23 | 2/4 | 2/3 | 0.904584 | (0.8091670629723368, 1] | 8 |
| llama-kev-4b-q8 | six-filter | short | dunking | 79 | 0.7183 | 25 / 3 | 28 | 10/23 | 2/4 | 2/3 | 0.904584 | (0.8091670629723368, 1] | 8 |
| llama-kev-4b-q8 | single | short | engagement | 80 | 0.9028 | 22 / 1 | 23 | 7/24 | 1/4 | 1/3 | 0.564289 | (0.5470680721991916, 0.5815099087830264] | 4 |
| llama-kev-4b-q8 | six-filter | short | engagement | 80 | 0.9028 | 22 / 1 | 23 | 7/24 | 1/4 | 1/3 | 0.564289 | (0.5470680721991916, 0.5815099087830264] | 4 |
| llama-kev-4b-q8 | single | guided | all | 482 | 0.8866 | 51 / 15 | 66 | 20/143 | 11/24 | 10/18 | 0.694428 | (0.6934912474222172, 0.6953648936096405] | 34 |
| llama-kev-4b-q8 | six-filter | guided | all | 482 | 0.8866 | 51 / 15 | 66 | 20/143 | 11/24 | 10/18 | 0.694428 | (0.6934912474222172, 0.6953648936096405] | 34 |
| llama-kev-4b-q8 | single | guided | rudeness | 75 | 0.8731 | 17 / 2 | 19 | 6/24 | 2/4 | 2/3 | 0.724544 | (0.7132005391878227, 0.7358865686870855] | 5 |
| llama-kev-4b-q8 | six-filter | guided | rudeness | 75 | 0.8731 | 17 / 2 | 19 | 6/24 | 2/4 | 2/3 | 0.724544 | (0.7132005391878227, 0.7358865686870855] | 5 |
| llama-kev-4b-q8 | single | guided | humblebrag | 81 | 0.6815 | 6 / 6 | 12 | 2/24 | 2/4 | 2/3 | 0.408336 | (0.3884365096378055, 0.428235474971682] | 7 |
| llama-kev-4b-q8 | six-filter | guided | humblebrag | 81 | 0.6815 | 6 / 6 | 12 | 2/24 | 2/4 | 2/3 | 0.408336 | (0.3884365096378055, 0.428235474971682] | 7 |
| llama-kev-4b-q8 | single | guided | doom | 84 | 0.9161 | 2 / 3 | 5 | 1/24 | 1/4 | 3/3 | 0.628348 | (0.49840372226306046, 0.758292974897951] | 3 |
| llama-kev-4b-q8 | six-filter | guided | doom | 84 | 0.9161 | 2 / 3 | 5 | 1/24 | 1/4 | 3/3 | 0.628348 | (0.49840372226306046, 0.758292974897951] | 3 |
| llama-kev-4b-q8 | single | guided | hustle | 83 | 0.9783 | 2 / 2 | 4 | 1/24 | 1/4 | 1/3 | 0.584297 | (0.5807508611736577, 0.5878438618362385] | 2 |
| llama-kev-4b-q8 | six-filter | guided | hustle | 83 | 0.9783 | 2 / 2 | 4 | 1/24 | 1/4 | 1/3 | 0.584297 | (0.5807508611736577, 0.5878438618362385] | 2 |
| llama-kev-4b-q8 | single | guided | dunking | 79 | 0.9437 | 17 / 1 | 18 | 6/23 | 2/4 | 1/3 | 0.665727 | (0.6560233359652693, 0.6754314758702805] | 5 |
| llama-kev-4b-q8 | six-filter | guided | dunking | 79 | 0.9437 | 17 / 1 | 18 | 6/23 | 2/4 | 1/3 | 0.665727 | (0.6560233359652693, 0.6754314758702805] | 5 |
| llama-kev-4b-q8 | single | guided | engagement | 80 | 0.9184 | 7 / 1 | 8 | 4/24 | 3/4 | 1/3 | 0.662208 | (0.6033529178281456, 0.7210638603796133] | 7 |
| llama-kev-4b-q8 | six-filter | guided | engagement | 80 | 0.9184 | 7 / 1 | 8 | 4/24 | 3/4 | 1/3 | 0.662208 | (0.6033529178281456, 0.7210638603796133] | 7 |
| llama-kev-4b-q8 | single | rubric | all | 482 | 0.9222 | 88 / 5 | 93 | 36/143 | 18/24 | 4/18 | 0.656915 | (0.6545197448793968, 0.6593106975385638] | 39 |
| llama-kev-4b-q8 | six-filter | rubric | all | 482 | 0.9222 | 88 / 5 | 93 | 36/143 | 18/24 | 4/18 | 0.656915 | (0.6545197448793968, 0.6593106975385638] | 39 |
| llama-kev-4b-q8 | single | rubric | rudeness | 75 | 0.9179 | 14 / 1 | 15 | 6/24 | 2/4 | 1/3 | 0.646258 | (0.641307005183561, 0.6512081854659365] | 4 |
| llama-kev-4b-q8 | six-filter | rubric | rudeness | 75 | 0.9179 | 14 / 1 | 15 | 6/24 | 2/4 | 1/3 | 0.646258 | (0.641307005183561, 0.6512081854659365] | 4 |
| llama-kev-4b-q8 | single | rubric | humblebrag | 81 | 0.8664 | 29 / 0 | 29 | 9/24 | 4/4 | 0/3 | 0.922141 | (0.8442814512977384, 1] | 8 |
| llama-kev-4b-q8 | six-filter | rubric | humblebrag | 81 | 0.8664 | 29 / 0 | 29 | 9/24 | 4/4 | 0/3 | 0.922141 | (0.8442814512977384, 1] | 8 |
| llama-kev-4b-q8 | single | rubric | doom | 84 | 0.9803 | 4 / 1 | 5 | 2/24 | 2/4 | 1/3 | 0.601043 | (0.4223785908048781, 0.7797078429576897] | 3 |
| llama-kev-4b-q8 | six-filter | rubric | doom | 84 | 0.9803 | 4 / 1 | 5 | 2/24 | 2/4 | 1/3 | 0.601043 | (0.4223785908048781, 0.7797078429576897] | 3 |
| llama-kev-4b-q8 | single | rubric | hustle | 83 | 0.9733 | 5 / 2 | 7 | 5/24 | 4/4 | 1/3 | 0.517396 | (0.5093723553122224, 0.5254186514652203] | 3 |
| llama-kev-4b-q8 | six-filter | rubric | hustle | 83 | 0.9733 | 5 / 2 | 7 | 5/24 | 4/4 | 1/3 | 0.517396 | (0.5093723553122224, 0.5254186514652203] | 3 |
| llama-kev-4b-q8 | single | rubric | dunking | 79 | 0.9014 | 19 / 1 | 20 | 6/23 | 2/4 | 1/3 | 0.645852 | (0.6323923218911754, 0.6593106975385638] | 7 |
| llama-kev-4b-q8 | six-filter | rubric | dunking | 79 | 0.9014 | 19 / 1 | 20 | 6/23 | 2/4 | 1/3 | 0.645852 | (0.6323923218911754, 0.6593106975385638] | 7 |
| llama-kev-4b-q8 | single | rubric | engagement | 80 | 0.9340 | 17 / 0 | 17 | 8/24 | 4/4 | 0/3 | 0.812523 | (0.80337320239197, 0.8216730361481003] | 6 |
| llama-kev-4b-q8 | six-filter | rubric | engagement | 80 | 0.9340 | 17 / 0 | 17 | 8/24 | 4/4 | 0/3 | 0.812523 | (0.80337320239197, 0.8216730361481003] | 6 |
| llama-clef-flash-q4km | single | short | all | 482 | 0.8725 | 60 / 15 | 75 | 20/143 | 7/24 | 9/18 | 0.416361 | (0.40419913688295556, 0.42852274470748675] | 35 |
| llama-clef-flash-q4km | six-filter | short | all | 482 | 0.9022 | 107 / 7 | 114 | 38/143 | 13/24 | 4/18 | 0.668605 | (0.6685938439473315, 0.6686166387746956] | 37 |
| llama-clef-flash-q4km | single | short | rudeness | 75 | 0.8918 | 8 / 4 | 12 | 3/24 | 1/4 | 3/3 | 0.636136 | (0.5918364604897023, 0.6804359922780893] | 4 |
| llama-clef-flash-q4km | six-filter | short | rudeness | 75 | 0.8899 | 13 / 2 | 15 | 5/24 | 2/4 | 2/3 | 0.717979 | (0.5383063945785503, 0.8976515246707917] | 5 |
| llama-clef-flash-q4km | single | short | humblebrag | 81 | 0.8767 | 10 / 3 | 13 | 1/24 | 1/4 | 1/3 | 0.406555 | (0.35394510985424155, 0.45916404902849683] | 5 |
| llama-clef-flash-q4km | six-filter | short | humblebrag | 81 | 0.8955 | 16 / 1 | 17 | 3/24 | 2/4 | 0/3 | 0.473268 | (0.4655294662903694, 0.48100729000611464] | 4 |
| llama-clef-flash-q4km | single | short | doom | 84 | 0.8668 | 20 / 2 | 22 | 6/24 | 1/4 | 2/3 | 0.808467 | (0.7687313653118688, 0.8482025596074031] | 5 |
| llama-clef-flash-q4km | six-filter | short | doom | 84 | 0.9227 | 41 / 0 | 41 | 14/24 | 4/4 | 0/3 | 0.827874 | (0.7938923539094914, 0.8618548655762857] | 4 |
| llama-clef-flash-q4km | single | short | hustle | 83 | 0.9767 | 13 / 0 | 13 | 6/24 | 3/4 | 0/3 | 0.766145 | (0.7508275778432656, 0.781463103889892] | 4 |
| llama-clef-flash-q4km | six-filter | short | hustle | 83 | 0.9750 | 14 / 0 | 14 | 7/24 | 3/4 | 0/3 | 0.656458 | (0.6377927354941444, 0.6751239610311923] | 4 |
| llama-clef-flash-q4km | single | short | dunking | 79 | 0.8327 | 3 / 6 | 9 | 1/23 | 0/4 | 3/3 | 0.477742 | (0.39200289678948935, 0.5634801499746883] | 7 |
| llama-clef-flash-q4km | six-filter | short | dunking | 79 | 0.8609 | 13 / 3 | 16 | 4/23 | 0/4 | 2/3 | 0.299697 | (0.26937383697341766, 0.3300200836170204] | 7 |
| llama-clef-flash-q4km | single | short | engagement | 80 | 0.9948 | 6 / 0 | 6 | 3/24 | 1/4 | 0/3 | 0.196603 | (0.19053639995157756, 0.20266925219163895] | 1 |
| llama-clef-flash-q4km | six-filter | short | engagement | 80 | 0.9688 | 10 / 1 | 11 | 5/24 | 2/4 | 0/3 | 0.221548 | (0.202562321970991, 0.2405335474086206] | 3 |
| llama-clef-flash-q4km | single | guided | all | 482 | 0.9507 | 26 / 13 | 39 | 11/143 | 7/24 | 8/18 | 0.482492 | (0.47525380473030104, 0.48973080404792585] | 28 |
| llama-clef-flash-q4km | six-filter | guided | all | 482 | 0.9469 | 51 / 10 | 61 | 20/143 | 11/24 | 6/18 | 0.442620 | (0.441977556029479, 0.4432625148852123] | 25 |
| llama-clef-flash-q4km | single | guided | rudeness | 75 | 0.8937 | 8 / 3 | 11 | 3/24 | 2/4 | 1/3 | 0.694495 | (0.6509989668565161, 0.7379908318817076] | 5 |
| llama-clef-flash-q4km | six-filter | guided | rudeness | 75 | 0.8507 | 16 / 2 | 18 | 4/24 | 2/4 | 1/3 | 0.621633 | (0.6129945305738765, 0.6302723342835335] | 5 |
| llama-clef-flash-q4km | single | guided | humblebrag | 81 | 0.9024 | 4 / 3 | 7 | 1/24 | 1/4 | 1/3 | 0.171467 | (0.15348883404919333, 0.18944469180271892] | 5 |
| llama-clef-flash-q4km | six-filter | guided | humblebrag | 81 | 0.8870 | 11 / 2 | 13 | 2/24 | 1/4 | 0/3 | 0.261305 | (0.23232776316339612, 0.2902832296962644] | 6 |
| llama-clef-flash-q4km | single | guided | doom | 84 | 0.9786 | 3 / 2 | 5 | 2/24 | 1/4 | 2/3 | 0.827676 | (0.7610629470445011, 0.8942887890758324] | 3 |
| llama-clef-flash-q4km | six-filter | guided | doom | 84 | 0.9753 | 6 / 2 | 8 | 4/24 | 1/4 | 2/3 | 0.508273 | (0.4319365857013597, 0.5846089403257955] | 3 |
| llama-clef-flash-q4km | single | guided | hustle | 83 | 0.9833 | 6 / 1 | 7 | 2/24 | 2/4 | 1/3 | 0.619798 | (0.47488251411528815, 0.7647143283537502] | 2 |
| llama-clef-flash-q4km | six-filter | guided | hustle | 83 | 0.9750 | 6 / 1 | 7 | 2/24 | 2/4 | 1/3 | 0.462630 | (0.3884522767852127, 0.536807226847001] | 2 |
| llama-clef-flash-q4km | single | guided | dunking | 79 | 0.9648 | 3 / 2 | 5 | 1/23 | 0/4 | 2/3 | 0.436992 | (0.3329962810831234, 0.5409877540892196] | 4 |
| llama-clef-flash-q4km | six-filter | guided | dunking | 79 | 0.9613 | 7 / 2 | 9 | 4/23 | 2/4 | 2/3 | 0.468668 | (0.441977556029479, 0.49535794483138124] | 4 |
| llama-clef-flash-q4km | single | guided | engagement | 80 | 0.9774 | 2 / 2 | 4 | 2/24 | 1/4 | 1/3 | 0.088900 | (0.0844465069015463, 0.09335332563390626] | 3 |
| llama-clef-flash-q4km | six-filter | guided | engagement | 80 | 0.9809 | 5 / 1 | 6 | 4/24 | 3/4 | 0/3 | 0.197734 | (0.18030809111302243, 0.21516028816795116] | 3 |
| llama-clef-flash-q4km | single | rubric | all | 482 | 0.9205 | 43 / 10 | 53 | 19/143 | 12/24 | 5/18 | 0.842601 | (0.8087279905701207, 0.8764737473104325] | 34 |
| llama-clef-flash-q4km | six-filter | rubric | all | 482 | 0.9315 | 61 / 8 | 69 | 27/143 | 18/24 | 4/18 | 0.669714 | (0.6691010001347498, 0.6703267377680835] | 31 |
| llama-clef-flash-q4km | single | rubric | rudeness | 75 | 0.9142 | 2 / 3 | 5 | 1/24 | 1/4 | 1/3 | 0.702837 | (0.5173319548007028, 0.8883429480382826] | 5 |
| llama-clef-flash-q4km | six-filter | rubric | rudeness | 75 | 0.8694 | 11 / 3 | 14 | 4/24 | 2/4 | 1/3 | 0.671646 | (0.5477412928527404, 0.7955508469444917] | 5 |
| llama-clef-flash-q4km | single | rubric | humblebrag | 81 | 0.9281 | 4 / 2 | 6 | 1/24 | 1/4 | 0/3 | 0.152810 | (0.13716991571874965, 0.16844932527715278] | 5 |
| llama-clef-flash-q4km | six-filter | rubric | humblebrag | 81 | 0.9058 | 9 / 1 | 10 | 2/24 | 2/4 | 0/3 | 0.384913 | (0.3497886690237725, 0.4200382296811883] | 7 |
| llama-clef-flash-q4km | single | rubric | doom | 84 | 0.9671 | 14 / 1 | 15 | 3/24 | 1/4 | 1/3 | 0.796637 | (0.6474496886181681, 0.9458234115040087] | 3 |
| llama-clef-flash-q4km | six-filter | rubric | doom | 84 | 0.9737 | 12 / 0 | 12 | 5/24 | 4/4 | 0/3 | 0.560927 | (0.44983151557914197, 0.6720217322620418] | 2 |
| llama-clef-flash-q4km | single | rubric | hustle | 83 | 0.9617 | 8 / 0 | 8 | 5/24 | 4/4 | 0/3 | 0.546110 | (0.5267357091572975, 0.565484802607143] | 5 |
| llama-clef-flash-q4km | six-filter | rubric | hustle | 83 | 0.9633 | 8 / 0 | 8 | 5/24 | 4/4 | 0/3 | 0.316888 | (0.24839523101091637, 0.3853808648794258] | 5 |
| llama-clef-flash-q4km | single | rubric | dunking | 79 | 0.8151 | 7 / 4 | 11 | 5/23 | 3/4 | 3/3 | 0.689263 | (0.5794382034995545, 0.7990884899896795] | 7 |
| llama-clef-flash-q4km | six-filter | rubric | dunking | 79 | 0.8803 | 9 / 4 | 13 | 5/23 | 2/4 | 3/3 | 0.350101 | (0.22822794883865508, 0.47197461203598445] | 5 |
| llama-clef-flash-q4km | single | rubric | engagement | 80 | 0.9670 | 8 / 0 | 8 | 4/24 | 2/4 | 0/3 | 0.857210 | (0.8087279905701207, 0.905691498509427] | 4 |
| llama-clef-flash-q4km | six-filter | rubric | engagement | 80 | 0.9670 | 12 / 0 | 12 | 6/24 | 4/4 | 0/3 | 0.848021 | (0.8186056712735474, 0.8774369358975599] | 4 |

Original discovery (exploratory), with the selected cutoff, fixed 0.5 and leave-one-out selection:

| Model | Operating point | Exact vectors | Correct hide/show | FH / MH | New FH / MH vs Browser |
| --- | --- | --- | --- | --- | --- |
| llama-d1-3b-q8 | frozen ≥ 0.16801175051148398 | 82/88 | 82/88 | 2 / 4 | 1 / 3 |
| llama-d1-3b-q8 | fixed ≥ 0.5 | 76/88 | 77/88 | 0 / 11 | 0 / 10 |
| llama-d1-3b-q8 | leave-one-out | 79/88 | 80/88 | 3 / 5 | 2 / 4 |
| llama-kev-4b-q8 | frozen ≥ 0.3168879112149103 | 86/88 | 87/88 | 0 / 1 | 0 / 1 |
| llama-kev-4b-q8 | fixed ≥ 0.5 | 80/88 | 85/88 | 0 / 3 | 0 / 2 |
| llama-kev-4b-q8 | leave-one-out | 84/88 | 85/88 | 2 / 1 | 1 / 1 |
| llama-clef-flash-q4km | frozen ≥ 0.1057976166900887 | 84/88 | 85/88 | 0 / 3 | 0 / 2 |
| llama-clef-flash-q4km | fixed ≥ 0.5 | 69/88 | 78/88 | 0 / 10 | 0 / 9 |
| llama-clef-flash-q4km | leave-one-out | 81/88 | 85/88 | 0 / 3 | 0 / 2 |

Original validation gates remain separate for each corpus:

| Model | Corpus | Gate | Actual | Required | Result |
| --- | --- | --- | --- | --- | --- |
| llama-d1-3b-q8 | isolation | G1: newFalseHides | 1 | ≤ 1 | PASS |
| llama-d1-3b-q8 | isolation | G2: exactVectors | 68 | ≥ 60 | PASS |
| llama-d1-3b-q8 | isolation | G3: correctHideDecisions | 70 | ≥ 68 | PASS |
| llama-d1-3b-q8 | migration | G1: newFalseHides | 1 | ≤ 1 | PASS |
| llama-d1-3b-q8 | migration | G2: exactVectors | 117 | ≥ 110 | PASS |
| llama-d1-3b-q8 | migration | G3: correctHideDecisions | 119 | ≥ 117 | PASS |
| llama-kev-4b-q8 | isolation | G1: newFalseHides | 1 | ≤ 1 | PASS |
| llama-kev-4b-q8 | isolation | G2: exactVectors | 67 | ≥ 60 | PASS |
| llama-kev-4b-q8 | isolation | G3: correctHideDecisions | 70 | ≥ 68 | PASS |
| llama-kev-4b-q8 | migration | G1: newFalseHides | 0 | ≤ 1 | PASS |
| llama-kev-4b-q8 | migration | G2: exactVectors | 119 | ≥ 110 | PASS |
| llama-kev-4b-q8 | migration | G3: correctHideDecisions | 120 | ≥ 117 | PASS |
| llama-clef-flash-q4km | isolation | G1: newFalseHides | 1 | ≤ 1 | PASS |
| llama-clef-flash-q4km | isolation | G2: exactVectors | 70 | ≥ 60 | PASS |
| llama-clef-flash-q4km | isolation | G3: correctHideDecisions | 71 | ≥ 68 | PASS |
| llama-clef-flash-q4km | migration | G1: newFalseHides | 0 | ≤ 1 | PASS |
| llama-clef-flash-q4km | migration | G2: exactVectors | 117 | ≥ 110 | PASS |
| llama-clef-flash-q4km | migration | G3: correctHideDecisions | 120 | ≥ 117 | PASS |

| Model | Corpus | Operating point | Exact vectors | Correct hide/show | FH / MH | New FH / MH vs Browser |
| --- | --- | --- | --- | --- | --- | --- |
| llama-d1-3b-q8 | isolation | frozen | 68/72 | 70/72 | 2 / 0 | 1 / 0 |
| llama-d1-3b-q8 | isolation | fixed ≥ 0.5 | 70/72 | 71/72 | 0 / 1 | 0 / 1 |
| Browser Gemma E2B | isolation | historical baseline | 60/72 | 69/72 | 2 / 1 | 0 / 0 |
| llama-d1-3b-q8 | migration | frozen | 117/120 | 119/120 | 1 / 0 | 1 / 0 |
| llama-d1-3b-q8 | migration | fixed ≥ 0.5 | 114/120 | 116/120 | 0 / 4 | 0 / 4 |
| Browser Gemma E2B | migration | historical baseline | 110/120 | 118/120 | 2 / 0 | 0 / 0 |
| Text-only QAT Gemma E2B | migration | Ollama 0.40.3; 1024 tokens | 115/120 | 119/120 | 0 / 1 | 0 / 0 |
| llama-kev-4b-q8 | isolation | frozen | 67/72 | 70/72 | 1 / 1 | 1 / 1 |
| llama-kev-4b-q8 | isolation | fixed ≥ 0.5 | 66/72 | 71/72 | 0 / 1 | 0 / 1 |
| Browser Gemma E2B | isolation | historical baseline | 60/72 | 69/72 | 2 / 1 | 0 / 0 |
| llama-kev-4b-q8 | migration | frozen | 119/120 | 120/120 | 0 / 0 | 0 / 0 |
| llama-kev-4b-q8 | migration | fixed ≥ 0.5 | 120/120 | 120/120 | 0 / 0 | 0 / 0 |
| Browser Gemma E2B | migration | historical baseline | 110/120 | 118/120 | 2 / 0 | 0 / 0 |
| Text-only QAT Gemma E2B | migration | Ollama 0.40.3; 1024 tokens | 115/120 | 119/120 | 0 / 1 | 0 / 0 |
| llama-clef-flash-q4km | isolation | frozen | 70/72 | 71/72 | 1 / 0 | 1 / 0 |
| llama-clef-flash-q4km | isolation | fixed ≥ 0.5 | 65/72 | 72/72 | 0 / 0 | 0 / 0 |
| Browser Gemma E2B | isolation | historical baseline | 60/72 | 69/72 | 2 / 1 | 0 / 0 |
| llama-clef-flash-q4km | migration | frozen | 117/120 | 120/120 | 0 / 0 | 0 / 0 |
| llama-clef-flash-q4km | migration | fixed ≥ 0.5 | 115/120 | 117/120 | 0 / 3 | 0 / 3 |
| Browser Gemma E2B | migration | historical baseline | 110/120 | 118/120 | 2 / 0 | 0 / 0 |
| Text-only QAT Gemma E2B | migration | Ollama 0.40.3; 1024 tokens | 115/120 | 119/120 | 0 / 1 | 0 / 0 |

| Model | Warm ×3 p50 / p90 ms (n) | Warm ×10 p50 / p90 ms (n) | Cold median ms | Steady RSS / footprint GiB | Peak RSS / footprint GiB | Logical / allocated disk GB | Disk scope | Identical controls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llama-d1-3b-q8 | 202.75 / 253.96 (60) | 705.87 / 873.97 (60) | 1812.74 | 3.009 / 0.278 | 3.011 / 0.282 | 2.875 / 2.886 | Primary text GGUF; projector excluded; temporary runtime cache | yes |
| llama-kev-4b-q8 | 356.43 / 489.97 (60) | 1525.08 / 1621.08 (60) | 2357.10 | 4.771 / 0.544 | 4.774 / 0.550 | 4.484 / 4.496 | Primary text GGUF; projector excluded; temporary runtime cache | yes |
| llama-clef-flash-q4km | 400.06 / 458.72 (60) | 1338.66 / 1476.76 (60) | 2052.62 | 6.625 / 0.302 | 6.625 / 0.307 | 6.733 / 6.744 | Primary text GGUF; projector excluded; temporary runtime cache | yes |

Memory is process-tree RSS and physical footprint, shown separately. Disk GB are decimal; memory GiB are binary. Capacity cold time sums explicit model loading, observed runtime settings and the first request, excluding artifact integrity hashing. Its metadata sequence differs from the older implicit-load cold measurement, so it is not a controlled comparison of cold speed. Timings describe the pinned 4096-token, one-slot serving stack and do not qualify extension lifecycle or live-feed behavior. Fresh one-pass request timings below are separate from repeated steady-state speed cells.

| Model | Mode | Style | Filter | Requests | Median ms | Median / mean input tokens | Input tokens min–max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | single | guided | all | 504 | 29.78 | 77.0 / 76.75 | 60–94 |
| llama-d1-2b-q8 | single | guided | rudeness | 84 | 29.79 | 76.0 / 76.58 | 62–92 |
| llama-d1-2b-q8 | single | guided | humblebrag | 84 | 29.78 | 77.0 / 77.58 | 63–93 |
| llama-d1-2b-q8 | single | guided | doom | 84 | 29.77 | 76.0 / 76.58 | 62–92 |
| llama-d1-2b-q8 | single | guided | hustle | 84 | 29.88 | 78.0 / 78.58 | 64–94 |
| llama-d1-2b-q8 | single | guided | dunking | 84 | 29.86 | 76.0 / 76.58 | 62–92 |
| llama-d1-2b-q8 | single | guided | engagement | 84 | 29.72 | 74.0 / 74.58 | 60–90 |
| llama-d1-2b-q8 | six-filter | guided | all | 84 | 65.34 | 302.0 / 302.58 | 288–318 |
| llama-d1-2b-q8 | single | sentence | all | 504 | 32.36 | 121.0 / 120.92 | 102–148 |
| llama-d1-2b-q8 | single | sentence | rudeness | 84 | 32.15 | 117.0 / 117.58 | 103–133 |
| llama-d1-2b-q8 | single | sentence | humblebrag | 84 | 32.57 | 124.0 / 124.58 | 110–140 |
| llama-d1-2b-q8 | single | sentence | doom | 84 | 32.45 | 117.0 / 117.58 | 103–133 |
| llama-d1-2b-q8 | single | sentence | hustle | 84 | 44.00 | 132.0 / 132.58 | 118–148 |
| llama-d1-2b-q8 | single | sentence | dunking | 84 | 32.15 | 116.0 / 116.58 | 102–132 |
| llama-d1-2b-q8 | single | sentence | engagement | 84 | 32.06 | 116.0 / 116.58 | 102–132 |
| llama-d1-2b-q8 | six-filter | sentence | all | 84 | 101.85 | 567.0 / 567.58 | 553–583 |
| llama-d1-2b-q8 | single | rubric | all | 504 | 44.95 | 165.0 / 164.08 | 132–192 |
| llama-d1-2b-q8 | single | rubric | rudeness | 84 | 45.25 | 173.0 / 173.58 | 159–189 |
| llama-d1-2b-q8 | single | rubric | humblebrag | 84 | 44.76 | 157.0 / 157.58 | 143–173 |
| llama-d1-2b-q8 | single | rubric | doom | 84 | 44.40 | 146.0 / 146.58 | 132–162 |
| llama-d1-2b-q8 | single | rubric | hustle | 84 | 44.98 | 167.0 / 167.58 | 153–183 |
| llama-d1-2b-q8 | single | rubric | dunking | 84 | 44.94 | 162.0 / 162.58 | 148–178 |
| llama-d1-2b-q8 | single | rubric | engagement | 84 | 45.10 | 176.0 / 176.58 | 162–192 |
| llama-d1-2b-q8 | six-filter | rubric | all | 84 | 145.43 | 826.0 / 826.58 | 812–842 |
| llama-d1-3b-q8 | single | short | all | 504 | 51.84 | 79.0 / 79.25 | 64–96 |
| llama-d1-3b-q8 | single | short | rudeness | 84 | 51.84 | 78.0 / 78.58 | 64–94 |
| llama-d1-3b-q8 | single | short | humblebrag | 84 | 51.90 | 80.0 / 80.58 | 66–96 |
| llama-d1-3b-q8 | single | short | doom | 84 | 51.92 | 79.0 / 79.58 | 65–95 |
| llama-d1-3b-q8 | single | short | hustle | 84 | 52.36 | 79.0 / 79.58 | 65–95 |
| llama-d1-3b-q8 | single | short | dunking | 84 | 51.99 | 78.0 / 78.58 | 64–94 |
| llama-d1-3b-q8 | single | short | engagement | 84 | 50.51 | 78.0 / 78.58 | 64–94 |
| llama-d1-3b-q8 | six-filter | short | all | 84 | 291.20 | 472.0 / 475.50 | 388–568 |
| llama-d1-3b-q8 | single | guided | all | 504 | 53.50 | 86.0 / 85.75 | 69–103 |
| llama-d1-3b-q8 | single | guided | rudeness | 84 | 53.13 | 85.0 / 85.58 | 71–101 |
| llama-d1-3b-q8 | single | guided | humblebrag | 84 | 53.77 | 86.0 / 86.58 | 72–102 |
| llama-d1-3b-q8 | single | guided | doom | 84 | 53.20 | 85.0 / 85.58 | 71–101 |
| llama-d1-3b-q8 | single | guided | hustle | 84 | 53.67 | 87.0 / 87.58 | 73–103 |
| llama-d1-3b-q8 | single | guided | dunking | 84 | 53.65 | 85.0 / 85.58 | 71–101 |
| llama-d1-3b-q8 | single | guided | engagement | 84 | 53.29 | 83.0 / 83.58 | 69–99 |
| llama-d1-3b-q8 | six-filter | guided | all | 84 | 301.66 | 511.0 / 514.50 | 427–607 |
| llama-d1-3b-q8 | single | rubric | all | 504 | 86.18 | 173.0 / 172.08 | 140–200 |
| llama-d1-3b-q8 | single | rubric | rudeness | 84 | 84.92 | 181.0 / 181.58 | 167–197 |
| llama-d1-3b-q8 | single | rubric | humblebrag | 84 | 85.59 | 165.0 / 165.58 | 151–181 |
| llama-d1-3b-q8 | single | rubric | doom | 84 | 85.71 | 154.0 / 154.58 | 140–170 |
| llama-d1-3b-q8 | single | rubric | hustle | 84 | 87.18 | 175.0 / 175.58 | 161–191 |
| llama-d1-3b-q8 | single | rubric | dunking | 84 | 85.74 | 170.0 / 170.58 | 156–186 |
| llama-d1-3b-q8 | single | rubric | engagement | 84 | 88.07 | 184.0 / 184.58 | 170–200 |
| llama-d1-3b-q8 | six-filter | rubric | all | 84 | 512.29 | 1029.0 / 1032.50 | 945–1125 |
| llama-kev-4b-q8 | single | short | all | 504 | 93.65 | 68.0 / 68.85 | 51–86 |
| llama-kev-4b-q8 | single | short | rudeness | 84 | 93.46 | 68.0 / 68.68 | 52–85 |
| llama-kev-4b-q8 | single | short | humblebrag | 84 | 94.55 | 69.0 / 69.68 | 53–86 |
| llama-kev-4b-q8 | single | short | doom | 84 | 93.45 | 68.0 / 68.68 | 52–85 |
| llama-kev-4b-q8 | single | short | hustle | 84 | 93.10 | 69.0 / 69.68 | 53–86 |
| llama-kev-4b-q8 | single | short | dunking | 84 | 93.04 | 68.0 / 68.68 | 52–85 |
| llama-kev-4b-q8 | single | short | engagement | 84 | 93.59 | 67.0 / 67.68 | 51–84 |
| llama-kev-4b-q8 | six-filter | short | all | 84 | 536.08 | 409.0 / 413.07 | 313–511 |
| llama-kev-4b-q8 | single | guided | all | 504 | 95.77 | 75.0 / 75.18 | 56–94 |
| llama-kev-4b-q8 | single | guided | rudeness | 84 | 94.79 | 75.0 / 75.68 | 59–92 |
| llama-kev-4b-q8 | single | guided | humblebrag | 84 | 96.29 | 75.0 / 75.68 | 59–92 |
| llama-kev-4b-q8 | single | guided | doom | 84 | 95.57 | 74.0 / 74.68 | 58–91 |
| llama-kev-4b-q8 | single | guided | hustle | 84 | 97.59 | 77.0 / 77.68 | 61–94 |
| llama-kev-4b-q8 | single | guided | dunking | 84 | 94.93 | 74.0 / 74.68 | 58–91 |
| llama-kev-4b-q8 | single | guided | engagement | 84 | 96.10 | 72.0 / 72.68 | 56–89 |
| llama-kev-4b-q8 | six-filter | guided | all | 84 | 547.36 | 447.0 / 451.07 | 351–549 |
| llama-kev-4b-q8 | single | rubric | all | 504 | 148.18 | 159.0 / 157.85 | 124–187 |
| llama-kev-4b-q8 | single | rubric | rudeness | 84 | 148.44 | 165.0 / 165.68 | 149–182 |
| llama-kev-4b-q8 | single | rubric | humblebrag | 84 | 145.05 | 153.0 / 153.68 | 137–170 |
| llama-kev-4b-q8 | single | rubric | doom | 84 | 142.61 | 140.0 / 140.68 | 124–157 |
| llama-kev-4b-q8 | single | rubric | hustle | 84 | 147.19 | 162.0 / 162.68 | 146–179 |
| llama-kev-4b-q8 | single | rubric | dunking | 84 | 147.95 | 153.0 / 153.68 | 137–170 |
| llama-kev-4b-q8 | single | rubric | engagement | 84 | 150.69 | 170.0 / 170.68 | 154–187 |
| llama-kev-4b-q8 | six-filter | rubric | all | 84 | 893.54 | 943.0 / 947.07 | 847–1045 |
| llama-clef-flash-q4km | single | short | all | 504 | 264.89 | 196.0 / 196.85 | 179–214 |
| llama-clef-flash-q4km | single | short | rudeness | 84 | 265.53 | 196.0 / 196.68 | 180–213 |
| llama-clef-flash-q4km | single | short | humblebrag | 84 | 268.86 | 197.0 / 197.68 | 181–214 |
| llama-clef-flash-q4km | single | short | doom | 84 | 262.73 | 196.0 / 196.68 | 180–213 |
| llama-clef-flash-q4km | single | short | hustle | 84 | 264.84 | 197.0 / 197.68 | 181–214 |
| llama-clef-flash-q4km | single | short | dunking | 84 | 269.78 | 196.0 / 196.68 | 180–213 |
| llama-clef-flash-q4km | single | short | engagement | 84 | 263.88 | 195.0 / 195.68 | 179–212 |
| llama-clef-flash-q4km | six-filter | short | all | 84 | 797.38 | 742.0 / 742.68 | 726–759 |
| llama-clef-flash-q4km | single | guided | all | 504 | 266.49 | 203.0 / 203.18 | 184–222 |
| llama-clef-flash-q4km | single | guided | rudeness | 84 | 266.44 | 203.0 / 203.68 | 187–220 |
| llama-clef-flash-q4km | single | guided | humblebrag | 84 | 267.94 | 203.0 / 203.68 | 187–220 |
| llama-clef-flash-q4km | single | guided | doom | 84 | 266.47 | 202.0 / 202.68 | 186–219 |
| llama-clef-flash-q4km | single | guided | hustle | 84 | 269.49 | 205.0 / 205.68 | 189–222 |
| llama-clef-flash-q4km | single | guided | dunking | 84 | 261.68 | 202.0 / 202.68 | 186–219 |
| llama-clef-flash-q4km | single | guided | engagement | 84 | 266.38 | 200.0 / 200.68 | 184–217 |
| llama-clef-flash-q4km | six-filter | guided | all | 84 | 908.12 | 780.0 / 780.68 | 764–797 |
| llama-clef-flash-q4km | single | rubric | all | 504 | 388.18 | 287.0 / 285.85 | 252–315 |
| llama-clef-flash-q4km | single | rubric | rudeness | 84 | 393.45 | 293.0 / 293.68 | 277–310 |
| llama-clef-flash-q4km | single | rubric | humblebrag | 84 | 386.73 | 281.0 / 281.68 | 265–298 |
| llama-clef-flash-q4km | single | rubric | doom | 84 | 388.02 | 268.0 / 268.68 | 252–285 |
| llama-clef-flash-q4km | single | rubric | hustle | 84 | 387.42 | 290.0 / 290.68 | 274–307 |
| llama-clef-flash-q4km | single | rubric | dunking | 84 | 387.81 | 281.0 / 281.68 | 265–298 |
| llama-clef-flash-q4km | single | rubric | engagement | 84 | 391.32 | 298.0 / 298.68 | 282–315 |
| llama-clef-flash-q4km | six-filter | rubric | all | 84 | 1362.60 | 1276.0 / 1276.68 | 1260–1293 |

Single-versus-six-filter interference, including ambiguous pairs only in the explicitly named secondary population:

| Model | Style | Filter | Population | n | Median / worst absolute Δ | Flips |
| --- | --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | guided | all | headline | 482 | 0.012474 / 0.339845 | 28 |
| llama-d1-2b-q8 | guided | all | allIncludingAmbiguous | 504 | 0.012776 / 0.339845 | 28 |
| llama-d1-2b-q8 | guided | rudeness | headline | 75 | 0.012416 / 0.133287 | 4 |
| llama-d1-2b-q8 | guided | rudeness | allIncludingAmbiguous | 84 | 0.011933 / 0.133287 | 4 |
| llama-d1-2b-q8 | guided | humblebrag | headline | 81 | 0.021668 / 0.095626 | 4 |
| llama-d1-2b-q8 | guided | humblebrag | allIncludingAmbiguous | 84 | 0.021628 / 0.124682 | 4 |
| llama-d1-2b-q8 | guided | doom | headline | 84 | 0.008359 / 0.199622 | 3 |
| llama-d1-2b-q8 | guided | doom | allIncludingAmbiguous | 84 | 0.008359 / 0.199622 | 3 |
| llama-d1-2b-q8 | guided | hustle | headline | 83 | 0.026157 / 0.339845 | 7 |
| llama-d1-2b-q8 | guided | hustle | allIncludingAmbiguous | 84 | 0.027350 / 0.339845 | 7 |
| llama-d1-2b-q8 | guided | dunking | headline | 79 | 0.014829 / 0.135914 | 6 |
| llama-d1-2b-q8 | guided | dunking | allIncludingAmbiguous | 84 | 0.015968 / 0.135914 | 6 |
| llama-d1-2b-q8 | guided | engagement | headline | 80 | 0.004613 / 0.248853 | 4 |
| llama-d1-2b-q8 | guided | engagement | allIncludingAmbiguous | 84 | 0.005081 / 0.248853 | 4 |
| llama-d1-2b-q8 | sentence | all | headline | 482 | 0.022641 / 0.397300 | 38 |
| llama-d1-2b-q8 | sentence | all | allIncludingAmbiguous | 504 | 0.023190 / 0.397300 | 41 |
| llama-d1-2b-q8 | sentence | rudeness | headline | 75 | 0.029283 / 0.122218 | 6 |
| llama-d1-2b-q8 | sentence | rudeness | allIncludingAmbiguous | 84 | 0.028308 / 0.122218 | 6 |
| llama-d1-2b-q8 | sentence | humblebrag | headline | 81 | 0.025702 / 0.195437 | 10 |
| llama-d1-2b-q8 | sentence | humblebrag | allIncludingAmbiguous | 84 | 0.026147 / 0.195437 | 10 |
| llama-d1-2b-q8 | sentence | doom | headline | 84 | 0.013338 / 0.254022 | 5 |
| llama-d1-2b-q8 | sentence | doom | allIncludingAmbiguous | 84 | 0.013338 / 0.254022 | 5 |
| llama-d1-2b-q8 | sentence | hustle | headline | 83 | 0.037524 / 0.397300 | 7 |
| llama-d1-2b-q8 | sentence | hustle | allIncludingAmbiguous | 84 | 0.038252 / 0.397300 | 8 |
| llama-d1-2b-q8 | sentence | dunking | headline | 79 | 0.024197 / 0.309932 | 7 |
| llama-d1-2b-q8 | sentence | dunking | allIncludingAmbiguous | 84 | 0.024537 / 0.309932 | 8 |
| llama-d1-2b-q8 | sentence | engagement | headline | 80 | 0.014074 / 0.352265 | 3 |
| llama-d1-2b-q8 | sentence | engagement | allIncludingAmbiguous | 84 | 0.014971 / 0.352265 | 4 |
| llama-d1-2b-q8 | rubric | all | headline | 482 | 0.040945 / 0.342607 | 48 |
| llama-d1-2b-q8 | rubric | all | allIncludingAmbiguous | 504 | 0.044258 / 0.342607 | 51 |
| llama-d1-2b-q8 | rubric | rudeness | headline | 75 | 0.028699 / 0.174901 | 7 |
| llama-d1-2b-q8 | rubric | rudeness | allIncludingAmbiguous | 84 | 0.030801 / 0.174901 | 7 |
| llama-d1-2b-q8 | rubric | humblebrag | headline | 81 | 0.048054 / 0.250343 | 7 |
| llama-d1-2b-q8 | rubric | humblebrag | allIncludingAmbiguous | 84 | 0.048101 / 0.250343 | 7 |
| llama-d1-2b-q8 | rubric | doom | headline | 84 | 0.027583 / 0.247263 | 8 |
| llama-d1-2b-q8 | rubric | doom | allIncludingAmbiguous | 84 | 0.027583 / 0.247263 | 8 |
| llama-d1-2b-q8 | rubric | hustle | headline | 83 | 0.058499 / 0.342607 | 16 |
| llama-d1-2b-q8 | rubric | hustle | allIncludingAmbiguous | 84 | 0.060031 / 0.342607 | 16 |
| llama-d1-2b-q8 | rubric | dunking | headline | 79 | 0.051261 / 0.325003 | 6 |
| llama-d1-2b-q8 | rubric | dunking | allIncludingAmbiguous | 84 | 0.053756 / 0.325003 | 8 |
| llama-d1-2b-q8 | rubric | engagement | headline | 80 | 0.042530 / 0.283232 | 4 |
| llama-d1-2b-q8 | rubric | engagement | allIncludingAmbiguous | 84 | 0.047206 / 0.283232 | 5 |
| llama-d1-3b-q8 | short | all | headline | 482 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | all | allIncludingAmbiguous | 504 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | rudeness | headline | 75 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | rudeness | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | humblebrag | headline | 81 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | humblebrag | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | doom | headline | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | doom | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | hustle | headline | 83 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | hustle | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | dunking | headline | 79 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | dunking | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | engagement | headline | 80 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | short | engagement | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | all | headline | 482 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | all | allIncludingAmbiguous | 504 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | rudeness | headline | 75 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | rudeness | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | humblebrag | headline | 81 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | humblebrag | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | doom | headline | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | doom | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | hustle | headline | 83 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | hustle | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | dunking | headline | 79 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | dunking | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | engagement | headline | 80 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | guided | engagement | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | all | headline | 482 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | all | allIncludingAmbiguous | 504 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | rudeness | headline | 75 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | rudeness | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | humblebrag | headline | 81 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | humblebrag | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | doom | headline | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | doom | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | hustle | headline | 83 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | hustle | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | dunking | headline | 79 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | dunking | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | engagement | headline | 80 | 0.000000 / 0.000000 | 0 |
| llama-d1-3b-q8 | rubric | engagement | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | all | headline | 482 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | all | allIncludingAmbiguous | 504 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | rudeness | headline | 75 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | rudeness | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | humblebrag | headline | 81 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | humblebrag | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | doom | headline | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | doom | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | hustle | headline | 83 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | hustle | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | dunking | headline | 79 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | dunking | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | engagement | headline | 80 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | short | engagement | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | all | headline | 482 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | all | allIncludingAmbiguous | 504 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | rudeness | headline | 75 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | rudeness | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | humblebrag | headline | 81 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | humblebrag | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | doom | headline | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | doom | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | hustle | headline | 83 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | hustle | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | dunking | headline | 79 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | dunking | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | engagement | headline | 80 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | guided | engagement | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | all | headline | 482 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | all | allIncludingAmbiguous | 504 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | rudeness | headline | 75 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | rudeness | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | humblebrag | headline | 81 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | humblebrag | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | doom | headline | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | doom | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | hustle | headline | 83 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | hustle | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | dunking | headline | 79 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | dunking | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | engagement | headline | 80 | 0.000000 / 0.000000 | 0 |
| llama-kev-4b-q8 | rubric | engagement | allIncludingAmbiguous | 84 | 0.000000 / 0.000000 | 0 |
| llama-clef-flash-q4km | short | all | headline | 482 | 0.012381 / 0.734628 | 67 |
| llama-clef-flash-q4km | short | all | allIncludingAmbiguous | 504 | 0.013079 / 0.734628 | 72 |
| llama-clef-flash-q4km | short | rudeness | headline | 75 | 0.006757 / 0.230486 | 7 |
| llama-clef-flash-q4km | short | rudeness | allIncludingAmbiguous | 84 | 0.007854 / 0.230486 | 9 |
| llama-clef-flash-q4km | short | humblebrag | headline | 81 | 0.008240 / 0.274874 | 10 |
| llama-clef-flash-q4km | short | humblebrag | allIncludingAmbiguous | 84 | 0.009395 / 0.274874 | 11 |
| llama-clef-flash-q4km | short | doom | headline | 84 | 0.056220 / 0.734628 | 25 |
| llama-clef-flash-q4km | short | doom | allIncludingAmbiguous | 84 | 0.056220 / 0.734628 | 25 |
| llama-clef-flash-q4km | short | hustle | headline | 83 | 0.008227 / 0.207906 | 3 |
| llama-clef-flash-q4km | short | hustle | allIncludingAmbiguous | 84 | 0.008351 / 0.207906 | 3 |
| llama-clef-flash-q4km | short | dunking | headline | 79 | 0.012221 / 0.449718 | 13 |
| llama-clef-flash-q4km | short | dunking | allIncludingAmbiguous | 84 | 0.014814 / 0.449718 | 15 |
| llama-clef-flash-q4km | short | engagement | headline | 80 | 0.011201 / 0.466732 | 9 |
| llama-clef-flash-q4km | short | engagement | allIncludingAmbiguous | 84 | 0.011783 / 0.466732 | 9 |
| llama-clef-flash-q4km | guided | all | headline | 482 | 0.006350 / 0.502783 | 32 |
| llama-clef-flash-q4km | guided | all | allIncludingAmbiguous | 504 | 0.006673 / 0.502783 | 41 |
| llama-clef-flash-q4km | guided | rudeness | headline | 75 | 0.025767 / 0.212040 | 9 |
| llama-clef-flash-q4km | guided | rudeness | allIncludingAmbiguous | 84 | 0.028513 / 0.212040 | 13 |
| llama-clef-flash-q4km | guided | humblebrag | headline | 81 | 0.004790 / 0.251311 | 10 |
| llama-clef-flash-q4km | guided | humblebrag | allIncludingAmbiguous | 84 | 0.004807 / 0.251311 | 11 |
| llama-clef-flash-q4km | guided | doom | headline | 84 | 0.004852 / 0.304672 | 3 |
| llama-clef-flash-q4km | guided | doom | allIncludingAmbiguous | 84 | 0.004852 / 0.304672 | 3 |
| llama-clef-flash-q4km | guided | hustle | headline | 83 | 0.007779 / 0.280060 | 0 |
| llama-clef-flash-q4km | guided | hustle | allIncludingAmbiguous | 84 | 0.007884 / 0.280060 | 1 |
| llama-clef-flash-q4km | guided | dunking | headline | 79 | 0.004726 / 0.174208 | 6 |
| llama-clef-flash-q4km | guided | dunking | allIncludingAmbiguous | 84 | 0.004865 / 0.198846 | 7 |
| llama-clef-flash-q4km | guided | engagement | headline | 80 | 0.005882 / 0.502783 | 4 |
| llama-clef-flash-q4km | guided | engagement | allIncludingAmbiguous | 84 | 0.005882 / 0.502783 | 6 |
| llama-clef-flash-q4km | rubric | all | headline | 482 | 0.009539 / 0.790048 | 40 |
| llama-clef-flash-q4km | rubric | all | allIncludingAmbiguous | 504 | 0.010225 / 0.790048 | 49 |
| llama-clef-flash-q4km | rubric | rudeness | headline | 75 | 0.017152 / 0.206087 | 9 |
| llama-clef-flash-q4km | rubric | rudeness | allIncludingAmbiguous | 84 | 0.019204 / 0.206087 | 14 |
| llama-clef-flash-q4km | rubric | humblebrag | headline | 81 | 0.007548 / 0.330970 | 8 |
| llama-clef-flash-q4km | rubric | humblebrag | allIncludingAmbiguous | 84 | 0.007582 / 0.330970 | 10 |
| llama-clef-flash-q4km | rubric | doom | headline | 84 | 0.010321 / 0.487076 | 9 |
| llama-clef-flash-q4km | rubric | doom | allIncludingAmbiguous | 84 | 0.010321 / 0.487076 | 9 |
| llama-clef-flash-q4km | rubric | hustle | headline | 83 | 0.006491 / 0.420958 | 2 |
| llama-clef-flash-q4km | rubric | hustle | allIncludingAmbiguous | 84 | 0.006839 / 0.468081 | 3 |
| llama-clef-flash-q4km | rubric | dunking | headline | 79 | 0.007973 / 0.534902 | 6 |
| llama-clef-flash-q4km | rubric | dunking | allIncludingAmbiguous | 84 | 0.008697 / 0.534902 | 7 |
| llama-clef-flash-q4km | rubric | engagement | headline | 80 | 0.009548 / 0.790048 | 6 |
| llama-clef-flash-q4km | rubric | engagement | allIncludingAmbiguous | 84 | 0.010454 / 0.790048 | 6 |

Own-filter bounced-post checks use positive posts with their single-filter label:

| Model | Style | Filter | Bounced positives | Caught | Missed | Subtle missed |
| --- | --- | --- | --- | --- | --- | --- |
| llama-d1-2b-q8 | guided | all | 48 | 28 | 20 | 12 |
| llama-d1-2b-q8 | guided | rudeness | 8 | 5 | 3 | 3 |
| llama-d1-2b-q8 | guided | humblebrag | 8 | 3 | 5 | 2 |
| llama-d1-2b-q8 | guided | doom | 8 | 5 | 3 | 2 |
| llama-d1-2b-q8 | guided | hustle | 8 | 6 | 2 | 1 |
| llama-d1-2b-q8 | guided | dunking | 8 | 5 | 3 | 2 |
| llama-d1-2b-q8 | guided | engagement | 8 | 4 | 4 | 2 |
| llama-d1-2b-q8 | sentence | all | 48 | 29 | 19 | 12 |
| llama-d1-2b-q8 | sentence | rudeness | 8 | 5 | 3 | 3 |
| llama-d1-2b-q8 | sentence | humblebrag | 8 | 4 | 4 | 1 |
| llama-d1-2b-q8 | sentence | doom | 8 | 5 | 3 | 3 |
| llama-d1-2b-q8 | sentence | hustle | 8 | 6 | 2 | 1 |
| llama-d1-2b-q8 | sentence | dunking | 8 | 6 | 2 | 2 |
| llama-d1-2b-q8 | sentence | engagement | 8 | 3 | 5 | 2 |
| llama-d1-2b-q8 | rubric | all | 48 | 44 | 4 | 4 |
| llama-d1-2b-q8 | rubric | rudeness | 8 | 7 | 1 | 1 |
| llama-d1-2b-q8 | rubric | humblebrag | 8 | 8 | 0 | 0 |
| llama-d1-2b-q8 | rubric | doom | 8 | 7 | 1 | 1 |
| llama-d1-2b-q8 | rubric | hustle | 8 | 8 | 0 | 0 |
| llama-d1-2b-q8 | rubric | dunking | 8 | 6 | 2 | 2 |
| llama-d1-2b-q8 | rubric | engagement | 8 | 8 | 0 | 0 |
| llama-d1-3b-q8 | short | all | 48 | 28 | 20 | 9 |
| llama-d1-3b-q8 | short | rudeness | 8 | 3 | 5 | 3 |
| llama-d1-3b-q8 | short | humblebrag | 8 | 3 | 5 | 1 |
| llama-d1-3b-q8 | short | doom | 8 | 6 | 2 | 2 |
| llama-d1-3b-q8 | short | hustle | 8 | 7 | 1 | 1 |
| llama-d1-3b-q8 | short | dunking | 8 | 1 | 7 | 2 |
| llama-d1-3b-q8 | short | engagement | 8 | 8 | 0 | 0 |
| llama-d1-3b-q8 | guided | all | 48 | 27 | 21 | 12 |
| llama-d1-3b-q8 | guided | rudeness | 8 | 4 | 4 | 3 |
| llama-d1-3b-q8 | guided | humblebrag | 8 | 0 | 8 | 3 |
| llama-d1-3b-q8 | guided | doom | 8 | 6 | 2 | 2 |
| llama-d1-3b-q8 | guided | hustle | 8 | 5 | 3 | 2 |
| llama-d1-3b-q8 | guided | dunking | 8 | 5 | 3 | 2 |
| llama-d1-3b-q8 | guided | engagement | 8 | 7 | 1 | 0 |
| llama-d1-3b-q8 | rubric | all | 48 | 33 | 15 | 12 |
| llama-d1-3b-q8 | rubric | rudeness | 8 | 5 | 3 | 3 |
| llama-d1-3b-q8 | rubric | humblebrag | 8 | 3 | 5 | 2 |
| llama-d1-3b-q8 | rubric | doom | 8 | 6 | 2 | 2 |
| llama-d1-3b-q8 | rubric | hustle | 8 | 7 | 1 | 1 |
| llama-d1-3b-q8 | rubric | dunking | 8 | 5 | 3 | 3 |
| llama-d1-3b-q8 | rubric | engagement | 8 | 7 | 1 | 1 |
| llama-kev-4b-q8 | short | all | 48 | 39 | 9 | 7 |
| llama-kev-4b-q8 | short | rudeness | 8 | 6 | 2 | 2 |
| llama-kev-4b-q8 | short | humblebrag | 8 | 6 | 2 | 1 |
| llama-kev-4b-q8 | short | doom | 8 | 8 | 0 | 0 |
| llama-kev-4b-q8 | short | hustle | 8 | 7 | 1 | 1 |
| llama-kev-4b-q8 | short | dunking | 8 | 5 | 3 | 2 |
| llama-kev-4b-q8 | short | engagement | 8 | 7 | 1 | 1 |
| llama-kev-4b-q8 | guided | all | 48 | 33 | 15 | 10 |
| llama-kev-4b-q8 | guided | rudeness | 8 | 6 | 2 | 2 |
| llama-kev-4b-q8 | guided | humblebrag | 8 | 2 | 6 | 2 |
| llama-kev-4b-q8 | guided | doom | 8 | 5 | 3 | 3 |
| llama-kev-4b-q8 | guided | hustle | 8 | 6 | 2 | 1 |
| llama-kev-4b-q8 | guided | dunking | 8 | 7 | 1 | 1 |
| llama-kev-4b-q8 | guided | engagement | 8 | 7 | 1 | 1 |
| llama-kev-4b-q8 | rubric | all | 48 | 43 | 5 | 4 |
| llama-kev-4b-q8 | rubric | rudeness | 8 | 7 | 1 | 1 |
| llama-kev-4b-q8 | rubric | humblebrag | 8 | 8 | 0 | 0 |
| llama-kev-4b-q8 | rubric | doom | 8 | 7 | 1 | 1 |
| llama-kev-4b-q8 | rubric | hustle | 8 | 6 | 2 | 1 |
| llama-kev-4b-q8 | rubric | dunking | 8 | 7 | 1 | 1 |
| llama-kev-4b-q8 | rubric | engagement | 8 | 8 | 0 | 0 |
| llama-clef-flash-q4km | short | all | 48 | 33 | 15 | 9 |
| llama-clef-flash-q4km | short | rudeness | 8 | 4 | 4 | 3 |
| llama-clef-flash-q4km | short | humblebrag | 8 | 5 | 3 | 1 |
| llama-clef-flash-q4km | short | doom | 8 | 6 | 2 | 2 |
| llama-clef-flash-q4km | short | hustle | 8 | 8 | 0 | 0 |
| llama-clef-flash-q4km | short | dunking | 8 | 2 | 6 | 3 |
| llama-clef-flash-q4km | short | engagement | 8 | 8 | 0 | 0 |
| llama-clef-flash-q4km | guided | all | 48 | 35 | 13 | 8 |
| llama-clef-flash-q4km | guided | rudeness | 8 | 5 | 3 | 1 |
| llama-clef-flash-q4km | guided | humblebrag | 8 | 5 | 3 | 1 |
| llama-clef-flash-q4km | guided | doom | 8 | 6 | 2 | 2 |
| llama-clef-flash-q4km | guided | hustle | 8 | 7 | 1 | 1 |
| llama-clef-flash-q4km | guided | dunking | 8 | 6 | 2 | 2 |
| llama-clef-flash-q4km | guided | engagement | 8 | 6 | 2 | 1 |
| llama-clef-flash-q4km | rubric | all | 48 | 38 | 10 | 5 |
| llama-clef-flash-q4km | rubric | rudeness | 8 | 5 | 3 | 1 |
| llama-clef-flash-q4km | rubric | humblebrag | 8 | 6 | 2 | 0 |
| llama-clef-flash-q4km | rubric | doom | 8 | 7 | 1 | 1 |
| llama-clef-flash-q4km | rubric | hustle | 8 | 8 | 0 | 0 |
| llama-clef-flash-q4km | rubric | dunking | 8 | 4 | 4 | 3 |
| llama-clef-flash-q4km | rubric | engagement | 8 | 8 | 0 | 0 |

The [complete summary](data/decision-capacity-summary.json) retains per-filter best-cutoff diagnostics, every interference flip and the full text of every missed bounced post. Best cutoffs are descriptive and never replace the frozen cutoff. Raw fresh receipts: llama-d1-2b-q8 [receipt](data/decision-capacity-fresh-llama-d1-2b-q8.json); llama-d1-3b-q8 [receipt](data/decision-capacity-fresh-llama-d1-3b-q8.json); llama-kev-4b-q8 [receipt](data/decision-capacity-fresh-llama-kev-4b-q8.json); llama-clef-flash-q4km [receipt](data/decision-capacity-fresh-llama-clef-flash-q4km.json).

The original evidence is unchanged. [Registration/result](data/decision-capacity-result.json), [summary](data/decision-capacity-summary.json) and [raw archive descriptor](data/decision-capacity-archive.json) are hash-bound. Result SHA-256: `b45b8f49c48cc34772121375e51df1d2f40562fb3a4395227bcccc95ad3a3e9e`; registration SHA-256: `a8d08122d5c1a95f27b11289cb243aac94de6aa84686295a0e0e134ae72c9b9e`. The renderer reads recorded JSON, verifies provenance and checks aggregate/gate algebra; it performs no inference, scoring or optimization.


Regenerate with `node scripts/decision-eval/report.mjs`; strict mode requires all registry variants and three speed receipts each. `--partial` leaves missing evidence pending while rejecting inconsistent available provenance. This renderer checks hashes and frozen bindings; runtime/response validation belongs to the runner and its tests.

To add a future model, add an explicit registry entry and run `node scripts/decision-eval/run.mjs all <id>`. The command prepares the artifact, runs discovery, freezes selection and records three speed repetitions. Omit `<id>` for the full rotated matrix. Model execution is separate from report generation.

Pinned corpus hashes:

- `eval-corpus.ts`: `4a2dacac7271704addb5c06d953021b8c8c7f20108cfa002ce11942a6e907214`
- `native-benchmark-corpus.ts`: `a5db3bf30aa3039a3e571020c111797e1cfdd675872514a40139e66db6038603`
- `native-isolation-holdout.json`: `18841a6609d9e68493c629880bc03eeaa233eab890245e5cfd5c2eaa9e9d4159`
- `native-migration-validation.json`: `354e80566fdf889e213aec9072387c42f8286a48347379b1142073cba3fa4e27`

## Tone label study findings

This study asked why a rudeness filter hides harmless posts, and whether label wording, the question template or a label-agnostic rule can fix it. It used two independently authored synthetic splits (discovery and holdout, 112 posts each, slurs masked), gold for 18 filter intents confirmed by two blind labelers, and a holdout registered before inference and run once.

- **Vocabulary, not acts.** Under the typed label, posts that swear at things, criticise rudeness, quote an insult to object to it or tease friends were hidden at rates of 60 to 100%. The same posts rewritten without the rude-sounding words were rarely hidden: 16 of 23 originals against 1 of 23 rewrites on discovery, and 16 against 3 on the holdout. Sarcastic contempt without rude words was mostly missed.
- **Almost no words of their own.** Mean scores on five content-free inputs ranged from 0.11 to 0.36 across labels, at or above the general cutoff for some, and changing only the @handle of a short reply moved its typed-label score by up to about 0.28 (0.36 when the variant with no handle is included).
- **Wording and templates.** Thirteen wordings made 27 to 31 errors on the 112 discovery posts; pooled over both splits, no tested wording beat the label as typed (54 errors against 54 to 57). Three of four alternative templates ranked posts almost identically (Spearman 0.94 to 0.99); the fourth agreed less (0.74) and was worse.
- **Stricter cutoffs trade errors.** A uniform 0.72 cutoff cut the owner label's false hides on the holdout from 21 to 3 but raised misses from 6 to 12, three of them slur posts, and missed 30 topic decisions on the earlier validation set. It is not adopted.
- **Short-post rule adopted.** Requiring 0.70 for posts with at most three own words passed every registered gate: tone-holdout errors fell from 231 to 177 with no added misses, and the owner label was unchanged. The earlier validation and behaviour corpora contain no posts with three or fewer own words, so they could not show an effect; short topical posts were thinly covered (one scored positive decision in the holdout; a second was excluded as ambiguous). The extension now applies it.

<!-- tone-label-study:start -->
## Tone label study

Single-filter decisions; ambiguous pairs excluded. Discovery cutoffs are exploratory. Holdout uses the registered cutoffs and gates.

**Discovery**

| Wording | Label | n | Errors | FP / FN | AUC | Best cutoff / errors |
| --- | --- | --- | --- | --- | --- | --- |
| W0 | performative rudeness that are execessive like unnecessary usage of slurs | 112 | 27 | 19 / 8 | 0.8422 | 0.7151 / 20 |
| W1 | performative rudeness that are excessive like unnecessary usage of slurs | 112 | 27 | 19 / 8 | 0.8383 | 0.7049 / 20 |
| W2 | excessive rudeness | 112 | 31 | 23 / 8 | 0.8086 | 0.5777 / 22 |
| W3 | rude posts | 112 | 31 | 24 / 7 | 0.8086 | 0.6860 / 23 |
| W4 | posts being deliberately rude or edgy to get attention | 112 | 30 | 24 / 6 | 0.8355 | 0.7390 / 19 |
| W5 | posts insulting people or using slurs | 112 | 28 | 20 / 8 | 0.8355 | 0.6526 / 19 |
| W6 | posts that insult someone or use slurs | 112 | 29 | 20 / 9 | 0.8340 | 0.6084 / 19 |
| W7 | insults, slurs and name-calling aimed at people | 112 | 28 | 21 / 7 | 0.8266 | 0.7261 / 20 |
| W8 | posts where the author insults people or uses slurs | 112 | 28 | 19 / 9 | 0.8258 | 0.7178 / 20 |
| W9 | slurs or insults | 112 | 30 | 22 / 8 | 0.8219 | 0.8972 / 21 |
| W10 | posts with slurs | 112 | 30 | 20 / 10 | 0.8137 | 0.7150 / 21 |
| W11 | posts mocking or insulting people to look edgy | 112 | 27 | 20 / 7 | 0.8566 | 0.7685 / 17 |
| W12 | posts insulting or attacking a person | 112 | 28 | 19 / 9 | 0.8379 | 0.8626 / 18 |

| Policy | Template | State transform | Calibration | n | Cutoff | Errors | FP / FN | Low-content FP | Short-positive FN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | T0 | none | none | 2192 | 0.290813258948728 | 240 | 228 / 12 | 44 | 0 |
| P1 | T1 | none | none | 2192 | 0.7411908547670589 | 63 | 12 / 51 | 0 | 5 |
| P2 | T2 | none | none | 2192 | 0.6863968387955592 | 96 | 26 / 70 | 3 | 3 |
| P3 | T3 | none | none | 2192 | 0.6765923102275773 | 109 | 35 / 74 | 5 | 4 |
| P4 | T4 | none | none | 2192 | 0.7763282897323603 | 72 | 19 / 53 | 0 | 4 |
| P5 | T0 | none | content-free | 2192 | 0.9313052169208927 | 73 | 25 / 48 | 3 | 2 |
| P6 | T0 | strip-leading-mentions | none | 2192 | 0.290813258948728 | 213 | 200 / 13 | 25 | 1 |

[Discovery summary](data/decision-tone-discovery-summary.json).

Short-rule grid: saved best cutoffs for posts with at most N own words.

| N | Short cutoff | Errors | FP | FN |
| --- | --- | --- | --- | --- |
| 0 | 0.7643 | 221 | 209 | 12 |
| 1 | 0.8717 | 200 | 186 | 14 |
| 2 | 0.8717 | 190 | 176 | 14 |
| 3 | 0.8184 | 167 | 152 | 15 |
| 4 | 0.8184 | 163 | 146 | 17 |
| 5 | 0.8184 | 156 | 138 | 18 |

W0 subtype probabilities; shares use the recorded cutoff of 0.290813258948728.

| Subtype | n | Median | Share ≥ cutoff |
| --- | --- | --- | --- |
| blunt-critique | 3 | 0.0113 | 0.0000 |
| violent-slang-praise | 3 | 0.0600 | 0.0000 |
| hate-speech-news | 2 | 0.0539 | 0.0000 |
| ordinary | 8 | 0.0246 | 0.0000 |
| criticises-rudeness | 5 | 0.5034 | 0.8000 |
| angry-complaint | 3 | 0.0149 | 0.0000 |
| casual-slur | 3 | 0.6147 | 1.0000 |
| quotes-to-object | 5 | 0.5528 | 0.6000 |
| banter | 4 | 0.3680 | 0.5000 |
| death-wish | 2 | 0.3193 | 0.5000 |
| edgy-contempt | 5 | 0.1803 | 0.4000 |
| sarcastic-contempt | 4 | 0.0520 | 0.0000 |
| untargeted-profanity | 5 | 0.7066 | 1.0000 |
| name-calling | 4 | 0.7879 | 1.0000 |
| slur-insult | 4 | 0.7046 | 1.0000 |
| group-slur | 2 | 0.5920 | 1.0000 |
| word-discussion | 2 | 0.3122 | 1.0000 |
| short-rude | 8 | 0.7904 | 1.0000 |
| low-content | 18 | 0.0930 | 0.1111 |
| short-topic | 10 | 0.0329 | 0.0000 |
| short-behaviour | 6 | 0.0567 | 0.0000 |
| short-slang | 6 | 0.0620 | 0.1667 |

Source-to-twin probability drops.

| Wording | Pairs | Median source − twin |
| --- | --- | --- |
| W0 | 23 | 0.3833 |
| W5 | 23 | 0.3146 |

Handle-noise probabilities across the saved variants.

| Wording | Texts | Probability min–max | Median text range | Max text range | Texts crossing cutoff |
| --- | --- | --- | --- | --- | --- |
| W0 | 26 | 0.0123–0.9490 | 0.0773 | 0.3550 | 4 |
| W5 | 26 | 0.0041–0.9832 | 0.0586 | 0.5626 | 2 |

Template sensitivity.

| Template | n | AUC n | Spearman vs T0 | AUC |
| --- | --- | --- | --- | --- |
| T0 | 2284 | 2192 | 1.0000 | 0.9626 |
| T1 | 2284 | 2192 | 0.9810 | 0.9646 |
| T2 | 2284 | 2192 | 0.9375 | 0.9445 |
| T3 | 2284 | 2192 | 0.7389 | 0.8980 |
| T4 | 2284 | 2192 | 0.9922 | 0.9612 |

Content-free prior probabilities by intent and wording ID.

| Template | Label IDs | . | … | - | N/A | ? |
| --- | --- | --- | --- | --- | --- | --- |
| T0 | excessive-rudeness, W0 | 0.1684 | 0.2076 | 0.1088 | 0.0981 | 0.2027 |
| T0 | fresh-doom | 0.3207 | 0.3601 | 0.2507 | 0.2000 | 0.1969 |
| T0 | fresh-dunking | 0.1514 | 0.1853 | 0.1476 | 0.1102 | 0.1188 |
| T0 | fresh-engagement | 0.2817 | 0.3478 | 0.1806 | 0.2012 | 0.4167 |
| T0 | fresh-humblebrag | 0.1931 | 0.2677 | 0.1634 | 0.1559 | 0.1563 |
| T0 | fresh-hustle | 0.3793 | 0.4894 | 0.3699 | 0.2971 | 0.2774 |
| T0 | fresh-rudeness, W4 | 0.2174 | 0.2282 | 0.1912 | 0.1339 | 0.2352 |
| T0 | orig-ai | 0.2476 | 0.3368 | 0.1616 | 0.1698 | 0.1460 |
| T0 | orig-celebrity | 0.1458 | 0.2464 | 0.1071 | 0.1225 | 0.0968 |
| T0 | orig-crypto | 0.2195 | 0.3047 | 0.1727 | 0.2029 | 0.1281 |
| T0 | orig-drama | 0.1839 | 0.2361 | 0.1194 | 0.1260 | 0.1225 |
| T0 | orig-engagement | 0.2631 | 0.3225 | 0.1708 | 0.1394 | 0.2152 |
| T0 | orig-fitness | 0.2580 | 0.3827 | 0.2578 | 0.2050 | 0.1466 |
| T0 | orig-food | 0.3027 | 0.3959 | 0.2278 | 0.2274 | 0.1525 |
| T0 | orig-politics | 0.1565 | 0.2562 | 0.1312 | 0.1423 | 0.0806 |
| T0 | orig-promotion | 0.1696 | 0.2311 | 0.1358 | 0.1298 | 0.0926 |
| T0 | orig-rage | 0.1243 | 0.1698 | 0.1192 | 0.0573 | 0.1609 |
| T0 | orig-sports | 0.1802 | 0.2941 | 0.1406 | 0.1250 | 0.0947 |
| T0 | W1 | 0.1841 | 0.2245 | 0.1248 | 0.1087 | 0.2375 |
| T0 | W2 | 0.2354 | 0.2642 | 0.1523 | 0.1432 | 0.2637 |
| T0 | W3 | 0.2344 | 0.2877 | 0.1684 | 0.1359 | 0.1840 |
| T0 | W5 | 0.1494 | 0.2096 | 0.1062 | 0.1000 | 0.1022 |
| T0 | W6 | 0.1535 | 0.2004 | 0.1020 | 0.0969 | 0.0929 |
| T0 | W7 | 0.1479 | 0.1973 | 0.1005 | 0.1037 | 0.0853 |
| T0 | W8 | 0.1369 | 0.1697 | 0.0891 | 0.0678 | 0.0888 |
| T0 | W9 | 0.1745 | 0.2025 | 0.1086 | 0.1106 | 0.1077 |
| T0 | W10 | 0.1516 | 0.1983 | 0.0937 | 0.0920 | 0.0967 |
| T0 | W11 | 0.2011 | 0.2595 | 0.1754 | 0.1531 | 0.1458 |
| T0 | W12 | 0.1914 | 0.2364 | 0.1347 | 0.1170 | 0.1122 |

**Holdout**

| Wording | Label | n | Errors | FP / FN | AUC |
| --- | --- | --- | --- | --- | --- |
| W0 | performative rudeness that are execessive like unnecessary usage of slurs | 109 | 27 | 21 / 6 | 0.8681 |
| W5 | posts insulting people or using slurs | 109 | 26 | 21 / 5 | 0.8776 |
| W11 | posts mocking or insulting people to look edgy | 109 | 30 | 26 / 4 | 0.8961 |
| W12 | posts insulting or attacking a person | 109 | 28 | 23 / 5 | 0.8763 |

| Policy | Template | State transform | Calibration | n | Cutoff | Errors | FP / FN | Low-content FP | Short-positive FN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | T0 | none | none | 3060 | 0.290813258948728 | 299 | 273 / 26 | 38 | 1 |
| Q | T0 | none | none | 3060 | 0.290813258948728; ≤3 words: 0.7 | 245 | 219 / 26 | 3 | 1 |
| S | T0 | none | none | 3060 | 0.72 | 125 | 45 / 80 | 3 | 3 |

[Holdout summary](data/decision-tone-holdout-summary.json).

| Gate | Scope | Actual | Comparator | factor × ref + slack | Verdict |
| --- | --- | --- | --- | --- | --- |
| G1 fewer errors on the tone holdout, all intents | corpus:tone-holdout | 177 | <= | 0.85 × 231 + 0 = 196.35 | PASS |
| G2 bounded extra misses on the tone holdout | corpus:tone-holdout | 6 | <= | 1 × 6 + 2 = 8 | PASS |
| G3 original validation not worse | corpus:original-validation | 2 | <= | 1 × 2 + 1 = 3 | PASS |
| G4 earlier behaviour corpus not worse | corpus:fresh-behaviour | 66 | <= | 1 × 66 + 1 = 67 | PASS |
| G5 owner label errors not worse | group:excessive-rudeness | 27 | <= | 1 × 27 + 0 = 27 | PASS |
| G6 owner label at most one extra miss | group:excessive-rudeness | 6 | <= | 1 × 6 + 1 = 7 | PASS |
<!-- tone-label-study:end -->
