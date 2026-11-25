import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESULT = 'decision-capacity-result.json';
const SUMMARY = 'decision-capacity-summary.json';
const CORPUS = 'scripts/decision-eval/corpora/guidance-fresh-2026-11-25.json';
const CORPUS_HASH = 'fe82fe7dcdf8cd96fb828d20624b4ba160dede297c36ddcfa4e57c09f6373cb3';
const BASELINE = 'llama-d1-2b-q8';
const IDS = ['llama-d1-3b-q8', 'llama-kev-4b-q8', 'llama-clef-flash-q4km'];
const CUTOFF = 0.290813258948728;
const MODES = ['single', 'six-filter'];
// Independent copies of the immutable experiment bindings; no runner imports.
const ORIGINAL = {
  'eval-corpus.ts': '4a2dacac7271704addb5c06d953021b8c8c7f20108cfa002ce11942a6e907214',
  'native-benchmark-corpus.ts': 'a5db3bf30aa3039a3e571020c111797e1cfdd675872514a40139e66db6038603',
  'native-isolation-holdout.json': '18841a6609d9e68493c629880bc03eeaa233eab890245e5cfd5c2eaa9e9d4159',
  'native-migration-validation.json': '354e80566fdf889e213aec9072387c42f8286a48347379b1142073cba3fa4e27',
};
const TEMPLATES = [
  { id: 'matches-category', hash: '9a1e023c41c8c19c37317953ae8d7b486ec088070ce00abadd4809242eb67f54' },
  { id: 'category-applies', hash: '63c1d9bc4c93b016b38f047d74585d73b08f54651031b80433da8b1f915aee3a' },
];
const RULE = {
  switch: { baselineGuidedErrors: 66, freshGuidedErrorsMax: 33,
    originalValidation: { newFalseHidesMax: 1, exactVectorsAtLeastBrowser: true, correctHideShowDeficitMax: 1, bothCorporaRequired: true },
    warm10MedianMsMax: 250, allRequired: true, otherwise: 'd1-2B stays' },
  sentence: { baselineGuidedErrors: 66, errorsStrictlyFewer: true, nearMissFalseHidesMax: 18, allRequired: true },
  nearMissPopulation: 'Negative-gold non-ambiguous pairs on near-miss posts, including cross-filter pairs; own-filter near misses reported separately',
  primaryFreshMode: 'single', ambiguousExcluded: true, rubricIsUpperBound: true, discoveryOnlySelection: true,
  originalValidationIsExploratory: true, noRetuning: true, noRelabelling: true, noQualityReruns: true, speedRepetitions: 3,
};
const hash = value => createHash('sha256').update(value).digest('hex');
const objectHash = value => hash(JSON.stringify(value));
const assert = (condition, message) => { if (!condition) throw new Error(`Decision capacity: ${message}`); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => Number.isFinite(value) && value >= 0;
const probability = value => finite(value) && value <= 1;
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const number = (value, places = 4) => Number.isFinite(value) ? value.toFixed(places) : '—';
const text = value => value == null ? '—' : String(typeof value === 'object' ? JSON.stringify(value) : value)
  .replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(text).join(' | ')} |`)].join('\n');
const gib = value => finite(value) ? number(value / 1024 ** 3, 3) : '—';
const gb = value => finite(value) ? number(value / 1e9, 3) : '—';
const link = file => `[receipt](data/${file})`;

async function read(directory, name, optional = false) {
  try {
    const bytes = await readFile(resolve(directory, name));
    return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`${name}: ${error.message}`, { cause: error });
  }
}

async function boundFile(directory, binding, expected) {
  assert(record(binding) && binding.file === expected && digest(binding.sha256), `${expected}: source binding differs`);
  const file = await read(directory, expected);
  assert(file.sha256 === binding.sha256, `${expected}: source hash differs`);
  return file;
}

function unique(rows, keys, expected, label) {
  assert(Array.isArray(rows) && (expected === undefined || rows.length === expected)
    && new Set(rows.map(row => JSON.stringify(keys.map(key => row?.[key])))).size === rows.length,
  `${label}: missing or duplicate populations`);
}

function labelsFor(corpus) {
  return corpus.intents.map(intent => {
    const keep = intent.rubric.match(/\bKeep\b[^.!?]*[.!?]/)?.[0];
    assert(keep, `${intent.id}: no complete Keep sentence in frozen rubric`);
    return { intentId: intent.id, ...intent.labels, sentence: `${intent.labels.guided}. ${keep}`, rubric: intent.rubric };
  });
}

async function checkRegistration(file, directory) {
  const result = file.value, r = result.registration;
  assert(result.schemaVersion === 1 && result.phase === 'decision-capacity'
    && ['registered', 'running', 'complete', 'failed'].includes(result.status) && date(result.registeredAt), 'result header differs');
  assert(record(r) && result.registrationSha256 === objectHash(r)
    && same(r.corpora, { original: ORIGINAL, fresh: { file: CORPUS, sha256: CORPUS_HASH } })
    && same(r.templates, TEMPLATES), 'registration, corpus or template binding differs');
  assert(Array.isArray(r.models) && same(r.models.map(item => item?.id), IDS)
    && r.models.every(item => typeof item.model === 'string' && item.model && typeof item.format === 'string'
      && typeof item.artifact?.repository === 'string' && /^[0-9a-f]{40}$/.test(item.artifact?.revision)
      && typeof item.artifact?.file === 'string' && !item.artifact.file.includes('/')
      && digest(item.artifact?.sha256) && count(item.artifact?.logicalBytes) && item.artifact.logicalBytes > 0),
  'registered larger-model identities differ');
  assert(same(r.partA?.styles, ['sentence', 'rubric']) && r.partA.templateId === 'matches-category'
    && r.partA.cutoff === CUTOFF && typeof r.partA.questionEncoding === 'string'
    && same(r.partB?.styles, ['short', 'guided', 'rubric']) && r.partB.freshPrimaryMode === 'single'
    && typeof r.partB.cutoffsFrom === 'string' && typeof r.partB.questionEncoding === 'string'
    && same(r.freshSchedule, { seed: '0x0cab2026', partARequests: 1176, perLargerModelRequests: 1764 }),
  'registered experiment design differs');
  checkRule(r.rule);
  const corpus = await read(ROOT, CORPUS);
  assert(corpus.sha256 === CORPUS_HASH && corpus.value.intents?.length === 6 && corpus.value.posts?.length === 84,
    'current fresh corpus differs');
  for (const [name, expected] of Object.entries(ORIGINAL)) {
    const bytes = await readFile(new URL(`./corpora/${name}`, import.meta.url));
    assert(hash(bytes) === expected, `current original corpus differs: ${name}`);
  }
  const d = r.d1Baseline;
  assert(record(d) && d.selectionFile === `decision-1b-selection-${BASELINE}.json`
    && d.guidedResultFile === 'decision-guidance-fresh-result.json' && d.guidedSummaryFile === 'decision-guidance-fresh-summary.json'
    && d.guidedErrors === 66 && d.nearMissFalseHides === 18 && digest(d.identityHash), 'baseline registration differs');
  const [selectionFile, guidedResult, guidedSummary, identityFile] = await Promise.all([
    boundFile(directory, { file: d.selectionFile, sha256: d.selectionSha256 }, d.selectionFile),
    boundFile(directory, { file: d.guidedResultFile, sha256: d.guidedResultSha256 }, d.guidedResultFile),
    boundFile(directory, { file: d.guidedSummaryFile, sha256: d.guidedSummarySha256 }, d.guidedSummaryFile),
    read(directory, `decision-1b-identity-${BASELINE}.json`),
  ]);
  const selection = selectionFile.value;
  assert(selection.schemaVersion === 2 && selection.phase === 'discovery' && selection.frozen === true
    && selection.variantId === BASELINE && selection.cutoff === CUTOFF && selection.templateId === 'matches-category'
    && selection.templateHash === TEMPLATES[0].hash && selection.identityHash === d.identityHash
    && identityFile.value.variant?.id === BASELINE && objectHash(identityFile.value.identity) === d.identityHash,
  'baseline frozen selection or identity differs');
  const guided = guidedSummary.value.metrics?.find(row => row.mode === 'single' && row.style === 'guided' && row.intentId === 'all');
  assert(guidedResult.value.status === 'complete' && guidedSummary.value.status === 'complete'
    && guidedSummary.value.resultSha256 === guidedResult.sha256 && guided?.errors === 66 && guided.nearMissFalseHides === 18,
  'baseline guided comparison differs');
  assert(record(result.protectedHashes) && Object.keys(result.protectedHashes).length > 0, 'protected evidence hashes are missing');
  for (const [name, expected] of Object.entries(result.protectedHashes)) {
    assert(/^docs\/benchmarks\/data\/decision-[^/]+\.json$/.test(name)
      && !name.startsWith('docs/benchmarks/data/decision-capacity-') && digest(expected), 'protected evidence path or hash differs');
    assert((await read(directory, basename(name))).sha256 === expected, `protected evidence changed: ${name}`);
  }
  if (result.status === 'registered') assert(result.startedAt === undefined, 'registered result already started');
  else assert(date(result.startedAt) && Date.parse(result.startedAt) >= Date.parse(result.registeredAt), 'run started before registration');
  if (result.status === 'complete') assert(date(result.finishedAt)
    && Date.parse(result.finishedAt) >= Date.parse(result.startedAt), 'complete result has no finish time');
  return { corpus: corpus.value, baselineSelection: selection, baselineSummary: guidedSummary.value, labels: labelsFor(corpus.value) };
}

// The exact numeric policy is validated independently of the runner below.
function checkRule(rule) {
  assert(same(rule, RULE), 'preregistered numeric policy differs');
}

function intervalValid(value) {
  return record(value) && probability(value.lower) && probability(value.upper) && value.lower <= value.upper
    && finite(value.width) && typeof value.lowerInclusive === 'boolean' && typeof value.upperInclusive === 'boolean';
}

const intervalText = value => value ? `${value.lowerInclusive ? '[' : '('}${value.lower}, ${value.upper}${value.upperInclusive ? ']' : ')'}` : '—';

function checkMetric(row, styles, intents) {
  assert(record(row) && MODES.includes(row.mode) && styles.includes(row.style) && intents.includes(row.intentId)
    && ['n', 'positives', 'negatives', 'falseHides', 'missedHides', 'errors', 'correct', 'ambiguousExcluded',
      'nearMissFalseHides', 'nearMissDecisions', 'ownNearMissFalseHides', 'ownNearMissDecisions',
      'missedSubtlePositives', 'subtlePositiveDecisions'].every(key => count(row[key])), 'stored metric fields differ');
  const c = row.confusion, o = row.optimal;
  assert(row.n === row.positives + row.negatives && row.errors === row.falseHides + row.missedHides
    && row.correct + row.errors === row.n && (row.auc === null || probability(row.auc))
    && record(c) && ['tp', 'tn', 'fp', 'fn'].every(key => count(c[key])) && c.fp === row.falseHides && c.fn === row.missedHides
    && c.tp + c.fn === row.positives && c.tn + c.fp === row.negatives
    && row.nearMissFalseHides <= row.nearMissDecisions && row.nearMissFalseHides <= row.falseHides
    && row.ownNearMissFalseHides <= row.ownNearMissDecisions && row.ownNearMissFalseHides <= row.nearMissFalseHides
    && row.ownNearMissDecisions <= row.nearMissDecisions && row.missedSubtlePositives <= row.subtlePositiveDecisions
    && row.missedSubtlePositives <= row.missedHides && record(o) && probability(o.cutoff) && intervalValid(o.interval)
    && Array.isArray(o.intervals) && o.intervals.length > 0 && o.intervals.every(intervalValid)
    && ['errors', 'falseHides', 'missedHides'].every(key => count(o[key])) && o.errors === o.falseHides + o.missedHides
    && o.errors <= row.errors, 'stored metric algebra differs');
}

function checkMatrix(matrix, styles, cutoff, corpus, labels) {
  assert(record(matrix) && same(matrix.styles, styles) && matrix.cutoff === cutoff, 'matrix styles or frozen cutoff differ');
  const intents = ['all', ...corpus.intents.map(intent => intent.id)];
  unique(matrix.metrics, ['mode', 'style', 'intentId'], styles.length * 14, 'matrix metrics');
  for (const row of matrix.metrics) {
    checkMetric(row, styles, intents);
    const pairs = corpus.posts.flatMap(post => corpus.intents.filter(intent => row.intentId === 'all' || intent.id === row.intentId)
      .map(intent => ({ post, id: intent.id })));
    const eligible = pairs.filter(({ post, id }) => !post.ambiguousFor.includes(id));
    const near = eligible.filter(({ post, id }) => post.kind === 'near-miss' && !post.gold[id]);
    assert(row.n === eligible.length && row.ambiguousExcluded === pairs.length - eligible.length
      && row.positives === eligible.filter(({ post, id }) => post.gold[id]).length
      && row.nearMissDecisions === near.length
      && row.ownNearMissDecisions === near.filter(({ post, id }) => post.authoredFor === id).length
      && row.subtlePositiveDecisions === eligible.filter(({ post, id }) => post.kind === 'subtle-positive' && post.gold[id]).length,
    'matrix denominators differ from frozen corpus');
  }
  for (const mode of MODES) for (const style of styles) {
    const rows = matrix.metrics.filter(row => row.mode === mode && row.style === style), pooled = rows.find(row => row.intentId === 'all');
    assert(rows.length === 7 && intents.every(id => rows.some(row => row.intentId === id))
      && pooled.n === 482 && pooled.positives === 48 && pooled.nearMissDecisions === 143
      && pooled.ownNearMissDecisions === 24 && pooled.subtlePositiveDecisions === 18, 'matrix population differs');
    for (const field of ['n', 'positives', 'negatives', 'falseHides', 'missedHides', 'errors', 'correct', 'ambiguousExcluded',
      'nearMissFalseHides', 'nearMissDecisions', 'ownNearMissFalseHides', 'ownNearMissDecisions',
      'missedSubtlePositives', 'subtlePositiveDecisions']) assert(pooled[field] === rows.filter(row => row.intentId !== 'all')
      .reduce((sum, row) => sum + row[field], 0), `pooled ${field} differs`);
  }
  unique(matrix.requestStats, ['mode', 'style', 'intentId'], styles.length * 8, 'request statistics');
  for (const row of matrix.requestStats) assert(MODES.includes(row.mode) && styles.includes(row.style) && intents.includes(row.intentId)
    && (row.mode === 'single' || row.intentId === 'all') && row.n === (row.mode === 'single' && row.intentId === 'all' ? 504 : 84)
    && ['medianMs', 'medianInputTokens', 'meanInputTokens', 'minInputTokens', 'maxInputTokens'].every(key => finite(row[key]))
    && row.minInputTokens <= row.medianInputTokens && row.medianInputTokens <= row.maxInputTokens
    && row.minInputTokens <= row.meanInputTokens && row.meanInputTokens <= row.maxInputTokens, 'request statistics differ');
  unique(matrix.interference, ['style', 'intentId', 'population'], styles.length * 14, 'interference statistics');
  unique(matrix.interferenceFlips, ['style', 'postId', 'intentId'], undefined, 'interference flip details');
  for (const row of matrix.interferenceFlips) {
    const post = corpus.posts.find(post => post.id === row.postId);
    assert(styles.includes(row.style) && intents.includes(row.intentId) && row.intentId !== 'all' && post
      && row.text === post.text && row.gold === post.gold[row.intentId] && row.ambiguous === post.ambiguousFor.includes(row.intentId)
      && probability(row.singleProbability) && probability(row.multiProbability)
      && typeof row.singleCorrect === 'boolean' && typeof row.multiCorrect === 'boolean', 'interference flip details differ');
  }
  for (const row of matrix.interference) {
    const m = matrix.metrics.find(metric => metric.mode === 'single' && metric.style === row.style && metric.intentId === row.intentId);
    assert(m && ['headline', 'allIncludingAmbiguous'].includes(row.population)
      && row.n === m.n + (row.population === 'headline' ? 0 : m.ambiguousExcluded)
      && probability(row.medianAbsDelta) && probability(row.worstAbsDelta) && row.medianAbsDelta <= row.worstAbsDelta
      && count(row.flips) && row.flips === matrix.interferenceFlips.filter(flip => flip.style === row.style
        && (row.intentId === 'all' || flip.intentId === row.intentId) && (row.population !== 'headline' || !flip.ambiguous)).length,
    'interference aggregate differs');
  }
  unique(matrix.bounced, ['style', 'intentId'], styles.length * 7, 'bounced-post checks');
  for (const row of matrix.bounced) {
    const posts = corpus.posts.filter(post => (row.intentId === 'all' || post.authoredFor === row.intentId) && post.gold[post.authoredFor]);
    const m = matrix.metrics.find(metric => metric.mode === 'single' && metric.style === row.style && metric.intentId === row.intentId);
    assert(m && ['n', 'caught', 'missed', 'subtleMissed'].every(key => count(row[key])) && row.n === posts.length
      && row.caught + row.missed === row.n && row.missed === m.missedHides && row.subtleMissed === m.missedSubtlePositives
      && Array.isArray(row.failures) && row.failures.length === row.missed
      && new Set(row.failures.map(failure => failure.postId)).size === row.failures.length
      && row.failures.every(failure => {
        const post = posts.find(post => post.id === failure.postId);
        return post && failure.text === post.text && failure.kind === post.kind && probability(failure.probability)
          && failure.cutoff === cutoff && failure.label === labels.find(label => label.intentId === post.authoredFor)?.[row.style];
      }), 'bounced-post population or failures differ');
  }
}

const pooled = (matrix, style) => matrix.metrics.find(row => row.mode === 'single' && row.style === style && row.intentId === 'all');

function numericGate(actual, reference, comparison) {
  return { actual, reference, comparison, pass: comparison === '<' ? actual < reference : actual <= reference };
}

function checkSentenceRule(gate, matrix) {
  const sentence = pooled(matrix, 'sentence');
  const checks = { errors: numericGate(sentence.errors, 66, '<'), nearMissFalseHides: numericGate(sentence.nearMissFalseHides, 18, '<=') };
  assert(same(gate, { checks, supported: Object.values(checks).every(check => check.pass) }), 'sentence guidance gate differs');
}

function checkScores(scores, label) {
  assert(record(scores) && ['all', 'rage', 'broad'].every(key => {
    const g = scores[key], h = g?.hide;
    return record(g) && count(g.exactVectors) && count(g.totalVectors) && g.exactVectors <= g.totalVectors
      && record(h) && ['n', 'tp', 'tn', 'fp', 'fn'].every(field => count(h[field]))
      && h.n === g.totalVectors && h.n === h.tp + h.tn + h.fp + h.fn
      && g.falseHides === h.fp && g.missedHides === h.fn
      && (g.newFalseHides === null || count(g.newFalseHides)) && (g.newMissedHides === null || count(g.newMissedHides));
  }), `${label}: stored original scores differ`);
}

function checkValidationGates(value) {
  checkScores(value.scores, 'validation'); checkScores(value.at05, 'at 0.5'); checkScores(value.browser, 'Browser');
  const all = value.scores.all, browser = value.browser.all;
  const gates = {
    G1: { metric: 'newFalseHides', actual: all.newFalseHides, max: 1, pass: all.newFalseHides <= 1 },
    G2: { metric: 'exactVectors', actual: all.exactVectors, min: browser.exactVectors, pass: all.exactVectors >= browser.exactVectors },
    G3: { metric: 'correctHideDecisions', actual: all.hide.tp + all.hide.tn,
      min: browser.hide.tp + browser.hide.tn - 1, pass: all.hide.tp + all.hide.tn >= browser.hide.tp + browser.hide.tn - 1 },
  };
  assert(count(all.newFalseHides) && same(value.gates, gates) && value.pass === Object.values(gates).every(gate => gate.pass),
    'original validation gate algebra differs');
  if (value.corpus === 'isolation') assert(value.textOnlyQat === null, 'isolation has an unavailable QAT baseline');
  else {
    checkScores(value.textOnlyQat?.scores, 'text-only QAT');
    assert(value.textOnlyQat.contextTokens === 1024 && value.textOnlyQat.runtime === 'Ollama 0.40.3', 'QAT context or runtime differs');
  }
}

function checkProductRule(value) {
  const checks = { freshGuidedErrors: numericGate(pooled(value.fresh.matrix, 'guided').errors, 33, '<='),
    originalValidation: { pass: value.validation.every(item => item.pass) },
    warm10MedianMs: numericGate(value.performance.warm10.median, 250, '<=') };
  assert(same(value.productRule, { checks, worthSwitching: Object.values(checks).every(check => check.pass) }),
    'larger-model product gate differs');
}

async function checkFresh(directory, value, variant, selection, identityHash, result, context, styles, baseline = false) {
  const file = await boundFile(directory, value, `decision-capacity-fresh-${variant.id}.json`), raw = file.value;
  const selectionName = baseline ? `decision-1b-selection-${BASELINE}.json` : `decision-capacity-selection-${variant.id}.json`;
  const selectionFile = await read(directory, selectionName);
  assert(raw.schemaVersion === 1 && raw.phase === 'decision-capacity-fresh' && raw.status === 'complete'
    && same(raw.variant, variant) && raw.registrationSha256 === result.registrationSha256
    && raw.selectionFile === selectionName && raw.selectionSha256 === selectionFile.sha256 && same(raw.selection, selection)
    && raw.identityHash === identityHash && same(raw.runtimeSettings, selection.runtimeSettings)
    && raw.corpusSha256 === CORPUS_HASH && same(raw.corpusSnapshot, context.corpus) && same(raw.styleLabels, context.labels)
    && same(raw.styles, styles) && raw.requestsIssued === styles.length * 588
    && Array.isArray(raw.requests) && raw.requests.length === raw.requestsIssued
    && date(raw.startedAt) && Date.parse(raw.startedAt) >= Date.parse(result.registeredAt)
    && date(raw.finishedAt) && Date.parse(raw.finishedAt) >= Date.parse(raw.startedAt) && record(raw.environment),
  `${variant.id}: fresh raw provenance differs`);
  if (baseline) assert(same(raw.baselineGuided, { file: result.registration.d1Baseline.guidedResultFile,
    sha256: result.registration.d1Baseline.guidedResultSha256, style: 'guided' }), 'Part A historical guided binding differs');
  checkMatrix(value.matrix, baseline ? ['guided', 'sentence', 'rubric'] : styles, selection.cutoff, context.corpus, context.labels);
}

async function checkModel(directory, value, registered, result, context) {
  const id = registered.id;
  assert(record(value) && value.variant?.id === id && value.variant.model === registered.model
    && value.variant.format === registered.format && value.variant.runtime === 'llama', `${id}: model summary differs`);
  const [identityFile, discoveryFile, selectionFile] = await Promise.all(['identity', 'discovery', 'selection']
    .map(kind => read(directory, `decision-capacity-${kind}-${id}.json`)));
  const identity = identityFile.value, discovery = discoveryFile.value, selection = selectionFile.value;
  const artifact = registered.artifact;
  assert(identity.schemaVersion === 2 && same(identity.variant, value.variant) && same(identity.identity, value.identity)
    && ['repository', 'revision', 'file', 'sha256'].every(key => value.identity?.[key] === artifact[key])
    && value.identity.disk?.logicalBytes === artifact.logicalBytes, `${id}: artifact identity differs`);
  assert(discovery.schemaVersion === 2 && discovery.phase === 'discovery' && same(discovery.variant, value.variant)
    && discovery.identityHash === objectHash(value.identity) && same(discovery.corpusHashes, ORIGINAL)
    && same(discovery.templates?.map(item => ({ id: item.id, hash: item.hash })), TEMPLATES)
    && selection.schemaVersion === 2 && selection.phase === 'discovery' && selection.frozen === true
    && same(selection, value.selection) && selection.variantId === id && selection.identityHash === objectHash(value.identity)
    && selection.discoverySha256 === discoveryFile.sha256 && same(selection.corpusHashes, ORIGINAL)
    && same(selection.runtimeSettings, discovery.runtimeSettings) && selection.runtimeSettings?.effectiveContext === 4096
    && selection.runtimeSettings.parallel === 1 && probability(selection.cutoff), `${id}: discovery or frozen selection differs`);
  const chosen = discovery.templates.find(item => item.id === selection.templateId);
  assert(chosen && chosen.hash === selection.templateHash && selection.cutoff === chosen.optimized?.cutoff
    && same(selection.interval, chosen.optimized.interval) && same(value.discovery?.chosen, chosen.optimized.scores)
    && same(value.discovery.at05, chosen.at05) && same(value.discovery.loo, selection.loo), `${id}: recorded discovery scores differ`);
  checkScores(value.discovery.chosen, 'discovery'); checkScores(value.discovery.at05, 'discovery at 0.5');
  checkPerformance(value.performance);
  assert(same(value.performance.disk, value.identity.disk), `${id}: disk accounting differs`);
  await checkPerformanceSources(directory, value, selection, result);
  unique(value.validation, ['corpus'], 2, 'original validation');
  assert(same(value.validation.map(item => item.corpus).sort(), ['isolation', 'migration']), `${id}: original validation corpora differ`);
  for (const validation of value.validation) {
    const source = await boundFile(directory, validation, `decision-capacity-validation-${id}-${validation.corpus}.json`);
    checkValidationGates(validation);
    await checkValidationSource(directory, source.value, validation, value, selectionFile, result);
  }
  await checkFresh(directory, value.fresh, value.variant, selection, selection.identityHash, result, context, ['short', 'guided', 'rubric']);
  checkProductRule(value);
}

function checkPerformance(value) {
  assert(record(value) && ['warm3', 'warm10'].every(key => record(value[key]) && count(value[key].n) && value[key].n > 0
    && finite(value[key].median) && finite(value[key].p90) && value[key].median <= value[key].p90)
    && ['coldMedianMs', 'steadyRssBytes', 'steadyFootprintBytes', 'peakRssBytes', 'peakFootprintBytes'].every(key => finite(value[key]))
    && value.peakRssBytes >= value.steadyRssBytes && value.peakFootprintBytes >= value.steadyFootprintBytes
    && typeof value.identicalProbabilities === 'boolean', 'performance summary differs');
}

async function checkPerformanceSources(directory, value, selection) {
  const id = value.variant.id;
  assert(Array.isArray(value.performance.sources) && value.performance.sources.length === 3, `${id}: speed source hashes are missing`);
  for (let repetition = 0; repetition < 3; repetition++) {
    const file = await boundFile(directory, value.performance.sources[repetition], `decision-capacity-speed-r${repetition}-${id}.json`);
    const raw = file.value;
    assert(raw.schemaVersion === 2 && raw.phase === 'performance' && raw.repetition === repetition
      && same(raw.variant, value.variant) && same(raw.selection, selection) && raw.identityHash === selection.identityHash
      && same(raw.runtimeSettings, selection.runtimeSettings) && raw.artifact?.model === value.variant.model
      && raw.artifact.format === value.variant.format && raw.artifact.digest === value.identity.sha256
      && same(raw.artifact.disk, value.identity.disk), `${id}: speed source provenance differs`);
  }
}

async function checkValidationSource(directory, raw, value, model, selectionFile, result) {
  const sourceCorpus = value.corpus === 'isolation' ? 'native-isolation-holdout.json' : 'native-migration-validation.json';
  const baseline = await read(directory, 'decision-baselines.json');
  assert(raw.schemaVersion === 1 && raw.phase === 'decision-capacity-validation' && raw.status === 'complete'
    && raw.exploratory === true && raw.preRegisteredClaim === false && raw.registrationSha256 === result.registrationSha256
    && same(raw.variant, model.variant) && raw.identityHash === model.selection.identityHash
    && same(raw.runtimeSettings, model.selection.runtimeSettings) && same(raw.corpusHashes, ORIGINAL)
    && raw.selectionFile === `decision-capacity-selection-${model.variant.id}.json`
    && raw.selectionSha256 === selectionFile.sha256 && same(raw.selection, model.selection)
    && raw.corpus === value.corpus && raw.sourceCorpus === sourceCorpus && raw.corpusSha256 === ORIGINAL[sourceCorpus]
    && raw.baselineSha256 === baseline.sha256 && same(raw.atFrozen, value.scores) && same(raw.at05, value.at05)
    && same(raw.baseline?.browser?.scores, value.browser) && same(raw.baseline?.textOnlyQat, value.textOnlyQat)
    && Array.isArray(raw.rows) && raw.rows.length === value.scores.all.totalVectors && raw.requestsIssued === raw.rows.length
    && same(raw.gates, value.gates) && raw.pass === value.pass, 'original validation source binding differs');
}

async function checkSummary(summary, resultFile, directory, context) {
  const result = resultFile.value;
  assert(summary.schemaVersion === 1 && summary.phase === 'decision-capacity' && summary.status === 'complete'
    && result.status === 'complete' && summary.resultFile === RESULT && summary.resultSha256 === resultFile.sha256
    && summary.registrationSha256 === result.registrationSha256 && summary.immutableEvidenceUnchanged === true,
  'complete summary binding differs');
  const baselineIdentity = (await read(directory, `decision-1b-identity-${BASELINE}.json`)).value;
  assert(same(summary.partA?.selection, context.baselineSelection), 'Part A frozen selection differs');
  await checkFresh(directory, summary.partA, baselineIdentity.variant, context.baselineSelection,
    result.registration.d1Baseline.identityHash, result, context, ['sentence', 'rubric'], true);
  const historic = context.baselineSummary.metrics.filter(row => row.style === 'guided');
  assert(same(summary.partA.matrix.metrics.filter(row => row.style === 'guided'), historic), 'Part A historical guided scores differ');
  checkSentenceRule(summary.partA.sentenceRule, summary.partA.matrix);
  assert(Array.isArray(summary.models) && same(summary.models.map(item => item.variant?.id), IDS), 'summary model population differs');
  for (let i = 0; i < IDS.length; i++) await checkModel(directory, summary.models[i], result.registration.models[i], result, context);
  const archive = await boundFile(directory, summary.archive, 'decision-capacity-archive.json');
  assert(digest(archive.value.sha256) && count(archive.value.bytes) && archive.value.bytes > 0, 'raw archive descriptor differs');
}

function intro(result) {
  return ['## Capacity and description experiment', '',
    `Status: **${result.status}**. Registration recorded at ${text(result.registeredAt)} before inference. This experiment compares sentence guidance and full rubrics on d1-2B Q8 with three larger models. It changes no extension engine, model or default.`, '',
    'Part A retains d1-2B Q8’s frozen `matches-category` wrapper and `probability >= 0.290813258948728` cutoff. A sentence label is the guided label plus “. ” and the first complete “Keep…” sentence copied verbatim from its gold rubric; nothing is hand-authored. Full rubrics fill the same category slot in the selected template, rather than adding instructions outside that wrapper. **Full-gold rubric results are an upper bound**, because the definition contains the gold labeling boundary.', '',
    'Part B selects one of the same two templates and a midpoint cutoff on the original 88-case discovery set, then freezes that choice before either original validation corpus or the fresh short/guided/rubric matrix. Original validation is exploratory: those corpora already helped qualify Gemma. The fresh 84-post corpus has six intents and 504 decisions per style; 22 ambiguous pairs leave 482 headline decisions, including 48 positives and 18 subtle positives.', '',
    'The independent sentence-guidance rule requires **errors < 66 AND near-miss false hides ≤ 18** on d1-2B’s single-filter decisions. Near misses retain the original population of 143 eligible negative pairs on near-miss-tagged posts, including cross-filter pairs; the 24 own-filter pairs are secondary diagnostics.', '',
    'The preregistered larger-model switch rule requires **fresh guided errors ≤ 33 AND G1/G2/G3 on BOTH original corpora AND warm ten-filter p50 ≤ 250 ms**. G1 allows at most one new false hide versus Browser, G2 requires at least Browser’s exact vectors, and G3 requires at least Browser’s correct hide/show decisions minus one. Rubric quality, six-filter behavior and in-sample best cutoffs cannot satisfy that rule.', ''];
}

function matrixRows(matrix, id) {
  return matrix.metrics.map(row => [id, row.mode, row.style, row.intentId, row.n, number(row.auc), `${row.falseHides} / ${row.missedHides}`,
    row.errors, `${row.nearMissFalseHides}/${row.nearMissDecisions}`, `${row.ownNearMissFalseHides}/${row.ownNearMissDecisions}`,
    `${row.missedSubtlePositives}/${row.subtlePositiveDecisions}`, number(row.optimal.cutoff, 6),
    intervalText(row.optimal.interval), row.optimal.errors]);
}

const scoreCells = scores => {
  const all = scores.all;
  return [`${all.exactVectors}/${all.totalVectors}`, `${all.hide.tp + all.hide.tn}/${all.hide.n}`,
    `${all.falseHides} / ${all.missedHides}`, `${text(all.newFalseHides)} / ${text(all.newMissedHides)}`];
};

/** Recorded data only: no inference, runtime imports, probability scoring or threshold optimization. */
export async function renderCapacity({ dataDirectory }) {
  const [resultFile, summaryFile] = await Promise.all([read(dataDirectory, RESULT, true), read(dataDirectory, SUMMARY, true)]);
  if (!resultFile) {
    assert(!summaryFile, 'summary exists without registered result');
    return { markdown: '', hasResults: false, hasPreregistration: false, complete: false };
  }
  const result = resultFile.value, context = await checkRegistration(resultFile, dataDirectory), lines = intro(result);
  if (!summaryFile) {
    lines.push(`Recorded stage: ${text(result.stage)}. ${result.status === 'registered' ? 'Inference has not started.'
      : result.status === 'failed' ? `The run failed: ${text(result.error?.message ?? result.error)}.` : 'A complete checked summary is not available.'}
No completed comparison, gate conclusion or switch recommendation is available.`, '',
    `Registration SHA-256: \`${result.registrationSha256}\`. [Registration and progress](data/${RESULT}).`, '');
    return { markdown: lines.join('\n'), hasResults: false, hasPreregistration: true, complete: false, status: result.status };
  }
  const summary = summaryFile.value;
  await checkSummary(summary, resultFile, dataDirectory, context);
  const matrices = [{ id: BASELINE, value: summary.partA.matrix, file: summary.partA.file },
    ...summary.models.map(item => ({ id: item.variant.id, value: item.fresh.matrix, file: item.fresh.file }))];
  const sentenceRows = Object.entries(summary.partA.sentenceRule.checks).map(([name, check]) =>
    [BASELINE, name, check.actual, check.comparison, check.reference, check.pass ? 'PASS' : 'FAIL']);
  const productRows = summary.models.flatMap(item => Object.entries(item.productRule.checks).map(([name, check]) =>
    [item.variant.id, name, check.actual ?? 'both corpora', check.comparison ?? 'all gates', check.reference ?? 'pass',
      check.pass ? 'PASS' : 'FAIL', item.productRule.worthSwitching ? 'PASSES SWITCH RULE' : 'DOES NOT PASS SWITCH RULE']));
  lines.push(`Sentence guidance: **${summary.partA.sentenceRule.supported ? 'SUPPORTED' : 'NOT SUPPORTED'}** by both recorded checks.`, '',
    table(['Model', 'Description check', 'Actual', 'Comparison', 'Reference', 'Result'], sentenceRows), '',
    table(['Larger model', 'Switch check', 'Actual', 'Comparison', 'Reference', 'Result', 'Overall'], productRows), '',
    'Frozen choices (discovery chooses the operating point; fresh and validation results never retune it):', '',
    table(['Model', 'Model name', 'Format', 'Template', 'Cutoff', 'Equivalent interval', 'Identity SHA-256'], [
      [BASELINE, 'LiquidAI/d1-2B-GGUF:Q8_0', 'GGUF Q8_0', summary.partA.selection.templateId, summary.partA.selection.cutoff,
        intervalText(summary.partA.selection.interval), result.registration.d1Baseline.identityHash],
      ...summary.models.map(item => [item.variant.id, item.variant.model, item.variant.format, item.selection.templateId,
        item.selection.cutoff, intervalText(item.selection.interval), item.selection.identityHash])]), '',
    table(['Intent', 'Short', 'Guided', 'Mechanical sentence', 'Full gold rubric (upper bound)'], context.labels.map(label =>
      [label.intentId, label.short, label.guided, label.sentence, label.rubric])), '',
    'Fresh headline quality. FH/MH are false hides/missed hides. The single-filter guided row alone contributes fresh quality to the switch gate; six-filter rows measure interference.', '',
    table(['Model', 'Mode', 'Style', 'Filter', 'n', 'AUC', 'FH / MH', 'Errors', 'Near-miss FH / n', 'Own near-miss FH / n', 'Subtle MH / n',
      'In-sample best cutoff', 'Best interval', 'Best errors'],
      matrices.flatMap(item => matrixRows(item.value, item.id))), '',
    'Original discovery (exploratory), with the selected cutoff, fixed 0.5 and leave-one-out selection:', '',
    table(['Model', 'Operating point', 'Exact vectors', 'Correct hide/show', 'FH / MH', 'New FH / MH vs Browser'], summary.models.flatMap(item => [
      [item.variant.id, `frozen ≥ ${item.selection.cutoff}`, ...scoreCells(item.discovery.chosen)],
      [item.variant.id, 'fixed ≥ 0.5', ...scoreCells(item.discovery.at05)],
      [item.variant.id, 'leave-one-out', ...scoreCells(item.discovery.loo.groups ?? { all: item.discovery.loo })]])), '',
    'Original validation gates remain separate for each corpus:', '',
    table(['Model', 'Corpus', 'Gate', 'Actual', 'Required', 'Result'], summary.models.flatMap(item => item.validation.flatMap(value =>
      Object.entries(value.gates).map(([name, gate]) => [item.variant.id, value.corpus, `${name}: ${gate.metric}`, gate.actual,
        gate.max === undefined ? `≥ ${gate.min}` : `≤ ${gate.max}`, gate.pass ? 'PASS' : 'FAIL'])))), '',
    table(['Model', 'Corpus', 'Operating point', 'Exact vectors', 'Correct hide/show', 'FH / MH', 'New FH / MH vs Browser'],
      summary.models.flatMap(item => item.validation.flatMap(value => [
        [item.variant.id, value.corpus, 'frozen', ...scoreCells(value.scores)],
        [item.variant.id, value.corpus, 'fixed ≥ 0.5', ...scoreCells(value.at05)],
        ['Browser Gemma E2B', value.corpus, 'historical baseline', ...scoreCells(value.browser)],
        ...(value.textOnlyQat ? [['Text-only QAT Gemma E2B', value.corpus, `${value.textOnlyQat.runtime}; 1024 tokens`, ...scoreCells(value.textOnlyQat.scores)]] : [])]))), '',
    table(['Model', 'Warm ×3 p50 / p90 ms (n)', 'Warm ×10 p50 / p90 ms (n)', 'Cold median ms', 'Steady RSS / footprint GiB',
      'Peak RSS / footprint GiB', 'Logical / allocated disk GB', 'Disk scope', 'Identical controls'], summary.models.map(item => {
      const p = item.performance, latency = cell => `${number(cell.median, 2)} / ${number(cell.p90, 2)} (${cell.n})`;
      return [item.variant.id, latency(p.warm3), latency(p.warm10), number(p.coldMedianMs, 2),
        `${gib(p.steadyRssBytes)} / ${gib(p.steadyFootprintBytes)}`, `${gib(p.peakRssBytes)} / ${gib(p.peakFootprintBytes)}`,
        `${gb(p.disk.logicalBytes)} / ${gb(p.disk.allocatedBytes)}`, p.disk.scope, p.identicalProbabilities ? 'yes' : 'no'];
    })), '',
    'Memory is process-tree RSS and physical footprint, shown separately. Disk GB are decimal; memory GiB are binary. Capacity cold time sums explicit model loading, observed runtime settings and the first request, excluding artifact integrity hashing. Its metadata sequence differs from the older implicit-load cold measurement, so it is not a controlled comparison of cold speed. Timings describe the pinned 4096-token, one-slot serving stack and do not qualify extension lifecycle or live-feed behavior. Fresh one-pass request timings below are separate from repeated steady-state speed cells.', '',
    table(['Model', 'Mode', 'Style', 'Filter', 'Requests', 'Median ms', 'Median / mean input tokens', 'Input tokens min–max'],
      matrices.flatMap(item => item.value.requestStats.map(row => [item.id, row.mode, row.style, row.intentId, row.n,
        number(row.medianMs, 2), `${number(row.medianInputTokens, 1)} / ${number(row.meanInputTokens, 2)}`, `${row.minInputTokens}–${row.maxInputTokens}`]))), '',
    'Single-versus-six-filter interference, including ambiguous pairs only in the explicitly named secondary population:', '',
    table(['Model', 'Style', 'Filter', 'Population', 'n', 'Median / worst absolute Δ', 'Flips'], matrices.flatMap(item =>
      item.value.interference.map(row => [item.id, row.style, row.intentId, row.population, row.n,
        `${number(row.medianAbsDelta, 6)} / ${number(row.worstAbsDelta, 6)}`, row.flips]))), '',
    'Own-filter bounced-post checks use positive posts with their single-filter label:', '',
    table(['Model', 'Style', 'Filter', 'Bounced positives', 'Caught', 'Missed', 'Subtle missed'], matrices.flatMap(item =>
      item.value.bounced.map(row => [item.id, row.style, row.intentId, row.n, row.caught, row.missed, row.subtleMissed]))), '',
    `The [complete summary](data/${SUMMARY}) retains per-filter best-cutoff diagnostics, every interference flip and the full text of every missed bounced post. Best cutoffs are descriptive and never replace the frozen cutoff. Raw fresh receipts: ${matrices.map(item => `${item.id} ${link(item.file)}`).join('; ')}.`, '',
    `The original evidence is unchanged. [Registration/result](data/${RESULT}), [summary](data/${SUMMARY}) and [raw archive descriptor](data/decision-capacity-archive.json) are hash-bound. Result SHA-256: \`${resultFile.sha256}\`; registration SHA-256: \`${result.registrationSha256}\`. The renderer reads recorded JSON, verifies provenance and checks aggregate/gate algebra; it performs no inference, scoring or optimization.`, '');
  return { markdown: lines.join('\n'), hasResults: true, hasPreregistration: true, complete: true, status: 'complete', summary };
}
