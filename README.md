# Bouncer

<p align="center">
  <img src="Bouncer/icons/b-bouncer-2x_big.png" alt="Bouncer" width="200" />
</p>

**Heal your feed.** Bouncer filters unwanted posts from Twitter/X. Describe
filters such as “crypto,” “engagement bait,” or “rage politics”; Bouncer hides
matching posts and shows their matched phrases in **View filtered**.

This local-only [imbue-ai/bouncer](https://github.com/imbue-ai/bouncer) fork
is licensed under AGPL-3.0 and targets Chrome on macOS. You choose where its
fixed text-only Gemma 4 E2B classifier runs:

| Choice | How it works | Setup |
|---|---|---|
| **In your browser — LiteRT-LM** (recommended) | Runs in this Chrome profile using WebGPU | Explicitly download about 2.01 GB once; no native app needed |
| **On this Mac — Ollama** | Uses the local app at `http://127.0.0.1:11434` | Prepare Bouncer's fixed native model and grant the optional local connection permission |

Both process post text and filter phrases on your device. Browser setup
downloads fixed model weights from Hugging Face; posts are never sent there.
Images and videos are not passed to inference. The two packages use separate
prompts and classifier identities, so their results can differ. There is no
automatic fallback, model picker, custom endpoint or cloud inference.

> **The two-engine integration remains in draft.** Owner-operated checks
> establish bounded development runtime behavior and production Browser setup
> and synthetic-feed behavior. Cancellation, offline operation, migration,
> native recovery and normal-login gates remain open. The
> [qualification report](docs/benchmarks/ollama-qualification.md) separates
> those observations from historical measurements and the remaining gates.

## Features

- **Natural-language filters** — describe what should leave the feed.
- **Your engine choice** — use Browser or Ollama and change it in settings.
- **Local inference** — post text stays on your device in either mode.
- **Filter transparency** — hidden posts show their matched phrases.
- **Explicit decisions** — Bounce and Restore preserve ordered manual decisions.
- **Theme-aware UI** — the interface follows X's light, dim and dark modes.
- **Lazy loading** — real requests load the model; settings and cached decisions do not.

## Setup

Node 24 LTS is used in CI. From the repository root:

```bash
cd Bouncer
npm ci
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Load the `Bouncer/` folder unpacked.
3. Open Bouncer settings and choose **In your browser** or **On this Mac**.
4. For Browser, use **Download & use browser AI**. The download verifies the
   exact size and SHA-256 before the saved weights can be loaded. When the
   fixed weights are saved or cache status is still being checked, use
   **Use browser AI**. If weights are missing afterward, use the explicit
   **Download browser model** action.
5. For Ollama, follow the [native prerequisites and preparation](docs/models.md#first-time-prerequisites),
   choose **Use Ollama**, then **Connect to Ollama**. It requests only
   `http://127.0.0.1:11434/*`; readiness checks exact runtime and artifact
   metadata before transmitting post text.
6. Once the selected engine is ready, open `x.com` and add filters.

Chrome is the sole build target, with a manifest floor of 137. Browser mode
also requires WebGPU and enough profile storage for the fixed artifact.
Choosing a card previews it; the explicit Use or Download action saves your
choice before setup starts. Failed or canceled setup preserves it. A fresh
or ambiguous profile asks you to choose; upgrades preserve a valid earlier
Browser preference or completed Ollama cutover. Permission or GPU availability
never chooses an engine for you.

See [engine scenarios and actions](docs/inference-engines.md) and
[exact artifacts and setup](docs/models.md) for download, offline, switching
and recovery behavior. The optional native operator helper opens the existing
official app with a finite exact-origin configuration. The extension never
installs the helper, starts a native service or edits native settings.

## Everyday use and recovery

Opening settings for saved Browser weights does not load the GPU. The first
eligible uncached post or requested suggestion loads the selected model.
Browser releases its runtime after one minute of inactivity and retains saved
weights. Ollama requests `keep_alive: "1m"` for each generation; another client
sharing those weights can extend residency. That request is not a promise to
unload a shared native model exactly one minute later.

Browser weights stay in this Chrome profile's Cache Storage. Download progress,
Cancel and **Delete downloaded browser model** are explicit settings controls. Missing
or evicted weights require another explicit Download action; filtering and
suggestions never redownload them. Saved verified weights can run without the
download network, subject to working Chrome/WebGPU; loading the X feed itself
still requires its network. A GPU failure asks for setup or retry and preserves
your Browser choice.

Switching retires old automatic results and suggestions, cancels an old browser
download, and lets known native work settle before new generation. Automatic
feed decisions are re-evaluated; manual hide and restore decisions remain.
Saved compatible decisions and manual Bounce/Restore work even when the
selected engine is unavailable.

An interrupted native generation may continue in Ollama. Its durable recovery
block applies to both choices, so selecting Browser cannot bypass it. Follow
the [full-process-stop recovery procedure](docs/models.md#interrupted-request-recovery)
and **Resume after restarting Ollama** confirmation. Recovery can finish while
Browser remains selected. Browser abort, ordinary Retry, elapsed time or an
empty native residency list cannot prove native cancellation. Bouncer never
force-unloads models, restarts the shared service or changes its global settings.

## Development and evidence

From `Bouncer/`, run `npm run lint` and `npm run test`. From the repository root,
the pure native operator checks are:

```bash
node --test scripts/test-macos-ollama-setup.mjs scripts/test-prepare-native-model.mjs
```

`npm run build:dev` adds actual-worker `benchmark.html` diagnostics for the
saved selected fixed engine. Preparation initializes verified cached Browser
weights or checks Ollama metadata without native prewarming; neither downloads
weights. Cleanup releases the Browser runtime or drains native requests without
forcing native model unload. Production archives exclude that surface and
include the local Browser SDK/WASM and third-party notices.
The recorded native quality corpora are bounded manual qualification evidence;
their public replay dataset is not shipped and CI does not replay those model
evaluations.

Historical reports preserve original measurements and raw data:
[E2B/E4B decision](docs/benchmarks/e2b-evaluation.md),
[LiteRT runtime verification](docs/benchmarks/runtime-upgrade.md),
[Qwen/E4B latency](docs/benchmarks/latency.md) and
[classification results](docs/benchmarks/accuracy.md). Reproduce their
historical harness from the recorded commit. The
[native qualification report](docs/benchmarks/ollama-qualification.md) owns
the dated native results and current integration gates. These measurements
establish no universal speed ranking or battery-life improvement.
