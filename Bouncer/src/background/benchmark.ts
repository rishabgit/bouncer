// Dev-only latency-benchmark worker. Each call runs ONE bounded operation; the
// page (src/benchmark/index.ts) owns the run loop. Reachable only in --dev
// builds — the benchmark page isn't built in prod and the index.ts dispatch is
// __DEV__-guarded, so this code is unreachable (and tree-shaken) in production.

import { localEngine, callLocalInference } from './local-model';
import { PREDEFINED_MODELS } from '../shared/models';
import type {
  BenchmarkOp, BenchmarkPost, BenchmarkPromptMode,
  BenchmarkInferResult, BenchmarkLoadResult,
} from '../shared/benchmark-types';

export interface BenchmarkRequest {
  op: BenchmarkOp;
  modelId?: string;
  post?: BenchmarkPost;
  categories?: string[];
  promptMode?: BenchmarkPromptMode;
}

export async function handleBenchmark(req: BenchmarkRequest): Promise<unknown> {
  // Dev-only guard. The driving page isn't built in prod, but this also blocks
  // any same-extension caller (e.g. an injected content script) from kicking off
  // inference in a production build.
  if (!__DEV__) return { error: 'Benchmark is disabled in production builds' };

  switch (req.op) {
    case 'load': {
      const modelId = req.modelId;
      if (!modelId) throw new Error('benchmark load: modelId required');
      // reset() first (untimed): ensureLoaded would otherwise unload any prior
      // model inside the timed call, polluting the cold-load number. Then time
      // pure cache→VRAM + WebGPU compile.
      await localEngine.reset();
      const t0 = performance.now();
      await localEngine.ensureLoaded(modelId);
      return { loadMs: performance.now() - t0 } satisfies BenchmarkLoadResult;
    }

    case 'infer': {
      const modelId = req.modelId;
      if (!modelId || !req.post || !req.categories) {
        throw new Error('benchmark infer: modelId, post, and categories required');
      }
      const cfg = PREDEFINED_MODELS.local.find(m => m.name === modelId) ?? null;
      const t0 = performance.now();
      // Real per-classification path: builds the table_yesno prompt,
      // truncates, and times generation.
      const result = await callLocalInference(
        { text: req.post.text },
        req.categories,
        cfg,
        modelId,
        { promptMode: req.promptMode },
      );
      const wallMs = performance.now() - t0;
      return {
        inferenceTime: result.inferenceTime ?? 0,
        wallMs,
        shouldHide: result.shouldHide,
        reasoning: result.reasoning,
        rawResponse: result.rawResponse ?? null,
        completionChars: (result.rawResponse ?? '').length,
        // LiteRT-LM does not expose token-level timing through its JS API.
        usage: null,
      } satisfies BenchmarkInferResult;
    }

    case 'unload': {
      await localEngine.reset();
      return { ok: true };
    }

    default:
      throw new Error(`benchmark: unknown op ${String((req as { op: unknown }).op)}`);
  }
}
