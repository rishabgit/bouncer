import assert from 'node:assert/strict';
import test from 'node:test';
import { auc, decisionMetrics, mcnemar, optimalCutoff } from '../wording-metrics.mjs';

function interval(lower, upper, lowerInclusive = false) {
  return { lower, upper, width: upper - lower, lowerInclusive, upperInclusive: true };
}

test('wording AUC handles perfect, reversed, mixed and tied empirical rankings', () => {
  const perfect = [
    { gold: false, probability: 0.1 }, { gold: false, probability: 0.3 },
    { gold: true, probability: 0.6 }, { gold: true, probability: 0.9 },
  ];
  assert.equal(auc(perfect), 1);
  assert.equal(auc(perfect.map(row => ({ ...row, gold: !row.gold }))), 0);
  assert.equal(auc([
    { gold: true, probability: 0.8 }, { gold: false, probability: 0.8 },
    { gold: true, probability: 0.3 }, { gold: false, probability: 0.1 },
  ]), 0.625);
  assert.equal(auc([
    { gold: true, probability: 0.5 }, { gold: false, probability: 0.5 },
    { gold: true, probability: 0.5 }, { gold: false, probability: 0.5 },
  ]), 0.5);
});

test('wording AUC is null when either gold class is absent', () => {
  assert.equal(auc([]), null);
  assert.equal(auc([{ gold: true, probability: 0.2 }]), null);
  assert.equal(auc([{ gold: false, probability: 0.8 }]), null);
});

test('wording decision metrics count individual errors with inclusive cutoff', () => {
  const rows = [
    { gold: true, probability: 0.5 }, { gold: false, probability: 0.5 },
    { gold: true, probability: 0.2 }, { gold: false, probability: 0.1 },
  ];
  assert.deepEqual(decisionMetrics(rows, 0.5), {
    n: 4, positives: 2, negatives: 2, auc: 0.625,
    falseHides: 1, missedHides: 1, errors: 2, correct: 2,
    confusion: { tp: 1, fp: 1, fn: 1, tn: 1 },
  });
  assert.deepEqual(decisionMetrics([], 0.5), {
    n: 0, positives: 0, negatives: 0, auc: null,
    falseHides: 0, missedHides: 0, errors: 0, correct: 0,
    confusion: { tp: 0, fp: 0, fn: 0, tn: 0 },
  });
});

test('wording cutoff minimizes total errors without prioritizing false hides', () => {
  // Both components make one error. The wider low cutoff hides the negative,
  // while the narrower high cutoff misses the positive.
  const rows = [{ gold: true, probability: 0.7 }, { gold: false, probability: 0.8 }];
  assert.deepEqual(optimalCutoff(rows), {
    cutoff: 0.35,
    interval: interval(0, 0.7, true),
    intervals: [interval(0, 0.7, true), interval(0.8, 1)],
    errors: 1, falseHides: 1, missedHides: 0,
  });
});

test('wording cutoff reports disjoint optima and selects their widest component', () => {
  const rows = [
    { gold: false, probability: 0.125 }, { gold: true, probability: 0.25 },
    { gold: false, probability: 0.5 }, { gold: true, probability: 0.875 },
  ];
  assert.deepEqual(optimalCutoff(rows), {
    cutoff: 0.6875,
    interval: interval(0.5, 0.875),
    intervals: [interval(0.125, 0.25), interval(0.5, 0.875)],
    errors: 1, falseHides: 0, missedHides: 1,
  });
});

test('wording cutoff resolves equal widths by midpoint proximity then lower midpoint', () => {
  const lowerTie = optimalCutoff([
    { gold: false, probability: 0.125 }, { gold: true, probability: 0.375 },
    { gold: false, probability: 0.625 }, { gold: true, probability: 0.875 },
  ]);
  assert.equal(lowerTie.cutoff, 0.25);
  assert.deepEqual(lowerTie.intervals, [interval(0.125, 0.375), interval(0.625, 0.875)]);
  const nearer = optimalCutoff([
    { gold: false, probability: 0.125 }, { gold: true, probability: 0.25 },
    { gold: false, probability: 0.5 }, { gold: true, probability: 0.625 },
  ]);
  assert.equal(nearer.cutoff, 0.5625);
});

test('wording cutoff merges neutral-score optima and scores the selected point', () => {
  const rows = [
    { gold: false, probability: 0.125 }, { gold: true, probability: 0.5 },
    { gold: false, probability: 0.5 }, { gold: true, probability: 0.875 },
  ];
  assert.deepEqual(optimalCutoff(rows), {
    cutoff: 0.5,
    interval: interval(0.125, 0.875),
    intervals: [interval(0.125, 0.875)],
    errors: 1, falseHides: 1, missedHides: 0,
  });
  assert.equal(decisionMetrics(rows, 0.75).falseHides, 0);
  assert.equal(decisionMetrics(rows, 0.75).errors, 1);
});

test('wording cutoff preserves [0,1] bounds and p>=cutoff endpoint semantics', () => {
  assert.deepEqual(optimalCutoff([]), {
    cutoff: 0.5, interval: interval(0, 1, true), intervals: [interval(0, 1, true)],
    errors: 0, falseHides: 0, missedHides: 0,
  });
  const zeroPositive = optimalCutoff([{ gold: true, probability: 0 }]);
  assert.equal(zeroPositive.cutoff, 0);
  assert.deepEqual(zeroPositive.interval, interval(0, 0, true));
  const oneNegative = optimalCutoff([{ gold: false, probability: 1 }]);
  assert.equal(oneNegative.cutoff, 0.5);
  assert.equal(oneNegative.errors, 1);
  assert.deepEqual(oneNegative.interval, interval(0, 1, true));
  assert.equal(decisionMetrics([{ gold: false, probability: 1 }], 1).falseHides, 1);
  const zeroNegative = optimalCutoff([{ gold: false, probability: 0 }]);
  assert.deepEqual(zeroNegative.interval, interval(0, 1));
  assert.equal(zeroNegative.errors, 0);
  assert.equal(optimalCutoff([{ gold: false, probability: -0 }]).interval.lower, 0);
});

test('wording cutoff reports adjacent-double feasible regions as honest singleton points', () => {
  for (const [low, high] of [[0, Number.MIN_VALUE], [0.5, 0.5000000000000001], [0.9999999999999999, 1]]) {
    const result = optimalCutoff([{ gold: false, probability: low }, { gold: true, probability: high }]);
    assert.equal(result.cutoff, high);
    assert.deepEqual(result.interval, interval(high, high, true));
    assert.deepEqual(result.intervals, [interval(high, high, true)]);
    assert.equal(result.errors, 0);
  }
});

test('wording cutoff covers exactly the optimal regions across small exhaustive gold assignments', () => {
  const probabilities = [0, 0.25, 0.25, 0.75, 1];
  const candidates = [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1];
  for (let mask = 0; mask < 2 ** probabilities.length; mask += 1) {
    const rows = probabilities.map((probability, index) => ({ probability, gold: Boolean(mask & (1 << index)) }));
    const countErrors = cutoff => rows.filter(row => (row.probability >= cutoff) !== row.gold).length;
    const bestErrors = Math.min(...candidates.map(countErrors));
    const result = optimalCutoff(rows);
    assert.equal(result.errors, bestErrors, `gold mask ${mask}`);
    assert.equal(countErrors(result.cutoff), bestErrors, `selected cutoff for gold mask ${mask}`);
    for (const cutoff of candidates) {
      const reportedOptimal = result.intervals.some(region =>
        (cutoff > region.lower || (region.lowerInclusive && cutoff === region.lower))
        && (cutoff < region.upper || (region.upperInclusive && cutoff === region.upper)));
      assert.equal(reportedOptimal, countErrors(cutoff) === bestErrors, `gold mask ${mask}, cutoff ${cutoff}`);
    }
  }
});

test('wording metrics leave input rows and their order unchanged', () => {
  const rows = Object.freeze([
    Object.freeze({ gold: true, probability: 0.9 }),
    Object.freeze({ gold: false, probability: 0.1 }),
  ]);
  assert.equal(auc(rows), 1);
  assert.equal(decisionMetrics(rows, 0.5).errors, 0);
  assert.equal(optimalCutoff(rows).errors, 0);
  assert.equal(rows[0].probability, 0.9);
});

function discordantPairs(dCorrectKWrong, dWrongKCorrect) {
  return [
    ...Array.from({ length: dCorrectKWrong }, () => ({ dCorrect: true, kCorrect: false })),
    ...Array.from({ length: dWrongKCorrect }, () => ({ dCorrect: false, kCorrect: true })),
  ];
}

test('wording McNemar reports the paired table and exact two-sided binomial p-value', () => {
  const pairs = [
    { dCorrect: true, kCorrect: true }, { dCorrect: false, kCorrect: false },
    ...discordantPairs(5, 1),
  ];
  const result = mcnemar(pairs);
  const { pValue, ...table } = result;
  assert.deepEqual(table, {
    n: 8, bothCorrect: 1, bothWrong: 1, dCorrectKWrong: 5, dWrongKCorrect: 1,
    discordant: 6, method: 'exact two-sided binomial',
  });
  assert(Math.abs(pValue - 0.21875) < 1e-14);
  for (const [d, k, expected] of [[10, 0, 0.001953125], [20, 5, 0.004077315330505371], [2, 0, 0.5]]) {
    assert(Math.abs(mcnemar(discordantPairs(d, k)).pValue - expected) < 1e-14);
  }
});

test('wording McNemar is symmetric, ignores concordants in its p-value and handles no discordance', () => {
  const pairs = discordantPairs(20, 5);
  const original = mcnemar(pairs);
  const swapped = mcnemar(pairs.map(pair => ({ dCorrect: pair.kCorrect, kCorrect: pair.dCorrect })));
  assert.equal(swapped.pValue, original.pValue);
  assert.equal(swapped.dCorrectKWrong, original.dWrongKCorrect);
  assert.equal(swapped.dWrongKCorrect, original.dCorrectKWrong);
  assert.equal(mcnemar([...pairs, { dCorrect: true, kCorrect: true }]).pValue, original.pValue);
  assert.equal(mcnemar([]).pValue, 1);
  assert.equal(mcnemar([{ dCorrect: false, kCorrect: false }]).pValue, 1);
  assert.equal(mcnemar(discordantPairs(3, 3)).pValue, 1);
  assert.equal(mcnemar(discordantPairs(3, 2)).pValue, 1);
});

test('wording McNemar remains stable when 2^-discordant would underflow', () => {
  let centralProbability = 1;
  for (let index = 1; index <= 1000; index += 1) centralProbability *= (2 * index - 1) / (2 * index);
  // For 2000 trials with smaller count 999, twice the lower tail excludes
  // exactly the central probability mass. This reference does not use logs.
  const result = mcnemar(discordantPairs(1001, 999));
  assert(Math.abs(result.pValue - (1 - centralProbability)) < 1e-12);
  assert.equal(mcnemar(discordantPairs(2000, 0)).pValue, 0);
});

test('wording metrics reject malformed inputs instead of coercing or omitting decisions', () => {
  const valid = { gold: true, probability: 0.5 };
  const invalidRows = [
    undefined, null, {}, 'rows', [null], [[]], new Array(1),
    [{ probability: 0.5 }], [{ ...valid, gold: 1 }], [{ ...valid, gold: 'true' }],
    ...[undefined, null, '0.5', NaN, Infinity, -Infinity, -0.1, 1.1].map(probability => [{ ...valid, probability }]),
  ];
  for (const rows of invalidRows) {
    assert.throws(() => auc(rows), TypeError);
    assert.throws(() => decisionMetrics(rows, 0.5), TypeError);
    assert.throws(() => optimalCutoff(rows), TypeError);
  }
  for (const cutoff of [undefined, null, '0.5', NaN, Infinity, -Infinity, -0.1, 1.1]) {
    assert.throws(() => decisionMetrics([valid], cutoff), /cutoff/);
  }
  for (const pairs of [undefined, null, {}, 'pairs', [null], [[]], new Array(1), [{}],
    [{ dCorrect: true }], [{ dCorrect: 1, kCorrect: false }], [{ dCorrect: false, kCorrect: 'false' }]]) {
    assert.throws(() => mcnemar(pairs), TypeError);
  }
});
