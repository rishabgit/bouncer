import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { renderGuidanceFresh } from '../guidance-report.mjs';

const RESULT = 'decision-guidance-fresh-result.json';
const SUMMARY = 'decision-guidance-fresh-summary.json';
const VARIANT = 'llama-d1-2b-q8';
const MODEL = 'LiquidAI/d1-2B-GGUF:Q8_0';
const CUTOFF = 0.290813258948728;
const TEMPLATE_HASH = '9a1e023c41c8c19c37317953ae8d7b486ec088070ce00abadd4809242eb67f54';
const STYLES = ['short', 'guided', 'guidedExclusion'];
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const rule = {
  version: 1, primaryMode: 'single', population: 'All post/filter pairs, excluding pairs named in post.ambiguousFor',
  nearMissPopulation: 'Negative-gold eligible pairs on posts tagged near-miss, including cross-filter pairs',
  ownNearMissDiagnostic: 'Negative-gold eligible near-miss pairs whose filter equals post.authoredFor',
  subtlePositivePopulation: 'Positive-gold eligible pairs on posts tagged subtle-positive',
  bouncedPopulation: 'Each own-intent positive post, using its own single-filter label',
  guidance: { errors: 'guided.errors < short.errors', nearMissFalseHides: 'guided.nearMissFalseHides <= short.nearMissFalseHides' },
  exclusion: { nearMissFalseHides: 'guidedExclusion.nearMissFalseHides <= guided.nearMissFalseHides', missedHides: 'guidedExclusion.missedHides <= guided.missedHides + 1' },
  nearMissComparison: 'Aggregate false-hide counts; newly introduced and repaired false hides are reported separately, not gated',
  diagnostics: 'AUC, best cutoffs, six-filter interference, request cost and bounced-post checks are not gated',
  noRetuning: true, noRelabelling: true, noReruns: true,
};

async function fixture({ failing = false } = {}) {
  const scratch = new URL('../.tmp/', import.meta.url);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(new URL('guidance-report-test-', scratch));
  const save = (name, value) => writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  const corpusBytes = await readFile(new URL('../corpora/guidance-fresh-2026-11-25.json', import.meta.url));
  const corpus = JSON.parse(corpusBytes), intents = ['all', ...corpus.intents.map(intent => intent.id)];
  const runtimeSettings = { runtime: 'llama', version: '0.49.0', build: 'synthetic', effectiveContext: 4096,
    parallel: 1, batch: 4096, ubatch: 4096, projector: false, runner: 'llamacpp', quantization: 'Q8_0', aliasDefinition: null };
  const identity = { sha256: 'a'.repeat(64), file: 'synthetic.gguf' };
  const selection = { schemaVersion: 2, phase: 'discovery', frozen: true, variantId: VARIANT,
    templateId: 'matches-category', templateHash: TEMPLATE_HASH, cutoff: CUTOFF,
    identityHash: hash(JSON.stringify(identity)), runtimeSettings };
  const registration = { corpus: { file: 'scripts/decision-eval/corpora/guidance-fresh-2026-11-25.json', sha256: hash(corpusBytes) },
    model: { variantId: VARIANT, model: MODEL, identityHash: selection.identityHash, selectionSha256: hash(JSON.stringify(selection)) },
    runtimeSettings, templateId: selection.templateId, templateHash: TEMPLATE_HASH, cutoff: CUTOFF, rule,
    schedule: { seed: '0x6b0b2026', singleRequests: 1512, multiRequests: 252, totalRequests: 1764 } };
  const protectedBytes = '{"synthetic":"fixed prior evidence"}';
  const result = { schemaVersion: 1, phase: 'fresh-guidance', status: 'complete', registeredAt: '2026-11-25T01:00:00.000Z',
    registration, registrationSha256: hash(JSON.stringify(registration)), startedAt: '2026-11-25T01:01:00.000Z',
    finishedAt: '2026-11-25T01:02:00.000Z', environment: { node: 'synthetic' }, runtimeSettings,
    corpusSnapshot: corpus, requestsIssued: 1764, activeRequest: null,
    // Opaque synthetic receipts: the renderer must use saved scores, not classify these probabilities.
    requests: Array.from({ length: 1764 }, (_, index) => ({ index, probabilities: [0.999] })),
    protectedHashes: { 'docs/benchmarks/data/decision-synthetic.json': hash(protectedBytes) } };
  const metric = (mode, style, intentId) => {
    const pairs = corpus.posts.flatMap(post => corpus.intents.filter(intent => intentId === 'all' || intent.id === intentId)
      .map(intent => ({ post, id: intent.id })));
    const eligible = pairs.filter(({ post, id }) => !post.ambiguousFor.includes(id));
    const near = eligible.filter(({ post, id }) => post.kind === 'near-miss' && !post.gold[id]);
    const positives = eligible.filter(({ post, id }) => post.gold[id]).length;
    const multiplier = intentId === 'all' ? 6 : 1;
    const falseHides = !failing && style === 'short' ? multiplier : 0;
    const missedHides = failing ? style === 'guidedExclusion' ? multiplier : 0
      : style === 'short' ? multiplier : style === 'guidedExclusion' && ['all', 'rudeness'].includes(intentId) ? 1 : 0;
    const interval = { lower: 0.1, upper: 0.9, width: 0.8, lowerInclusive: false, upperInclusive: true };
    return { mode, style, intentId, n: eligible.length, positives, negatives: eligible.length - positives, auc: 0.812345,
      falseHides, missedHides, errors: falseHides + missedHides, correct: eligible.length - falseHides - missedHides,
      confusion: { tp: positives - missedHides, tn: eligible.length - positives - falseHides, fp: falseHides, fn: missedHides },
      optimal: { cutoff: 0.123456, interval, intervals: [interval,
        { lower: 0.95, upper: 1, width: 0.05, lowerInclusive: true, upperInclusive: true }], errors: 0, falseHides: 0, missedHides: 0 },
      ambiguousExcluded: pairs.length - eligible.length, nearMissFalseHides: falseHides, nearMissDecisions: near.length,
      ownNearMissFalseHides: falseHides, ownNearMissDecisions: near.filter(({ post, id }) => post.authoredFor === id).length,
      missedSubtlePositives: 0, subtlePositiveDecisions: eligible.filter(({ post, id }) => post.kind === 'subtle-positive' && post.gold[id]).length };
  };
  const metrics = ['single', 'six-filter'].flatMap(mode => STYLES.flatMap(style => intents.map(intentId => metric(mode, style, intentId))));
  const pooled = style => metrics.find(row => row.mode === 'single' && row.style === style && row.intentId === 'all');
  const check = (actual, reference, comparison) => ({ actual, reference, comparison, pass: comparison === '<' ? actual < reference : actual <= reference });
  const guidance = { checks: { errors: check(pooled('guided').errors, pooled('short').errors, '<'),
    nearMissFalseHides: check(pooled('guided').nearMissFalseHides, pooled('short').nearMissFalseHides, '<=') } };
  const exclusion = { checks: { nearMissFalseHides: check(pooled('guidedExclusion').nearMissFalseHides, pooled('guided').nearMissFalseHides, '<='),
    missedHides: check(pooled('guidedExclusion').missedHides, pooled('guided').missedHides + 1, '<=') } };
  for (const gate of [guidance, exclusion]) gate.supported = Object.values(gate.checks).every(value => value.pass);
  const summary = { schemaVersion: 1, phase: 'fresh-guidance', status: 'complete', resultFile: RESULT,
    resultSha256: hash(JSON.stringify(result)), registrationSha256: result.registrationSha256, cutoff: CUTOFF,
    counts: { posts: 84, intents: 6, decisionsPerStyle: 504, ambiguousPerStyle: 22, headlinePerStyle: 482, requests: 1764 },
    intents: corpus.intents, metrics, gates: { guidance, exclusion }, immutableEvidenceUnchanged: true,
    requestStats: STYLES.flatMap(style => ['single', 'six-filter'].flatMap(mode => (mode === 'single' ? intents : ['all']).map(intentId =>
      ({ mode, style, intentId, n: mode === 'six-filter' || intentId !== 'all' ? 84 : 504, medianMs: 123.456,
        medianInputTokens: 17, meanInputTokens: 18.5, minInputTokens: 17, maxInputTokens: 20 })))),
    interference: STYLES.flatMap(style => intents.flatMap(intentId => ['headline', 'allIncludingAmbiguous'].map(population => {
      const m = metrics.find(row => row.mode === 'single' && row.style === style && row.intentId === intentId);
      return { style, intentId, population, n: population === 'headline' ? m.n : m.n + m.ambiguousExcluded,
        medianAbsDelta: 0.0123456, worstAbsDelta: 0.2345678, flips: 0 };
    }))), interferenceFlips: [],
    bounced: STYLES.flatMap(style => intents.map(intentId => {
      const posts = corpus.posts.filter(post => (intentId === 'all' || post.authoredFor === intentId) && post.gold[post.authoredFor]);
      const missed = posts.filter(post => {
        const first = posts.find(candidate => candidate.authoredFor === post.authoredFor);
        return post.id === first.id && metric('single', style, post.authoredFor).missedHides > 0;
      });
      return { style, intentId, n: posts.length, caught: posts.length - missed.length, missed: missed.length, subtleMissed: 0,
        failures: missed.map(post => ({ postId: post.id, text: post.text, kind: post.kind, probability: 0.1, cutoff: CUTOFF,
          label: corpus.intents.find(intent => intent.id === post.authoredFor).labels[style] })) };
    })), nearMissPaired: [{ comparison: 'guided-vs-short', n: pooled('short').nearMissDecisions,
      newFalseHides: 0, repairedFalseHides: failing ? 0 : 6, ownNewFalseHides: 0, ownRepairedFalseHides: failing ? 0 : 6 },
    { comparison: 'exclusion-vs-guided', n: pooled('guided').nearMissDecisions,
      newFalseHides: 0, repairedFalseHides: 0, ownNewFalseHides: 0, ownRepairedFalseHides: 0 }] };
  await save('decision-synthetic.json', protectedBytes);
  await save(`decision-1b-identity-${VARIANT}.json`, { schemaVersion: 2, variant: { id: VARIANT, model: MODEL }, identity });
  await save(`decision-1b-selection-${VARIANT}.json`, selection);
  await save(RESULT, result); await save(SUMMARY, summary);
  return { directory, save, result, summary, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('fresh guidance renderer omits absent experiment and shows registration and unfinished status without gates', async () => {
  const f = await fixture();
  try {
    await rm(join(f.directory, RESULT)); await rm(join(f.directory, SUMMARY));
    assert.deepEqual(await renderGuidanceFresh({ dataDirectory: f.directory }),
      { markdown: '', hasResults: false, hasPreregistration: false, complete: false });
    for (const status of ['registered', 'running', 'failed']) {
      const result = { ...f.result, status, requestsIssued: status === 'registered' ? 0 : 1, requests: [] };
      if (status === 'registered') delete result.startedAt;
      await f.save(RESULT, result);
      const rendered = await renderGuidanceFresh({ dataDirectory: f.directory });
      assert.equal(rendered.hasPreregistration, true); assert.equal(rendered.complete, false); assert.equal(rendered.hasResults, false);
      assert.match(rendered.markdown, new RegExp(`Status: \\*\\*${status}\\*\\*`));
      assert.match(rendered.markdown, /G_guidance.*AND/); assert.match(rendered.markdown, /24 pairs per style/);
      assert.doesNotMatch(rendered.markdown, /SUPPORTED|Component result|Recorded gate outcomes/);
      if (status === 'registered') assert.match(rendered.markdown, /Inference has not started/);
      if (status === 'failed') assert.match(rendered.markdown, /run failed/);
    }
  } finally { await f.cleanup(); }
});

test('fresh guidance renderer displays saved gates, per-filter quality, costs, interference and bounced text', async () => {
  const f = await fixture();
  try {
    const rendered = await renderGuidanceFresh({ dataDirectory: f.directory });
    assert.equal(rendered.complete, true); assert.equal(rendered.hasResults, true);
    assert.match(rendered.markdown, /^## Fresh-filter test: Bounce label guidance\n/);
    assert.match(rendered.markdown, /probability >= 0\.290813258948728/);
    assert.match(rendered.markdown, /guidance \| errors \| 0 \| < \| 12 \| PASS \| SUPPORTED/);
    assert.match(rendered.markdown, /exclusion \| missedHides \| 1 \| <= \| 1 \| PASS \| SUPPORTED/);
    assert.match(rendered.markdown, /short \| all \| 482 \| 48 \/ 434 \| 0\.8123 \| 6 \/ 6 \| 12/);
    assert.match(rendered.markdown, /single \| guided \| rudeness \| 84 \| 123\.46 \| 17\.0 \| 18\.50 \| 17–20/);
    assert.match(rendered.markdown, /six-filter \| guided \| all \| 84/);
    assert.match(rendered.markdown, /0\.012346 \| 0\.234568/);
    assert.match(rendered.markdown, /a-rudeness-01 \| clear-positive \| 0\.100000/);
    assert.match(rendered.markdown, /imagine being this mid and still posting/);
    assert.match(rendered.markdown, /\(0\.1, 0\.9\] ∪ \[0\.95, 1\]/);
    assert.match(rendered.markdown, /data\/decision-guidance-fresh-summary\.json/);
    assert.match(rendered.markdown, /never replace the frozen operating point/);
    assert.doesNotMatch(rendered.markdown, /recommend|winner|My pick/);
    const source = await readFile(new URL('../guidance-report.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\//);
    // Raw model responses are opaque to this renderer even when they disagree with saved metrics.
    const result = clone(f.result); result.requests[0].probabilities = [0.001];
    await f.save(RESULT, result); await f.save(SUMMARY, { ...f.summary, resultSha256: hash(JSON.stringify(result)) });
    assert.match((await renderGuidanceFresh({ dataDirectory: f.directory })).markdown,
      /guidance \| errors \| 0 \| < \| 12 \| PASS \| SUPPORTED/);
  } finally { await f.cleanup(); }
});

test('fresh guidance renderer reports each failed gate component without a recommendation', async () => {
  const f = await fixture({ failing: true });
  try {
    const { markdown } = await renderGuidanceFresh({ dataDirectory: f.directory });
    assert.match(markdown, /guidance \| errors \| 0 \| < \| 0 \| FAIL \| NOT SUPPORTED/);
    assert.match(markdown, /guidance \| nearMissFalseHides \| 0 \| <= \| 0 \| PASS \| NOT SUPPORTED/);
    assert.match(markdown, /exclusion \| missedHides \| 6 \| <= \| 1 \| FAIL \| NOT SUPPORTED/);
  } finally { await f.cleanup(); }
});

test('fresh guidance renderer rejects stale hashes, altered registration, metric algebra and unsupported gate claims', async () => {
  const f = await fixture();
  try {
    const mutations = [
      s => { s.resultSha256 = '0'.repeat(64); }, s => { s.resultFile = '../outside.json'; },
      s => { s.registrationSha256 = '0'.repeat(64); }, s => { s.cutoff = 0.2908; },
      s => { s.counts.headlinePerStyle = 504; }, s => { s.intents[0].labels.guided = 'changed'; },
      s => { s.metrics[0].errors += 1; }, s => { s.metrics.push(clone(s.metrics[0])); },
      s => { s.gates.guidance.supported = false; }, s => { s.gates.exclusion.checks.missedHides.reference = 0; },
      s => { s.interference[0].n -= 1; }, s => { s.bounced[0].caught -= 1; },
      s => { s.nearMissPaired[0].repairedFalseHides -= 1; }, s => { s.immutableEvidenceUnchanged = false; },
    ];
    for (const mutate of mutations) {
      const summary = clone(f.summary); mutate(summary); await f.save(SUMMARY, summary);
      await assert.rejects(renderGuidanceFresh({ dataDirectory: f.directory }), /Fresh Bounce guidance:/);
    }
    await f.save(SUMMARY, f.summary);
    const changes = [
      r => { r.registration.rule.primaryMode = 'six-filter'; }, r => { r.registration.runtimeSettings.parallel = 2; },
      r => { r.registration.model.selectionSha256 = '0'.repeat(64); }, r => { r.registration.cutoff = 0.2908; },
      r => { r.corpusSnapshot.posts[0].gold.rudeness = false; }, r => { r.requestsIssued = 1763; },
    ];
    for (const mutate of changes) {
      const result = clone(f.result); mutate(result); result.registrationSha256 = hash(JSON.stringify(result.registration));
      await f.save(RESULT, result);
      await f.save(SUMMARY, { ...f.summary, resultSha256: hash(JSON.stringify(result)), registrationSha256: result.registrationSha256 });
      await assert.rejects(renderGuidanceFresh({ dataDirectory: f.directory }), /Fresh Bounce guidance:/);
    }
    await f.save(RESULT, f.result); await f.save(SUMMARY, f.summary);
    await f.save('decision-synthetic.json', '{"changed":true}');
    await assert.rejects(renderGuidanceFresh({ dataDirectory: f.directory }), /protected evidence changed/);
  } finally { await f.cleanup(); }
});
