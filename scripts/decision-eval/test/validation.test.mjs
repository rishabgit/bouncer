import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CORPUS_HASHES } from '../corpora.mjs';
import { variantById } from '../registry.mjs';
import { templateHash } from '../templates.mjs';
import { checkPreregistration, verifyValidationBindings, loadValidationPlan, claimAttempt, assertNotAttempted,
  resultFile, attemptFile, validationGates, recordedBaseline, sha256, PREREGISTRATION_SHA256 } from '../validation.mjs';

const rawRegistration = await readFile(new URL('../../../docs/benchmarks/data/decision-preregistration.json', import.meta.url));
const registration = JSON.parse(rawRegistration);
const clone = value => structuredClone(value);
async function scratch(callback) {
  const root = new URL('../.tmp/', import.meta.url); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(new URL('validation-test-', root));
  try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function bindings() {
  const preregistration = clone(registration), variant = variantById(preregistration.candidates[0].variantId);
  const runtimeSettings = { runtime: 'llama', version: 'test', build: 'test', effectiveContext: 4096,
    parallel: 1, batch: 4096, ubatch: 4096, projector: false, runner: 'llamacpp', quantization: 'Q8_0', aliasDefinition: null };
  const identityRecord = { schemaVersion: 2, variant, identity: { sha256: 'a'.repeat(64) } };
  const identityHash = sha256(identityRecord.identity);
  const discoveryBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, phase: 'discovery', variant, identityHash, corpusHashes: CORPUS_HASHES, runtimeSettings }));
  const selection = { schemaVersion: 2, phase: 'discovery', frozen: true, variantId: variant.id,
    templateId: 'matches-category', templateHash: templateHash('matches-category'), cutoff: .3,
    identityHash, discoverySha256: sha256(discoveryBytes), corpusHashes: CORPUS_HASHES, runtimeSettings };
  const selectionBytes = Buffer.from(JSON.stringify(selection));
  preregistration.candidates[0].selectionSha256 = sha256(selectionBytes);
  return { preregistration, variantId: variant.id, selectionBytes, identityRecord, discoveryBytes, runtimeSettings, corpusHashes: CORPUS_HASHES };
}

test('phase2 production plan binds the committed pre-registration and exactly two selections without inference', async () => {
  assert.equal(sha256(rawRegistration), PREREGISTRATION_SHA256);
  const result = await loadValidationPlan();
  assert.deepEqual(result.plans.map(p => p.variant.id), ['llama-d1-2b-q8', 'ollama-d1-2b-nvfp4']);
  await assert.rejects(loadValidationPlan(undefined, 'ollama-d1-2b-mxfp8'), /not pre-registered/);
});

test('pre-registration refuses missing, unknown, duplicate, path-traversing and changed-policy authority', () => {
  assert.throws(() => checkPreregistration(), /Pre-registration/);
  for (const change of [
    d => { d.schemaVersion = 2; }, d => { d.candidates.pop(); },
    d => { d.candidates[1] = clone(d.candidates[0]); },
    d => { d.candidates[1].variantId = 'ollama-d1-2b-mxfp8'; },
    d => { d.candidates[0].selectionFile = '../selection.json'; },
    d => { d.candidates[0].selectionSha256 = 'bad'; },
    d => { d.corpora.reverse(); }, d => { d.gatesPerCorpus.G1_newFalseHides = 'at most 2'; },
  ]) { const d = clone(registration); change(d); assert.throws(() => checkPreregistration(d)); }
});

test('validation guard refuses selection bytes, artifact, discovery, runtime or corpus drift', () => {
  const b = bindings(); assert.equal(verifyValidationBindings(b).selection.cutoff, .3);
  assert.throws(() => verifyValidationBindings({ ...b, variantId: 'llama-d1-2b-q4km' }), /not pre-registered/);
  assert.throws(() => verifyValidationBindings({ ...b, selectionBytes: Buffer.concat([b.selectionBytes, Buffer.from('\n')]) }), /selection SHA-256/);
  const identityRecord = clone(b.identityRecord); identityRecord.identity.sha256 = 'b'.repeat(64);
  assert.throws(() => verifyValidationBindings({ ...b, identityRecord }), /artifact identity/);
  assert.throws(() => verifyValidationBindings({ ...b, discoveryBytes: Buffer.concat([b.discoveryBytes, Buffer.from('\n')]) }), /discovery binding/);
  assert.throws(() => verifyValidationBindings({ ...b, runtimeSettings: { ...b.runtimeSettings, effectiveContext: 8192 } }), /runtime settings/);
  assert.throws(() => verifyValidationBindings({ ...b, corpusHashes: { ...CORPUS_HASHES, 'native-isolation-holdout.json': '0'.repeat(64) } }), /discovery binding|corpus hashes/);
});

test('validation refuses absent or edited pre-registration bytes before loading a model', async () => {
  await scratch(async directory => {
    await assert.rejects(loadValidationPlan(directory), /ENOENT/);
    await writeFile(join(directory, 'decision-preregistration.json'), Buffer.concat([rawRegistration, Buffer.from('\n')]));
    await assert.rejects(loadValidationPlan(directory), /pre-registration SHA-256 differs/);
  });
});

test('permanent attempt claims prevent retry after failure, orphan outputs and concurrent starts', async () => {
  const id = registration.candidates[0].variantId;
  await scratch(async directory => {
    const attempt = { variantId: id, status: 'failed', runId: 'synthetic' };
    await claimAttempt(attempt, directory);
    await assert.rejects(claimAttempt(attempt, directory), /already attempted/);
    await assert.rejects(assertNotAttempted(id, directory), /no retry/);
    assert.equal(JSON.parse(await readFile(join(directory, attemptFile(id)))).status, 'failed');
  });
  await scratch(async directory => {
    await writeFile(join(directory, resultFile(id, 'migration')), '{}');
    await assert.rejects(assertNotAttempted(id, directory), /already attempted/);
  });
  await scratch(async directory => {
    const attempts = await Promise.allSettled([claimAttempt({ variantId: id }, directory), claimAttempt({ variantId: id }, directory)]);
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  });
});

test('registered gate boundaries pass equality and fail each excess or deficit independently', () => {
  const browser = { all: { exactVectors: 60, hide: { tp: 50, tn: 19 } } };
  const group = { pairedAvailable: true, newFalseHides: 1, exactVectors: 60, hide: { tp: 49, tn: 19 } };
  assert.equal(validationGates({ all: group }, browser).pass, true);
  for (const [field, value, gate] of [['newFalseHides', 2, 'G1'], ['exactVectors', 59, 'G2'], ['hide', { tp: 48, tn: 19 }, 'G3']]) {
    const result = validationGates({ all: { ...group, [field]: value } }, browser);
    assert.equal(result.pass, false); assert.equal(result.gates[gate].pass, false);
    assert.equal(Object.values(result.gates).filter(g => !g.pass).length, 1);
  }
  assert.throws(() => validationGates({ all: { ...group, pairedAvailable: false } }, browser), /complete paired/);
});

test('recorded validation vectors reproduce Browser aggregates and keep text-only QAT separate', async () => {
  const document = JSON.parse(await readFile(new URL('../../../docs/benchmarks/data/decision-baselines.json', import.meta.url)));
  for (const [dataset, name, exact, correct] of [['isolation', 'native-isolation-holdout.json', 60, 69], ['migration', 'native-migration-validation.json', 110, 118]]) {
    const input = JSON.parse(await readFile(new URL('../corpora/' + name, import.meta.url)));
    const cases = input.cases.map(c => ({ ...c, corpus: c.filters.length === 1 && c.filters[0] === 'rage bait' ? 'rage' : 'broad',
      expected: c.filters.map(f => c.expectedMatches.includes(f)) }));
    const b = recordedBaseline(cases, document, 'browser', dataset);
    assert.equal(b.scores.all.exactVectors, exact); assert.equal(b.scores.all.hide.tp + b.scores.all.hide.tn, correct);
    const qat = recordedBaseline(cases, document, 'textOnlyQat', dataset);
    if (dataset === 'isolation') assert.equal(qat, null); else assert.equal(qat.scores.all.exactVectors, 115);
    const bad = clone(document); const e = bad.baselineCollections.browser.caseEvidenceById[`${cases[0].corpus}:${cases[0].id}`]; e.caseIdentitySha256 = '0'.repeat(64);
    assert.throws(() => recordedBaseline(cases, bad, 'browser', dataset), /baseline vector/);
  }
});
