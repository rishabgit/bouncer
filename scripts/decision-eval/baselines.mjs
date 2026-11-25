import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const BASELINE_FILE = new URL('../../docs/benchmarks/data/decision-baselines.json', import.meta.url);
export const CASE_IDENTITY_ENCODING = 'sha256(JSON.stringify({id,text,filters,expected})); UTF-8; fixed property order; ordered filters and Boolean labels; no normalization';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function identity(item) {
  if (!record(item) || typeof item.id !== 'string' || !item.id.trim()
      || typeof item.text !== 'string' || !item.text.trim()
      || !Array.isArray(item.filters) || !item.filters.length
      || item.filters.some(value => typeof value !== 'string' || !value.trim())
      || new Set(item.filters).size !== item.filters.length
      || !Array.isArray(item.expected) || item.expected.length !== item.filters.length
      || item.expected.some(value => typeof value !== 'boolean')) {
    throw new Error('Baseline identity requires id, text, ordered filters and Boolean expected labels');
  }
  return { id: item.id, text: item.text, filters: [...item.filters], expected: [...item.expected] };
}

/** The encoding is identical for discovery, isolation and migration cases. */
export function caseIdentityHash(item) {
  return createHash('sha256').update(JSON.stringify(identity(item)), 'utf8').digest('hex');
}

/**
 * Import recorded Gemma decisions only. Missing evidence is an error; an
 * explicitly unavailable, identity-bound baseline returns null, never false.
 * corpusHash restricts a load to one exact frozen source document when supplied.
 * baseline='textOnlyQat' is an explicit alternative, never a Browser fallback.
 */
export async function loadBaselines(cases, { corpusHash, baseline = 'browser', dataFile = BASELINE_FILE } = {}) {
  if (!Array.isArray(cases)) throw new Error('Baseline cases must be an array');
  if (corpusHash !== undefined && !isHash(corpusHash)) throw new Error('Baseline corpus hash must be a lowercase SHA-256');
  const document = JSON.parse(await readFile(dataFile, 'utf8'));
  const collection = document.baselineCollections?.[baseline];
  if (document.schemaVersion !== 1 || document.caseIdentityEncoding !== CASE_IDENTITY_ENCODING
      || !record(collection) || !record(collection.caseEvidenceById)) {
    throw new Error(`Missing or invalid recorded baseline collection: ${baseline}`);
  }
  const values = new Map();
  for (const item of cases) {
    const canonicalHash = caseIdentityHash(item);
    if (typeof item.corpus !== 'string' || !item.corpus.trim()) throw new Error('Baseline case corpus is required');
    const key = `${item.corpus}:${item.id}`;
    if (values.has(key)) throw new Error(`Duplicate baseline case: ${key}`);
    const evidence = Object.hasOwn(collection.caseEvidenceById, key) ? collection.caseEvidenceById[key] : undefined;
    if (!record(evidence)) throw new Error(`Missing expected ${baseline} baseline: ${key}`);
    if (evidence.corpus !== item.corpus || evidence.id !== item.id
        || !isHash(evidence.corpusSha256) || evidence.caseIdentitySha256 !== canonicalHash
        || document.corpusSources?.[evidence.corpusSource]?.sha256 !== evidence.corpusSha256
        || (corpusHash !== undefined && evidence.corpusSha256 !== corpusHash)) {
      throw new Error(`Recorded baseline case identity or corpus hash differs: ${key}`);
    }
    if (evidence.status === 'unavailable') {
      if (evidence.shouldHide !== null || typeof evidence.unavailableReason !== 'string'
          || !evidence.unavailableReason.trim()) throw new Error(`Invalid unavailable baseline: ${key}`);
      values.set(key, null);
    } else if (evidence.status === 'recorded' && typeof evidence.shouldHide === 'boolean'
        && Number.isSafeInteger(evidence.observations) && evidence.observations > 0
        && Array.isArray(evidence.sourceIds) && evidence.sourceIds.length > 0
        && evidence.sourceIds.every(id => record(document.baselineSources?.[id]))) {
      values.set(key, evidence.shouldHide);
    } else {
      throw new Error(`Invalid recorded baseline decision: ${key}`);
    }
  }
  return values;
}
