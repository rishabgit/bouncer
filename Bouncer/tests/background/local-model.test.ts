import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

const litertState = vi.hoisted(() => ({
  createBackend: vi.fn(),
  isCached: vi.fn(),
  deleteCache: vi.fn(),
  forceCloseOffscreen: vi.fn(),
}));

const modelsState = vi.hoisted(() => ({
  local: [] as unknown[],
}));

const utilityState = vi.hoisted(() => ({
  isGpuLost: vi.fn(),
  isNetworkError: vi.fn(),
}));

vi.mock('../../src/background/backends/litertlm-backend.js', () => ({
  LitertlmBackend: vi.fn(function LitertlmBackendMock() {
    return litertState.createBackend();
  }),
  isLitertlmCached: litertState.isCached,
  deleteLitertlmCache: litertState.deleteCache,
  forceCloseLitertlmOffscreen: litertState.forceCloseOffscreen,
}));

vi.mock('../../src/shared/models.js', () => ({
  get PREDEFINED_MODELS() {
    return { local: modelsState.local };
  },
}));

vi.mock('../../src/shared/utils.js', () => ({
  isGPUDeviceLostError: utilityState.isGpuLost,
  isNetworkError: utilityState.isNetworkError,
  formatLocalInferenceResult: (reasoning: string, shouldHide: boolean) => ({
    shouldHide,
    reasoning: reasoning || 'No reasoning provided',
  }),
}));

import {
  callLocalInference,
  LocalEngine,
  localEngine,
  MODEL_MAINTENANCE_ERROR,
} from '../../src/background/local-model.js';
import {
  LitertlmBackend,
  deleteLitertlmCache,
  forceCloseLitertlmOffscreen,
  isLitertlmCached,
} from '../../src/background/backends/litertlm-backend.js';
import {
  InferenceQueue,
  inferenceQueue,
} from '../../src/background/inference-queue.js';
import type { LocalBackend } from '../../src/background/backends/types.js';
import type { LocalModelDef, LocalModelStatus } from '../../src/types.js';

const E2B_MODEL_ID = 'gemma-4-E2B-it-web';
const E2B_MODEL: LocalModelDef = {
  name: E2B_MODEL_ID,
  display: 'Gemma 4 E2B (Instruct)',
  isLocal: true,
  backend: 'litertlm',
  sizeGB: 2.008,
  litertlmConfig: {
    modelUrl: 'https://example.test/gemma-4-E2B-it-web.litertlm',
    maxTokens: 1024,
  },
};

let storageData: Record<string, unknown>;
let engine: LocalEngine | null;

function makeBackend(overrides: Partial<LocalBackend> = {}): LocalBackend {
  return {
    unloadAfterSuperseded: false,
    initialize: vi.fn().mockResolvedValue(undefined),
    unload: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn().mockResolvedValue('no'),
    interrupt: vi.fn().mockResolvedValue(undefined),
    countTokens: vi.fn(async (text: string) => text.length),
    truncateText: vi.fn(async (text: string, maxTokens: number) => text.slice(0, maxTokens)),
    ...overrides,
  };
}

function installChromeStorage(initial: Record<string, unknown> = {}): void {
  storageData = structuredClone(initial);
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[]) => {
          if (keys === undefined) return structuredClone(storageData);
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter(key => Object.prototype.hasOwnProperty.call(storageData, key))
              .map(key => [key, storageData[key]]),
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(storageData, structuredClone(items));
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
        }),
      } as unknown as chrome.storage.LocalStorageArea,
    },
  } as unknown as typeof chrome;
}

function setWebGpuSupported(supported: boolean): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: supported ? { gpu: {} } : {},
  });
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function statusFor(modelId = E2B_MODEL_ID): LocalModelStatus | undefined {
  return (storageData.localModelStatuses as Record<string, LocalModelStatus> | undefined)?.[modelId];
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  installChromeStorage();
  setWebGpuSupported(true);
  modelsState.local = [E2B_MODEL];
  litertState.isCached.mockResolvedValue(false);
  litertState.deleteCache.mockResolvedValue(undefined);
  litertState.forceCloseOffscreen.mockResolvedValue(false);
  litertState.createBackend.mockImplementation(() => makeBackend());
  utilityState.isGpuLost.mockReturnValue(false);
  utilityState.isNetworkError.mockReturnValue(false);
  inferenceQueue.reset();
  engine = null;
});

afterEach(async () => {
  if (engine) {
    await engine.reset();
    engine._settleInitOperation(engine._initSettledGeneration);
    engine.teardown();
  }
  inferenceQueue.reset();
  vi.useRealTimers();
});

describe('InferenceQueue', () => {
  it('clears pending work without disturbing the in-flight task', async () => {
    const queue = new InferenceQueue();
    let finishInflight!: () => void;
    const inflight = queue.enqueue(() => new Promise<void>(resolve => {
      finishInflight = resolve;
    }));
    await flushAsync();
    const pending = queue.enqueue(async () => 'pending');

    queue.clear();

    await expect(pending).rejects.toThrow('Inference queue cleared');
    finishInflight();
    await expect(inflight).resolves.toBeUndefined();
  });

  it('drains after the in-flight task and rejects ordinary pending work', async () => {
    const queue = new InferenceQueue();
    const order: string[] = [];
    let finishInflight!: () => void;
    const inflight = queue.enqueue(() => new Promise<void>(resolve => {
      finishInflight = () => {
        order.push('inflight');
        resolve();
      };
    }));
    await flushAsync();
    const pending = queue.enqueue(async () => {
      order.push('pending');
    });
    pending.catch(() => undefined);
    const drain = queue.drain(async () => {
      order.push('maintenance');
      return 'done';
    });

    finishInflight();

    await inflight;
    await expect(pending).rejects.toThrow('Inference queue cleared');
    await expect(drain).resolves.toBe('done');
    expect(order).toEqual(['inflight', 'maintenance']);
  });

  it('serializes concurrent drains', async () => {
    const queue = new InferenceQueue();
    const order: string[] = [];
    const first = queue.drain(async () => {
      order.push('first');
    });
    const second = queue.drain(async () => {
      order.push('second');
    });

    await Promise.all([first, second]);

    expect(order).toEqual(['first', 'second']);
  });

  it('runs higher-priority pending work first', async () => {
    const queue = new InferenceQueue();
    const order: string[] = [];
    let finishInflight!: () => void;
    const inflight = queue.enqueue(() => new Promise<void>(resolve => {
      finishInflight = resolve;
    }));
    await flushAsync();
    const low = queue.enqueue(async () => { order.push('low'); }, { priority: 0 });
    const high = queue.enqueue(async () => { order.push('high'); }, { priority: 10 });
    const middle = queue.enqueue(async () => { order.push('middle'); }, { priority: 5 });

    finishInflight();
    await Promise.all([inflight, low, high, middle]);

    expect(order).toEqual(['high', 'middle', 'low']);
  });
});

describe('LocalEngine initialization', () => {
  beforeEach(() => {
    engine = new LocalEngine();
  });

  it('initializes the LiteRT backend with the E2B definition and publishes ready', async () => {
    const backend = makeBackend({
      initialize: vi.fn(async (_model, onProgress) => {
        onProgress({ progress: 0.5, text: 'Downloading' });
        onProgress({ progress: 1, text: 'Starting' });
      }),
    });
    litertState.createBackend.mockReturnValue(backend);

    await expect(engine!.initialize(E2B_MODEL_ID)).resolves.toBe(backend);
    await engine!._statusWriteChain;

    expect(LitertlmBackend).toHaveBeenCalledTimes(1);
    expect(backend.initialize).toHaveBeenCalledWith(
      E2B_MODEL,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(engine!.loadedModel).toBe(E2B_MODEL_ID);
    expect(statusFor()).toEqual({ state: 'ready' });
  });

  it('coalesces concurrent initialization of the sole model', async () => {
    let finishInitialize!: () => void;
    const backend = makeBackend({
      initialize: vi.fn(() => new Promise<void>(resolve => {
        finishInitialize = resolve;
      })),
    });
    litertState.createBackend.mockReturnValue(backend);

    const first = engine!.initialize(E2B_MODEL_ID);
    await vi.waitFor(() => expect(backend.initialize).toHaveBeenCalledTimes(1));
    const second = engine!.initialize(E2B_MODEL_ID);
    finishInitialize();

    await expect(Promise.all([first, second])).resolves.toEqual([backend, backend]);
    expect(LitertlmBackend).toHaveBeenCalledTimes(1);
  });

  it('marks the model unsupported without constructing LiteRT when WebGPU is absent', async () => {
    setWebGpuSupported(false);

    await expect(engine!.initialize(E2B_MODEL_ID)).resolves.toBeNull();

    expect(LitertlmBackend).not.toHaveBeenCalled();
    expect(statusFor()).toEqual({
      state: 'unsupported',
      reason: 'WebGPU not supported',
    });
  });

  it('retries a network failure three times before surfacing a terminal download error', async () => {
    vi.useFakeTimers();
    utilityState.isNetworkError.mockImplementation((message: string) => message.includes('network'));
    const backend = makeBackend({
      initialize: vi.fn().mockRejectedValue(new Error('network failed')),
    });
    litertState.createBackend.mockReturnValue(backend);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const initialization = engine!.initialize(E2B_MODEL_ID);
    await flushAsync();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(initialization).resolves.toBeNull();
    expect(backend.initialize).toHaveBeenCalledTimes(4);
    expect(statusFor()).toEqual({
      state: 'error',
      error: 'Download failed after multiple retries. Check your internet connection.',
    });
    error.mockRestore();
  });

  it('cleans up initialization state after persistent status storage failure and permits retry', async () => {
    const firstBackend = makeBackend();
    const retryBackend = makeBackend();
    litertState.createBackend
      .mockReturnValueOnce(firstBackend)
      .mockReturnValueOnce(retryBackend);
    const set = globalThis.chrome.storage.local.set as unknown as Mock;
    set.mockRejectedValue(new Error('storage write failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(engine!.initialize(E2B_MODEL_ID)).rejects.toThrow('storage write failed');

    expect(engine!._initializingModel).toBeNull();
    expect(engine!._initPromise).toBeNull();
    expect(engine!._initAbortController).toBeNull();
    expect(engine!._downloadKeepAliveInterval).toBeNull();
    expect(engine!.engine).toBeNull();
    expect(firstBackend.unload).toHaveBeenCalledTimes(1);

    set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(storageData, structuredClone(items));
    });
    await expect(engine!.initialize(E2B_MODEL_ID)).resolves.toBe(retryBackend);
    expect(engine!.engine).toBe(retryBackend);
    expect(statusFor()).toEqual({ state: 'ready' });
    error.mockRestore();
  });

  it('preserves a persisted terminal fence across an MV3 worker restart until explicit Retry', async () => {
    installChromeStorage({
      localModelStatuses: {
        [E2B_MODEL_ID]: {
          state: 'error',
          error: 'Local inference timed out. Retry from the Bouncer popup.',
        },
      },
    });
    litertState.isCached.mockResolvedValue(true);
    const retryBackend = makeBackend();
    litertState.createBackend.mockReturnValue(retryBackend);

    // A newly constructed LocalEngine represents a fresh MV3 worker. Startup
    // reconciliation must hydrate, not erase, its durable terminal fence.
    engine = new LocalEngine();
    await engine.syncAllStatuses();

    expect(statusFor()).toEqual({
      state: 'error',
      error: 'Local inference timed out. Retry from the Bouncer popup.',
    });
    await expect(engine.ensureLoaded(E2B_MODEL_ID)).rejects.toThrow('explicit Retry');
    expect(LitertlmBackend).not.toHaveBeenCalled();

    await expect(engine.initialize(E2B_MODEL_ID)).resolves.toBe(retryBackend);
    expect(LitertlmBackend).toHaveBeenCalledTimes(1);
    expect(statusFor()).toEqual({ state: 'ready' });
  });

  it('does not re-add a stale terminal fence while explicit Retry persists ready', async () => {
    installChromeStorage({
      localModelStatuses: {
        [E2B_MODEL_ID]: {
          state: 'error',
          error: 'Local inference timed out. Retry from the Bouncer popup.',
        },
      },
    });
    const backend = makeBackend();
    litertState.createBackend.mockReturnValue(backend);

    let releaseInitializingWrite!: () => void;
    let initializingWriteStarted!: () => void;
    const initializingWrite = new Promise<void>(resolve => {
      initializingWriteStarted = resolve;
    });
    const initializingGate = new Promise<void>(resolve => {
      releaseInitializingWrite = resolve;
    });
    const set = globalThis.chrome.storage.local.set as unknown as Mock;
    set.mockImplementation(async (items: Record<string, unknown>) => {
      const nextStatuses = items.localModelStatuses as Record<string, LocalModelStatus> | undefined;
      if (nextStatuses?.[E2B_MODEL_ID]?.state === 'initializing') {
        initializingWriteStarted();
        await initializingGate;
      }
      Object.assign(storageData, structuredClone(items));
    });

    engine = new LocalEngine();
    await engine.syncAllStatuses();
    const retry = engine.initialize(E2B_MODEL_ID);
    await initializingWrite;

    // Feed work can arrive while the popup Retry is still initializing. It
    // must serialize behind the status transition instead of reviving `error`.
    const concurrentLoad = engine.ensureLoaded(E2B_MODEL_ID);
    releaseInitializingWrite();

    await expect(retry).resolves.toBe(backend);
    await expect(concurrentLoad).resolves.toBeUndefined();
    await expect(engine.ensureLoaded(E2B_MODEL_ID)).resolves.toBeUndefined();
    expect(statusFor()).toEqual({ state: 'ready' });
  });

  it('rebuilds a logically loaded backend when explicit Retry follows host loss', async () => {
    const staleBackend = makeBackend();
    const replacementBackend = makeBackend();
    litertState.createBackend
      .mockReturnValueOnce(staleBackend)
      .mockReturnValueOnce(replacementBackend);

    await expect(engine!.initialize(E2B_MODEL_ID)).resolves.toBe(staleBackend);
    await engine!.markTerminalError(E2B_MODEL_ID, 'Engine not loaded');

    await expect(engine!.initialize(E2B_MODEL_ID)).resolves.toBe(replacementBackend);

    expect(staleBackend.unload).toHaveBeenCalledTimes(1);
    expect(replacementBackend.initialize).toHaveBeenCalledTimes(1);
    expect(engine!.engine).toBe(replacementBackend);
    expect(statusFor()).toEqual({ state: 'ready' });
  });
});

describe('LocalEngine cancellation and cache deletion', () => {
  beforeEach(() => {
    engine = new LocalEngine();
  });

  it('returns false when the model is not downloading', async () => {
    await expect(engine!.cancelDownload(E2B_MODEL_ID)).resolves.toBe(false);
    expect(forceCloseLitertlmOffscreen).not.toHaveBeenCalled();
  });

  it('aborts an active LiteRT initialization and restores the cache-derived status', async () => {
    let observedSignal: AbortSignal | undefined;
    const backend = makeBackend({
      initialize: vi.fn((_model, _progress, signal) => {
        observedSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }),
    });
    litertState.createBackend.mockReturnValue(backend);
    litertState.isCached.mockResolvedValue(true);

    const initialization = engine!.initialize(E2B_MODEL_ID);
    await vi.waitFor(() => expect(backend.initialize).toHaveBeenCalledTimes(1));

    await expect(engine!.cancelDownload(E2B_MODEL_ID)).resolves.toBe(true);
    await expect(initialization).resolves.toBeNull();

    expect(observedSignal?.aborted).toBe(true);
    expect(engine!.engine).toBeNull();
    expect(statusFor()).toEqual({ state: 'cached' });
    expect(isLitertlmCached).toHaveBeenCalledWith(E2B_MODEL);
  });

  it('unloads a loaded E2B engine before deleting its exact LiteRT cache entry', async () => {
    const backend = makeBackend();
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);

    await expect(engine!.deleteModelCache(E2B_MODEL_ID)).resolves.toEqual({ success: true });

    expect(backend.unload).toHaveBeenCalledTimes(1);
    expect(deleteLitertlmCache).toHaveBeenCalledWith(E2B_MODEL);
    expect(engine!.engine).toBeNull();
    expect(statusFor()).toEqual({ state: 'not_downloaded' });
  });

  it('waits for an unabortable initializer before deleting so late writes cannot resurrect the model', async () => {
    vi.useFakeTimers();
    let finishInitialize!: () => void;
    const backend = makeBackend({
      unloadAfterSuperseded: true,
      initialize: vi.fn(() => new Promise<void>(resolve => {
        finishInitialize = resolve;
      })),
    });
    litertState.createBackend.mockReturnValue(backend);

    const initialization = engine!.initialize(E2B_MODEL_ID);
    await vi.waitFor(() => expect(backend.initialize).toHaveBeenCalledTimes(1));

    const deletion = engine!.deleteModelCache(E2B_MODEL_ID);
    await flushAsync();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(forceCloseLitertlmOffscreen).toHaveBeenCalledTimes(1);
    expect(deleteLitertlmCache).not.toHaveBeenCalled();

    finishInitialize();
    await expect(initialization).resolves.toBeNull();
    await expect(deletion).resolves.toEqual({ success: true });

    expect(backend.unload).toHaveBeenCalledTimes(1);
    expect(deleteLitertlmCache).toHaveBeenCalledWith(E2B_MODEL);
    expect(LitertlmBackend).toHaveBeenCalledTimes(1);
    expect(engine!.engine).toBeNull();
    expect(engine!.loadedModel).toBeNull();
  });

  it('deletes after Chrome confirms the unabortable offscreen host was closed', async () => {
    vi.useFakeTimers();
    let finishInitialize!: () => void;
    const backend = makeBackend({
      unloadAfterSuperseded: false,
      initialize: vi.fn(() => new Promise<void>(resolve => {
        finishInitialize = resolve;
      })),
    });
    litertState.createBackend.mockReturnValue(backend);
    litertState.forceCloseOffscreen.mockResolvedValue(true);

    const initialization = engine!.initialize(E2B_MODEL_ID);
    await vi.waitFor(() => expect(backend.initialize).toHaveBeenCalledTimes(1));
    const deletion = engine!.deleteModelCache(E2B_MODEL_ID);
    await flushAsync();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(deletion).resolves.toEqual({ success: true });
    expect(forceCloseLitertlmOffscreen).toHaveBeenCalledTimes(1);
    expect(deleteLitertlmCache).toHaveBeenCalledWith(E2B_MODEL);

    finishInitialize();
    await expect(initialization).resolves.toBeNull();
    await engine!._statusWriteChain;

    // The late proxy completion belongs to the force-closed host. It must not
    // unload a replacement host or publish itself after cache deletion.
    expect(backend.unload).not.toHaveBeenCalled();
    expect(LitertlmBackend).toHaveBeenCalledTimes(1);
    expect(engine!.engine).toBeNull();
    expect(engine!.loadedModel).toBeNull();
    expect(statusFor()).toEqual({ state: 'not_downloaded' });
  });

  it('re-syncs status when LiteRT cache deletion fails', async () => {
    litertState.deleteCache.mockRejectedValue(new Error('Cache delete failed'));
    litertState.isCached.mockResolvedValue(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(engine!.deleteModelCache(E2B_MODEL_ID)).resolves.toEqual({
      success: false,
      error: 'Cache delete failed',
    });

    expect(statusFor()).toEqual({ state: 'cached' });
    error.mockRestore();
  });

  it('rejects empty and retired model IDs without touching cache storage', async () => {
    await expect(engine!.deleteModelCache('')).resolves.toEqual({
      success: false,
      error: 'No model ID provided',
    });
    await expect(engine!.deleteModelCache('retired-local-model')).resolves.toEqual({
      success: false,
      error: 'Unknown local model: retired-local-model',
    });

    expect(deleteLitertlmCache).not.toHaveBeenCalled();
  });

  it('serializes stale progress before a later terminal status', async () => {
    const get = globalThis.chrome.storage.local.get as unknown as Mock<
      (keys: string | string[]) => Promise<Record<string, unknown>>
    >;
    let releaseFirstRead!: () => void;
    get.mockImplementationOnce(() => new Promise(resolve => {
      releaseFirstRead = () => resolve({ localModelStatuses: {} });
    }));

    const progress = engine!.updateStatus(E2B_MODEL_ID, {
      state: 'downloading',
      progress: 0.8,
    });
    const terminal = engine!.updateStatus(E2B_MODEL_ID, { state: 'not_downloaded' });
    await flushAsync();

    expect(globalThis.chrome.storage.local.set).not.toHaveBeenCalled();
    releaseFirstRead();
    await Promise.all([progress, terminal]);

    expect(statusFor()).toEqual({ state: 'not_downloaded' });
  });
});

describe('LocalEngine idle lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    engine = new LocalEngine();
  });

  it('unloads E2B and marks it cached after one idle minute', async () => {
    const backend = makeBackend();
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);

    await vi.advanceTimersByTimeAsync(60_000);
    await engine!._statusWriteChain;

    expect(backend.unload).toHaveBeenCalledTimes(1);
    expect(engine!.engine).toBeNull();
    expect(statusFor()).toEqual({ state: 'cached' });
  });

  it('a successful generation resets the idle deadline', async () => {
    const backend = makeBackend({
      generate: vi.fn().mockResolvedValue('yes'),
    });
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);

    await vi.advanceTimersByTimeAsync(59_000);
    await engine!.generate([{ role: 'user', content: 'post' }], 16);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(backend.unload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(backend.unload).toHaveBeenCalledTimes(1);
  });

  it('keeps the engine loaded during generation and starts a fresh idle minute afterward', async () => {
    let finishGeneration!: (result: string) => void;
    const backend = makeBackend({
      generate: vi.fn(() => new Promise<string>(resolve => {
        finishGeneration = resolve;
      })),
    });
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);

    await vi.advanceTimersByTimeAsync(59_000);
    const generation = engine!.generate([{ role: 'user', content: 'post' }], 16);
    await flushAsync();
    expect(backend.generate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.unload).not.toHaveBeenCalled();

    finishGeneration('yes');
    await expect(generation).resolves.toBe('yes');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(backend.unload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushAsync();
    await engine!._statusWriteChain;
    expect(backend.unload).toHaveBeenCalledTimes(1);
    expect(statusFor()).toEqual({ state: 'cached' });
  });

  it('defers the idle deadline while another maintenance owns the engine', async () => {
    let finishMaintenance!: () => void;
    const backend = makeBackend();
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);

    await vi.advanceTimersByTimeAsync(59_000);
    const staleIdleGeneration = engine!._activityGeneration;
    const maintenance = engine!.runMaintenance(
      () => new Promise<void>(resolve => { finishMaintenance = resolve; }),
    );
    await flushAsync();
    expect(engine!.isMaintaining()).toBe(true);

    // Simulate an already-queued callback that escaped clearTimeout(). It must
    // return without attempting nested maintenance or unloading the backend.
    await expect(engine!._onIdleTimeout(staleIdleGeneration)).resolves.toBeUndefined();

    // Cross the original idle deadline while maintenance is still active.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(backend.unload).not.toHaveBeenCalled();

    finishMaintenance();
    await maintenance;
    expect(engine!.isMaintaining()).toBe(false);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(backend.unload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushAsync();
    expect(backend.unload).toHaveBeenCalledTimes(1);
  });
});

describe('LocalEngine generation, preemption, and maintenance', () => {
  beforeEach(() => {
    engine = new LocalEngine();
  });

  it('passes the request through the LiteRT seam', async () => {
    const onStart = vi.fn();
    const backend = makeBackend({
      generate: vi.fn().mockResolvedValue('| yes | no'),
    });
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);
    const messages = [{ role: 'user' as const, content: 'post' }];

    await expect(engine!.generate(messages, 24, {
      priority: 3,
      onStart,
    })).resolves.toBe('| yes | no');

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(backend.generate).toHaveBeenCalledWith(messages, 24);
  });

  it('preempts an in-flight generation and does not interrupt twice', async () => {
    let rejectGeneration!: (error: Error) => void;
    const backend = makeBackend({
      generate: vi.fn(() => new Promise<string>((_resolve, reject) => {
        rejectGeneration = reject;
      })),
      interrupt: vi.fn(async () => {
        rejectGeneration(new Error('interrupted'));
      }),
    });
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);

    const generation = engine!.generate([{ role: 'user', content: 'post' }], 16);
    await flushAsync();
    engine!.preempt();
    engine!.preempt();

    await expect(generation).rejects.toThrow('Inference preempted');
    expect(backend.interrupt).toHaveBeenCalledTimes(1);
  });

  it('waits for interrupt settlement before starting the queued generation', async () => {
    let rejectFirst!: (error: Error) => void;
    let finishInterrupt!: () => void;
    const backend = makeBackend({
      generate: vi.fn()
        .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
          rejectFirst = reject;
        }))
        .mockResolvedValueOnce('second result'),
      interrupt: vi.fn(() => {
        rejectFirst(new Error('interrupted'));
        return new Promise<void>(resolve => {
          finishInterrupt = resolve;
        });
      }),
    });
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);

    const first = engine!.generate([{ role: 'user', content: 'first' }], 16);
    await flushAsync();
    engine!.preempt();
    const onSecondStart = vi.fn();
    const second = engine!.generate(
      [{ role: 'user', content: 'second' }],
      16,
      { onStart: onSecondStart },
    );

    await expect(first).rejects.toThrow('Inference preempted');
    await flushAsync();
    expect(onSecondStart).not.toHaveBeenCalled();
    expect(backend.generate).toHaveBeenCalledTimes(1);

    finishInterrupt();
    await expect(second).resolves.toBe('second result');
    expect(onSecondStart).toHaveBeenCalledTimes(1);
    expect(backend.generate).toHaveBeenCalledTimes(2);
  });

  it('blocks reloads during maintenance and leaves no loaded engine after deletion', async () => {
    let rejectGeneration!: (error: Error) => void;
    const backend = makeBackend({
      generate: vi.fn(() => new Promise<string>((_resolve, reject) => {
        rejectGeneration = reject;
      })),
      interrupt: vi.fn(async () => {
        rejectGeneration(new Error('interrupted for maintenance'));
      }),
    });
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);
    const generation = engine!.generate([{ role: 'user', content: 'post' }], 16);
    await flushAsync();
    const prepare = vi.fn();

    const maintenance = engine!.runMaintenance(
      () => engine!.deleteModelCache(E2B_MODEL_ID),
      prepare,
    );

    await expect(engine!.ensureLoaded(E2B_MODEL_ID)).rejects.toThrow(MODEL_MAINTENANCE_ERROR);
    await expect(engine!.initialize(E2B_MODEL_ID)).rejects.toThrow(MODEL_MAINTENANCE_ERROR);
    await expect(generation).rejects.toThrow('Inference preempted');
    await expect(maintenance).resolves.toEqual({ success: true });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(backend.unload).toHaveBeenCalledTimes(1);
    expect(deleteLitertlmCache).toHaveBeenCalledWith(E2B_MODEL);
    expect(LitertlmBackend).toHaveBeenCalledTimes(1);
    expect(engine!.isMaintaining()).toBe(false);
    expect(engine!.engine).toBeNull();
    expect(engine!.loadedModel).toBeNull();
  });

  it('rejects a stale ensureLoaded after fast maintenance spans its status await', async () => {
    let finishStatusSync!: () => void;
    vi.spyOn(engine!, 'syncStatus').mockImplementationOnce(
      () => new Promise(resolve => { finishStatusSync = () => resolve(undefined); }),
    );

    const staleLoad = engine!.ensureLoaded(E2B_MODEL_ID);
    const staleLoadAssertion = expect(staleLoad).rejects.toThrow(MODEL_MAINTENANCE_ERROR);
    await flushAsync();
    await engine!.runMaintenance(async () => undefined);
    finishStatusSync();

    await staleLoadAssertion;
    expect(LitertlmBackend).not.toHaveBeenCalled();
    expect(engine!.engine).toBeNull();
  });

  it('waits for deferred token counting before deleting the leased backend', async () => {
    let finishCount!: (count: number) => void;
    const backend = makeBackend({
      countTokens: vi.fn(() => new Promise<number>(resolve => {
        finishCount = resolve;
      })),
    });
    litertState.createBackend.mockReturnValue(backend);
    engine = localEngine;
    await engine.initialize(E2B_MODEL_ID);

    const inference = callLocalInference(
      { text: 'A post that should still be preparing its prompt.' },
      ['rage bait'],
      E2B_MODEL,
      E2B_MODEL_ID,
    );
    await vi.waitFor(() => expect(backend.countTokens).toHaveBeenCalledTimes(1));

    const deletion = engine.runMaintenance(
      () => engine!.deleteModelCache(E2B_MODEL_ID),
    );
    await flushAsync();

    expect(backend.unload).not.toHaveBeenCalled();
    expect(deleteLitertlmCache).not.toHaveBeenCalled();

    finishCount(12);
    await expect(inference).rejects.toThrow(MODEL_MAINTENANCE_ERROR);
    await expect(deletion).resolves.toEqual({ success: true });

    expect(backend.truncateText).not.toHaveBeenCalled();
    expect(backend.generate).not.toHaveBeenCalled();
    expect(backend.unload).toHaveBeenCalledTimes(1);
    expect(deleteLitertlmCache).toHaveBeenCalledWith(E2B_MODEL);
  });

  it('resets the engine and records an actionable status after GPU loss', async () => {
    utilityState.isGpuLost.mockImplementation((message: string) => message.includes('device lost'));
    const backend = makeBackend({
      generate: vi.fn().mockRejectedValue(new Error('GPU device lost')),
    });
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      engine!.generate([{ role: 'user', content: 'post' }], 16),
    ).rejects.toThrow('GPU device lost');

    expect(backend.unload).toHaveBeenCalledTimes(1);
    expect(engine!.engine).toBeNull();
    expect(statusFor()).toEqual({
      state: 'error',
      error: 'GPU memory exhausted during inference. Close other GPU-intensive tabs and retry.',
    });

    litertState.isCached.mockResolvedValue(true);
    await expect(engine!.ensureLoaded(E2B_MODEL_ID))
      .rejects.toThrow('explicit Retry');
    expect(LitertlmBackend).toHaveBeenCalledTimes(1);

    const retryBackend = makeBackend();
    litertState.createBackend.mockReturnValue(retryBackend);
    await expect(engine!.initialize(E2B_MODEL_ID)).resolves.toBe(retryBackend);
    expect(LitertlmBackend).toHaveBeenCalledTimes(2);
    expect(statusFor()).toEqual({ state: 'ready' });
    error.mockRestore();
  });

  it('rejects at the inference deadline even when interrupt never settles', async () => {
    vi.useFakeTimers();
    const backend = makeBackend({
      generate: vi.fn(() => new Promise<string>(() => undefined)),
      interrupt: vi.fn(() => new Promise<void>(() => undefined)),
    });
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const generation = engine!.generate([{ role: 'user', content: 'post' }], 16);
    const generationAssertion = expect(generation).rejects.toThrow('Inference timeout');
    await flushAsync();
    await vi.advanceTimersByTimeAsync(90_000);

    await generationAssertion;
    expect(backend.interrupt).toHaveBeenCalledTimes(1);
    expect(engine!.engine).toBeNull();
    expect(forceCloseLitertlmOffscreen).toHaveBeenCalled();
    await engine!._statusWriteChain;
    expect(statusFor()).toEqual({
      state: 'error',
      error: 'Local inference timed out. Retry from the Bouncer popup.',
    });
    warning.mockRestore();
  });

  it('publishes ready when explicit retry finds an already-loaded backend', async () => {
    const backend = makeBackend();
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);
    await engine!.updateStatus(E2B_MODEL_ID, {
      state: 'error',
      error: 'temporary runtime failure',
    });

    await expect(engine!.initialize(E2B_MODEL_ID)).resolves.toBe(backend);

    expect(statusFor()).toEqual({ state: 'ready' });
    expect(LitertlmBackend).toHaveBeenCalledTimes(1);
  });

  it('teardown clears model references and timers synchronously', async () => {
    const backend = makeBackend();
    litertState.createBackend.mockReturnValue(backend);
    await engine!.initialize(E2B_MODEL_ID);

    engine!.teardown();

    expect(engine!.engine).toBeNull();
    expect(engine!.loadedModel).toBeNull();
    expect(engine!._modelConfig).toBeNull();
    expect(engine!._idleTimeoutId).toBeNull();
    expect(engine!._keepAliveInterval).toBeNull();
    expect(engine!._downloadKeepAliveInterval).toBeNull();
  });
});
