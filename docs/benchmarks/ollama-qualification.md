# Native Ollama qualification — 2026-10-12–13

The fixed text-only E2B QAT artifact passes the recorded synthetic filtering,
suggestion, speed, charged-memory and native idle gates. Its exact production
digest is accepted. This report separates those measurements and the
2026-10-12 Chrome checks from the 2026-10-13 startup correction.

## Draft release gates

| Gate | Recorded status |
|---|---|
| Fixed classifier quality, latency, loading and expiry | Passed in the 2026-10-12 qualification below |
| Actual Chrome Connect/grant/regrant, generation, worker lifecycle, recovery and synthetic X controls | Passed before the launcher correction, with unchanged classifier/request contracts |
| Corrected launcher fresh-app metadata and registered-job readback | Passed 2026-10-13: qualified runtime, pinned model, exact-Origin HTTP 200, foreign-Origin HTTP 403, zero model residency |
| Fresh actual Chrome-worker metadata request after the launcher correction | Not established |
| Successful subsequent normal-login startup with the corrected launcher | Not established |

Keep the migration PR in draft until the last two gates are recorded. Launcher
metadata checks alone cannot establish actual Chrome-worker access or future
login behavior. See [operator setup and recovery](../models.md).

## Fixed artifact and method

The fixed artifact is Gemma 4 E2B Instruct QAT Q4_0, with text weights SHA-256 `3646b4c147cd235a44d91df1546d3b7d8e29b547dbe4e1f80856419aa455e6fd`, 3,349,514,112 bytes. The verified text-only import manifest is `fbc40c82cb8acd3f63077d417d6040a42b5aeac406ed078fa8ba888fb38cfc19`. Import reuses existing weights, omits projector/draft layers and preserves other installed tags. See [artifact identity](../models.md).

Tests ran on an M5 Pro / 64 GB Mac, Ollama 0.40.3 and matching Chrome for Testing 155.0.8059.39 in a separate synthetic profile. Native classification uses numbered categories, strict parsing, `think:false`, `stream:false`, temperature/seed zero, context 1024 and one-minute retention. Final requests explicitly set `truncate:false` and `shift:false`. The [pinned request contract](https://github.com/ollama/ollama/blob/v0.40.3/api/types.go) supports these refusal flags; an actual oversized Unicode request estimated at 620 tokens was rejected with HTTP 400 for 1,107 actual tokens rather than silently shortened. Production treats this conservatively as unresolved native work.

The new 120-post corpus was independently authored and reviewed before inference: 40 rage cases plus 20 broad cases each at 1/3/5/10 filters, yielding 420 filter answers. Three repetitions test stability, not 360 independent posts. Corpus SHA-256: `354e80566fdf889e213aec9072387c42f8286a48347379b1142073cba3fa4e27`. Previously observed 160 posts remain regression data.

These corpus hashes record manual qualification evidence. No public replay dataset for the native
120-post, 160-post or 12-fixture runs is shipped, and CI does not replay these
model-quality evaluations. The numbers below are recorded measurements, not a
publicly reproducible CI benchmark.

## Filtering quality

| Stack | Correct hide/show decisions /120 | Every filter answer correct /120 | Correct individual answers /420 | False hides | Missed hides |
|---|---:|---:|---:|---:|---:|
| Text-only QAT, final refusal flags | 119 | 115 | 414 | 0 | 1 |
| Q8 reference | 120 | 117 | 417 | 0 | 0 |
| LiteRT baseline | 118 | 110 | 402 | 2 | 0 |

All repetitions were stable, with no missing, malformed or invalid evaluations. QAT has one additional hide/show error, two additional complete-filter errors and three additional individual errors versus Q8, within the frozen 2/3/4 budgets. It improves all three totals versus LiteRT and introduces no additional false hide. The final safety flags preserve the earlier QAT answers. The old 160-post replay scores 156/160 hide decisions, 146/160 complete filter sets and 495/520 individual answers, with three false hides and one missed hide; those are disclosed tradeoffs, not fresh validation.

The Q8 control is the measured combined package, about 5.95 GB. It requests context 1024 but reports effective context 2048; QAT reports 1024. Selecting Q8 for production would require its own text-only artifact qualification. QAT remains the smallest qualified native candidate in this bounded comparison; its 3.35 GB weights are larger on disk than LiteRT’s 2.01 GB artifact.

## Suggestions and speed

The inherited generator forced nine mostly negative labels and produced unsupported criticism of neutral posts. The revised prompt permits neutral topics and zero candidates, requires grounding and distinguishes the poster from quoted or criticized conduct. The parser accepts whole-response `NONE` and enforces one to three words per phrase before the candidate cap. The final UI accepts zero to three validated suggestions and always retains an editable phrase plus manual Bounce/Cancel.

A separate, independently reviewed 12-fixture corpus was frozen before evaluating the new prompt, SHA-256 `eaa41f92252345168b927f0de01acf064551395a0889e72ad58363593e2c9f76`. Six fixtures require at least one useful suggestion so an all-empty generator cannot pass. The prompt’s rendered SHA-256 is `bb59c89862473f81e27a1cf69eb329878af7dcaa453698cfae5345898e72dee2`.

Reviewed suggestion fixtures scored QAT **11/12**, LiteRT **11/12**, Q8 **12/12**. QAT’s known miss describes the incidental craft-fair topics while omitting the hostile pile-on behavior requested by that fixture. No accepted set invents scam, criminality or ideology. The two warm repetitions are identical; all cold sets match the final warm sets. Final QAT has no shape, count or terminal-flow failure.

| Complete suggestion flow | Median | 95th percentile | Maximum |
|---|---:|---:|---:|
| QAT, 24 warm flows | 540.3 ms | 654.6 ms | 655.1 ms |
| LiteRT, 24 warm flows | 1,047.95 ms | 1,505.1 ms | 1,509.2 ms |
| QAT, 12 flows after actual idle expiry | 1,369.15 ms | 1,464.6 ms | 1,464.6 ms |

Every native cold flow waited for actual expiry at 60,030.8–60,061.4 ms after last completion, without an inference heartbeat or forced unload. All complete well below the eight-second cold budget. These are direct normal-page generation/validation flows, excluding production worker metadata and messaging overhead.

Forty distinct-post observations per cell, across two reversed workload orders:

| Workload | QAT median /p95 ms | LiteRT median /p95 ms |
|---|---:|---:|
| Medium, one filter | 87.65 /89.3 | 86.1 /92.9 |
| Medium, three filters | 130.4 /132.5 | 159.3 /173.0 |
| Medium, five filters | 164.6 /176.1 | 217.35 /232.9 |
| Medium, ten filters | 260.2 /275.1 | 372.9 /384.2 |
| Short, three filters | 123.95 /138.4 | 148.9 /159.4 |
| Long, three filters | 141.65 /231.9 | 246.45 /250.0 |

All cells meet the frozen regression allowance of the larger of 10% or 20 ms. One-filter speed is effectively tied. Native prefix reuse helps the long workload; this does not establish a universal real-feed speedup. Final installed-weight first verdict is 971.1 ms; cached LiteRT baseline is 1,279.5 ms. The earlier fresh-profile LiteRT download took about 64.9 seconds and is excluded from installed-cache startup comparison.

## Memory and lifecycle

Charged footprint and resident mappings (RSS) are different gauges. The following sampled peaks subtract each run’s settled unloaded baseline and cover **all Chrome profiles plus Ollama**, with unrelated browser activity remaining a source of noise:

| Workload | QAT peak footprint increase | LiteRT peak footprint increase | QAT peak RSS increase | LiteRT peak RSS increase |
|---|---:|---:|---:|---:|
| Quality | 707.988 MiB | 2,901.003 MiB | 3,956.969 MiB | 2,885.844 MiB |
| Latency | 1,174.911 MiB | 3,696.971 MiB | 4,435.828 MiB | 2,609.203 MiB |

QAT meets the charged-footprint gate; RSS moves in the opposite direction. Do not add GPU/residency metadata to either gauge. The final QAT and paired LiteRT traces record no new swap-ins, swap-outs, compression or pageouts; existing swap remains 0.25 MiB. The earlier Q8 control records whole-host compression/pageouts, without establishing backend causation. These are whole-host observations, not an energy or uniquely attributable memory-pressure measurement. Two of 3,049 cold-run samples have incomplete Ollama readings; every expiry event is complete. Normal-page LiteRT retains allocated memory after disposal, which does not establish production offscreen idle memory.

The real native retention test confirms a second request resets expiry, metadata reads do not, the runner disappears around 60 seconds after the second completion, and later work reloads automatically. Ollama returns to roughly 28 MiB charged listener footprint. Client abort rejection does not prove server compute stopped; the completed full-restart verification below establishes the explicit operator recovery boundary.

The conservative shared-model policy also passed a native API check: one synthetic Qwen request loaded its existing model; the production backend compiled with a test-only candidate pin refused Gemma generation with `other_model_resident`, sending zero Gemma chat requests. Qwen remained resident and expired naturally after 60.3 seconds. This checks deferral, not real Chrome permissions or concurrent-compute behavior; concurrency stays disabled.

## Implementation and review

The replacement removes LiteRT/WASM, browser downloads, offscreen hosting, GPU timers, E4B comparison, model catalogs and retired Firefox/Safari/iOS paths. It preserves the queue, strict parser, explicit decisions, sharing, themes, reply control and 500-snapshot panel. Native storage migration retains all valid settled manual rows, drops old automatic results, verifies readback before markers, and deletes only owned browser model caches. Rollback refuses any unresolved native fence rather than returning an executable old runtime with an inert marker.

Actual Chrome reload in a disposable profile preserved all **702** synthetic manual hide/restore rows and preferences, removed retired automatic/model state and owned caches, retained an unrelated cache, and disposed the old synthetic offscreen document. The new build has no offscreen API permission. Disconnected Retry retained the synthetic unresolved fence. This check used an attached software debugger and does not qualify idle worker lifetime or native generation.

Recorded 2026-10-12 verification: **597 extension tests** and full ESLint/type checking pass. Earlier development/production builds, **17 pure operator-helper tests** and release allowlist checks also pass. The recorded X bundle and final debugger-free lifecycle checks passed as described below. Two independent finders reviewed the stable implementation and focused fixes with unchanged hash/status guards. Review fixes pin CLI import to loopback, refuse truncation/shifting, restrict origin advice, fence whole requests across document/epoch changes, bound complete suggestions to 25 seconds, reject unsafe rollback and prevent deferred startup cleanup from retiring replacement documents. Runtime fixture work also corrected grounded suggestions and phrase shape. Canonical post identity for manual decisions was corrected and covered by **79 targeted tests**, including three review-caused timing/rollback cases.

## Actual Chrome checks — 2026-10-12

Before exact-origin setup, the stable-origin Chrome worker metadata POST
returned **403** while GET health returned **200**. A registered one-shot
`local.bouncer.ollama-origins` hook opened the stopped official app twice,
including after an owned origin-environment reset. Both runs exited with status
zero. The real Chrome 155 worker then received **200**, an unrelated origin
received **403**, and the listener remained on `127.0.0.1`. The subsequent
startup race and correction are recorded separately below.

Actual **Connect to Ollama** used Chrome's normal Allow flow. Optional grant,
revocation and regrant, readiness without prewarming, extension reload,
cold/warm generation and natural one-minute expiry passed. A debugger-free run
observed no worker after 40 seconds; real cold/warm requests completed in
**2,474/121 ms**. After 70 seconds of quiet both worker and native runner were
absent; a later request created a different worker and completed in
**1,496 ms**. No inspector, popup or inference heartbeat kept it alive.

Forced worker loss during generation retained the durable unresolved-work
fence. Ordinary Retry sent **zero** generation requests. A normal full Ollama
stop, with app/server/listener absence confirmed and other clients idle,
followed by the origin-preserving launcher and popup's
**Resume after restarting Ollama** confirmation cleared the fence and allowed
fresh inference. This verifies the full-process-stop recovery boundary;
fetch abort does not establish server cancellation. Concurrent-model
generation remains disabled.

## Synthetic X and worker lifecycle checks — 2026-10-12

The final synthetic X run uses the actual manifest, content scripts, Redux/fiber extraction bridge and native worker. Twelve real generation requests completed with the fixed manifest, text-only contract, credentials omitted, 1024-token context and one-minute retention. Positive/negative classification, exact matched categories, all three themes, rule addition/removal, localized Home and profile/explore navigation, disable/re-enable, and the embedded reply setting pass. The opened conversation main post remains excluded from automatic filtering.

The connected composer completed in 611 ms with two suggestions, preserving the edited draft and manual Bounce control. The disconnected composer finished in 5 ms with no native generation. No-phrase and duplicate-phrase Bounce persist under the same canonical store identity used by automatic evaluation. Both manual hides survive a real reload with native permission revoked; Restore remains visible after a second reload, while the other manual hide remains hidden. These reloads issue zero generation requests.

Source fixes also cover failed Restore ordering, current-rule rollback, fresh retries for queued posts surviving navigation, and bounded genuine store-reader readiness. The store script has a two-second loading limit followed by the existing 200 ms extraction-response limit. Six new adapter regressions failed before that readiness fix and pass afterward.

A copied test profile can retain older registered service-worker bytes even
when extension-resource fetches return new files. Qualification re-registered
the isolated extension using the normal host grant/reload flow and verified
the complete current worker script. No internal permission API was used.

The final fresh-profile permission check confirms that **one Connect → Allow
→ reopen** reaches Ready without a second Connect or prewarming, leaving zero
models resident. The grant event completes bounded metadata verification in the
worker. Revocation invalidates stale completion; a regrant waits for revoked
metadata work to settle before a fresh check. Three real-engine regressions
failed before that fix and pass afterward, including unchanged unresolved
fencing.

The final debugger-free run uses the complete current worker script, verified in the task script cache. After **40,002 ms** of quiet the worker was absent and the native model cold; real cold/warm requests completed in **1,278/112 ms**. After **70,002 ms** of quiet both worker and native model were absent; a later request created a different worker and completed in **1,282 ms**. No inspector, popup, inference heartbeat or controller storage writes kept the worker alive. Native lease, transport, artifact and generation-body contracts remain unchanged. The recorded 2026-10-12 production package contained **16 files /447,566 bytes**, excluding diagnostics and all retired runtime assets.

## Login-startup correction — 2026-10-13

A normal-login observation exposed an origin-access startup race.
Ollama's independent `com.ollama.ollama` user service uses `RunAtLoad` and can
open the app before the Bouncer hook supplies its finite origin union. An
app background-startup checkbox did not establish that this actual job was
disabled.

The corrected operator contract disables and verifies only that user job,
through the official UI or narrow persistent `launchctl disable` override,
including readback after fresh app launch. This is launchd state, not
background-item approval. The launcher preserves finite origin provenance and
explicitly passes `OLLAMA_ORIGINS` through `open --env` to the official app.
A recognized owned installation supports guarded `--upgrade` while preserving
installation identity, selected Node executable, plist and restoration state.

Completion requires the exact qualified runtime and pinned model within
20 seconds: extension-Origin metadata POST **200**, and an Origin outside the
finite union **403**. A compatible running server is verified without reopening;
a responding incompatible server fails without forced restart. No inference is
sent. Attempted launch failure preserves ownership evidence.

Fresh-app qualification of the corrected startup implementation passed those
metadata checks with **zero resident models**. Its installed-launcher
registered-job readback also passed. Later CLI help/argument-validation polish
is covered by pure unit checks; this report does not claim that polished CLI
source was installed or freshly tested against the native application. A fresh actual
Chrome-worker request after the correction and a successful subsequent normal
login are **not established** and remain the draft gates above. Earlier
filtering, permission, loading, retention and recovery results qualify the
unchanged classifier contract; they do not close these post-correction gates.
