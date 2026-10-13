// Shared contract between the dev-only benchmark page (src/benchmark/index.ts)
// and its background worker (src/background/benchmark.ts). These are types only
// — importing this module pulls no runtime code into either bundle.

import type { LocalPromptMode } from './prompts';
import type { InferenceEngineId, LocalModelStatus } from '../types';

// One bounded operation per message. The PAGE owns the run loop: an MV3 service
// worker must not hold a response open for an entire multi-minute run. The
// `status` reads the committed choice without setup. `load` initializes cached
// Browser weights or verifies native metadata. `unload` releases Browser's
// extension-owned runtime; it only drains work for a shared native runner.
export type BenchmarkOp = 'status' | 'load' | 'infer' | 'unload';

export interface BenchmarkRequest {
  op: BenchmarkOp;
  selectionRevision?: number;
  post?: BenchmarkPost;
  categories?: string[];
  promptMode?: BenchmarkPromptMode;
}

/** Captured classifier identity, never an instruction to select a model. */
export interface BenchmarkClassifierIdentity {
  readonly engine: InferenceEngineId;
  readonly modelId: string;
  readonly selectionRevision: number;
  readonly classifierFingerprint: string;
  readonly display: string;
  readonly weightDigest: string;
  readonly manifestDigest: string | null;
  readonly runtimeVersion: string;
}

export interface BenchmarkStatusResult {
  identity: BenchmarkClassifierIdentity | null;
  status: LocalModelStatus;
}

export type BenchmarkLoadKind = 'browser_initialization' | 'native_metadata';

// The post payload for an `infer` op (mirrors EvaluationPostData; text-only here).
export interface BenchmarkPost {
  text: string;
}

export type BenchmarkPromptMode = LocalPromptMode;

// Optional per-classification runtime accounting. Blank columns are not
// zero-throughput measurements.
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
export interface BenchmarkInferResult extends BenchmarkClassifierIdentity {
  inferenceTime: number;   // generation-call SECONDS, including backend transport/loading
  wallMs: number;          // full callLocalInference() wall time (performance.now), incl. prompt prep
  shouldHide: boolean;
  reasoning: string;
  rawResponse: string | null;
  completionChars: number;
  usage: BenchmarkUsage | null;
}

// Native metadata readiness and cached Browser initialization are distinct.
export interface BenchmarkLoadResult extends BenchmarkClassifierIdentity {
  loadMs: number;
  loadKind: BenchmarkLoadKind;
}
