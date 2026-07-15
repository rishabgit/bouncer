# Gemma 4 E2B replacement evaluation

Upstream Bouncer added Gemma 4 E2B as a smaller LiteRT model. This fork keeps
it as a **development-build evaluation candidate only** until it demonstrates
that the size reduction does not weaken the local X classifier or the
generation paths used by “Bounce this tweet.” Production builds do not expose
or download it.

## Pinned candidate

| | |
|---|---|
| Source | `litert-community/gemma-4-E2B-it-litert-lm` |
| Revision | `9262660a1676eed6d0c477ab1a86344430854664` |
| File | `gemma-4-E2B-it-web.litertlm` |
| Size | 2,008,432,640 bytes (1.870 GiB) |
| LFS SHA-256 | `3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5` |
| Declared license | Apache-2.0 |

The shipped E4B file is 2,969,059,328 bytes, so E2B is 960,626,688 bytes
(32.35%) smaller. That is a worthwhile product improvement only if behavior is
at least as good. Vendor performance figures are not treated as Bouncer
evidence.

The source repository does not publish a fully reproducible conversion command
or an exact base-model revision. Before production adoption, copy the artifact
to a fork-owned mirror with the source revision, checksum, license, and model
card, then use a revision-pinned mirror URL just like the shipped E4B model.

## Run the comparison

The candidate is included only by the development build:

```bash
cd Bouncer
npm run build:dev
```

Load `Bouncer/` unpacked in Chrome, download both Gemma models from the popup,
then open:

```text
chrome-extension://<actual-extension-id>/benchmark.html
```

Run and export both latency and accuracy for E2B and E4B on this same build.
Use three warmups and twenty timed latency iterations. The accuracy corpus runs
40 rows × four variants × three repetitions per model. Close or idle X tabs so
ordinary filtering does not contend for the engine.

The extension benchmark page is a manual checkpoint because Chrome automation
cannot currently control `chrome-extension://` pages.

## Adoption gate

Do not compare a corrected E2B run with an older E4B export. For contemporaneous
baseline results, require all of the following:

- E2B has no more false negatives than E4B.
- E2B has no more false positives than E4B.
- E2B has zero unstable rows and zero malformed verdicts.
- No E2B median, p95, cold load, or first inference is more than 10% slower.
- Neither run has a GPU loss, runtime error, or missing row.

If false positives and false negatives trade off, the result is “no clear
winner.” Quality parity plus the 32.35% size reduction is enough to prefer E2B;
headline speed claims are not required.

The current rage-bait corpus covers classification only. Before removing E4B,
also add fixed suggestion-generation fixtures and require nine unique 1–3 word
candidates, at least one negative-tone or content-quality label, at least three
valid batch-checked suggestions, and no malformed/runtime errors. Future
filter-interpretation or structured-feedback use needs its own capability eval;
model readiness alone is not evidence that those operations are safe.
