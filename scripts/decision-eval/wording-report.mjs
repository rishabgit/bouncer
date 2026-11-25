import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';

const SUMMARY = 'decision-wording-probe-summary.json';
const RAW = 'decision-wording-probe-raw.json';
const FLIPS = 'decision-wording-probe-flips.json';
const VARIANT = 'llama-d1-2b-q8';
const MODEL = 'LiquidAI/d1-2B-GGUF:Q8_0';
const CUTOFF = 0.290813258948728;
const STYLES = ['D', 'K1', 'K2', 'Rdef', 'X'];
const CORPORA = ['all', 'discovery', 'isolation', 'migration'];
const hash = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(`Label wording probe: ${message}`); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const number = (value, places = 4) => Number.isFinite(value) ? value.toFixed(places) : '—';
const pValue = value => Number.isFinite(value) && value > 0 && value < 0.0001 ? value.toExponential(3) : number(value, 6);
const signed = (value, places = 4) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(places)}` : '—';
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

function intervalValid(value) {
  return record(value) && probability(value.lower) && probability(value.upper) && value.lower <= value.upper
    && Number.isFinite(value.width) && value.width >= 0
    && typeof value.lowerInclusive === 'boolean' && typeof value.upperInclusive === 'boolean';
}

function intervalText(value) {
  return `${value.lowerInclusive ? '[' : '('}${value.lower}, ${value.upper}${value.upperInclusive ? ']' : ')'}`;
}

function rowBinding(row, styles, intents) {
  return record(row) && styles.includes(row.variant ?? row.style) && CORPORA.includes(row.corpus)
    && (row.intent === 'all' || intents.has(row.intent)) && count(row.n);
}

function uniqueRows(rows, keys, label) {
  assert(Array.isArray(rows) && rows.length > 0, `${label} are missing`);
  assert(new Set(rows.map(row => JSON.stringify(keys.map(key => row[key])))).size === rows.length,
    `${label} have duplicate population keys`);
}

// Verify the recorded evidence and its frozen provenance. Never fit, score, or infer.
function check(summary, raw, flips, selection, identity) {
  assert(summary.schemaVersion === 1 && summary.phase === 'exploratory-label-wording' && summary.status === 'complete',
    'summary is not complete exploratory evidence');
  assert(summary.rawFile === RAW && summary.flipsFile === FLIPS && summary.rawSha256 === raw.sha256
    && summary.flipsSha256 === flips.sha256, 'raw or flip evidence hash differs');
  assert(summary.cutoff === CUTOFF && summary.roundedCutoff === 0.2908
    && count(summary.roundedCutoffDecisionDifferences), 'frozen cutoff binding differs');
  assert(summary.model?.variantId === VARIANT && summary.model.model === MODEL
    && digest(summary.model.identityHash) && digest(summary.model.selectionSha256)
    && summary.model.selectionSha256 === selection.sha256
    && selection.value.schemaVersion === 2 && selection.value.phase === 'discovery' && selection.value.frozen === true
    && selection.value.variantId === VARIANT && selection.value.cutoff === CUTOFF
    && selection.value.identityHash === summary.model.identityHash
    && identity.value.schemaVersion === 2 && identity.value.variant?.id === VARIANT && identity.value.variant.model === MODEL
    && record(identity.value.identity) && hash(JSON.stringify(identity.value.identity)) === summary.model.identityHash,
  'model, identity or frozen selection binding differs');
  assert(record(summary.runtimeSettings) && same(summary.runtimeSettings, selection.value.runtimeSettings)
    && same(raw.value.runtimeSettings, summary.runtimeSettings), 'frozen runtime settings differ');
  assert(raw.value.schemaVersion === 1 && raw.value.phase === 'exploratory-label-wording' && raw.value.status === 'complete'
    && same(raw.value.model, summary.model) && raw.value.cutoff === CUTOFF
    && same(raw.value.corpusHashes, selection.value.corpusHashes), 'raw provenance differs');
  assert(flips.value.schemaVersion === 1 && flips.value.phase === 'exploratory-label-wording'
    && flips.value.cutoff === CUTOFF && Array.isArray(flips.value.rows), 'flip evidence binding differs');
  assert(summary.goldProvisional === true && summary.immutableEvidenceUnchanged === true && record(summary.environment),
    'provisional-gold or immutable-evidence statement differs');
  assert(record(summary.counts) && ['cases', 'decisions', 'requests'].every(key => count(summary.counts[key]))
    && Array.isArray(raw.value.cases) && Array.isArray(raw.value.requests)
    && summary.counts.cases === raw.value.cases.length && summary.counts.requests === raw.value.requests.length
    && raw.value.cases.every(item => Array.isArray(item.filters) && Array.isArray(item.expected)
      && item.filters.length === item.expected.length)
    && summary.counts.decisions === raw.value.cases.reduce((total, item) => total + item.filters.length, 0),
  'recorded case, decision or request counts differ');
  assert(Array.isArray(raw.value.intents) && raw.value.intents.length > 0
    && raw.value.intents.every(item => record(item) && ['D', 'K1', 'K2'].every(key => typeof item[key] === 'string' && item[key].trim())
      && (item.X === undefined || typeof item.X === 'string')),
  'recorded intent labels are missing');
  const intents = new Set(raw.value.intents.map(item => item.D));
  assert(intents.size === raw.value.intents.length, 'recorded descriptive intents are duplicated');
  uniqueRows(summary.metrics, ['variant', 'intent', 'corpus'], 'metrics');
  assert(summary.metrics.every(row => rowBinding(row, STYLES, intents)
    && count(row.positives) && count(row.negatives) && row.positives + row.negatives === row.n
    && (row.auc === null || probability(row.auc)) && ['falseHides', 'missedHides', 'errors', 'correct'].every(key => count(row[key]))
    && row.falseHides + row.missedHides === row.errors && row.correct + row.errors === row.n
    && record(row.confusion) && record(row.optimal) && probability(row.optimal.cutoff)
    && intervalValid(row.optimal.interval) && Array.isArray(row.optimal.intervals) && row.optimal.intervals.length > 0
    && row.optimal.intervals.every(intervalValid)
    && ['errors', 'falseHides', 'missedHides'].every(key => count(row.optimal[key]))), 'stored metrics are incomplete or invalid');
  uniqueRows(summary.paired, ['variant', 'intent', 'corpus'], 'paired comparisons');
  assert(summary.paired.every(row => rowBinding(row, ['K1', 'K2', 'Rdef', 'X'], intents)
    && (row.aucDifference === null || Number.isFinite(row.aucDifference)) && Number.isFinite(row.errorDifference)
    && count(row.flips) && record(row.mcnemar) && row.mcnemar.n === row.n
    && ['bothCorrect', 'bothWrong', 'dCorrectKWrong', 'dWrongKCorrect', 'discordant'].every(key => count(row.mcnemar[key]))
    && probability(row.mcnemar.pValue) && row.mcnemar.method === 'exact two-sided binomial'),
  'stored paired comparisons are incomplete or invalid');
  uniqueRows(summary.requestStats, ['variant', 'mode', 'intent', 'corpus'], 'request statistics');
  assert(summary.requestStats.every(row => rowBinding(row, STYLES, new Set([...intents, 'multi-filter'])) && ['single', 'multi'].includes(row.mode)
    && ['medianMs', 'medianInputTokens', 'meanInputTokens', 'minInputTokens', 'maxInputTokens'].every(key => Number.isFinite(row[key]) && row[key] >= 0)),
  'stored request statistics are incomplete or invalid');
  uniqueRows(summary.interference, ['style', 'intent', 'corpus'], 'interference statistics');
  assert(summary.interference.every(row => rowBinding(row, ['D', 'K1'], intents)
    && probability(row.medianAbsDelta) && probability(row.worstAbsDelta) && count(row.flips)),
  'stored interference statistics are incomplete or invalid');
}

function metricRows(rows, withIntent = true) {
  return rows.map(row => [row.variant, ...(withIntent ? [row.intent] : [row.corpus]), row.n,
    `${row.positives} / ${row.negatives}`, number(row.auc), `${row.falseHides} / ${row.missedHides}`,
    row.errors, `${row.correct}/${row.n}`, row.optimal.cutoff,
    row.optimal.intervals.map(intervalText).join(' ∪ '), row.optimal.errors]);
}

/** Render only saved exploratory evidence. An absent summary leaves no report section. */
export async function renderWordingProbe({ dataDirectory }) {
  const file = await read(dataDirectory, SUMMARY, true);
  if (!file) return { markdown: '', hasResults: false };
  const raw = await read(dataDirectory, RAW);
  const flips = await read(dataDirectory, FLIPS);
  const selection = await read(dataDirectory, `decision-1b-selection-${VARIANT}.json`);
  const identity = await read(dataDirectory, `decision-1b-identity-${VARIANT}.json`);
  const summary = file.value;
  check(summary, raw, flips, selection, identity);
  const metricHead = ['Variant', 'Intent', 'n', 'Gold + / −', 'AUC', 'FH / MH', 'Errors', 'Correct',
    'In-sample best cutoff', 'All equally optimal cutoff intervals', 'Best-cutoff errors'];
  const intentOrder = ['all', ...raw.value.intents.map(item => item.D)];
  const byIntentStyle = (a, b) => intentOrder.indexOf(a.intent) - intentOrder.indexOf(b.intent)
    || STYLES.indexOf(a.variant ?? a.style) - STYLES.indexOf(b.variant ?? b.style);
  const pooledMetrics = summary.metrics.filter(row => row.corpus === 'all').sort(byIntentStyle);
  const corpusMetrics = summary.metrics.filter(row => row.corpus !== 'all' && row.intent === 'all' && ['D', 'K1', 'K2'].includes(row.variant));
  const paired = summary.paired.filter(row => row.corpus === 'all').sort(byIntentStyle);
  const requests = summary.requestStats.filter(row => row.corpus === 'all' && row.intent === 'all');
  const interference = summary.interference.filter(row => row.corpus === 'all').sort(byIntentStyle);
  const lines = ['## Exploratory: label wording probe', '',
    `This is exploratory analysis of the existing ${summary.counts.cases} cases and ${summary.counts.decisions} labeled category decisions, using ${summary.counts.requests} recorded requests to \`${MODEL}\`. Existing gold labels remain provisional pending a blind audit. This provides no independent validation and does not retune the frozen template, model, runtime settings or cutoff.`, '',
    `Every operating-point result uses the exact frozen rule \`probability >= ${summary.cutoff}\`. The displayed shorthand \`${summary.roundedCutoff}\` would change ${summary.roundedCutoffDecisionDifferences} recorded decisions; it is never used to score this probe. Best cutoffs and every equally optimal interval below are descriptive in-sample diagnostics and are never applied.`, '',
    'D uses each original descriptive phrase; K1 and K2 use the recorded short labels. K1 `ragebait` has no definition. K2 `rage bait` explicitly has no definition under the probe override. Rdef adds the rage-bait definition: it is an extra replicate with the same label and definition as D rage, rather than a new wording. X adds exclusion wording for four intents only, so its pooled population differs; each paired X comparison uses the matching D subset.', '',
    table(['Intent (D)', 'K1', 'K2', 'X (where tested)'], raw.value.intents.map(item => [item.D, item.K1, item.K2, item.X])), '',
    'Pooled and per-intent category decisions across all three corpora:', '',
    table(metricHead, metricRows(pooledMetrics)), '',
    'Corpus-pooled descriptive and keyword results:', '',
    table(metricHead.map((item, index) => index === 1 ? 'Corpus' : item), metricRows(corpusMetrics, false)), '',
    'FH/MH mean false hides/missed hides at the frozen cutoff, counted per filter decision rather than per unique post. AUC is — when a population has no positive or no negative gold examples. Interval brackets preserve endpoint inclusion; disconnected equally optimal components are joined by ∪. Rdef covers rage only; X covers its tested subset. These pooled rows should not be compared as if every variant had the same intent population.', '',
    'Paired differences against D on matching decisions (variant minus D). Positive ΔAUC favors the variant; positive Δerrors means more errors. McNemar p-values are recorded exact conditional two-sided binomial tests of per-decision correctness discordance, with no multiplicity adjustment. Multiple filter decisions on the same post may be dependent, so pooled tests are exploratory and do not establish a confirmatory independent-sample claim or a new winner.', '',
    table(['Variant vs D', 'Intent', 'n', 'ΔAUC', 'Δerrors', 'D correct / variant wrong', 'D wrong / variant correct', 'Discordant', 'Exact McNemar p', 'Decision flips'],
      paired.map(row => [row.variant, row.intent, row.n, signed(row.aucDifference), signed(row.errorDifference, 0),
        row.mcnemar.dCorrectKWrong, row.mcnemar.dWrongKCorrect, row.mcnemar.discordant, pValue(row.mcnemar.pValue), row.flips])), '',
    `The [full K1/K2-versus-D flip file](data/${FLIPS}) contains ${flips.value.rows.length} decision flips, including post text, gold, actual labels, probabilities and correctness on both sides. [Summary](data/${SUMMARY}) and [raw requests](data/${RAW}) retain the full per-corpus and per-intent evidence.`, '',
    'Request cost by variant and mode (pooled across intents and corpora):', '',
    table(['Variant', 'Mode', 'Requests', 'Median wall ms', 'Median input tokens', 'Mean input tokens', 'Input tokens min–max'],
      requests.map(row => [row.variant, row.mode, row.n, number(row.medianMs, 2), number(row.medianInputTokens, 1),
        number(row.meanInputTokens, 2), `${row.minInputTokens}–${row.maxInputTokens}`])), '',
    'Latency is exploratory: a shuffled one-pass workload, without repeated stable timing cells. Label token differences are recorded request input-token counts, not a benchmark of steady-state speed or a production latency claim.', '',
    'Single-versus-multi interference on matching category decisions:', '',
    table(['Style', 'Intent', 'n', 'Median absolute probability Δ', 'Worst absolute probability Δ', 'Frozen-cutoff flips'],
      interference.map(row => [row.style, row.intent, row.n, number(row.medianAbsDelta, 6), number(row.worstAbsDelta, 6), row.flips])), '',
    `Evidence SHA-256: raw \`${raw.sha256}\`; flips \`${flips.sha256}\`. Frozen selection SHA-256: \`${summary.model.selectionSha256}\`; artifact identity hash: \`${summary.model.identityHash}\`. Existing discovery, validation, performance and selection evidence was recorded unchanged. This renderer only checks saved bindings and renders stored metrics; it performs no inference, scoring, fitting or selection.`, '',
  ];
  return { markdown: lines.join('\n'), hasResults: true, summary, flips: flips.value.rows.length };
}
