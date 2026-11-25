import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { renderWordingProbe } from '../wording-report.mjs';

const SUMMARY = 'decision-wording-probe-summary.json';
const RAW = 'decision-wording-probe-raw.json';
const FLIPS = 'decision-wording-probe-flips.json';
const VARIANT = 'llama-d1-2b-q8';
const MODEL = 'LiquidAI/d1-2B-GGUF:Q8_0';
const CUTOFF = 0.290813258948728;
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture() {
  const scratch = new URL('../.tmp/', import.meta.url);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(new URL('wording-report-test-', scratch));
  const save = (name, value) => writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  const runtimeSettings = { runtime: 'llama', version: '0.49.0', build: 'synthetic', effectiveContext: 4096,
    parallel: 1, batch: 4096, ubatch: 4096, projector: false, runner: 'llamacpp', quantization: 'Q8_0', aliasDefinition: null };
  const artifact = { sha256: 'a'.repeat(64), file: 'synthetic.gguf' };
  const corpusHashes = { 'synthetic.json': 'b'.repeat(64) };
  const selection = { schemaVersion: 2, phase: 'discovery', frozen: true, variantId: VARIANT,
    cutoff: CUTOFF, identityHash: hash(JSON.stringify(artifact)), runtimeSettings, corpusHashes };
  const selectionBytes = JSON.stringify(selection);
  const model = { variantId: VARIANT, model: MODEL, identityHash: selection.identityHash, selectionSha256: hash(selectionBytes) };
  const intent = 'descriptive | category';
  const cases = ['one', 'two'].map((key, index) => ({ key, corpus: index ? 'isolation' : 'discovery',
    sourceCorpus: 'synthetic.json', id: key, text: `Synthetic ${key}`, filters: [intent], expected: [index === 0], caseIdentitySha256: 'c'.repeat(64) }));
  const raw = { schemaVersion: 1, phase: 'exploratory-label-wording', status: 'complete', model, cutoff: CUTOFF,
    runtimeSettings, corpusHashes, cases, intents: [{ id: 'synthetic', D: intent, K1: 'keyword', K2: 'other keyword', X: 'category but not excluded' }],
    requests: cases.map((item, index) => ({ index, mode: 'single', variant: 'D', caseKey: item.key, intents: [intent],
      labels: [intent], appendDefinition: [false], probabilities: [0.9], usage: { input_tokens: 17 }, wallMs: 12 })) };
  const flips = { schemaVersion: 1, phase: 'exploratory-label-wording', cutoff: CUTOFF,
    rows: [{ variant: 'K1', corpus: 'discovery', caseKey: 'one', intent, text: 'Do not dump this post in the report',
      gold: true, dLabel: intent, kLabel: 'keyword', dProbability: 0.1, kProbability: 0.9, dCorrect: false, kCorrect: true }] };
  const interval = { lower: 0.1, upper: 0.9, width: 0.8, lowerInclusive: false, upperInclusive: true };
  const metric = (variant, rowIntent, corpus) => ({ variant, intent: rowIntent, corpus, n: 2, positives: 1, negatives: 1,
    auc: 0.812345, falseHides: 1, missedHides: 0, errors: 1, correct: 1, confusion: { tp: 1, tn: 0, fp: 1, fn: 0 },
    optimal: { cutoff: 0.123456, interval, intervals: [interval,
      { lower: 0.95, upper: 1, width: 0.05, lowerInclusive: true, upperInclusive: true }], errors: 0, falseHides: 0, missedHides: 0 } });
  const summary = { schemaVersion: 1, phase: 'exploratory-label-wording', status: 'complete', rawFile: RAW,
    rawSha256: hash(JSON.stringify(raw)), flipsFile: FLIPS, flipsSha256: hash(JSON.stringify(flips)), model, cutoff: CUTOFF,
    counts: { cases: 2, decisions: 2, requests: 2 }, runtimeSettings, environment: { node: 'synthetic' }, goldProvisional: true,
    metrics: ['D', 'K1', 'K2', 'Rdef', 'X'].flatMap(variant => [metric(variant, 'all', 'all'), metric(variant, intent, 'all'),
      ...['discovery', 'isolation', 'migration'].map(corpus => metric(variant, 'all', corpus))]),
    paired: ['K1', 'K2', 'Rdef', 'X'].flatMap(variant => ['all', intent].map(rowIntent => ({ variant, intent: rowIntent,
      corpus: 'all', n: 2, aucDifference: 0.125, errorDifference: -1, flips: 1,
      mcnemar: { n: 2, bothCorrect: 1, bothWrong: 0, dCorrectKWrong: 0, dWrongKCorrect: 1, discordant: 1,
        pValue: 1, method: 'exact two-sided binomial' } }))),
    requestStats: ['D', 'K1', 'K2', 'Rdef', 'X'].flatMap(variant => ['single', 'multi'].map(mode => ({ variant, mode,
      intent: 'all', corpus: 'all', n: 2, medianMs: 123.456, medianInputTokens: 17, meanInputTokens: 18.5,
      minInputTokens: 17, maxInputTokens: 20 }))),
    interference: ['D', 'K1'].flatMap(style => ['all', intent].map(rowIntent => ({ style, intent: rowIntent, corpus: 'all',
      n: 2, medianAbsDelta: 0.0123456, worstAbsDelta: 0.2345678, flips: 1 }))),
    roundedCutoff: 0.2908, roundedCutoffDecisionDifferences: 0, immutableEvidenceUnchanged: true };
  summary.requestStats.push({ ...summary.requestStats.find(row => row.mode === 'multi'), intent: 'multi-filter' });
  await save(`decision-1b-selection-${VARIANT}.json`, selectionBytes);
  await save(`decision-1b-identity-${VARIANT}.json`, { schemaVersion: 2, variant: { id: VARIANT, model: MODEL }, identity: artifact });
  await save(RAW, raw);
  await save(FLIPS, flips);
  await save(SUMMARY, summary);
  return { directory, save, summary, raw, flips, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('wording renderer omits absent summary even when raw evidence is unfinished', async () => {
  const f = await fixture();
  try {
    await rm(join(f.directory, SUMMARY));
    await f.save(RAW, '{unfinished raw evidence');
    assert.deepEqual(await renderWordingProbe({ dataDirectory: f.directory }), { markdown: '', hasResults: false });
  } finally { await f.cleanup(); }
});

test('wording renderer renders stored diagnostics, paired signs, costs and links without scoring raw requests', async () => {
  const f = await fixture();
  try {
    const result = await renderWordingProbe({ dataDirectory: f.directory });
    assert.equal(result.hasResults, true);
    assert.equal(result.flips, 1);
    assert.match(result.markdown, /^## Exploratory: label wording probe\n/);
    assert.match(result.markdown, /probability >= 0\.290813258948728/);
    assert.match(result.markdown, /\| D \| all \| 2 \| 1 \/ 1 \| 0\.8123 \| 1 \/ 0 \| 1 \| 1\/2 \| 0\.123456 \| \(0\.1, 0\.9\] ∪ \[0\.95, 1\] \| 0 \|/);
    assert.match(result.markdown, /descriptive \\\| category/);
    assert.match(result.markdown, /\| K1 \| all \| 2 \| \+0\.1250 \| -1 \| 0 \| 1 \| 1 \| 1\.000000 \| 1 \|/);
    assert.match(result.markdown, /\| K2 \| migration \|/);
    assert.match(result.markdown, /\| K1 \| multi \| 2 \| 123\.46 \| 17\.0 \| 18\.50 \| 17–20 \|/);
    assert.match(result.markdown, /0\.012346 \| 0\.234568/);
    assert.match(result.markdown, /\[full K1\/K2-versus-D flip file\]\(data\/decision-wording-probe-flips\.json\)/);
    assert.doesNotMatch(result.markdown, /Do not dump this post|recommended|My pick/);
    assert.match(result.markdown, /K2 `rage bait` explicitly has no definition/);
    assert.match(result.markdown, /extra replicate with the same label and definition as D rage/);
    assert.match(result.markdown, /paired X comparison uses the matching D subset/);
    assert.match(result.markdown, /provisional pending a blind audit/);
    assert.match(result.markdown, /descriptive in-sample diagnostics and are never applied/);
    assert.match(result.markdown, /shuffled one-pass workload/);
    assert.match(result.markdown, /Multiple filter decisions on the same post may be dependent/);
    const source = await readFile(new URL('../wording-report.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\//);
  } finally { await f.cleanup(); }
});

test('wording renderer rejects stale hashes, frozen bindings and incomplete summary claims', async () => {
  const f = await fixture();
  try {
    const mutations = [
      value => { value.rawSha256 = '0'.repeat(64); },
      value => { value.flipsSha256 = '0'.repeat(64); },
      value => { value.rawFile = '../outside.json'; },
      value => { value.cutoff = 0.2908; },
      value => { value.model.variantId = 'other'; },
      value => { value.model.selectionSha256 = '0'.repeat(64); },
      value => { value.runtimeSettings.effectiveContext = 1024; },
      value => { value.counts.requests = 3; },
      value => { value.status = 'running'; },
      value => { value.goldProvisional = false; },
      value => { value.immutableEvidenceUnchanged = false; },
      value => { value.metrics[0].errors = 0; },
      value => { value.metrics.push(clone(value.metrics[0])); },
      value => { value.paired[0].mcnemar.method = 'asymptotic'; },
    ];
    for (const mutate of mutations) {
      const summary = clone(f.summary);
      mutate(summary);
      await f.save(SUMMARY, summary);
      await assert.rejects(renderWordingProbe({ dataDirectory: f.directory }), /Label wording probe:/);
    }
    await f.save(SUMMARY, f.summary);
    await f.save(RAW, `${JSON.stringify(f.raw)}\n`);
    await assert.rejects(renderWordingProbe({ dataDirectory: f.directory }), /raw or flip evidence hash differs/);
    await f.save(RAW, f.raw);
    await f.save(FLIPS, `${JSON.stringify(f.flips)}\n`);
    await assert.rejects(renderWordingProbe({ dataDirectory: f.directory }), /raw or flip evidence hash differs/);
    await f.save(FLIPS, f.flips);
    const selectionName = `decision-1b-selection-${VARIANT}.json`;
    const selection = await readFile(join(f.directory, selectionName), 'utf8');
    await f.save(selectionName, `${selection}\n`);
    await assert.rejects(renderWordingProbe({ dataDirectory: f.directory }), /model, identity or frozen selection binding differs/);
  } finally { await f.cleanup(); }
});

test('wording renderer rejects raw provenance changes even with a refreshed file hash', async () => {
  const f = await fixture();
  try {
    const mutations = [
      value => { value.cutoff = 0.2908; },
      value => { value.model.identityHash = '0'.repeat(64); },
      value => { value.runtimeSettings.batch = 512; },
      value => { value.corpusHashes['synthetic.json'] = '0'.repeat(64); },
      value => { value.status = 'running'; },
    ];
    for (const mutate of mutations) {
      const raw = clone(f.raw);
      mutate(raw);
      await f.save(RAW, raw);
      await f.save(SUMMARY, { ...f.summary, rawSha256: hash(JSON.stringify(raw)) });
      await assert.rejects(renderWordingProbe({ dataDirectory: f.directory }), /frozen runtime settings differ|raw provenance differs/);
    }
  } finally { await f.cleanup(); }
});
