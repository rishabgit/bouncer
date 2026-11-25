import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { publicValue } from './runtime.mjs';
import { evaluateGates } from './tone-label-metrics.mjs';
import { expandToneEvidence } from './tone-label-evidence.mjs';

export const TONE_MARKERS = Object.freeze(['<!-- tone-label-study:start -->', '<!-- tone-label-study:end -->']);
const NAMES = { discovery: 'decision-tone-discovery-summary.json', holdout: 'decision-tone-holdout-summary.json' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const insist = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
const number = value => Number.isFinite(value) ? value.toFixed(4) : '—';
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(text).join(' | ')} |`)].join('\n');
const cutoff = policy => policy?.shortRule
  ? `${policy.cutoff}; ≤${policy.shortRule.maxOwnWords} words: ${policy.shortRule.cutoff}` : policy?.cutoff;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function discoveryDetails(summary) {
  const lines = [], diagnostics = summary.diagnostics ?? {}, grid = summary.shortRuleGrid?.bestByMaxOwnWords;
  if (grid?.length) lines.push('Short-rule grid: saved best cutoffs for posts with at most N own words.', '',
    table(['N', 'Short cutoff', 'Errors', 'FP', 'FN'], grid.map(row =>
      [row.maxOwnWords, number(row.cutoff), row.errors, row.FP ?? row.falseHides, row.FN ?? row.missedHides])), '');
  const subtypes = diagnostics.subtypeDistributions?.find(row => row.wording === 'W0')?.subtypes;
  if (subtypes?.length) lines.push(`W0 subtype probabilities; shares use the recorded cutoff of ${summary.cutoff}.`, '',
    table(['Subtype', 'n', 'Median', 'Share ≥ cutoff'], subtypes.map(row =>
      [row.subtype, row.n, number(row.median), number(row.shareAtOrAboveCutoff)])), '');
  const twins = diagnostics.twins?.filter(row => ['W0', 'W5'].includes(row.wording));
  if (twins?.length) lines.push('Source-to-twin probability drops.', '',
    table(['Wording', 'Pairs', 'Median source − twin'], twins.map(row =>
      [row.wording, row.n, number(row.medianSourceMinusTwin)])), '');
  if (diagnostics.handleSensitivity?.length) {
    const rows = ['W0', 'W5'].flatMap(id => {
      const values = diagnostics.handleSensitivity.flatMap(row => row.wordings?.filter(wording => wording.id === id) ?? []);
      if (!values.length) return [];
      const ranges = values.map(row => row.max - row.min);
      return [[id, values.length, `${number(Math.min(...values.map(row => row.min)))}–${number(Math.max(...values.map(row => row.max)))}`,
        number(median(ranges)), number(Math.max(...ranges)), values.filter(row => row.crossesCutoff).length]];
    });
    if (rows.length) lines.push('Handle-noise probabilities across the saved variants.', '',
      table(['Wording', 'Texts', 'Probability min–max', 'Median text range', 'Max text range', 'Texts crossing cutoff'], rows), '');
  }
  if (diagnostics.templateSensitivity?.length) lines.push('Template sensitivity.', '',
    table(['Template', 'n', 'AUC n', 'Spearman vs T0', 'AUC'], diagnostics.templateSensitivity.map(row =>
      [row.template, row.n, row.aucN, number(row.spearmanVsT0), number(row.auc)])), '');
  if (diagnostics.contentFreePriors?.length) {
    const states = ['.', '…', '-', 'N/A', '?'];
    lines.push('Content-free prior probabilities by intent and wording ID.', '',
      table(['Template', 'Label IDs', ...states], diagnostics.contentFreePriors.map(row =>
        [row.template, (row.labelKeys ?? [...(row.intentIds ?? []), ...(row.wordingIds ?? [])]).join(', '),
          ...states.map(state => number(row.probabilities[row.states.indexOf(state)]))])), '');
  }
  return lines;
}

function checkMetric(row) {
  insist(['n', 'positives', 'negatives', 'FP', 'FN', 'errors', 'correct', 'lowContentFP', 'shortPositiveFN']
    .every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
    && row.n === row.positives + row.negatives && row.errors === row.FP + row.FN && row.n === row.errors + row.correct
    && row.FP === row.falseHides && row.FN === row.missedHides
    && row.FP <= row.negatives && row.FN <= row.positives
    && row.lowContentFP <= row.FP && row.shortPositiveFN <= row.FN
    && (row.auc === null || Number.isFinite(row.auc) && row.auc >= 0 && row.auc <= 1), 'Tone report metric algebra differs');
}
function checkSummary(summary, raw, name) {
  insist(raw.status === 'complete' && raw.phase === summary.phase && raw.requestsIssued === raw.requests?.length
    && summary.counts?.requests === raw.requestsIssued, 'Tone report raw completion differs');
  insist(Array.isArray(summary.wordings) && Array.isArray(summary.policies), 'Missing tone metrics');
  for (const row of [...summary.wordings, ...summary.policies]) checkMetric(row);
  if (name === 'holdout') {
    insist(summary.registrationSha256 === raw.registrationSha256 && raw.registrationSha256 === hash(JSON.stringify(raw.registration))
      && same(summary.model, raw.registration.model) && same(summary.corpusHashes, raw.registration.corpusHashes), 'Tone report registration binding differs');
    insist(same(summary.policies.map(row => row.id), raw.plan.policies.map(row => row.id))
      && same(summary.wordings.map(row => row.id), raw.plan.wordingIds), 'Tone report populations differ');
    for (const [index, row] of summary.policies.entries())
      insist(same(row.policy, raw.plan.policies[index].policy) && row.optimizedOnDiscovery === false && row.optimal === undefined,
        'Tone report holdout policy differs from registration');
    const gates = evaluateGates(raw.spec.gates, Object.fromEntries([...summary.wordings, ...summary.policies].map(row => [row.id, row])));
    insist(same(gates, summary.gates), 'Tone report gate algebra differs');
  } else insist(same(summary.model, raw.model) && same(summary.corpusHashes, raw.corpusHashes), 'Tone discovery report binding differs');
}

/** Uses saved summaries only: no inference, scoring, threshold fitting or advice. */
export function renderToneSection({ discovery, holdout } = {}) {
  const lines = ['## Tone label study', ''];
  if (!discovery && !holdout) return [...lines, 'No tone label study results have been recorded.', ''].join('\n');
  lines.push('Single-filter decisions; ambiguous pairs excluded. Discovery cutoffs are exploratory. Holdout uses the registered cutoffs and gates.', '');
  for (const [name, summary] of [['Discovery', discovery], ['Holdout', holdout]]) {
    if (!summary) continue;
    insist(summary.status === 'complete' && Array.isArray(summary.wordings) && Array.isArray(summary.policies), 'Invalid tone summary');
    lines.push(`**${name}**`, '', table(['Wording', 'Label', 'n', 'Errors', 'FP / FN', 'AUC', ...(name === 'Discovery' ? ['Best cutoff / errors'] : [])], summary.wordings.map(row =>
      [row.id, row.label, row.n, row.errors, `${row.FP ?? row.falseHides} / ${row.FN ?? row.missedHides}`, number(row.auc),
        ...(name === 'Discovery' ? [row.optimal ? `${number(row.optimal.cutoff)} / ${row.optimal.errors}` : '—'] : [])])), '',
    table(['Policy', 'Template', 'State transform', 'Calibration', 'n', 'Cutoff', 'Errors', 'FP / FN', 'Low-content FP', 'Short-positive FN'], summary.policies.map(row =>
      [row.id, row.policy?.template, row.policy?.stateTransform, row.policy?.calibration, row.n, cutoff(row.policy) ?? row.cutoff, row.errors, `${row.FP ?? row.falseHides} / ${row.FN ?? row.missedHides}`,
        row.lowContentFP, row.shortPositiveFN])), '', `[${name} summary](data/${name === 'Discovery' ? NAMES.discovery : NAMES.holdout}).`, '');
    if (name === 'Discovery') lines.push(...discoveryDetails(summary));
    if (name === 'Holdout') {
      insist(summary.gates && Array.isArray(summary.gates.checks), 'Missing registered tone gate verdicts');
      lines.push(table(['Gate', 'Scope', 'Actual', 'Comparator', 'factor × ref + slack', 'Verdict'], summary.gates.checks.map(gate =>
        [gate.name, gate.scope, gate.actual, gate.comparator, `${gate.factor} × ${gate.referenceValue} + ${gate.slack} = ${gate.limit}`,
          gate.pass ? 'PASS' : 'FAIL'])), '');
    }
  }
  return lines.join('\n');
}

export function replaceToneSection(markdown, section) {
  const [start, end] = TONE_MARKERS, starts = markdown.split(start).length - 1, ends = markdown.split(end).length - 1;
  insist(starts === ends && starts <= 1, 'Tone report markers are missing or duplicated');
  const block = `${start}\n${section.trim()}\n${end}`;
  if (!starts) return `${markdown.trimEnd()}\n\n${block}\n`;
  const first = markdown.indexOf(start), last = markdown.indexOf(end);
  insist(last > first, 'Tone report markers are reversed');
  return markdown.slice(0, first) + block + markdown.slice(last + end.length);
}

export async function reportTone({ root = new URL('../../', import.meta.url) } = {}) {
  const out = new URL('docs/benchmarks/data/', root), summaries = {};
  for (const [name, file] of Object.entries(NAMES)) {
    let summary;
    try { summary = JSON.parse(await readFile(new URL(file, out))); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    insist(summary.schemaVersion === 1 && summary.phase === `tone-label-${name}` && summary.immutableEvidenceUnchanged === true,
      'Tone report summary provenance differs');
    const rawName = name === 'discovery' ? 'decision-tone-discovery-raw.json' : 'decision-tone-holdout-result.json';
    const rawBytes = await readFile(new URL(rawName, out));
    insist(summary.rawFile === rawName && summary.rawSha256 === hash(rawBytes), 'Tone report raw SHA-256 differs');
    const raw = expandToneEvidence(JSON.parse(rawBytes)); checkSummary(summary, raw, name);
    for (const [receipt, digest] of Object.entries(raw.protectedHashes ?? {})) {
      insist(/^decision-[^/]+\.json$/.test(receipt) && !receipt.includes('..')
        && hash(await readFile(new URL(receipt, out))) === digest, 'Tone report protected receipt differs');
    }
    summaries[name] = summary;
  }
  const document = new URL('docs/benchmarks/decision-models.md', root);
  const markdown = replaceToneSection(await readFile(document, 'utf8'), renderToneSection(summaries));
  insist(publicValue(markdown) === markdown, 'Tone report would require redaction outside the bounded section');
  await writeFile(document, publicValue(markdown)); return markdown;
}
