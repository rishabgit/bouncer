import { isDeepStrictEqual as same } from 'node:util';
import { questions } from './templates.mjs';
import { assertNoTruncation } from './runtime.mjs';
import { decisionMetrics, optimalCutoff } from './wording-metrics.mjs';

const insist = (condition, message) => { if (!condition) throw new Error(message); };
const median = values => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length ? s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 : null; };
export function capacityLabels(corpus) {
  return corpus.intents.map(intent => {
    const keep = intent.rubric.match(/\bKeep\b[^.!?]*(?:[.!?]|$)/)?.[0].trim();
    insist(keep, `No Keep sentence for ${intent.id}`);
    return { intentId: intent.id, ...intent.labels,
      sentence: `${intent.labels.guided.replace(/[.!?]\s*$/, '')}. ${keep}`, rubric: intent.rubric };
  });
}

export function capacityFreshPlan(corpus, styles, templateId, seed = 0x0cab2026) {
  insist(new Set(styles).size === styles.length && styles.length > 0, 'Fresh styles must be unique');
  const labels = capacityLabels(corpus), requests = [];
  for (const post of corpus.posts) for (const style of styles) {
    insist(labels.every(i => typeof i[style] === 'string'), `Unknown capacity style ${style}`);
    for (const intent of labels) {
      const values = [intent[style]];
      requests.push({ mode: 'single', style, postId: post.id, intentIds: [intent.intentId], labels: values, questions: questions(values, templateId) });
    }
    const values = labels.map(i => i[style]);
    requests.push({ mode: 'six-filter', style, postId: post.id, intentIds: labels.map(i => i.intentId), labels: values, questions: questions(values, templateId) });
  }
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
  for (let n = requests.length - 1; n > 0; n--) { const k = Math.floor(random() * (n + 1)); [requests[n], requests[k]] = [requests[k], requests[n]]; }
  return requests.map((request, index) => ({ index, ...request }));
}

function groupMetric(rows, cutoff) {
  const eligible = rows.filter(r => !r.ambiguous), near = eligible.filter(r => r.kind === 'near-miss' && !r.gold);
  const own = near.filter(r => r.intentId === r.authoredFor), subtle = eligible.filter(r => r.kind === 'subtle-positive' && r.gold);
  return { ...decisionMetrics(eligible, cutoff), optimal: optimalCutoff(eligible), ambiguousExcluded: rows.length - eligible.length,
    nearMissFalseHides: near.filter(r => r.probability >= cutoff).length, nearMissDecisions: near.length,
    ownNearMissFalseHides: own.filter(r => r.probability >= cutoff).length, ownNearMissDecisions: own.length,
    missedSubtlePositives: subtle.filter(r => r.probability < cutoff).length, subtlePositiveDecisions: subtle.length };
}

/** Same fresh-corpus populations as guidance, with arbitrary frozen styles/cutoff. */
export function analyzeCapacityFresh(corpus, requests, styles, templateId, cutoff) {
  const expected = new Map(capacityFreshPlan(corpus, styles, templateId).map(({ index, ...r }) => [JSON.stringify([r.mode, r.style, r.postId, r.intentIds]), r]));
  const posts = new Map(corpus.posts.map(p => [p.id, p])), seen = new Set(), rows = [];
  for (const request of requests) {
    const key = JSON.stringify([request.mode, request.style, request.postId, request.intentIds]), spec = expected.get(key);
    insist(spec && !seen.has(key), 'Unplanned or duplicate capacity request'); seen.add(key);
    for (const [name, value] of Object.entries(spec)) insist(same(request[name], value), `Capacity request ${name} differs`);
    assertNoTruncation(request, 4096);
    insist(request.probabilities?.length === request.intentIds.length && request.probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1), 'Invalid capacity probabilities');
    const post = posts.get(request.postId);
    request.intentIds.forEach((intentId, i) => rows.push({ mode: request.mode, style: request.style, postId: post.id, intentId,
      gold: post.gold[intentId], ambiguous: post.ambiguousFor.includes(intentId), authoredFor: post.authoredFor, kind: post.kind,
      probability: request.probabilities[i], label: request.labels[i] }));
  }
  insist(seen.size === expected.size, 'Incomplete capacity fresh matrix');
  const single = new Map(rows.filter(r => r.mode === 'single').map(r => [JSON.stringify([r.style, r.postId, r.intentId]), r]));
  const metrics = [], requestStats = [], interference = [], interferenceFlips = [], bounced = [];
  for (const style of styles) for (const intentId of ['all', ...corpus.intents.map(i => i.id)]) {
    const matches = r => r.style === style && (intentId === 'all' || r.intentId === intentId);
    for (const mode of ['single', 'six-filter']) metrics.push({ mode, style, intentId, ...groupMetric(rows.filter(r => r.mode === mode && matches(r)), cutoff) });
    const positives = rows.filter(r => r.mode === 'single' && matches(r) && r.intentId === r.authoredFor && r.gold);
    const failures = positives.filter(r => r.probability < cutoff).map(r => ({ postId: r.postId, text: posts.get(r.postId).text, kind: r.kind, probability: r.probability, cutoff, label: r.label }));
    bounced.push({ style, intentId, n: positives.length, caught: positives.length - failures.length, missed: failures.length,
      subtleMissed: failures.filter(r => r.kind === 'subtle-positive').length, failures });
    const comparisons = rows.filter(r => r.mode === 'six-filter' && matches(r)).map(r => ({ ...r,
      singleProbability: single.get(JSON.stringify([style, r.postId, r.intentId])).probability }));
    for (const population of ['headline', 'allIncludingAmbiguous']) {
      const paired = comparisons.filter(r => population !== 'headline' || !r.ambiguous);
      const changes = paired.map(r => Math.abs(r.probability - r.singleProbability));
      interference.push({ style, intentId, population, n: paired.length, medianAbsDelta: median(changes), worstAbsDelta: Math.max(0, ...changes),
        flips: paired.filter(r => (r.probability >= cutoff) !== (r.singleProbability >= cutoff)).length });
    }
    if (intentId === 'all') for (const r of comparisons.filter(r => (r.probability >= cutoff) !== (r.singleProbability >= cutoff))) {
      interferenceFlips.push({ style, postId: r.postId, intentId: r.intentId, text: posts.get(r.postId).text,
        gold: r.gold, ambiguous: r.ambiguous, singleProbability: r.singleProbability, multiProbability: r.probability,
        singleCorrect: (r.singleProbability >= cutoff) === r.gold, multiCorrect: (r.probability >= cutoff) === r.gold });
    }
  }
  for (const style of styles) for (const mode of ['single', 'six-filter']) for (const intentId of mode === 'single' ? ['all', ...corpus.intents.map(i => i.id)] : ['all']) {
    const group = requests.filter(r => r.style === style && r.mode === mode && (intentId === 'all' || r.intentIds[0] === intentId));
    const tokens = group.map(r => r.usage.input_tokens);
    requestStats.push({ mode, style, intentId, n: group.length, medianMs: median(group.map(r => r.wallMs)), medianInputTokens: median(tokens),
      meanInputTokens: tokens.reduce((a, b) => a + b, 0) / tokens.length, minInputTokens: Math.min(...tokens), maxInputTokens: Math.max(...tokens) });
  }
  return { styles, cutoff, metrics, requestStats, interference, interferenceFlips, bounced };
}

const check = (actual, reference, comparison) => ({ actual, reference, comparison, pass: comparison === '<' ? actual < reference : actual <= reference });
export function sentenceRecommendation(matrix) {
  const metric = style => matrix.metrics.find(r => r.mode === 'single' && r.intentId === 'all' && r.style === style);
  const guided = metric('guided'), sentence = metric('sentence'); insist(guided && sentence, 'Missing sentence/guided comparison');
  const checks = { errors: check(sentence.errors, guided.errors, '<'), nearMissFalseHides: check(sentence.nearMissFalseHides, guided.nearMissFalseHides, '<=') };
  return { checks, supported: Object.values(checks).every(c => c.pass) };
}

export function capacityProductRule(guidedErrors, validation, warm10MedianMs) {
  insist(Number.isSafeInteger(guidedErrors) && guidedErrors >= 0 && Number.isFinite(warm10MedianMs) && warm10MedianMs > 0,
    'Complete guided quality and measured warm latency are required');
  insist(validation.length === 2 && new Set(validation.map(v => v.corpus)).size === 2
    && ['isolation', 'migration'].every(name => validation.some(v => v.corpus === name && typeof v.pass === 'boolean')), 'Both original corpus gate receipts are required');
  const checks = { freshGuidedErrors: check(guidedErrors, 33, '<='), originalValidation: { pass: validation.every(v => v.pass) }, warm10MedianMs: check(warm10MedianMs, 250, '<=') };
  return { checks, worthSwitching: Object.values(checks).every(c => c.pass) };
}
