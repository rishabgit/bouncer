# Model weights — sources, mirrors & licenses

Bouncer downloads its model weights at runtime, client-side (WebGPU/WebLLM and LiteRT). To keep this fork working even if an upstream repo is deleted, renamed, or changed, the two models it actually ships are served from **self-hosted, revision-pinned mirrors** on Hugging Face. The mirrors are byte-for-byte copies of the upstream files; pinning each URL to a commit SHA means upstream changes can't silently alter behavior either.

**All weights are [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0).** Each mirror ships a `LICENSE` and a model card documenting the full chain.

## What the extension fetches

| Model | Engine | Mirror (pinned) | Mirrored from | Base model · license |
|---|---|---|---|---|
| Qwen 3.5 4B (default) | WebLLM | [`rishabhf/bouncer-qwen3.5-4b-mlc`](https://huggingface.co/rishabhf/bouncer-qwen3.5-4b-mlc) `@3a23198` | [`imbue/Qwen3.5-4B-q4f16_1-MLC-2`](https://huggingface.co/imbue/Qwen3.5-4B-q4f16_1-MLC-2) `@16b7d99` + WebGPU lib [`imbue-ai/binary-mlc-llm-libs`](https://github.com/imbue-ai/binary-mlc-llm-libs) `@96d72b4` | [`Qwen/Qwen3.5-4B`](https://huggingface.co/Qwen/Qwen3.5-4B) · Apache-2.0 (© Qwen Team, Alibaba) |
| Gemma 4 E4B | LiteRT | [`rishabhf/bouncer-gemma-4-e4b-litert`](https://huggingface.co/rishabhf/bouncer-gemma-4-e4b-litert) `@41a40de` | [`litert-community/gemma-4-E4B-it-litert-lm`](https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm) `@65ce5ba` (web `.litertlm` only) | [`google/gemma-4-E4B-it`](https://huggingface.co/google/gemma-4-E4B-it) · Apache-2.0 (© Google DeepMind) |

The exact pinned `…/resolve/<sha>/…` URLs live in [`Bouncer/src/shared/models.ts`](../Bouncer/src/shared/models.ts). The other models in the picker (Qwen 3 4B, Qwen 3.5 Vision) are **not** mirrored — they still fetch from their original upstreams.

> A WebLLM model is a pair: the quantized weights (HF) **plus** a compiled WebGPU kernel library (`.wasm`). The Qwen mirror co-locates both so they stay pinned together. Gemma's `.litertlm` is a single self-contained file.

## Licensing & attribution

Both base models are genuinely Apache-2.0 — including Gemma 4, whose [license page](https://ai.google.dev/gemma/docs/gemma_4_license) *is* the Apache-2.0 text (a departure from the older Gemma Terms of Use). Redistribution via these mirrors honors Apache-2.0 §4:

- the full license is included (`LICENSE`) — Qwen's mirror carries Qwen's own upstream `LICENSE`; Gemma's carries the canonical Apache-2.0 text (the Google base repo ships no license file);
- upstream copyright/attribution is retained in each mirror's model card;
- the weights are marked **unmodified** copies;
- no endorsement by the original authors is implied.

## Refreshing / re-pinning a mirror

To roll a mirror forward to a newer upstream revision:

```bash
hf download <upstream-repo> --revision <sha> --local-dir ./m   # add the .wasm for the Qwen mirror
hf upload  rishabhf/<mirror-repo> ./m . --commit-message "..."
curl -s https://huggingface.co/api/models/rishabhf/<mirror-repo>/revision/main   # -> .sha
```

Then update the `resolve/<sha>/` URL(s) in `models.ts`. Changing a URL is a one-time re-download for any browser (Cache Storage is keyed by the full URL).
