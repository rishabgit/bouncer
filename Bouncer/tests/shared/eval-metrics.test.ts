import { describe, it, expect } from 'vitest';
import { score, scoreByKind, unstableCount, type EvalCase } from '../../src/shared/eval-metrics.js';

// Shorthand: c(expected, predicted).
const c = (expected: boolean, predicted: boolean): EvalCase => ({ expected, predicted });

// ==================== score ====================

describe('score — confusion matrix', () => {
  it('counts tp / fp / fn / tn correctly', () => {
    const s = score([
      c(true, true), // tp
      c(true, true), // tp
      c(false, true), // fp
      c(true, false), // fn
      c(false, false), // tn
      c(false, false), // tn
    ]);
    expect(s.n).toBe(6);
    expect(s.tp).toBe(2);
    expect(s.fp).toBe(1);
    expect(s.fn).toBe(1);
    expect(s.tn).toBe(2);
    // ratios on the richest input: acc 4/6, P 2/3, R 2/3, f1 2/3.
    expect(s.accuracy).toBeCloseTo(2 / 3, 10);
    expect(s.precision).toBeCloseTo(2 / 3, 10);
    expect(s.recall).toBeCloseTo(2 / 3, 10);
    expect(s.f1).toBeCloseTo(2 / 3, 10);
    expect(s.specificity).toBeCloseTo(2 / 3, 10);
    expect(s.falsePositiveRate).toBeCloseTo(1 / 3, 10);
  });
});

describe('score — asymmetric precision and recall (pins the harmonic mean)', () => {
  it('uses the harmonic mean, not the arithmetic mean or precision alone', () => {
    // 1 tp, 2 fp, 1 fn → precision 1/3, recall 1/2.
    // f1 = 2·(1/3)·(1/2) / (1/3 + 1/2) = 0.4
    // (arithmetic mean would be ~0.4167; f1 = precision would be ~0.333)
    const s = score([c(true, true), c(false, true), c(false, true), c(true, false)]);
    expect(s.precision).toBeCloseTo(1 / 3, 10);
    expect(s.recall).toBe(0.5);
    expect(s.f1).toBeCloseTo(0.4, 10);
    expect(s.accuracy).toBe(0.25); // 1 correct (tp) of 4
  });
});

describe('score — perfect classifier', () => {
  it('reports 1.0 across the board when every prediction is right', () => {
    const s = score([c(true, true), c(true, true), c(false, false)]);
    expect(s.accuracy).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.specificity).toBe(1);
    expect(s.falsePositiveRate).toBe(0);
  });
});

describe('score — partial classifier', () => {
  it('computes precision/recall/f1 for a mixed result', () => {
    // 1 tp, 1 fp, 1 fn, 0 tn → precision 0.5, recall 0.5, f1 0.5.
    const s = score([c(true, true), c(false, true), c(true, false)]);
    expect(s.precision).toBe(0.5);
    expect(s.recall).toBe(0.5);
    expect(s.f1).toBe(0.5);
    expect(s.accuracy).toBeCloseTo(1 / 3, 10);
  });
});

describe('score — nothing predicted hide', () => {
  it('precision is NaN (undefined), recall is a defined 0, f1 is NaN', () => {
    // No predicted positives → precision undefined; positives exist but none
    // caught → recall is a real 0.
    const s = score([c(true, false), c(true, false), c(false, false)]);
    expect(s.tp).toBe(0);
    expect(s.fp).toBe(0);
    expect(s.precision).toBeNaN();
    expect(s.recall).toBe(0);
    expect(s.f1).toBeNaN();
    expect(s.accuracy).toBeCloseTo(1 / 3, 10);
  });
});

describe('score — no positives in the gold set', () => {
  it('recall is NaN (undefined) when nothing was expected to hide', () => {
    const s = score([c(false, false), c(false, true)]);
    expect(s.recall).toBeNaN();
    expect(s.precision).toBe(0); // 0 tp out of 1 predicted hide
    expect(s.f1).toBeNaN();
    expect(s.accuracy).toBe(0.5);
  });
});

describe('score — caught nothing (defined zeros)', () => {
  it('f1 is a real 0 when precision and recall are both defined 0', () => {
    // Every prediction is flipped: 0 tp, but there were predicted hides and
    // expected hides, so precision and recall are defined zeros → f1 = 0.
    const s = score([c(true, false), c(false, true)]);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.accuracy).toBe(0);
  });
});

describe('score — all true negatives (non-empty)', () => {
  it('precision and recall are NaN (undefined) but accuracy is a defined 1', () => {
    const s = score([c(false, false), c(false, false)]);
    expect(s.n).toBe(2);
    expect(s.tn).toBe(2);
    expect(s.accuracy).toBe(1);
    expect(s.precision).toBeNaN();
    expect(s.recall).toBeNaN();
    expect(s.f1).toBeNaN();
    expect(s.specificity).toBe(1);
    expect(s.falsePositiveRate).toBe(0);
  });
});

describe('score — empty input', () => {
  it('does not throw and reports NaN ratios', () => {
    const s = score([]);
    expect(s.n).toBe(0);
    expect(s.tp).toBe(0);
    expect(s.accuracy).toBeNaN();
    expect(s.precision).toBeNaN();
    expect(s.recall).toBeNaN();
    expect(s.f1).toBeNaN();
    expect(s.specificity).toBeNaN();
    expect(s.falsePositiveRate).toBeNaN();
  });
});

describe('score — no negatives in the gold set', () => {
  it('specificity and false-positive rate are NaN when no rows were expected allow', () => {
    const s = score([c(true, true), c(true, false)]);
    expect(s.specificity).toBeNaN();
    expect(s.falsePositiveRate).toBeNaN();
    expect(s.recall).toBe(0.5);
  });
});

describe('scoreByKind', () => {
  it('scores each kind independently', () => {
    const byKind = scoreByKind([
      { kind: 'pos', expected: true, predicted: true },
      { kind: 'pos', expected: true, predicted: false },
      { kind: 'neg-amb', expected: false, predicted: true },
      { kind: 'neg-amb', expected: false, predicted: false },
      { kind: 'neg-easy', expected: false, predicted: false },
    ]);

    expect(byKind.pos.tp).toBe(1);
    expect(byKind.pos.fn).toBe(1);
    expect(byKind['neg-amb'].fp).toBe(1);
    expect(byKind['neg-amb'].tn).toBe(1);
    expect(byKind['neg-easy'].tn).toBe(1);
  });
});

describe('unstableCount', () => {
  it('counts rows with split repeated verdicts', () => {
    expect(unstableCount([
      { runs: [{ shouldHide: false }, { shouldHide: false }, { shouldHide: false }] },
      { runs: [{ shouldHide: true }, { shouldHide: true }, { shouldHide: true }] },
      { runs: [{ shouldHide: true }, { shouldHide: false }, { shouldHide: false }] },
      { runs: [{ shouldHide: true }, { shouldHide: true }, { shouldHide: false }] },
    ])).toBe(2);
  });
});
