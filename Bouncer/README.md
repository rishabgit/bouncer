# Bouncer extension

Bouncer filters X posts in Brave or Chrome on macOS. It uses the fixed
`LiquidAI/d1-2B-GGUF:Q8_0` text classifier through Llama.app System One at
`http://127.0.0.1:9931`. The browser owns the feed, decisions, queue and UI;
Llama.app serves the model. Images and videos never enter inference.

## Build and setup

Node 24 LTS is used in CI. From this directory:

```bash
npm ci
npm run build
npm run lint
npm run test
```

Follow [model setup](../docs/models.md), then load `Bouncer/` unpacked from your
browser’s extensions page with **Developer mode** enabled. The manifest includes
required access to X and `http://127.0.0.1:9931/*`. The Chromium manifest floor
is 137, and the checked-in key preserves the extension identity.

Llama.app answers requests from any web origin by default. Brave asks before
websites can access localhost; review the prompt for the requesting site.

## Source and build

`src/shared/decision-model.ts` is the single source for the model, endpoint,
System One request template, probability cutoffs, input limits and classifier
fingerprint. The service worker owns local `fetch` calls; content scripts
submit typed post and filter operations. X extraction, selectors and theme
behavior live in `adapters/twitter/`. DOMPurify sanitizes displayed post HTML.

`npm run build` recreates `dist/`. `npm run watch` rebuilds on source changes.
`npm run gen-manifests` regenerates the manifest. CSP permits packaged code and
connections only to self and the fixed loopback endpoint.

## Decisions and inference

Bouncer permits up to ten active filters. Use plain descriptions of what a post
does or is about. Tone filters can overhide or miss posts; see the recorded
[quality and limits](../docs/models.md#quality-and-limits).

Bounce requires a label and adds it in the same serialized action that hides
the post. Its helper text is defined once in `src/shared/filter-guidance.ts`.
The missed-filter action uses an existing phrase without inference. Restore
updates the UI after its cache override succeeds. Explicit decisions take
precedence over automatic results.

Readiness uses only `GET /v1/models` to find the fixed model and inspect its
configured arguments. Classification uses `POST /v1/systemone` with bare post
text and one `noul` question per filter. Each filter defaults to **Standard**
(`0.290813258948728`) and can opt into **Strict** (`0.72`) from its filter menu.
A match requires `probability >= cutoff`. For at most three own words in the
sent text, excluding http(s) links and @handles, the cutoff is
`max(filter cutoff, 0.70)`, so Strict remains `0.72`. Strict hides fewer posts
and may miss more matches; see
[quality and limits](../docs/models.md#quality-and-limits).
A transport error, timeout, truncated response or malformed
answer leaves that post visible and later filtering continues.

Settings, compatible cache reads and empty feeds leave model weights unloaded.
Navigation, pause and explicit decisions reject stale results. Llama.app controls
model residency. See [inference behavior](../docs/inference-engines.md) and the
future human [browser check](../docs/browser-testing.md). Recorded model results
do not qualify this extension’s browser integration.

This fork retains upstream attribution and AGPL-3.0. The model has its own
license; review the model repository’s terms before acquiring or redistributing
its files.
