# Native model — identity, setup and recovery

Bouncer uses one fixed Gemma 4 E2B QAT text classifier through local Ollama.
Exact artifact and runtime validation govern generation. The
[native qualification report](benchmarks/ollama-qualification.md) records
measured results and the remaining draft release gates.

## Fixed artifact

| Field | Value |
|---|---|
| Model | Gemma 4 E2B Instruct, QAT Q4_0 |
| Qualified application and CLI | Ollama 0.40.3 |
| Owned alias | `bouncer-gemma4-e2b-qat-text:v1` |
| Text-weight bytes | 3,349,514,112, about 3.35 GB |
| Text-weight SHA-256 | `3646b4c147cd235a44d91df1546d3b7d8e29b547dbe4e1f80856419aa455e6fd` |
| Source license blob SHA-256 | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |
| Renderer / parser | `gemma4-small` / `gemma4` |
| Request context | 1,024 tokens, also the measured QAT allocation |
| Accepted imported manifest | `fbc40c82cb8acd3f63077d417d6040a42b5aeac406ed078fa8ba888fb38cfc19` |

The source is the exact measured text layer from the official
[`gemma4:e2b-it-qat` package](https://ollama.com/library/gemma4:e2b-it-qat).
On 2026-10-13 its public page listed manifest prefix `07ea59a47401` and
4.3 GB; the recorded full source manifest is
`07ea59a474013479c8b6b802bef095c40e964a1d776ba02f264c0e30e1aede0c`.
The text-only import omits the 986,833,312-byte image projector and draft
layers without requantizing weights. Its manifest is separate from the source
manifest and must match the accepted digest above.

The measured combined package is about 4.34 GB. The 3.35 GB figure describes
text weights, not the initial download, whole store, RAM or first-use latency.
Other tags can continue referencing the projector and other layers; preparation
does not delete them. A floating tag or model name alone is insufficient
identity. Later source bytes can be used only if exact verification succeeds;
a changed artifact needs fresh qualification.

Google's [QAT source repository](https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf/tree/main)
separates text and projector files. At qualification, its text file had a
different hash from the measured Ollama layer. Substitution cannot inherit
these measurements.

## First-time prerequisites

This operator setup targets macOS and the official Ollama application at
`/Applications/Ollama.app`. Install the qualified
[Ollama 0.40.3 release](https://github.com/ollama/ollama/releases/tag/v0.40.3)
and its matching CLI, available as `ollama` on `PATH`. Check `ollama --version`;
the preparation and startup helpers also verify the running service's exact
version. A newer version is not implicitly qualified.

Keep the service bound to `127.0.0.1:11434` and disable cloud features before
using it for feed data. The [official Ollama FAQ](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features)
documents the persistent `"disable_ollama_cloud": true` field in
`~/.ollama/server.json`. Merge that field into the existing JSON object while
preserving every other field; do not replace the whole file with a minimal
example. Apply configuration through a normal app restart after other clients
finish. The helper preserves these settings and does not edit that file.
Ollama's default binding is loopback; an existing non-loopback override must
be corrected separately before use.

The model preparation script uses the default macOS store
`~/.ollama/models`, including its `blobs/` directory. A custom `OLLAMA_MODELS`
store is not supported by this recipe. Keep the exact source text and license
blobs in that default store. If they are absent, this optional operator command
acquires the official combined package from its source:

```bash
OLLAMA_HOST=http://127.0.0.1:11434 ollama pull gemma4:e2b-it-qat
```

Acquisition is separate from preparation and transfers about 4.34 GB for the
recorded source. Inspect its source and license before acquiring it. The
extension and preparation script never pull or download weights. A future
floating tag is acceptable only if the resulting exact weights, license and
imported manifest pass the fixed checks; never bypass a mismatch.

Choose a stable absolute Node executable and keep it available across logins.
Node 24 LTS is used in CI. For example, a Homebrew installation may provide
`/opt/homebrew/bin/node`; that path is not universal. In the commands below,
replace this placeholder with your selected executable:

```bash
BOUNCER_NODE="/absolute/stable/path/to/node"
"$BOUNCER_NODE" --version
```

Installation records that process's `process.execPath`, which is the actual
absolute executable used by the login hook. A temporary runtime or a removed
version-manager installation will break that hook.
Check the recorded path before installation:

```bash
"$BOUNCER_NODE" -p process.execPath
```

A stable symlink can resolve to a versioned executable. Keep that actual
executable available after package upgrades, or choose a runtime installed at
a fixed path before preparing the login hook. Review the preview's
`nodeExecutable`; the helper does not automatically migrate it on upgrade.

## Prepare the text-only model

With Ollama 0.40.3 running on loopback and no native model resident, run from
the repository root:

```bash
"$BOUNCER_NODE" scripts/prepare-native-model.mjs
```

The script verifies source weight size and SHA-256, retains the source license,
imports an inspectable text-only Modelfile through the matching local CLI and
reads back manifest, weights, renderer/parser and local completion metadata.
It records evidence under ignored `.native-preparation/`. It sends no inference,
edits no store files directly and preserves existing aliases. Let other clients
finish and their models expire normally before preparing.

The named alias retains a disk reference; it does not create separate memory
ownership. The runner is shared by weight identity. Missing or changed
manifest, weights, capabilities, family or remote metadata blocks post
transmission. Verify the reported imported digest against the fixed artifact
table before proceeding.

## Install exact-origin startup

Chrome's checked-in key preserves
`chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm`. After **Connect to Ollama**
grants only `http://127.0.0.1:11434/*`, readiness must POST model metadata from
the actual worker. A GET health check may succeed while Ollama rejects this
Origin. Apply exact-origin setup only when that worker POST confirms rejection.
Never broaden Chrome host access or use wildcard native origins.

The operator-only `scripts/macos-ollama-setup.mjs` owns:

| File | Purpose |
|---|---|
| `~/Library/Application Support/Bouncer/OllamaOrigins/macos-ollama-setup.mjs` | Launcher for the existing official app |
| `~/Library/Application Support/Bouncer/OllamaOrigins/ownership.json` | Owned hashes and preserved origin/restoration state |
| `~/Library/LaunchAgents/local.bouncer.ollama-origins.plist` | Optional one-shot `RunAtLoad` hook with `KeepAlive` disabled |

First create the login-hook preview from the repository root:

```bash
"$BOUNCER_NODE" scripts/macos-ollama-setup.mjs --prepare --mode login-hook
```

This is read-only with respect to native configuration, environment, launchd
and the application. It writes ignored review artifacts under
`.macos-ollama-setup-review/`; review their paths, selected Node executable,
finite-origin behavior and removal contract. Preview does not install or
register a job. Its optional `--origins` input is for review only; installation
reads and preserves the actual finite login-session origin set.

Before the Bouncer hook owns startup, disable the competing
`com.ollama.ollama` user login/background service and verify its actual state.
Its independent `RunAtLoad` launch can race the hook; a background-startup
checkbox alone does not prove it is disabled. Use the official UI if it can
disable that actual job. Otherwise, the narrow operator override is:

```bash
launchctl disable "gui/$(id -u)/com.ollama.ollama"
launchctl print-disabled "gui/$(id -u)" | sed -n '/"com\.ollama\.ollama" =>/p'
```

The readback must show `"com.ollama.ollama" => true`. This persists across
logins and boots for one user job; it is launchd state, not background-item
approval. The helper neither runs this command nor restores that service.
Do not reset unrelated background items.

Let every local client finish, then use the menu-bar **Quit Ollama** command
and confirm the application, server and listener have stopped. Install the
reviewed hook from the repository root:

```bash
"$BOUNCER_NODE" scripts/macos-ollama-setup.mjs --install --mode login-hook \
  --confirm-origin-setup --confirm-ollama-stopped --confirm-login-item-disabled
```

Installation writes the owned files, preserves finite existing origins,
appends the exact extension origin if absent, and opens the official app
through `open --env OLLAMA_ORIGINS=... -a /Applications/Ollama.app`.
It does not create another app instance or invoke the internal executable.
Within 20 seconds, it requires Ollama 0.40.3, pinned model metadata,
extension-Origin HTTP 200 and outside-union HTTP 403. These are metadata-only
checks and leave zero models loaded by the helper. A responding incompatible
server fails without an automatic restart. An attempted launch failure preserves
applied origins and ownership evidence for review.

Installation writes the plist but does not register it with launchd. After a
successful installation, register the known owned hook for the current user:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.bouncer.ollama-origins.plist"
launchctl print "gui/$(id -u)/local.bouncer.ollama-origins" | sed -n '/state = /p; /last exit code = /p'
launchctl print-disabled "gui/$(id -u)" | sed -n '/"com\.ollama\.ollama" =>/p'
```

The one-shot registration verifies the already compatible running service and
exits; require last exit code zero and the competing job still disabled.
An already registered label needs inspection rather than repeated bootstrap
or forced kickstart. The hook performs no inference and installs no daemon,
proxy, listener, heartbeat or ongoing polling. Finally, use **Retry** or
**Connect to Ollama** in the actual popup and verify worker readiness.
Native helper metadata checks do not establish that browser result.

For manual startup without a login hook, use `--mode manual` for both preview
and installation, omit `--confirm-login-item-disabled`, and skip bootstrap.
The exact-origin, normal-stop, artifact and ownership rules still apply.

## Launch, upgrade and removal

After Ollama has stopped normally with other clients idle, launch through the
owned script using the same selected Node executable:

```bash
"$BOUNCER_NODE" "$HOME/Library/Application Support/Bouncer/OllamaOrigins/macos-ollama-setup.mjs" \
  --launch --confirm-ollama-stopped
```

Then click **Retry** for ordinary connection recovery. The helper also accepts
an already compatible server after verifying it and leaves it running; it
never quits a server. Recheck the competing job's disabled state after fresh
app launch when using login-hook mode.

Update a recognized, unchanged owned installation from the repository root:

```bash
"$BOUNCER_NODE" scripts/macos-ollama-setup.mjs --upgrade
```

Upgrade checks the installed script against its recorded hash and recognized
predecessor. Locked compare-and-swap changes only the launcher and recorded
script hash, preserving installation identity, Node path, plist and
origin/restoration provenance. Unknown, modified or partially updated files
fail closed. Upgrade does not launch the app or change native settings.

Remove the owned setup from the repository root:

```bash
"$BOUNCER_NODE" scripts/macos-ollama-setup.mjs --uninstall --confirm-remove-setup
```

Removal requires unchanged owned files and the expected origin environment.
It undoes only the known origin addition, preserves other origins and removes
owned files. It does not stop Ollama or unregister launchd's completed job.
A running app retains its environment until a later normal launch. After a
successful owned removal, if the known Bouncer label remains registered,
unregister only that label:

```bash
launchctl bootout "gui/$(id -u)/local.bouncer.ollama-origins"
```

Do not remove an unknown or reused label. Independent Ollama startup remains
disabled unless explicitly restored. Restore it only after the Bouncer login
hook is removed and unregistered, so the startup paths cannot race:

```bash
launchctl enable "gui/$(id -u)/com.ollama.ollama"
```

## Interrupted-request recovery

A timed-out, aborted or worker-interrupted generation may still be running.
Bouncer preserves a durable unresolved-work fence and pauses new generation;
saved manual/cache decisions remain available. Browser abort, elapsed time,
ordinary **Retry**, metadata or an empty residency list cannot prove cancellation.
Concurrent-model generation remains disabled, and other resident models defer
automatic work without forced unload.

For the full-process-stop recovery boundary:

1. Let other local clients finish and remain idle.
2. Use **Quit Ollama** normally and confirm the app, server and listener stopped.
3. Reopen through the owned `--launch --confirm-ollama-stopped` command above.
4. In the popup, select **Resume after restarting Ollama** and confirm that the
   full restart completed and other clients are idle.

That explicit confirmation establishes that prior native work stopped.
Metadata validates only the reopened service and artifact. Every subsequent
generation is text-only with fixed sampling, finite budgets, `think: false`
and `keep_alive: "1m"`; cache reads and readiness do not preload it. Another
client sharing the weights can extend residency. Bouncer changes no native
global retention, scheduling or context settings.

## Future pins and license provenance

A runtime or artifact change needs fresh qualification: record exact runtime,
source layers, imported manifest, rendering, context and measured results,
then update the fixed contract and this page together. The measured Q8 package
remains historical comparison evidence, manifest
`8cb19ff6df848ad9b9bf55cea35e47c3d877d3dc2d724a5b5f126fb28398b242`;
it is not a fallback or selectable alternative. Existing LiteRT/Q8 measurements
establish neither native QAT performance nor a battery benefit.

Bouncer preserves upstream attribution and its [AGPL-3.0 license](../LICENSE.txt).
The exact official Ollama source package supplies an
[Apache-2.0 license blob](https://ollama.com/library/gemma4:e2b-it-qat/blobs/0d542e0c8804),
observed 2026-10-13 and identified by the full license hash in the artifact
table. Preparation retains that source material in the imported model.
Consult the exact source license when acquiring or redistributing the artifact;
this provenance statement does not generalize to other Gemma packages.

The historical LiteRT E2B release used
[`litert-community/gemma-4-E2B-it-litert-lm`](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm),
revision `9262660a1676eed6d0c477ab1a86344430854664`, file
`gemma-4-E2B-it-web.litertlm`, 2,008,432,640 bytes, SHA-256
`3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5`.
Its converted repository declared Apache-2.0 and identified Google's Gemma
4 E2B as its base. Historical E4B used
`rishabhf/bouncer-gemma-4-e4b-litert@41a40dee03ce6185fb76bd96294f74561bf87f89`,
2,969,059,328 bytes. Both browser runtimes are retired in this checkout.
[Historical reports and raw data](benchmarks/) preserve their measurements;
reproduce from commit `a590ce0186c89374e904bef599c3f9c51db5b9b2`.

Rollback to the historical browser runtime requires verified artifact bytes or
exact-source reacquisition; git and a storage snapshot do not restore model
bytes. Reconcile newer settings and manual decisions and respect unresolved
native work. Restoring old code does not cancel a native request.
