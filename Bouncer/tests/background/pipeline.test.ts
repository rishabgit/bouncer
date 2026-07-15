import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const localEngineState = vi.hoisted(() => ({ maintaining: false }));

// Mock Chrome APIs used by pipeline.js and its imports
globalThis.chrome = {
  storage: {
    local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) },
    onChanged: { addListener: vi.fn() },
  },
  tabs: { sendMessage: vi.fn().mockResolvedValue({}) },
  runtime: { id: 'test-extension-id', onMessage: { addListener: vi.fn() } },
} as unknown as typeof chrome;

// Mock local-model.js so pipeline tests do not initialize the browser LiteRT runtime.
vi.mock('../../src/background/local-model.js', () => ({
  MODEL_MAINTENANCE_ERROR: 'Local model maintenance in progress',
  callLocalInference: vi.fn(),
  localEngine: {
    isInitializing: () => false,
    isModelLoaded: () => false,
    isMaintaining: () => localEngineState.maintaining,
    preempt: vi.fn(),
    clearQueue: vi.fn(),
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    markTerminalError: vi.fn().mockResolvedValue(undefined),
    runMaintenance: vi.fn(async (fn: () => Promise<unknown>, prepare?: () => void) => {
      localEngineState.maintaining = true;
      try {
        prepare?.();
        return await fn();
      } finally {
        localEngineState.maintaining = false;
      }
    }),
  },
}));

import {
  enqueuePost,
  isKeyPending,
  clearTabQueue,
  setActiveTab,
  scheduleBatch,
  prioritizeByViewportDistance,
  parseCandidatePhrases,
  runModelMaintenance,
  suggestAnnoyingReasons,
  initPipeline,
  errorState,
  clearErrorState,
  triggerErrorRetry,
  localErrorRetryDelay,
  handleFilterPackChange,
  clearEvaluationCache,
  evaluationCache,
  saveCache,
  requiresLocalInference,
} from '../../src/background/pipeline.js';
import { localEngine, callLocalInference } from '../../src/background/local-model.js';
import type { PendingEvaluation } from '../../src/types.js';

const mockCallLocalInference = vi.mocked(callLocalInference);
const E2B_MODEL_ID = 'gemma-4-E2B-it-web';

describe('requiresLocalInference', () => {
  it('does not require a model download when filtering is disabled or no filters exist', () => {
    expect(requiresLocalInference({ enabled: false, descriptions: ['Sports'] })).toBe(false);
    expect(requiresLocalInference({ enabled: true, descriptions: [] })).toBe(false);
    expect(requiresLocalInference({ enabled: true, descriptions: ['Sports'] })).toBe(true);
  });
});

beforeEach(() => {
  localEngineState.maintaining = false;
});

/** Create a PendingEvaluation with sensible defaults. */
function makePendingItem(overrides: Partial<PendingEvaluation> & { post: string; cacheKey: string; resolve: PendingEvaluation['resolve'] }): PendingEvaluation {
  return {
    evaluationId: 'eval-default',
    tabId: undefined,
    postUrl: null,
    siteId: 'twitter',
    ...overrides,
  };
}

// ==================== Per-tab queue management ====================

describe('enqueuePost', () => {
  beforeEach(() => {
    // Clear all tab queues by clearing the tab for a fresh state
    clearTabQueue(1);
    clearTabQueue(2);
  });

  it('adds item to correct tab queue and returns false for new cacheKey', () => {
    const resolve = vi.fn();
    const item = makePendingItem({ post: 'test', cacheKey: 'key1', resolve });
    const isDuplicate = enqueuePost(1, item);
    expect(isDuplicate).toBe(false);
    expect(isKeyPending(1, 'key1')).toBe(true);
  });

  it('returns true for duplicate cacheKey on same tab', () => {
    const item1 = makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() });
    const item2 = makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() });
    enqueuePost(1, item1);
    const isDuplicate = enqueuePost(1, item2);
    expect(isDuplicate).toBe(true);
  });

  it('items from different tabs are independent (same cacheKey on two tabs)', () => {
    const item1 = makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() });
    const item2 = makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() });
    expect(enqueuePost(1, item1)).toBe(false);
    expect(enqueuePost(2, item2)).toBe(false);
  });
});

describe('isKeyPending', () => {
  beforeEach(() => {
    clearTabQueue(1);
    clearTabQueue(2);
  });

  it('returns true for queued cacheKey on correct tab', () => {
    enqueuePost(1, makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() }));
    expect(isKeyPending(1, 'key1')).toBe(true);
  });

  it('returns false for wrong tab', () => {
    enqueuePost(1, makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() }));
    expect(isKeyPending(2, 'key1')).toBe(false);
  });

  it('returns false for unknown key', () => {
    expect(isKeyPending(1, 'nonexistent')).toBe(false);
  });
});

describe('clearTabQueue', () => {
  beforeEach(() => {
    clearTabQueue(1);
    vi.clearAllMocks();
  });

  it('resolves all items with null when tab is cleared', () => {
    const resolve1 = vi.fn();
    const resolve2 = vi.fn();
    enqueuePost(1, makePendingItem({ post: 'a', cacheKey: 'k1', resolve: resolve1 }));
    enqueuePost(1, makePendingItem({ post: 'b', cacheKey: 'k2', resolve: resolve2 }));

    clearTabQueue(1);

    expect(resolve1).toHaveBeenCalledWith(null);
    expect(resolve2).toHaveBeenCalledWith(null);
  });

  it('deletes queue and keys after clearing', () => {
    enqueuePost(1, makePendingItem({ post: 'a', cacheKey: 'k1', resolve: vi.fn() }));
    clearTabQueue(1);
    expect(isKeyPending(1, 'k1')).toBe(false);
  });

  it('is a no-op for unknown tabId', () => {
    expect(() => clearTabQueue(999)).not.toThrow();
  });
});

describe('setActiveTab', () => {
  beforeEach(() => {
    clearTabQueue(1);
    setActiveTab(null);
    vi.clearAllMocks();
  });

  it('calls localEngine.clearQueue', () => {
    setActiveTab(1);
    expect(localEngine.clearQueue).toHaveBeenCalled();
  });

  it('calls localEngine.clearQueue even when setting to null', () => {
    setActiveTab(1);
    vi.clearAllMocks();
    setActiveTab(null);
    expect(localEngine.preempt).toHaveBeenCalled();
    expect(localEngine.clearQueue).toHaveBeenCalled();
  });

  it('preempts in-flight work when switching away from an active tab', () => {
    setActiveTab(1);
    vi.clearAllMocks();

    setActiveTab(2);

    expect(localEngine.preempt).toHaveBeenCalledOnce();
    expect(localEngine.clearQueue).toHaveBeenCalledOnce();
  });
});

describe('prioritizeByViewportDistance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sorts by postUrl when available and evaluationId when postUrl is missing', async () => {
    const queue = [
      makePendingItem({
        evaluationId: 'eval-far',
        post: 'far post',
        cacheKey: 'far',
        postUrl: 'https://x.com/user/status/far',
        tabId: 7,
        resolve: vi.fn(),
      }),
      makePendingItem({
        evaluationId: 'eval-near-no-url',
        post: 'near ad',
        cacheKey: 'near-no-url',
        postUrl: null,
        tabId: 7,
        resolve: vi.fn(),
      }),
      makePendingItem({
        evaluationId: 'eval-mid',
        post: 'mid post',
        cacheKey: 'mid',
        postUrl: 'https://x.com/user/status/mid',
        tabId: 7,
        resolve: vi.fn(),
      }),
    ];
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({
      positions: {
        'https://x.com/user/status/far': 300,
        'eval-near-no-url': 5,
        'https://x.com/user/status/mid': 20,
      },
    });

    await prioritizeByViewportDistance(queue);

    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: 'getPositions',
      postUrls: ['https://x.com/user/status/far', 'https://x.com/user/status/mid'],
      evaluationIds: ['eval-near-no-url'],
    });
    expect(queue.map(item => item.cacheKey)).toEqual(['near-no-url', 'mid', 'far']);
  });
});

// ==================== processBatch re-queue on tab switch ====================

describe('processBatch re-queue on inference queue cleared', () => {
  const TAB_ID = 10;
  const flush = () => new Promise(r => setTimeout(r, 100));

  beforeEach(() => {
    clearTabQueue(TAB_ID);
    clearTabQueue(TAB_ID + 1);
    setActiveTab(null);
    vi.clearAllMocks();

    // Mock storage to return local model settings with descriptions
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
      selectedModel: `local:${E2B_MODEL_ID}`,
      descriptions_twitter: ['Sports'],
    });
    // Mock tabs.sendMessage for prioritizeByViewportDistance
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
  });

  it('re-queues items to original tab on inference queue cleared', async () => {
    mockCallLocalInference.mockRejectedValue(new Error('Inference queue cleared'));

    const resolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({ post: 'test post', cacheKey: 'test post', resolve, tabId: TAB_ID }));

    setActiveTab(TAB_ID);
    scheduleBatch();
    await flush();

    // Item should be back in the queue, NOT resolved
    expect(resolve).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'test post')).toBe(true);
  });

  it('resolves with queue_cleared when tab was closed during batch', async () => {
    // Simulate: callLocalInference is called, tab closes (clearTabQueue), then inference rejects
    mockCallLocalInference.mockImplementation(async () => {
      clearTabQueue(TAB_ID);
      throw new Error('Inference queue cleared');
    });

    const resolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({ post: 'test post', cacheKey: 'test post', resolve, tabId: TAB_ID }));

    setActiveTab(TAB_ID);
    scheduleBatch();
    await flush();

    // Item should be resolved with null since tab is gone
    expect(resolve).toHaveBeenCalledWith(null);
    expect(isKeyPending(TAB_ID, 'test post')).toBe(false);
  });

  it('does not re-queue into a replacement queue (page reload)', async () => {
    const newResolve = vi.fn();

    // Simulate: callLocalInference is called, page reloads (clear + new enqueue), then inference rejects
    mockCallLocalInference.mockImplementation(async () => {
      clearTabQueue(TAB_ID);
      // New page enqueues a fresh item into a NEW queue for the same tab
      enqueuePost(TAB_ID, makePendingItem({ post: 'new page post', cacheKey: 'new_key', resolve: newResolve, tabId: TAB_ID }));
      throw new Error('Inference queue cleared');
    });

    const oldResolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({ post: 'old post', cacheKey: 'old_key', resolve: oldResolve, tabId: TAB_ID }));

    setActiveTab(TAB_ID);
    scheduleBatch();
    await flush();

    // Old item should be resolved with null (NOT re-queued into the new queue)
    expect(oldResolve).toHaveBeenCalledWith(null);
    // New item should be untouched in the new queue
    expect(newResolve).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'new_key')).toBe(true);
  });

  it('does not put a preempted old-page item into a reload replacement queue', async () => {
    const newResolve = vi.fn();
    mockCallLocalInference.mockImplementation(async () => {
      clearTabQueue(TAB_ID);
      enqueuePost(TAB_ID, makePendingItem({
        post: 'replacement page post',
        cacheKey: 'replacement_key',
        resolve: newResolve,
        tabId: TAB_ID,
      }));
      throw new Error('Inference preempted');
    });

    const oldResolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'preempted old page post',
      cacheKey: 'preempted_old_key',
      resolve: oldResolve,
      tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    scheduleBatch();
    await flush();

    expect(oldResolve).toHaveBeenCalledWith(null);
    expect(newResolve).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'replacement_key')).toBe(true);
  });

  it('resolves duplicate callers when their original is in flight and the tab closes', async () => {
    let rejectInference!: (error: Error) => void;
    mockCallLocalInference.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectInference = reject;
    }));
    const originalResolve = vi.fn();
    const duplicateResolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'in-flight original',
      cacheKey: 'in-flight-clear',
      resolve: originalResolve,
      tabId: TAB_ID,
    }));
    expect(enqueuePost(TAB_ID, makePendingItem({
      post: 'in-flight duplicate',
      cacheKey: 'in-flight-clear',
      resolve: duplicateResolve,
      tabId: TAB_ID,
    }))).toBe(true);
    setActiveTab(TAB_ID);
    scheduleBatch();
    await vi.waitFor(() => expect(mockCallLocalInference).toHaveBeenCalledTimes(1));

    clearTabQueue(TAB_ID);

    expect(duplicateResolve).toHaveBeenCalledWith(null);
    rejectInference(new Error('Inference queue cleared'));
    await vi.waitFor(() => expect(originalResolve).toHaveBeenCalledWith(null));
  });

  it('wakes the newly active tab after the old tab clears its in-flight inference', async () => {
    const OTHER_TAB_ID = TAB_ID + 1;
    let rejectOldInference!: (error: Error) => void;
    mockCallLocalInference
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectOldInference = reject;
      }))
      .mockResolvedValueOnce({
        shouldHide: false,
        reasoning: 'new tab result',
        rawResponse: 'no',
      });
    const oldResolve = vi.fn();
    const newResolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'old active tab',
      cacheKey: 'old-active-tab',
      resolve: oldResolve,
      tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    scheduleBatch();
    await vi.waitFor(() => expect(mockCallLocalInference).toHaveBeenCalledTimes(1));

    enqueuePost(OTHER_TAB_ID, makePendingItem({
      post: 'new active tab',
      cacheKey: 'new-active-tab',
      resolve: newResolve,
      tabId: OTHER_TAB_ID,
    }));
    setActiveTab(OTHER_TAB_ID);
    scheduleBatch();
    expect(localEngine.preempt).toHaveBeenCalled();
    rejectOldInference(new Error('Inference queue cleared'));

    await vi.waitFor(() => expect(newResolve).toHaveBeenCalledWith(
      expect.objectContaining({ shouldHide: false, reasoning: 'new tab result' }),
    ));
    expect(mockCallLocalInference).toHaveBeenCalledTimes(2);
    expect(oldResolve).not.toHaveBeenCalled();
    setActiveTab(null);
    clearTabQueue(TAB_ID);
    clearTabQueue(OTHER_TAB_ID);
  });

  it('does not start inference for a tab switched away during viewport preparation', async () => {
    const OTHER_TAB_ID = TAB_ID + 1;
    let releaseOldPositions!: (value: { positions: Record<string, number> }) => void;
    (globalThis.chrome.tabs.sendMessage as Mock).mockImplementation((tabId, message) => {
      if (tabId === TAB_ID && message.type === 'getPositions') {
        return new Promise(resolve => { releaseOldPositions = resolve; });
      }
      return Promise.resolve({ positions: {} });
    });
    mockCallLocalInference.mockResolvedValue({
      shouldHide: false,
      reasoning: 'new tab result',
      rawResponse: 'no',
    });

    const oldResolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'old tab awaiting viewport',
      cacheKey: 'old-preparation',
      resolve: oldResolve,
      tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    scheduleBatch();
    await vi.waitFor(() => expect(releaseOldPositions).toBeTypeOf('function'));

    const newResolve = vi.fn();
    enqueuePost(OTHER_TAB_ID, makePendingItem({
      post: 'new active tab post',
      cacheKey: 'new-preparation',
      resolve: newResolve,
      tabId: OTHER_TAB_ID,
    }));
    setActiveTab(OTHER_TAB_ID);
    releaseOldPositions({ positions: {} });

    await vi.waitFor(() => expect(newResolve).toHaveBeenCalledWith(
      expect.objectContaining({ shouldHide: false, reasoning: 'new tab result' }),
    ));
    expect(mockCallLocalInference).toHaveBeenCalledTimes(1);
    expect(mockCallLocalInference).toHaveBeenCalledWith(
      { text: 'new active tab post' },
      expect.anything(),
      expect.anything(),
      E2B_MODEL_ID,
      expect.anything(),
    );
    expect(oldResolve).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'old-preparation')).toBe(true);

    setActiveTab(null);
    clearTabQueue(TAB_ID);
    clearTabQueue(OTHER_TAB_ID);
  });

  it('rechecks tab ownership after model loading and before generation starts', async () => {
    const OTHER_TAB_ID = TAB_ID + 1;
    let releaseOldStart!: () => void;
    mockCallLocalInference.mockImplementation((postData, _categories, _config, _model, options) => {
      if (postData.text === 'old tab loading model') {
        return new Promise((resolve, reject) => {
          releaseOldStart = () => {
            try {
              options?.onInferenceStart?.();
              resolve({ shouldHide: false, reasoning: 'stale result', rawResponse: 'no' });
            } catch (error) {
              reject(error);
            }
          };
        });
      }
      options?.onInferenceStart?.();
      return Promise.resolve({ shouldHide: false, reasoning: 'new tab result', rawResponse: 'no' });
    });

    const oldResolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'old tab loading model',
      cacheKey: 'old-model-load',
      resolve: oldResolve,
      tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    scheduleBatch();
    await vi.waitFor(() => expect(releaseOldStart).toBeTypeOf('function'));

    const newResolve = vi.fn();
    enqueuePost(OTHER_TAB_ID, makePendingItem({
      post: 'new tab after model load',
      cacheKey: 'new-after-model-load',
      resolve: newResolve,
      tabId: OTHER_TAB_ID,
    }));
    setActiveTab(OTHER_TAB_ID);
    releaseOldStart();

    await vi.waitFor(() => expect(newResolve).toHaveBeenCalledWith(
      expect.objectContaining({ shouldHide: false, reasoning: 'new tab result' }),
    ));
    expect(oldResolve).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'old-model-load')).toBe(true);

    setActiveTab(null);
    clearTabQueue(TAB_ID);
    clearTabQueue(OTHER_TAB_ID);
  });

  it('resolves a bounded retry when settings storage fails and accepts later work', async () => {
    const storageError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (globalThis.chrome.storage.local.get as Mock)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue({
        selectedModel: `local:${E2B_MODEL_ID}`,
        descriptions_twitter: ['Sports'],
      });
    mockCallLocalInference.mockResolvedValue({
      shouldHide: false,
      reasoning: 'no match',
      rawResponse: 'no',
    });
    const resolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'retry after storage recovery',
      cacheKey: 'storage-recovery',
      resolve,
      tabId: TAB_ID,
    }));

    setActiveTab(TAB_ID);
    scheduleBatch();
    await vi.waitFor(() => expect(storageError).toHaveBeenCalledWith(
      '[Pipeline] Batch preparation failed:',
      expect.objectContaining({ message: 'storage unavailable' }),
    ));
    expect(resolve).toHaveBeenCalledWith({
      retry: true,
      reasoning: 'storage unavailable',
      retryAfterMs: 1000,
    });
    expect(isKeyPending(TAB_ID, 'storage-recovery')).toBe(false);

    const recoveredResolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'new request after storage recovery',
      cacheKey: 'storage-recovered-request',
      resolve: recoveredResolve,
      tabId: TAB_ID,
    }));
    scheduleBatch();

    await vi.waitFor(() => expect(recoveredResolve).toHaveBeenCalledWith(
      expect.objectContaining({ shouldHide: false, reasoning: 'no match' }),
    ));
    expect(mockCallLocalInference).toHaveBeenCalledTimes(1);
    expect(isKeyPending(TAB_ID, 'storage-recovered-request')).toBe(false);
    storageError.mockRestore();
  });
});

describe('runModelMaintenance', () => {
  const TAB_ID = 24;

  beforeEach(() => {
    clearTabQueue(TAB_ID);
    vi.clearAllMocks();
  });

  it('flushes queued work with a retry before running model maintenance', async () => {
    const resolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'queued post',
      cacheKey: 'queued-post',
      resolve,
      tabId: TAB_ID,
    }));
    const deleteModel = vi.fn().mockResolvedValue('deleted');

    await expect(runModelMaintenance(deleteModel)).resolves.toBe('deleted');

    expect(localEngine.runMaintenance).toHaveBeenCalledTimes(1);
    expect(deleteModel).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({
      retry: true,
      reasoning: 'Local model maintenance in progress.',
      retryAfterMs: 250,
    });
    expect(isKeyPending(TAB_ID, 'queued-post')).toBe(false);
    expect(localEngine.clearQueue).toHaveBeenCalledTimes(1);
  });

  it('invalidates a batch awaiting settings so fast maintenance cannot redownload the model', async () => {
    let releaseSettings!: (value: Record<string, unknown>) => void;
    (globalThis.chrome.storage.local.get as Mock).mockImplementationOnce(
      () => new Promise<Record<string, unknown>>(resolve => { releaseSettings = resolve; }),
    );
    const resolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'stale pre-inference post',
      cacheKey: 'stale-pre-inference-post',
      resolve,
      tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    scheduleBatch();
    await vi.waitFor(() => expect(globalThis.chrome.storage.local.get).toHaveBeenCalled());

    await runModelMaintenance(vi.fn().mockResolvedValue(undefined));
    releaseSettings({
      enabled: true,
      selectedModel: `local:${E2B_MODEL_ID}`,
      descriptions_twitter: ['Sports'],
    });

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({
      retry: true,
      reasoning: 'Local model maintenance in progress.',
      retryAfterMs: 250,
    }));
    expect(mockCallLocalInference).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'stale-pre-inference-post')).toBe(false);
    setActiveTab(null);
  });

  it.each(['Inference preempted', 'Inference queue cleared'])(
    'resolves a shifted in-flight item with a maintenance retry on %s',
    async (inferenceError) => {
      (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
        selectedModel: `local:${E2B_MODEL_ID}`,
        descriptions_twitter: ['Sports'],
      });
      (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
      let rejectInference!: (error: Error) => void;
      mockCallLocalInference.mockImplementation(() => new Promise((_resolve, reject) => {
        rejectInference = reject;
      }));
      const resolve = vi.fn();
      const duplicateResolve = vi.fn();
      enqueuePost(TAB_ID, makePendingItem({
        post: 'in-flight post',
        cacheKey: 'in-flight-post',
        resolve,
        tabId: TAB_ID,
      }));
      expect(enqueuePost(TAB_ID, makePendingItem({
        post: 'in-flight duplicate',
        cacheKey: 'in-flight-post',
        resolve: duplicateResolve,
        tabId: TAB_ID,
      }))).toBe(true);
      setActiveTab(TAB_ID);
      scheduleBatch();
      await vi.waitFor(() => expect(mockCallLocalInference).toHaveBeenCalledTimes(1));

      let finishDelete!: () => void;
      const deleteModel = vi.fn(() => new Promise<void>(finish => {
        finishDelete = finish;
      }));
      const maintenance = runModelMaintenance(deleteModel);
      expect(localEngineState.maintaining).toBe(true);
      rejectInference(new Error(inferenceError));

      await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({
        retry: true,
        reasoning: 'Local model maintenance in progress.',
        retryAfterMs: 250,
      }));
      expect(duplicateResolve).toHaveBeenCalledWith({
        retry: true,
        reasoning: 'Local model maintenance in progress.',
        retryAfterMs: 250,
      });
      expect(isKeyPending(TAB_ID, 'in-flight-post')).toBe(false);

      finishDelete();
      await expect(maintenance).resolves.toBeUndefined();
      expect(localEngineState.maintaining).toBe(false);
      setActiveTab(null);
    },
  );
});

describe('local runtime error recovery', () => {
  const TAB_ID = 25;

  beforeEach(async () => {
    clearTabQueue(TAB_ID);
    setActiveTab(null);
    await clearErrorState();
    vi.clearAllMocks();
    initPipeline(new Set([TAB_ID]));
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
      selectedModel: `local:${E2B_MODEL_ID}`,
      descriptions_twitter: ['Sports'],
    });
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
  });

  it.each(['GPU device lost', 'RESOURCE_EXHAUSTED']) (
    'surfaces %s as a retryable local-model error and clears it on recovery',
    async (runtimeError) => {
      mockCallLocalInference.mockRejectedValueOnce(new Error(runtimeError));
      const resolve = vi.fn();
      enqueuePost(TAB_ID, makePendingItem({
        post: `post failing with ${runtimeError}`,
        cacheKey: `runtime-error-${runtimeError}`,
        resolve,
        tabId: TAB_ID,
      }));

      setActiveTab(TAB_ID);
      scheduleBatch();

      await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({
        error: 'local_model',
        reasoning: runtimeError,
      }));
      expect(errorState).toEqual({ type: 'local_model', count: 1 });
      await vi.waitFor(() => expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(
        TAB_ID,
        { type: 'errorStatusUpdate', errorType: 'local_model', count: 1 },
      ));

      await triggerErrorRetry();

      expect(errorState).toEqual({ type: null, count: 0 });
      expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(
        TAB_ID,
        { type: 'errorStatusUpdate', errorType: null, count: 0 },
      );
      expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(
        TAB_ID,
        { type: 'reEvaluateErrors' },
      );
      expect(isKeyPending(TAB_ID, `runtime-error-${runtimeError}`)).toBe(false);
      setActiveTab(null);
    },
  );

  it('bounds transient automatic retries and blocks persistent GPU retry loops', () => {
    expect(localErrorRetryDelay('temporary runtime failure', 0)).toBe(5_000);
    expect(localErrorRetryDelay('temporary runtime failure', 1)).toBe(10_000);
    expect(localErrorRetryDelay('temporary runtime failure', 2)).toBeNull();
    expect(localErrorRetryDelay('GPU device lost', 0)).toBeNull();
    expect(localErrorRetryDelay('RESOURCE_EXHAUSTED', 0)).toBeNull();
    expect(localErrorRetryDelay('Inference timeout - model took too long', 0)).toBeNull();
  });

  it('releases content-side error posts after explicit Retry on a fresh worker', async () => {
    expect(errorState).toEqual({ type: null, count: 0 });

    await triggerErrorRetry(true, true);

    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(
      TAB_ID,
      { type: 'errorStatusUpdate', errorType: null, count: 0 },
    );
    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(
      TAB_ID,
      { type: 'reEvaluateErrors' },
    );
  });
});

describe('filter cache invalidation', () => {
  const TAB_ID = 26;

  beforeEach(async () => {
    clearTabQueue(TAB_ID);
    setActiveTab(null);
    await clearEvaluationCache();
    vi.clearAllMocks();
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
      selectedModel: `local:${E2B_MODEL_ID}`,
      descriptions_twitter: ['Sports'],
      stats: { filtered: 0, evaluated: 0, totalCost: 0 },
    });
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
  });

  it('preempts stale work and fences a filter change before cold-load decode starts', async () => {
    let releaseInferenceStart!: () => void;
    let decodeStarted = false;
    mockCallLocalInference.mockImplementation((_post, _categories, _config, _model, options) => (
      new Promise((resolve, reject) => {
        releaseInferenceStart = () => {
          try {
            options?.onInferenceStart?.();
            decodeStarted = true;
            resolve({ shouldHide: true, reasoning: 'stale filter result', rawResponse: 'yes' });
          } catch (error) {
            reject(error);
          }
        };
      })
    ));
    const resolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'filter changes while model loads',
      cacheKey: 'filter-change-before-decode',
      resolve,
      tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    scheduleBatch();
    await vi.waitFor(() => expect(releaseInferenceStart).toBeTypeOf('function'));

    await handleFilterPackChange();

    expect(localEngine.preempt).toHaveBeenCalledTimes(1);
    releaseInferenceStart();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({
      retry: true,
      reasoning: 'Local model maintenance in progress.',
      retryAfterMs: 250,
    }));
    expect(decodeStarted).toBe(false);
    expect(evaluationCache.size).toBe(0);
    setActiveTab(null);
  });

  it('serializes a clear after an older cache save and leaves persisted state empty', async () => {
    evaluationCache.set('old-filter-result', {
      shouldHide: true,
      reasoning: 'old rules',
    });
    let releaseOldWrite!: () => void;
    (globalThis.chrome.storage.local.set as Mock).mockImplementationOnce(
      () => new Promise<void>(resolve => { releaseOldWrite = resolve; }),
    );

    const oldSave = saveCache();
    await vi.waitFor(() => expect(globalThis.chrome.storage.local.set).toHaveBeenCalledTimes(1));
    const clear = clearEvaluationCache();
    await Promise.resolve();
    expect(globalThis.chrome.storage.local.set).toHaveBeenCalledTimes(1);

    releaseOldWrite();
    await oldSave;
    await clear;

    expect(globalThis.chrome.storage.local.set).toHaveBeenLastCalledWith({ evaluationCache: {} });
    expect(evaluationCache.size).toBe(0);
  });

  it('returns retry instead of a stale verdict when filters change during stats storage', async () => {
    mockCallLocalInference.mockResolvedValue({
      shouldHide: true,
      reasoning: 'matched old filter',
      rawResponse: 'yes',
    });
    let releaseStatsWrite!: () => void;
    (globalThis.chrome.storage.local.set as Mock).mockImplementation(
      (items: Record<string, unknown>) => {
        if ('stats' in items && !releaseStatsWrite) {
          return new Promise<void>(resolve => { releaseStatsWrite = resolve; });
        }
        return Promise.resolve();
      },
    );
    const resolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'old filter should have hidden this',
      cacheKey: 'stale-filter-result',
      resolve,
      tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    scheduleBatch();
    await vi.waitFor(() => expect(releaseStatsWrite).toBeTypeOf('function'));

    await handleFilterPackChange();
    releaseStatsWrite();

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({
      retry: true,
      reasoning: 'Local model or filter settings changed during evaluation.',
      retryAfterMs: 250,
    }));
    expect(resolve).not.toHaveBeenCalledWith(expect.objectContaining({ shouldHide: true }));
    expect(evaluationCache.size).toBe(0);
    setActiveTab(null);
  });

  it('publishes a successful verdict when only stats persistence fails', async () => {
    mockCallLocalInference.mockResolvedValue({
      shouldHide: true,
      reasoning: 'healthy model verdict',
      rawResponse: 'yes',
    });
    const statsFailure = new Error('stats storage unavailable');
    (globalThis.chrome.storage.local.set as Mock).mockImplementation(
      (items: Record<string, unknown>) => (
        'stats' in items ? Promise.reject(statsFailure) : Promise.resolve()
      ),
    );
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const resolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'model succeeds while stats storage fails',
      cacheKey: 'stats-write-failure',
      resolve,
      tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    scheduleBatch();

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      shouldHide: true,
      reasoning: 'healthy model verdict',
    })));

    expect(errorState).toEqual({ type: null, count: 0 });
    expect(localEngine.markTerminalError).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      '[Stats] Failed to update evaluation counters:',
      statsFailure,
    );
    logError.mockRestore();
    setActiveTab(null);
  });
});

describe('suggestAnnoyingReasons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
      selectedModel: `local:${E2B_MODEL_ID}`,
      descriptions_twitter: [],
    });
    vi.mocked(localEngine.ensureLoaded).mockResolvedValue(undefined);
  });

  it('cleans markdown and validates Gemma candidates in one batched call', async () => {
    vi.mocked(localEngine.generate).mockResolvedValue(
      '1. **rage bait**\n- `smug dunking`\n• "crypto"\n4) _hostile tone_',
    );
    mockCallLocalInference.mockResolvedValue({
      shouldHide: true,
      reasoning: 'matched',
      rawResponse: '| yes | no | yes | no',
    });

    const result = await suggestAnnoyingReasons('post', 'twitter', 7);

    expect(result).toEqual(['rage bait', 'crypto']);
    expect(mockCallLocalInference).toHaveBeenCalledTimes(1);
    expect(mockCallLocalInference.mock.calls[0][1]).toEqual([
      'rage bait', 'smug dunking', 'crypto', 'hostile tone',
    ]);
    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not restart a deleted model when fast maintenance spans settings loading', async () => {
    let releaseSettings!: (value: Record<string, unknown>) => void;
    (globalThis.chrome.storage.local.get as Mock).mockImplementationOnce(
      () => new Promise<Record<string, unknown>>(resolve => { releaseSettings = resolve; }),
    );
    const suggestion = suggestAnnoyingReasons('post', 'twitter');
    const suggestionAssertion = expect(suggestion).rejects.toThrow(
      'Local model maintenance in progress',
    );
    await vi.waitFor(() => expect(globalThis.chrome.storage.local.get).toHaveBeenCalled());

    await runModelMaintenance(vi.fn().mockResolvedValue(undefined));
    releaseSettings({
      selectedModel: `local:${E2B_MODEL_ID}`,
      descriptions_twitter: [],
    });

    await suggestionAssertion;
    expect(localEngine.ensureLoaded).not.toHaveBeenCalled();
    expect(localEngine.generate).not.toHaveBeenCalled();
  });

  it('only removes surrounding formatting from candidate phrases', () => {
    expect(parseCandidatePhrases('1. **don\'t engage**\n- `web_3 outrage`\n• “smug dunking”', 9))
      .toEqual(["don't engage", 'web_3 outrage', 'smug dunking']);
  });

  it('falls back to per-phrase validation when the batched Gemma row is malformed', async () => {
    vi.mocked(localEngine.generate).mockResolvedValue('rage bait\nsmug dunking\ncrypto');
    mockCallLocalInference
      .mockResolvedValueOnce({ shouldHide: false, reasoning: 'bad', rawResponse: '| yes | no' })
      .mockResolvedValue({ shouldHide: true, reasoning: 'matched', rawResponse: 'yes' });

    const result = await suggestAnnoyingReasons('post', 'twitter');

    expect(result).toEqual(['rage bait', 'smug dunking', 'crypto']);
    expect(mockCallLocalInference).toHaveBeenCalledTimes(4);
    expect(mockCallLocalInference.mock.calls[0][1]).toHaveLength(3);
    expect(mockCallLocalInference.mock.calls.slice(1).every(call => call[1].length === 1)).toBe(true);
  });

  it('propagates a batched LiteRT runtime error without spawning per-phrase calls', async () => {
    vi.mocked(localEngine.generate).mockResolvedValue('rage bait\nsmug dunking\ncrypto');
    mockCallLocalInference.mockRejectedValueOnce(new Error('GPU device lost'));

    await expect(suggestAnnoyingReasons('post', 'twitter')).rejects.toThrow('GPU device lost');
    expect(mockCallLocalInference).toHaveBeenCalledTimes(1);
  });

  it('propagates an operational error from per-phrase malformed-batch fallback', async () => {
    vi.mocked(localEngine.generate).mockResolvedValue('rage bait\nsmug dunking\ncrypto');
    mockCallLocalInference
      .mockResolvedValueOnce({ shouldHide: false, reasoning: 'bad', rawResponse: '| yes | no' })
      .mockRejectedValueOnce(new Error('Local model maintenance in progress'));

    await expect(suggestAnnoyingReasons('post', 'twitter'))
      .rejects.toThrow('Local model maintenance in progress');
    expect(mockCallLocalInference).toHaveBeenCalledTimes(2);
  });

  it('does not invoke the model for an image-only/empty-text suggestion', async () => {
    await expect(suggestAnnoyingReasons('   ', 'twitter')).resolves.toEqual([]);
    expect(localEngine.generate).not.toHaveBeenCalled();
    expect(mockCallLocalInference).not.toHaveBeenCalled();
  });
});
