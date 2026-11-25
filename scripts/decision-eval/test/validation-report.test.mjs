import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CORPUS_HASHES } from '../corpora.mjs';
import { buildReport } from '../report.mjs';
import { VARIANTS } from '../registry.mjs';
import { TEMPLATES, templateHash } from '../templates.mjs';
import { renderValidation } from '../validation-report.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const datasets = { isolation: 'native-isolation-holdout.json', migration: 'native-migration-validation.json' };
const candidateIds = ['llama-d1-2b-q8', 'ollama-d1-2b-nvfp4'];
const group = (n = 2) => ({ hide: { n, tp: n, tn: 0, fp: 0, fn: 0, f1: 1 }, totalVectors: n,
  exactVectors: n, falseHides: 0, missedHides: 0, newFalseHides: 0, newMissedHides: 0 });
const scores = () => ({ all: group(), rage: group(1), broad: group(1) });
const gates = (frozen, browser) => ({
  G1: { metric: 'newFalseHides', actual: frozen.all.newFalseHides, max: 1, pass: frozen.all.newFalseHides <= 1 },
  G2: { metric: 'exactVectors', actual: frozen.all.exactVectors, min: browser.all.exactVectors, pass: frozen.all.exactVectors >= browser.all.exactVectors },
  G3: { metric: 'correctHideDecisions', actual: frozen.all.hide.tp + frozen.all.hide.tn,
    min: browser.all.hide.tp + browser.all.hide.tn - 1,
    pass: frozen.all.hide.tp + frozen.all.hide.tn >= browser.all.hide.tp + browser.all.hide.tn - 1 },
});

async function fixture() {
  const scratch = new URL('../.tmp/', import.meta.url);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(new URL('validation-report-test-', scratch));
  const save = (name, value) => writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  const baseline = { baselines: [], sources: { currentTextOnlyQatContract: {
    alias: 'qualified-text-only', manifestDigest: 'c'.repeat(64), runtime: 'Ollama 0.40.3', contextTokens: 1024,
  } } };
  await save('decision-baselines.json', baseline);
  const candidates = [];
  const bindings = [];
  for (const variantId of candidateIds) {
    const variant = VARIANTS.find(item => item.id === variantId);
    const identity = { sha256: 'a'.repeat(64), disk: { logicalBytes: 100, allocatedBytes: 512, scope: 'test fixture' } };
    const runtimeSettings = { runtime: variant.runtime, effectiveContext: 4096, parallel: 1, projector: 'none', version: 'test' };
    const discovery = { schemaVersion: 2, phase: 'discovery', variant, identityHash: hash(identity), corpusHashes: CORPUS_HASHES,
      runtimeSettings, templates: TEMPLATES.map(template => ({ id: template.id, hash: templateHash(template.id), rows: [],
        optimized: { cutoff: 0.7, interval: { lower: 0.6, upper: 0.8 }, scores: scores() }, at05: scores() })) };
    const selection = { schemaVersion: 2, phase: 'discovery', frozen: true, variantId, identityHash: hash(identity),
      templateId: TEMPLATES[0].id, templateHash: templateHash(TEMPLATES[0].id), cutoff: 0.7,
      interval: discovery.templates[0].optimized.interval, runtimeSettings, corpusHashes: CORPUS_HASHES, discoverySha256: hash(discovery) };
    const file = `decision-1b-selection-${variantId}.json`;
    await save(`decision-1b-identity-${variantId}.json`, { schemaVersion: 2, variant, identity });
    await save(`decision-1b-discovery-${variantId}.json`, discovery);
    await save(file, selection);
    candidates.push({ variantId, selectionFile: file, selectionSha256: hash(selection), why: 'synthetic preregistration' });
    bindings.push({ variant, identityHash: hash(identity), runtimeSettings,
      selection: { file, sha256: hash(selection), templateId: selection.templateId, templateHash: selection.templateHash, cutoff: selection.cutoff } });
  }
  const preregistration = { schemaVersion: 1, candidates, corpora: ['native-isolation-holdout.json (72 cases)', 'native-migration-validation.json (120 cases)'],
    gatesPerCorpus: { G1_newFalseHides: 'at most 1 false hide on a case Browser showed correctly',
      G2_exactVectors: "exact filter vectors >= Browser's count", G3_hideDecisions: "correct hide/show decisions >= Browser's count minus 1" } };
  await save('decision-preregistration.json', preregistration);
  const registrationBinding = { file: 'decision-preregistration.json', sha256: hash(preregistration) };
  async function writeCandidate(index = 0) {
    const binding = bindings[index];
    const common = { schemaVersion: 1, status: 'complete', runId: `synthetic-run-${index}`, preregistration: registrationBinding,
      selection: binding.selection, identityHash: binding.identityHash, runtimeSettings: binding.runtimeSettings,
      corpusHashes: CORPUS_HASHES, startedAt: '2026-11-25T00:00:00.000Z', finishedAt: '2026-11-25T00:00:01.000Z' };
    const attempt = { ...common, phase: 'validation-attempt', variantId: binding.variant.id };
    await save(`decision-validation-attempt-${binding.variant.id}.json`, attempt);
    const results = {};
    for (const [dataset, sourceCorpus] of Object.entries(datasets)) {
      const result = { ...common, phase: 'validation', variant: binding.variant, dataset, sourceCorpus,
        corpusSha256: CORPUS_HASHES[sourceCorpus], baselineSha256: hash(baseline), environment: { synthetic: true },
        rows: [{ id: 'tiny-rage', corpus: 'rage', sourceCorpus, filters: ['rage bait'], expected: [true], probabilities: [0.01],
          wallMs: 1, usage: { input_tokens: 2 } }, { id: 'tiny-broad', corpus: 'broad', sourceCorpus,
          filters: ['synthetic'], expected: [true], probabilities: [0.01], wallMs: 1, usage: { input_tokens: 2 } }],
        atFrozen: scores(), at05: scores(), baseline: { browser: { scores: scores(), sourceIds: ['synthetic-browser'] },
          textOnlyQat: dataset === 'migration' ? { scores: scores(), sourceIds: ['synthetic-text-qat'],
            runtime: 'Ollama 0.40.3', contextTokens: 1024, artifact: baseline.sources.currentTextOnlyQatContract } : null },
        pairedVsTextOnlyQat: dataset === 'migration' ? scores() : null, pass: true };
      result.gates = gates(result.atFrozen, result.baseline.browser.scores);
      results[dataset] = result;
      await save(`decision-validation-${binding.variant.id}-${dataset}.json`, result);
    }
    return { attempt, results, variantId: binding.variant.id };
  }
  return { directory, save, baseline, preregistration, bindings, writeCandidate,
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('validation renderer omits phase 2 without a preregistration and shows pending when registered', async () => {
  const f = await fixture();
  try {
    let result = await renderValidation({ dataDirectory: f.directory });
    assert.equal(result.hasResults, false);
    assert.equal(result.complete, 0);
    assert.match(result.markdown, /Validation is pending; no run is recorded/);
    assert.match(result.markdown, /NOT RUN/);
    assert.doesNotMatch(result.markdown, /\| PASS \|/);
    await rm(join(f.directory, 'decision-preregistration.json'));
    result = await renderValidation({ dataDirectory: f.directory });
    assert.equal(result.markdown, '');
    const report = await buildReport({ partial: true, dataDirectory: f.directory });
    assert.match(report.markdown, /^# Decision-model evaluation\n/);
    assert.match(report.markdown, /## Detailed recorded evidence: phase 1b\n/);
    assert.doesNotMatch(report.markdown, /## Phase 2:/);
  } finally { await f.cleanup(); }
});

test('validation renderer displays both corpora, all gates and stored non-gated metrics without scoring', async () => {
  const f = await fixture();
  try {
    const { results, variantId } = await f.writeCandidate();
    // Deliberately use contradictory synthetic probabilities: rendering must
    // retain the stored scores instead of silently performing another scoring run.
    results.migration.at05.all.newMissedHides = 17;
    results.migration.pairedVsTextOnlyQat.all.newMissedHides = 23;
    await f.save(`decision-validation-${variantId}-migration.json`, results.migration);
    const rendered = await renderValidation({ dataDirectory: f.directory });
    assert.equal(rendered.hasResults, true);
    assert.equal(rendered.complete, 1);
    assert.match(rendered.markdown, /llama-d1-2b-q8 \| PASS \| PASS \(complete\) \| PASS \(complete\)/);
    assert.match(rendered.markdown, /G1: newFalseHides \| 0 \| ≤ 1 \| PASS/);
    assert.match(rendered.markdown, /G2: exactVectors \| 2 \| ≥ 2 \| PASS/);
    assert.match(rendered.markdown, /G3: correctHideDecisions \| 2 \| ≥ 1 \| PASS/);
    assert.match(rendered.markdown, /Fixed ≥ 0\.5 \(not gated\).*0 \/ 17/);
    assert.match(rendered.markdown, /Ollama 0\.40\.3; context 1024 tokens \| 0 \| 23/);
    assert.match(rendered.markdown, /Both validation corpora were previously used to qualify Gemma/);
    assert.match(rendered.markdown, /Rage hide F1/);
    assert.doesNotMatch(rendered.markdown, /recommended|My pick|replace Gemma|\/Users\//);
    const report = await buildReport({ partial: true, dataDirectory: f.directory });
    assert.match(report.markdown, /^# Decision-model evaluation\n/);
    assert.match(report.markdown, /## Detailed recorded evidence: phase 1b and phase 2\n/);
    assert.doesNotMatch(report.markdown, /This harness has run no decision-model validation/);
    assert.match(report.markdown, /Same template at 0\.5/);
    assert.match(report.markdown, /## Phase 2:/);
  } finally { await f.cleanup(); }
});

test('candidate fails when one stored corpus gate fails; other corpus pass cannot override it', async () => {
  const f = await fixture();
  try {
    const { results, variantId } = await f.writeCandidate();
    results.migration.atFrozen.all.exactVectors = 1;
    results.migration.gates = gates(results.migration.atFrozen, results.migration.baseline.browser.scores);
    results.migration.pass = false;
    await f.save(`decision-validation-${variantId}-migration.json`, results.migration);
    const result = await renderValidation({ dataDirectory: f.directory });
    assert.match(result.markdown, /llama-d1-2b-q8 \| FAIL \| PASS \(complete\) \| FAIL \(complete\)/);
    assert.match(result.markdown, /migration \| G2: exactVectors \| 1 \| ≥ 2 \| FAIL/);
  } finally { await f.cleanup(); }
});

test('failed and running attempts remain incomplete and cannot expose pass gates', async () => {
  const f = await fixture();
  try {
    const { attempt, results, variantId } = await f.writeCandidate();
    const attemptName = `decision-validation-attempt-${variantId}.json`;
    for (const dataset of Object.keys(datasets)) await rm(join(f.directory, `decision-validation-${variantId}-${dataset}.json`));
    await f.save(attemptName, { ...attempt, status: 'failed', error: 'synthetic early failure' });
    let result = await renderValidation({ dataDirectory: f.directory });
    assert.equal(result.complete, 0);
    assert.match(result.markdown, /FAILED \/ INCOMPLETE/);
    assert.match(result.markdown, /NOT EVALUATED/);
    assert.doesNotMatch(result.markdown, /\| PASS \|/);
    await f.save(attemptName, { ...attempt, status: 'running' });
    const running = { ...results.isolation, status: 'running' };
    for (const field of ['gates', 'pass', 'atFrozen', 'at05', 'baseline', 'pairedVsTextOnlyQat']) delete running[field];
    await f.save(`decision-validation-${variantId}-isolation.json`, running);
    result = await renderValidation({ dataDirectory: f.directory });
    assert.match(result.markdown, /llama-d1-2b-q8 \| INCOMPLETE \| running \| missing result \| running/);
    await f.save(`decision-validation-${variantId}-isolation.json`, { ...running, pass: true });
    await assert.rejects(renderValidation({ dataDirectory: f.directory }), /unfinished validation cannot claim/);
  } finally { await f.cleanup(); }
});

test('validation renderer rejects stale provenance and inconsistent gate flags', async () => {
  const f = await fixture();
  try {
    const { results, variantId } = await f.writeCandidate();
    const name = `decision-validation-${variantId}-isolation.json`;
    const mutations = [
      value => { value.preregistration.sha256 = '0'.repeat(64); },
      value => { value.selection.sha256 = '0'.repeat(64); },
      value => { value.selection.cutoff = 0.5; },
      value => { value.identityHash = '0'.repeat(64); },
      value => { value.runtimeSettings.effectiveContext = 1024; },
      value => { value.corpusHashes['eval-corpus.ts'] = '0'.repeat(64); },
      value => { value.corpusSha256 = '0'.repeat(64); },
      value => { value.baselineSha256 = '0'.repeat(64); },
      value => { value.runId = 'other-run'; },
      value => { value.gates.G1.pass = false; },
      value => { value.gates.G3.min = 0; },
      value => { value.pass = false; },
    ];
    for (const mutate of mutations) {
      const changed = clone(results.isolation);
      mutate(changed);
      await f.save(name, changed);
      await assert.rejects(renderValidation({ dataDirectory: f.directory }), /differs|differ|disagree/);
    }
    await f.save(name, results.isolation);
    const selectionName = f.preregistration.candidates[0].selectionFile;
    const original = await readFile(join(f.directory, selectionName), 'utf8');
    await f.save(selectionName, `${original}\n`);
    await assert.rejects(renderValidation({ dataDirectory: f.directory }), /current frozen selection or artifact identity differs/);
    await f.save(selectionName, original);
    const identityName = `decision-1b-identity-${variantId}.json`;
    const identity = JSON.parse(await readFile(join(f.directory, identityName), 'utf8'));
    identity.identity.sha256 = 'd'.repeat(64);
    await f.save(identityName, identity);
    await assert.rejects(renderValidation({ dataDirectory: f.directory }), /validation provenance differs/);
  } finally { await f.cleanup(); }
});

test('validation renderer rejects unexpected files, orphan results and changed baseline bytes', async () => {
  const f = await fixture();
  try {
    const { variantId } = await f.writeCandidate();
    const name = 'decision-validation-unregistered-isolation.json';
    await f.save(name, {});
    await assert.rejects(renderValidation({ dataDirectory: f.directory }), /Unexpected validation variant or corpus/);
    await rm(join(f.directory, name));
    const original = await readFile(join(f.directory, 'decision-baselines.json'), 'utf8');
    await f.save('decision-baselines.json', `${original}\n`);
    await assert.rejects(renderValidation({ dataDirectory: f.directory }), /baseline or run binding differs/);
    await f.save('decision-baselines.json', original);
    await rm(join(f.directory, `decision-validation-attempt-${variantId}.json`));
    await assert.rejects(renderValidation({ dataDirectory: f.directory }), /no single-run attempt receipt/);
    await rm(join(f.directory, 'decision-preregistration.json'));
    await assert.rejects(renderValidation({ dataDirectory: f.directory }), /requires decision-preregistration/);
  } finally { await f.cleanup(); }
});
