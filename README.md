# Bouncer

<p align="center">
  <img src="Bouncer/icons/b-bouncer-2x_big.png" alt="Bouncer" width="200" />
</p>

**Heal your feed.** Bouncer is a browser extension that uses AI to filter unwanted posts from your Twitter/X feed. Define filter topics in plain language — "crypto", "engagement bait", "rage politics" — and Bouncer classifies and hides matching posts in real time.

> **Local-only fork.** This is a modified, local-only fork of [imbue-ai/bouncer](https://github.com/imbue-ai/bouncer) (AGPL-3.0). All cloud/remote backends have been removed — classification runs entirely on-device via WebLLM (Qwen) and LiteRT (Gemma). Build and load it from source (see [Quick Start](#quick-start)).

## Features

- **Natural language filters** — describe what you don't want to see in your own words
- **On-device only** — models run entirely in your browser via WebLLM and LiteRT (WebGPU); no accounts, no API keys, nothing sent to a server
- **Image-aware filtering** — multimodal models can classify posts based on images, not just text
- **Reasoning transparency** — see exactly why each post was filtered
- **Theme-aware UI** — adapts to light, dim, and dark modes automatically

## Supported Models

All models run locally in the browser (requires a WebGPU-capable browser):

| Model | Engine | Vision | Size |
|-------|--------|--------|------|
| Qwen3.5-4B | WebLLM | No | ~2.2 GB |
| Qwen3-4B | WebLLM | No | ~2.1 GB |
| Qwen3.5-4B Vision | WebLLM | Yes | ~2.8 GB |
| Gemma 4 E4B | LiteRT | No | ~3.0 GB |

Models are downloaded once and cached in the browser's Cache Storage. Delete a downloaded model anytime from the model dropdown in the popup.

> The default Qwen 3.5 and Gemma weights are served from self-hosted, revision-pinned **Apache-2.0 mirrors** so the fork keeps working regardless of upstream availability — see [model sources & licenses](docs/models.md).

## Quick Start

Build from source and load the unpacked extension:

```bash
cd Bouncer
npm install
npm run build          # or: npm run build:firefox / npm run build:safari
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `Bouncer/` folder
4. Navigate to twitter.com / x.com
5. Click "Settings" in the Bouncer element, pick a local model from the dropdown, and download it. Filtering runs on-device from then on.

## How It Works

1. A MutationObserver watches the Twitter feed for new posts
2. Post text, images, and metadata are extracted via the Twitter adapter
3. Posts are queued and sent to the selected AI model for classification against your filter topics
4. The model returns a category match and reasoning for each post
5. Matching posts are hidden with a fade-out animation and added to your filtered posts list
6. Click **View filtered** to review hidden posts and see why each was filtered

Results are cached so re-encountering a post doesn't require another inference call.

## Performance

Classification runs on-device, so per-post latency depends on your GPU and the engine you pick. On Apple Silicon the two engines differ markedly:

| Model | Engine | Median latency / post¹ |
|-------|--------|------------------------|
| Gemma 4 E4B | LiteRT | ~460 ms |
| Qwen 3.5 4B | WebLLM | ~1170 ms |

¹ Medium post, 3 filters. Gemma is **~2.5× faster** — it emits a terse verdict, while Qwen writes visible reasoning. (Faster isn't necessarily more accurate; this measures speed only.)

See the **[latency benchmark →](docs/benchmarks/latency.md)** for the full methodology, per-model tables, scaling behaviour, and how to reproduce it on your own machine.
