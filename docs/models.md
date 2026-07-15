# Model artifact — source, pin, and license

Bouncer has one production model: **Gemma 4 E2B (Instruct)** running through
LiteRT-LM/WebGPU. There is no production WebLLM/Qwen catalog, vision model,
custom-model path, or model picker.

## Production artifact

| Field | Value |
|---|---|
| Model | Gemma 4 E2B (Instruct) |
| Runtime | LiteRT-LM |
| Source repository | [`litert-community/gemma-4-E2B-it-litert-lm`](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm) |
| Pinned revision | `9262660a1676eed6d0c477ab1a86344430854664` |
| File | `gemma-4-E2B-it-web.litertlm` |
| Size | 2,008,432,640 bytes (1.870 GiB) |
| LFS SHA-256 | `3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5` |
| Declared license | Apache-2.0 |

The exact `resolve/<revision>/...` URL lives in
[`Bouncer/src/shared/models.ts`](../Bouncer/src/shared/models.ts). Pinning the
revision prevents an upstream update from silently changing model behavior.
Changing that URL deliberately causes a fresh browser download because Cache
Storage is keyed by the full URL.

The current production URL points directly to the revision-pinned
`litert-community` repository. **It is not yet a fork-owned mirror.** The model
decision does not depend on pretending otherwise: the source revision,
artifact size, and checksum above describe exactly what the browser fetches.
Before relying on independent long-term availability, copy this exact artifact
to a fork-owned repository with its source revision, checksum, license, and a
model card, then update the pinned URL and rerun the capability checks.

The repository declares Apache-2.0 for the converted artifact and identifies
[`google/gemma-4-E2B-it`](https://huggingface.co/google/gemma-4-E2B-it) as the
base model. Preserve the license, source attribution, unmodified-artifact note,
and lack-of-endorsement notice in any future mirror.

## Development-only E4B comparator

The dev localhost harness retains Gemma 4 E4B solely to keep the production
decision reproducible:

| Field | Value |
|---|---|
| Definition | [`Bouncer/src/shared/benchmark-models.ts`](../Bouncer/src/shared/benchmark-models.ts) |
| Artifact | `rishabhf/bouncer-gemma-4-e4b-litert@41a40dee03ce6185fb76bd96294f74561bf87f89` |
| Size | 2,969,059,328 bytes (2.765 GiB) |
| Role | Dev-only benchmark comparator |

E4B is not included in the production model catalog, shown in the popup, or
loaded as part of normal filtering. Its presence in a dev entry point does not
create a two-model product pipeline.

## Retired artifacts

The old WebLLM/Qwen weights and compiled WebGPU module are no longer fetched or
bundled. Historical Qwen and E4B result pages remain in `docs/benchmarks/` so
the decision trail is auditable; those pages do not describe selectable models
in the current product.

## Updating the production pin

Treat a model URL change as a behavior change, not routine dependency churn:

1. Record the upstream repository, exact revision, filename, size, SHA-256, and license.
2. Run the counterbalanced classification, latency, and suggestion flows on the target Mac in Chrome.
3. Review suggestion text semantically; the automated checks only validate shape and self-consistency.
4. Update `models.ts`, this page, and the E2B decision record together.
5. Expect every browser profile to download the new artifact once.

The current evidence and its limitations are in
[`benchmarks/e2b-evaluation.md`](benchmarks/e2b-evaluation.md).
