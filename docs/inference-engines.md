# Choosing where Bouncer runs

**You choose the engine.** Settings asks **Where should Bouncer run?** and
offers **In your browser** (LiteRT-LM, recommended) and **On this Mac** (Ollama).
Both run a fixed text-only Gemma 4 E2B artifact locally. They use different
packages, prompts and classifier fingerprints, so answers can differ.
The recommendation is a starting point, not a saved choice or fallback rule.

| Scenario | What happens | Your action |
|---|---|---|
| Fresh or ambiguous profile | No engine is committed; Browser is recommended. Automatic filtering waits. | Choose a card, then its explicit Use or Download action. |
| Upgrade with a valid earlier Browser preference | Browser remains selected; compatible fixed E2B cached weights are preserved. Old automatic verdicts without the current fingerprint are re-evaluated. | Use the selected engine; download explicitly if weights were removed. |
| Upgrade after completed native cutover | Ollama remains selected. A valid newer explicit choice takes precedence over older markers. | Keep it or explicitly choose Browser. |
| Preview the other card | The preview differs from the committed engine. No transfer, GPU initialization or native readiness starts. | Use its explicit action to commit it. |
| Commit an engine | The preference is saved and read back before setup. Setup failure or cancellation preserves the choice. | **Use browser AI**, **Download & use browser AI**, or **Use Ollama**. |
| Switch engines during work | Old verdicts/suggestions are retired, browser downloads are canceled, and known native work drains. Automatic feed decisions are restored and re-evaluated; manual decisions remain. | Wait for the selected engine's status; settle any native recovery block. |
| Browser weights missing | No post or suggestion triggers download. | **Download browser model**; first choice may offer **Download & use browser AI**. |
| Browser cache status still unknown | **Use browser AI** commits the choice without assuming a download is needed. | Use the subsequent explicit Download action if status reports missing weights. |
| Browser download running | Progress reports the fixed model transfer; hashing checks size and SHA-256 before completion. It does not load the GPU or send posts. | Wait or **Cancel**; canceled bytes cannot become a replacement ready model. |
| Change tabs, pause filtering or edit filters during a Browser download | The explicit model download continues independently of automatic inference. | Return to Settings for progress, or **Cancel**. Choosing another engine cancels the transfer. |
| GPU preparation canceled | Browser remains selected, downloaded files stay saved and automatic preparation pauses. | **Retry browser AI** when ready; Retry itself does not preload. |
| Download failed or canceled | Browser remains selected. No native fallback or background replacement download occurs. | Retry the explicit download when ready. |
| Saved Browser weights, cold runtime | Settings reports saved weights without loading the GPU. Actual initialization verifies bytes before the next real request. | Continue using Bouncer; no setup load is required. |
| Offline after Browser download | Verified saved weights and bundled runtime can infer locally if Chrome/WebGPU work. X itself still needs its network to load a feed. | Reconnect only if weights are absent or the feed needs it. |
| No usable GPU or Browser initialization failed | Automatic generation waits or reports the Browser error; the preference stays Browser. | **Retry browser AI** after fixing support, or explicitly choose Ollama. |
| Browser cache evicted or integrity invalid | Automatic generation waits for setup; invalid saved bytes are rejected. | Explicitly download again. |
| Delete Browser weights | Bouncer deletes its owned saved model entries and retains Browser preference, filters and manual decisions. It does not delete native models. | **Delete downloaded browser model**, then explicitly download if needed later. |
| Browser worker recreated during a download | The chosen Browser download continues; its progress and completion are reconciled only while active. | Wait or Cancel. Choosing Ollama stops the inherited transfer. |
| Browser worker recreated during GPU work | Bouncer closes the orphaned owned GPU host and retains downloaded files. | The next eligible request reloads locally; no replacement download starts. |
| A request arrives as Browser releases idle memory | The request waits for cleanup, then loads the saved model. | Continue normally; idle teardown does not require Retry. |
| One minute idle | Browser releases its runtime and retains weights. Ollama requests one-minute retention; other clients can extend its shared residency. | The next real request loads again as needed. |
| Ollama has no connection permission | No post is sent to the native service. Permission is optional and exact loopback only. | With Ollama selected, **Connect to Ollama** and allow the local connection. |
| Native permission changes while Browser is selected | Browser keeps its selected work; the permission event does not probe Ollama or preempt Browser. | No action unless using explicit native recovery. |
| Ollama stopped or inaccessible | Native automatic work waits; manual and compatible cached decisions remain usable. | Start the prepared app normally, then **Retry**. |
| Ollama rejects the extension Origin | A successful GET cannot establish worker POST access. | Follow the [exact-origin operator recipe](models.md#install-exact-origin-startup) after actual worker rejection. |
| Native artifact or runtime changed | Generation is blocked before post transmission. | Follow [fixed model preparation](models.md#prepare-the-text-only-model); never bypass identity checks. |
| Another native model is resident | Ollama automatic work defers; Bouncer does not unload another client's model or change native global settings. | Let other work finish, then use a later eligible action or **Retry**. |
| Native request outcome unresolved | A durable block prevents replacement generation through either engine, including Browser. Abort, elapsed time, Retry and empty residency do not settle it. | Follow [native restart recovery](models.md#interrupted-request-recovery), then **Resume after restarting Ollama**. |
| Recover while Browser is selected | Explicit native recovery validates the restarted native service without changing the committed Browser choice. | Complete the qualified operator procedure; resume Browser afterward. |
| Either engine unavailable | Manual Bounce/Restore and saved compatible decisions remain available. | Keep using explicit decisions or complete the selected engine's setup. |
| Request filter suggestions | Suggestions use only the selected ready engine. Missing setup never causes download or fallback; stale suggestions are retired on switch. | Edit your own phrase and use manual Bounce when suggestions are unavailable. |

Selecting Browser cannot cancel a native request that already reached Ollama.
Switching therefore keeps the global native recovery block until an owned
terminal response or the qualified full-process restart establishes settlement.
The extension never starts, restarts, configures, force-unloads or deletes from
the shared native service.

## Local inference and downloads

Browser weights come only from the fixed revision-pinned Hugging Face URL after
an explicit Download action. Transfer size and SHA-256 are verified in a
backpressured stream, and saved bytes are verified before GPU loading. The
LiteRT SDK and normal/compat WASM runners are bundled in the extension and run
in an on-demand offscreen host. The download server receives a model request;
it receives no post or filter text.

Ollama receives text only at `http://127.0.0.1:11434`, after optional host
permission and exact runtime/model metadata validation. Its model preparation
and native source acquisition are separate operator actions. Preserve local
binding, cloud-disabled settings and other clients' existing configuration.
Images and video bytes go to neither inference path. X's own network activity
and image display remain part of browsing X.

Automatic cache identity includes the selected artifact, prompt/parser and
budgets. A Browser verdict is not reused as an Ollama verdict or vice versa;
manual hide/restore decisions keep the same ownership across both choices.
Changing engines does not clear the filter list or create a second manual
override store.

## Evidence limits

Historical LiteRT normal-page tests measured the fixed E2B artifact and core
0.17.0, and dated native tests measured the fixed QAT artifact. Their quality
and timing results are bounded manual evidence, not a guarantee of identical
answers, universal speed or energy savings. The native replay corpus is not
published. New engine choice, streaming integrity and integrated offscreen
switching/idle behavior remain unqualified in actual Chrome until recorded in
the [qualification report](benchmarks/ollama-qualification.md).

See [fixed artifacts and setup](models.md) for sizes, hashes, licenses and the
optional Ollama preparation, startup, upgrade/removal and recovery recipes.
