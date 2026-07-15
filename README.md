# Bouncer

<p align="center">
  <img src="Bouncer/icons/b-bouncer-2x_big.png" alt="Bouncer" width="200" />
</p>

**Heal your feed.** Bouncer is a browser extension that filters unwanted posts
from Twitter/X. Define topics such as “crypto,” “engagement bait,” or “rage
politics”; Bouncer classifies posts against them and hides matches.

> **Personal, local-only fork.** This fork of
> [imbue-ai/bouncer](https://github.com/imbue-ai/bouncer) is built for one
> user's Mac and Twitter/X feed. Classification runs on-device with Gemma 4 E2B
> through LiteRT-LM. It has no cloud inference, hosted backend, account, API
> key, model picker, custom-model path, WebLLM/Qwen path, or vision inference.

## Features

- **Natural-language filters** — describe what should leave the feed in plain language.
- **On-device classification** — post content stays in the browser; only the model artifact is downloaded.
- **One measured model** — Gemma 4 E2B is the sole production model, selected automatically.
- **Filter transparency** — hidden posts show which filter categories matched.
- **Text-only media handling** — posts with images or video are judged from their written text.
- **Theme-aware UI** — the injected interface follows X's light, dim, and dark modes.

## Production model

| Model | Engine | Input | Artifact |
|---|---|---|---:|
| Gemma 4 E2B (Instruct) | LiteRT-LM / WebGPU | Text | 2,008,432,640 bytes (1.870 GiB) |

The model downloads once into browser Cache Storage and can be deleted from the
popup. Its URL is pinned to an exact revision of
[`litert-community/gemma-4-E2B-it-litert-lm`](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm),
but the artifact has **not yet been copied to a fork-owned mirror**. See
[model source and license details](docs/models.md).

Gemma 4 E4B remains in a localhost-only development comparison harness. It is
not a product option and is not part of a two-model pipeline.

## Quick start

```bash
cd Bouncer
npm install
npm run build
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `Bouncer/` folder.
4. Open the Bouncer popup and download Gemma once.
5. Navigate to `x.com` and add filters.

Chrome on the target M5 Pro MacBook Pro is the actively measured path. Firefox
and Safari desktop build scripts remain available, but the model decision below
is based on Chrome on that machine, not a general hardware/browser matrix.

## How it works

1. A MutationObserver watches the X feed for posts.
2. The Twitter adapter extracts post text and metadata. Media bytes are not sent to the model.
3. A serial local queue processes one post at a time and batches that post's filter categories into one Gemma request.
4. A strict parser maps only well-formed verdict rows back to the requested categories.
5. Matching posts are hidden and added to **View filtered**, with the matched categories attached.
6. “Bounce this tweet” can generate short filter suggestions; malformed batch validation falls back to strict one-category checks rather than guessing.

Results are cached, so seeing the same post again does not require another
inference call.

## Why E2B

The production choice was made with counterbalanced, live Chrome runs on the
target Apple M5 Pro / 64 GB MacBook Pro. Both models used the same LiteRT
runtime, prompts, parser, and synthetic corpora.

| Metric | Gemma 4 E2B (production) | Gemma 4 E4B (dev comparator) |
|---|---:|---:|
| Artifact size | 2,008,432,640 bytes | 2,969,059,328 bytes |
| Medium post × 1 filter, hot median | 119–128 ms | 334 ms |
| Medium post × 3 filters, hot median | 213–229 ms | 536–537 ms |
| Rage-bait baseline accuracy | 95.0% | 92.5% |
| Rage-bait baseline F1 | 0.944 | 0.919 |
| Unstable / malformed classification runs | 0 / 0 | 0 / 0 |
| Ten fixture-runs across both orders | ~1.23 s | ~2.03 s |

E2B is 32.35% smaller, roughly 2.3–2.8× as fast in the common one-to-three-filter
cells, and slightly better on the narrow classification corpus. All five
suggestion fixtures passed in both orders through the actual
strict-validation/fallback flow. The tracked tables are hot-cache measurements;
an earlier exploratory pass showed a multi-second first-use shader-compilation
outlier, so first-use startup remains a live-smoke concern rather than a hot
latency guarantee.

Historical WebLLM/Qwen evidence also supported simplifying the product: the
shipped Qwen baseline scored 77.5% accuracy / 0.77 F1 with four unstable rows,
and a medium-post × 3-filter inference took about 1,170 ms. A tuned Qwen prompt
could reach 95% accuracy, so removing it is **not** a claim that Qwen is
universally inferior. It is an evidence-backed simplification for this one
text-only product and machine.

No numeric battery-life claim is supported yet: the E2B/E4B comparison ran on
AC power. The smaller download, lower storage footprint, lazy loading, and
shorter active inference time are sensible reasons to prefer E2B on a laptop,
but a controlled unplugged whole-system A/B run is still needed to quantify
energy use.

See the full [E2B decision record](docs/benchmarks/e2b-evaluation.md), the
[historical Qwen/E4B latency run](docs/benchmarks/latency.md), and the
[classification corpus history](docs/benchmarks/accuracy.md).
