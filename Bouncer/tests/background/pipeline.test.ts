import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Mock Chrome APIs used by pipeline.js and its imports
globalThis.chrome = {
  storage: {
    local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) },
    onChanged: { addListener: vi.fn() },
  },
  tabs: { sendMessage: vi.fn().mockResolvedValue({}) },
  runtime: { id: 'test-extension-id', onMessage: { addListener: vi.fn() } },
} as unknown as typeof chrome;

// Mock auth module to prevent Firebase initialization
vi.mock('../../src/background/auth.js', () => ({
  getAuthToken: vi.fn().mockResolvedValue(null),
}));

// Mock local-model.js to avoid WebLLM dependencies
vi.mock('../../src/background/local-model.js', () => ({
  callLocalInference: vi.fn(),
  localEngine: {
    isInitializing: () => false,
    isModelLoaded: () => false,
    clearQueue: vi.fn(),
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn(),
  },
}));

// Mock providers.js
vi.mock('../../src/background/providers.js', () => ({
  callDirectAPI: vi.fn(),
  callImbueAPI: vi.fn(),
}));

import {
  classifyError,
  enqueuePost,
  isKeyPending,
  clearTabQueue,
  setActiveTab,
  scheduleBatch,
  prioritizeByViewportDistance,
  parseCandidatePhrases,
  suggestAnnoyingReasons,
} from '../../src/background/pipeline.js';
import { localEngine, callLocalInference } from '../../src/background/local-model.js';
import type { PendingEvaluation } from '../../src/types.js';

const mockCallLocalInference = vi.mocked(callLocalInference);

/** Create a PendingEvaluation with sensible defaults. */
function makePendingItem(overrides: Partial<PendingEvaluation> & { post: string; cacheKey: string; resolve: PendingEvaluation['resolve'] }): PendingEvaluation {
  return {
    evaluationId: 'eval-default',
    imageUrls: [],
    rawText: overrides.post,
    tabId: undefined,
    postUrl: null,
    siteId: 'twitter',
    ...overrides,
  };
}

describe('classifyError', () => {
  it('classifies "401 Unauthorized" as auth for external APIs', () => {
    const result = classifyError('401 Unauthorized', 'openai');
    expect(result.errorType).toBe('auth');
  });

  it('does not classify auth errors for local provider', () => {
    const result = classifyError('401 Unauthorized', 'local');
    expect(result.errorType).toBeNull();
  });

  it('classifies "503 Service Unavailable rate limit" as rate_limit (checked before api_error)', () => {
    const result = classifyError('503 Service Unavailable rate limit', 'openai');
    expect(result.errorType).toBe('rate_limit');
    expect(result.subType).toBe('generic');
  });

  it('classifies "HTTP 404 Not Found" as not_found', () => {
    const result = classifyError('HTTP 404 Not Found', 'openai');
    expect(result.errorType).toBe('not_found');
  });

  it('classifies "Internal Server Error 500" as server_error', () => {
    const result = classifyError('Internal Server Error 500', 'openai');
    expect(result.errorType).toBe('server_error');
  });

  it('auth takes priority over rate_limit for overlapping patterns', () => {
    const result = classifyError('Unauthorized 429', 'openai');
    expect(result.errorType).toBe('auth');
  });

  it('returns null errorType for unrecognized errors', () => {
    const result = classifyError('Something completely unknown happened', 'openai');
    expect(result.errorType).toBeNull();
    expect(result.subType).toBeNull();
  });
});

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
    vi.clearAllMocks();
  });

  it('calls localEngine.clearQueue', () => {
    setActiveTab(1);
    expect(localEngine.clearQueue).toHaveBeenCalled();
  });

  it('calls localEngine.clearQueue even when setting to null', () => {
    setActiveTab(null);
    expect(localEngine.clearQueue).toHaveBeenCalled();
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
      selectedModel: 'local:TestModel',
      descriptions_twitter: ['Sports'],
    });
    // Mock tabs.sendMessage for prioritizeByViewportDistance
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
  });

  it('re-queues items to original tab on inference queue cleared', async () => {
    mockCallLocalInference.mockRejectedValue(new Error('Inference queue cleared'));

    const resolve = vi.fn();
    enqueuePost(TAB_ID, { post: 'test post', imageUrls: [], cacheKey: 'test post', resolve, tabId: TAB_ID, postUrl: null, siteId: 'twitter' });

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
    enqueuePost(TAB_ID, { post: 'test post', imageUrls: [], cacheKey: 'test post', resolve, tabId: TAB_ID, postUrl: null, siteId: 'twitter' });

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
      enqueuePost(TAB_ID, { post: 'new page post', imageUrls: [], cacheKey: 'new_key', resolve: newResolve, tabId: TAB_ID, postUrl: null, siteId: 'twitter' });
      throw new Error('Inference queue cleared');
    });

    const oldResolve = vi.fn();
    enqueuePost(TAB_ID, { post: 'old post', imageUrls: [], cacheKey: 'old_key', resolve: oldResolve, tabId: TAB_ID, postUrl: null, siteId: 'twitter' });

    setActiveTab(TAB_ID);
    scheduleBatch();
    await flush();

    // Old item should be resolved with null (NOT re-queued into the new queue)
    expect(oldResolve).toHaveBeenCalledWith(null);
    // New item should be untouched in the new queue
    expect(newResolve).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'new_key')).toBe(true);
  });
});

describe('suggestAnnoyingReasons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
      selectedModel: 'local:gemma-4-E4B-it-web',
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

    const result = await suggestAnnoyingReasons('post', [], 'twitter', 7);

    expect(result).toEqual(['rage bait', 'crypto']);
    expect(mockCallLocalInference).toHaveBeenCalledTimes(1);
    expect(mockCallLocalInference.mock.calls[0][1]).toEqual([
      'rage bait', 'smug dunking', 'crypto', 'hostile tone',
    ]);
    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('only removes surrounding formatting from candidate phrases', () => {
    expect(parseCandidatePhrases('1. **don\'t engage**\n- `web_3 outrage`\n• “smug dunking”', 9))
      .toEqual(["don't engage", 'web_3 outrage', 'smug dunking']);
  });

  it('keeps Qwen validation on the per-phrase reasoning path', async () => {
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
      selectedModel: 'local:Qwen3_5-4B-q4f16_1-MLC',
      descriptions_twitter: [],
    });
    vi.mocked(localEngine.generate).mockResolvedValue('rage bait\nsmug dunking\ncrypto');
    mockCallLocalInference.mockResolvedValue({ shouldHide: true, reasoning: 'matched' });

    const result = await suggestAnnoyingReasons('post', [], 'twitter');

    expect(result).toEqual(['rage bait', 'smug dunking', 'crypto']);
    expect(mockCallLocalInference).toHaveBeenCalledTimes(3);
    expect(mockCallLocalInference.mock.calls.every(call => call[1].length === 1)).toBe(true);
  });

  it('falls back to per-phrase validation when the batched Gemma row is malformed', async () => {
    vi.mocked(localEngine.generate).mockResolvedValue('rage bait\nsmug dunking\ncrypto');
    mockCallLocalInference
      .mockResolvedValueOnce({ shouldHide: false, reasoning: 'bad', rawResponse: '| yes | no' })
      .mockResolvedValue({ shouldHide: true, reasoning: 'matched', rawResponse: 'yes' });

    const result = await suggestAnnoyingReasons('post', [], 'twitter');

    expect(result).toEqual(['rage bait', 'smug dunking', 'crypto']);
    expect(mockCallLocalInference).toHaveBeenCalledTimes(4);
    expect(mockCallLocalInference.mock.calls[0][1]).toHaveLength(3);
    expect(mockCallLocalInference.mock.calls.slice(1).every(call => call[1].length === 1)).toBe(true);
  });

  it('propagates a batched LiteRT runtime error without spawning per-phrase calls', async () => {
    vi.mocked(localEngine.generate).mockResolvedValue('rage bait\nsmug dunking\ncrypto');
    mockCallLocalInference.mockRejectedValueOnce(new Error('GPU device lost'));

    await expect(suggestAnnoyingReasons('post', [], 'twitter')).rejects.toThrow('GPU device lost');
    expect(mockCallLocalInference).toHaveBeenCalledTimes(1);
  });
});
