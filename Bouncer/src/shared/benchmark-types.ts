// Shared contract between the dev-only benchmark page (src/benchmark/index.ts)
// and its background worker (src/background/benchmark.ts). These are types only
// — importing this module pulls no runtime code into either bundle.

import type { LocalPromptMode } from './prompts';

// One bounded operation per message. The PAGE owns the run loop: an MV3 service
// worker must not hold a response open for an entire multi-minute run. The
// historical operation names remain internal: `load` verifies metadata without
// loading weights, `infer` is real generation, and `unload` drains extension
// work without unloading the shared native runner.
export type BenchmarkOp = 'load' | 'infer' | 'unload';

// The post payload for an `infer` op (mirrors EvaluationPostData; text-only here).
export interface BenchmarkPost {
  text: string;
}

export type BenchmarkPromptMode = LocalPromptMode;

// Optional per-classification runtime accounting. The fixed native benchmark
// currently reports null; blank columns are not zero-throughput measurements.
export interface BenchmarkUsage {
  promptTokens: number;
  completionTokens: number;
  timeToFirstTokenS?: number;   // ≈ prefill
  timePerOutputTokenS?: number; // ≈ decode, per token
  prefillTokensPerS?: number;
  decodeTokensPerS?: number;
  e2eLatencyS?: number;
}

// Result of one `infer` op.
export interface BenchmarkInferResult {
  inferenceTime: number;   // generation-call SECONDS, including transport/native loading
  wallMs: number;          // full callLocalInference() wall time (performance.now), incl. prompt prep
  shouldHide: boolean;
  reasoning: string;
  rawResponse: string | null;
  completionChars: number;
  usage: BenchmarkUsage | null;
}

// Result of one `load` op: timed metadata readiness, never a native model load.
export interface BenchmarkLoadResult {
  loadMs: number;
}
