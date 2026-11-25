import { isDeepStrictEqual } from 'node:util';
import { WORDINGS, toneQuestion, toneTemplateHash } from './tone-templates.mjs';
import {
  CUTOFF, CONTENT_FREE, ownWords, stripLeadingMentions, transformState,
  validatePolicy, applyPolicy, summarizeRows, evaluateGates,
} from './tone-label-metrics.mjs';

const insist = (condition, message) => { if (!condition) throw new TypeError(message); };
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), half = sorted.length >> 1;
  return sorted.length ? sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2 : null;
};
const basePolicy = () => ({ template: 'T0', stateTransform: 'none', calibration: 'none', shortRule: null, cutoff: CUTOFF });
const rude = row => row.intentId === 'excessive-rudeness' || row.group === 'excessive-rudeness';
const lowContent = row => row.subtype === 'low-content' || ownWords(row.text) === 0;
const shortRude = row => row.subtype === 'short-rude' || (rude(row) && row.gold === true && ownWords(row.text) <= 5);
export const HANDLE_VARIANTS = Object.freeze([
  '@mira_k', '@toastgremlin', '@vrkzln', '@user48213', '@prathvesh_r', '@dev_tom', '@lunafromcalc', '@qqzx_09', '',
]);

/** Discovery experiments have independent knobs; selection never changes production. */
export function discoveryPolicies() {
  return [
    { id: 'P0', ...basePolicy() },
    ...['T1', 'T2', 'T3', 'T4'].map((template, index) => ({ id: `P${index + 1}`, ...basePolicy(), template, optimize: true })),
    { id: 'P5', ...basePolicy(), calibration: 'content-free', optimize: true },
    { id: 'P6', ...basePolicy(), stateTransform: 'strip-leading-mentions' },
  ];
}

function inputs({ phase, corpus, rows, wordings, policies }) {
  insist(['discovery', 'holdout'].includes(phase), 'Unknown tone study phase');
  insist(corpus && typeof corpus === 'object', 'A tone corpus is required');
  if (corpus.split !== undefined) insist(corpus.split === phase, 'Tone corpus split differs from phase');
  insist(Array.isArray(rows) && rows.length > 0, 'Tone decision rows are required');
  const keys = new Set();
  for (const row of rows) {
    insist(row && typeof row.key === 'string' && !keys.has(row.key), 'Duplicate or missing tone row key');
    keys.add(row.key);
    insist(typeof row.text === 'string' && typeof row.postId === 'string' && typeof row.labelKey === 'string'
      && typeof row.label === 'string' && row.label.length > 0, 'Invalid tone decision row');
    insist(typeof row.gold === 'boolean' && typeof row.ambiguous === 'boolean', 'Tone rows require explicit gold and ambiguity');
  }
  const ids = wordings ?? Object.keys(WORDINGS);
  insist(Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length, 'Unique wording IDs are required');
  insist(ids.every(id => Object.hasOwn(WORDINGS, id)), 'Unknown tone wording');
  insist(phase !== 'discovery' || ids.length === Object.keys(WORDINGS).length, 'Discovery requires every wording');
  const descriptors = policies ?? discoveryPolicies();
  insist(Array.isArray(descriptors) && descriptors.length > 0, 'Tone policies are required');
  const policyIds = new Set();
  const normalized = descriptors.map(descriptor => {
    const { id, optimize, ...policy } = descriptor;
    insist(typeof id === 'string' && id.length > 0 && !policyIds.has(id), 'Duplicate or missing policy ID');
    policyIds.add(id);
    insist(optimize === undefined || typeof optimize === 'boolean', 'Policy optimize must be boolean');
    insist(phase !== 'holdout' || !optimize, 'Holdout policies must be frozen');
    validatePolicy(policy);
    insist(!optimize || policy.shortRule === null, 'Short-rule policies require a frozen cutoff');
    return { id, policy, optimize: optimize === true };
  });
  return { ids, normalized };
}

/**
 * Pure, deterministic request registration. Every question is stored once and
 * every distinct (question,state) pair is sent once, even across diagnostics.
 * References retain all scoring memberships when request deduplication occurs.
 */
export function buildTonePlan({ phase, corpus, rows, wordings, policies }) {
  const { ids, normalized } = inputs({ phase, corpus, rows, wordings, policies });
  const questions = {}, requests = [], questionIds = new Map(), requestIds = new Map();
  const refs = { baseline: {}, wordings: {}, policies: {}, priors: {}, handles: [], twins: [] };
  const register = (label, template, state, postId, labelKey) => {
    const question = toneQuestion(label, template), questionIdentity = JSON.stringify(question);
    let questionKey = questionIds.get(questionIdentity);
    if (questionKey === undefined) {
      questionKey = `q${questionIds.size}`;
      questionIds.set(questionIdentity, questionKey);
      questions[questionKey] = question;
    }
    const identity = JSON.stringify([questionKey, state]);
    let index = requestIds.get(identity);
    if (index === undefined) {
      index = requests.length;
      requestIds.set(identity, index);
      requests.push({ index, questionKey, postId, labelKey, state });
    }
    return index;
  };
  const prior = (label, template) => {
    const key = JSON.stringify([template, label]);
    if (!Object.hasOwn(refs.priors, key)) refs.priors[key] = CONTENT_FREE.map((state, index) =>
      register(label, template, state, `content-free-${index}`, label));
    return key;
  };
  // T0 for all decisions is the common source for baseline and the short grid.
  for (const row of rows) refs.baseline[row.key] = register(row.label, 'T0', row.text, row.postId, row.labelKey);
  const diagnosticIds = [...new Set([...ids, 'W0', 'W5'])];
  const rudeRows = rows.filter(rude);
  for (const id of diagnosticIds) {
    refs.wordings[id] = {};
    for (const row of rudeRows) refs.wordings[id][row.key] = register(WORDINGS[id], 'T0', row.text, row.postId, id);
  }
  // Priors cover each intent plus every tested wording, independently of whether
  // the calibrated candidate ultimately wins selection.
  for (const row of rows) prior(row.label, 'T0');
  for (const id of diagnosticIds) prior(WORDINGS[id], 'T0');
  for (const { id, policy } of normalized) {
    refs.policies[id] = {};
    for (const row of rows) {
      const transformed = transformState(row.text, policy.stateTransform);
      refs.policies[id][row.key] = transformed.unclassified ? { index: null, unclassified: true } : {
        index: register(row.label, policy.template, transformed.text, row.postId, row.labelKey), unclassified: false,
      };
      if (policy.calibration === 'content-free') prior(row.label, policy.template);
    }
  }
  const posts = new Map();
  for (const row of rudeRows) {
    if (!posts.has(row.postId)) posts.set(row.postId, row);
  }
  for (const row of posts.values()) {
    if (!lowContent(row) && !shortRude(row)) continue;
    const body = stripLeadingMentions(row.text);
    const handles = HANDLE_VARIANTS.map(handle => {
      const state = handle ? (body ? `${handle} ${body}` : handle) : body;
      return { handle: handle || null, state, scores: Object.fromEntries(['W0', 'W5'].map(id =>
        [id, register(WORDINGS[id], 'T0', state, row.postId, id)])) };
    });
    refs.handles.push({ postId: row.postId, text: row.text, subtype: row.subtype ?? 'unspecified',
      lowContent: lowContent(row), shortRude: shortRude(row), handles });
  }
  for (const twin of corpus.twins ?? []) {
    const source = posts.get(twin.sourceId);
    insist(source && typeof twin.id === 'string' && typeof twin.text === 'string', 'Twin source or text is invalid');
    refs.twins.push({ id: twin.id, sourceId: twin.sourceId, text: twin.text, sourceText: source.text,
      scores: Object.fromEntries(['W0', 'W5'].map(id => [id, {
        source: refs.wordings[id][source.key], twin: register(WORDINGS[id], 'T0', twin.text, twin.id, id),
      }])) });
  }
  // Frozen holdout comparisons cross every selected wording with every policy.
  // Append these registrations so discovery scheduling and its evidence remain
  // byte-for-byte compatible, and keep W0 even for callers selecting other IDs.
  if (phase === 'holdout') {
    refs.wordingPolicies = {};
    const wordingIds = [...new Set([...ids, 'W0'])];
    const toneRows = rudeRows.filter(row => row.corpus === 'tone-holdout');
    for (const { id, policy } of normalized) {
      refs.wordingPolicies[id] = {};
      for (const wordingId of wordingIds) {
        const label = WORDINGS[wordingId];
        refs.wordingPolicies[id][wordingId] = {};
        for (const row of toneRows) {
          const transformed = transformState(row.text, policy.stateTransform);
          refs.wordingPolicies[id][wordingId][row.key] = transformed.unclassified ? { index: null, unclassified: true } : {
            index: register(label, policy.template, transformed.text, row.postId, wordingId), unclassified: false,
          };
        }
        if (policy.calibration === 'content-free') prior(label, policy.template);
      }
    }
  }
  return { schemaVersion: 1, phase, templateHash: toneTemplateHash(), wordingIds: ids,
    policies: normalized, questions, requests, refs };
}

function validateRecorded(plan, requests) {
  insist(Array.isArray(requests) && requests.length === plan.requests.length, 'Incomplete or extra recorded tone requests');
  const recorded = Array(requests.length), seen = new Set();
  for (const request of requests) {
    insist(request && Number.isInteger(request.index) && request.index >= 0 && request.index < requests.length
      && !seen.has(request.index), 'Invalid or duplicate recorded tone request index');
    seen.add(request.index);
    const expected = plan.requests[request.index];
    for (const field of ['questionKey', 'postId', 'labelKey']) {
      insist(request[field] === expected[field], `Recorded tone request ${field} differs from plan`);
    }
    if (Object.hasOwn(request, 'state')) insist(request.state === expected.state, 'Recorded tone state differs from plan');
    insist(typeof request.probability === 'number' && Number.isFinite(request.probability)
      && request.probability >= 0 && request.probability <= 1, 'Invalid recorded tone probability');
    insist(typeof request.wallMs === 'number' && Number.isFinite(request.wallMs) && request.wallMs >= 0,
      'Invalid recorded tone latency');
    insist(Number.isInteger(request.inputTokens) && request.inputTokens >= 0, 'Invalid recorded tone input tokens');
    recorded[request.index] = request;
  }
  return recorded;
}

function bucketMetrics(rows, field, options) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[field] ?? 'unknown';
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, summarizeRows(values, options)]));
}

function scopedMetrics(rows, phase, options) {
  const metrics = summarizeRows(rows, options);
  const byCorpus = bucketMetrics(rows, 'corpus', options), byGroup = bucketMetrics(rows, 'group', options);
  const toneGroups = bucketMetrics(rows.filter(row => row.corpus === `tone-${phase}`), 'group', options);
  const scopes = {
    all: metrics,
    ...Object.fromEntries(Object.entries(byCorpus).map(([corpus, values]) => [`corpus:${corpus}`, values])),
    ...Object.fromEntries(Object.entries(toneGroups)
      .filter(([group]) => group === 'excessive-rudeness' || group.startsWith('fresh-') || group.startsWith('orig-'))
      .map(([group, values]) => [`group:${group}`, values])),
  };
  return { ...metrics, byCorpus, byGroup, scopes };
}

const ownerRow = (row, phase) => row.corpus === `tone-${phase}` && rude(row) && row.label === WORDINGS.W0;
const decisionSnapshot = row => ({ probability: row.probability, cutoff: row.cutoff,
  hidden: row.hidden, unclassified: row.unclassified });
const ownerDetails = row => ({ postId: row.postId, text: row.text, subtype: row.subtype ?? 'unspecified',
  gold: row.gold, ambiguous: row.ambiguous });

function ownerFlips(baseline, candidate, phase) {
  const baselineByKey = new Map(baseline.map(row => [row.key, row]));
  return candidate.filter(row => ownerRow(row, phase)
    && row.hidden !== baselineByKey.get(row.key).hidden).map(row => ({
    ...ownerDetails(row), baseline: decisionSnapshot(baselineByKey.get(row.key)), candidate: decisionSnapshot(row),
    effect: row.hidden === row.gold ? 'fixed' : 'broke',
  }));
}

function rank(values) {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = Array(values.length);
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value) end++;
    for (let index = start; index < end; index++) ranks[ordered[index].index] = (start + end - 1) / 2;
    start = end;
  }
  return ranks;
}
function spearman(left, right) {
  if (left.length < 2) return null;
  const a = rank(left), b = rank(right);
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0, denominatorA = 0, denominatorB = 0;
  for (let index = 0; index < a.length; index++) {
    const da = a[index] - meanA, db = b[index] - meanB;
    numerator += da * db; denominatorA += da * da; denominatorB += db * db;
  }
  return denominatorA && denominatorB ? numerator / Math.sqrt(denominatorA * denominatorB) : null;
}

// Grid cells need only count mistakes. Avoid recomputing AUC and optimal
// cutoffs for every candidate and each of its corpus/group slices.
const GRID_METRICS = ['errors', 'falseHides', 'missedHides', 'lowContentFP', 'shortPositiveFN', 'missedShortRude'];
function gridCounts(rows) {
  const counts = { n: 0, errors: 0, falseHides: 0, missedHides: 0,
    lowContentFP: 0, shortPositiveFN: 0, missedShortRude: 0 };
  for (const row of rows) {
    if (row.ambiguous) continue;
    counts.n++;
    if (row.hidden && !row.gold) {
      counts.errors++; counts.falseHides++;
      if (lowContent(row)) counts.lowContentFP++;
    } else if (!row.hidden && row.gold) {
      counts.errors++; counts.missedHides++;
      if (ownWords(row.text) <= 5) counts.shortPositiveFN++;
      if (shortRude(row)) counts.missedShortRude++;
    }
  }
  return counts;
}
function gridBuckets(rows, field) {
  const buckets = new Map();
  for (const row of rows) {
    const key = row[field] ?? 'unknown';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => [key, gridCounts(values)]));
}
function compactGridCounts(candidates) {
  return { n: candidates[0].n,
    ...Object.fromEntries(GRID_METRICS.map(metric => [metric, candidates.map(candidate => candidate[metric])])) };
}
function compactGridBuckets(candidates, field) {
  return Object.fromEntries(Object.keys(candidates[0][field]).map(key =>
    [key, compactGridCounts(candidates.map(candidate => candidate[field][key]))]));
}

const plateauMidpoint = plateau => plateau.lower + plateau.width / 2;

function shortPlateau(rows, maxOwnWords, cutoffs, candidates) {
  const minimumErrors = Math.min(...candidates.map(candidate => candidate.errors));
  const first = cutoffs[0], last = cutoffs.at(-1), regions = [];
  const ordered = rows.filter(row => !row.ambiguous && ownWords(row.text) <= maxOwnWords
    && row.probability >= first && row.probability < last).sort((a, b) => a.probability - b.probability);
  let errors = candidates[0].errors, lower = first, lowerInclusive = true;
  const consider = upper => {
    if (errors !== minimumErrors) return;
    const previous = regions.at(-1);
    if (previous && previous.upper === lower) previous.upper = upper;
    else regions.push({ lower, upper, lowerInclusive, upperInclusive: true });
  };
  // Sweep actual decision changes, including changes between sampled cutoffs.
  // Under p >= cutoff, a score stays hidden at its boundary and flips after it.
  for (let start = 0; start < ordered.length;) {
    const score = ordered[start].probability;
    consider(score);
    let end = start;
    while (end < ordered.length && ordered[end].probability === score) {
      errors += ordered[end].gold ? 1 : -1;
      end++;
    }
    lower = score; lowerInclusive = false; start = end;
  }
  consider(last);
  const plateaus = regions.map(region => {
    const points = cutoffs.filter(cutoff => (region.lowerInclusive ? cutoff >= region.lower : cutoff > region.lower)
      && cutoff <= region.upper).length;
    const width = region.upper - region.lower;
    // An open interval with no representable midpoint has only its upper point.
    if (!region.lowerInclusive && region.lower + width / 2 === region.lower)
      return { ...region, lower: region.upper, lowerInclusive: true, width: 0, points };
    return { ...region, width, points };
  }).filter(plateau => plateau.points > 0);
  // Keep selection tied to the declared grid, then choose a genuine continuous
  // plateau containing a minimum-error grid point. Never bridge an error change.
  plateaus.sort((a, b) => b.width - a.width || Math.abs(plateauMidpoint(a) - .5) - Math.abs(plateauMidpoint(b) - .5)
    || plateauMidpoint(a) - plateauMidpoint(b));
  insist(plateaus.length > 0, 'Missing optimal short-rule grid plateau');
  return { plateau: plateaus[0], cutoff: plateauMidpoint(plateaus[0]), minimumErrors };
}

function shortGrid(rows) {
  const cutoffs = Array.from({ length: 66 }, (_, index) => (index + 30) / 100);
  const table = [], bestByMaxOwnWords = [];
  const baseline = rows.map(row => applyPolicy(row, basePolicy()));
  const ownerRows = baseline.filter(row => ownerRow(row, 'discovery'));
  const ownerIndices = new Map(ownerRows.map((row, index) => [row.key, index]));
  const ownerDecisions = ownerRows.map(row => ({ ...ownerDetails(row), baseline: decisionSnapshot(row) }));
  const compactOwnerFlips = applied => applied.filter(row => ownerIndices.has(row.key)
    && row.hidden !== ownerDecisions[ownerIndices.get(row.key)].baseline.hidden).map(row => ({
    decision: ownerIndices.get(row.key), candidate: decisionSnapshot(row), effect: row.hidden === row.gold ? 'fixed' : 'broke',
  }));
  for (let maxOwnWords = 0; maxOwnWords <= 5; maxOwnWords++) {
    const candidates = cutoffs.map(cutoff => {
      const policy = { ...basePolicy(), shortRule: { maxOwnWords, cutoff } };
      const applied = rows.map(row => applyPolicy(row, policy));
      return { cutoff, ...gridCounts(applied), byCorpus: gridBuckets(applied, 'corpus'), byGroup: gridBuckets(applied, 'group'),
        ownerFlips: compactOwnerFlips(applied) };
    });
    const { plateau, cutoff, minimumErrors } = shortPlateau(rows, maxOwnWords, cutoffs, candidates);
    const policy = { ...basePolicy(), shortRule: { maxOwnWords, cutoff } };
    const applied = rows.map(row => applyPolicy(row, policy));
    const metrics = summarizeRows(applied);
    insist(metrics.errors === minimumErrors, 'Short-rule midpoint differs from minimum grid errors');
    bestByMaxOwnWords.push({ maxOwnWords, cutoff, plateau, policy,
      ...metrics, byCorpus: bucketMetrics(applied, 'corpus'), byGroup: bucketMetrics(applied, 'group'),
      ownerFlips: ownerFlips(baseline, applied, 'discovery') });
    table.push({ maxOwnWords, ...compactGridCounts(candidates),
      byCorpus: compactGridBuckets(candidates, 'byCorpus'), byGroup: compactGridBuckets(candidates, 'byGroup'),
      ownerFlips: candidates.map(candidate => candidate.ownerFlips) });
  }
  const ordered = [...bestByMaxOwnWords].sort((a, b) => a.errors - b.errors || b.plateau.width - a.plateau.width
    || Math.abs(a.cutoff - 0.5) - Math.abs(b.cutoff - 0.5) || a.maxOwnWords - b.maxOwnWords || a.cutoff - b.cutoff);
  return { cutoffs, table, ownerDecisions, bestByMaxOwnWords, best: ordered[0],
    selection: 'Lowest grid errors; widest constant-error interval containing an optimal grid point; midpoint closest to 0.5; lowest maxOwnWords, then lower midpoint.' };
}

/** Score completed evidence only. Rebuilding the plan catches mutated receipts. */
export function analyzeTone({ phase, corpus, rows, plan, requests, policies, wordings, gates = [] }) {
  const expected = buildTonePlan({ phase, corpus, rows, policies, wordings });
  insist(isDeepStrictEqual(plan, expected), 'Tone plan differs from deterministic inputs');
  const recorded = validateRecorded(plan, requests);
  // Holdout counts use only registered thresholds, with no in-sample fitting.
  const metricOptions = { includeOptimal: phase === 'discovery' };
  const score = index => recorded[index].probability;
  const rawBaseline = rows.map(row => ({ ...row, probability: score(plan.refs.baseline[row.key]) }));
  const priorValues = (label, template) => plan.refs.priors[JSON.stringify([template, label])].map(score);
  const wordingMetrics = plan.wordingIds.map(id => {
    const applied = rows.filter(rude).map(row => applyPolicy({ ...row, label: WORDINGS[id],
      probability: score(plan.refs.wordings[id][row.key]) }, basePolicy()));
    return { id, label: WORDINGS[id], ...scopedMetrics(applied, phase, metricOptions),
      medianMs: median(rows.filter(rude).map(row => recorded[plan.refs.wordings[id][row.key]].wallMs)) };
  });
  const evaluatedPolicies = [], appliedByPolicy = new Map();
  for (const descriptor of plan.policies) {
    const { id } = descriptor;
    let policy = { ...descriptor.policy };
    const raw = rows.map(row => {
      const ref = plan.refs.policies[id][row.key];
      return { ...row, probability: ref.index === null ? 0 : score(ref.index), unclassified: ref.unclassified };
    });
    const apply = () => raw.map(row => applyPolicy(row, policy,
      policy.calibration === 'content-free' ? priorValues(row.label, policy.template) : []));
    let applied = apply();
    if (descriptor.optimize) {
      policy = { ...policy, cutoff: summarizeRows(applied).optimal.cutoff };
      applied = apply();
    }
    appliedByPolicy.set(id, applied);
    const indices = [...new Set(Object.values(plan.refs.policies[id]).map(ref => ref.index).filter(index => index !== null))];
    evaluatedPolicies.push({ id, policy, optimizedOnDiscovery: descriptor.optimize,
      ...scopedMetrics(applied, phase, metricOptions),
      medianMs: median(indices.map(index => recorded[index].wallMs)) });
  }
  const baseline = appliedByPolicy.get('P0');
  if (evaluatedPolicies.some(policy => policy.id !== 'P0')) insist(baseline, 'Owner flips require P0 baseline metrics');
  for (const evaluated of evaluatedPolicies) {
    if (evaluated.id !== 'P0') evaluated.ownerFlips = ownerFlips(baseline, appliedByPolicy.get(evaluated.id), phase);
  }
  const wordingPolicies = phase === 'holdout' ? evaluatedPolicies.flatMap(({ id: policyId, policy }) =>
    Object.entries(plan.refs.wordingPolicies[policyId]).map(([wordingId, refs]) => {
      const label = WORDINGS[wordingId];
      const applied = rows.filter(row => Object.hasOwn(refs, row.key)).map(row => {
        const ref = refs[row.key];
        return applyPolicy({ ...row, label, probability: ref.index === null ? 0 : score(ref.index), unclassified: ref.unclassified },
          policy, policy.calibration === 'content-free' ? priorValues(label, policy.template) : []);
      });
      return { wordingId, policyId, policy, ...scopedMetrics(applied, phase, metricOptions) };
    })) : [];
  const subtypeDistributions = ['W0', 'W5'].map(id => {
    const buckets = new Map();
    for (const row of rows.filter(rude)) {
      if (!buckets.has(row.subtype)) buckets.set(row.subtype, []);
      buckets.get(row.subtype).push(score(plan.refs.wordings[id][row.key]));
    }
    return { wording: id, subtypes: [...buckets].map(([subtype, values]) => ({ subtype, n: values.length,
      median: median(values), shareAtOrAboveCutoff: values.filter(value => value >= CUTOFF).length / values.length })) };
  });
  const handleSensitivity = plan.refs.handles.map(post => ({ postId: post.postId, text: post.text, subtype: post.subtype,
    lowContent: post.lowContent, shortRude: post.shortRude,
    wordings: ['W0', 'W5'].map(id => {
      const variants = post.handles.map(handle => ({ handle: handle.handle, text: handle.state, probability: score(handle.scores[id]) }));
      const values = variants.map(variant => variant.probability), mean = values.reduce((a, b) => a + b, 0) / values.length;
      const aboveCutoff = values.filter(value => value >= CUTOFF).length;
      return { id, min: Math.min(...values), max: Math.max(...values),
        stddev: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
        aboveCutoff, crossesCutoff: aboveCutoff > 0 && aboveCutoff < values.length,
        crossings: aboveCutoff * (values.length - aboveCutoff), variants };
    }) }));
  const twins = ['W0', 'W5'].map(id => {
    const comparisons = plan.refs.twins.map(twin => ({ id: twin.id, sourceId: twin.sourceId, sourceText: twin.sourceText, text: twin.text,
      sourceProbability: score(twin.scores[id].source), twinProbability: score(twin.scores[id].twin),
      delta: score(twin.scores[id].source) - score(twin.scores[id].twin) }));
    return { wording: id, n: comparisons.length, medianSourceMinusTwin: median(comparisons.map(pair => pair.delta)), comparisons };
  });
  const contentFreePriors = Object.entries(plan.refs.priors).map(([key, indices]) => {
    const [template, label] = JSON.parse(key), values = indices.map(score);
    const intentIds = [...new Set(rows.filter(row => row.label === label).map(row => row.intentId))];
    const wordingIds = Object.keys(plan.refs.wordings).filter(id => WORDINGS[id] === label);
    const labelKeys = [...new Set([...rows.filter(row => row.label === label).map(row => row.labelKey), ...wordingIds])];
    return { template, label, labelKeys, intentIds, wordingIds, states: [...CONTENT_FREE], probabilities: values, median: median(values) };
  });
  const diagnostics = { subtypeDistributions, handleSensitivity, twins, contentFreePriors };
  if (phase === 'discovery') {
    const baseline = rawBaseline;
    diagnostics.templateSensitivity = ['T0', 'T1', 'T2', 'T3', 'T4'].map(template => {
      const descriptor = plan.policies.find(candidate => candidate.policy.template === template
        && candidate.policy.stateTransform === 'none' && candidate.policy.calibration === 'none');
      insist(descriptor, `Discovery requires ${template} template coverage`);
      const applied = appliedByPolicy.get(descriptor.id), metrics = summarizeRows(applied);
      return { template, n: applied.length, aucN: metrics.n, auc: metrics.auc,
        spearmanVsT0: spearman(baseline.map(row => row.probability), applied.map(row => row.probability)) };
    });
  }
  return { schemaVersion: 1, phase, cutoff: CUTOFF,
    counts: { decisions: rows.length, scoredDecisions: rows.filter(row => !row.ambiguous).length,
      ambiguous: rows.filter(row => row.ambiguous).length, questions: Object.keys(plan.questions).length, requests: requests.length },
    wordings: wordingMetrics, policies: evaluatedPolicies, ...(phase === 'holdout' ? { wordingPolicies } : {}),
    shortRuleGrid: phase === 'discovery' ? shortGrid(rawBaseline) : null,
    diagnostics, gates: evaluateGates(gates, Object.fromEntries([...evaluatedPolicies, ...wordingMetrics].map(metric => [metric.id, metric]))) };
}
