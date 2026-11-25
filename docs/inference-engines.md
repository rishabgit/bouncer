# Local inference

Bouncer uses the fixed `LiquidAI/d1-2B-GGUF:Q8_0` classifier through Llama.app
System One at `http://127.0.0.1:9931`. Follow [model setup](models.md) once;
the extension checks readiness automatically.

The service worker makes only two kinds of local request:

- `GET /v1/models` checks that the exact model ID is available and its `status.args`
  advertise context, batch and microbatch 4096, parallelism one and no projector,
  without loading the model.
- `POST /v1/systemone` sends only the post's own text as `state` and one `noul`
  question per filter, keyed `f0`, `f1`, and so on in filter order. A filter
  matches when its probability reaches its cutoff: **Standard** (the default)
  uses `0.290813258948728`, and opt-in **Strict** uses `0.72`. For at most three
  own words in the sent `state`, excluding http(s) links and @handles, use
  `max(filter cutoff, 0.70)`; Strict stays at `0.72`. See
  [quality and limits](models.md#quality-and-limits).

Model identity, endpoint, question template, rage-bait guidance, cutoffs and
classifier fingerprint are defined in `Bouncer/src/shared/decision-model.ts`.
Requests time out after 25 seconds and use `credentials: "omit"` and
`redirect: "error"`. Content scripts submit typed post/filter operations.
Only the post's own text and filter questions enter classification. Quoted or
embedded post text is never appended; quote data, images and videos remain
available for display in the browser. A bare quote or media-only post with no
own text stays visible without classification. A quoted post appearing on its
own is evaluated on its own text, independently of the post quoting it.

Cache keys use each post's own text, so a verdict previously computed with appended
quoted text is not reused for the new input. Details and Copy details retain
the exact state sent to the model, after input-budget truncation.

Manual decisions and compatible cache entries are read before native readiness.
Changing a filter's strictness rejudges available automatic scores, including
live posts, while explicit Bounce, missed-filter and Restore decisions retain
precedence.
Opening settings, reading the model list, a cache hit or an empty feed leaves
weights unloaded. The first eligible uncached classification lets Llama.app
load the model; Llama.app controls its residency.

Bouncer permits at most ten active filters. Post text has a weighted cap of
1,200: ASCII UTF-16 code units count as one, and non-ASCII code units count as
two. Truncation preserves surrogate pairs. The cap shrinks further when the
filter questions need more room, so the combined state and question instructions
stay within a 3,072-byte text budget. Filter questions that exceed that budget
are rejected locally. These input limits are part of the classifier fingerprint.

A transport failure, timeout, missing model, malformed answer or
`response.truncated: true` leaves the affected post visible. A successful answer
must include exactly one finite probability in [0, 1] for every requested
filter. Later posts continue through the queue. Explicit pause stops automatic
filtering, and navigation, pause or a manual decision invalidates stale
automatic results.

Bounce adds a required phrase and persists the selected post’s hide in one
serialized action. The missed-filter action uses a saved filter. Restore waits
for its cache override before showing the post. These actions require no model
request, and their decisions take precedence over automatic classification.
