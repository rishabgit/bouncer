import { createHash } from 'node:crypto';
import { readFile, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { CORPUS_HASHES, validateSelection } from './corpora.mjs';
import { variantById } from './registry.mjs';
import { templateHash } from './templates.mjs';
import { caseIdentityHash } from './baselines.mjs';
import { scoreRows } from './metrics.mjs';

export const DATA = fileURLToPath(new URL('../../docs/benchmarks/data/', import.meta.url));
export const PREREGISTRATION_FILE = 'decision-preregistration.json';
// Publication-normalized phase-2 authority and baseline file digests.
export const PREREGISTRATION_SHA256 = '804e8f2ed5ce151e4cc71429e0652600f23ebf5f78c023585b4b747b4d6b0561';
export const BASELINES_SHA256 = '6814f37a9dae4c918507533a24087ab6c117a57a8634bf6763ac0834e0731852';
export const VALIDATION_CORPORA = Object.freeze([
  { dataset: 'isolation', file: 'native-isolation-holdout.json', count: 72 },
  { dataset: 'migration', file: 'native-migration-validation.json', count: 120 },
]);
const IDS = ['llama-d1-2b-q8', 'ollama-d1-2b-nvfp4'];
const GATES = {
  G1_newFalseHides: 'at most 1 false hide on a case Browser showed correctly',
  G2_exactVectors: "exact filter vectors >= Browser's count",
  G3_hideDecisions: "correct hide/show decisions >= Browser's count minus 1",
};
const insist = (condition, message) => { if (!condition) throw new Error(message); };
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

/** This interpreter accepts precisely the registered experiment, not arbitrary prose gates. */
export function checkPreregistration(document) {
  insist(document?.schemaVersion === 1 && Array.isArray(document.candidates)
    && same(document.candidates.map(c => c?.variantId), IDS), 'Pre-registration must name exactly the two authorized candidates in order');
  insist(same(document.corpora, VALIDATION_CORPORA.map(c => `${c.file} (${c.count} cases)`))
    && same(document.gatesPerCorpus, GATES), 'Pre-registration corpus or gate policy differs');
  for (const c of document.candidates) insist(c.selectionFile === `decision-1b-selection-${c.variantId}.json`
    && /^[a-f0-9]{64}$/.test(c.selectionSha256), 'Invalid pre-registration selection binding');
  return document.candidates;
}

/** Check exact bytes before parsing or accepting any frozen parameters. */
export function verifyValidationBindings({ preregistration, variantId, selectionBytes, identityRecord, discoveryBytes, runtimeSettings, corpusHashes }) {
  const registered = checkPreregistration(preregistration).find(c => c.variantId === variantId);
  insist(registered, `Variant is not pre-registered: ${variantId}`);
  insist(sha256(selectionBytes) === registered.selectionSha256, `Pre-registered selection SHA-256 differs: ${variantId}`);
  const selection = JSON.parse(selectionBytes.toString()), discovery = JSON.parse(discoveryBytes.toString());
  const variant = variantById(variantId);
  insist(identityRecord?.schemaVersion === 2 && same(identityRecord.variant, variant)
    && identityRecord.identity && selection.identityHash === sha256(identityRecord.identity), `Frozen artifact identity differs: ${variantId}`);
  insist(selection.phase === 'discovery' && selection.discoverySha256 === sha256(discoveryBytes)
    && discovery.schemaVersion === 2 && discovery.phase === 'discovery' && same(discovery.variant, variant)
    && discovery.identityHash === selection.identityHash && same(discovery.corpusHashes, corpusHashes)
    && same(discovery.runtimeSettings, selection.runtimeSettings), `Frozen discovery binding differs: ${variantId}`);
  validateSelection(selection, { id: variantId, templateId: selection.templateId }, corpusHashes, templateHash(selection.templateId), runtimeSettings);
  return { registered, variant, selection, identity: identityRecord.identity };
}

export async function loadValidationPlan(dataDirectory = DATA, requestedId) {
  const preregistrationBytes = await readFile(join(dataDirectory, PREREGISTRATION_FILE));
  insist(sha256(preregistrationBytes) === PREREGISTRATION_SHA256, 'Committed pre-registration SHA-256 differs');
  const preregistration = JSON.parse(preregistrationBytes), candidates = checkPreregistration(preregistration);
  if (requestedId !== undefined) insist(candidates.some(c => c.variantId === requestedId), `Variant is not pre-registered: ${requestedId}`);
  const baselinesBytes = await readFile(join(dataDirectory, 'decision-baselines.json'));
  insist(sha256(baselinesBytes) === BASELINES_SHA256, 'Committed Browser/QAT baseline SHA-256 differs');
  const plans = [];
  for (const c of candidates.filter(c => requestedId === undefined || c.variantId === requestedId)) {
    const selectionBytes = await readFile(join(dataDirectory, c.selectionFile));
    const identityRecord = JSON.parse(await readFile(join(dataDirectory, `decision-1b-identity-${c.variantId}.json`)));
    const discoveryBytes = await readFile(join(dataDirectory, `decision-1b-discovery-${c.variantId}.json`));
    const runtimeSettings = JSON.parse(selectionBytes).runtimeSettings;
    plans.push({ ...verifyValidationBindings({ preregistration, variantId: c.variantId, selectionBytes, identityRecord, discoveryBytes,
      runtimeSettings, corpusHashes: CORPUS_HASHES }), preregistration, selectionBytes, identityRecord, discoveryBytes });
  }
  return { plans, baselines: JSON.parse(baselinesBytes), baselineSha256: sha256(baselinesBytes) };
}

export const resultFile = (id, dataset) => `decision-validation-${id}-${dataset}.json`;
export const attemptFile = id => `decision-validation-attempt-${id}.json`;
export async function assertNotAttempted(id, dataDirectory = DATA) {
  for (const name of [attemptFile(id), ...VALIDATION_CORPORA.map(c => resultFile(id, c.dataset))]) {
    const found = await stat(join(dataDirectory, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    insist(!found, `Validation was already attempted for ${id}: ${name}; no retry is permitted`);
  }
}

/** Exclusive permanent claim; it is retained after success, error or interruption. */
export async function claimAttempt(attempt, dataDirectory = DATA) {
  await assertNotAttempted(attempt.variantId, dataDirectory);
  const handle = await open(join(dataDirectory, attemptFile(attempt.variantId)), 'wx');
  try { await handle.writeFile(JSON.stringify(attempt, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

/** Reconstruct historical vectors from identity-bound recorded matches, never a new model run. */
export function recordedBaseline(cases, document, collectionName, dataset) {
  const collection = document.baselineCollections?.[collectionName], meta = collection?.datasets?.[dataset];
  if (!meta && collectionName !== 'browser') return null;
  const source = VALIDATION_CORPORA.find(c => c.dataset === dataset);
  insist(source && meta?.sourceCorpus === source.file && meta.corpusSha256 === CORPUS_HASHES[source.file]
    && meta.caseCount === cases.length && meta.recordedCases === cases.length && meta.unavailableCases === 0, 'Recorded baseline corpus coverage differs');
  const map = new Map(), rows = cases.map(c => {
    const key = `${c.corpus}:${c.id}`, e = collection.caseEvidenceById?.[key];
    insist(e?.status === 'recorded' && e.corpusSha256 === meta.corpusSha256 && e.dataset === dataset
      && e.caseIdentitySha256 === caseIdentityHash(c) && same(e.expected, c.expected)
      && Array.isArray(e.matches) && new Set(e.matches).size === e.matches.length
      && e.matches.every(f => c.filters.includes(f)) && e.shouldHide === (e.matches.length > 0)
      && e.sourceIds?.every(id => meta.sourceIds.includes(id) && document.baselineSources[id]), `Missing or inconsistent baseline vector: ${key}`);
    map.set(key, e.shouldHide);
    return { ...c, probabilities: c.filters.map(f => Number(e.matches.includes(f))) };
  });
  const scores = scoreRows(rows, .5, map), all = scores.all;
  insist(all.exactVectors === meta.quality.exactVectorCorrectCases && all.hide.tp + all.hide.tn === meta.quality.correctHideCases,
    'Recorded baseline aggregate differs from per-case vectors');
  return { map, scores, sourceIds: meta.sourceIds };
}

export function validationGates(scores, browserScores) {
  const actual = scores.all, reference = browserScores.all;
  insist(actual.pairedAvailable === true && Number.isSafeInteger(actual.newFalseHides), 'Validation gates require complete paired Browser evidence');
  const correct = actual.hide.tp + actual.hide.tn, minimum = reference.hide.tp + reference.hide.tn - 1;
  const gates = {
    G1: { metric: 'newFalseHides', actual: actual.newFalseHides, max: 1, pass: actual.newFalseHides <= 1 },
    G2: { metric: 'exactVectors', actual: actual.exactVectors, min: reference.exactVectors, pass: actual.exactVectors >= reference.exactVectors },
    G3: { metric: 'correctHideDecisions', actual: correct, min: minimum, pass: correct >= minimum },
  };
  return { gates, pass: Object.values(gates).every(g => g.pass) };
}
