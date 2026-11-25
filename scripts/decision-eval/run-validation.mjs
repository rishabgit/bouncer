import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { DATA, PREREGISTRATION_FILE, PREREGISTRATION_SHA256, VALIDATION_CORPORA, loadValidationPlan,
  assertNotAttempted, claimAttempt, attemptFile, resultFile, verifyValidationBindings, recordedBaseline, validationGates, sha256 } from './validation.mjs';
import { CORPUS_HASHES, loadCorpora } from './corpora.mjs';
import { caseIdentityHash, loadBaselines } from './baselines.mjs';
import { scoreRows } from './metrics.mjs';
import { ENDPOINTS } from './registry.mjs';
import { publicValue, LOCAL, json, assertExclusive, assertPreset, assertPinned, classify, runtimeInfo,
  normalizedSettings, verifyPinned, identity, unload } from './runtime.mjs';
import { environment } from './observations.mjs';

// Progress is checkpointed after each response. An issued-but-unrecorded request
// consumes the attempt too; there is intentionally no resume/retry mode.
async function checkpoint(file, value) {
  await mkdir(LOCAL, { recursive: true });
  const temp = new URL(`phase2-${basename(file)}.tmp`, LOCAL);
  await writeFile(temp, JSON.stringify(publicValue(value), null, 2) + '\n');
  await rename(temp, file);
}
const announce = text => console.log(`${new Date().toISOString()} ${text}`);

async function verifyCurrentArtifact(plan) {
  const { variant: v, identity: frozen } = plan;
  await verifyPinned(v, frozen);
  if (v.runtime === 'ollama') {
    const alias = frozen.aliasDefinition;
    const tags = (await json(`${ENDPOINTS.ollama}/api/tags`)).models;
    const current = JSON.parse(JSON.stringify(await identity(v, alias)));
    if (tags.find(m => m.name === alias.from)?.digest !== alias.sourceDigest
      || !same(current, frozen)) throw new Error(`Current Ollama artifact or derived alias differs: ${v.id}`);
  } else {
    const entries = (await json(`${ENDPOINTS.llama}/models`)).data;
    assertPreset(v, entries.find(m => m.id === v.model));
  }
}

async function observedSettings(plan) {
  const info = await runtimeInfo(plan.variant);
  const settings = normalizedSettings(plan.variant, info, plan.identity.aliasDefinition ?? null);
  assertPinned(plan.variant, settings);
  verifyValidationBindings({ ...plan, variantId: plan.variant.id, runtimeSettings: settings, corpusHashes: CORPUS_HASHES });
  return settings;
}

async function runCandidate(plan, baselines, baselineSha256, discovery) {
  const v = plan.variant, s = plan.selection, runId = randomUUID();
  await assertExclusive(v);
  await verifyCurrentArtifact(plan);
  const provenance = {
    runId, preregistration: { file: PREREGISTRATION_FILE, sha256: PREREGISTRATION_SHA256 },
    selection: { file: plan.registered.selectionFile, sha256: plan.registered.selectionSha256,
      templateId: s.templateId, templateHash: s.templateHash, cutoff: s.cutoff },
    identityHash: s.identityHash, runtimeSettings: s.runtimeSettings, corpusHashes: CORPUS_HASHES,
  };
  const attempt = { schemaVersion: 1, phase: 'validation-attempt', variantId: v.id, ...provenance,
    startedAt: new Date().toISOString(), status: 'running', validationRequestsIssued: 0, completedCases: 0, activeCase: null };
  await claimAttempt(attempt);
  const attemptPath = join(DATA, attemptFile(v.id));
  let current, currentPath, failure;
  try {
    // This canary is discovery data, not a validation case. No holdout request
    // is sent until the loaded runner's effective settings match the freeze.
    const canary = discovery.cases[0];
    attempt.preflight = { caseId: `${canary.corpus}:${canary.id}`, split: 'discovery',
      ...await classify(v, canary.text, canary.filters, s.templateId, s.runtimeSettings.effectiveContext) };
    attempt.runtimeSettings = await observedSettings(plan);
    await assertExclusive(v, true);
    const corpus = await loadCorpora({ split: 'validation', selection: s,
      variant: { id: v.id, templateId: s.templateId }, templateHash: s.templateHash, runtimeSettings: attempt.runtimeSettings });
    // Check both baseline datasets completely before issuing the first holdout request.
    const datasets = [];
    for (const c of VALIDATION_CORPORA) {
      const cases = corpus.cases.filter(row => row.sourceCorpus === c.file);
      if (cases.length !== c.count) throw new Error(`Validation case count differs: ${c.file}`);
      const browser = recordedBaseline(cases, baselines, 'browser', c.dataset);
      const checked = await loadBaselines(cases, { corpusHash: CORPUS_HASHES[c.file] });
      if (!same(browser.map, checked)) throw new Error('Paired Browser baseline differs');
      const qat = recordedBaseline(cases, baselines, 'textOnlyQat', c.dataset);
      if (qat && !same(qat.map, await loadBaselines(cases, { corpusHash: CORPUS_HASHES[c.file], baseline: 'textOnlyQat' }))) throw new Error('Text-only QAT baseline differs');
      datasets.push({ ...c, cases, browser, qat });
    }
    await checkpoint(attemptPath, attempt);
    for (const c of datasets) {
      await observedSettings(plan);
      currentPath = join(DATA, resultFile(v.id, c.dataset));
      const baseline = { browser: { scores: c.browser.scores, sourceIds: c.browser.sourceIds }, textOnlyQat: c.qat ? {
        scores: c.qat.scores, sourceIds: c.qat.sourceIds,
        contextTokens: baselines.sources.currentTextOnlyQatContract.contextTokens,
        runtime: baselines.sources.currentTextOnlyQatContract.runtime, artifact: baselines.sources.currentTextOnlyQatContract,
      } : null };
      current = { schemaVersion: 1, phase: 'validation', status: 'running', variant: v, ...provenance,
        dataset: c.dataset, sourceCorpus: c.file, corpusSha256: CORPUS_HASHES[c.file], baselineSha256,
        baseline, environment: publicValue(await environment()), startedAt: new Date().toISOString(), rows: [] };
      // Exclusive creation is a second barrier against overwriting a prior run.
      await writeFile(currentPath, JSON.stringify(publicValue(current), null, 2) + '\n', { flag: 'wx' });
      announce(`validation ${v.id} ${c.dataset} ${c.cases.length} cases; frozen cutoff ${s.cutoff}`);
      for (const row of c.cases) {
        attempt.activeCase = { dataset: c.dataset, key: `${row.corpus}:${row.id}` };
        attempt.validationRequestsIssued++;
        await checkpoint(attemptPath, attempt);
        const output = await classify(v, row.text, row.filters, s.templateId, s.runtimeSettings.effectiveContext);
        current.rows.push({ id: row.id, corpus: row.corpus, sourceCorpus: c.file,
          caseIdentitySha256: caseIdentityHash(row), filters: row.filters, expected: row.expected, ...output });
        await checkpoint(currentPath, current);
        attempt.completedCases++;
        attempt.activeCase = null;
        await checkpoint(attemptPath, attempt);
      }
      await observedSettings(plan);
      current.atFrozen = scoreRows(current.rows, s.cutoff, c.browser.map);
      current.at05 = scoreRows(current.rows, .5, c.browser.map);
      current.pairedVsTextOnlyQat = c.qat ? scoreRows(current.rows, s.cutoff, c.qat.map) : null;
      Object.assign(current, validationGates(current.atFrozen, c.browser.scores));
      current.status = 'complete'; current.finishedAt = new Date().toISOString();
      await checkpoint(currentPath, current);
      announce(`completed ${v.id} ${c.dataset}: ${current.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(current.gates)}`);
    }
    // Read the two immutable output choices, never re-evaluate any case.
    attempt.pass = (await Promise.all(VALIDATION_CORPORA.map(async c => JSON.parse(await readFile(join(DATA, resultFile(v.id, c.dataset))))))).every(r => r.pass);
  } catch (error) {
    failure = error;
    if (current?.status === 'running') {
      current.status = 'failed'; current.error = publicValue(error.message); current.failedAt = new Date().toISOString();
      await checkpoint(currentPath, current);
    }
  } finally {
    try { await unload(v); } catch (error) { failure ??= error; }
    attempt.status = failure ? 'failed' : 'complete';
    attempt.finishedAt = new Date().toISOString();
    if (failure) attempt.error = publicValue(failure.message);
    await checkpoint(attemptPath, attempt);
  }
  if (failure) throw new Error(`Validation attempt ${runId} failed for ${v.id}; no retry permitted: ${publicValue(failure.message)}`, { cause: failure });
}

export async function runValidation(requestedId) {
  const { plans, baselines, baselineSha256 } = await loadValidationPlan(DATA, requestedId);
  const discovery = await loadCorpora('discovery'); // Also verifies all four corpus byte hashes.
  // Fail before any inference if any requested candidate has prior evidence or changed artifacts.
  for (const plan of plans) { await assertNotAttempted(plan.variant.id); await assertExclusive(plan.variant); await verifyCurrentArtifact(plan); }
  for (const plan of plans) await runCandidate(plan, baselines, baselineSha256, discovery);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [id, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Usage: node scripts/decision-eval/run-validation.mjs [registered-id]');
  runValidation(id).catch(error => { console.error(publicValue(error.message)); process.exitCode = 1; });
}
