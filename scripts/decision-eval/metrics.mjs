// Positive means "should hide" throughout this evaluation.
// Undefined ratios are NaN, including F1 if precision or recall is undefined.
export function score(cases) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const { expected, predicted } of cases) {
    if (expected && predicted) tp++;
    else if (!expected && predicted) fp++;
    else if (expected && !predicted) fn++;
    else tn++;
  }
  const n = cases.length;
  const accuracy = n === 0 ? NaN : (tp + tn) / n;
  const precision = tp + fp === 0 ? NaN : tp / (tp + fp);
  const recall = tp + fn === 0 ? NaN : tp / (tp + fn);
  const specificity = tn + fp === 0 ? NaN : tn / (tn + fp);
  const falsePositiveRate = tn + fp === 0 ? NaN : fp / (fp + tn);
  const f1 = Number.isNaN(precision) || Number.isNaN(recall) ? NaN
    : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { n, tp, fp, fn, tn, accuracy, precision, recall, f1, specificity, falsePositiveRate };
}

function checkRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Decision rows must be an array');
  const ids = new Set();
  for (const row of rows) {
    const key = `${row?.corpus}:${row?.id}`;
    if (!row || !['rage', 'broad'].includes(row.corpus)
        || typeof row.id !== 'string' || !row.id.trim() || ids.has(key)
        || !Array.isArray(row.expected) || !row.expected.length
        || row.expected.some(value => typeof value !== 'boolean')
        || !Array.isArray(row.probabilities) || row.probabilities.length !== row.expected.length
        || row.probabilities.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`Invalid decision row: ${key}`);
    }
    ids.add(key);
  }
}

const rowKey = row => `${row.corpus}:${row.id}`;

function baselineValue(baseline, key) {
  if (baseline === null) return null;
  if (baseline instanceof Map && baseline.has(key)) return baseline.get(key);
  if (baseline && typeof baseline === 'object' && !Array.isArray(baseline) && Object.hasOwn(baseline, key)) return baseline[key];
  throw new Error(`Missing baseline key: ${key}`);
}

function checkBaseline(rows, baseline, allowUnavailable = true) {
  if (baseline === null && allowUnavailable) return;
  if (baseline === undefined || baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('Baseline map is required; pass explicit null for unpaired scoring');
  }
  for (const row of rows) {
    const value = baselineValue(baseline, rowKey(row));
    if (typeof value !== 'boolean' && value !== null) throw new Error(`Missing or invalid baseline value: ${rowKey(row)}`);
  }
}

function scoreGroup(rows, predict, baseline) {
  const hideCases = [];
  const individualCases = [];
  const falseHideIds = [];
  const missedHideIds = [];
  const newFalseHideIds = [];
  const newMissedHideIds = [];
  const incorrectVectorIds = [];
  const pairedAvailable = baseline !== null && rows.every(row => baselineValue(baseline, rowKey(row)) !== null);
  let exactVectors = 0;
  for (const row of rows) {
    const key = rowKey(row);
    const predicted = predict(row);
    const expectedHide = row.expected.some(Boolean);
    const predictedHide = predicted.some(Boolean);
    hideCases.push({ expected: expectedHide, predicted: predictedHide });
    individualCases.push(...row.expected.map((expected, index) => ({ expected, predicted: predicted[index] })));
    if (predicted.every((value, index) => value === row.expected[index])) exactVectors++;
    else incorrectVectorIds.push(key);
    if (!expectedHide && predictedHide) {
      falseHideIds.push(key);
      // A regression requires a known baseline-correct SHOW, not an absent or
      // previously false-hide baseline. Per-category errors on hidden posts do
      // not count as newly hiding an expected-show post.
      if (baselineValue(baseline, key) === false) newFalseHideIds.push(key);
    }
    if (expectedHide && !predictedHide) {
      missedHideIds.push(key);
      if (baselineValue(baseline, key) === true) newMissedHideIds.push(key);
    }
  }
  return {
    hide: score(hideCases),
    exactVectors,
    totalVectors: rows.length,
    exactVectorAccuracy: rows.length === 0 ? NaN : exactVectors / rows.length,
    individualDecisions: individualCases.length,
    individual: score(individualCases),
    falseHides: falseHideIds.length,
    missedHides: missedHideIds.length,
    pairedAvailable,
    newFalseHides: pairedAvailable ? newFalseHideIds.length : null,
    newMissedHides: pairedAvailable ? newMissedHideIds.length : null,
    falseHideIds,
    missedHideIds,
    newFalseHideIds: pairedAvailable ? newFalseHideIds : null,
    newMissedHideIds: pairedAvailable ? newMissedHideIds : null,
    incorrectVectorIds,
  };
}

function scorePredictions(rows, predict, baseline) {
  return {
    rage: scoreGroup(rows.filter(row => row.corpus === 'rage'), predict, baseline),
    broad: scoreGroup(rows.filter(row => row.corpus === 'broad'), predict, baseline),
    all: scoreGroup(rows, predict, baseline),
  };
}

export function scoreRows(rows, cutoff, baseline) {
  checkRows(rows);
  checkBaseline(rows, baseline);
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 1) throw new Error('Decision cutoff must be finite and within [0,1]');
  return scorePredictions(rows, row => row.probabilities.map(probability => probability >= cutoff), baseline);
}

function prepare(rows) {
  const byProbability = new Map();
  rows.forEach((row, index) => row.probabilities.forEach((probability, category) => {
    if (!byProbability.has(probability)) byProbability.set(probability, []);
    byProbability.get(probability).push({ index, expected: row.expected[category] });
  }));
  return [...byProbability].sort(([left], [right]) => left - right);
}

// Counts change only when a probability is crossed. Update affected cases once
// per breakpoint rather than rescoring every full vector at every threshold.
function spans(rows, events, omit = -1) {
  const mismatches = rows.map(row => row.expected.filter(expected => !expected).length);
  const remaining = rows.map(row => row.expected.length);
  let exactVectors = 0;
  let falseHides = 0;
  rows.forEach((row, index) => {
    if (index === omit) return;
    if (mismatches[index] === 0) exactVectors++;
    if (!row.expected.some(Boolean)) falseHides++;
  });
  const result = [];
  let lower = 0;
  let lowerInclusive = true;
  const add = upper => result.push({ lower, upper, lowerInclusive, upperInclusive: true, exactVectors, falseHides });
  for (const [probability, candidates] of events) {
    const active = candidates.filter(event => event.index !== omit);
    if (!active.length) continue; // Held-out probabilities must not shape fold intervals.
    if (probability > lower || (probability === 0 && lowerInclusive)) add(probability);
    const affected = new Set(active.map(event => event.index));
    for (const index of affected) {
      if (mismatches[index] === 0) exactVectors--;
      if (!rows[index].expected.some(Boolean) && remaining[index] > 0) falseHides--;
    }
    for (const event of active) {
      mismatches[event.index] += event.expected ? 1 : -1;
      remaining[event.index]--;
    }
    for (const index of affected) {
      if (mismatches[index] === 0) exactVectors++;
      if (!rows[index].expected.some(Boolean) && remaining[index] > 0) falseHides++;
    }
    lower = probability;
    lowerInclusive = false;
  }
  if (lower < 1 || !result.length) add(1);
  return result;
}

function representative(span) {
  const midpoint = span.lower + (span.upper - span.lower) / 2;
  // Adjacent IEEE-754 values have no interior midpoint. Export an explicit
  // point interval at an admissible endpoint instead of a fictitious margin.
  if (span.lower === span.upper || midpoint <= span.lower || midpoint >= span.upper) {
    const cutoff = midpoint === span.lower && span.lowerInclusive ? span.lower : span.upper;
    return { cutoff, interval: { lower: cutoff, upper: cutoff, width: 0, lowerInclusive: true, upperInclusive: true } };
  }
  return { cutoff: midpoint, interval: { lower: span.lower, upper: span.upper,
    width: span.upper - span.lower, lowerInclusive: span.lowerInclusive, upperInclusive: span.upperInclusive } };
}

function better(candidate, best) {
  if (!best) return true;
  if (candidate.exactVectors !== best.exactVectors) return candidate.exactVectors > best.exactVectors;
  if (candidate.falseHides !== best.falseHides) return candidate.falseHides < best.falseHides;
  if (candidate.interval.width !== best.interval.width) return candidate.interval.width > best.interval.width;
  const candidateDistance = Math.abs(candidate.cutoff - 0.5);
  const bestDistance = Math.abs(best.cutoff - 0.5);
  return candidateDistance < bestDistance
    || (candidateDistance === bestDistance && candidate.cutoff < best.cutoff);
}

function bestInterval(rows, events, omit = -1) {
  const intervals = spans(rows, events, omit);
  const exactVectors = Math.max(...intervals.map(interval => interval.exactVectors));
  const falseHides = Math.min(...intervals.filter(interval => interval.exactVectors === exactVectors).map(interval => interval.falseHides));
  const components = [];
  for (const interval of intervals) {
    if (interval.exactVectors !== exactVectors || interval.falseHides !== falseHides) continue;
    const previous = components.at(-1);
    if (previous && previous.upper === interval.lower && (previous.upperInclusive || interval.lowerInclusive)) {
      previous.upper = interval.upper;
      previous.upperInclusive = interval.upperInclusive;
    } else components.push({ ...interval });
  }
  let best;
  for (const component of components) {
    const candidate = { ...representative(component), exactVectors, falseHides };
    if (better(candidate, best)) best = candidate;
  }
  return best;
}

/** One representative per probability interval, without merging objectives. */
export function candidateThresholds(rows) {
  checkRows(rows);
  return spans(rows, prepare(rows)).map(span => representative(span).cutoff);
}

/**
 * Optimize exact vectors, then false hides. Merge adjacent equally optimal
 * intervals and prefer the widest contiguous component, then midpoint closest
 * to .5, then lower midpoint. Every cutoff stays in [0,1]; with p>=cutoff an
 * observed p=1 can never become NO. Zero may be a singleton optimum.
 */
export function optimizeThreshold(rows, baseline = null) {
  checkRows(rows);
  checkBaseline(rows, baseline);
  const { cutoff, interval } = bestInterval(rows, prepare(rows));
  return { cutoff, interval, scores: scoreRows(rows, cutoff, baseline) };
}

function preparedTemplates(templates, baseline) {
  if (!Array.isArray(templates) || !templates.length) throw new Error('Selection requires declared templates');
  const ids = new Set();
  let reference;
  return templates.map(template => {
    if (!template || typeof template.id !== 'string' || !template.id.trim() || ids.has(template.id)) throw new Error('Template identities must be unique');
    ids.add(template.id);
    checkRows(template.rows);
    checkBaseline(template.rows, baseline, false);
    const gold = template.rows.map(row => JSON.stringify([rowKey(row), row.expected]));
    if (reference && (gold.length !== reference.length || gold.some((value, index) => value !== reference[index]))) {
      throw new Error('Templates must share ordered case identities and gold vectors');
    }
    reference = gold;
    return { ...template, events: prepare(template.rows) };
  });
}

function choosePrepared(templates, omit = -1) {
  let best;
  for (const template of templates) {
    const candidate = { ...bestInterval(template.rows, template.events, omit), templateId: template.id, template };
    if (better(candidate, best)) best = candidate;
  }
  return best; // Exact ties retain the declared template order.
}

export function chooseSelection(templates, baseline) {
  const chosen = choosePrepared(preparedTemplates(templates, baseline));
  return { templateId: chosen.templateId, cutoff: chosen.cutoff, interval: chosen.interval,
    scores: scoreRows(chosen.template.rows, chosen.cutoff, baseline) };
}

/** Refit template and cutoff on N-1 whole cases; no held-out breakpoint leaks. */
export function leaveOneOut(templates, baseline) {
  const prepared = preparedTemplates(templates, baseline);
  const evaluated = prepared[0].rows.map((_, index) => {
    const chosen = choosePrepared(prepared, index);
    const heldOut = chosen.template.rows[index];
    return { id: heldOut.id, corpus: heldOut.corpus, expected: [...heldOut.expected],
      predicted: heldOut.probabilities.map(probability => probability >= chosen.cutoff),
      templateId: chosen.templateId, cutoff: chosen.cutoff, interval: chosen.interval,
      trainingExactVectors: chosen.exactVectors, trainingFalseHides: chosen.falseHides };
  });
  const scores = scorePredictions(evaluated, row => row.predicted, baseline);
  return { ...scores.all, scores, rows: evaluated };
}
