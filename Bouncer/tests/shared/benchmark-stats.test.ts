import { describe, it, expect } from 'vitest';
import { mean, median, percentile, stddev, summarize } from '../../src/shared/benchmark-stats.js';

describe('mean', () => {
  it('averages values', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
  it('returns NaN for empty input', () => {
    expect(mean([])).toBeNaN();
  });
});

describe('median', () => {
  it('returns the middle element for odd-length input', () => {
    expect(median([1, 2, 3])).toBe(2);
  });
  it('averages the two middle elements for even-length input (matches pipeline)', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('sorts before taking the median (does not assume sorted input)', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it('does not mutate the input array', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
  it('returns NaN for empty input', () => {
    expect(median([])).toBeNaN();
  });
});

describe('percentile (nearest-rank)', () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it('p90 → 9th of 10 (rank = ceil(0.9·10) = 9)', () => {
    expect(percentile(data, 90)).toBe(9);
  });
  it('p95 → 10th of 10 (rank = ceil(0.95·10) = 10)', () => {
    expect(percentile(data, 95)).toBe(10);
  });
  it('p50 → 5th of 10', () => {
    expect(percentile(data, 50)).toBe(5);
  });
  it('clamps low percentiles to the first element', () => {
    expect(percentile(data, 0)).toBe(1);
  });
  it('returns the only element for a single-value array', () => {
    expect(percentile([42], 90)).toBe(42);
  });
  it('returns NaN for empty input', () => {
    expect(percentile([], 90)).toBeNaN();
  });
});

describe('stddev (population)', () => {
  it('matches the textbook example', () => {
    // mean 5, variance 4 → stddev 2
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });
  it('is 0 for a single value', () => {
    expect(stddev([5])).toBe(0);
  });
  it('returns NaN for empty input', () => {
    expect(stddev([])).toBeNaN();
  });
});

describe('summarize', () => {
  it('reports the full set of stats', () => {
    const s = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.n).toBe(10);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.mean).toBe(5.5);
    expect(s.median).toBe(5.5);
    expect(s.p90).toBe(9);
    expect(s.p95).toBe(10);
    expect(s.stddev).toBeCloseTo(2.8723, 3);
  });
  it('handles empty input without throwing', () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.min).toBeNaN();
    expect(s.max).toBeNaN();
    expect(s.mean).toBeNaN();
  });
});
