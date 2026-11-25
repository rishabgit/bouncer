// Exploratory per-decision metrics. These deliberately do not reuse the frozen
// evaluation's vector-level objective or its false-hide selection tiebreak.

function validateRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError(`rows[${index}] must be an object`);
    }
    if (typeof row.gold !== 'boolean') {
      throw new TypeError(`rows[${index}].gold must be boolean`);
    }
    validateProbability(row.probability, `rows[${index}].probability`);
  }
}

function validateProbability(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a finite number in [0,1]`);
  }
}

function aucValidated(rows) {
  const positives = rows.reduce((count, row) => count + Number(row.gold), 0);
  const negatives = rows.length - positives;
  if (positives === 0 || negatives === 0) return null;

  const ordered = [...rows].sort((left, right) => left.probability - right.probability);
  let negativesBelow = 0;
  let wins = 0;
  for (let start = 0; start < ordered.length;) {
    let end = start;
    let tiedPositives = 0;
    let tiedNegatives = 0;
    while (end < ordered.length && ordered[end].probability === ordered[start].probability) {
      if (ordered[end].gold) tiedPositives += 1;
      else tiedNegatives += 1;
      end += 1;
    }
    wins += tiedPositives * (negativesBelow + tiedNegatives / 2);
    negativesBelow += tiedNegatives;
    start = end;
  }
  return wins / (positives * negatives);
}

/** Empirical ROC AUC, giving tied positive/negative scores half a win. */
export function auc(rows) {
  validateRows(rows);
  return aucValidated(rows);
}

function confusionAt(rows, cutoff) {
  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const row of rows) {
    if (row.probability >= cutoff) {
      if (row.gold) confusion.tp += 1;
      else confusion.fp += 1;
    } else if (row.gold) confusion.fn += 1;
    else confusion.tn += 1;
  }
  return confusion;
}

/** A positive prediction is a hide, with probability >= cutoff. */
export function decisionMetrics(rows, cutoff) {
  validateRows(rows);
  validateProbability(cutoff, 'cutoff');
  const confusion = confusionAt(rows, cutoff);
  return {
    n: rows.length,
    positives: confusion.tp + confusion.fn,
    negatives: confusion.fp + confusion.tn,
    auc: aucValidated(rows),
    falseHides: confusion.fp,
    missedHides: confusion.fn,
    errors: confusion.fp + confusion.fn,
    correct: confusion.tp + confusion.tn,
    confusion,
  };
}

// All values used here are nonnegative finite doubles, so their IEEE-754 bit
// ordering is numeric ordering. Zero's successor is the smallest subnormal.
function nextUp(value) {
  if (value === 0) return Number.MIN_VALUE;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  bytes.setBigUint64(0, bytes.getBigUint64(0) + 1n);
  return bytes.getFloat64(0);
}

function intervalFor(lower, upper, lowerInclusive) {
  if (!lowerInclusive && nextUp(lower) === upper) {
    // The open interval has only one representable cutoff. Do not report a
    // nonzero amount of available threshold tuning for that singleton.
    return { lower: upper, upper, width: 0, lowerInclusive: true, upperInclusive: true };
  }
  return { lower, upper, width: upper - lower, lowerInclusive, upperInclusive: true };
}

function midpoint(interval) {
  const middle = interval.lower + interval.width / 2;
  return !interval.lowerInclusive && middle === interval.lower ? nextUp(interval.lower) : middle;
}

/**
 * Minimize total per-decision errors over representable cutoffs in [0,1].
 * Ties prefer the widest optimal component, its midpoint closest to 0.5, then
 * the lower midpoint. False hides have no separate selection priority.
 */
export function optimalCutoff(rows) {
  validateRows(rows);
  const ordered = [...rows].sort((left, right) => left.probability - right.probability);
  let errors = rows.reduce((count, row) => count + Number(!row.gold), 0);
  let bestErrors = Infinity;
  let bestRegions = [];

  function consider(lower, upper, lowerInclusive) {
    if (errors < bestErrors) {
      bestErrors = errors;
      bestRegions = [];
    }
    if (errors === bestErrors) {
      const previous = bestRegions.at(-1);
      if (previous && previous.upper === lower) {
        previous.upper = upper;
      } else {
        bestRegions.push({ lower, upper, lowerInclusive });
      }
    }
  }

  consider(0, ordered.length === 0 ? 1 : (ordered[0].probability || 0), true);
  for (let start = 0; start < ordered.length;) {
    let end = start;
    const score = ordered[start].probability || 0;
    while (end < ordered.length && ordered[end].probability === score) {
      errors += ordered[end].gold ? 1 : -1;
      end += 1;
    }
    if (score < 1) consider(score, end === ordered.length ? 1 : ordered[end].probability, false);
    start = end;
  }

  const intervals = bestRegions.map(region => intervalFor(region.lower, region.upper, region.lowerInclusive));
  let interval = intervals[0];
  let cutoff = midpoint(interval);
  for (const candidate of intervals.slice(1)) {
    const candidateCutoff = midpoint(candidate);
    if (candidate.width > interval.width
      || (candidate.width === interval.width
        && (Math.abs(candidateCutoff - 0.5) < Math.abs(cutoff - 0.5)
          || (Math.abs(candidateCutoff - 0.5) === Math.abs(cutoff - 0.5) && candidateCutoff < cutoff)))) {
      interval = candidate;
      cutoff = candidateCutoff;
    }
  }
  const confusion = confusionAt(rows, cutoff);
  return {
    cutoff,
    interval: { ...interval },
    intervals,
    errors: confusion.fp + confusion.fn,
    falseHides: confusion.fp,
    missedHides: confusion.fn,
  };
}

function binomialTwoSided(discordant, smaller) {
  if (discordant === 0 || smaller === Math.floor(discordant / 2)) return 1;

  // Sum the lower tail relative to its largest term, P(X=smaller). Computing
  // that term in log space avoids starting with 2^-n, which underflows even
  // when a large-n tail near the center has substantial probability.
  let logTerm = -discordant * Math.LN2;
  let correction = 0;
  for (let index = 1; index <= smaller; index += 1) {
    const increment = Math.log((discordant - index + 1) / index) - correction;
    const next = logTerm + increment;
    correction = (next - logTerm) - increment;
    logTerm = next;
  }
  let scaledTail = 1;
  let term = 1;
  for (let index = smaller; index > 0; index -= 1) {
    term *= index / (discordant - index + 1);
    scaledTail += term;
    if (term === 0) break;
  }
  return Math.min(1, Math.exp(Math.LN2 + logTerm + Math.log(scaledTail)));
}

/** Exact conditional two-sided McNemar test; d and k are paired decisions. */
export function mcnemar(pairs) {
  if (!Array.isArray(pairs)) throw new TypeError('pairs must be an array');
  let bothCorrect = 0;
  let bothWrong = 0;
  let dCorrectKWrong = 0;
  let dWrongKCorrect = 0;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair === null || typeof pair !== 'object' || Array.isArray(pair)
      || typeof pair.dCorrect !== 'boolean' || typeof pair.kCorrect !== 'boolean') {
      throw new TypeError(`pairs[${index}] must have boolean dCorrect and kCorrect`);
    }
    if (pair.dCorrect && pair.kCorrect) bothCorrect += 1;
    else if (!pair.dCorrect && !pair.kCorrect) bothWrong += 1;
    else if (pair.dCorrect) dCorrectKWrong += 1;
    else dWrongKCorrect += 1;
  }
  const discordant = dCorrectKWrong + dWrongKCorrect;
  return {
    n: pairs.length,
    bothCorrect,
    bothWrong,
    dCorrectKWrong,
    dWrongKCorrect,
    discordant,
    pValue: binomialTwoSided(discordant, Math.min(dCorrectKWrong, dWrongKCorrect)),
    method: 'exact two-sided binomial',
  };
}
