import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineSelection, LocalModelStatus } from '../../src/types';
import type { BenchmarkInferResult, BenchmarkLoadResult, BenchmarkRequest, BenchmarkStatusResult } from '../../src/shared/benchmark-types';
import { BROWSER_MODEL, PRIMARY_LOCAL_MODEL, classifierFingerprintForEngine } from '../../src/shared/models';

const runtime = vi.hoisted(() => ({
  selection: { engine: 'litertlm', revision: 7 } as EngineSelection,
  getSelection: vi.fn(),
  getSelectedModel: vi.fn(),
  getClassifierFingerprint: vi.fn(),
  getStatus: vi.fn(),
  ensureLoaded: vi.fn(),
  drainQueue: vi.fn(),
  unloadBrowserModel: vi.fn(),
  infer: vi.fn(),
}));

vi.mock('../../src/background/local-model', () => ({
  localEngine: runtime,
  callLocalInference: runtime.infer,
}));

import { handleBenchmark } from '../../src/background/benchmark';

const request: BenchmarkRequest = {
  op: 'infer', selectionRevision: 7, post: { text: 'A synthetic post.' }, categories: ['rage bait'],
};

function status(): LocalModelStatus {
  return { state: runtime.selection.engine ? 'ready' : 'not_configured', message: 'Synthetic status', revision: 3 };
}

function result() {
  const engine = runtime.selection.engine ?? 'litertlm';
  return {
    engine, modelId: engine === 'litertlm' ? BROWSER_MODEL.name : PRIMARY_LOCAL_MODEL.name,
    selectionRevision: runtime.selection.revision,
    classifierFingerprint: classifierFingerprintForEngine(engine),
    shouldHide: true, reasoning: 'Matched: rage bait', rawResponse: 'rage bait:yes',
    inferenceTime: 0.125, malformed: false,
  };
}

beforeEach(() => {
  vi.stubGlobal('__DEV__', true);
  vi.clearAllMocks();
  runtime.selection = { engine: 'litertlm', revision: 7 };
  runtime.getSelection.mockImplementation(() => ({ ...runtime.selection }));
  runtime.getSelectedModel.mockImplementation(() => runtime.selection.engine === null ? null
    : runtime.selection.engine === 'litertlm' ? BROWSER_MODEL : PRIMARY_LOCAL_MODEL);
  runtime.getClassifierFingerprint.mockImplementation(() => runtime.selection.engine
    ? classifierFingerprintForEngine(runtime.selection.engine) : null);
  runtime.getStatus.mockImplementation(() => Promise.resolve(status()));
  runtime.ensureLoaded.mockResolvedValue(undefined);
  runtime.unloadBrowserModel.mockResolvedValue(status());
  runtime.drainQueue.mockImplementation((fn: () => Promise<unknown>) => fn());
  runtime.infer.mockImplementation(() => Promise.resolve(result()));
});

afterEach(() => vi.unstubAllGlobals());

describe('selected-engine development benchmark', () => {
  it('remains disabled in production without consulting or loading an engine', async () => {
    vi.stubGlobal('__DEV__', false);
    expect(await handleBenchmark(request)).toEqual({ error: 'Benchmark is disabled in production builds' });
    expect(runtime.getSelection).not.toHaveBeenCalled();
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it('reads Browser identity without readiness setup, inference or native work', async () => {
    const response = await handleBenchmark({ op: 'status' }) as BenchmarkStatusResult;
    expect(response.identity).toMatchObject({
      engine: 'litertlm', modelId: BROWSER_MODEL.name, selectionRevision: 7,
      classifierFingerprint: classifierFingerprintForEngine('litertlm'),
      weightDigest: BROWSER_MODEL.weightDigest, manifestDigest: null, runtimeVersion: '0.17.0',
    });
    expect(response.status.state).toBe('ready');
    expect(runtime.ensureLoaded).not.toHaveBeenCalled();
    expect(runtime.infer).not.toHaveBeenCalled();
    expect(runtime.drainQueue).not.toHaveBeenCalled();
  });

  it('requires an explicit choice instead of selecting a default or doing setup', async () => {
    runtime.selection = { engine: null, revision: 0 };
    expect(await handleBenchmark({ op: 'status' })).toMatchObject({ identity: null, status: { state: 'not_configured' } });
    await expect(handleBenchmark({ op: 'load' })).rejects.toThrow('Bouncer popup');
    await expect(handleBenchmark({ ...request, selectionRevision: undefined })).rejects.toThrow('Bouncer popup');
    expect(runtime.ensureLoaded).not.toHaveBeenCalled();
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it.each(['modelId', 'endpoint', 'model', 'engine', 'backend', 'modelUrl'])('rejects the %s override', async key => {
    await expect(handleBenchmark({ ...request, [key]: 'arbitrary' })).rejects.toThrow('selected fixed classifier');
    expect(runtime.ensureLoaded).not.toHaveBeenCalled();
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it('loads only the selected fixed Browser model and labels cached initialization', async () => {
    const response = await handleBenchmark({ op: 'load', selectionRevision: 7 }) as BenchmarkLoadResult;
    expect(runtime.ensureLoaded).toHaveBeenCalledExactlyOnceWith(BROWSER_MODEL.name);
    expect(response).toMatchObject({ engine: 'litertlm', modelId: BROWSER_MODEL.name, loadKind: 'browser_initialization' });
    expect(response.loadMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps native load as metadata readiness and native unload as queue drain', async () => {
    runtime.selection = { engine: 'ollama', revision: 7 };
    const response = await handleBenchmark({ op: 'load', selectionRevision: 7 }) as BenchmarkLoadResult;
    expect(runtime.ensureLoaded).toHaveBeenCalledExactlyOnceWith(PRIMARY_LOCAL_MODEL.name);
    expect(response).toMatchObject({ engine: 'ollama', modelId: PRIMARY_LOCAL_MODEL.name, loadKind: 'native_metadata', manifestDigest: PRIMARY_LOCAL_MODEL.manifestDigest });
    expect(await handleBenchmark({ op: 'unload', selectionRevision: 7 })).toEqual({ ok: true });
    expect(runtime.drainQueue).toHaveBeenCalledOnce();
    expect(runtime.unloadBrowserModel).not.toHaveBeenCalled();
  });

  it('uses the captured Browser classifier for real inference and reports its identity', async () => {
    const response = await handleBenchmark(request) as BenchmarkInferResult;
    expect(runtime.infer).toHaveBeenCalledExactlyOnceWith(request.post, request.categories,
      BROWSER_MODEL, BROWSER_MODEL.name, expect.objectContaining({ assertCurrent: expect.any(Function) }));
    expect(response).toMatchObject({
      engine: 'litertlm', modelId: BROWSER_MODEL.name, selectionRevision: 7,
      classifierFingerprint: classifierFingerprintForEngine('litertlm'),
      inferenceTime: 0.125, shouldHide: true, rawResponse: 'rage bait:yes', usage: null,
    });
  });

  it('uses the native fixed classifier when that engine is selected', async () => {
    runtime.selection = { engine: 'ollama', revision: 7 };
    const response = await handleBenchmark(request) as BenchmarkInferResult;
    expect(runtime.infer).toHaveBeenCalledWith(request.post, request.categories,
      PRIMARY_LOCAL_MODEL, PRIMARY_LOCAL_MODEL.name, expect.any(Object));
    expect(response.engine).toBe('ollama');
    expect(response.classifierFingerprint).toBe(classifierFingerprintForEngine('ollama'));
  });

  it('rejects stale revisions before loading, generation or cleanup of a replacement engine', async () => {
    runtime.selection = { engine: 'ollama', revision: 8 };
    for (const op of ['load', 'infer', 'unload'] as const) {
      await expect(handleBenchmark({ ...request, op })).rejects.toThrow('selected engine changed');
    }
    expect(runtime.ensureLoaded).not.toHaveBeenCalled();
    expect(runtime.infer).not.toHaveBeenCalled();
    expect(runtime.drainQueue).not.toHaveBeenCalled();
    expect(runtime.unloadBrowserModel).not.toHaveBeenCalled();
  });

  it('rejects a switch while preparation is pending', async () => {
    runtime.ensureLoaded.mockImplementation(() => {
      runtime.selection = { engine: 'ollama', revision: 8 };
      return Promise.resolve();
    });
    await expect(handleBenchmark({ op: 'load', selectionRevision: 7 })).rejects.toThrow('selected engine changed');
  });

  it('does not combine status from a newer selection with the earlier identity', async () => {
    runtime.getStatus.mockImplementation(() => {
      runtime.selection = { engine: 'ollama', revision: 8 };
      return Promise.resolve(status());
    });
    await expect(handleBenchmark({ op: 'status' })).rejects.toThrow('selected engine changed');
    expect(runtime.ensureLoaded).not.toHaveBeenCalled();
  });

  it('provides a live selection guard to inference before prompt or transport work', async () => {
    runtime.infer.mockImplementation((_post, _categories, _model, _id, options: { assertCurrent: () => void }) => {
      runtime.selection = { engine: 'ollama', revision: 8 };
      options.assertCurrent();
      return Promise.resolve(result());
    });
    await expect(handleBenchmark(request)).rejects.toThrow('selected engine changed');
  });

  it('rejects wrong result identity even if the current selection did not change', async () => {
    runtime.infer.mockResolvedValue({ ...result(), classifierFingerprint: 'another-classifier' });
    await expect(handleBenchmark(request)).rejects.toThrow('different classifier identity');
  });

  it('releases Browser through its coordinator without draining or unloading native weights', async () => {
    expect(await handleBenchmark({ op: 'unload', selectionRevision: 7 })).toEqual({ ok: true });
    expect(runtime.unloadBrowserModel).toHaveBeenCalledOnce();
    expect(runtime.drainQueue).not.toHaveBeenCalled();
  });

  it('propagates missing cached bytes instead of invoking download or a fallback', async () => {
    runtime.ensureLoaded.mockRejectedValue(new Error('Download the browser model from the popup.'));
    await expect(handleBenchmark({ op: 'load', selectionRevision: 7 })).rejects.toThrow('Download the browser model');
    expect(runtime.ensureLoaded).toHaveBeenCalledExactlyOnceWith(BROWSER_MODEL.name);
    expect(runtime.infer).not.toHaveBeenCalled();
    expect(runtime.selection).toEqual({ engine: 'litertlm', revision: 7 });
  });
});
