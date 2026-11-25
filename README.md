# Bouncer

<p align="center">
  <img src="Bouncer/icons/b-bouncer-2x_big.png" alt="Bouncer" width="200" />
</p>

**Heal your feed.** Bouncer filters unwanted posts from Twitter/X. Add up to ten
filters describing what posts do or are about, such as “crypto” or “posts asking
for likes or reposts.” Bouncer hides matching posts and shows their matched
phrases in **View filtered**.

This AGPL-3.0 fork of [imbue-ai/bouncer](https://github.com/imbue-ai/bouncer)
runs on macOS in Brave or Chrome. Its fixed text-only classifier is
`LiquidAI/d1-2B-GGUF:Q8_0`, served by Llama.app System One at
`http://127.0.0.1:9931`. Post text and filter phrases stay on your device.
Images and videos never enter inference.
Each post is classified on its own words only; quoted and embedded posts are
displayed but excluded from classification. Bare quotes and media-only posts
with no words of their own stay visible without a model request.

## Setup

1. Follow [model setup](docs/models.md) to install Llama.app, the llama.cpp
   team’s macOS menu-bar app, place `d1-2B-Q8_0.gguf` in the Hugging Face cache
   and apply the required text-only settings. Enable **Launch at login**.
2. Build the extension with Node 24 LTS:

   ```bash
   cd Bouncer
   npm ci
   npm run build
   ```

3. Open your browser’s extensions page, enable **Developer mode** and load the
   `Bouncer/` folder unpacked. Installation includes the required
   `http://127.0.0.1:9931/*` host permission.
4. Open `x.com`, add filters and leave Llama.app running. Bouncer checks for its
   fixed model automatically.

Llama.app answers requests from any web origin by default. Brave asks before
websites can access localhost; review the prompt for the requesting site.
This build supports fresh installs with the current local storage schema.
The operator manages Llama.app, its settings and model files.

## Everyday use

Use **Bounce** to enter a label describing what to hide, then confirm to add
the filter and hide that post. If an existing filter should have matched, use
the missed-filter action and choose it. **Restore** makes a hidden post visible
again. These manual decisions and compatible cached decisions work without
model inference.

Llama.app loads the model when classification needs it. If a request fails or
returns an invalid answer, that post stays visible and filtering continues with
later posts. See [inference behavior](docs/inference-engines.md).

Tone filters can overhide or miss posts. Plain descriptions worked better than
short tone labels in the recorded evaluation; [quality and limits](docs/models.md#quality-and-limits)
records the results and their boundaries.

## Development

From `Bouncer/`, run `npm run build`, `npm run lint` and `npm run test`.
The classifier’s model, endpoint, request template, cutoff and input limits are
defined in `src/shared/decision-model.ts`. Follow
[browser testing](docs/browser-testing.md) for a future human check of the real
extension. Unit tests and recorded model evaluations do not establish live-feed
behavior.
