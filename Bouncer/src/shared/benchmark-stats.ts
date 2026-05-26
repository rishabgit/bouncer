// Pure summary statistics for the latency benchmark. No DOM / chrome / engine
// deps, so this is the one piece the benchmark exercises that can be unit-tested
// in Node (vitest). All inputs are plain number arrays (milliseconds at the
// call sites, but the math is unit-agnostic).

export interface LatencyStats {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  p95: number;
  stddev: number; // population standard deviation
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Median follows the same definition as the app's pipeline `getMedianLatency()`
// — average of the two middle elements for even-length input — so benchmark
// medians stay directly comparable to the live `latencyUpdate` numbers.
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Nearest-rank percentile (p in 0..100): rank = ceil(p/100 · n), clamped to
// [1, n]. Used for p90/p95, where interpolation would over-promise precision on
// the small samples (~20) a run collects.
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function stddev(values: number[]): number {
  if (values.length === 0) return NaN;
  if (values.length === 1) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function summarize(values: number[]): LatencyStats {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    n: values.length,
    min: values.length ? min : NaN,
    max: values.length ? max : NaN,
    mean: mean(values),
    median: median(values),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    stddev: stddev(values),
  };
}
