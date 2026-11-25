import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESULT = 'decision-guidance-fresh-result.json';
const SUMMARY = 'decision-guidance-fresh-summary.json';
const CORPUS = 'scripts/decision-eval/corpora/guidance-fresh-2026-11-25.json';
const CORPUS_HASH = 'fe82fe7dcdf8cd96fb828d20624b4ba160dede297c36ddcfa4e57c09f6373cb3';
const VARIANT = 'llama-d1-2b-q8';
const MODEL = 'LiquidAI/d1-2B-GGUF:Q8_0';
const CUTOFF = 0.290813258948728;
const TEMPLATE_HASH = '9a1e023c41c8c19c37317953ae8d7b486ec088070ce00abadd4809242eb67f54';
const STYLES = ['short', 'guided', 'guidedExclusion'];
const MODES = ['single', 'six-filter'];
// Independent copy of the saved preregistration contract; never import the runner.
const RULE = {
  version: 1,
  primaryMode: 'single',
  population: 'All post/filter pairs, excluding pairs named in post.ambiguousFor',
  nearMissPopulation: 'Negative-gold eligible pairs on posts tagged near-miss, including cross-filter pairs',
  ownNearMissDiagnostic: 'Negative-gold eligible near-miss pairs whose filter equals post.authoredFor',
  subtlePositivePopulation: 'Positive-gold eligible pairs on posts tagged subtle-positive',
  bouncedPopulation: 'Each own-intent positive post, using its own single-filter label',
  guidance: { errors: 'guided.errors < short.errors', nearMissFalseHides: 'guided.nearMissFalseHides <= short.nearMissFalseHides' },
  exclusion: { nearMissFalseHides: 'guidedExclusion.nearMissFalseHides <= guided.nearMissFalseHides', missedHides: 'guidedExclusion.missedHides <= guided.missedHides + 1' },
  nearMissComparison: 'Aggregate false-hide counts; newly introduced and repaired false hides are reported separately, not gated',
  diagnostics: 'AUC, best cutoffs, six-filter interference, request cost and bounced-post checks are not gated',
  noRetuning: true,
  noRelabelling: true,
  noReruns: true,
};
const hash = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(`Fresh Bounce guidance: ${message}`); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const number = (value, places = 4) => Number.isFinite(value) ? value.toFixed(places) : '—';
const text = value => value == null ? '—' : String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(text).join(' | ')} |`)].join('\n');

async function read(directory, name, optional = false) {
  try {
    const bytes = await readFile(resolve(directory, name));
    return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`${name}: ${error.message}`, { cause: error });
  }
}

function uniqueRows(rows, keys, label, expected) {
  assert(Array.isArray(rows) && (expected === undefined || rows.length === expected)
    && new Set(rows.map(row => JSON.stringify(keys.map(key => row?.[key])))).size === rows.length,
  `${label} have missing or duplicate population keys`);
}

function intervalValid(value) {
  return record(value) && probability(value.lower) && probability(value.upper) && value.lower <= value.upper
    && Number.isFinite(value.width) && value.width >= 0
    && typeof value.lowerInclusive === 'boolean' && typeof value.upperInclusive === 'boolean';
}

const intervalText = value => `${value.lowerInclusive ? '[' : '('}${value.lower}, ${value.upper}${value.upperInclusive ? ']' : ')'}`;

async function checkRegistration(result, dataDirectory) {
  assert(result.schemaVersion === 1 && result.phase === 'fresh-guidance'
    && ['registered', 'running', 'complete', 'failed'].includes(result.status)
    && typeof result.registeredAt === 'string' && Number.isFinite(Date.parse(result.registeredAt)), 'result header differs');
  const registration = result.registration;
  assert(record(registration) && result.registrationSha256 === hash(JSON.stringify(registration))
    && same(registration.corpus, { file: CORPUS, sha256: CORPUS_HASH }), 'registration or corpus binding differs');
  const [corpus, selection, identity] = await Promise.all([
    read(ROOT, CORPUS), read(dataDirectory, `decision-1b-selection-${VARIANT}.json`),
    read(dataDirectory, `decision-1b-identity-${VARIANT}.json`),
  ]);
  assert(corpus.sha256 === CORPUS_HASH && same(result.corpusSnapshot, corpus.value), 'frozen corpus bytes or snapshot differ');
  assert(registration.model?.variantId === VARIANT && registration.model.model === MODEL
    && registration.model.selectionSha256 === selection.sha256
    && digest(registration.model.identityHash) && identity.value.schemaVersion === 2
    && identity.value.variant?.id === VARIANT && identity.value.variant.model === MODEL && record(identity.value.identity)
    && registration.model.identityHash === hash(JSON.stringify(identity.value.identity))
    && selection.value.schemaVersion === 2 && selection.value.phase === 'discovery' && selection.value.frozen === true
    && selection.value.variantId === VARIANT && selection.value.identityHash === registration.model.identityHash
    && registration.cutoff === CUTOFF && selection.value.cutoff === CUTOFF
    && registration.templateId === 'matches-category' && selection.value.templateId === registration.templateId
    && registration.templateHash === TEMPLATE_HASH && selection.value.templateHash === TEMPLATE_HASH,
  'model, identity, selection, template or cutoff binding differs');
  assert(record(registration.runtimeSettings) && same(registration.runtimeSettings, selection.value.runtimeSettings)
    && (result.runtimeSettings === undefined || same(result.runtimeSettings, registration.runtimeSettings))
    && registration.runtimeSettings.effectiveContext === 4096 && registration.runtimeSettings.parallel === 1,
  'frozen runtime settings differ');
  assert(same(registration.schedule, { seed: '0x6b0b2026', singleRequests: 1512, multiRequests: 252, totalRequests: 1764 })
    && same(registration.rule, RULE), 'preregistered schedule or gates differ');
  assert(Array.isArray(corpus.value.intents) && corpus.value.intents.length === 6
    && Array.isArray(corpus.value.posts) && corpus.value.posts.length === 84, 'fixed corpus population differs');
  assert(count(result.requestsIssued) && result.requestsIssued <= 1764 && Array.isArray(result.requests)
    && result.requests.length <= result.requestsIssued, 'request progress is invalid');
  if (result.status === 'registered') assert(result.requestsIssued === 0 && result.requests.length === 0
    && result.startedAt === undefined, 'registered result already contains inference progress');
  else assert(typeof result.startedAt === 'string' && Number.isFinite(Date.parse(result.startedAt))
    && Date.parse(result.startedAt) >= Date.parse(result.registeredAt), 'inference started before its registration');
  if (result.status === 'complete') assert(result.requestsIssued === 1764 && result.requests.length === 1764
    && result.activeRequest == null && record(result.environment) && same(result.runtimeSettings, registration.runtimeSettings)
    && typeof result.finishedAt === 'string' && Number.isFinite(Date.parse(result.finishedAt))
    && Date.parse(result.finishedAt) >= Date.parse(result.startedAt), 'complete result has unfinished requests or runtime provenance');
  assert(record(result.protectedHashes) && Object.keys(result.protectedHashes).length > 0,
    'protected evidence hashes are missing');
  for (const [name, expected] of Object.entries(result.protectedHashes)) {
    assert(/^docs\/benchmarks\/data\/decision-[^/]+\.json$/.test(name)
      && !name.startsWith('docs/benchmarks/data/decision-guidance-fresh-') && digest(expected), 'protected evidence path or hash differs');
    const bytes = await readFile(resolve(dataDirectory, basename(name)));
    assert(hash(bytes) === expected, `protected evidence changed: ${name}`);
  }
  return corpus.value;
}

function metricValid(row, intents) {
  if (!record(row) || !MODES.includes(row.mode) || !STYLES.includes(row.style) || !intents.includes(row.intentId)
    || !['n', 'positives', 'negatives', 'falseHides', 'missedHides', 'errors', 'correct', 'ambiguousExcluded',
      'nearMissFalseHides', 'nearMissDecisions', 'ownNearMissFalseHides', 'ownNearMissDecisions',
      'missedSubtlePositives', 'subtlePositiveDecisions'].every(key => count(row[key]))) return false;
  const c = row.confusion, o = row.optimal;
  return row.positives + row.negatives === row.n && row.falseHides + row.missedHides === row.errors
    && row.correct + row.errors === row.n && row.falseHides <= row.negatives && row.missedHides <= row.positives
    && (row.auc === null || probability(row.auc)) && record(c) && ['tp', 'tn', 'fp', 'fn'].every(key => count(c[key]))
    && c.fp === row.falseHides && c.fn === row.missedHides && c.tp + c.fn === row.positives
    && c.tn + c.fp === row.negatives && row.nearMissFalseHides <= row.nearMissDecisions
    && row.nearMissFalseHides <= row.falseHides && row.ownNearMissFalseHides <= row.ownNearMissDecisions
    && row.ownNearMissFalseHides <= row.nearMissFalseHides && row.ownNearMissDecisions <= row.nearMissDecisions
    && row.missedSubtlePositives <= row.subtlePositiveDecisions && row.missedSubtlePositives <= row.missedHides
    && record(o) && probability(o.cutoff) && intervalValid(o.interval)
    && Array.isArray(o.intervals) && o.intervals.length > 0 && o.intervals.every(intervalValid)
    && ['errors', 'falseHides', 'missedHides'].every(key => count(o[key]))
    && o.errors === o.falseHides + o.missedHides && o.errors <= row.errors;
}

function checkGate(gate, expected, label) {
  assert(record(gate) && record(gate.checks) && Object.keys(gate.checks).length === Object.keys(expected).length,
    `${label} gate checks differ`);
  for (const [key, values] of Object.entries(expected)) {
    const [actual, reference, comparison] = values;
    const pass = comparison === '<' ? actual < reference : actual <= reference;
    assert(same(gate.checks[key], { actual, reference, comparison, pass }), `${label} ${key} gate algebra differs`);
  }
  assert(gate.supported === Object.values(gate.checks).every(check => check.pass), `${label} support differs from its checks`);
}

// Check saved aggregate algebra and provenance; never score raw probabilities or fit a threshold.
function checkSummary(summary, resultFile, corpus) {
  const result = resultFile.value;
  assert(summary.schemaVersion === 1 && summary.phase === 'fresh-guidance' && summary.status === 'complete'
    && result.status === 'complete' && summary.resultFile === RESULT && summary.resultSha256 === resultFile.sha256
    && summary.registrationSha256 === result.registrationSha256 && summary.cutoff === CUTOFF
    && summary.immutableEvidenceUnchanged === true, 'complete summary binding differs');
  assert(same(summary.counts, { posts: 84, intents: 6, decisionsPerStyle: 504, ambiguousPerStyle: 22,
    headlinePerStyle: 482, requests: 1764 }) && same(summary.intents, corpus.intents), 'summary counts or intent labels differ');
  const intents = ['all', ...corpus.intents.map(intent => intent.id)];
  uniqueRows(summary.metrics, ['mode', 'style', 'intentId'], 'metrics', 42);
  assert(summary.metrics.every(row => metricValid(row, intents)), 'stored metrics are invalid');
  for (const row of summary.metrics) {
    const pairs = corpus.posts.flatMap(post => corpus.intents.filter(intent => row.intentId === 'all' || row.intentId === intent.id)
      .map(intent => ({ post, intentId: intent.id })));
    const eligible = pairs.filter(({ post, intentId }) => !post.ambiguousFor.includes(intentId));
    const near = eligible.filter(({ post, intentId }) => post.kind === 'near-miss' && !post.gold[intentId]);
    assert(row.n === eligible.length && row.ambiguousExcluded === pairs.length - eligible.length
      && row.positives === eligible.filter(({ post, intentId }) => post.gold[intentId]).length
      && row.nearMissDecisions === near.length
      && row.ownNearMissDecisions === near.filter(({ post, intentId }) => post.authoredFor === intentId).length
      && row.subtlePositiveDecisions === eligible.filter(({ post, intentId }) => post.kind === 'subtle-positive' && post.gold[intentId]).length,
    'stored metric denominators differ from frozen corpus');
  }
  for (const mode of MODES) for (const style of STYLES) {
    const rows = summary.metrics.filter(row => row.mode === mode && row.style === style);
    const pooled = rows.find(row => row.intentId === 'all');
    assert(pooled && pooled.n === 482 && pooled.ambiguousExcluded === 22 && pooled.ownNearMissDecisions === 24
      && rows.length === 7 && intents.every(id => rows.some(row => row.intentId === id)), 'metric populations differ');
    for (const field of ['n', 'positives', 'negatives', 'falseHides', 'missedHides', 'errors', 'correct', 'ambiguousExcluded',
      'nearMissFalseHides', 'nearMissDecisions', 'ownNearMissFalseHides', 'ownNearMissDecisions',
      'missedSubtlePositives', 'subtlePositiveDecisions']) {
      assert(pooled[field] === rows.filter(row => row.intentId !== 'all').reduce((sum, row) => sum + row[field], 0),
        `pooled ${field} differs from per-filter metrics`);
    }
  }
  const single = style => summary.metrics.find(row => row.mode === 'single' && row.style === style && row.intentId === 'all');
  const short = single('short'), guided = single('guided'), exclusion = single('guidedExclusion');
  assert(record(summary.gates) && same(Object.keys(summary.gates).sort(), ['exclusion', 'guidance']), 'gate population differs');
  checkGate(summary.gates?.guidance, { errors: [guided.errors, short.errors, '<'],
    nearMissFalseHides: [guided.nearMissFalseHides, short.nearMissFalseHides, '<='] }, 'guidance');
  checkGate(summary.gates?.exclusion, { nearMissFalseHides: [exclusion.nearMissFalseHides, guided.nearMissFalseHides, '<='],
    missedHides: [exclusion.missedHides, guided.missedHides + 1, '<='] }, 'exclusion');
  uniqueRows(summary.requestStats, ['mode', 'style', 'intentId'], 'request statistics', 24);
  assert(summary.requestStats.every(row => record(row) && MODES.includes(row.mode) && STYLES.includes(row.style)
    && intents.includes(row.intentId) && count(row.n) && row.n > 0
    && ['medianMs', 'medianInputTokens', 'meanInputTokens', 'minInputTokens', 'maxInputTokens'].every(key => Number.isFinite(row[key]) && row[key] >= 0)
    && row.minInputTokens <= row.medianInputTokens && row.medianInputTokens <= row.maxInputTokens
    && row.minInputTokens <= row.meanInputTokens && row.meanInputTokens <= row.maxInputTokens), 'stored request statistics are invalid');
  for (const style of STYLES) {
    for (const intentId of intents) assert(summary.requestStats.some(row => row.mode === 'single' && row.style === style
      && row.intentId === intentId && row.n === (intentId === 'all' ? 504 : 84)), 'single-filter request statistics are missing');
    assert(summary.requestStats.some(row => row.mode === 'six-filter' && row.style === style && row.intentId === 'all' && row.n === 84),
      'six-filter request statistics are missing');
  }
  uniqueRows(summary.interference, ['style', 'intentId', 'population'], 'interference statistics', 42);
  assert(summary.interference.every(row => STYLES.includes(row.style) && intents.includes(row.intentId)
    && ['headline', 'allIncludingAmbiguous'].includes(row.population) && count(row.n)
    && probability(row.medianAbsDelta) && probability(row.worstAbsDelta) && row.medianAbsDelta <= row.worstAbsDelta
    && count(row.flips) && row.flips <= row.n), 'stored interference statistics are invalid');
  for (const row of summary.interference) {
    const metric = summary.metrics.find(item => item.mode === 'single' && item.style === row.style && item.intentId === row.intentId);
    assert(row.n === (row.population === 'headline' ? metric.n : metric.n + metric.ambiguousExcluded),
      'interference population count differs');
  }
  assert(Array.isArray(summary.interferenceFlips) && summary.interferenceFlips.every(row => STYLES.includes(row.style)
    && intents.includes(row.intentId) && row.intentId !== 'all' && typeof row.postId === 'string' && typeof row.text === 'string'
    && typeof row.gold === 'boolean' && typeof row.ambiguous === 'boolean' && probability(row.singleProbability)
    && probability(row.multiProbability) && typeof row.singleCorrect === 'boolean' && typeof row.multiCorrect === 'boolean'),
  'stored interference flip details are invalid');
  uniqueRows(summary.interferenceFlips, ['style', 'postId', 'intentId'], 'interference flip details');
  for (const row of summary.interferenceFlips) {
    const post = corpus.posts.find(post => post.id === row.postId);
    assert(post && row.text === post.text && row.gold === post.gold[row.intentId]
      && row.ambiguous === post.ambiguousFor.includes(row.intentId), 'interference flip corpus binding differs');
  }
  for (const row of summary.interference) assert(row.flips === summary.interferenceFlips.filter(flip => flip.style === row.style
    && (row.intentId === 'all' || flip.intentId === row.intentId) && (row.population !== 'headline' || !flip.ambiguous)).length,
  'interference flip counts differ from saved details');
  uniqueRows(summary.bounced, ['style', 'intentId'], 'bounced-post checks', 21);
  assert(summary.bounced.every(row => STYLES.includes(row.style) && intents.includes(row.intentId)
    && ['n', 'caught', 'missed', 'subtleMissed'].every(key => count(row[key])) && row.caught + row.missed === row.n
    && row.subtleMissed <= row.missed && Array.isArray(row.failures) && row.failures.length === row.missed
    && row.failures.every(failure => typeof failure.postId === 'string' && typeof failure.text === 'string'
      && ['clear-positive', 'subtle-positive'].includes(failure.kind) && probability(failure.probability)
      && failure.cutoff === CUTOFF && typeof failure.label === 'string')), 'stored bounced-post checks are invalid');
  for (const row of summary.bounced) {
    const posts = corpus.posts.filter(post => (row.intentId === 'all' || post.authoredFor === row.intentId) && post.gold[post.authoredFor]);
    const metric = summary.metrics.find(metric => metric.mode === 'single' && metric.style === row.style && metric.intentId === row.intentId);
    assert(row.n === posts.length && row.n === metric.positives && row.missed === metric.missedHides
      && row.subtleMissed === metric.missedSubtlePositives
      && new Set(row.failures.map(failure => failure.postId)).size === row.failures.length
      && row.failures.every(failure => {
        const post = posts.find(post => post.id === failure.postId);
        return post && failure.text === post.text && failure.kind === post.kind
          && failure.label === corpus.intents.find(intent => intent.id === post.authoredFor).labels[row.style];
      }), 'bounced-post population or failure binding differs');
  }
  uniqueRows(summary.nearMissPaired, ['comparison'], 'paired near-miss statistics', 2);
  assert(summary.nearMissPaired.every(row => ['guided-vs-short', 'exclusion-vs-guided'].includes(row.comparison)
    && ['n', 'newFalseHides', 'repairedFalseHides', 'ownNewFalseHides', 'ownRepairedFalseHides'].every(key => count(row[key]))
    && row.newFalseHides <= row.n && row.repairedFalseHides <= row.n
    && row.ownNewFalseHides <= row.newFalseHides && row.ownRepairedFalseHides <= row.repairedFalseHides),
  'stored paired near-miss statistics are invalid');
  for (const row of summary.nearMissPaired) {
    const before = row.comparison === 'guided-vs-short' ? short : guided;
    const after = row.comparison === 'guided-vs-short' ? guided : exclusion;
    assert(row.n === before.nearMissDecisions && row.n === after.nearMissDecisions
      && after.nearMissFalseHides - before.nearMissFalseHides === row.newFalseHides - row.repairedFalseHides
      && after.ownNearMissFalseHides - before.ownNearMissFalseHides === row.ownNewFalseHides - row.ownRepairedFalseHides,
    'paired near-miss counts differ from stored metrics');
  }
}

function intro(result) {
  return ['## Fresh-filter test: Bounce label guidance', '',
    `Status: **${result.status}**. Registration recorded at ${text(result.registeredAt)} before inference. The fixed model is \`${MODEL}\`, with the \`matches-category\` template, one 4096-token slot and the exact frozen rule \`probability >= ${CUTOFF}\`.`, '',
    'The fresh synthetic corpus has six intents and 84 posts. Each style has 504 post/filter decisions; 22 ambiguous pairs are excluded from the 482-decision headline population. Labels are short, guided, or guided plus an exclusion. The run is one shuffled pass: 1,512 single-filter requests and 252 six-filter requests, with no retuning, relabeling or rerun.', '',
    'Preregistered gates use pooled single-filter decisions only. **G_guidance** requires fewer total errors than short labels AND no increase in near-miss false hides. **G_exclusion** requires no increase in near-miss false hides relative to guided labels AND no more than one additional missed hide. Six-filter results cannot satisfy either gate.', '',
    'For both gates, “near miss” means any post authored as a near-miss with negative gold for the tested filter, excluding ambiguous pairs: 143 eligible pairs per style, including cross-intent negative pairs. Own-filter near-miss counts are also reported separately (24 pairs per style), so the broader interpretation is visible.', ''];
}

/** Render registered or complete saved evidence without any runtime, scoring or optimizer imports. */
export async function renderGuidanceFresh({ dataDirectory }) {
  const [resultFile, summaryFile] = await Promise.all([read(dataDirectory, RESULT, true), read(dataDirectory, SUMMARY, true)]);
  if (!resultFile) {
    assert(!summaryFile, 'summary exists without its registered result');
    return { markdown: '', hasResults: false, hasPreregistration: false, complete: false };
  }
  const result = resultFile.value, corpus = await checkRegistration(result, dataDirectory), lines = intro(result);
  if (!summaryFile) {
    lines.push(`Recorded progress: ${result.requestsIssued}/1,764 requests issued; ${result.requests.length} completed receipts. ${result.status === 'registered'
      ? 'Inference has not started.' : result.status === 'failed' ? 'The run failed; no completed comparison or gate conclusion is available.'
        : 'A complete checked summary is not available; no gate conclusion is available.'}`, '',
    `Registration SHA-256: \`${result.registrationSha256}\`. [Registered result and progress](data/${RESULT}).`, '');
    return { markdown: lines.join('\n'), hasResults: false, hasPreregistration: true, complete: false, status: result.status };
  }
  const summary = summaryFile.value;
  checkSummary(summary, resultFile, corpus);
  const intents = ['all', ...corpus.intents.map(intent => intent.id)];
  const sort = (a, b) => intents.indexOf(a.intentId) - intents.indexOf(b.intentId) || STYLES.indexOf(a.style) - STYLES.indexOf(b.style);
  const metricRows = mode => summary.metrics.filter(row => row.mode === mode).sort(sort).map(row => [row.style, row.intentId,
    row.n, `${row.positives} / ${row.negatives}`, number(row.auc), `${row.falseHides} / ${row.missedHides}`, row.errors,
    `${row.nearMissFalseHides}/${row.nearMissDecisions}`, `${row.ownNearMissFalseHides}/${row.ownNearMissDecisions}`,
    `${row.missedSubtlePositives}/${row.subtlePositiveDecisions}`]);
  const gateRows = Object.entries(summary.gates).flatMap(([name, gate]) => Object.entries(gate.checks).map(([component, check]) =>
    [name, component, check.actual, check.comparison, check.reference, check.pass ? 'PASS' : 'FAIL', gate.supported ? 'SUPPORTED' : 'NOT SUPPORTED']));
  lines.push('Recorded gate outcomes (each gate requires both components to pass):', '',
    table(['Gate', 'Component', 'Actual', 'Comparison', 'Reference', 'Component result', 'Gate result'], gateRows), '',
    table(['Intent', 'Short', 'Guided', 'Guided + exclusion'], corpus.intents.map(intent => [intent.id,
      ...STYLES.map(style => intent.labels[style])])), '',
    'Single-filter headline results, pooled and by filter. FH/MH are false hides/missed hides per post/filter decision:', '',
    table(['Style', 'Filter', 'n', 'Gold + / −', 'AUC', 'FH / MH', 'Errors', 'Near-miss FH / n', 'Own near-miss FH / n', 'Subtle MH / n'], metricRows('single')), '',
    'Six-filter headline results (interference diagnostic; excluded from both gates):', '',
    table(['Style', 'Filter', 'n', 'Gold + / −', 'AUC', 'FH / MH', 'Errors', 'Near-miss FH / n', 'Own near-miss FH / n', 'Subtle MH / n'], metricRows('six-filter')), '',
    'Paired near-miss changes at the frozen cutoff:', '',
    table(['Comparison', 'Negative near-miss pairs', 'New false hides', 'Repaired false hides', 'Own new false hides', 'Own repaired false hides'],
      summary.nearMissPaired.map(row => [row.comparison, row.n, row.newFalseHides, row.repairedFalseHides, row.ownNewFalseHides, row.ownRepairedFalseHides])), '',
    'Request cost: pooled and per-filter single requests, plus pooled six-filter requests. Six-filter costs cover all six questions in one request.', '',
    table(['Mode', 'Style', 'Filter', 'Requests', 'Median wall ms', 'Median input tokens', 'Mean input tokens', 'Input tokens min–max'],
      summary.requestStats.filter(row => row.mode === 'single' || row.intentId === 'all').sort((a, b) => MODES.indexOf(a.mode) - MODES.indexOf(b.mode) || sort(a, b))
        .map(row => [row.mode, row.style, row.intentId, row.n, number(row.medianMs, 2), number(row.medianInputTokens, 1), number(row.meanInputTokens, 2), `${row.minInputTokens}–${row.maxInputTokens}`])), '',
    'These one-pass timings describe the recorded workload, rather than repeated steady-state latency cells.', '',
    'Single-versus-six-filter interference, including a separate population retaining the ambiguous pairs:', '',
    table(['Style', 'Filter', 'Population', 'n', 'Median absolute probability Δ', 'Worst absolute probability Δ', 'Frozen-cutoff flips'],
      [...summary.interference].sort(sort).map(row => [row.style, row.intentId, row.population, row.n, number(row.medianAbsDelta, 6), number(row.worstAbsDelta, 6), row.flips])), '',
    `The [full summary JSON](data/${SUMMARY}) contains all ${summary.interferenceFlips.length} interference flips with post text, gold, probabilities and correctness in each mode.`, '',
    'Own-filter “would the bounced post be caught again?” checks at the frozen cutoff (single-filter requests):', '',
    table(['Style', 'Filter', 'Positive bounced posts', 'Caught again', 'Missed', 'Subtle missed'], [...summary.bounced].sort(sort)
      .map(row => [row.style, row.intentId, row.n, row.caught, row.missed, row.subtleMissed])), '',
    'Missed bounced posts, with their full text (pooled duplicates omitted):', '',
    table(['Style', 'Filter', 'Post', 'Kind', 'Probability', 'Label', 'Text'], summary.bounced.filter(row => row.intentId !== 'all').sort(sort)
      .flatMap(row => row.failures.map(failure => [row.style, row.intentId, failure.postId, failure.kind, number(failure.probability, 6), failure.label, failure.text]))), '',
    'In-sample best cutoffs are diagnostics only. They never replace the frozen operating point or affect the gate conclusions; disconnected equally optimal intervals are joined by ∪:', '',
    table(['Mode', 'Style', 'Filter', 'Best cutoff', 'Equally optimal intervals', 'Best-cutoff errors'], [...summary.metrics].sort((a, b) => MODES.indexOf(a.mode) - MODES.indexOf(b.mode) || sort(a, b))
      .map(row => [row.mode, row.style, row.intentId, row.optimal.cutoff, row.optimal.intervals.map(intervalText).join(' ∪ '), row.optimal.errors])), '',
    `This is a fresh synthetic test of the proposed label guidance, not production or live-feed qualification. AUC and best cutoffs are descriptive; no labels, thresholds, models or runtime settings were changed after registration. [Raw result](data/${RESULT}); [summary](data/${SUMMARY}). Existing protected evidence remains unchanged. The renderer checks recorded provenance and aggregate/gate algebra only; it performs no inference, scoring, fitting or selection.`, '',
    `Evidence SHA-256: result \`${resultFile.sha256}\`; registration \`${result.registrationSha256}\`; corpus \`${CORPUS_HASH}\`; frozen selection \`${result.registration.model.selectionSha256}\`; identity \`${result.registration.model.identityHash}\`.`, '');
  return { markdown: lines.join('\n'), hasResults: true, hasPreregistration: true, complete: true, status: 'complete', summary };
}
