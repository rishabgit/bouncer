import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { CORPUS_HASHES } from './corpora.mjs';
import { VARIANTS } from './registry.mjs';
import { templateHash } from './templates.mjs';

const REGISTRATION = 'decision-preregistration.json';
const CANDIDATES = ['llama-d1-2b-q8', 'ollama-d1-2b-nvfp4'];
const DATASETS = { isolation: 'native-isolation-holdout.json', migration: 'native-migration-validation.json' };
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => value == null ? '—' : String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const number = value => Number.isFinite(value) ? value.toFixed(4) : '—';
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(text).join(' | ')} |`)].join('\n');

async function read(directory, name, optional = false) {
  try {
    const bytes = await readFile(resolve(directory, name));
    return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`${name}: ${error.message}`, { cause: error });
  }
}

function registrationCandidates(document) {
  assert(document?.schemaVersion === 1 && Array.isArray(document.candidates)
    && document.candidates.length === CANDIDATES.length
    && document.candidates.every((candidate, index) => candidate.variantId === CANDIDATES[index]
      && candidate.selectionFile === `decision-1b-selection-${candidate.variantId}.json`
      && /^[0-9a-f]{64}$/.test(candidate.selectionSha256)), 'Validation preregistration candidate bindings differ');
  assert(same(document.corpora, ['native-isolation-holdout.json (72 cases)', 'native-migration-validation.json (120 cases)'])
    && same(document.gatesPerCorpus, {
      G1_newFalseHides: 'at most 1 false hide on a case Browser showed correctly',
      G2_exactVectors: "exact filter vectors >= Browser's count",
      G3_hideDecisions: "correct hide/show decisions >= Browser's count minus 1",
    }), 'Validation preregistration corpora or gates differ');
  return document.candidates;
}

function checkBinding(value, binding, label) {
  const { candidate, variant, selection, identity, preregistration } = binding;
  assert(value.schemaVersion === 1 && typeof value.runId === 'string' && value.runId.trim()
    && ['running', 'complete', 'failed'].includes(value.status), `${label}: validation receipt header differs`);
  assert(same(value.preregistration, { file: REGISTRATION, sha256: preregistration.sha256 })
    && same(value.selection, { file: candidate.selectionFile, sha256: candidate.selectionSha256,
      templateId: selection.templateId, templateHash: selection.templateHash, cutoff: selection.cutoff })
    && value.identityHash === hash(identity.identity)
    && value.identityHash === selection.identityHash
    && same(value.runtimeSettings, selection.runtimeSettings)
    && same(value.corpusHashes, CORPUS_HASHES), `${label}: validation provenance differs`);
  if (value.phase === 'validation-attempt') assert(value.variantId === variant.id, `${label}: attempt variant differs`);
  else assert(value.phase === 'validation' && same(value.variant, variant), `${label}: result variant differs`);
}

function checkScores(scores, label) {
  assert(record(scores) && ['all', 'rage', 'broad'].every(key => {
    const group = scores[key];
    return record(group) && integer(group.exactVectors) && integer(group.totalVectors)
      && group.exactVectors <= group.totalVectors && record(group.hide)
      && ['n', 'tp', 'tn', 'fp', 'fn'].every(field => integer(group.hide[field]))
      && group.hide.n === group.totalVectors
      && group.hide.tp + group.hide.tn + group.hide.fp + group.hide.fn === group.hide.n
      && integer(group.falseHides) && integer(group.missedHides)
      && (group.newFalseHides === null || integer(group.newFalseHides))
      && (group.newMissedHides === null || integer(group.newMissedHides));
  }), `${label}: stored scores are incomplete or invalid`);
}

function checkComplete(result, baselineDocument, label) {
  checkScores(result.atFrozen, label);
  checkScores(result.at05, label);
  checkScores(result.baseline?.browser?.scores, label);
  assert(Array.isArray(result.rows) && result.rows.length === result.atFrozen.all.totalVectors
    && result.at05.all.totalVectors === result.rows.length
    && result.baseline.browser.scores.all.totalVectors === result.rows.length
    && Array.isArray(result.baseline.browser.sourceIds) && result.baseline.browser.sourceIds.length > 0,
  `${label}: complete validation evidence is missing`);
  const all = result.atFrozen.all, browser = result.baseline.browser.scores.all;
  const expected = {
    G1: { metric: 'newFalseHides', actual: all.newFalseHides, max: 1, pass: all.newFalseHides <= 1 },
    G2: { metric: 'exactVectors', actual: all.exactVectors, min: browser.exactVectors, pass: all.exactVectors >= browser.exactVectors },
    G3: { metric: 'correctHideDecisions', actual: all.hide.tp + all.hide.tn,
      min: browser.hide.tp + browser.hide.tn - 1, pass: all.hide.tp + all.hide.tn >= browser.hide.tp + browser.hide.tn - 1 },
  };
  assert(integer(all.newFalseHides) && same(result.gates, expected)
    && result.pass === Object.values(expected).every(gate => gate.pass), `${label}: stored gates or pass flag disagree`);
  if (result.dataset === 'isolation') {
    assert(result.baseline.textOnlyQat === null && result.pairedVsTextOnlyQat === null,
      `${label}: isolation cannot carry a migration QAT comparison`);
  } else {
    const qat = result.baseline.textOnlyQat;
    checkScores(qat?.scores, label);
    checkScores(result.pairedVsTextOnlyQat, label);
    assert(qat.contextTokens === 1024 && qat.runtime === 'Ollama 0.40.3'
      && same(qat.artifact, baselineDocument.sources?.currentTextOnlyQatContract)
      && Array.isArray(qat.sourceIds) && qat.sourceIds.length > 0,
    `${label}: text-only QAT context or artifact differs`);
  }
}

function scoreCells(scores) {
  const all = scores.all;
  return [`${all.exactVectors}/${all.totalVectors}`, `${all.hide.tp + all.hide.tn}/${all.hide.n}`,
    `${all.falseHides} / ${all.missedHides}`, `${text(all.newFalseHides)} / ${text(all.newMissedHides)}`, number(scores.rage.hide.f1)];
}

/** Render stored phase-2 evidence only. No inference, corpus parsing or metric fitting. */
export async function renderValidation({ dataDirectory }) {
  const names = await readdir(dataDirectory);
  const evidenceNames = names.filter(name => /^decision-validation-.*\.json$/.test(name));
  const preregistration = await read(dataDirectory, REGISTRATION, true);
  if (!preregistration) {
    assert(evidenceNames.length === 0, 'Validation evidence requires decision-preregistration.json');
    return { markdown: '', hasResults: false, hasPreregistration: false, complete: 0, candidates: [] };
  }
  const registered = registrationCandidates(preregistration.value);
  const allowed = new Set(registered.flatMap(candidate => [
    `decision-validation-attempt-${candidate.variantId}.json`,
    ...Object.keys(DATASETS).map(dataset => `decision-validation-${candidate.variantId}-${dataset}.json`),
  ]));
  assert(evidenceNames.every(name => allowed.has(name)), 'Unexpected validation variant or corpus result file');
  const baseline = await read(dataDirectory, 'decision-baselines.json');
  const candidates = [];
  for (const candidate of registered) {
    const variant = VARIANTS.find(item => item.id === candidate.variantId);
    const attemptName = `decision-validation-attempt-${variant.id}.json`;
    const attempt = await read(dataDirectory, attemptName, true);
    const results = [];
    for (const dataset of Object.keys(DATASETS)) {
      const name = `decision-validation-${variant.id}-${dataset}.json`;
      results.push({ dataset, name, file: await read(dataDirectory, name, true) });
    }
    const hasEvidence = attempt || results.some(item => item.file);
    if (hasEvidence) {
      assert(attempt, `${variant.id}: validation result has no single-run attempt receipt`);
      const selectionFile = await read(dataDirectory, candidate.selectionFile);
      const selection = selectionFile.value;
      const identity = (await read(dataDirectory, `decision-1b-identity-${variant.id}.json`)).value;
      assert(selectionFile.sha256 === candidate.selectionSha256 && selection.schemaVersion === 2
        && selection.phase === 'discovery' && selection.frozen === true && selection.variantId === variant.id
        && selection.templateHash === templateHash(selection.templateId)
        && Number.isFinite(selection.cutoff) && selection.cutoff >= 0 && selection.cutoff <= 1
        && same(selection.corpusHashes, CORPUS_HASHES)
        && identity.schemaVersion === 2 && same(identity.variant, variant) && record(identity.identity),
      `${variant.id}: current frozen selection or artifact identity differs`);
      const binding = { candidate, variant, selection, identity, preregistration };
      checkBinding(attempt.value, binding, attemptName);
      assert(attempt.value.phase === 'validation-attempt', `${attemptName}: attempt phase differs`);
      for (const { dataset, name, file } of results) {
        if (!file) continue;
        const result = file.value;
        checkBinding(result, binding, name);
        assert(result.phase === 'validation' && result.runId === attempt.value.runId && result.dataset === dataset
          && result.sourceCorpus === DATASETS[dataset] && result.corpusSha256 === CORPUS_HASHES[DATASETS[dataset]]
          && result.baselineSha256 === baseline.sha256, `${name}: corpus, baseline or run binding differs`);
        if (result.status === 'complete') checkComplete(result, baseline.value, name);
        else assert(result.pass !== true && result.gates === undefined,
          `${name}: unfinished validation cannot claim gates or pass`);
      }
    }
    const complete = attempt?.value.status === 'complete' && results.every(item => item.file?.value.status === 'complete');
    const status = complete ? results.every(item => item.file.value.pass) ? 'PASS' : 'FAIL'
      : attempt?.value.status === 'failed' || results.some(item => item.file?.value.status === 'failed') ? 'FAILED / INCOMPLETE'
        : hasEvidence ? 'INCOMPLETE' : 'NOT RUN';
    candidates.push({ variantId: variant.id, attempt: attempt?.value ?? null, results, complete, status });
  }
  const hasResults = evidenceNames.length > 0;
  const complete = candidates.filter(candidate => candidate.complete).length;
  const statusRows = candidates.map(candidate => [candidate.variantId, candidate.status,
    ...candidate.results.map(item => item.file?.value.status === 'complete' ? item.file.value.pass ? 'PASS (complete)' : 'FAIL (complete)'
      : item.file?.value.status ?? (candidate.attempt ? 'missing result' : 'not run')),
    candidate.attempt?.status ?? 'not run']);
  const attemptRows = candidates.filter(candidate => candidate.attempt).map(candidate => [candidate.variantId,
    `[attempt](data/decision-validation-attempt-${candidate.variantId}.json)`, candidate.attempt.runId,
    candidate.attempt.status, candidate.attempt.startedAt, candidate.attempt.finishedAt,
    candidate.attempt.error?.message ?? candidate.attempt.error]);
  const gateRows = [], metricRows = [], qatRows = [], provenanceRows = [];
  for (const candidate of candidates) {
    for (const { dataset, name, file } of candidate.results) {
      const result = file?.value;
      if (result?.status !== 'complete') {
        for (const gate of ['G1', 'G2', 'G3']) gateRows.push([candidate.variantId, dataset, gate, '—', '—', 'NOT EVALUATED']);
        continue;
      }
      for (const [key, gate] of Object.entries(result.gates)) gateRows.push([candidate.variantId, dataset,
        `${key}: ${gate.metric}`, gate.actual, gate.max === undefined ? `≥ ${gate.min}` : `≤ ${gate.max}`, gate.pass ? 'PASS' : 'FAIL']);
      metricRows.push([candidate.variantId, dataset, `Frozen ≥ ${result.selection.cutoff}`, ...scoreCells(result.atFrozen)],
        [candidate.variantId, dataset, 'Fixed ≥ 0.5 (not gated)', ...scoreCells(result.at05)],
        ['Browser Gemma 4 E2B', dataset, 'Historical baseline', ...scoreCells(result.baseline.browser.scores)]);
      if (result.baseline.textOnlyQat) {
        metricRows.push(['Text-only QAT Gemma 4 E2B', dataset, 'Historical baseline (not gated)', ...scoreCells(result.baseline.textOnlyQat.scores)]);
        const qat = result.baseline.textOnlyQat;
        qatRows.push([candidate.variantId, `${qat.runtime}; context ${qat.contextTokens} tokens`,
          result.pairedVsTextOnlyQat.all.newFalseHides, result.pairedVsTextOnlyQat.all.newMissedHides,
          qat.sourceIds.join(', ')]);
      }
      provenanceRows.push([candidate.variantId, dataset, `[receipt](data/${name})`, result.runId,
        result.selection.templateId, result.selection.cutoff, result.selection.sha256, result.identityHash,
        result.corpusSha256, result.baselineSha256]);
    }
  }
  const lines = ['## Phase 2: preregistered validation', '',
    `**${complete}/${candidates.length} candidates have complete results on both corpora.** Each candidate passes only when G1, G2 and G3 pass on both corpora at its frozen template, cutoff and runtime settings. Failed or incomplete attempts cannot pass and are not retried.`, '',
    'Both validation corpora were previously used to qualify Gemma; neither is globally untouched. These are independent of decision-model discovery selection, and do not establish extension or production qualification.', '',
    `Preregistration: [recorded plan](data/${REGISTRATION}), SHA-256 \`${preregistration.sha256}\`. ${hasResults ? 'Results below are recorded evidence.' : 'Validation is pending; no run is recorded.'} This renderer checks recorded bindings and gate consistency and performs no inference, scoring, selection or retuning.`, '',
    table(['Candidate', 'Overall', 'Isolation', 'Migration', 'Attempt status'], statusRows), '',
    ...(attemptRows.length ? [table(['Candidate', 'Attempt receipt', 'Run ID', 'Status', 'Started', 'Finished', 'Recorded error'], attemptRows), ''] : []),
    table(['Candidate', 'Corpus', 'Gate', 'Actual', 'Required', 'Result'], gateRows), '',
    'G1 counts new false hides against Browser-correct SHOW decisions. G2 compares exact ordered filter vectors. G3 compares correct hide/show decisions with Browser minus one. New missed hides, fixed-0.5 results, rage-bait F1 and the migration text-only QAT comparison are reported without gates.', '',
    ...(metricRows.length ? [table(['Model / candidate', 'Corpus', 'Operating point', 'Exact vectors', 'Correct hide/show', 'FH / MH', 'New FH / new MH vs Browser', 'Rage hide F1'], metricRows), '',
      'FH/MH mean false hides/missed hides. Scores are rendered as stored; unavailable paired counts and undefined ratios are —. Browser and current text-only QAT are separate Gemma artifacts and prompts.', ''] : []),
    ...(qatRows.length ? [table(['Candidate', 'Migration text-only QAT baseline', 'New FH vs QAT', 'New MH vs QAT', 'QAT source IDs'], qatRows), '',
      'The migration QAT baseline uses the separately qualified text-only import, Ollama 0.40.3 and a 1024-token context. Its artifact contract is bound in each receipt; it is not the original combined-package QAT discovery/timing reference.', ''] : []),
    ...(provenanceRows.length ? [table(['Candidate', 'Corpus', 'Result', 'Run ID', 'Template', 'Frozen cutoff', 'Selection SHA-256', 'Artifact identity hash', 'Corpus SHA-256', 'Baseline-file SHA-256'], provenanceRows), ''] : []),
  ];
  return { markdown: lines.join('\n'), hasResults, hasPreregistration: true, complete, candidates };
}
