/**
 * Lossless raw-evidence format v2. Inputs are column tables with dictionaries;
 * the deterministic plan is reconstructed from those inputs and checked by
 * SHA-256. Question texts are retained once. Request identities come from the
 * plan, while all measured values (including full-precision doubles) are kept.
 * No filesystem, model or corpus loader is used when expanding evidence.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { buildTonePlan } from './tone-label-study.mjs';

const FORMAT = 'tone-label-evidence-v2';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const insist = (ok, message) => { if (!ok) throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const IDENTITY = ['questionKey', 'postId', 'labelKey'];

function packTable(records, dictionaries) {
  const columns = [...new Set(records.flatMap(row => Object.keys(row)))];
  const pools = columns.map(() => []), lookups = columns.map(() => new Map());
  const values = records.map(row => columns.map((key, column) => {
    if (!Object.hasOwn(row, key)) return dictionaries ? -1 : null;
    if (!dictionaries) return row[key];
    const value = row[key], encoded = JSON.stringify(value);
    let index = lookups[column].get(encoded);
    if (index === undefined) {
      index = pools[column].length; pools[column].push(value); lookups[column].set(encoded, index);
    }
    return index;
  }));
  const missing = records.map(row => columns.flatMap((key, index) => Object.hasOwn(row, key) ? [] : [index]));
  return { columns, ...(dictionaries ? { dictionaries: pools } : missing.some(row => row.length) ? { missing } : {}), values };
}

function expandTable(table) {
  insist(record(table) && Array.isArray(table.columns) && table.columns.every(key => typeof key === 'string')
    && new Set(table.columns).size === table.columns.length && Array.isArray(table.values), 'Invalid tone evidence table');
  const pools = table.dictionaries;
  if (pools) insist(Array.isArray(pools) && pools.length === table.columns.length && pools.every(Array.isArray), 'Invalid tone evidence dictionaries');
  if (table.missing) insist(Array.isArray(table.missing) && table.missing.length === table.values.length
    && table.missing.every(row => Array.isArray(row) && new Set(row).size === row.length
      && row.every(index => Number.isSafeInteger(index) && index >= 0 && index < table.columns.length)), 'Invalid tone table presence flags');
  return table.values.map((values, row) => {
    insist(Array.isArray(values) && values.length === table.columns.length, 'Invalid tone evidence table row');
    return Object.fromEntries(values.flatMap((value, column) => {
      if (!pools) return table.missing?.[row].includes(column) ? [] : [[table.columns[column], value]];
      insist(Number.isSafeInteger(value) && value >= -1 && value < pools[column].length, 'Invalid tone dictionary index');
      return value === -1 ? [] : [[table.columns[column], pools[column][value]]];
    }));
  });
}

export function packToneEvidence(raw) {
  if (raw.evidenceFormat === FORMAT) { expandToneEvidence(raw); return raw; }
  insist(raw.schemaVersion === 1 && record(raw.plan) && Array.isArray(raw.rows) && Array.isArray(raw.requests), 'Expanded tone evidence is required');
  const { plan, rows, requests, ...metadata } = raw;
  const measurements = requests.map(request => {
    const expected = plan.requests[request.index];
    insist(expected && IDENTITY.every(key => request[key] === expected[key]), 'Tone request identity differs from plan');
    return Object.fromEntries(Object.entries(request).filter(([key]) => !IDENTITY.includes(key)));
  });
  // A raw record normally has the same fields on every request. Dictionary
  // tables also preserve optional fields, including absence versus null.
  return { ...metadata, schemaVersion: 2, evidenceFormat: FORMAT,
    rowTable: packTable(rows, true),
    planSpec: { phase: plan.phase, wordings: plan.wordingIds,
      policies: plan.policies.map(({ id, policy, optimize }) => ({ id, ...policy, ...(optimize ? { optimize: true } : {}) })) },
    planSha256: hash(plan), questions: plan.questions,
    requestTable: packTable(measurements, false) };
}

export function expandToneEvidence(raw) {
  if (raw.schemaVersion === 1 && raw.evidenceFormat === undefined) return raw;
  insist(raw.schemaVersion === 2 && raw.evidenceFormat === FORMAT && record(raw.planSpec), 'Unknown tone evidence format');
  const { evidenceFormat, rowTable, planSpec, planSha256, questions, requestTable, ...metadata } = raw;
  const rows = expandTable(rowTable);
  const plan = buildTonePlan({ phase: planSpec.phase, corpus: raw.corpusSnapshot, rows,
    wordings: planSpec.wordings, policies: planSpec.policies });
  insist(hash(plan) === planSha256 && same(plan.questions, questions), 'Reconstructed tone plan SHA-256 or questions differ');
  const requests = expandTable(requestTable).map(measurement => {
    const expected = plan.requests[measurement.index];
    insist(expected, 'Tone measurement index is outside the plan');
    return { ...Object.fromEntries(IDENTITY.map(key => [key, expected[key]])), ...measurement };
  });
  return { ...metadata, schemaVersion: 1, rows, plan, requests };
}
