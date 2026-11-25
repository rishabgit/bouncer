# Llama.app model setup

Bouncer uses one text-only model: `LiquidAI/d1-2B-GGUF:Q8_0`, from
[`LiquidAI/d1-2B-GGUF`](https://huggingface.co/LiquidAI/d1-2B-GGUF).
The required file is `d1-2B-Q8_0.gguf`. Llama.app serves it through System One
at `http://127.0.0.1:9931`. The extension’s fixed values live together in
`Bouncer/src/shared/decision-model.ts`.

## Set up Llama.app

1. Install [Llama.app](https://llama.app), the llama.cpp team’s macOS menu-bar
   app. You can also install it with Homebrew:

   ```bash
   brew install --cask llama-app
   ```

   Open the app, keep its local API at `127.0.0.1:9931` and enable
   **Launch at login**.
2. Acquire `d1-2B-Q8_0.gguf` in the Hugging Face cache. With the Hugging Face CLI,
   use:

   ```bash
   hf download LiquidAI/d1-2B-GGUF d1-2B-Q8_0.gguf
   ```

   Use the cache layout rather than a separate download directory. Its default
   model path is
   `~/.cache/huggingface/hub/models--LiquidAI--d1-2B-GGUF/snapshots/<revision>/d1-2B-Q8_0.gguf`.
   Llama.app scans the model cache and discovers the model when it starts.
3. Quit Llama.app. Add this section to `~/.config/llama/models.user.ini`, or
   update the existing section without creating a duplicate. Preserve other
   model sections:

   ```ini
   [LiquidAI/d1-2B-GGUF:Q8_0]
   ctx-size = 4096
   parallel = 1
   batch-size = 4096
   ubatch-size = 4096
   no-mmproj = true
   ```

   The file binding comes from Llama.app’s cache scan. Do not add `hf-repo` to
   this section: that setting can start a separate download under `/tmp`.
   Use `models.user.ini` for these overrides; Llama.app regenerates `models.ini`.
   The 4096-token physical batch and microbatch let d1 process the post and its
   questions together.
4. Reopen Llama.app. Confirm that `LiquidAI/d1-2B-GGUF:Q8_0` appears with these
   settings.

Llama.app answers requests from any web origin by default. While it is running,
websites can attempt to reach its local API. Brave asks before allowing websites
to access localhost; review that prompt for the requesting site. Bouncer’s
required extension permission is limited to `http://127.0.0.1:9931/*`.

The operator manages model files and Llama.app settings. Review the model
repository’s license before acquiring or redistributing its files.

## Load Bouncer

Build the extension from `Bouncer/` with `npm ci` and `npm run build`. In Brave
or Chrome, open your browser’s extensions page, enable **Developer mode** and
load `Bouncer/` unpacked. Leave Llama.app running.

Bouncer automatically checks `GET /v1/models` for the exact model ID and the
required `status.args`. This readiness check leaves model weights unloaded.
The next eligible uncached post uses `POST /v1/systemone` for classification.
If the app is unavailable, the model is absent or classification fails, the
affected post stays visible and later posts continue through the queue.
Manual decisions and compatible cached results remain available.

## Quality and limits

The selected operating point is the `matches-category` template with
`probability >= cutoff`: `0.70` for at most three own words in the exact sent
text, otherwise `0.290813258948728`, regardless of filter phrase. To count own
words, remove case-insensitive `https?://\S+` http(s) links, then `@\w+` handles,
and split on whitespace. Count each token containing a Unicode letter or digit
as one own word, exactly as the registered holdout's `ownWords` in
`scripts/decision-eval/tone-label-metrics.mjs`. The counter version is part of
the classifier fingerprint. See the [tone label study](benchmarks/decision-models.md#tone-label-study).
Context/batch/microbatch remain 4096, with one slot and no projector. The recorded
Llama.app version was 0.49.0.

On the two original corpora, d1 returned the exact expected filter vector for
72 of 72 and 119 of 120 posts. The previous Gemma classifier returned 60 of 72
and 110 of 120. These figures count a post as correct only when every filter
decision matches its expected vector.

A fresh behavior corpus covered rudeness, humblebragging, doomposting, hustle
culture, dunking and reply bait. Guided, plain descriptive labels produced 66 errors
across 482 decisions, including 46 false hides; short labels produced 141
errors. Larger decision models did not resolve the problem at acceptable
latency. Tone filters can still overhide or miss posts. Describe what a post
does or is about in plain words, and treat the results as fallible.

A later tone label study found why. d1-2B responds to rude-sounding words more
than to rude acts: posts that swear at things, criticise rudeness, quote an insult
to object to it, or tease friends are often hidden by a rudeness filter, while
polite contempt is usually missed. No tested label wording or question template
changed this. On posts with almost no words of their own, scores mostly reflect
the filter phrase and the @handle rather than the post, which is why such posts
need the higher cutoff above. Details are in the
[tone label study](benchmarks/decision-models.md#tone-label-study).

Quality was evaluated with at most ten active filters. Bouncer enforces that
limit and caps request text to fit the model’s context. Recorded model results
do not establish the extension’s live browser behavior; use the separate
[human browser check](browser-testing.md) for that. The full results, and the
harness for evaluating a future decision model, are in
[the decision-model evaluation](benchmarks/decision-models.md).
