// Shared contract between the dev-only benchmark page (src/benchmark/index.ts)
// and its background worker (src/background/benchmark.ts). These are types only
// — importing this module pulls no runtime code into either bundle.

// One bounded operation per message. The PAGE owns the run loop: an MV3 service
// worker must not be asked to hold a response open for a whole multi-minute run
// (the codebase already treats long model-init as fire-and-forget for this
// reason), so each op returns within a single load / inference / unload.
export type BenchmarkOp = 'load' | 'infer' | 'unload';

// The post payload for an `infer` op (mirrors EvaluationPostData; text-only here).
export interface BenchmarkPost {
  text: string;
  imageUrls: string[];
}

// Per-classification throughput/latency breakdown. WebLLM/Qwen fills this from
// `reply.usage` + `usage.extra`; LiteRT/Gemma exposes nothing, so it stays null.
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
  inferenceTime: number;   // generate-only SECONDS (result.inferenceTime; matches the app's latencyUpdate)
  wallMs: number;          // full callLocalInference() wall time (performance.now), incl. prompt prep
  shouldHide: boolean;
  reasoning: string;
  completionChars: number;
  usage: BenchmarkUsage | null;
}

// Result of one `load` op (reset() then timed ensureLoaded()).
export interface BenchmarkLoadResult {
  loadMs: number;
}
