// Development-only actual-extension checks. Each message owns one bounded
// operation through the selected fixed classifier and the normal local lease.

import { localEngine, callLocalInference } from './local-model';
import { ACCEPTED_OLLAMA_VERSION, BROWSER_RUNTIME_VERSION } from '../shared/models';
import type {
  BenchmarkClassifierIdentity, BenchmarkRequest,
  BenchmarkInferResult, BenchmarkLoadResult, BenchmarkStatusResult,
} from '../shared/benchmark-types';

export type { BenchmarkRequest } from '../shared/benchmark-types';

function captureIdentity(): BenchmarkClassifierIdentity | null {
  const selection = localEngine.getSelection();
  const model = localEngine.getSelectedModel();
  const fingerprint = localEngine.getClassifierFingerprint();
  if (!selection.engine || !model || !fingerprint) return null;
  return {
    engine: selection.engine,
    modelId: model.name,
    selectionRevision: selection.revision,
    classifierFingerprint: fingerprint,
    display: model.display,
    weightDigest: model.weightDigest,
    manifestDigest: model.backend === 'ollama' ? model.manifestDigest : null,
    runtimeVersion: model.backend === 'ollama' ? ACCEPTED_OLLAMA_VERSION : BROWSER_RUNTIME_VERSION,
  };
}

function assertCurrent(identity: BenchmarkClassifierIdentity): void {
  const current = captureIdentity();
  if (!current || current.engine !== identity.engine
      || current.selectionRevision !== identity.selectionRevision
      || current.modelId !== identity.modelId
      || current.classifierFingerprint !== identity.classifierFingerprint) {
    throw new Error('The selected engine changed. Start a new benchmark run.');
  }
}

export async function handleBenchmark(req: BenchmarkRequest): Promise<unknown> {
  if (!__DEV__) return { error: 'Benchmark is disabled in production builds' };
  if (['modelId', 'endpoint', 'model', 'engine', 'backend', 'modelUrl'].some(key => key in req)) {
    throw new Error('The benchmark uses only the selected fixed classifier. Choose and set it up in the Bouncer popup.');
  }
  const identity = captureIdentity();
  if (req.selectionRevision !== undefined
      && (!Number.isSafeInteger(req.selectionRevision) || req.selectionRevision !== identity?.selectionRevision)) {
    throw new Error('The selected engine changed. Start a new benchmark run.');
  }
  if (req.op === 'status') {
    const status = await localEngine.getStatus();
    if (identity) assertCurrent(identity);
    else if (captureIdentity()) throw new Error('The selected engine changed. Refresh benchmark status.');
    return { identity, status } satisfies BenchmarkStatusResult;
  }
  if (!identity) throw new Error('Choose and set up a local engine in the Bouncer popup before benchmarking.');
  switch (req.op) {
    case 'load': {
      // This explicit dev action may initialize verified cached Browser bytes.
      // Native metadata never warms weights, and neither path downloads them.
      const started = performance.now();
      await localEngine.ensureLoaded(identity.modelId);
      assertCurrent(identity);
      return {
        ...identity, loadMs: performance.now() - started,
        loadKind: identity.engine === 'litertlm' ? 'browser_initialization' : 'native_metadata',
      } satisfies BenchmarkLoadResult;
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
        { text: req.post.text }, req.categories, localEngine.getSelectedModel(), identity.modelId,
        { promptMode: req.promptMode, assertCurrent: () => assertCurrent(identity) },
      );
      assertCurrent(identity);
      if (result.engine !== identity.engine || result.modelId !== identity.modelId
          || result.selectionRevision !== identity.selectionRevision
          || result.classifierFingerprint !== identity.classifierFingerprint) {
        throw new Error('The benchmark returned a different classifier identity. Start a new run.');
      }
      if (result.malformed) throw new Error('Malformed benchmark classification.');
      return {
        ...identity,
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
      if (identity.engine === 'litertlm') await localEngine.unloadBrowserModel();
      else await localEngine.drainQueue(() => Promise.resolve(undefined));
      assertCurrent(identity);
      return { ok: true };
    }
    default:
      throw new Error(`Unknown benchmark operation: ${String(req.op)}`);
  }
}
