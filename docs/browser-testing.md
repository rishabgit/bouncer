# Browser testing on macOS

Use synthetic data and the actual built extension. Choose a browser connection
for the behavior being checked, keep the browser sandbox, and treat an unexpected
authentication prompt as evidence to investigate. A quiet launch is not proof
that every later action will be prompt-free.

## Choose the test surface

| Surface | Good use | Limits and ownership |
| --- | --- | --- |
| Existing, authorized browser connection | Inspect the installed extension or a specifically authorized tab/origin with minimal setup | Existing profile state cannot prove fresh installation or first-grant behavior. Selecting a tab is not process isolation. Disconnect afterward; preserve the owner's browser. |
| Disposable Playwright persistent context | Repeatable MV3 UI, messaging, storage, synthetic feed and permission-state checks | Prefer Playwright's paired Chromium. Launch defaults and instrumentation affect fidelity. Close the owned context/browser. |
| Direct Chrome for Testing (CfT), disposable profile | Headed browser chrome, genuine permission UI and a conservative uninstrumented idle baseline | Requires native UI/manual interaction for browser-owned controls. A separate recipe must be qualified against the selected binary. Quit only the process launched for the test. |

Reuse a connection only when it already exists and its exact scope is authorized.
Do not install a connection extension or enable remote debugging on a daily
profile as an incidental testing step. Playwright's CDP attachment has lower
fidelity than its native protocol. Where supported, `noDefaults: true` avoids
attachment-time context overrides; it does not remove instrumentation. Check
the connection API's close/disconnect semantics before cleanup.
[Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype)

For command-line extension loading, use paired Chromium or CfT. Ordinary
Google Chrome removed `--load-extension` in Chrome 137 and
`--disable-extensions-except` in Chrome 139; manual **Developer mode → Load
unpacked** remains available. Ordinary Chrome 136+ requires a non-default data
directory for remote-debugging switches; CfT retains automation support.
[Chrome extension announcement](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/FxMU1TvxWWg/m/daZVTYNlBQAJ),
[remote-debugging changes](https://developer.chrome.com/blog/remote-debugging-port)

## Disposable launch recipes

Use an already approved installation. Review any required download or
dependency change under the current task authorization; these recipes grant no
access to real accounts. Build Bouncer using its normal
project workflow before loading `Bouncer/`.

Playwright requires a persistent context for extensions. An empty data-directory
argument creates temporary storage. Start with its paired Chromium and inspect
the effective argv; using an arbitrary `executablePath` needs separate
compatibility qualification.
[Extension guide](https://playwright.dev/docs/chrome-extensions),
[launch API](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)

```js
import { chromium } from 'playwright';
import path from 'node:path';

const extensionPath = path.resolve('Bouncer');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: false,
  chromiumSandbox: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    '--use-mock-keychain',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});
try {
  // Run the explicitly scoped synthetic scenario.
} finally {
  await context.close();
}
```

Verify Developer mode through the normal extensions UI before relying on
extension-page navigation; confirm the toggle state instead of blindly
clicking it on every relaunch. Do not edit profile files to enable it.

Qualify `chromiumSandbox: true` on the chosen build. If launch fails, investigate
the failure; do not silently fall back to `--no-sandbox`. Preserve other defaults
unless a particular scenario justifies a reviewed change; do not use
`ignoreDefaultArgs: true` to chase prompts.

The inspected Playwright launch path supplies `--use-mock-keychain`,
`--password-store=basic`, remote-debugging pipe transport, and background/timing
flags. It otherwise disables Chromium's sandbox unless requested. On macOS,
`--use-mock-keychain` is the relevant OSCrypt substitution;
`--password-store=basic` is not a replacement for it. Background timer,
occlusion and renderer flags can change focus, throttling and latency behavior.
Other defaults also change browser protections and background services; this
configuration does not qualify normal-browser security behavior.
[Pinned default switches](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/chromium/chromiumSwitches.ts),
[launch implementation](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/chromium/chromium.ts)

For an uninstrumented CfT baseline, the following is a **recipe to qualify
against the selected binary and profile**. Set the placeholder to the approved
executable. Run from the repository root and retain the temporary directory's
exact identity for cleanup.

```sh
BOUNCER_CFT='/path/to/approved/ChromeForTestingExecutable'
BOUNCER_EXTENSION="$(pwd)/Bouncer"
BOUNCER_TEST_PROFILE="$(mktemp -d)"
"$BOUNCER_CFT" \
  --user-data-dir="$BOUNCER_TEST_PROFILE" \
  --use-mock-keychain \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --disable-component-update \
  --disable-extensions-except="$BOUNCER_EXTENSION" \
  --load-extension="$BOUNCER_EXTENSION" \
  about:blank
```

This recipe keeps the sandbox and omits remote debugging and
`--password-store=basic`. Its background-network flags reduce incidental work;
they are not a network access boundary. If a separate CDP scenario needs a TCP
endpoint, bind it to loopback with an ephemeral port and the owned profile.
Read only that launch's endpoint; never discover or attach to another process's
debugger. Playwright's normal pipe does not expose a TCP listener.

## Profile isolation and mock Keychain

A separate profile isolates cookies, history and extension state, **not the
macOS Keychain**. The audited Chromium startup path initializes an OSCrypt key
provider that can query Safe Storage before any meaningful page is visited,
including an `about:blank` launch. A new profile therefore does not eliminate
this authentication hypothesis.
[Startup registration](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.39/chrome/browser/browser_process_impl.cc#1663),
[key provider](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.39/components/os_crypt/async/browser/keychain_key_provider.mm#34)

For that provider, `--use-mock-keychain` substitutes a local fake Keychain with
fixed test key material; OSCrypt still encrypts data. The switch is not a global
block on every Keychain consumer, such as client certificates or WebAuthn.
Source branding selects the Safe Storage service: CfT uses the Chromium
branding path, while ordinary Google Chrome uses Chrome branding. Do not infer
the service name from a bundle identifier alone.
[Keychain password implementation](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.39/components/os_crypt/common/keychain_password_mac.mm#34),
[fake Keychain implementation](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.39/crypto/apple/fake_keychain_v2.mm#58)

Use mock mode only with synthetic MV3 UI, storage, host-permission and lifecycle
fixtures. It cannot establish real Keychain ACL/unlock behavior, saved-password,
passkey, client-certificate, encrypted-profile interoperability or security
properties. Tests needing real credentials require separate scope and owner
handoff. Never copy a daily profile into the harness. Keep mock/real mode
consistent on every launch of a reusable test profile. A claim that switching
modes invalidates encrypted preference hashes remains a hypothesis until
reproduced; do not diagnose a failed prepared-profile load from that assumption.

## Minimum permissions and genuine grants

Unpacked installation through Developer mode and Load unpacked needs no
administrator or Keychain credential grant. Extension `storage` does not need
one either. CLI Playwright browser control does not itself require macOS
Accessibility or Screen Recording. Native UI automation may require
Accessibility; screen capture may require its corresponding macOS permission.
Authorize those capabilities only for a scenario that actually needs them.
[Chrome development workflow](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug),
[Apple Accessibility controls](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac)

Bouncer declares mandatory X access, `storage`, and optional
`http://127.0.0.1:11434/*`. Exercise the product's **Connect** click and Chrome's
genuine **Allow** or deny action. Use a fresh profile for first-grant UI;
revoke/regrant alone may restore access without another prompt. Playwright
`context.grantPermissions()` grants supported web-page capabilities, not
extension optional hosts. Do not edit profile preferences or invoke internal
`developerPrivate` methods to manufacture a grant.
[Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)

Keep the exact declared loopback pattern. Host-permission paths are ignored;
an explicit port constrains matching, while an omitted port is a wildcard.
Do not widen it to all localhost ports or `<all_urls>` for convenience.
`activeTab` access to an X page does not grant loopback access. Browser host
permission, extension CSP and Ollama's allowed Origin are separate checks.
A successful GET or ordinary page fetch cannot establish Bouncer's worker POST.
[Match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns),
[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

## Coverage and lifecycle evidence

| Scenario | Required evidence |
| --- | --- |
| Synthetic X behavior | Actual content scripts, bridge, themes, filter edits, same-document navigation, suggestions and manual Bounce/Restore persistence; no real account/feed needed. |
| First Connect, deny, grant and revoke/regrant | Genuine product gesture and browser grant, worker metadata POST, readiness after popup closure, no inference prewarm. |
| Toolbar popup, focus or side panel | Headed browser-owned UI, closure and focus transitions. Opening `popup.html` in a tab checks document content, not toolbar popup behavior. |
| Idle worker and recreation | Quiet interval, worker absence before wakeup, then new execution context on real work. Record instrumented and uninstrumented results separately. |
| Interrupted native work | Durable unresolved-work fence and qualified recovery from `docs/models.md`; fetch abort is not proof of server cancellation. |
| Quality, latency or energy | Separate datasets and methods. UI/lifecycle correctness or faster inference does not establish an energy saving. |

Chrome normally terminates an idle MV3 worker after about 30 seconds, subject
to lifecycle exceptions. An open worker DevTools inspector prevents ordinary
idle termination. Chrome's specific `chrome.debugger` API attachment keeps its
extension worker alive on supported versions; this is not proof that every CDP
attachment does so.
[Chrome lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle),
[debugging guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug)

Current Playwright documentation explicitly describes MV3 suspension/restart
while preserving the same `Worker` handle and emitting no new `serviceworker`
event. Handle identity or lack of a new event therefore cannot prove the worker
stayed alive. A custom browser/package combination may behave differently;
measure it rather than treating the documented behavior as a local result. During idle, close the popup/inspector and avoid worker evaluation,
runtime messages, polling or heartbeats. After a bounded quiet interval, inspect
`chrome.runtime.getContexts()` from an extension renderer to establish absence
before sending the real wakeup operation, then verify new worker execution.
Account for the renderer itself in the context readback. Direct no-CDP launch
is a conservative baseline, not universally superior coverage.
[Playwright idle behavior](https://playwright.dev/docs/chrome-extensions#service-worker-idle-suspension-mv3)

## Unexpected-prompt triage

Cancel or deny an unexpected authentication dialog. Privately record requester,
item or authorization right, requested action, time, triggering command/effective
argv, tool/browser version and executable signing identity. Capture no secrets
and avoid screenshots exposing unrelated private content. Inspect process
metadata and the relevant command/source before proposing another attempt.
Do not select **Always Allow**, alter Keychain ACLs, reset security databases or
repeat a prompt-producing command solely to research it.
[Apple Keychain prompts](https://support.apple.com/guide/keychain-access/if-youre-asked-for-access-to-your-keychain-kyca1243/mac)

For a known, owned LaunchAgent, prefer narrow `launchctl print
gui/<uid>/<owned-label>` diagnostics. Read `launchctl print-disabled gui/<uid>`
only when the disabled override is relevant; it does not prove background-task
approval. Apple documents
`sfltool dumpbtm` for background-task diagnostics, but it may internally require
administrator authorization even without `sudo`. Plain read-only intent does
not guarantee no authentication. Do not rerun it without a concrete need and
authorization; never use `sfltool resetbtm` for this investigation.
[Apple background-task diagnostics](https://support.apple.com/guide/deployment/manage-login-items-and-background-tasks-depdca572563/web)

## Startup, cleanup and upgrade checks

Before launch, identify the owned binary/profile, built extension bytes, allowed
origins, synthetic fixtures, required UI capabilities and finite scenario. Check
effective argv, sandbox and mock mode. Keep machine-specific observations in a
private qualification record, separate from reusable product documentation.

Afterward, close an owned Playwright context or normally quit the exact owned
CfT process; disconnect from an existing connection. Confirm owned processes
and any owned listener stopped before removing only the disposable profile and
synthetic artifacts. Preserve the owner's browser, other services and profiles.

On upgrades, recheck source/default-flag changes, executable identity, paired
browser compatibility and sandbox launch; repeat mock storage round-trip,
first-grant/deny/revoke checks, actual worker POST and worker idle/recreation.
Label source-audited expectations, observed results and remaining hypotheses
separately. No launch flag or previous successful run guarantees that future
macOS prompts are impossible.
