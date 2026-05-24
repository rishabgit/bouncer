# Bouncer

A browser extension that filters unwanted posts from Twitter/X feeds using AI. Users define filter topics (e.g., "crypto", "engagement bait") and the AI classifies and hides matching posts.

**Local-only fork.** This is a modified, local-only fork of [imbue-ai/bouncer](https://github.com/imbue-ai/bouncer) (AGPL-3.0). Every non-local backend has been removed — the direct cloud APIs (OpenAI/Gemini/OpenRouter/Anthropic), the Imbue WebSocket backend + Firebase auth, and AI-text detection. Classification runs **only** on-device via WebLLM/Qwen (WebGPU). Upstream has since migrated local inference to LiteRT-LM; this fork deliberately stays on WebLLM. When editing, do not reintroduce cloud/provider/auth code paths.

## Project Structure

**Important:** All extension code lives in `Bouncer/`; load it unpacked from there. The native Xcode wrapper project (macOS Safari + iOS apps) was removed from this fork. iOS is not supported (WKWebView has no WebGPU).

## Build & Development

```bash
cd Bouncer
npm install
npm run build        # one-time build
```

Then load the unpacked extension from the `Bouncer/` folder at `chrome://extensions`.

Dependencies: esbuild, dompurify, vendored web-llm

Pre-commit checks:
```bash
cd Bouncer
npm run lint
npm run test
```

## Architecture

### Key Patterns

- **Adapter pattern**: Site-specific logic (DOM selectors, theme, post extraction) is abstracted behind adapters. Currently only `adapters/twitter/`. This enables future support for other platforms.
- **Theme support**: Three modes (light, dim, dark) detected via `adapter.getThemeMode()`. All custom UI elements respect the active theme.
- **Filter storage**: Filter phrases persisted via Chrome `storage.local` API.
- **Post tracking**: Filtered posts stored in `filteredPosts` array with their HTML, reasoning, image URLs, and post URLs.
- **Reasoning popups**: Each filtered post can show an AI-generated reasoning explaining why it was filtered.

### Local model (Qwen3.5): thinking is disabled at the model level

The local WebLLM models are imbue's custom MLC builds. Their
`mlc-chat-config.json` ships conv_template **`qwen3_5_nothink`**, whose
assistant role is hardcoded to begin with an empty pre-closed
`<think>\n\n</think>` — so Qwen3.5 emits **no chain-of-thought by default**,
even though base Qwen3/Qwen3.5 default thinking ON. Implications:

- `extra_body.enable_thinking` is a **no-op for Qwen3.5** (already off via the
  template); only `Qwen3-4B` needs/uses that runtime flag.
- The model has no hidden `<think>` deliberation, so the **visible reasoning
  the prompt asks for (written before the classification label) is the only
  test-time "thinking"** — keep reasoning-before-label ordering in any
  prompt/structured-output changes.

Verified from source (`mlc-chat-config.json`):

- [Qwen3.5-4B-q4f16_1-MLC-2](https://huggingface.co/imbue/Qwen3.5-4B-q4f16_1-MLC-2/raw/main/mlc-chat-config.json)
- [Qwen3.5-4B-vision-q4f16_1-MLC-2](https://huggingface.co/imbue/Qwen3.5-4B-vision-q4f16_1-MLC-2/raw/main/mlc-chat-config.json)

### Content Script Flow

1. Extension injects content script on Twitter/X pages
2. MutationObserver watches for new posts in the feed
3. New posts are sent to the AI for classification against user-defined filter topics
4. Posts classified as matching a filter are hidden and added to `filteredPosts`
5. Users can view filtered posts via the "View filtered" button
