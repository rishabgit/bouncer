# Bouncer — Chrome extension

Bouncer offers an explicit choice between two fixed text-only Gemma 4 E2B
execution paths: LiteRT-LM in this Chrome profile, or local Ollama at
`http://127.0.0.1:11434`. Chrome owns the feed, decisions, queue and UI.
Browser mode uses bundled local SDK/WASM and an on-demand offscreen host;
Ollama owns its shared native runner. Model weights are acquired separately.
Neither path sends image or video bytes to inference.

The [qualification report](../docs/benchmarks/ollama-qualification.md)
records the 2026-10-12 native/browser comparison and the 2026-10-13 launcher
correction. Historical results do not qualify the new engine choice,
streaming integrity, offscreen lifecycle or switching. Those actual-Chrome
checks, post-correction native worker access and subsequent normal-login
startup remain draft gates. Read the
[engine action matrix](../docs/inference-engines.md) for expected behavior.

## Build and setup

```bash
npm ci
npm run build          # production Chrome build
npm run watch          # production-mode file watching
npm run build:dev      # development build with actual-extension diagnostics
npm run watch:dev      # development-mode file watching
```

Every build recreates `dist/`. Production emits `background.js`, `popup.js`,
`content.js`, `offscreen.js`, the standalone `TwitterAdapter.js` and the fixed
normal/compat LiteRT runners under `dist/litertlm-wasm/`; development adds
`benchmark.js`. Chrome is the only build target. The manifest floor remains
137 and the public key preserves
`chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm`.

Load this `Bouncer/` folder unpacked at `chrome://extensions`. In settings,
Browser is recommended for a fresh profile, but no engine runs until an
explicit Use or Download action commits the choice. Browser requires WebGPU
and an explicit 2,008,432,640-byte model download. A cold saved model's status
does not initialize the GPU; the next eligible real request does. The download
is separate from loading and verifies exact size/SHA-256 in a backpressured
stream. Cache misses after eviction require explicit download again.

For the optional Ollama path, follow the
[first-time setup](../docs/models.md#first-time-prerequisites)
for Ollama 0.40.3 application/CLI, exact source weights and license, default
store, cloud-disabled loopback configuration and a stable Node executable.
Run `node scripts/prepare-native-model.mjs` from the repository root. Preparation
imports existing verified weights without downloading, generating text or
changing origin settings.

Choose **Use Ollama**, then **Connect to Ollama**, which requests only the optional
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

## Scripts and release packaging

| Command | Description |
|---|---|
| `npm run build` | Clean production Chrome build via esbuild |
| `npm run build:dev` | Development build with the selected fixed engine benchmark |
| `npm run gen-manifests` | Generate the Chrome manifest from checked-in sources |
| `npm run watch` | Rebuild on source changes |
| `npm run test` | Unit tests with Vitest |
| `npm run lint` | ESLint and TypeScript checks |
| `npm run typecheck` | TypeScript without emitting |
| `npm run cut-chrome` | Build and stage a Chrome release archive |
| `npm run cut-chrome:same` | Keep the manifest version when archiving |

Release staging copies an explicit runtime allowlist, including Chrome icons,
the X adapter/extractor, DOMPurify, popup/content styles, offscreen host,
bundled SDK/WASM, `dist/THIRD-PARTY-NOTICES.txt` and the AGPL license.
It excludes development pages, source, dependency installations and stale
runtime assets. Release preparation uses `npm ci` and leaves local dependencies
installed. No runtime code is fetched from Hugging Face.

## Source layout

```text
src/
  background/
    index.ts                         # MV3 service worker and typed message routing
    pipeline.ts                      # Evaluation queue, cache and suggestions
    local-model.ts                   # Selected-engine lifecycle, inference and recovery
    inference-queue.ts               # Serial priority queue
    model-migration.ts               # Preserve preference/decisions; retire unsupported caches
    backends/
      types.ts                       # Fixed browser/native backend contracts
      litertlm-backend.ts             # Worker façade for on-demand Browser runtime
      litertlm-proxy.ts               # Owned offscreen protocol/lifecycle
      model-cache.ts                  # Streaming integrity and owned browser weights
      ollama-backend.ts               # Fixed loopback transport and metadata verification
    benchmark.ts                     # Dev-only actual-extension operations
  popup/
    index.ts                         # Engine choice, download, connection and recovery
  shared/
    models.ts                        # Two fixed artifacts and separate fingerprints
    ollama-contract.ts               # Local native request/metadata rules
    prompts.ts                       # Gemma classifier prompts
    table-yesno-request.ts            # Categories and finite input/output budgets
    table-yesno.ts                    # Strict verdict parser
    suggestions.ts                   # “Bounce this tweet” prompt/parser
    storage.ts                       # Typed Chrome storage helpers
  content/
    index.ts                         # MutationObserver and post submission
    ui.ts                            # X UI, themes, filters and review surfaces
  offscreen/
    index.ts                         # Validated fixed Browser operations
    litertlm-runtime.ts               # Browser SDK, conversation and GPU lifecycle
    litertlm-loader.ts                # Extension-local normal/compat WASM loader
  benchmark/
    index.ts                         # Dev-only selected fixed engine benchmark page

adapters/twitter/
  TwitterAdapter.ts                  # X DOM extraction and selectors
  fiber-extractor.js                 # Main-world extraction bridge
  twitter.css                        # X-specific styles

popup.html / popup.css               # Settings, choice and connection UI
offscreen.html                      # On-demand Browser runtime host
benchmark.html                      # Dev-only actual-extension benchmark
manifest.base.json                  # Storage/offscreen, X, optional loopback and narrow CSP
manifest.chrome.json                # Stable Chrome key and version floor
```

## Runtime and diagnostics

The committed preference is read back before download, GPU initialization or
native readiness. Browsing an uncommitted settings card starts none of them.
Migration preserves a valid new selection, an earlier valid LiteRT preference
or a completed native cutover, otherwise asks for choice. No availability test
or failure chooses the other engine.

The first real generation loads the selected model. Browser inactivity releases
the runtime after one minute and retains saved weights. Every native generation
requests `keep_alive: "1m"`; metadata probes, popup opening and cached reads do
not preload it, and another native client may extend residency. Bouncer cancels
queued work and rejects stale results when paused or switched. A switch retires
automatic decisions and suggestions, preserves manual decisions, cancels browser
downloads and drains known native work. It does not issue native model
delete/unload requests, restart the service or evict other clients' models.
An unresolved native request survives worker termination as a durable recovery
block for both engines. Selecting Browser cannot bypass it. Ordinary Retry
cannot clear it. Follow the
[full-process-stop recovery procedure](../docs/models.md#interrupted-request-recovery),
then use **Resume after restarting Ollama**. This recovery can run while Browser
stays selected; it does not change preference. Native concurrent-model
generation remains disabled.

The development `benchmark.html` runs the saved selected fixed classifier
through the actual Chrome worker; choose and set it up in the popup first.
Explicit benchmark preparation initializes verified cached Browser weights or
checks Ollama metadata without native prewarming. Neither path downloads
weights. Cleanup releases the Browser runtime or drains native requests without
forcing shared native model unload. Reports capture the engine, artifact,
classifier fingerprint and selection revision; a changed choice invalidates
the run. Actual cold loading and expiry need real requests and engine-specific
lifecycle observations. Run synthetic fixtures with no X tab actively filtering.
The native report's corpus hashes record manual qualification; no public replay
dataset for those model evaluations is shipped or replayed in CI. Localhost
component checks do not qualify actual-extension behavior.

Historical LiteRT, E4B and Qwen reports remain in
[docs/benchmarks](../docs/benchmarks/) and can be reproduced from their historical
commit. The Browser option reuses the fixed E2B artifact and 0.17.0 core;
historical normal-page tests did not qualify its new offscreen,
download-integrity or selection lifecycle. Qwen/E4B and their comparison
harness are not packaged. Measurements establish no universal quality/speed
ranking or energy benefit.

## Dependencies and license

- **DOMPurify** — HTML sanitization.
- **html-to-image** — existing UI export support.
- **@litert-lm/core 0.17.0** — bundled Browser inference SDK and WASM runners.
- **@noble/hashes 2.4.0** — streaming browser artifact SHA-256 verification.
- **esbuild** — bundling.
- **Vitest** — unit tests.
- **TypeScript** — static checking.

Native transport uses browser `fetch` and requires no Ollama SDK. This fork
preserves upstream attribution and the repository's AGPL-3.0 license. Bundled
Browser runtime notices accompany releases. See
[artifact license provenance](../docs/models.md#future-pins-and-license-provenance)
before acquiring or redistributing either fixed model.
