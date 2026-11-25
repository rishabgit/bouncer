import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { renderCapacity } from '../capacity-report.mjs';

const RESULT = 'decision-capacity-result.json', SUMMARY = 'decision-capacity-summary.json';
const BASELINE = 'llama-d1-2b-q8';
const IDS = ['llama-d1-3b-q8', 'llama-kev-4b-q8', 'llama-clef-flash-q4km'];
const CUTOFF = 0.290813258948728;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const TEMPLATES = [
  { id: 'matches-category', hash: '9a1e023c41c8c19c37317953ae8d7b486ec088070ce00abadd4809242eb67f54' },
  { id: 'category-applies', hash: '63c1d9bc4c93b016b38f047d74585d73b08f54651031b80433da8b1f915aee3a' },
];
const ORIGINAL = {
  'eval-corpus.ts': '4a2dacac7271704addb5c06d953021b8c8c7f20108cfa002ce11942a6e907214',
  'native-benchmark-corpus.ts': 'a5db3bf30aa3039a3e571020c111797e1cfdd675872514a40139e66db6038603',
  'native-isolation-holdout.json': '18841a6609d9e68493c629880bc03eeaa233eab890245e5cfd5c2eaa9e9d4159',
  'native-migration-validation.json': '354e80566fdf889e213aec9072387c42f8286a48347379b1142073cba3fa4e27',
};
const interval = { lower: 0.2, upper: 0.4, width: 0.2, lowerInclusive: false, upperInclusive: true };
const rule = {
  switch: { baselineGuidedErrors: 66, freshGuidedErrorsMax: 33,
    originalValidation: { newFalseHidesMax: 1, exactVectorsAtLeastBrowser: true, correctHideShowDeficitMax: 1, bothCorporaRequired: true },
    warm10MedianMsMax: 250, allRequired: true, otherwise: 'd1-2B stays' },
  sentence: { baselineGuidedErrors: 66, errorsStrictlyFewer: true, nearMissFalseHidesMax: 18, allRequired: true },
  nearMissPopulation: 'Negative-gold non-ambiguous pairs on near-miss posts, including cross-filter pairs; own-filter near misses reported separately',
  primaryFreshMode: 'single', ambiguousExcluded: true, rubricIsUpperBound: true, discoveryOnlySelection: true,
  originalValidationIsExploratory: true, noRetuning: true, noRelabelling: true, noQualityReruns: true, speedRepetitions: 3,
};
const numeric = (actual, reference, comparison = '<=') => ({ actual, reference, comparison,
  pass: comparison === '<' ? actual < reference : actual <= reference });

async function fixture({ failing = false } = {}) {
  const scratch = new URL('../.tmp/', import.meta.url);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(new URL('capacity-report-test-', scratch));
  const save = async (name, value) => {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value);
    await writeFile(join(directory, name), bytes); return { file: name, sha256: hash(bytes) };
  };
  const corpusBytes = await readFile(new URL('../corpora/guidance-fresh-2026-11-25.json', import.meta.url));
  const corpus = JSON.parse(corpusBytes), intentIds = ['all', ...corpus.intents.map(intent => intent.id)];
  const labels = corpus.intents.map(intent => ({ intentId: intent.id, ...intent.labels,
    sentence: `${intent.labels.guided}. ${intent.rubric.match(/\bKeep\b[^.!?]*[.!?]/)[0]}`, rubric: intent.rubric }));
  const settings = { runtime: 'llama', version: 'synthetic', build: 'synthetic', effectiveContext: 4096,
    parallel: 1, batch: 4096, ubatch: 4096, projector: false, runner: 'llamacpp', quantization: 'Q8_0', aliasDefinition: null };
  const baselineVariant = { id: BASELINE, runtime: 'llama', model: 'LiquidAI/d1-2B-GGUF:Q8_0', format: 'GGUF Q8_0' };
  const identityFor = id => ({ repository: `synthetic/${id}`, revision: 'a'.repeat(40), file: `${id}.gguf`, sha256: hash(id),
    disk: { logicalBytes: 2000000000, allocatedBytes: 2100000000, scope: 'Primary text GGUF only; projector excluded' } });
  const baselineIdentity = identityFor(BASELINE);
  const baselineSelection = { schemaVersion: 2, phase: 'discovery', frozen: true, variantId: BASELINE,
    identityHash: hash(baselineIdentity), templateId: TEMPLATES[0].id, templateHash: TEMPLATES[0].hash,
    cutoff: CUTOFF, interval, runtimeSettings: settings };
  const baselineSelectionBinding = await save(`decision-1b-selection-${BASELINE}.json`, baselineSelection);
  await save(`decision-1b-identity-${BASELINE}.json`, { schemaVersion: 2, variant: baselineVariant, identity: baselineIdentity });
  const matrix = (styles, cutoff, baseline = false) => {
    const metrics = ['single', 'six-filter'].flatMap(mode => styles.flatMap(style => intentIds.map(intentId => {
      const pairs = corpus.posts.flatMap(post => corpus.intents.filter(intent => intentId === 'all' || intent.id === intentId)
        .map(intent => ({ post, id: intent.id })));
      const eligible = pairs.filter(({ post, id }) => !post.ambiguousFor.includes(id));
      const near = eligible.filter(({ post, id }) => post.kind === 'near-miss' && !post.gold[id]);
      const positives = eligible.filter(({ post, id }) => post.gold[id]).length, factor = intentId === 'all' ? 6 : 1;
      const falseHides = factor * (baseline && style === 'guided' ? 11 : style === 'sentence' ? failing ? 11 : 5 : style === 'rubric' ? 1 : 4);
      const nearMissFalseHides = factor * (style === 'guided' || style === 'sentence' ? 3 : 1);
      return { mode, style, intentId, n: eligible.length, positives, negatives: eligible.length - positives, auc: 0.987654,
        falseHides, missedHides: 0, errors: falseHides, correct: eligible.length - falseHides,
        confusion: { tp: positives, tn: eligible.length - positives - falseHides, fp: falseHides, fn: 0 },
        optimal: { cutoff: 0.3, interval, intervals: [interval], errors: 0, falseHides: 0, missedHides: 0 },
        ambiguousExcluded: pairs.length - eligible.length, nearMissFalseHides, nearMissDecisions: near.length,
        ownNearMissFalseHides: factor, ownNearMissDecisions: near.filter(({ post, id }) => post.authoredFor === id).length,
        missedSubtlePositives: 0, subtlePositiveDecisions: eligible.filter(({ post, id }) => post.kind === 'subtle-positive' && post.gold[id]).length };
    })));
    return { styles, cutoff, metrics,
      requestStats: styles.flatMap(style => ['single', 'six-filter'].flatMap(mode => (mode === 'single' ? intentIds : ['all']).map(intentId =>
        ({ mode, style, intentId, n: mode === 'single' && intentId === 'all' ? 504 : 84,
          medianMs: 98.765, medianInputTokens: 30, meanInputTokens: 31.25, minInputTokens: 20, maxInputTokens: 50 })))),
      interference: styles.flatMap(style => intentIds.flatMap(intentId => ['headline', 'allIncludingAmbiguous'].map(population => {
        const m = metrics.find(row => row.mode === 'single' && row.style === style && row.intentId === intentId);
        return { style, intentId, population, n: m.n + (population === 'headline' ? 0 : m.ambiguousExcluded),
          medianAbsDelta: 0.012345, worstAbsDelta: 0.234567, flips: 0 };
      }))), interferenceFlips: [],
      bounced: styles.flatMap(style => intentIds.map(intentId => ({ style, intentId,
        n: intentId === 'all' ? 48 : 8, caught: intentId === 'all' ? 48 : 8, missed: 0, subtleMissed: 0, failures: [] }))) };
  };
  const partAMatrix = matrix(['guided', 'sentence', 'rubric'], CUTOFF, true);
  const oldResultBinding = await save('decision-guidance-fresh-result.json', { status: 'complete' });
  const oldSummary = { status: 'complete', resultSha256: oldResultBinding.sha256,
    metrics: partAMatrix.metrics.filter(row => row.style === 'guided') };
  const oldSummaryBinding = await save('decision-guidance-fresh-summary.json', oldSummary);
  const variants = IDS.map(id => ({ id, runtime: 'llama', model: `synthetic/${id}:Q8_0`, format: 'GGUF Q8_0' }));
  const models = variants.map(variant => {
    const identity = identityFor(variant.id), { disk, ...artifact } = identity;
    return { id: variant.id, model: variant.model, format: variant.format, artifact: { ...artifact, logicalBytes: disk.logicalBytes } };
  });
  const registration = { corpora: { original: ORIGINAL, fresh: {
    file: 'scripts/decision-eval/corpora/guidance-fresh-2026-11-25.json', sha256: hash(corpusBytes) } }, models,
  d1Baseline: { selectionFile: baselineSelectionBinding.file, selectionSha256: baselineSelectionBinding.sha256,
    identityHash: hash(baselineIdentity), guidedResultFile: oldResultBinding.file, guidedResultSha256: oldResultBinding.sha256,
    guidedSummaryFile: oldSummaryBinding.file, guidedSummarySha256: oldSummaryBinding.sha256, guidedErrors: 66, nearMissFalseHides: 18 },
  templates: TEMPLATES, partA: { styles: ['sentence', 'rubric'], templateId: 'matches-category', cutoff: CUTOFF,
    questionEncoding: 'Frozen selected wrapper with the definition in the category slot' },
  partB: { styles: ['short', 'guided', 'rubric'], freshPrimaryMode: 'single', cutoffsFrom: 'Original 88-case discovery midpoint',
    questionEncoding: 'Frozen selected wrapper with the definition in the category slot' },
  freshSchedule: { seed: '0x0cab2026', partARequests: 1176, perLargerModelRequests: 1764 }, rule };
  const protectedBytes = '{"prior":"immutable"}';
  const result = { schemaVersion: 1, phase: 'decision-capacity', status: 'complete', registeredAt: '2026-11-25T01:00:00.000Z',
    registration, registrationSha256: hash(registration), startedAt: '2026-11-25T01:01:00.000Z',
    finishedAt: '2026-11-25T01:02:00.000Z', stage: 'complete',
    protectedHashes: { 'docs/benchmarks/data/decision-synthetic.json': hash(protectedBytes) } };
  await save('decision-synthetic.json', protectedBytes);
  const baselinesBinding = await save('decision-baselines.json', { synthetic: 'recorded baselines' });
  const fresh = async (variant, selection, styles, freshMatrix, baseline = false) => {
    const selectionName = baseline ? baselineSelectionBinding.file : `decision-capacity-selection-${variant.id}.json`;
    const selectionBytes = await readFile(join(directory, selectionName));
    const raw = { schemaVersion: 1, phase: 'decision-capacity-fresh', status: 'complete', variant,
      registrationSha256: result.registrationSha256, selectionFile: selectionName, selectionSha256: hash(selectionBytes), selection,
      identityHash: selection.identityHash, runtimeSettings: selection.runtimeSettings, corpusSha256: hash(corpusBytes),
      corpusSnapshot: corpus, styleLabels: labels, styles,
      // Opaque receipts deliberately disagree with the saved scores: rendering must never classify them.
      requests: Array.from({ length: styles.length * 588 }, (_, index) => ({ index, probabilities: [0.99999] })),
      requestsIssued: styles.length * 588, startedAt: '2026-11-25T01:01:00.000Z', finishedAt: '2026-11-25T01:02:00.000Z',
      environment: { node: 'synthetic' }, ...(baseline ? { baselineGuided: { ...oldResultBinding, style: 'guided' } } : {}) };
    return { ...await save(`decision-capacity-fresh-${variant.id}.json`, raw), matrix: freshMatrix };
  };
  const partA = { ...await fresh(baselineVariant, baselineSelection, ['sentence', 'rubric'], partAMatrix, true), selection: baselineSelection,
    sentenceRule: { checks: { errors: numeric(failing ? 66 : 30, 66, '<'), nearMissFalseHides: numeric(18, 18) }, supported: !failing } };
  const scoreGroup = n => ({ exactVectors: n, totalVectors: n, hide: { n, tp: 0, tn: n, fp: 0, fn: 0, f1: null },
    falseHides: 0, missedHides: 0, newFalseHides: 0, newMissedHides: 0 });
  const scores = (n = 88) => ({ all: scoreGroup(n), rage: scoreGroup(40), broad: scoreGroup(n - 40) });
  const modelSummaries = [];
  for (const variant of variants) {
    const id = variant.id, identity = identityFor(id), groups = scores();
    await save(`decision-capacity-identity-${id}.json`, { schemaVersion: 2, variant, identity });
    const discovery = { schemaVersion: 2, phase: 'discovery', variant, identityHash: hash(identity), corpusHashes: ORIGINAL,
      runtimeSettings: settings, templates: TEMPLATES.map(template => ({ ...template, optimized: { cutoff: 0.3, interval, scores: groups }, at05: groups })) };
    const discoveryBinding = await save(`decision-capacity-discovery-${id}.json`, discovery);
    const selection = { schemaVersion: 2, phase: 'discovery', frozen: true, variantId: id, templateId: TEMPLATES[0].id,
      templateHash: TEMPLATES[0].hash, cutoff: 0.3, interval, loo: groups.all, corpusHashes: ORIGINAL,
      runtimeSettings: settings, identityHash: hash(identity), discoverySha256: discoveryBinding.sha256 };
    const selectionBinding = await save(`decision-capacity-selection-${id}.json`, selection);
    const performance = { warm3: { n: 60, median: 111, p90: 150 }, warm10: { n: 60, median: failing ? 251 : 249, p90: 300 },
      coldMedianMs: 2222, steadyRssBytes: 3e9, steadyFootprintBytes: 2e9, peakRssBytes: 4e9, peakFootprintBytes: 3e9,
      identicalProbabilities: true, disk: identity.disk, sources: [] };
    for (let repetition = 0; repetition < 3; repetition++) performance.sources.push(await save(`decision-capacity-speed-r${repetition}-${id}.json`,
      { schemaVersion: 2, phase: 'performance', repetition, variant, selection, identityHash: selection.identityHash,
        runtimeSettings: settings, artifact: { model: variant.model, format: variant.format, digest: identity.sha256, disk: identity.disk } }));
    const validation = [];
    for (const corpusName of ['isolation', 'migration']) {
      const stored = scores(corpusName === 'isolation' ? 72 : 120), browser = clone(stored);
      const gates = { G1: { metric: 'newFalseHides', actual: 0, max: 1, pass: true },
        G2: { metric: 'exactVectors', actual: stored.all.exactVectors, min: browser.all.exactVectors, pass: true },
        G3: { metric: 'correctHideDecisions', actual: stored.all.hide.n, min: browser.all.hide.n - 1, pass: true } };
      const textOnlyQat = corpusName === 'isolation' ? null : { scores: clone(stored), contextTokens: 1024, runtime: 'Ollama 0.40.3' };
      const sourceCorpus = corpusName === 'isolation' ? 'native-isolation-holdout.json' : 'native-migration-validation.json';
      const raw = { schemaVersion: 1, phase: 'decision-capacity-validation', status: 'complete', exploratory: true, preRegisteredClaim: false,
        registrationSha256: result.registrationSha256, variant, identityHash: selection.identityHash,
        runtimeSettings: settings, corpusHashes: ORIGINAL, selectionFile: selectionBinding.file, selectionSha256: selectionBinding.sha256,
        selection, corpus: corpusName, sourceCorpus, corpusSha256: ORIGINAL[sourceCorpus], baselineSha256: baselinesBinding.sha256,
        rows: Array.from({ length: stored.all.totalVectors }, (_, index) => ({ index, probabilities: [0.999] })),
        requestsIssued: stored.all.totalVectors,
        atFrozen: stored, at05: clone(stored), baseline: { browser: { scores: browser }, textOnlyQat }, gates, pass: true };
      validation.push({ corpus: corpusName, ...await save(`decision-capacity-validation-${id}-${corpusName}.json`, raw),
        scores: stored, at05: raw.at05, browser, textOnlyQat, gates, pass: true });
    }
    modelSummaries.push({ variant, identity, selection, discovery: { chosen: groups, at05: groups, loo: groups.all }, performance, validation,
      fresh: await fresh(variant, selection, ['short', 'guided', 'rubric'], matrix(['short', 'guided', 'rubric'], 0.3)),
      productRule: { checks: { freshGuidedErrors: numeric(24, 33), originalValidation: { pass: true },
        warm10MedianMs: numeric(performance.warm10.median, 250) }, worthSwitching: !failing } });
  }
  const archive = await save('decision-capacity-archive.json', { bytes: 123456, sha256: 'f'.repeat(64) });
  const resultBinding = await save(RESULT, result);
  const summary = { schemaVersion: 1, phase: 'decision-capacity', status: 'complete', resultFile: RESULT,
    resultSha256: resultBinding.sha256, registrationSha256: result.registrationSha256, partA, models: modelSummaries,
    immutableEvidenceUnchanged: true, archive };
  await save(SUMMARY, summary);
  return { directory, save, result, summary, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('capacity renderer omits absent experiment and states registered, running and failed status without gate conclusions', async () => {
  const f = await fixture();
  try {
    await rm(join(f.directory, RESULT)); await rm(join(f.directory, SUMMARY));
    assert.deepEqual(await renderCapacity({ dataDirectory: f.directory }),
      { markdown: '', hasResults: false, hasPreregistration: false, complete: false });
    for (const status of ['registered', 'running', 'failed']) {
      const result = { ...f.result, status, stage: 'synthetic-stage', error: { message: 'synthetic failure' } };
      if (status === 'registered') delete result.startedAt;
      await f.save(RESULT, result);
      const rendered = await renderCapacity({ dataDirectory: f.directory });
      assert.equal(rendered.hasPreregistration, true); assert.equal(rendered.hasResults, false); assert.equal(rendered.complete, false);
      assert.match(rendered.markdown, new RegExp(`Status: \\*\\*${status}\\*\\*`));
      assert.match(rendered.markdown, /fresh guided errors ≤ 33 AND G1\/G2\/G3 on BOTH original corpora AND warm ten-filter p50 ≤ 250 ms/);
      assert.match(rendered.markdown, /143 eligible negative pairs/); assert.match(rendered.markdown, /24 own-filter pairs/);
      assert.doesNotMatch(rendered.markdown, /PASSES SWITCH RULE|NOT SUPPORTED|Description check/);
      if (status === 'registered') assert.match(rendered.markdown, /Inference has not started/);
      if (status === 'failed') assert.match(rendered.markdown, /run failed: synthetic failure/);
    }
  } finally { await f.cleanup(); }
});

test('capacity renderer displays recorded quality, independent gates, frozen choices, cost and performance', async () => {
  const f = await fixture();
  try {
    const rendered = await renderCapacity({ dataDirectory: f.directory });
    assert.equal(rendered.complete, true); assert.equal(rendered.hasResults, true);
    assert.match(rendered.markdown, /^## Capacity and description experiment/);
    assert.match(rendered.markdown, /Full-gold rubric results are an upper bound/);
    assert.match(rendered.markdown, /Sentence guidance: \*\*SUPPORTED\*\*/);
    assert.match(rendered.markdown, /errors \| 30 \| < \| 66 \| PASS/);
    assert.match(rendered.markdown, /freshGuidedErrors \| 24 \| <= \| 33 \| PASS \| PASSES SWITCH RULE/);
    assert.match(rendered.markdown, /warm10MedianMs \| 249 \| <= \| 250 \| PASS/);
    assert.match(rendered.markdown, /llama-d1-2b-q8 \| single \| sentence \| all \| 482 \| 0\.9877 \| 30 \/ 0 \| 30 \| 18\/143/);
    assert.match(rendered.markdown, /guided \| all \| 482/); assert.match(rendered.markdown, /rubric \| all \| 482/);
    assert.match(rendered.markdown, /In-sample best cutoff \| Best interval \| Best errors/);
    assert.match(rendered.markdown, /0\.300000 \| \(0\.2, 0\.4\] \| 0/);
    assert.match(rendered.markdown, /111\.00 \/ 150\.00 \(60\) \| 249\.00 \/ 300\.00 \(60\)/);
    assert.match(rendered.markdown, /2\.794 \/ 1\.863 \| 3\.725 \/ 2\.794 \| 2\.000 \/ 2\.100/);
    assert.match(rendered.markdown, /98\.77 \| 30\.0 \/ 31\.25 \| 20–50/);
    assert.match(rendered.markdown, /0\.012345 \/ 0\.234567/);
    assert.match(rendered.markdown, /Original validation gates remain separate for each corpus/);
    assert.match(rendered.markdown, /Ollama 0\.40\.3; 1024 tokens/);
    assert.match(rendered.markdown, /Mechanical sentence/); assert.match(rendered.markdown, /Keep posts that are blunt but sincere critique/);
    assert.match(rendered.markdown, /data\/decision-capacity-fresh-llama-clef-flash-q4km\.json/);
    const source = await readFile(new URL('../capacity-report.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\//);
    // Keep raw opaque probabilities inconsistent with stored scores: report generation must still render saved metrics.
    assert.match(rendered.markdown, /sentence \| all \| 482 \| 0\.9877 \| 30 \/ 0/);
  } finally { await f.cleanup(); }
});

test('capacity renderer keeps failed description and larger-model checks visible without choosing a model', async () => {
  const f = await fixture({ failing: true });
  try {
    const { markdown } = await renderCapacity({ dataDirectory: f.directory });
    assert.match(markdown, /Sentence guidance: \*\*NOT SUPPORTED\*\*/);
    assert.match(markdown, /errors \| 66 \| < \| 66 \| FAIL/);
    assert.match(markdown, /warm10MedianMs \| 251 \| <= \| 250 \| FAIL \| DOES NOT PASS SWITCH RULE/);
    assert.doesNotMatch(markdown, /^My pick|^I recommend switching/m);
  } finally { await f.cleanup(); }
});

test('capacity renderer rejects altered source hashes, metric algebra, frozen choices and unsupported claims', async () => {
  const f = await fixture();
  try {
    const mutations = [
      s => { s.resultSha256 = '0'.repeat(64); }, s => { s.resultFile = '../outside.json'; },
      s => { s.registrationSha256 = '0'.repeat(64); }, s => { s.immutableEvidenceUnchanged = false; },
      s => { s.partA.sha256 = '0'.repeat(64); }, s => { s.partA.matrix.cutoff = 0.5; },
      s => { s.partA.matrix.metrics[0].errors++; }, s => { s.partA.matrix.metrics.push(clone(s.partA.matrix.metrics[0])); },
      s => { s.partA.sentenceRule.supported = false; }, s => { s.partA.sentenceRule.checks.errors.reference = 67; },
      s => { s.models[0].selection.cutoff = 0.5; }, s => { s.models[0].fresh.matrix.metrics[0].nearMissDecisions--; },
      s => { s.models[0].fresh.matrix.interference[0].n--; }, s => { s.models[0].fresh.matrix.bounced[0].caught--; },
      s => { s.models[0].fresh.matrix.requestStats[0].n--; }, s => { s.models[0].productRule.worthSwitching = false; },
      s => { s.models[0].productRule.checks.freshGuidedErrors.reference = 66; },
      s => { s.models[0].validation[0].gates.G1.max = 2; }, s => { s.models[0].validation[0].sha256 = '0'.repeat(64); },
      s => { s.models[0].performance.sources[0].sha256 = '0'.repeat(64); }, s => { delete s.models[0].performance.sources; },
      s => { s.archive.sha256 = '0'.repeat(64); },
    ];
    for (const mutate of mutations) {
      const summary = clone(f.summary); mutate(summary); await f.save(SUMMARY, summary);
      await assert.rejects(renderCapacity({ dataDirectory: f.directory }), /Decision capacity:/);
    }
    await f.save(SUMMARY, f.summary);
    const changes = [r => { r.registration.corpora.fresh.sha256 = '0'.repeat(64); },
      r => { r.registration.partA.cutoff = 0.5; }, r => { r.registration.partB.freshPrimaryMode = 'six-filter'; },
      r => { r.registration.d1Baseline.guidedErrors = 65; }, r => { r.registration.templates[0].hash = '0'.repeat(64); }];
    changes.push(r => { r.registration.rule.switch.freshGuidedErrorsMax = 66; });
    for (const mutate of changes) {
      const result = clone(f.result); mutate(result); result.registrationSha256 = hash(result.registration);
      await f.save(RESULT, result); await f.save(SUMMARY, { ...f.summary, resultSha256: hash(result), registrationSha256: result.registrationSha256 });
      await assert.rejects(renderCapacity({ dataDirectory: f.directory }), /Decision capacity:/);
    }
    await f.save(RESULT, f.result); await f.save(SUMMARY, f.summary);
    await f.save('decision-synthetic.json', '{"changed":true}');
    await assert.rejects(renderCapacity({ dataDirectory: f.directory }), /protected evidence changed/);
  } finally { await f.cleanup(); }
});
