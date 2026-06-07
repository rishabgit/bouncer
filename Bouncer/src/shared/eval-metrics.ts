// Pure scoring for the dev-only labeled accuracy eval. No DOM / chrome / engine
// deps, so this is the piece the eval exercises that can be unit-tested in Node
// (vitest) — exactly like benchmark-stats.ts.
//
// The positive class is "should hide" (the post matches the filter), so the
// metrics are framed around catching the posts we want filtered:
//   precision low → over-filtering (we hid posts that should have stayed)
//   recall low    → under-filtering (we let through posts that should have gone)
//
// Undefined ratios (zero denominator) yield NaN rather than a misleading 0, so
// the page renders them as "—" (same convention as the benchmark's fmt()). The
// one exception is F1 when precision and recall are both *defined* zeros: that
// means the classifier caught nothing, which is a real 0, not undefined.

export interface EvalCase {
  expected: boolean; // gold: should this post be hidden?
  predicted: boolean; // model: did we hide it?
}

export interface EvalCaseWithKind<K extends string = string> extends EvalCase {
  kind: K;
}

export interface EvalRunLike {
  shouldHide: boolean;
}

export interface EvalScore {
  n: number;
  tp: number; // expected hide & predicted hide
  fp: number; // expected show & predicted hide  (over-filter)
  fn: number; // expected hide & predicted show  (under-filter)
  tn: number; // expected show & predicted show
  accuracy: number; // (tp + tn) / n           — NaN for empty input
  precision: number; // tp / (tp + fp)          — NaN if nothing was predicted hide
  recall: number; // tp / (tp + fn)             — NaN if nothing was expected hide
  f1: number; // harmonic mean of the two       — NaN if either is undefined
  specificity: number; // tn / (tn + fp)         — NaN if nothing was expected show
  falsePositiveRate: number; // fp / (fp + tn)   — NaN if nothing was expected show
}

export function score(cases: EvalCase[]): EvalScore {
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

  let f1: number;
  if (Number.isNaN(precision) || Number.isNaN(recall)) {
    f1 = NaN; // at least one is undefined → F1 is undefined
  } else if (precision + recall === 0) {
    f1 = 0; // both are defined zeros → the model caught nothing
  } else {
    f1 = (2 * precision * recall) / (precision + recall);
  }

  return { n, tp, fp, fn, tn, accuracy, precision, recall, f1, specificity, falsePositiveRate };
}

export function scoreByKind<K extends string>(cases: EvalCaseWithKind<K>[]): Record<K, EvalScore> {
  const groups = new Map<K, EvalCase[]>();
  for (const row of cases) {
    const existing = groups.get(row.kind) ?? [];
    existing.push({ expected: row.expected, predicted: row.predicted });
    groups.set(row.kind, existing);
  }

  return Object.fromEntries([...groups.entries()].map(([kind, rows]) => [kind, score(rows)])) as Record<K, EvalScore>;
}

export function unstableCount(rows: { runs: EvalRunLike[] }[]): number {
  return rows.filter(row => {
    const hideCount = row.runs.filter(run => run.shouldHide).length;
    return hideCount > 0 && hideCount < row.runs.length;
  }).length;
}
