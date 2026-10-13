# Bouncer

<p align="center">
  <img src="Bouncer/icons/b-bouncer-2x_big.png" alt="Bouncer" width="200" />
</p>

**Heal your feed.** Bouncer filters unwanted posts from Twitter/X. Describe
filters such as “crypto,” “engagement bait,” or “rage politics”; Bouncer hides
matching posts and shows their matched phrases in **View filtered**.

This local-only [imbue-ai/bouncer](https://github.com/imbue-ai/bouncer) fork
is licensed under AGPL-3.0 and targets Chrome on macOS. It uses one fixed
Gemma 4 E2B QAT text classifier through Ollama at `http://127.0.0.1:11434`.
Post text and filter phrases go only to that local service; image and video
bytes are not passed to inference.

> **Native migration implemented; qualification remains in draft.** The
> [qualification report](docs/benchmarks/ollama-qualification.md) records
> synthetic quality/performance and actual Chrome checks, the 2026-10-13
> startup correction, and the remaining post-correction verification gates.

## Features

- **Natural-language filters** — describe what should leave the feed.
- **Local inference** — only the fixed loopback service receives classifier requests.
- **Filter transparency** — hidden posts show their matched phrases.
- **Explicit decisions** — Bounce and Restore preserve ordered manual decisions.
- **Theme-aware UI** — the interface follows X's light, dim and dark modes.
- **Lazy loading** — the first real generation loads Gemma, with one minute of requested native retention.

## Native model

| Field | Fixed artifact |
|---|---|
| Model | Gemma 4 E2B Instruct, QAT Q4_0 text weights |
| Qualified application and CLI | Ollama 0.40.3 |
| Owned alias | `bouncer-gemma4-e2b-qat-text:v1` |
| Text-weight size | 3,349,514,112 bytes, about 3.35 GB |
| Accepted manifest | `fbc40c82cb8acd3f63077d417d6040a42b5aeac406ed078fa8ba888fb38cfc19` |

Preparation reuses exact verified text weights in the default native store,
omits the separate image projector and does not requantize. The browser ships
no model weights, inference SDK, WASM or offscreen host. The 3.35 GB figure
describes referenced text weights; the recorded combined source package is
about 4.34 GB. See [source hashes and license provenance](docs/models.md).

## Setup

Follow the [first-time model and startup recipe](docs/models.md#first-time-prerequisites)
for the qualified Ollama application and CLI, cloud-disabled loopback settings,
default `~/.ollama/models` store, optional source acquisition and a stable
absolute Node executable. The preparation command imports existing exact
weights without inference or downloads; it does not install Ollama.

From the repository root, after those prerequisites are satisfied:

```bash
node scripts/prepare-native-model.mjs
cd Bouncer
npm ci
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Load the `Bouncer/` folder unpacked.
3. Open the popup and click **Connect to Ollama** to grant the exact optional
   `http://127.0.0.1:11434/*` permission.
4. Readiness verifies pinned metadata with a real worker POST before sending
   any post text. If that Origin is rejected, follow the
   [exact-origin startup recipe](docs/models.md#install-exact-origin-startup).
5. Once Ready, open `x.com` and add filters.

The checked-in Chrome key preserves
`chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm`. A successful GET health
check cannot establish worker POST readiness. The optional operator helper
preserves finite existing origins and adds only this exact origin, then opens
the existing official app and verifies runtime/model metadata without loading
a model. Its login hook requires the actual competing `com.ollama.ollama`
user startup job to be disabled and verified. Installation records the chosen
Node executable; no universal Homebrew path is assumed. The extension never
installs the helper or changes native configuration.

Chrome is the sole build target, with a manifest floor of 137. Recorded
qualification uses an M5 Pro / 64 GB MacBook Pro and specified Chrome/Ollama
versions; other hardware is not covered by those measurements.

## Everyday use and recovery

Popup opening, connection and metadata readiness do not preload Gemma.
The next eligible uncached post or requested suggestion loads it through a
real generation. Ollama manages expiry after the last use; another client
sharing the weights can extend residency. Cached decisions and explicit
Bounce/Restore remain available when the service is unavailable.

If Ollama is stopped, open it through the
[owned launcher](docs/models.md#launch-upgrade-and-removal), then click
**Retry**. Missing or changed model identity points back to preparation and
qualification. Other resident models defer automatic filtering until a later
eligible action can recheck. Bouncer never force-unloads shared models or
changes native global retention, parallelism or context settings.

An interrupted generation may continue in the native service. A durable
unresolved-work fence blocks new generation until the
[full-process-stop recovery procedure](docs/models.md#interrupted-request-recovery)
and popup's **Resume after restarting Ollama** confirmation establish that it
stopped. Browser abort, ordinary Retry, elapsed time or an unloaded model do
not establish cancellation. The extension never restarts the shared service.

## Development and evidence

Node 24 LTS is used in CI. From `Bouncer/`, run `npm run lint` and `npm run test`.
From the repository root, the pure operator checks are:

```bash
node --test scripts/test-macos-ollama-setup.mjs scripts/test-prepare-native-model.mjs
```

`npm run build:dev` in `Bouncer/` adds the actual-worker `benchmark.html`
with synthetic fixtures and latency diagnostics. Production archives exclude
that surface. The recorded native quality corpora are manual qualification
evidence; their public replay dataset is not shipped and CI does not replay
those model evaluations.

Historical browser reports preserve their original measurements and raw data:
[E2B/E4B decision](docs/benchmarks/e2b-evaluation.md),
[LiteRT runtime verification](docs/benchmarks/runtime-upgrade.md),
[Qwen/E4B latency](docs/benchmarks/latency.md) and
[classification results](docs/benchmarks/accuracy.md). Reproduce the retired
browser runtime from the recorded historical commit. Those timings, quality
and memory observations are not native QAT text-only measurements. The
[native qualification report](docs/benchmarks/ollama-qualification.md) owns
current evidence and release gates. No battery-life improvement is claimed.
