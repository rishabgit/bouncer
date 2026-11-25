import { auc, optimalCutoff } from './wording-metrics.mjs';
import { TONE_TEMPLATES } from './tone-templates.mjs';

export const CUTOFF = 0.290813258948728;
export const CONTENT_FREE = Object.freeze(['.', '…', '-', 'N/A', '?']);

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function exactKeys(value, expected, name) {
  object(value, name);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))
    || keys.some(key => !expected.includes(key))) {
    throw new TypeError(`${name} must have exactly: ${expected.join(', ')}`);
  }
}

function probability(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a finite number in [0,1]`);
  }
}

function textValue(value, name = 'text') {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
}

/** Count only whitespace-delimited tokens containing the author's letters or digits. */
export function ownWords(text) {
  textValue(text);
  return text.replace(/https?:\/\/\S+/giu, '').replace(/@\w+/gu, '')
    .split(/\s+/u).filter(token => /[\p{L}\p{N}]/u.test(token)).length;
}

export function stripLeadingMentions(text) {
  textValue(text);
  return text.trimStart().replace(/^(?:@\w+(?:\s+|$))+/u, '');
}

export function transformState(text, transform) {
  textValue(text);
  if (transform !== 'none' && transform !== 'strip-leading-mentions') {
    throw new TypeError(`Unknown state transform: ${String(transform)}`);
  }
  if (transform === 'none') return { text, unclassified: false };
  const transformed = stripLeadingMentions(text);
  return { text: transformed, unclassified: !/[\p{L}\p{N}]/u.test(transformed) };
}

const EPSILON = 1e-6;
const logit = value => {
  const clamped = Math.max(EPSILON, Math.min(1 - EPSILON, value));
  return Math.log(clamped / (1 - clamped));
};

/** Subtract the mean content-free log odds, using all five preregistered states. */
export function calibrateProbability(p, priors) {
  probability(p, 'probability');
  if (!Array.isArray(priors) || priors.length !== CONTENT_FREE.length) {
    throw new TypeError('Calibration requires exactly five content-free probabilities');
  }
  for (let index = 0; index < priors.length; index += 1) {
    probability(priors[index], `priors[${index}]`);
  }
  const offset = priors.reduce((sum, prior) => sum + logit(prior), 0) / priors.length;
  return 1 / (1 + Math.exp(-(logit(p) - offset)));
}

export function validatePolicy(policy) {
  exactKeys(policy, ['template', 'stateTransform', 'calibration', 'shortRule', 'cutoff'], 'policy');
  if (typeof policy.template !== 'string' || !Object.hasOwn(TONE_TEMPLATES, policy.template)) {
    throw new TypeError(`Unknown policy template: ${String(policy.template)}`);
  }
  if (!['none', 'strip-leading-mentions'].includes(policy.stateTransform)) {
    throw new TypeError(`Unknown state transform: ${String(policy.stateTransform)}`);
  }
  if (!['none', 'content-free'].includes(policy.calibration)) {
    throw new TypeError(`Unknown calibration: ${String(policy.calibration)}`);
  }
  probability(policy.cutoff, 'policy.cutoff');
  if (policy.shortRule !== null) {
    exactKeys(policy.shortRule, ['maxOwnWords', 'cutoff'], 'policy.shortRule');
    if (!Number.isSafeInteger(policy.shortRule.maxOwnWords) || policy.shortRule.maxOwnWords < 0) {
      throw new TypeError('policy.shortRule.maxOwnWords must be a nonnegative safe integer');
    }
    probability(policy.shortRule.cutoff, 'policy.shortRule.cutoff');
  }
  return policy;
}

/** Apply a frozen policy while retaining the original text for length decisions. */
export function applyPolicy(row, policy, priors = []) {
  object(row, 'row');
  textValue(row.text, 'row.text');
  probability(row.probability, 'row.probability');
  if (Object.hasOwn(row, 'unclassified') && typeof row.unclassified !== 'boolean') {
    throw new TypeError('row.unclassified must be boolean when provided');
  }
  validatePolicy(policy);
  const unclassified = Boolean(row.unclassified)
    || transformState(row.text, policy.stateTransform).unclassified;
  const adjusted = unclassified ? 0 : policy.calibration === 'content-free'
    ? calibrateProbability(row.probability, priors) : row.probability;
  const cutoff = policy.shortRule !== null && ownWords(row.text) <= policy.shortRule.maxOwnWords
    ? policy.shortRule.cutoff : policy.cutoff;
  return {
    ...row,
    rawProbability: row.probability,
    probability: adjusted,
    hidden: !unclassified && adjusted >= cutoff,
    unclassified,
  };
}

/** Score the actual policy decisions; ambiguous gold rows never enter scores. */
export function summarizeRows(rows, { includeOptimal = true } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const scored = [];
  let ambiguousExcluded = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    object(row, `rows[${index}]`);
    if (Object.hasOwn(row, 'ambiguous') && typeof row.ambiguous !== 'boolean') {
      throw new TypeError(`rows[${index}].ambiguous must be boolean when provided`);
    }
    if (row.ambiguous) {
      ambiguousExcluded += 1;
      continue;
    }
    if (typeof row.gold !== 'boolean' || typeof row.hidden !== 'boolean') {
      throw new TypeError(`rows[${index}] must have boolean gold and hidden`);
    }
    textValue(row.text, `rows[${index}].text`);
    probability(row.probability, `rows[${index}].probability`);
    if (Object.hasOwn(row, 'unclassified') && typeof row.unclassified !== 'boolean') {
      throw new TypeError(`rows[${index}].unclassified must be boolean when provided`);
    }
    scored.push(row);
  }

  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  let unclassified = 0;
  let lowContentFP = 0;
  let shortPositiveFN = 0;
  let missedShortRude = 0;
  const fpBySubtype = {};
  for (const row of scored) {
    confusion[row.hidden ? (row.gold ? 'tp' : 'fp') : (row.gold ? 'fn' : 'tn')] += 1;
    unclassified += Number(Boolean(row.unclassified));
    const length = ownWords(row.text);
    if (row.hidden && !row.gold) {
      // Explicit corpus subtypes and text-derived diagnostics both qualify.
      if (row.subtype === 'low-content' || length === 0) lowContentFP += 1;
      const subtype = typeof row.subtype === 'string' && row.subtype ? row.subtype : 'unspecified';
      Object.defineProperty(fpBySubtype, subtype, {
        value: (Object.hasOwn(fpBySubtype, subtype) ? fpBySubtype[subtype] : 0) + 1,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (!row.hidden && row.gold) {
      if (length <= 5) shortPositiveFN += 1;
      if (row.subtype === 'short-rude' || (row.intentId === 'excessive-rudeness' && length <= 5)) {
        missedShortRude += 1;
      }
    }
  }
  return {
    n: scored.length,
    positives: confusion.tp + confusion.fn,
    negatives: confusion.fp + confusion.tn,
    auc: auc(scored),
    falseHides: confusion.fp,
    missedHides: confusion.fn,
    FP: confusion.fp,
    FN: confusion.fn,
    errors: confusion.fp + confusion.fn,
    correct: confusion.tp + confusion.tn,
    confusion,
    ...(includeOptimal ? { optimal: policyOptimal(scored) } : {}),
    ambiguousExcluded,
    unclassified,
    lowContentFP,
    shortPositiveFN,
    missedShortRude,
    fpBySubtype,
  };
}

function policyOptimal(rows) {
  // Skipped states remain shown at every threshold, including zero.
  const fitted = optimalCutoff(rows.filter(row => !row.unclassified));
  const unavoidableMisses = rows.filter(row => row.unclassified && row.gold).length;
  return { ...fitted, errors: fitted.errors + unavoidableMisses, missedHides: fitted.missedHides + unavoidableMisses };
}

const GATE_METRICS = new Set([
  'errors', 'FP', 'FN', 'falseHides', 'missedHides', 'lowContentFP', 'shortPositiveFN', 'missedShortRude',
]);

function metricValue(metricsById, policyId, metric) {
  if (!Object.hasOwn(metricsById, policyId)) throw new TypeError(`Missing metrics for policy ${policyId}`);
  const metrics = metricsById[policyId];
  object(metrics, `Metrics for ${policyId}`);
  if (!Object.hasOwn(metrics, metric) || typeof metrics[metric] !== 'number'
    || !Number.isFinite(metrics[metric]) || metrics[metric] < 0) {
    throw new TypeError(`Missing or invalid ${metric} for policy ${policyId}`);
  }
  return metrics[metric];
}

/** Resolve preregistered count comparisons, rejecting malformed or absent evidence. */
export function evaluateGates(gates, metricsById) {
  if (!Array.isArray(gates)) throw new TypeError('gates must be an array');
  object(metricsById, 'metricsById');
  const checks = gates.map((gate, index) => {
    exactKeys(gate, ['name', 'metric', 'policy', 'comparator', 'reference', 'slack'], `gates[${index}]`);
    if (typeof gate.name !== 'string' || !gate.name.trim()
      || typeof gate.policy !== 'string' || !gate.policy.trim()) {
      throw new TypeError(`gates[${index}] requires nonempty name and policy`);
    }
    if (!GATE_METRICS.has(gate.metric)) throw new TypeError(`Unknown gate metric: ${String(gate.metric)}`);
    if (gate.comparator !== '<' && gate.comparator !== '<=') {
      throw new TypeError(`Unknown gate comparator: ${String(gate.comparator)}`);
    }
    if (typeof gate.slack !== 'number' || !Number.isFinite(gate.slack) || gate.slack < 0) {
      throw new TypeError('Gate slack must be finite and nonnegative');
    }
    const actual = metricValue(metricsById, gate.policy, gate.metric);
    let referenceValue;
    if (typeof gate.reference === 'string' && gate.reference.trim()) {
      referenceValue = metricValue(metricsById, gate.reference, gate.metric);
    } else if (typeof gate.reference === 'number' && Number.isFinite(gate.reference) && gate.reference >= 0) {
      referenceValue = gate.reference;
    } else throw new TypeError('Gate reference must be a policy ID or a finite nonnegative number');
    const limit = referenceValue + gate.slack;
    if (!Number.isFinite(limit)) throw new TypeError('Gate limit must be finite');
    return {
      ...gate,
      actual,
      referenceValue,
      limit,
      pass: gate.comparator === '<' ? actual < limit : actual <= limit,
    };
  });
  return { pass: checks.every(check => check.pass), checks };
}
