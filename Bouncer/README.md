# Bouncer — desktop extension

The extension code for the personal, local-only Twitter/X fork. Production
classification runs entirely on-device through LiteRT-LM/WebGPU with one model:
Gemma 4 E2B. Cloud inference, hosted auth, WebLLM/Qwen, vision inference,
custom models, and the product model picker are intentionally absent.

Chrome MV3 on the target M5 Pro MacBook Pro is the actively tested path. The
Firefox and Safari desktop build targets remain available, but they are not part
of the current model-performance evidence.

## Build

```bash
npm install
npm run build          # production Chrome build
npm run watch          # production-mode file watching
npm run build:dev      # development build, including benchmark pages
npm run watch:dev      # development-mode file watching
```

Load this `Bouncer/` folder unpacked at `chrome://extensions` with Developer
mode enabled. Open the popup and download the roughly 2 GB model once.

`npm run build:dev` creates bundles for two checked-in development surfaces.
Production builds omit those bundles; release archives omit both the pages and
their bundles:

- `benchmark.html` exercises the extension's actual MV3 background/offscreen path with the sole production model.
- `gemma-comparison.html` directly compares E2B with the retired E4B comparator from a normal localhost page. E4B exists only in this harness; it is not a second product model.

For the localhost comparison:

```bash
npm run build:dev
python3 -m http.server 8123 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8123/gemma-comparison.html`. Run both
`?order=e2b-first` and `?order=e4b-first` when comparing models so model order
does not masquerade as a performance difference. See the
[E2B decision record](../docs/benchmarks/e2b-evaluation.md) for methodology and
limitations.

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Production Chrome build via esbuild |
| `npm run build:dev` | Development build with benchmark bundles |
| `npm run build:firefox` | Firefox desktop build |
| `npm run build:safari` | Safari desktop build |
| `npm run watch` | Rebuild on source changes |
| `npm run test` | Run unit tests with Vitest |
| `npm run lint` | Run ESLint and TypeScript checks |
| `npm run lint:fix` | Apply safe ESLint fixes |
| `npm run typecheck` | Run TypeScript without emitting |
| `npm run cut-chrome` | Prepare a Chrome release archive |

## Source layout

```text
src/
  background/
    index.ts                         # MV3 service worker and message routing
    pipeline.ts                      # Evaluation queue, batching, result cache, suggestions
    local-model.ts                   # LocalEngine lifecycle, inference, cancellation
    inference-queue.ts               # Serial priority queue for local model work
    model-migration.ts               # One-time cleanup of retired model state/caches
    backends/
      types.ts                       # LocalBackend lifecycle seam
      litertlm-backend.ts            # Sole backend implementation
      litertlm-proxy.ts              # Chrome service-worker ↔ offscreen bridge
  offscreen/
    litertlm-runtime.ts              # LiteRT engine hosted by Chrome offscreen page
  popup/
    index.ts                         # Single-model download/load/delete UI
  shared/
    models.ts                        # Sole production E2B definition
    benchmark-models.ts              # Dev-only E4B comparator definition
    prompts.ts                       # Gemma classifier prompts
    table-yesno-request.ts           # Shared request and output-budget builder
    table-yesno.ts                   # Strict verdict parser
    suggestions.ts                   # “Bounce this tweet” prompt/parser
    storage.ts                       # Typed chrome.storage helpers
  content/
    index.ts                         # MutationObserver and post submission
    ui.ts                            # Injected X UI, theming, filters, review surfaces

adapters/twitter/
  TwitterAdapter.ts                  # X DOM extraction and selectors
  twitter.css                        # X-specific styles

popup.html / popup.css               # Settings and model lifecycle UI
offscreen.html                        # Chrome LiteRT host document
benchmark.html                        # Dev-only MV3 benchmark page
gemma-comparison.html                 # Dev-only localhost E2B/E4B runner
manifest.base.json                    # Shared manifest source
manifest.chrome.json                  # Chrome overlay
```

## Runtime shape

`LocalEngine` retains a backend interface because lifecycle boundaries still
matter: loading, cancellation, queueing, unload, status serialization, and
Chrome offscreen teardown remain separate from LiteRT's implementation details.
That seam does **not** imply multiple production engines. LiteRT-LM is the only
implementation and Gemma 4 E2B is the only production model.

The model is text-only. Image and video URLs may still be retained for the
filtered-post review UI, but their bytes are not passed to inference.

## Main dependencies

- **[@litert-lm/core](https://www.npmjs.com/package/@litert-lm/core)** — local Gemma inference through WebGPU
- **[DOMPurify](https://github.com/cure53/DOMPurify)** — HTML sanitization
- **[html-to-image](https://github.com/bubkoo/html-to-image)** — UI export support
- **[esbuild](https://esbuild.github.io/)** — bundling
- **[Vitest](https://vitest.dev/)** — tests
- **[TypeScript](https://www.typescriptlang.org/)** — static checking
