import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvaluationResult } from '../../src/types';

const engine = vi.hoisted(() => ({
  isMaintaining: vi.fn(() => false),
  markTerminalError: vi.fn(),
}));
vi.mock('../../src/shared/models.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/shared/models')>();
  return { ...original,
    ACCEPTED_NATIVE_MANIFEST_DIGEST: 'a'.repeat(64),
    PRIMARY_LOCAL_MODEL: { ...original.PRIMARY_LOCAL_MODEL, manifestDigest: 'a'.repeat(64) },
    NATIVE_CLASSIFIER_FINGERPRINT: 'synthetic-native-fingerprint',
  };
});
vi.mock('../../src/background/local-model.js', () => ({
  localEngine: engine,
  callLocalInference: vi.fn(),
  MODEL_MAINTENANCE_ERROR: 'Local model maintenance in progress',
}));

let pipeline: typeof import('../../src/background/pipeline');
let generateCacheKey: typeof import('../../src/shared/utils')['generateCacheKey'];
let persisted: Record<string, EvaluationResult>;
let writeStorage: ReturnType<typeof vi.fn>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function markAutomatic(key: string, shouldHide = true): void {
  pipeline.evaluationCache.set(key, { shouldHide, reasoning: `automatic ${key}` });
  pipeline.scheduleAutomaticCacheSave();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  persisted = {};
  writeStorage = vi.fn(async (items: { evaluationCache: Record<string, EvaluationResult> }) => {
    persisted = structuredClone(items.evaluationCache);
  });
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({ evaluationCache: structuredClone(persisted) })),
        set: writeStorage,
      },
    },
  } as unknown as typeof chrome;
  pipeline = await import('../../src/background/pipeline');
  ({ generateCacheKey } = await import('../../src/shared/utils'));
  await pipeline.loadCache();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('automatic cache persistence', () => {
  it('retries a failed initial cache read before accepting preserved manual decisions', async () => {
    vi.resetModules();
    const post = 'preserved manual decision after a transient cache read';
    const key = generateCacheKey(post);
    persisted = { [key]: { shouldHide: true, reasoning: 'manual', userOverride: true } };
    const failure = new Error('cache storage temporarily unavailable');
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(failure);
    pipeline = await import('../../src/background/pipeline');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(pipeline.loadCache()).rejects.toThrow(failure.message);
    await pipeline.loadCache();
    await expect(pipeline.readCachedEvaluation(key)).resolves.toMatchObject({ shouldHide: true, userOverride: true });
    expect(writeStorage).not.toHaveBeenCalled();
    logError.mockRestore();
  });

  it('uses the first dirty entry deadline and snapshots the current map when it fires', async () => {
    markAutomatic('first');
    await vi.advanceTimersByTimeAsync(1000);
    markAutomatic('second');
    pipeline.evaluationCache.set('first', { shouldHide: false, reasoning: 'updated before timer' });
    pipeline.scheduleAutomaticCacheSave();
    await vi.advanceTimersByTimeAsync(1999);
    expect(writeStorage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(writeStorage).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual({
      first: { shouldHide: false, reasoning: 'updated before timer' },
      second: { shouldHide: true, reasoning: 'automatic second' },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeStorage).toHaveBeenCalledTimes(1);
  });

  it('an immediate save flushes automatic state and cancels its later timer', async () => {
    markAutomatic('waiting');
    await vi.advanceTimersByTimeAsync(1000);
    await pipeline.saveCache(true);
    expect(persisted.waiting.shouldHide).toBe(true);
    expect(writeStorage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(writeStorage).toHaveBeenCalledTimes(1);
  });

  it('a manual override saves immediately and cancels a pending automatic timer', async () => {
    const post = 'post manually bounced before automatic persistence';
    const key = generateCacheKey(post);
    markAutomatic(key, false);
    await pipeline.overridePost(post, true, 'manual decision');
    expect(persisted[key]).toMatchObject({ shouldHide: true, userOverride: true });
    expect(writeStorage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeStorage).toHaveBeenCalledTimes(1);
  });

  it('a full clear cancels automatic persistence without repopulating deleted entries', async () => {
    markAutomatic('to-be-cleared');
    await pipeline.clearEvaluationCache();
    expect(persisted).toEqual({});
    expect(pipeline.evaluationCache.size).toBe(0);
    expect(writeStorage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(writeStorage).toHaveBeenCalledTimes(1);
  });

  it('orders a full clear after an already-running automatic snapshot', async () => {
    const automaticWrite = deferred();
    writeStorage.mockImplementationOnce(async (items: { evaluationCache: Record<string, EvaluationResult> }) => {
      await automaticWrite.promise;
      persisted = structuredClone(items.evaluationCache);
    });
    markAutomatic('old-result');
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeStorage).toHaveBeenCalledTimes(1);
    const clear = pipeline.clearEvaluationCache();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStorage).toHaveBeenCalledTimes(1);
    automaticWrite.resolve();
    await clear;
    expect(writeStorage).toHaveBeenCalledTimes(2);
    expect(writeStorage).toHaveBeenLastCalledWith({ evaluationCache: {} });
    expect(persisted).toEqual({});
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeStorage).toHaveBeenCalledTimes(2);
  });

  it('orders a manual override after a held automatic snapshot and keeps readers waiting', async () => {
    const post = 'post overridden during an automatic storage write';
    const key = generateCacheKey(post);
    const automaticWrite = deferred();
    writeStorage.mockImplementationOnce(async (items: { evaluationCache: Record<string, EvaluationResult> }) => {
      await automaticWrite.promise;
      persisted = structuredClone(items.evaluationCache);
    });
    markAutomatic(key, false);
    await vi.advanceTimersByTimeAsync(3000);
    const manual = pipeline.overridePost(post, true, 'manual wins');
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStorage).toHaveBeenCalledTimes(1);
    const reader = pipeline.readCachedEvaluation(key);
    const settled = vi.fn();
    void reader.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();

    automaticWrite.resolve();
    await manual;
    await expect(reader).resolves.toMatchObject({ shouldHide: true, userOverride: true });
    expect(persisted[key]).toMatchObject({ shouldHide: true, userOverride: true });
    expect(writeStorage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeStorage).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed manual rollback after an automatic snapshot containing its provisional entry', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const post = 'post whose manual write fails';
    const key = generateCacheKey(post);
    const previous = { shouldHide: false, reasoning: 'previous settled verdict', classifierFingerprint: 'synthetic-native-fingerprint' };
    pipeline.evaluationCache.set(key, previous);
    await pipeline.saveCache(true);
    const manualWrite = deferred();
    writeStorage.mockImplementationOnce(async () => {
      await manualWrite.promise;
      throw new Error('manual persistence unavailable');
    });
    const manual = pipeline.overridePost(post, true, 'provisional manual decision');
    const failure = expect(manual).rejects.toThrow('manual persistence unavailable');
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStorage).toHaveBeenCalledTimes(2);
    markAutomatic('unrelated');
    await vi.advanceTimersByTimeAsync(3000);
    // The automatic snapshot has joined the write chain behind the held write.
    expect(writeStorage).toHaveBeenCalledTimes(2);
    const reader = pipeline.readCachedEvaluation(key);
    const settled = vi.fn();
    void reader.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    manualWrite.resolve();
    await failure;
    await expect(reader).resolves.toEqual(previous);

    expect(writeStorage).toHaveBeenCalledTimes(4);
    expect(persisted[key]).toEqual(previous);
    expect(persisted.unrelated?.reasoning).toBe('automatic unrelated');
    expect(writeStorage).toHaveBeenLastCalledWith({ evaluationCache: {
      [key]: previous,
      unrelated: { shouldHide: true, reasoning: 'automatic unrelated' },
    } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeStorage).toHaveBeenCalledTimes(4);
    errorLog.mockRestore();
  });

  it('logs an automatic write failure without changing model errors and permits the next dirty window', async () => {
    const error = new Error('automatic persistence unavailable');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeStorage.mockRejectedValueOnce(error);
    markAutomatic('first');
    await vi.advanceTimersByTimeAsync(3000);
    expect(errorLog).toHaveBeenCalledWith('Failed to save cache:', error);
    expect(pipeline.errorState).toEqual({ type: null, count: 0 });
    expect(engine.markTerminalError).not.toHaveBeenCalled();
    markAutomatic('second');
    await vi.advanceTimersByTimeAsync(2999);
    expect(writeStorage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writeStorage).toHaveBeenCalledTimes(2);
    expect(Object.keys(persisted)).toEqual(['first', 'second']);
    errorLog.mockRestore();
  });

  it('a missing-key clear immediately flushes a pending automatic timer', async () => {
    markAutomatic('unrelated');
    await vi.advanceTimersByTimeAsync(1000);
    await pipeline.clearPost('uncached post');
    expect(writeStorage).toHaveBeenCalledTimes(1);
    expect(persisted.unrelated?.shouldHide).toBe(true);
    expect(await pipeline.readCachedEvaluation(generateCacheKey('uncached post'))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writeStorage).toHaveBeenCalledTimes(1);
  });

  it('a missing-key clear waits for an in-flight automatic write without adding another snapshot', async () => {
    const automaticWrite = deferred();
    writeStorage.mockImplementationOnce(async (items: { evaluationCache: Record<string, EvaluationResult> }) => {
      await automaticWrite.promise;
      persisted = structuredClone(items.evaluationCache);
    });
    markAutomatic('unrelated');
    await vi.advanceTimersByTimeAsync(3000);
    const clear = pipeline.clearPost('uncached post');
    const settled = vi.fn();
    void clear.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    automaticWrite.resolve();
    await clear;
    expect(writeStorage).toHaveBeenCalledTimes(1);
    expect(persisted.unrelated?.shouldHide).toBe(true);
  });
});
