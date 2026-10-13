// Development-only actual-extension checks. Each message owns one bounded
// operation through the fixed classifier and the normal native lease.

import { localEngine, callLocalInference } from './local-model';
import { PRIMARY_LOCAL_MODEL, PRIMARY_LOCAL_MODEL_ID } from '../shared/models';
import type {
  BenchmarkOp, BenchmarkPost, BenchmarkPromptMode,
  BenchmarkInferResult, BenchmarkLoadResult,
} from '../shared/benchmark-types';

export interface BenchmarkRequest {
  op: BenchmarkOp;
  post?: BenchmarkPost;
  categories?: string[];
  promptMode?: BenchmarkPromptMode;
}

export async function handleBenchmark(req: BenchmarkRequest): Promise<unknown> {
  if (!__DEV__) return { error: 'Benchmark is disabled in production builds' };
  if ('modelId' in req || 'endpoint' in req || 'model' in req) {
    throw new Error('The benchmark uses only the fixed native classifier.');
  }
  switch (req.op) {
    case 'load': {
      // Metadata readiness does not warm native weights. First-inference time
      // includes a native load only if Ollama has actually expired its runner.
      const started = performance.now();
      await localEngine.ensureLoaded();
      return { loadMs: performance.now() - started } satisfies BenchmarkLoadResult;
    }
    case 'infer': {
      if (typeof req.post?.text !== 'string' || !Array.isArray(req.categories)
          || !req.categories.length || req.categories.length > 10
          || req.categories.some(value => typeof value !== 'string' || !value.trim())
          || (req.promptMode !== undefined && !['baseline', 'intent'].includes(req.promptMode))) {
        throw new Error('Benchmark inference requires bounded post text and filter phrases.');
      }
      const started = performance.now();
      const result = await callLocalInference(
        { text: req.post.text }, req.categories, PRIMARY_LOCAL_MODEL, PRIMARY_LOCAL_MODEL_ID,
        { promptMode: req.promptMode },
      );
      if (result.malformed) throw new Error('Malformed benchmark classification.');
      return {
        inferenceTime: result.inferenceTime ?? 0,
        wallMs: performance.now() - started,
        shouldHide: result.shouldHide,
        reasoning: result.reasoning,
        rawResponse: result.rawResponse ?? null,
        completionChars: (result.rawResponse ?? '').length,
        usage: null,
      } satisfies BenchmarkInferResult;
    }
    case 'unload': {
      // Retire only extension work. Never unload a shared native runner.
      await localEngine.drainQueue(() => Promise.resolve(undefined));
      return { ok: true };
    }
    default:
      throw new Error(`Unknown benchmark operation: ${String(req.op)}`);
  }
}
