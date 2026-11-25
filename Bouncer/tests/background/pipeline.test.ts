import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

const localEngineState = vi.hoisted(() => ({
  epoch: 0,
}));

// Mock Chrome APIs used by pipeline.js and its imports
globalThis.chrome = {
  storage: {
    local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) },
    onChanged: { addListener: vi.fn() },
  },
  tabs: { sendMessage: vi.fn().mockResolvedValue({}) },
  runtime: { id: 'test-extension-id', onMessage: { addListener: vi.fn() } },
} as unknown as typeof chrome;

// Mock local-model.js so pipeline tests do not initialize the native service.
vi.mock('../../src/background/local-model.js', () => ({
  STALE_WORK_ERROR: 'Stale work',
  callLocalInference: vi.fn(),
  localEngine: {
    getClassifierFingerprint: () => 'synthetic-decision-fingerprint',
    get operationEpoch() { return localEngineState.epoch; },
    assertOperationEpoch: (expected: number) => {
      if (expected !== localEngineState.epoch) throw new Error('Stale work');
    },
    invalidate: vi.fn(() => { localEngineState.epoch++; }),
    clearQueue: vi.fn(),
  },
}));

import {
  enqueuePost,
  isKeyPending,
  clearTabQueue,
  setActiveTab,
  scheduleBatch,
  prioritizeByViewportDistance,
  initPipeline,
  errorState,
  clearErrorState,
  handleFilterChange,
  handleSettingsChange,
  clearEvaluationCache,
  evaluationCache,
  saveCache,
  readCachedEvaluation,
  requiresLocalInference,
} from '../../src/background/pipeline.js';
import { localEngine, callLocalInference } from '../../src/background/local-model.js';
import type { PendingEvaluation } from '../../src/types.js';

const mockCallLocalInference = vi.mocked(callLocalInference);
const DECISION_MODEL_ID = 'synthetic-decision-model';

type InferenceResult = Awaited<ReturnType<typeof callLocalInference>>;
function inferenceResult(overrides: Partial<InferenceResult> = {}): InferenceResult {
  return {
    shouldHide: false, reasoning: 'automatic verdict', category: null, matches: [],
    rawResponse: 'no', inferenceTime: 0,
    engine: 'llama.app',
    modelId: DECISION_MODEL_ID,
    classifierFingerprint: 'synthetic-decision-fingerprint',
    ...overrides,
  };
}

describe('requiresLocalInference', () => {
  it('does not require native inference when filtering is disabled or no filters exist', () => {
    expect(requiresLocalInference({ enabled: false, descriptions: ['Sports'] })).toBe(false);
    expect(requiresLocalInference({ enabled: true, descriptions: [] })).toBe(false);
    expect(requiresLocalInference({ enabled: true, descriptions: ['Sports'] })).toBe(true);
  });
});

beforeEach(() => {
  localEngineState.epoch = 0;
});

afterEach(async () => {
  await clearEvaluationCache();
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

  it('keeps the engine epoch and pending requests unchanged through focus changes', () => {
    const epoch = localEngine.operationEpoch;
    setActiveTab(1);
    setActiveTab(2);
    setActiveTab(null);
    expect(localEngine.operationEpoch).toBe(epoch);
    expect(localEngine.invalidate).not.toHaveBeenCalled();
    expect(localEngine.clearQueue).not.toHaveBeenCalled();
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

// ==================== Serial processing and tab ownership ====================

describe('serial processing and tab ownership', () => {
  const TAB_ID = 10;
  const flush = () => new Promise(r => setTimeout(r, 100));

  beforeEach(() => {
    clearTabQueue(TAB_ID);
    clearTabQueue(TAB_ID + 1);
    setActiveTab(null);
    vi.clearAllMocks();

    // Mock storage to return local model settings with descriptions
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
            descriptions_twitter: ['Sports'],
    });
    // Mock tabs.sendMessage for prioritizeByViewportDistance
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
  });

  it('drops the in-flight result when its tab closes', async () => {
    // Simulate: callLocalInference is called, tab closes (clearTabQueue), then inference rejects
    mockCallLocalInference.mockImplementation(async () => {
      clearTabQueue(TAB_ID);
      throw new Error('Stale work');
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
      throw new Error('Stale work');
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
    rejectInference(new Error('Stale work'));
    await vi.waitFor(() => expect(originalResolve).toHaveBeenCalledWith(null));
  });

  it('finishes the current response and immediately processes the newly active tab', async () => {
    vi.useFakeTimers();
    const OTHER_TAB_ID = TAB_ID + 1;
    let finishOldInference!: (result: InferenceResult) => void;
    mockCallLocalInference
      .mockImplementationOnce(() => new Promise(resolve => { finishOldInference = resolve; }))
      .mockResolvedValueOnce(inferenceResult({ reasoning: 'new tab result' }));
    const oldResolve = vi.fn();
    const newResolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'old active tab', cacheKey: 'old-active-tab', resolve: oldResolve, tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockCallLocalInference).toHaveBeenCalledTimes(1);
    const epoch = localEngine.operationEpoch;
    enqueuePost(OTHER_TAB_ID, makePendingItem({
      post: 'new active tab', cacheKey: 'new-active-tab', resolve: newResolve, tabId: OTHER_TAB_ID,
    }));
    setActiveTab(OTHER_TAB_ID);
    scheduleBatch();
    expect(localEngine.operationEpoch).toBe(epoch);
    expect(mockCallLocalInference).toHaveBeenCalledTimes(1);
    finishOldInference(inferenceResult({ shouldHide: true, reasoning: 'old tab result' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(oldResolve).toHaveBeenCalledWith(expect.objectContaining({ shouldHide: true, reasoning: 'old tab result' }));
    expect(newResolve).toHaveBeenCalledWith(expect.objectContaining({ shouldHide: false, reasoning: 'new tab result' }));
    expect(mockCallLocalInference).toHaveBeenCalledTimes(2);
    expect(isKeyPending(TAB_ID, 'old-active-tab')).toBe(false);
    setActiveTab(null);
    clearTabQueue(TAB_ID);
    clearTabQueue(OTHER_TAB_ID);
    vi.useRealTimers();
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
    mockCallLocalInference.mockResolvedValue(inferenceResult({
      shouldHide: false,
      reasoning: 'new tab result',
      rawResponse: 'no',
    }));

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
    );
    expect(oldResolve).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'old-preparation')).toBe(true);

    setActiveTab(null);
    clearTabQueue(TAB_ID);
    clearTabQueue(OTHER_TAB_ID);
  });

  it('finishes readiness for the current post through a tab switch', async () => {
    const OTHER_TAB_ID = TAB_ID + 1;
    let releaseOldStart!: () => void;
    mockCallLocalInference.mockImplementation((postData, _categories, options) => {
      if (postData.text === 'old tab loading model') {
        return new Promise((resolve, reject) => {
          releaseOldStart = () => {
            try {
              options?.assertCurrent?.();
              resolve(inferenceResult({ shouldHide: false, reasoning: 'current post result', rawResponse: 'no' }));
            } catch (error) {
              reject(error);
            }
          };
        });
      }
      options?.assertCurrent?.();
      return Promise.resolve(inferenceResult({ shouldHide: false, reasoning: 'new tab result', rawResponse: 'no' }));
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
    expect(oldResolve).toHaveBeenCalledWith(expect.objectContaining({ shouldHide: false, reasoning: 'current post result' }));
    expect(isKeyPending(TAB_ID, 'old-model-load')).toBe(false);

    setActiveTab(null);
    clearTabQueue(TAB_ID);
    clearTabQueue(OTHER_TAB_ID);
  });

  it('publishes a completed response when focus changes during stats persistence', async () => {
    mockCallLocalInference.mockResolvedValueOnce(inferenceResult({ shouldHide: true, matches: ['Sports'] }));
    let releaseStats!: () => void;
    (globalThis.chrome.storage.local.set as Mock).mockImplementation((items: Record<string, unknown>) => {
      if ('stats' in items) return new Promise<void>(resolve => { releaseStats = resolve; });
      return Promise.resolve();
    });
    const resolve = vi.fn();
    enqueuePost(TAB_ID, makePendingItem({
      post: 'post retired during stats write', cacheKey: 'stats-tab-change', resolve, tabId: TAB_ID,
    }));
    setActiveTab(TAB_ID);
    await vi.waitFor(() => expect(releaseStats).toBeTypeOf('function'));
    setActiveTab(null);
    releaseStats();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ shouldHide: true })));
    expect(isKeyPending(TAB_ID, 'stats-tab-change')).toBe(false);
    expect(evaluationCache.size).toBe(1);
    clearTabQueue(TAB_ID);
    (globalThis.chrome.storage.local.set as Mock).mockResolvedValue(undefined);
  });

  it('resolves a bounded retry when settings storage fails and accepts later work', async () => {
    const storageError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (globalThis.chrome.storage.local.get as Mock)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue({
                descriptions_twitter: ['Sports'],
      });
    mockCallLocalInference.mockResolvedValue(inferenceResult({
      shouldHide: false,
      reasoning: 'no match',
      rawResponse: 'no',
    }));
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

describe('pause invalidation', () => {
  it('retires a batch awaiting settings before native inference starts', async () => {
    const tabId = 24;
    clearTabQueue(tabId);
    setActiveTab(null);
    vi.clearAllMocks();
    let releaseSettings!: (value: Record<string, unknown>) => void;
    (globalThis.chrome.storage.local.get as Mock).mockImplementationOnce(
      () => new Promise<Record<string, unknown>>(resolve => { releaseSettings = resolve; }),
    );
    const resolve = vi.fn();
    enqueuePost(tabId, makePendingItem({ post: 'post awaiting pause', cacheKey: 'pause-awaiting-settings', resolve, tabId }));
    setActiveTab(tabId);
    await vi.waitFor(() => expect(releaseSettings).toBeTypeOf('function'));
    await handleSettingsChange({ enabled: { oldValue: true, newValue: false } });
    releaseSettings({ enabled: true, descriptions_twitter: ['Sports'] });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({
      retry: true, reasoning: 'Settings changed, re-evaluating...', retryAfterMs: 250,
    }));
    expect(mockCallLocalInference).not.toHaveBeenCalled();
    expect(localEngine.invalidate).toHaveBeenCalledOnce();
    expect(isKeyPending(tabId, 'pause-awaiting-settings')).toBe(false);
    setActiveTab(null);
  });
});

describe('per-post local runtime failures', () => {
  const TAB_ID = 25;

  beforeEach(async () => {
    clearTabQueue(TAB_ID);
    setActiveTab(null);
    await clearErrorState();
    vi.clearAllMocks();
    initPipeline(new Set([TAB_ID]));
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({ descriptions_twitter: ['Sports'] });
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
  });

  it.each(['HTTP 500', 'Request timed out', 'Connection refused', 'Malformed decision']) (
    'leaves a failed %s post visible and processes the next post without recovery',
    async runtimeError => {
      mockCallLocalInference.mockRejectedValueOnce(new Error(runtimeError));
      const failed = vi.fn();
      enqueuePost(TAB_ID, makePendingItem({
        post: `post failing with ${runtimeError}`, cacheKey: `failed-${runtimeError}`,
        resolve: failed, tabId: TAB_ID,
      }));
      setActiveTab(TAB_ID);
      await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({ error: 'local_model', reasoning: runtimeError }));
      expect(errorState).toEqual({ type: 'local_model', count: 1 });
      expect(evaluationCache.size).toBe(0);
      expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(TAB_ID, {
        type: 'detectorResponse', evaluationId: 'eval-default', detectorName: 'filter', error: runtimeError,
      });

      mockCallLocalInference.mockResolvedValueOnce(inferenceResult({ shouldHide: true, matches: ['Sports'] }));
      const next = vi.fn();
      enqueuePost(TAB_ID, makePendingItem({
        post: `next post after ${runtimeError}`, cacheKey: `next-${runtimeError}`,
        resolve: next, tabId: TAB_ID,
      }));
      scheduleBatch();
      await vi.waitFor(() => expect(next).toHaveBeenCalledWith(expect.objectContaining({ shouldHide: true })));
      expect(mockCallLocalInference).toHaveBeenCalledTimes(2);
      expect(errorState).toEqual({ type: null, count: 0 });
      expect(globalThis.chrome.storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
      setActiveTab(null);
    },
  );
});

describe('filter cache invalidation', () => {
  const TAB_ID = 26;

  beforeEach(async () => {
    clearTabQueue(TAB_ID);
    setActiveTab(null);
    await clearEvaluationCache();
    vi.clearAllMocks();
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
            descriptions_twitter: ['Sports'],
      stats: { filtered: 0, evaluated: 0, totalCost: 0 },
    });
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
  });

  it('invalidates stale work before classification starts after a filter change', async () => {
    let releaseInferenceStart!: () => void;
    let decodeStarted = false;
    mockCallLocalInference.mockImplementation((_post, _categories, options) => (
      new Promise((resolve, reject) => {
        releaseInferenceStart = () => {
          try {
            options?.assertCurrent?.();
            decodeStarted = true;
            resolve(inferenceResult({ shouldHide: true, reasoning: 'stale filter result', rawResponse: 'yes' }));
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

    await handleFilterChange();

    expect(localEngine.invalidate).toHaveBeenCalledTimes(1);
    releaseInferenceStart();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({
      retry: true,
      reasoning: 'Local model or filter settings changed during evaluation.',
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
    mockCallLocalInference.mockResolvedValue(inferenceResult({
      shouldHide: true,
      reasoning: 'matched old filter',
      rawResponse: 'yes',
    }));
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

    await handleFilterChange();
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
    mockCallLocalInference.mockResolvedValue(inferenceResult({
      shouldHide: true,
      reasoning: 'healthy model verdict',
      rawResponse: 'yes',
    }));
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
    expect(logError).toHaveBeenCalledWith(
      '[Stats] Failed to update evaluation counters:',
      statsFailure,
    );
    logError.mockRestore();
    setActiveTab(null);
  });
});

describe('selected automatic cache identity', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('accepts only the current fingerprint and always accepts settled manual decisions', async () => {
    evaluationCache.set('unverified', { shouldHide: false, reasoning: 'unverified result' });
    evaluationCache.set('stale', { shouldHide: false, reasoning: 'stale negative', classifierFingerprint: 'old-decision' });
    evaluationCache.set('current', { shouldHide: false, reasoning: 'current', engine: 'llama.app', classifierFingerprint: 'synthetic-decision-fingerprint' });
    evaluationCache.set('manual', { shouldHide: true, reasoning: 'manual hide', userOverride: true });
    expect(await readCachedEvaluation('unverified')).toBeUndefined();
    expect(await readCachedEvaluation('stale')).toBeUndefined();
    expect(await readCachedEvaluation('current')).toMatchObject({ shouldHide: false });
    expect(await readCachedEvaluation('manual')).toMatchObject({ userOverride: true, shouldHide: true });
  });

  it('rejects an old llama.app fingerprint while preserving current and manual decisions', async () => {
    evaluationCache.set('native', { shouldHide: true, reasoning: 'native match', engine: 'llama.app', classifierFingerprint: 'synthetic-decision-fingerprint' });
    evaluationCache.set('retired', { shouldHide: false, reasoning: 'retired classifier', engine: 'llama.app', classifierFingerprint: 'retired-fingerprint' });
    evaluationCache.set('manual', { shouldHide: false, reasoning: 'restored by you', userOverride: true });
    expect(await readCachedEvaluation('native')).toMatchObject({ shouldHide: true });
    expect(await readCachedEvaluation('retired')).toBeUndefined();
    expect(await readCachedEvaluation('manual')).toMatchObject({ shouldHide: false, userOverride: true });
    expect(mockCallLocalInference).not.toHaveBeenCalled();
  });

  it('dispatches a malformed classification as an error without negative cache or successful stats', async () => {
    clearTabQueue(77);
    setActiveTab(null);
    await clearErrorState();
    vi.clearAllMocks();
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({ descriptions_twitter: ['Sports'] });
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
    mockCallLocalInference.mockRejectedValueOnce(new Error('The classifier returned malformed output.'));
    const resolve = vi.fn();
    enqueuePost(77, makePendingItem({ post: 'malformed post', cacheKey: 'malformed post', resolve, tabId: 77 }));
    setActiveTab(77);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ error: 'local_model' })));
    expect(evaluationCache.size).toBe(0);
    expect(globalThis.chrome.storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({ stats: expect.anything() }));
    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(77, expect.objectContaining({ type: 'evaluationStarted', detectorNames: ['filter'] }));
    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(77, expect.objectContaining({ type: 'detectorResponse', error: expect.any(String) }));
    setActiveTab(null);
  });
});
