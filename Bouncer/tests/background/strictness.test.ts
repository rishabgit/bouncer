import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentToBackgroundMessage, EvaluationResult } from '../../src/types';

const runtime = vi.hoisted(() => ({
  epoch: 0, infer: vi.fn(),
  engine: {
    getClassifierFingerprint: () => 'synthetic-decision-fingerprint',
    getStatus: vi.fn(),
    get operationEpoch() { return runtime.epoch; },
    assertOperationEpoch: (expected: number) => {
      if (expected !== runtime.epoch) throw new Error('Stale work');
    },
    invalidate: vi.fn(() => { runtime.epoch++; }),
    clearQueue: vi.fn(),
    teardown: vi.fn(),
  },
}));

vi.mock('../../src/background/local-model.js', () => ({
  callLocalInference: runtime.infer,
  localEngine: runtime.engine,
  STALE_WORK_ERROR: 'Stale work',
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

const contentSender = { id: 'test-extension', url: 'https://x.com/home', frameId: 0, documentId: 'document-one', tab: { id: 1 } };
function send(message: ContentToBackgroundMessage, sender: chrome.runtime.MessageSender = contentSender): Promise<unknown> {
  return new Promise(resolve => onMessage(message, sender, resolve));
}

function bounce(post: string, phrase: string): Promise<unknown> {
  return send({ type: 'bouncePost', post, phrase, siteId: 'twitter' });
}

function cached(post: string): EvaluationResult | undefined {
  return (stored.evaluationCache as Record<string, EvaluationResult>)[generateCacheKey(post)];
}

async function evaluate(post: string, sender: chrome.runtime.MessageSender = contentSender): Promise<unknown> {
  return send({
    type: 'evaluatePost', evaluationId: `evaluation-${post}`,
    post, postUrl: null, siteId: 'twitter',
  }, sender);
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
  runtime.epoch = 0;
  stored = {
    enabled: true, filterReplies: true,
    descriptions_twitter: ['Sports'], evaluationCache: {},
    stats: { filtered: 0, evaluated: 0, totalCost: 0 },
  };
  readStorage = vi.fn(async (keys: string[]) => Object.fromEntries(
    keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]),
  ));
  writeStorage = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(stored, structuredClone(items));
  });
  runtime.engine.getStatus.mockImplementation(async () => ({
    state: 'ready', message: 'Ready', revision: 1,
    engine: 'llama.app',
  }));
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
  runtime.infer.mockImplementation(async () => ({
    scores: [{ label: 'Sports', score: 0.1 }], textSent: 'A full post about sports',
    rawResponse: 'no', inferenceTime: 0,
    modelId: 'synthetic-decision-model',
    engine: 'llama.app',
    classifierFingerprint: runtime.engine.getClassifierFingerprint(),
  }));
  pipeline = await import('../../src/background/pipeline');
  ({ generateCacheKey } = await import('../../src/shared/utils'));
  await import('../../src/background/index');
  await send({ type: 'getStats' });
});

afterEach(async () => {
  pipeline.clearTabQueue(1);
  pipeline.clearTabQueue(2);
  pipeline.setActiveTab(null);
  // Retired module timers must not write into a later test's Chrome fixture.
  await pipeline.clearEvaluationCache().catch(() => undefined);
  vi.useRealTimers();
});

const popupSender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
function strict(phrase: string, value: boolean): Promise<unknown> {
  return send({ type: 'setFilterStrictness', siteId: 'twitter', phrase, strict: value }, popupSender);
}

function editPhrase(type: 'addFilterPhrase' | 'removeFilterPhrase'): Promise<unknown> {
  return send({ type, siteId: 'twitter', phrase: type === 'addFilterPhrase' ? 'Crypto' : 'Politics' });
}

function scoredResult(score = 0.5): EvaluationResult {
  return {
    shouldHide: true, reasoning: 'Matched: Sports', matches: ['Sports'], category: 'Sports',
    scores: [{ label: 'Sports', score }], textSent: 'A full post about local sports',
    engine: 'llama.app', classifierFingerprint: runtime.engine.getClassifierFingerprint(),
    detectorStates: { names: ['filter'], map: {
      filter: { status: 'success', shouldHide: true, reasoning: 'Matched: Sports', matches: ['Sports'], category: 'Sports' },
    } },
  };
}

describe('per-filter strictness through the trusted background', () => {
  it.each([
    { type: 'addFilterPhrase', first: 'phrase', phase: 'read' },
    { type: 'addFilterPhrase', first: 'phrase', phase: 'write' },
    { type: 'addFilterPhrase', first: 'strict', phase: 'read' },
    { type: 'addFilterPhrase', first: 'strict', phase: 'write' },
    { type: 'removeFilterPhrase', first: 'phrase', phase: 'read' },
    { type: 'removeFilterPhrase', first: 'phrase', phase: 'write' },
    { type: 'removeFilterPhrase', first: 'strict', phase: 'read' },
    { type: 'removeFilterPhrase', first: 'strict', phase: 'write' },
  ] as const)('serializes $type with a $first-first paused $phase without reverting Strict or later manual decisions', async ({ type, first, phase }) => {
    stored.descriptions_twitter = ['Sports', 'Politics'];
    await deliverFilterEvent(['Sports'], ['Sports', 'Politics']);
    pipeline.evaluationCache.set(generateCacheKey('old automatic result'), scoredResult());
    writeStorage.mockClear();
    const gate = deferred<void>();
    let paused = false;
    readStorage.mockImplementation(async (keys: string[]) => {
      // Capture the snapshot before yielding: an unqueued phrase writer would
      // otherwise resume with the old Strict list and overwrite the saved level.
      const snapshot = Object.fromEntries(keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]));
      if (phase === 'read' && !paused && keys.includes('strictFilters_twitter')) {
        paused = true;
        await gate.promise;
      }
      return snapshot;
    });
    writeStorage.mockImplementation(async (items: Record<string, unknown>) => {
      const isFirstWrite = first === 'phrase' ? 'descriptions_twitter' in items
        : 'strictFilters_twitter' in items && !('descriptions_twitter' in items);
      if (phase === 'write' && !paused && isFirstWrite) {
        paused = true;
        await gate.promise;
      }
      Object.assign(stored, structuredClone(items));
    });

    const firstAction = first === 'phrase' ? editPhrase(type) : strict('Sports', true);
    await vi.waitFor(() => expect(paused).toBe(true));
    const readsWhilePaused = readStorage.mock.calls.length;
    const writesWhilePaused = writeStorage.mock.calls.length;
    const secondAction = first === 'phrase' ? strict('Sports', true) : editPhrase(type);
    // This explicit decision must land after phrase invalidation, even while
    // neither Chrome storage notification has been delivered.
    const manual = bounce('manual decision following both filter actions', 'Sports');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(readStorage).toHaveBeenCalledTimes(readsWhilePaused);
    expect(writeStorage).toHaveBeenCalledTimes(writesWhilePaused);
    gate.resolve();
    const phraseResponse = type === 'addFilterPhrase' ? { success: true, added: true } : { success: true };
    await expect(Promise.all([firstAction, secondAction, manual])).resolves.toEqual([
      first === 'phrase' ? phraseResponse : { success: true },
      first === 'phrase' ? { success: true } : phraseResponse,
      { success: true },
    ]);

    const expectedPhrases = type === 'addFilterPhrase' ? ['Sports', 'Politics', 'Crypto'] : ['Sports'];
    expect(stored.descriptions_twitter).toEqual(expectedPhrases);
    expect(stored.strictFilters_twitter).toEqual(['Sports']);
    expect(pipeline.evaluationCache.has(generateCacheKey('old automatic result'))).toBe(false);
    expect(cached('manual decision following both filter actions')).toMatchObject({
      shouldHide: true, userOverride: true, matches: ['Sports'],
    });
    const clearIndex = writeStorage.mock.calls.findIndex(([items]) => (
      'evaluationCache' in items && Object.keys(items.evaluationCache).length === 0
    ));
    const manualIndex = writeStorage.mock.calls.findIndex(([items]) => (
      'evaluationCache' in items && generateCacheKey('manual decision following both filter actions') in items.evaluationCache
    ));
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(manualIndex).toBeGreaterThan(clearIndex);
    const clears = writeStorage.mock.calls.filter(([items]) => (
      'evaluationCache' in items && Object.keys(items.evaluationCache).length === 0
    )).length;
    await deliverFilterEvent(['Sports', 'Politics'], expectedPhrases);
    onStorageChanged({ strictFilters_twitter: { oldValue: [], newValue: ['Sports'] } }, 'local');
    await send({ type: 'clearSinglePost', post: 'strict-event-barrier-post' });
    expect(stored.strictFilters_twitter).toEqual(['Sports']);
    expect(cached('manual decision following both filter actions')?.userOverride).toBe(true);
    expect(writeStorage.mock.calls.filter(([items]) => (
      'evaluationCache' in items && Object.keys(items.evaluationCache).length === 0
    ))).toHaveLength(clears);
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it('defaults a missing Strict key to Standard without writing storage or requesting the model', async () => {
    writeStorage.mockClear();
    pipeline.evaluationCache.set(generateCacheKey('A full post about local sports'), scoredResult());
    await expect(evaluate('A full post about local sports')).resolves.toMatchObject({ cached: true, shouldHide: true });
    expect(stored).not.toHaveProperty('strictFilters_twitter');
    expect(writeStorage).not.toHaveBeenCalled();
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it('rejudges cached scores and detector snapshots in both directions without inference or changing evidence', async () => {
    const post = 'A full post about local sports';
    const key = generateCacheKey(post);
    const original = scoredResult();
    pipeline.evaluationCache.set(key, original);
    await pipeline.saveCache();
    await expect(strict('Sports', true)).resolves.toEqual({ success: true });
    expect(stored.strictFilters_twitter).toEqual(['Sports']);
    expect(pipeline.evaluationCache.get(key)).toBe(original);
    expect(await pipeline.readCachedEvaluation(key)).toMatchObject({
      shouldHide: false, matches: [], scores: original.scores, textSent: original.textSent,
      detectorStates: { map: { filter: { shouldHide: false, matches: [] } } },
    });
    await expect(evaluate(post)).resolves.toMatchObject({ cached: true, shouldHide: false, matches: [] });
    await expect(strict('Sports', false)).resolves.toEqual({ success: true });
    await expect(evaluate(post)).resolves.toMatchObject({
      cached: true, shouldHide: true, matches: ['Sports'], scores: original.scores,
      detectorStates: { map: { filter: { shouldHide: true, matches: ['Sports'] } } },
    });
    expect(pipeline.evaluationCache.size).toBe(1);
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it('rejudges cached scores on read while leaving manual Bounce and Restore decisions untouched', async () => {
    const automatic = 'Another full post about local sports';
    pipeline.evaluationCache.set(generateCacheKey(automatic), scoredResult());
    await bounce('manually bounced post', 'Sports');
    await send({ type: 'overrideCacheEntry', post: 'manually restored post', shouldHide: false });
    const bounced = structuredClone(cached('manually bounced post'));
    const restored = structuredClone(cached('manually restored post'));
    await expect(strict('Sports', true)).resolves.toEqual({ success: true });
    expect(await pipeline.readCachedEvaluation(generateCacheKey(automatic))).toMatchObject({ shouldHide: false, scores: scoredResult().scores });
    await expect(evaluate('manually bounced post')).resolves.toMatchObject({ ...bounced, cached: true });
    await expect(evaluate('manually restored post')).resolves.toMatchObject({ ...restored, cached: true });
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it('retains duplicate Strict phrases, makes new phrases Standard, and still clears cache on an ordered phrase edit', async () => {
    await strict('Sports', true);
    await bounce('duplicate Bounce', 'Sports');
    expect(stored.strictFilters_twitter).toEqual(['Sports']);
    await bounce('new phrase Bounce', 'Politics');
    expect(stored.descriptions_twitter).toEqual(['Sports', 'Politics']);
    expect(stored.strictFilters_twitter).toEqual(['Sports']);
    pipeline.evaluationCache.set(generateCacheKey('scored cache'), scoredResult());
    stored.descriptions_twitter = ['Politics', 'Sports'];
    await deliverFilterEvent(['Sports', 'Politics'], ['Politics', 'Sports']);
    expect(pipeline.evaluationCache.size).toBe(0);
    expect(stored.evaluationCache).toEqual({});
  });

  it.each([
    { initial: [], next: true, shouldHide: false },
    { initial: ['Sports'], next: false, shouldHide: true },
  ])('publishes one in-flight inference at the saved level when Strict becomes $next', async ({ initial, next, shouldHide }) => {
    stored.strictFilters_twitter = initial;
    const inference = deferred<EvaluationResult>();
    runtime.infer.mockReturnValueOnce(inference.promise);
    const result = evaluate('A full post about local sports');
    await vi.waitFor(() => expect(runtime.infer).toHaveBeenCalledOnce());
    const invalidations = runtime.engine.invalidate.mock.calls.length;
    const queueClears = runtime.engine.clearQueue.mock.calls.length;
    await expect(strict('Sports', next)).resolves.toEqual({ success: true });
    onStorageChanged({ strictFilters_twitter: { oldValue: initial, newValue: next ? ['Sports'] : [] } }, 'local');
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    inference.resolve(scoredResult());
    await expect(result).resolves.toMatchObject({ shouldHide, matches: shouldHide ? ['Sports'] : [] });
    expect(pipeline.evaluationCache.size).toBe(1);
    expect(runtime.infer).toHaveBeenCalledOnce();
    expect(runtime.engine.invalidate).toHaveBeenCalledTimes(invalidations);
    expect(runtime.engine.clearQueue).toHaveBeenCalledTimes(queueClears);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'detectorResponse', shouldHide,
    }));
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'detectorResponse', shouldHide: !shouldHide,
    }));
  });

  it.each(['delayed', 'delivered'])('preserves queued work in both tabs with a %s Strict event and infers each post once', async event => {
    const inference = deferred<EvaluationResult>();
    runtime.infer.mockReturnValueOnce(inference.promise).mockResolvedValue(scoredResult());
    const first = evaluate('First full post about local sports');
    await vi.waitFor(() => expect(runtime.infer).toHaveBeenCalledOnce());
    const secondPost = 'Second full post about local sports';
    const otherPost = 'Another tab post about local sports';
    const second = evaluate(secondPost);
    const other = evaluate(otherPost, { ...contentSender, documentId: 'document-two', tab: { id: 2 } });
    await vi.waitFor(() => {
      expect(pipeline.isKeyPending(1, generateCacheKey(secondPost))).toBe(true);
      expect(pipeline.isKeyPending(2, generateCacheKey(otherPost))).toBe(true);
    });
    const invalidations = runtime.engine.invalidate.mock.calls.length;
    const queueClears = runtime.engine.clearQueue.mock.calls.length;
    await expect(strict('Sports', true)).resolves.toEqual({ success: true });
    const change = { strictFilters_twitter: { oldValue: [], newValue: ['Sports'] } };
    if (event === 'delivered') onStorageChanged(change, 'local');
    expect(pipeline.isKeyPending(1, generateCacheKey(secondPost))).toBe(true);
    expect(pipeline.isKeyPending(2, generateCacheKey(otherPost))).toBe(true);
    inference.resolve(scoredResult());
    await expect(first).resolves.toMatchObject({ shouldHide: false, matches: [] });
    await expect(second).resolves.toMatchObject({ shouldHide: false, matches: [] });
    pipeline.setActiveTab(2);
    await expect(other).resolves.toMatchObject({ shouldHide: false, matches: [] });
    if (event === 'delayed') onStorageChanged(change, 'local');
    await send({ type: 'clearSinglePost', post: 'delayed-event-barrier' });
    expect(runtime.infer).toHaveBeenCalledTimes(3);
    expect(runtime.infer.mock.calls.map(([post]) => post.text)).toEqual([
      'First full post about local sports', secondPost, otherPost,
    ]);
    expect(runtime.engine.invalidate).toHaveBeenCalledTimes(invalidations);
    expect(runtime.engine.clearQueue).toHaveBeenCalledTimes(queueClears);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({
      type: 'detectorResponse', shouldHide: true,
    }));
  });

  it('counts Standard and Strict publications from the same half-probability evidence', async () => {
    runtime.infer.mockResolvedValue(scoredResult());
    await expect(evaluate('Standard post about the local sports results')).resolves.toMatchObject({ shouldHide: true });
    await vi.waitFor(() => expect(stored.stats).toEqual({ filtered: 1, evaluated: 1, totalCost: 0 }));
    await expect(strict('Sports', true)).resolves.toEqual({ success: true });
    await expect(evaluate('Strict post about the local sports results')).resolves.toMatchObject({ shouldHide: false });
    await vi.waitFor(() => expect(stored.stats).toEqual({ filtered: 1, evaluated: 2, totalCost: 0 }));
    expect(runtime.infer).toHaveBeenCalledTimes(2);
  });

  it('counts the saved Strict verdict when its storage event is delayed during inference', async () => {
    const inference = deferred<EvaluationResult>();
    runtime.infer.mockReturnValueOnce(inference.promise);
    const post = 'A full post about local sports';
    const result = evaluate(post);
    await vi.waitFor(() => expect(runtime.infer).toHaveBeenCalledOnce());
    // Chrome storage has changed, but onChanged is deliberately not delivered.
    stored.strictFilters_twitter = ['Sports'];
    inference.resolve(scoredResult());
    await expect(result).resolves.toMatchObject({ shouldHide: false, matches: [], scores: scoredResult().scores });
    await vi.waitFor(() => expect(stored.stats).toEqual({ filtered: 0, evaluated: 1, totalCost: 0 }));
    expect(pipeline.evaluationCache.get(generateCacheKey(post))).toMatchObject({ shouldHide: false, scores: scoredResult().scores });
    expect(runtime.infer).toHaveBeenCalledOnce();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'detectorResponse', shouldHide: true,
    }));
  });

  it('retains the published historical count when Strict changes during later stats persistence', async () => {
    runtime.infer.mockResolvedValueOnce(scoredResult());
    const statsWrite = deferred<void>();
    let statsPaused = false;
    writeStorage.mockImplementation(async (items: Record<string, unknown>) => {
      if ('stats' in items) { statsPaused = true; await statsWrite.promise; }
      Object.assign(stored, structuredClone(items));
    });
    const post = 'A full post about local sports';
    const settled = vi.fn();
    const result = evaluate(post);
    void result.then(settled);
    try {
      await vi.waitFor(() => expect(statsPaused).toBe(true));
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ shouldHide: true, matches: ['Sports'] }));
      await expect(strict('Sports', true)).resolves.toEqual({ success: true });
      onStorageChanged({ strictFilters_twitter: { oldValue: [], newValue: ['Sports'] } }, 'local');
      statsWrite.resolve();
      await vi.waitFor(() => expect(stored.stats).toEqual({ filtered: 1, evaluated: 1, totalCost: 0 }));
      await expect(result).resolves.toMatchObject({ shouldHide: true, matches: ['Sports'] });
      const successes = vi.mocked(chrome.tabs.sendMessage).mock.calls.filter(([, message]) => (
        message.type === 'detectorResponse' && typeof message.shouldHide === 'boolean'
      ));
      expect(successes).toEqual([[1, expect.objectContaining({
        type: 'detectorResponse', shouldHide: true, matches: ['Sports'],
      })]]);
      await expect(evaluate(post)).resolves.toMatchObject({ cached: true, shouldHide: false, matches: [] });
      expect(stored.stats).toEqual({ filtered: 1, evaluated: 1, totalCost: 0 });
      expect(runtime.infer).toHaveBeenCalledOnce();
    } finally {
      statsWrite.resolve();
    }
  });

  it('publishes the saved Strict verdict before an isolated stats write failure', async () => {
    stored.strictFilters_twitter = ['Sports'];
    runtime.infer.mockResolvedValueOnce(scoredResult());
    const statsWrite = deferred<void>();
    const failure = new Error('counter storage unavailable');
    let statsPaused = false;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeStorage.mockImplementation(async (items: Record<string, unknown>) => {
      if ('stats' in items) {
        statsPaused = true;
        await statsWrite.promise;
        throw failure;
      }
      Object.assign(stored, structuredClone(items));
    });
    const post = 'Strict post with failed counter persistence';
    const settled = vi.fn();
    const result = evaluate(post);
    void result.then(settled);
    try {
      await vi.waitFor(() => expect(statsPaused).toBe(true));
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ shouldHide: false, matches: [] }));
      expect(pipeline.evaluationCache.get(generateCacheKey(post))).toMatchObject({ shouldHide: false });
      statsWrite.resolve();
      await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith('[Stats] Failed to update evaluation counters:', failure));
      await expect(result).resolves.toMatchObject({ shouldHide: false, matches: [] });
      expect(pipeline.errorState).toEqual({ type: null, count: 0 });
      expect(runtime.infer).toHaveBeenCalledOnce();
    } finally {
      statsWrite.resolve();
      errorLog.mockRestore();
    }
  });

  it('holds the serial batch after publication until stats settle without losing queued increments', async () => {
    runtime.infer.mockResolvedValue(scoredResult());
    const statsWrite = deferred<void>();
    let statsPaused = false;
    writeStorage.mockImplementation(async (items: Record<string, unknown>) => {
      if ('stats' in items && !statsPaused) { statsPaused = true; await statsWrite.promise; }
      Object.assign(stored, structuredClone(items));
    });
    const firstPost = 'First complete post about the sports results';
    const secondPost = 'Second complete post about the sports results';
    const firstSettled = vi.fn();
    const first = evaluate(firstPost);
    void first.then(firstSettled);
    try {
      await vi.waitFor(() => expect(statsPaused).toBe(true));
      expect(firstSettled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ shouldHide: true }));
      await strict('Sports', true);
      const second = evaluate(secondPost);
      await vi.waitFor(() => expect(pipeline.isKeyPending(1, generateCacheKey(secondPost))).toBe(true));
      expect(runtime.infer).toHaveBeenCalledOnce();
      statsWrite.resolve();
      await expect(first).resolves.toMatchObject({ shouldHide: true });
      await expect(second).resolves.toMatchObject({ shouldHide: false });
      await vi.waitFor(() => expect(stored.stats).toEqual({ filtered: 1, evaluated: 2, totalCost: 0 }));
      expect(runtime.infer).toHaveBeenCalledTimes(2);
    } finally {
      statsWrite.resolve();
    }
  });

  it('reads the latest level on the first cache response and ignores a delayed Strict event', async () => {
    const post = 'A full post about local sports';
    pipeline.evaluationCache.set(generateCacheKey(post), scoredResult());
    stored.strictFilters_twitter = ['Sports'];
    await expect(evaluate(post)).resolves.toMatchObject({ cached: true, shouldHide: false });
    const invalidations = runtime.engine.invalidate.mock.calls.length;
    onStorageChanged({ strictFilters_twitter: { oldValue: [], newValue: ['Sports'] } }, 'local');
    await send({ type: 'clearSinglePost', post: 'event-barrier-post' });
    expect(runtime.engine.invalidate).toHaveBeenCalledTimes(invalidations);
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it.each([
    { descriptions: ['Politics'], labels: ['Sports'] },
    { descriptions: ['Sports', 'Politics'], labels: ['Sports'] },
    { descriptions: ['Sports'], labels: ['Sports', 'Politics'] },
  ])('rejects scored cache with a stale label set before a delayed phrase event: %#', async ({ descriptions, labels }) => {
    const post = 'A full post about local sports';
    const key = generateCacheKey(post);
    const original = { ...scoredResult(), scores: labels.map(label => ({ label, score: 0.5 })) };
    pipeline.evaluationCache.set(key, original);
    stored.descriptions_twitter = descriptions;
    await expect(send({ type: 'getReasoning', post })).resolves.toMatchObject({ found: false });
    expect(pipeline.evaluationCache.get(key)).toBe(original);
    expect(runtime.infer).not.toHaveBeenCalled();
    // Explicit decisions remain valid regardless of the automatic vector.
    pipeline.evaluationCache.set(key, { ...original, userOverride: true });
    await expect(send({ type: 'getReasoning', post })).resolves.toMatchObject({ found: true, userOverride: true });
  });

  it('rejudges persisted cache against Strict storage after worker startup without inference', async () => {
    const post = 'A full post about local sports';
    const key = generateCacheKey(post);
    stored.strictFilters_twitter = ['Sports'];
    stored.evaluationCache = { [key]: scoredResult() };
    vi.resetModules();
    pipeline = await import('../../src/background/pipeline');
    await import('../../src/background/index');
    await expect(evaluate(post)).resolves.toMatchObject({ cached: true, shouldHide: false, scores: scoredResult().scores });
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it('does not reinsert a retired scored cache entry when its Strict storage read spans a phrase change', async () => {
    const post = 'A full post about local sports';
    const key = generateCacheKey(post);
    pipeline.evaluationCache.set(key, scoredResult());
    const read = deferred<Record<string, unknown>>();
    readStorage.mockImplementationOnce(() => read.promise);
    const result = pipeline.readCachedEvaluation(key);
    await pipeline.handleFilterChange();
    read.resolve({ descriptions_twitter: ['Sports'], strictFilters_twitter: [] });
    await expect(result).resolves.toBeUndefined();
    expect(pipeline.evaluationCache.size).toBe(0);
  });

  it('accepts overlapping cache readers without replacing their shared score evidence', async () => {
    const key = generateCacheKey('A full post about local sports');
    const original = scoredResult();
    pipeline.evaluationCache.set(key, original);
    stored.strictFilters_twitter = ['Sports'];
    const results = await Promise.all([pipeline.readCachedEvaluation(key), pipeline.readCachedEvaluation(key)]);
    expect(results).toEqual([expect.objectContaining({ shouldHide: false }), expect.objectContaining({ shouldHide: false })]);
    expect(pipeline.evaluationCache.get(key)).toBe(original);
    expect(runtime.infer).not.toHaveBeenCalled();
  });

  it.each([
    { phrase: 'Missing', strict: true, error: 'Filter phrase is no longer saved.' },
    { phrase: 'Sports', strict: 'yes', error: 'Invalid filter strictness request.' },
    { phrase: '', strict: true, error: 'Invalid filter strictness request.' },
  ])('rejects invalid Strict mutation %# without changing storage', async fields => {
    const before = structuredClone(stored);
    await expect(send({ type: 'setFilterStrictness', siteId: 'twitter', ...fields } as ContentToBackgroundMessage, popupSender))
      .resolves.toMatchObject({ success: false, error: fields.error });
    expect(stored).toEqual(before);
    expect(runtime.infer).not.toHaveBeenCalled();
  });
});

