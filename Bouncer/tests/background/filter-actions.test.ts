import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentToBackgroundMessage, EvaluationResult } from '../../src/types';

const runtime = vi.hoisted(() => ({
  infer: vi.fn(),
  engine: {
    engine: null,
    loadedModel: null,
    syncAllStatuses: vi.fn().mockResolvedValue(undefined),
    checkCached: vi.fn().mockResolvedValue(true),
    isMaintaining: vi.fn(() => false),
    isModelLoaded: vi.fn(() => true),
    isInitializing: vi.fn(() => false),
    preempt: vi.fn(),
    clearQueue: vi.fn(),
    teardown: vi.fn(),
  },
}));

vi.mock('../../src/background/local-model.js', () => ({
  callLocalInference: runtime.infer,
  localEngine: runtime.engine,
  MODEL_MAINTENANCE_ERROR: 'Local model maintenance in progress',
}));
vi.mock('../../src/background/backends/litertlm-backend.js', () => ({
  forceCloseLitertlmOffscreen: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/background/model-migration.js', () => ({
  migrateToGemmaOnlyModel: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../src/background/benchmark.js', () => ({
  handleBenchmark: vi.fn().mockResolvedValue({}),
}));

type StorageChanges = Record<string, chrome.storage.StorageChange>;
let stored: Record<string, unknown>;
let onMessage: (
  message: ContentToBackgroundMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;
let onStorageChanged: (changes: StorageChanges, areaName: string) => void;
let pipeline: typeof import('../../src/background/pipeline');
let generateCacheKey: typeof import('../../src/shared/utils')['generateCacheKey'];
let writeStorage: ReturnType<typeof vi.fn>;
let readStorage: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function send(message: ContentToBackgroundMessage): Promise<unknown> {
  return new Promise(resolve => onMessage(message, { tab: { id: 1 } }, resolve));
}

function bounce(post: string, phrase?: string): Promise<unknown> {
  return send({ type: 'bouncePost', post, phrase, siteId: 'twitter' });
}

function cached(post: string): EvaluationResult | undefined {
  return (stored.evaluationCache as Record<string, EvaluationResult>)[generateCacheKey(post)];
}

async function evaluate(post: string): Promise<unknown> {
  return send({
    type: 'evaluatePost', evaluationId: `evaluation-${post}`,
    post, postUrl: null, siteId: 'twitter',
  });
}

async function deliverFilterEvent(before: string[], after: string[]): Promise<void> {
  onStorageChanged({ descriptions_twitter: { oldValue: before, newValue: after } }, 'local');
  // The listener waits on startup before joining the action chain.
  await Promise.resolve();
  await Promise.resolve();
  await send({ type: 'clearSinglePost', post: 'event-barrier-post' });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  stored = {
    enabled: true, selectedModel: 'local:gemma-4-E2B-it-web', filterReplies: true,
    descriptions_twitter: ['Sports'], evaluationCache: {},
    stats: { filtered: 0, evaluated: 0, totalCost: 0 },
  };
  readStorage = vi.fn(async (keys: string[]) => Object.fromEntries(
    keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]),
  ));
  writeStorage = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(stored, structuredClone(items));
  });
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: vi.fn(listener => { onMessage = listener; }) },
      onInstalled: { addListener: vi.fn() },
      onSuspend: { addListener: vi.fn() },
    },
    storage: {
      local: { get: readStorage, set: writeStorage, remove: vi.fn().mockResolvedValue(undefined) },
      onChanged: { addListener: vi.fn(listener => { onStorageChanged = listener; }) },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1 }]),
      sendMessage: vi.fn().mockResolvedValue({ positions: {} }),
      onActivated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: vi.fn() } },
  } as unknown as typeof chrome;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } });
  runtime.infer.mockResolvedValue({ shouldHide: false, reasoning: 'automatic verdict', matches: [] });
  pipeline = await import('../../src/background/pipeline');
  ({ generateCacheKey } = await import('../../src/shared/utils'));
  await import('../../src/background/index');
  await send({ type: 'getStats' });
});

afterEach(async () => {
  pipeline.clearTabQueue(1);
  pipeline.setActiveTab(null);
  // Retired module timers must not write into a later test's Chrome fixture.
  await pipeline.clearEvaluationCache().catch(() => undefined);
  vi.useRealTimers();
});

describe('atomic local Bounce actions', () => {
  it('reconciles visible phrase removal before accepting an old cache hit when its storage event is delayed', async () => {
    const post = 'cached post after its only rule was removed';
    pipeline.evaluationCache.set(generateCacheKey(post), {
      shouldHide: true, reasoning: 'old Sports match', matches: ['Sports'],
    });
    stored.descriptions_twitter = [];

    await expect(evaluate(post)).resolves.toMatchObject({ shouldHide: false });
    expect(runtime.infer).not.toHaveBeenCalled();
    expect(writeStorage).toHaveBeenCalledWith({ evaluationCache: {} });

    const clears = writeStorage.mock.calls.filter(([items]) => (
      'evaluationCache' in items && Object.keys(items.evaluationCache).length === 0
    )).length;
    await deliverFilterEvent(['Sports'], []);
    expect(writeStorage.mock.calls.filter(([items]) => (
      'evaluationCache' in items && Object.keys(items.evaluationCache).length === 0
    ))).toHaveLength(clears);
  });

  it('keeps a valid cache hit when evaluation observes the same effective phrase list', async () => {
    const post = 'cached post with unchanged rules';
    pipeline.evaluationCache.set(generateCacheKey(post), {
      shouldHide: true, reasoning: 'current Sports match', matches: ['Sports'],
    });

    await expect(evaluate(post)).resolves.toMatchObject({ shouldHide: true, cached: true, matches: ['Sports'] });
    expect(runtime.infer).not.toHaveBeenCalled();
    expect(writeStorage).not.toHaveBeenCalledWith({ evaluationCache: {} });
  });

  it.each([true, false])('reconciles a delayed filter event after preparation with current settings=%s', async (readsCurrentPhrases) => {
    const post = 'cached post whose phrase disappears during preparation';
    pipeline.evaluationCache.set(generateCacheKey(post), {
      shouldHide: true, reasoning: 'old Sports match', matches: ['Sports'],
    });
    const settingsRead = deferred<Record<string, unknown>>();
    const phraseRead = deferred<Record<string, unknown>>();
    let settingsPaused = false;
    let phrasesPaused = false;
    readStorage.mockImplementation(async (keys: string[]) => {
      if (keys.includes('enabled') && !settingsPaused) {
        settingsPaused = true;
        return settingsRead.promise;
      }
      if (settingsPaused && keys.includes('descriptions_twitter') && !phrasesPaused) {
        phrasesPaused = true;
        return phraseRead.promise;
      }
      return Object.fromEntries(keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]));
    });
    const result = evaluate(post);
    await vi.waitFor(() => expect(settingsPaused && phrasesPaused).toBe(true));
    stored.descriptions_twitter = [];
    settingsRead.resolve({ enabled: true, selectedModel: 'local:gemma-4-E2B-it-web', filterReplies: true });
    phraseRead.resolve({ descriptions_twitter: readsCurrentPhrases ? [] : ['Sports'] });

    await expect(result).resolves.toMatchObject({ shouldHide: false });
    expect(runtime.infer).not.toHaveBeenCalled();
    expect(writeStorage).toHaveBeenCalledWith({ evaluationCache: {} });
    const clears = writeStorage.mock.calls.filter(([items]) => (
      'evaluationCache' in items && Object.keys(items.evaluationCache).length === 0
    )).length;
    await deliverFilterEvent(['Sports'], []);
    expect(writeStorage.mock.calls.filter(([items]) => (
      'evaluationCache' in items && Object.keys(items.evaluationCache).length === 0
    ))).toHaveLength(clears);
  });

  it('invalidates loaded old-rule cache when a filter event races the startup phrase read', async () => {
    vi.resetModules();
    const descriptionsRead = deferred<Record<string, unknown>>();
    const oldKey = generateCacheKey('startup post with old verdict');
    stored.evaluationCache = { [oldKey]: { shouldHide: true, reasoning: 'old rule' } };
    let readingDescriptions = false;
    readStorage.mockImplementation(async (keys: string[]) => {
      if (keys.includes('descriptions_twitter') && !readingDescriptions) {
        readingDescriptions = true;
        return descriptionsRead.promise;
      }
      return Object.fromEntries(keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]));
    });
    pipeline = await import('../../src/background/pipeline');
    await import('../../src/background/index');
    await vi.waitFor(() => expect(readingDescriptions).toBe(true));
    stored.descriptions_twitter = ['Politics'];
    onStorageChanged({ descriptions_twitter: { oldValue: ['Sports'], newValue: ['Politics'] } }, 'local');
    descriptionsRead.resolve({ descriptions_twitter: ['Politics'] });
    await send({ type: 'getStats' });

    expect(pipeline.evaluationCache.size).toBe(0);
    expect(stored.evaluationCache).toEqual({});
  });

  it('waits for both the phrase write and complete invalidation before persisting the override', async () => {
    pipeline.evaluationCache.set('old-result', { shouldHide: true, reasoning: 'old rule' });
    const phraseWrite = deferred<void>();
    const clearWrite = deferred<void>();
    writeStorage.mockImplementation(async (items: Record<string, unknown>) => {
      if ('descriptions_twitter' in items) await phraseWrite.promise;
      if ('evaluationCache' in items && Object.keys(items.evaluationCache as object).length === 0) {
        await clearWrite.promise;
      }
      Object.assign(stored, structuredClone(items));
    });
    const action = bounce('chosen post', 'Crypto');
    await vi.waitFor(() => expect(writeStorage).toHaveBeenCalledWith({
      descriptions_twitter: ['Sports', 'Crypto'],
    }));
    expect(pipeline.evaluationCache.has('old-result')).toBe(true);
    expect(cached('chosen post')).toBeUndefined();

    phraseWrite.resolve();
    await vi.waitFor(() => expect(writeStorage).toHaveBeenCalledWith({ evaluationCache: {} }));
    expect(pipeline.evaluationCache.size).toBe(0);
    expect(cached('chosen post')).toBeUndefined();
    clearWrite.resolve();
    await expect(action).resolves.toEqual({ success: true });
    expect(cached('chosen post')).toMatchObject({
      shouldHide: true, userOverride: true, matches: ['Crypto'],
    });

    const clears = writeStorage.mock.calls.filter(([items]) => (
      'evaluationCache' in items && Object.keys(items.evaluationCache).length === 0
    )).length;
    await deliverFilterEvent(['Sports'], ['Sports', 'Crypto']);
    expect(cached('chosen post')?.userOverride).toBe(true);
    expect(writeStorage.mock.calls.filter(([items]) => (
      'evaluationCache' in items && Object.keys(items.evaluationCache).length === 0
    ))).toHaveLength(clears);
  });

  it('hides an already-present phrase without clearing unrelated cached posts', async () => {
    pipeline.evaluationCache.set('unrelated', { shouldHide: true, reasoning: 'another post' });
    await expect(bounce('existing phrase post', 'Sports')).resolves.toEqual({ success: true });
    expect(stored.descriptions_twitter).toEqual(['Sports']);
    expect(pipeline.evaluationCache.has('unrelated')).toBe(true);
    expect(cached('existing phrase post')?.shouldHide).toBe(true);
    expect(writeStorage).not.toHaveBeenCalledWith({ evaluationCache: {} });
    expect(writeStorage).not.toHaveBeenCalledWith(expect.objectContaining({ descriptions_twitter: expect.anything() }));
  });

  it('serializes concurrent additions so neither phrase is lost', async () => {
    const firstWrite = deferred<void>();
    writeStorage.mockImplementationOnce(async (items: Record<string, unknown>) => {
      await firstWrite.promise;
      Object.assign(stored, structuredClone(items));
    });
    const first = bounce('first chosen post', 'Crypto');
    const second = bounce('second chosen post', 'Politics');
    await vi.waitFor(() => expect(writeStorage).toHaveBeenCalledTimes(1));
    expect(readStorage.mock.calls.filter(([keys]) => keys.includes('descriptions_twitter'))).toHaveLength(2);
    firstWrite.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([{ success: true }, { success: true }]);
    expect(stored.descriptions_twitter).toEqual(['Sports', 'Crypto', 'Politics']);
    expect(cached('second chosen post')?.userOverride).toBe(true);
    await deliverFilterEvent(['Sports'], ['Sports', 'Crypto']);
    await deliverFilterEvent(['Sports', 'Crypto'], ['Sports', 'Crypto', 'Politics']);
    expect(cached('second chosen post')?.userOverride).toBe(true);
  });

  it.each(['phrase', 'clear', 'override'])('reports a failed %s write without claiming a successful Bounce', async (failureStage) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeStorage.mockImplementation(async (items: Record<string, unknown>) => {
      const fails = failureStage === 'phrase' ? 'descriptions_twitter' in items
        : failureStage === 'clear' ? 'evaluationCache' in items && Object.keys(items.evaluationCache as object).length === 0
          : 'evaluationCache' in items && Object.keys(items.evaluationCache as object).length > 0;
      if (fails) throw new Error(`${failureStage} unavailable`);
      Object.assign(stored, structuredClone(items));
    });
    await expect(bounce('failed action', 'Crypto')).resolves.toEqual({
      success: false, error: `${failureStage} unavailable`,
    });
    expect(cached('failed action')).toBeUndefined();
    expect(pipeline.evaluationCache.has(generateCacheKey('failed action'))).toBe(false);
    errorLog.mockRestore();
  });

  it('keeps full invalidation for a subsequent effective filter replacement', async () => {
    await bounce('post with manual override', 'Sports');
    stored.descriptions_twitter = ['Politics'];
    await deliverFilterEvent(['Sports'], ['Politics']);
    expect(pipeline.evaluationCache.size).toBe(0);
    expect(stored.evaluationCache).toEqual({});
    expect(runtime.engine.preempt).toHaveBeenCalled();
    expect(runtime.engine.clearQueue).toHaveBeenCalled();
  });
});

describe('explicit post decisions fence automatic work', () => {
  it('preserves a manual decision that starts between a settled cache miss and its await continuation', async () => {
    const post = 'manual decision at the asynchronous cache-miss boundary';
    const key = generateCacheKey(post);
    const manualWrite = deferred<void>();
    writeStorage.mockImplementationOnce(async (items: Record<string, unknown>) => {
      await manualWrite.promise;
      Object.assign(stored, structuredClone(items));
    });
    const originalGet = pipeline.evaluationCache.get.bind(pipeline.evaluationCache);
    let started = false;
    let manual!: Promise<void>;
    const cacheRead = vi.spyOn(pipeline.evaluationCache, 'get').mockImplementation(readKey => {
      const value = originalGet(readKey);
      if (readKey === key && !started) {
        started = true;
        // overridePost's normal loadCache continuation begins before the
        // automatic reader resumes from its already-settled cache miss.
        manual = pipeline.overridePost(post, true, 'durable manual decision');
      }
      return value;
    });
    pipeline.setActiveTab(1);
    const result = new Promise(resolve => pipeline.enqueuePost(1, {
      evaluationId: 'manual-at-cache-miss', post, cacheKey: key, resolve,
      tabId: 1, postUrl: null, siteId: 'twitter',
    }));
    pipeline.scheduleBatch();
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(runtime.infer).not.toHaveBeenCalled();
    } finally {
      manualWrite.resolve();
      await manual;
      cacheRead.mockRestore();
    }

    await expect(result).resolves.toMatchObject({
      shouldHide: true, userOverride: true, reasoning: 'durable manual decision',
    });
    expect(cached(post)).toMatchObject({
      shouldHide: true, userOverride: true, reasoning: 'durable manual decision',
    });
  });

  it.each([true, false])('direct cache-hit evaluation waits for a pending manual write with success=%s', async (succeeds) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const post = 'direct reader paused before pending manual decision';
    const key = generateCacheKey(post);
    pipeline.evaluationCache.set(key, { shouldHide: false, reasoning: 'settled automatic verdict' });
    await pipeline.saveCache();
    const settingsRead = deferred<Record<string, unknown>>();
    const manualWrite = deferred<void>();
    let settingsPaused = false;
    readStorage.mockImplementation(async (keys: string[]) => {
      if (keys.includes('enabled') && !settingsPaused) {
        settingsPaused = true;
        return settingsRead.promise;
      }
      return Object.fromEntries(keys.filter(storageKey => storageKey in stored).map(storageKey => [storageKey, structuredClone(stored[storageKey])]));
    });
    const result = evaluate(post);
    await vi.waitFor(() => expect(settingsPaused).toBe(true));
    writeStorage.mockImplementationOnce(async (items: Record<string, unknown>) => {
      await manualWrite.promise;
      if (!succeeds) throw new Error('manual cache unavailable');
      Object.assign(stored, structuredClone(items));
    });
    const action = bounce(post, 'Sports');
    await vi.waitFor(() => expect(pipeline.evaluationCache.get(key)?.userOverride).toBe(true));
    const settled = vi.fn();
    void result.then(settled);
    settingsRead.resolve({ enabled: true, selectedModel: 'local:gemma-4-E2B-it-web', filterReplies: true });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    manualWrite.resolve();

    await expect(action).resolves.toEqual(succeeds ? { success: true } : { success: false, error: 'manual cache unavailable' });
    await expect(result).resolves.toMatchObject({ shouldHide: succeeds, cached: true });
    expect(await result).toMatchObject(succeeds ? { userOverride: true } : { reasoning: 'settled automatic verdict' });
    expect(cached(post)?.shouldHide).toBe(succeeds);
    expect(runtime.infer).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it.each([true, false])('getReasoning waits and re-reads after a manual write with success=%s', async (succeeds) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const post = 'reasoning reader during pending manual decision';
    const key = generateCacheKey(post);
    pipeline.evaluationCache.set(key, { shouldHide: false, reasoning: 'settled automatic verdict' });
    await pipeline.saveCache();
    const manualWrite = deferred<void>();
    writeStorage.mockImplementationOnce(async (items: Record<string, unknown>) => {
      await manualWrite.promise;
      if (!succeeds) throw new Error('manual cache unavailable');
      Object.assign(stored, structuredClone(items));
    });
    const action = bounce(post, 'Sports');
    await vi.waitFor(() => expect(pipeline.evaluationCache.get(key)?.userOverride).toBe(true));
    const result = send({ type: 'getReasoning', post });
    const settled = vi.fn();
    void result.then(settled);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    manualWrite.resolve();

    await expect(action).resolves.toEqual(succeeds ? { success: true } : { success: false, error: 'manual cache unavailable' });
    await expect(result).resolves.toMatchObject({ found: true, shouldHide: succeeds });
    expect(await result).toMatchObject(succeeds ? { userOverride: true } : { reasoning: 'settled automatic verdict' });
    expect(cached(post)?.shouldHide).toBe(succeeds);
    errorLog.mockRestore();
  });

  it.each([true, false])('batch cache-hit waits for a pending manual write with success=%s', async (succeeds) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const post = 'batch reader paused before pending manual decision';
    const key = generateCacheKey(post);
    pipeline.evaluationCache.set(key, { shouldHide: false, reasoning: 'settled automatic verdict' });
    await pipeline.saveCache();
    const settingsRead = deferred<Record<string, unknown>>();
    const manualWrite = deferred<void>();
    let settingsPaused = false;
    readStorage.mockImplementation(async (keys: string[]) => {
      if (keys.includes('enabled') && !settingsPaused) {
        settingsPaused = true;
        return settingsRead.promise;
      }
      return Object.fromEntries(keys.filter(storageKey => storageKey in stored).map(storageKey => [storageKey, structuredClone(stored[storageKey])]));
    });
    pipeline.setActiveTab(1);
    const result = new Promise(resolve => {
      pipeline.enqueuePost(1, {
        evaluationId: 'pending-batch-cache-reader', post, cacheKey: key, resolve,
        tabId: 1, postUrl: null, siteId: 'twitter',
      });
    });
    pipeline.scheduleBatch();
    await vi.waitFor(() => expect(settingsPaused).toBe(true));
    writeStorage.mockImplementationOnce(async (items: Record<string, unknown>) => {
      await manualWrite.promise;
      if (!succeeds) throw new Error('manual cache unavailable');
      Object.assign(stored, structuredClone(items));
    });
    const action = bounce(post, 'Sports');
    await vi.waitFor(() => expect(pipeline.evaluationCache.get(key)?.userOverride).toBe(true));
    const settled = vi.fn();
    void result.then(settled);
    settingsRead.resolve({ enabled: true, selectedModel: 'local:gemma-4-E2B-it-web', filterReplies: true });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    manualWrite.resolve();

    await expect(action).resolves.toEqual(succeeds ? { success: true } : { success: false, error: 'manual cache unavailable' });
    await expect(result).resolves.toMatchObject({ shouldHide: succeeds, cached: true });
    expect(await result).toMatchObject(succeeds ? { userOverride: true } : { reasoning: 'settled automatic verdict' });
    expect(cached(post)?.shouldHide).toBe(succeeds);
    expect(runtime.infer).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('does not publish a provisional manual override when its durable write fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const inference = deferred<EvaluationResult>();
    const manualWrite = deferred<void>();
    runtime.infer.mockReturnValueOnce(inference.promise);
    const result = evaluate('post with failing manual persistence');
    await vi.waitFor(() => expect(runtime.infer).toHaveBeenCalled());
    writeStorage.mockImplementation(async () => {
      await manualWrite.promise;
      throw new Error('manual cache unavailable');
    });
    const action = bounce('post with failing manual persistence', 'Sports');
    await vi.waitFor(() => expect(writeStorage).toHaveBeenCalled());
    const settled = vi.fn();
    void result.then(settled);
    inference.resolve({ shouldHide: false, reasoning: 'stale automatic result' });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    manualWrite.resolve();

    await expect(action).resolves.toEqual({ success: false, error: 'manual cache unavailable' });
    await expect(result).resolves.toMatchObject({ retry: true });
    expect(cached('post with failing manual persistence')).toBeUndefined();
    errorLog.mockRestore();
  });

  it('rolls back a failed override while preserving an unrelated dirty automatic result', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const inference = deferred<EvaluationResult>();
    const manualWrite = deferred<void>();
    runtime.infer.mockReturnValueOnce(inference.promise);
    const automatic = evaluate('unrelated automatic post');
    await vi.waitFor(() => expect(runtime.infer).toHaveBeenCalled());
    writeStorage.mockImplementationOnce(async () => {
      await manualWrite.promise;
      throw new Error('manual cache unavailable');
    });
    const action = bounce('manual post with failing write', 'Sports');
    await vi.waitFor(() => expect(writeStorage).toHaveBeenCalled());
    inference.resolve({ shouldHide: false, reasoning: 'unrelated automatic result' });
    await vi.waitFor(() => expect(pipeline.evaluationCache.has(generateCacheKey('unrelated automatic post'))).toBe(true));
    manualWrite.resolve();

    await expect(action).resolves.toEqual({ success: false, error: 'manual cache unavailable' });
    await expect(automatic).resolves.toMatchObject({ shouldHide: false });
    expect(cached('manual post with failing write')).toBeUndefined();
    expect(cached('unrelated automatic post')?.reasoning).toBe('unrelated automatic result');
    errorLog.mockRestore();
  });

  it.each([true, false])('preserves a user shouldHide=%s override across late inference', async (shouldHide) => {
    const inference = deferred<EvaluationResult>();
    runtime.infer.mockReturnValueOnce(inference.promise);
    const result = evaluate('post evaluated while user acts');
    await vi.waitFor(() => expect(runtime.infer).toHaveBeenCalled());
    await send({ type: 'overrideCacheEntry', post: 'post evaluated while user acts', shouldHide });
    inference.resolve({ shouldHide: !shouldHide, reasoning: 'stale automatic result' });
    await expect(result).resolves.toMatchObject({ shouldHide, userOverride: true });
    expect(cached('post evaluated while user acts')).toMatchObject({ shouldHide, userOverride: true });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'detectorResponse', reasoning: 'stale automatic result',
    }));
  });

  it.each(['stats read', 'stats write'])('preserves Bounce across a pending automatic %s', async (pauseStage) => {
    const pause = deferred<void>();
    let reachedPause = false;
    if (pauseStage === 'stats read') {
      readStorage.mockImplementation(async (keys: string[]) => {
        if (keys.length === 1 && keys[0] === 'stats') {
          reachedPause = true;
          await pause.promise;
        }
        return Object.fromEntries(keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]));
      });
    } else {
      writeStorage.mockImplementation(async (items: Record<string, unknown>) => {
        if ('stats' in items) {
          reachedPause = true;
          await pause.promise;
        }
        Object.assign(stored, structuredClone(items));
      });
    }
    const result = evaluate('post with pending persistence');
    await vi.waitFor(() => expect(reachedPause).toBe(true));
    const action = bounce('post with pending persistence', 'Sports');
    await vi.waitFor(() => expect(pipeline.evaluationCache.get(generateCacheKey('post with pending persistence'))?.userOverride).toBe(true));
    pause.resolve();
    await expect(action).resolves.toEqual({ success: true });
    await expect(result).resolves.toMatchObject({ shouldHide: true, userOverride: true });
    expect(cached('post with pending persistence')).toMatchObject({ shouldHide: true, userOverride: true });
  });

  it('delivers an automatic verdict before its timer and orders a later Bounce after the held automatic write', async () => {
    vi.useFakeTimers();
    const post = 'post with held automatic cache persistence';
    const automaticWrite = deferred<void>();
    let writingAutomatic = false;
    writeStorage.mockImplementation(async (items: Record<string, unknown>) => {
      if ('evaluationCache' in items && !writingAutomatic) {
        writingAutomatic = true;
        await automaticWrite.promise;
      }
      Object.assign(stored, structuredClone(items));
    });
    const result = evaluate(post);
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toMatchObject({ shouldHide: false, reasoning: 'automatic verdict' });
    expect(stored.evaluationCache).toEqual({});
    expect(writingAutomatic).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(writingAutomatic).toBe(true);
    const action = bounce(post, 'Sports');
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.evaluationCache.get(generateCacheKey(post))?.userOverride).toBe(true);
    automaticWrite.resolve();

    await expect(action).resolves.toEqual({ success: true });
    expect(cached(post)).toMatchObject({ shouldHide: true, userOverride: true });
    await expect(send({ type: 'getReasoning', post })).resolves.toMatchObject({ shouldHide: true, userOverride: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(cached(post)).toMatchObject({ shouldHide: true, userOverride: true });
  });

  it('prevents a clearSinglePost from being undone by late inference', async () => {
    const inference = deferred<EvaluationResult>();
    runtime.infer.mockReturnValueOnce(inference.promise);
    const result = evaluate('post cleared during inference');
    await vi.waitFor(() => expect(runtime.infer).toHaveBeenCalled());
    await send({ type: 'clearSinglePost', post: 'post cleared during inference' });
    inference.resolve({ shouldHide: true, reasoning: 'stale verdict' });
    await expect(result).resolves.toMatchObject({ retry: true });
    expect(cached('post cleared during inference')).toBeUndefined();
    expect(pipeline.evaluationCache.has(generateCacheKey('post cleared during inference'))).toBe(false);
  });

  it('reports a failed clearSinglePost and keeps the previous cached decision', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await bounce('post whose clear will fail', 'Sports');
    writeStorage.mockRejectedValueOnce(new Error('cache clear unavailable'));

    await expect(send({ type: 'clearSinglePost', post: 'post whose clear will fail' })).resolves.toEqual({
      success: false, error: 'cache clear unavailable',
    });
    expect(cached('post whose clear will fail')).toMatchObject({ shouldHide: true, userOverride: true });
    expect(pipeline.evaluationCache.get(generateCacheKey('post whose clear will fail'))).toMatchObject({
      shouldHide: true, userOverride: true,
    });
    errorLog.mockRestore();
  });

  it('carries exact comma-containing matches through responses, snapshots, cache replay, and reasoning', async () => {
    const matches = ['Markets, crypto and NFTs', 'Sports'];
    runtime.infer.mockResolvedValue({
      shouldHide: true, reasoning: 'matched', category: matches.join(', '), matches,
    });
    await expect(evaluate('post matching comma label')).resolves.toMatchObject({
      matches, detectorStates: { map: { filter: { matches } } },
    });
    await expect(evaluate('post matching comma label')).resolves.toMatchObject({ cached: true, matches });
    await expect(send({ type: 'getReasoning', post: 'post matching comma label' })).resolves.toMatchObject({ matches });
    await pipeline.saveCache();
    expect(cached('post matching comma label')?.matches).toEqual(matches);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'detectorResponse', matches,
    }));
  });

  it('keeps legacy cache entries without exact matches distinguishable', async () => {
    pipeline.evaluationCache.set(generateCacheKey('legacy cached post'), {
      shouldHide: true, reasoning: 'legacy', category: 'Markets, crypto and NFTs',
    });
    const response = await evaluate('legacy cached post');
    expect(response).toMatchObject({ cached: true, shouldHide: true });
    expect(response).not.toHaveProperty('matches');
  });
});
