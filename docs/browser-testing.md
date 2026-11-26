# Human browser check

This is a future manual check of the real extension in Brave or Chrome on
macOS. It has not been completed by the unit suite or the recorded decision-model
evaluation. Use synthetic posts and filters, and record the browser version,
Llama.app version, extension commit and model settings with the result.

## Preparation

Follow [model setup](models.md), build the extension and load `Bouncer/`
unpacked from your browser’s extensions page. Use a fresh test profile and keep
the browser sandbox enabled. Confirm the required X and
`http://127.0.0.1:9931/*` permissions. Cancel unexpected authentication prompts.
Do not change an installed everyday profile for this check.

## Checks

1. Open settings with no posts to evaluate. Confirm the fixed Llama.app status
   is shown. Model-list checks must leave weights unloaded.
2. Add a descriptive filter and present synthetic matching and nonmatching
   posts through the real X controls. Confirm matching posts appear in
   **View filtered** with the exact matched phrases. Images may appear in the
   panel but must not enter inference.
3. Observe requests from the actual extension worker. Readiness must use only
   `GET /v1/models`, and classification must use only `POST /v1/systemone` at
   the fixed loopback endpoint. Classification state must contain only the
   post's own text and request questions must correspond to the active filters.
   For a post quoting a rude post, verify the quote still displays in the panel
   but is absent from state, Details and copied JSON. Bare quotes and media-only
   posts without own text must stay visible without classification; a quoted
   post appearing separately must be evaluated on its own words. An
   ordinary-page request does not verify the extension worker.
4. Make Llama.app unavailable during a synthetic test. The affected post must
   remain visible, and automatic filtering must remain enabled. Reopen the app
   and verify a later eligible post can classify.
5. Exercise Bounce, including a duplicate phrase, and the missed-filter action.
   Confirm each hides the selected post without inference. Restore must show
   the post only after its saved override succeeds; a failed save must retain
   the hidden post and offer a retry.
6. Check filter edits, cache hits, pause/resume, navigation and worker recreation.
   Explicit decisions must win over late automatic answers, and stale work must
   not alter the new page. Compatible cache hits must avoid native readiness
   and classification calls.
7. Add ten active filters, then try an eleventh through settings and Bounce.
   Confirm the limit is clear and existing filters remain intact. A duplicate
   Bounce phrase should still hide its selected post.
8. Check the popup, X controls and filtered panel in X’s light, dim and dark
   themes. Verify keyboard access and readable status/error text.
9. Open a filter's popover in the X sidebar and mobile/bottom filter box.
   Confirm Standard is the default, Strict applies only to that filter and its
   pill appears only while Strict is selected. Escape and Done return focus to
   the phrase; an outside click preserves focus on the clicked control. Removing
   the filter moves focus to the input. Confirm a long phrase scrolls inside
   the popover and both segments retain keyboard focus while saving.
10. With saved automatic scores and live posts, switch a filter between
    Standard and Strict. Confirm cached and live automatic decisions are
    rejudged, exact matched phrases update, and missing scores are evaluated
    when needed. Confirm explicit Bounce, missed-filter and Restore decisions
    stay unchanged, including across worker recreation.

Record what was actually observed, including failures and any debugger
instrumentation. Stop test sessions you started when finished. Keep synthetic
fixture checks, recorded model results and unit passes distinct from live-feed
qualification.

## Local UI harness

`scripts/ui-harness/` runs the built content scripts on a local X-shaped page
with 40 synthetic posts, a stand-in for X's post store and stubbed extension
APIs. Use it to reproduce and check feed UI such as Bounce, the filter box,
popovers and hiding, without X, a browser profile or Llama.app:

```bash
(cd Bouncer && npm run build)
node scripts/ui-harness/serve.mjs   # http://127.0.0.1:4177/home
```

Every post stays visible unless `bouncerHarness.classify` is replaced from the
page console, and `bouncerHarness.messages` records what the content script
sent to the worker. The stub worker keeps the real filter limits but nothing
survives a reload: there is no evaluation cache, so Bounce and Restore are not
remembered and post Details are empty. The page copies X's desktop layout, not
its narrow layout with the bottom bar. The harness does not run the background
worker, the model or the real X page, so it does not replace the checks above.
