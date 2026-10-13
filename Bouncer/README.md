# Bouncer — Chrome extension

Bouncer uses one fixed text-only Gemma 4 E2B QAT classifier through local
Ollama at `http://127.0.0.1:11434`. Chrome owns the feed, decisions, queue and
UI; Ollama owns loading and model residency. The extension ships no weights
or inference runtime and sends no image or video bytes to inference.

The [native qualification report](../docs/benchmarks/ollama-qualification.md)
records the 2026-10-12 browser/model evidence and the 2026-10-13 launcher
correction. Post-correction Chrome-worker and subsequent normal-login checks
remain draft gates.

## Build

```bash
npm ci
npm run build          # production Chrome build
npm run watch          # production-mode file watching
npm run build:dev      # development build with actual-extension diagnostics
npm run watch:dev      # development-mode file watching
```

Every build recreates `dist/`. Production emits `background.js`, `popup.js`,
`content.js` and the standalone `TwitterAdapter.js`; development adds
`benchmark.js`. Chrome is the only build target. The manifest floor remains
137 and the public key preserves
`chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm`.

Load this `Bouncer/` folder unpacked at `chrome://extensions`. Before
connecting, follow the [first-time setup](../docs/models.md#first-time-prerequisites)
for Ollama 0.40.3 application/CLI, exact source weights and license, default
store, cloud-disabled loopback configuration and a stable Node executable.
Run `node scripts/prepare-native-model.mjs` from the repository root. Preparation
imports existing verified weights without downloading, generating text or
changing origin settings.

**Connect to Ollama** requests only the optional
`http://127.0.0.1:11434/*` host permission. A real worker POST to `/api/show`
checks readiness. A successful GET is insufficient. If the service rejects
the stable extension Origin, follow the
[exact-origin startup recipe](../docs/models.md#install-exact-origin-startup).
The operator helper preserves finite origins and opens the existing official
app; its login-hook mode requires verified disabling of the competing
`com.ollama.ollama` user service. The extension installs no helper and changes
no native configuration.

Node 24 LTS is used in CI. From this directory, run `npm run lint` and
`npm run test`; from the repository root, run the pure operator checks:

```bash
node --test scripts/test-macos-ollama-setup.mjs scripts/test-prepare-native-model.mjs
```

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Clean production Chrome build via esbuild |
| `npm run build:dev` | Development build with the fixed native benchmark |
| `npm run gen-manifests` | Generate the Chrome manifest from checked-in sources |
| `npm run watch` | Rebuild on source changes |
| `npm run test` | Unit tests with Vitest |
| `npm run lint` | ESLint and TypeScript checks |
| `npm run typecheck` | TypeScript without emitting |
| `npm run cut-chrome` | Build and stage a Chrome release archive |
| `npm run cut-chrome:same` | Keep the manifest version when archiving |

Release staging copies an explicit runtime allowlist, including Chrome icons,
the X adapter/extractor, DOMPurify, popup/content styles and the AGPL license.
It excludes development pages, source, dependency installations and any stale
generated runtime assets. Release preparation uses `npm ci` and leaves local
dependencies installed.

## Source layout

```text
src/
  background/
    index.ts                         # MV3 service worker and typed message routing
    pipeline.ts                      # Evaluation queue, cache and suggestions
    local-model.ts                   # Native readiness, inference and recovery
    inference-queue.ts               # Serial priority queue
    model-migration.ts               # Preserve decisions; remove owned legacy state/caches
    backends/
      types.ts                       # Native backend contract
      ollama-backend.ts               # Fixed loopback transport and metadata verification
    benchmark.ts                     # Dev-only actual-extension operations
  popup/
    index.ts                         # Connect, status, Retry and setup guidance
  shared/
    models.ts                        # Fixed artifact identity and classifier fingerprint
    ollama-contract.ts               # Local native request/metadata rules
    prompts.ts                       # Gemma classifier prompts
    table-yesno-request.ts            # Numbered categories and finite input/output budget
    table-yesno.ts                    # Strict verdict parser
    suggestions.ts                   # “Bounce this tweet” prompt/parser
    storage.ts                       # Typed Chrome storage helpers
  content/
    index.ts                         # MutationObserver and post submission
    ui.ts                            # X UI, themes, filters and review surfaces
  benchmark/
    index.ts                         # Dev-only fixed-native benchmark page

adapters/twitter/
  TwitterAdapter.ts                  # X DOM extraction and selectors
  fiber-extractor.js                 # Main-world extraction bridge
  twitter.css                        # X-specific styles

popup.html / popup.css               # Settings and connection UI
benchmark.html                      # Dev-only actual-extension benchmark
manifest.base.json                  # Storage, X access, optional loopback and CSP
manifest.chrome.json                # Stable Chrome key and version floor
```

## Runtime and diagnostics

The first real generation loads Gemma. Every generation requests
`keep_alive: "1m"`; metadata probes, popup opening and cached reads do not
preload it. Bouncer cancels queued work and rejects stale results when paused,
but it leaves shared native residency to Ollama. It does not issue model
delete/unload requests, restart the service or evict other clients' models.
An unresolved request survives worker termination as a durable recovery block.
Ordinary Retry cannot clear it. Follow the
[full-process-stop recovery procedure](../docs/models.md#interrupted-request-recovery),
then use the popup's **Resume after restarting Ollama** confirmation.
The extension never restarts the shared service automatically, and
concurrent-model generation stays disabled.

The development `benchmark.html` runs the fixed classifier through the actual
Chrome worker. Its metadata operation checks readiness without loading weights;
its release operation clears only Bouncer bookkeeping. Actual cold loading and
expiry are measured with real requests and independent native observations.
Run synthetic fixtures with no X tab actively filtering. The native report's
corpus hashes record manual qualification; no public replay dataset for those
model evaluations is shipped or replayed in CI. Historical LiteRT,
E4B and Qwen reports remain in [docs/benchmarks](../docs/benchmarks/) and can be
reproduced from their historical commit; their runtime is no longer packaged.

## Dependencies and license

- **DOMPurify** — HTML sanitization.
- **html-to-image** — existing UI export support.
- **esbuild** — bundling.
- **Vitest** — unit tests.
- **TypeScript** — static checking.

Native transport uses browser `fetch` and requires no Ollama SDK. This fork
preserves upstream attribution and the repository's AGPL-3.0 license. Model
license material stays with the prepared native artifact.
