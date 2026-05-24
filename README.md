# Bouncer

<p align="center">
  <img src="Bouncer/icons/b-bouncer-2x_big.png" alt="Bouncer" width="200" />
</p>

**Heal your feed.** Bouncer is a browser extension that uses AI to filter unwanted posts from your Twitter/X feed. Define filter topics in plain language — "crypto", "engagement bait", "rage politics" — and Bouncer classifies and hides matching posts in real time.

> **Local-only fork.** This is a modified, local-only fork of [imbue-ai/bouncer](https://github.com/imbue-ai/bouncer) (AGPL-3.0). All cloud/remote backends have been removed — classification runs entirely on-device via WebLLM. Build and load it from source (see [Quick Start](#quick-start)).

## Features

- **Natural language filters** — describe what you don't want to see in your own words
- **On-device only** — models run entirely in your browser via WebLLM (WebGPU); no accounts, no API keys, nothing sent to a server
- **Image-aware filtering** — multimodal models can classify posts based on images, not just text
- **Reasoning transparency** — see exactly why each post was filtered
- **Theme-aware UI** — adapts to light, dim, and dark modes automatically

## Supported Models

All models run locally in the browser via WebLLM (requires a WebGPU-capable browser):

| Model | Vision | Size |
|-------|--------|------|
| Qwen3-4B | No | ~2.1 GB |
| Qwen3.5-4B | No | ~2.2 GB |
| Qwen3.5-4B Vision | Yes | ~2.8 GB |

Models are downloaded once and cached in the browser's Cache Storage. Delete a downloaded model anytime from the model dropdown in the popup.

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
