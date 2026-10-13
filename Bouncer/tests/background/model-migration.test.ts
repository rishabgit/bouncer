import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  NATIVE_CUTOVER_STORAGE_SCHEMA_KEY,
  NATIVE_CUTOVER_STORAGE_SCHEMA_VERSION,
  NATIVE_MODEL_CACHE_CLEANUP_KEY,
  NATIVE_MODEL_CACHE_CLEANUP_VERSION,
  RETIRED_BROWSER_MODEL_STORAGE_KEYS,
  cleanupRetiredModelCaches,
  migrateToNativeModel,
  normalizeNativeStorage,
  projectNativeStorageForBrowserRollback,
  projectSettledManualCache,
  stripNativeCutoverStorageChanges,
  type StorageChange,
} from '../../src/background/model-migration.js';

const OLD_MODEL_ID = 'gemma-4-E2B-it-web';
const OLD_MODEL_KEY = `local:${OLD_MODEL_ID}`;
const closeLegacyRuntime = vi.fn(async () => undefined);

interface MemoryStorage {
  data: Record<string, unknown>;
  events: Record<string, StorageChange>[];
  operations: string[];
  get: Mock<(keys: string | string[]) => Promise<Record<string, unknown>>>;
  set: Mock<(items: Record<string, unknown>) => Promise<void>>;
  remove: Mock<(keys: string | string[]) => Promise<void>>;
}

function memoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
  const data = structuredClone(initial);
  const events: Record<string, StorageChange>[] = [];
  const operations: string[] = [];
  return {
    data,
    events,
    operations,
    get: vi.fn(async (keys: string | string[]) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      operations.push(`get:${requested.join(',')}`);
      return structuredClone(Object.fromEntries(requested
        .filter(key => Object.prototype.hasOwnProperty.call(data, key))
        .map(key => [key, data[key]])));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      operations.push(`set:${Object.keys(items).join(',')}`);
      const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [
        key,
        { oldValue: structuredClone(data[key]), newValue: structuredClone(value) },
      ]));
      Object.assign(data, structuredClone(items));
      events.push(changes);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      operations.push(`remove:${requested.join(',')}`);
      const changes = Object.fromEntries(requested
        .filter(key => Object.prototype.hasOwnProperty.call(data, key))
        .map(key => [key, { oldValue: structuredClone(data[key]) }]));
      for (const key of requested) delete data[key];
      if (Object.keys(changes).length > 0) events.push(changes);
    }),
  };
}

interface MemoryCacheStorage {
  api: CacheStorage;
  entries: Map<string, string[]>;
  delete: Mock<(name: string) => Promise<boolean>>;
}

function memoryCaches(initial: Record<string, string[]> = {}): MemoryCacheStorage {
  const entries = new Map(Object.entries(structuredClone(initial)));
  const remove = vi.fn(async (name: string) => entries.delete(name));
  const api = {
    keys: vi.fn(async () => [...entries.keys()]),
    delete: remove,
    open: vi.fn(async () => { throw new Error('Migration must not open model buckets'); }),
  } as unknown as CacheStorage;
  return { api, entries, delete: remove };
}

function manual(shouldHide: boolean, suffix = ''): Record<string, unknown> {
  return {
    shouldHide,
    reasoning: `synthetic manual ${shouldHide ? 'hide' : 'restore'}${suffix}`,
    userOverride: true,
    timestamp: 1_700_000_000_000,
  };
}

function oldBackendSnapshot(): Record<string, unknown> {
  return {
    selectedModel: OLD_MODEL_KEY,
    localModelStatuses: {
      [OLD_MODEL_ID]: { state: 'cached' },
      'retired-other-model': { state: 'ready' },
    },
    gemmaOnlySchemaVersion: 1,
    retiredModelCacheCleanupVersion: 1,
  };
}

describe('native storage cutover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the legacy runtime, verifies transformed storage, and writes markers last', async () => {
    const storage = memoryStorage();
    const cacheStorage = memoryCaches();
    const close = vi.fn(async () => {
      expect(storage.set).not.toHaveBeenCalled();
      expect(cacheStorage.delete).not.toHaveBeenCalled();
      storage.operations.push('close');
    });

    await expect(migrateToNativeModel({
      storage, cacheStorage: cacheStorage.api, closeLegacyRuntime: close,
    })).resolves.toEqual({ storageNormalized: true, retiredCachesCleaned: true });

    expect(storage.data).toEqual({
      evaluationCache: {},
      [NATIVE_CUTOVER_STORAGE_SCHEMA_KEY]: NATIVE_CUTOVER_STORAGE_SCHEMA_VERSION,
      [NATIVE_MODEL_CACHE_CLEANUP_KEY]: NATIVE_MODEL_CACHE_CLEANUP_VERSION,
    });
    expect(storage.operations.indexOf('close')).toBeLessThan(
      storage.operations.indexOf('set:evaluationCache'),
    );
    expect(storage.operations.indexOf(`set:${NATIVE_CUTOVER_STORAGE_SCHEMA_KEY}`)).toBeGreaterThan(
      storage.operations.indexOf(`get:evaluationCache,${RETIRED_BROWSER_MODEL_STORAGE_KEYS.join(',')}`),
    );
    expect(storage.set.mock.calls.at(-1)).toEqual([{
      [NATIVE_MODEL_CACHE_CLEANUP_KEY]: NATIVE_MODEL_CACHE_CLEANUP_VERSION,
    }]);
    expect(cacheStorage.api.delete).not.toHaveBeenCalled();
  });

  it('retains every valid manual hide and restore above 500 and preserves all unrelated state', async () => {
    const decisions = Object.fromEntries(Array.from({ length: 702 }, (_, i) => [
      `manual-${i}`, manual(i % 2 === 0, ` ${i}`),
    ]));
    const compatible = {
      descriptions_twitter: ['Sports', 'synthetic topic'],
      theme: 'dim', enabled: false, filterReplies: false,
      stats: { filtered: 15, evaluated: 42, totalCost: 0 },
      nativeOperationFence: { operationId: 'synthetic-op', epoch: 1, startedAt: 12 },
      nativeModelStatus: { state: 'not_connected', revision: 3 },
      customModelsNote: 'unrelated name must survive',
      downloadSettings: { unrelated: true },
    };
    const storage = memoryStorage({
      ...compatible,
      ...oldBackendSnapshot(),
      pendingLocalModelSelection: { operationId: 'synthetic-old-download' },
      customModels: [{ name: 'synthetic-custom' }],
      predefinedModelKwargs: { temperature: 1 },
      evaluationCache: {
        ...decisions,
        automaticHide: { shouldHide: true, reasoning: 'old automatic' },
        automaticRestore: { shouldHide: false, reasoning: 'old automatic' },
      },
    });

    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).resolves.toBe(true);

    expect(storage.data.evaluationCache).toEqual(decisions);
    expect(Object.keys(storage.data.evaluationCache as object)).toHaveLength(702);
    expect(storage.data).toMatchObject(compatible);
    for (const key of RETIRED_BROWSER_MODEL_STORAGE_KEYS) {
      expect(storage.data).not.toHaveProperty(key);
    }
  });

  it('retains legacy optional fields and rejects malformed, automatic, and unresolved rows', () => {
    const oldShape = {
      ...manual(true), model: OLD_MODEL_KEY, rawResponse: null, category: 'Sports',
      matches: ['Sports'], cached: false,
      detectorStates: {
        names: ['synthetic'], map: { synthetic: { status: 'success', shouldHide: true } },
      },
    };
    const cache = {
      validHide: oldShape,
      validRestore: manual(false),
      automatic: { shouldHide: true, reasoning: 'automatic', userOverride: false },
      missingVerdict: { userOverride: true, reasoning: 'missing' },
      stringVerdict: { ...manual(true), shouldHide: 'true' },
      missingReason: { shouldHide: false, userOverride: true },
      badTimestamp: { ...manual(true), timestamp: Number.NaN },
      badMatches: { ...manual(true), matches: ['valid', 2] },
      badSnapshot: { ...manual(true), detectorStates: { names: [], map: { a: { status: 'pending' } } } },
      pending: { ...manual(true), pending: true },
      unsettled: { ...manual(false), settled: false },
      retry: { ...manual(false), retry: true },
      error: { ...manual(false), error: 'synthetic failure' },
      notObject: null,
    };

    expect(projectSettledManualCache(cache)).toEqual({
      validHide: oldShape, validRestore: manual(false),
    });
    const projected = projectSettledManualCache(cache);
    expect(projected.validHide).not.toBe(oldShape);
    expect(projectSettledManualCache([])).toEqual({});
    expect(projectSettledManualCache(null)).toEqual({});
  });

  it('does not rerun the completed cutover or clear newer native automatic cache rows', async () => {
    const cache = { native: { shouldHide: true, reasoning: 'current automatic', classifierFingerprint: 'current' } };
    const storage = memoryStorage({
      [NATIVE_CUTOVER_STORAGE_SCHEMA_KEY]: NATIVE_CUTOVER_STORAGE_SCHEMA_VERSION,
      [NATIVE_MODEL_CACHE_CLEANUP_KEY]: NATIVE_MODEL_CACHE_CLEANUP_VERSION,
      evaluationCache: cache,
    });
    const cacheStorage = memoryCaches();

    await expect(migrateToNativeModel({
      storage, cacheStorage: cacheStorage.api, closeLegacyRuntime,
    })).resolves.toEqual({ storageNormalized: false, retiredCachesCleaned: false });

    expect(storage.data.evaluationCache).toEqual(cache);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(closeLegacyRuntime).not.toHaveBeenCalled();
    expect(cacheStorage.api.keys).not.toHaveBeenCalled();
  });

  it('shares one asynchronous barrier across concurrent callers', async () => {
    const storage = memoryStorage({ evaluationCache: { saved: manual(true) } });
    const cacheStorage = memoryCaches();
    let release!: () => void;
    const closing = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn(() => closing);
    const first = migrateToNativeModel({ storage, cacheStorage: cacheStorage.api, closeLegacyRuntime: close });
    const second = migrateToNativeModel({ storage, cacheStorage: cacheStorage.api, closeLegacyRuntime: close });
    expect(first).toBe(second);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(storage.set).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(storage.set).toHaveBeenCalledTimes(3);
    expect(storage.data.evaluationCache).toEqual({ saved: manual(true) });
  });

  it('blocks persistence and cache deletion if the legacy runtime could not close', async () => {
    const storage = memoryStorage({ evaluationCache: { saved: manual(false) } });
    const cacheStorage = memoryCaches({ 'litertlm-cache': ['synthetic-old-weights'] });
    const close = vi.fn(async () => { throw new Error('synthetic close failed'); });

    await expect(migrateToNativeModel({
      storage, cacheStorage: cacheStorage.api, closeLegacyRuntime: close,
    })).rejects.toThrow('synthetic close failed');
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(cacheStorage.api.delete).not.toHaveBeenCalled();
  });

  it('keeps a failed transform unmarked, skips cleanup, and retries', async () => {
    const original = { ...oldBackendSnapshot(), evaluationCache: { saved: manual(true) } };
    const storage = memoryStorage(original);
    storage.set.mockRejectedValueOnce(new Error('synthetic storage full'));
    const cacheStorage = memoryCaches({ 'litertlm-cache': ['synthetic-old-weights'] });

    await expect(migrateToNativeModel({
      storage, cacheStorage: cacheStorage.api, closeLegacyRuntime,
    })).rejects.toThrow('synthetic storage full');
    expect(storage.data).toEqual(original);
    expect(cacheStorage.api.delete).not.toHaveBeenCalled();

    await expect(migrateToNativeModel({
      storage, cacheStorage: cacheStorage.api, closeLegacyRuntime,
    })).resolves.toEqual({ storageNormalized: true, retiredCachesCleaned: true });
    expect(storage.data.evaluationCache).toEqual(original.evaluationCache);
  });

  it('retains manual rows through a partial removal failure and retries', async () => {
    const storage = memoryStorage({
      ...oldBackendSnapshot(), evaluationCache: { hide: manual(true), restore: manual(false), automatic: { shouldHide: true } },
    });
    storage.remove.mockImplementationOnce(async () => {
      delete storage.data.selectedModel;
      throw new Error('synthetic partial remove');
    });

    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).rejects.toThrow('synthetic partial remove');
    expect(storage.data).not.toHaveProperty(NATIVE_CUTOVER_STORAGE_SCHEMA_KEY);
    expect(storage.data.evaluationCache).toEqual({ hide: manual(true), restore: manual(false) });
    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).resolves.toBe(true);
    expect(storage.data.evaluationCache).toEqual({ hide: manual(true), restore: manual(false) });
  });

  it('does not publish success when the cache readback differs', async () => {
    const storage = memoryStorage({ evaluationCache: { saved: manual(false) } });
    const realGet = storage.get.getMockImplementation()!;
    storage.get.mockImplementation(async keys => {
      const values = await realGet(keys);
      return Array.isArray(keys) && keys.includes('selectedModel')
        ? { ...values, evaluationCache: {} } : values;
    });

    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).rejects.toThrow('manual cache differs');
    expect(storage.data).not.toHaveProperty(NATIVE_CUTOVER_STORAGE_SCHEMA_KEY);
    expect(storage.data.evaluationCache).toEqual({ saved: manual(false) });
    storage.get.mockImplementation(realGet);
    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).resolves.toBe(true);
  });

  it('does not publish success when a removal silently leaves retired keys', async () => {
    const storage = memoryStorage({ ...oldBackendSnapshot(), evaluationCache: { saved: manual(true) } });
    storage.remove.mockImplementationOnce(async () => undefined);

    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).rejects.toThrow('retired storage keys remain');
    expect(storage.data).not.toHaveProperty(NATIVE_CUTOVER_STORAGE_SCHEMA_KEY);
    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).resolves.toBe(true);
    expect(storage.data.evaluationCache).toEqual({ saved: manual(true) });
  });

  it('removes a partially committed marker after a rejected marker write', async () => {
    const storage = memoryStorage({ evaluationCache: { saved: manual(true) } });
    const realSet = storage.set.getMockImplementation()!;
    storage.set.mockImplementation(async items => {
      await realSet(items);
      if (NATIVE_CUTOVER_STORAGE_SCHEMA_KEY in items) throw new Error('synthetic marker failure');
    });

    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).rejects.toThrow('synthetic marker failure');
    expect(storage.data).not.toHaveProperty(NATIVE_CUTOVER_STORAGE_SCHEMA_KEY);
    expect(storage.data.evaluationCache).toEqual({ saved: manual(true) });
    storage.set.mockImplementation(realSet);
    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).resolves.toBe(true);
  });

  it('ignores separated cutover housekeeping events without clearing preserved decisions', async () => {
    const storage = memoryStorage({ ...oldBackendSnapshot(), evaluationCache: { saved: manual(true) } });
    await normalizeNativeStorage(storage, closeLegacyRuntime);
    const cacheClear = vi.fn();
    for (const event of storage.events) {
      const genuine = stripNativeCutoverStorageChanges(event);
      if (genuine.selectedModel || genuine.descriptions_twitter) cacheClear();
    }
    expect(storage.events.map(event => Object.keys(event))).toEqual([
      ['evaluationCache'],
      ['selectedModel', 'localModelStatuses', 'gemmaOnlySchemaVersion', 'retiredModelCacheCleanupVersion'],
      [NATIVE_CUTOVER_STORAGE_SCHEMA_KEY],
    ]);
    expect(cacheClear).not.toHaveBeenCalled();
    expect(stripNativeCutoverStorageChanges({
      selectedModel: { oldValue: OLD_MODEL_KEY },
      descriptions_twitter: { oldValue: ['old'], newValue: ['new'] },
      enabled: { oldValue: true, newValue: false },
    })).toEqual({
      descriptions_twitter: { oldValue: ['old'], newValue: ['new'] },
      enabled: { oldValue: true, newValue: false },
    });
  });

  it('retains genuine writes to former model keys for diagnostics rather than hiding them', () => {
    const change = { selectedModel: { oldValue: OLD_MODEL_KEY, newValue: 'unexpected-new-value' } };
    expect(stripNativeCutoverStorageChanges(change)).toEqual(change);
  });
});

describe('owned browser model cache cleanup', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('deletes whole owned buckets and preserves unrelated caches and lookalike names', async () => {
    const storage = memoryStorage();
    const cacheStorage = memoryCaches({
      'litertlm-cache': ['synthetic-E2B', 'synthetic-E4B'],
      'webllm/model': ['synthetic-qwen'],
      'webllm/config': ['synthetic-config'],
      'webllm/wasm': ['synthetic-runtime'],
      'bouncer-model-old': ['synthetic-legacy'],
      'unrelated-cache': ['synthetic-keep'],
      'litertlm-cache-backup': ['synthetic-keep'],
      'other/webllm/model': ['synthetic-keep'],
      'webllmish': ['synthetic-keep'],
    });

    await expect(cleanupRetiredModelCaches(storage, cacheStorage.api)).resolves.toBe(true);
    expect([...cacheStorage.entries.keys()].sort()).toEqual([
      'litertlm-cache-backup', 'other/webllm/model', 'unrelated-cache', 'webllmish',
    ]);
    expect(cacheStorage.api.open).not.toHaveBeenCalled();
    expect(storage.data[NATIVE_MODEL_CACHE_CLEANUP_KEY]).toBe(NATIVE_MODEL_CACHE_CLEANUP_VERSION);
  });

  it('does not mark a false-returning deletion complete and retries without blocking manual state', async () => {
    const storage = memoryStorage({ evaluationCache: { saved: manual(false) } });
    const cacheStorage = memoryCaches({ 'litertlm-cache': ['synthetic-old'] });
    cacheStorage.delete.mockResolvedValueOnce(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(migrateToNativeModel({
      storage, cacheStorage: cacheStorage.api, closeLegacyRuntime,
    })).resolves.toEqual({ storageNormalized: true, retiredCachesCleaned: false });
    expect(storage.data[NATIVE_CUTOVER_STORAGE_SCHEMA_KEY]).toBe(NATIVE_CUTOVER_STORAGE_SCHEMA_VERSION);
    expect(storage.data).not.toHaveProperty(NATIVE_MODEL_CACHE_CLEANUP_KEY);
    expect(storage.data.evaluationCache).toEqual({ saved: manual(false) });
    expect(warn).toHaveBeenCalledWith(
      '[Model migration] Retired cache cleanup failed; will retry',
      expect.objectContaining({ message: 'Retired browser model caches remain after cleanup' }),
    );

    await expect(migrateToNativeModel({
      storage, cacheStorage: cacheStorage.api, closeLegacyRuntime,
    })).resolves.toEqual({ storageNormalized: false, retiredCachesCleaned: true });
    expect(cacheStorage.entries.size).toBe(0);
    expect(storage.data.evaluationCache).toEqual({ saved: manual(false) });
  });

  it('retries a thrown partial bucket deletion without deleting unrelated data', async () => {
    const storage = memoryStorage();
    const cacheStorage = memoryCaches({
      'webllm/model': ['synthetic-old'], 'litertlm-cache': ['synthetic-old'], unrelated: ['synthetic-keep'],
    });
    const realDelete = cacheStorage.delete.getMockImplementation()!;
    cacheStorage.delete.mockImplementationOnce(realDelete)
      .mockRejectedValueOnce(new Error('synthetic blocked deletion'));

    await expect(cleanupRetiredModelCaches(storage, cacheStorage.api)).rejects.toThrow('synthetic blocked deletion');
    expect(storage.data).not.toHaveProperty(NATIVE_MODEL_CACHE_CLEANUP_KEY);
    expect([...cacheStorage.entries.keys()]).toEqual(['litertlm-cache', 'unrelated']);
    await expect(cleanupRetiredModelCaches(storage, cacheStorage.api)).resolves.toBe(true);
    expect([...cacheStorage.entries.keys()]).toEqual(['unrelated']);
  });

  it('leaves rejected cache-cleanup marker writes unmarked even if partially committed', async () => {
    const storage = memoryStorage();
    const cacheStorage = memoryCaches();
    const realSet = storage.set.getMockImplementation()!;
    storage.set.mockImplementation(async items => {
      await realSet(items);
      throw new Error('synthetic cleanup marker failure');
    });

    await expect(cleanupRetiredModelCaches(storage, cacheStorage.api)).rejects.toThrow('synthetic cleanup marker failure');
    expect(storage.data).not.toHaveProperty(NATIVE_MODEL_CACHE_CLEANUP_KEY);
  });
});

describe('native-era rollback projection', () => {
  it('keeps current edits and every manual decision while restoring only old backend markers', () => {
    const manualRows = Object.fromEntries(Array.from({ length: 650 }, (_, i) => [
      `current-${i}`, manual(i % 2 === 0, ` ${i}`),
    ]));
    const current = {
      descriptions_twitter: ['new ordered phrase', 'Sports'],
      theme: 'dark', enabled: false, filterReplies: false,
      stats: { filtered: 22, evaluated: 100, totalCost: 0 },
      unrelated: 'current value',
      nativeModelStatus: { state: 'recovery_required', revision: 10 },
      [NATIVE_CUTOVER_STORAGE_SCHEMA_KEY]: NATIVE_CUTOVER_STORAGE_SCHEMA_VERSION,
      [NATIVE_MODEL_CACHE_CLEANUP_KEY]: NATIVE_MODEL_CACHE_CLEANUP_VERSION,
      evaluationCache: {
        ...manualRows,
        nativeAutomatic: { shouldHide: true, reasoning: 'new automatic', classifierFingerprint: 'native' },
      },
    };
    const historical = {
      ...oldBackendSnapshot(),
      descriptions_twitter: ['obsolete phrase'], enabled: true, theme: 'light',
      stats: { filtered: 1, evaluated: 1, totalCost: 0 },
      evaluationCache: { intentionallyInvalidated: manual(true), oldAutomatic: { shouldHide: true } },
      customModels: [{ name: 'unwanted historical custom' }],
    };
    const beforeCurrent = structuredClone(current);
    const beforeHistorical = structuredClone(historical);

    const projected = projectNativeStorageForBrowserRollback(current, historical);

    expect(projected).toMatchObject({
      descriptions_twitter: current.descriptions_twitter,
      theme: 'dark', enabled: false, filterReplies: false,
      stats: current.stats, unrelated: 'current value',
      selectedModel: OLD_MODEL_KEY,
      gemmaOnlySchemaVersion: 1, retiredModelCacheCleanupVersion: 1,
      localModelStatuses: { [OLD_MODEL_ID]: { state: 'cached' } },
      evaluationCache: manualRows,
    });
    expect(Object.keys(projected.evaluationCache as object)).toHaveLength(650);
    expect(projected).not.toHaveProperty(NATIVE_CUTOVER_STORAGE_SCHEMA_KEY);
    expect(projected).not.toHaveProperty(NATIVE_MODEL_CACHE_CLEANUP_KEY);
    expect(projected).not.toHaveProperty('nativeModelStatus');
    expect(projected).not.toHaveProperty('customModels');
    expect(current).toEqual(beforeCurrent);
    expect(historical).toEqual(beforeHistorical);
  });

  it.each([
    { enabled: true, fence: { operationId: 'synthetic-unresolved', epoch: 5, startedAt: 100 } },
    { enabled: false, fence: { operationId: 'synthetic-unresolved', epoch: 5, startedAt: 100 } },
    { enabled: true, fence: { malformed: true } },
    { enabled: false, fence: null },
    { enabled: true, fence: undefined },
  ])('rejects rollback with any native fence until qualified settlement: %j', ({ enabled, fence }) => {
    const current = {
      enabled,
      nativeOperationFence: fence,
      descriptions_twitter: ['current phrase'],
      evaluationCache: { currentHide: manual(true), currentRestore: manual(false) },
    };
    const historical = {
      ...oldBackendSnapshot(), enabled: true, descriptions_twitter: ['obsolete phrase'],
      evaluationCache: { obsoleteHide: manual(true) },
    };
    const beforeCurrent = structuredClone(current);
    const beforeHistorical = structuredClone(historical);

    expect(() => projectNativeStorageForBrowserRollback(current, historical)).toThrow(
      'Rollback requires qualified native-operation settlement before restoring browser execution',
    );
    expect(current).toEqual(beforeCurrent);
    expect(current).toHaveProperty('nativeOperationFence');
    expect(historical).toEqual(beforeHistorical);
  });

  it('does not resurrect decisions after a genuine native-era phrase edit cleared the cache', () => {
    const current = { descriptions_twitter: ['new phrase'], evaluationCache: {} };
    const historical = {
      ...oldBackendSnapshot(), descriptions_twitter: ['old phrase'],
      evaluationCache: { invalidatedHide: manual(true), invalidatedRestore: manual(false) },
    };
    const projected = projectNativeStorageForBrowserRollback(current, historical);
    expect(projected.descriptions_twitter).toEqual(['new phrase']);
    expect(projected.evaluationCache).toEqual({});
  });

  it('rejects missing or incompatible old schema markers before the historical normalizer can clear decisions', () => {
    const current = { evaluationCache: { saved: manual(true) } };
    expect(() => projectNativeStorageForBrowserRollback(current, {})).toThrow('verified Gemma E2B');
    expect(() => projectNativeStorageForBrowserRollback(current, {
      selectedModel: OLD_MODEL_KEY, gemmaOnlySchemaVersion: 0,
    })).toThrow('verified Gemma E2B');
    expect(() => projectNativeStorageForBrowserRollback(current, {
      selectedModel: 'local:unexpected', gemmaOnlySchemaVersion: 1,
    })).toThrow('verified Gemma E2B');
    expect(current.evaluationCache).toEqual({ saved: manual(true) });
  });

  it('preserves the latest manual direction through cutover, native edits, rollback, and a second cutover', async () => {
    const storage = memoryStorage({
      ...oldBackendSnapshot(), descriptions_twitter: ['Sports'],
      evaluationCache: { changedPost: manual(true), untouchedRestore: manual(false) },
    });
    await normalizeNativeStorage(storage, closeLegacyRuntime);
    storage.data.descriptions_twitter = ['Sports', 'current ordered phrase'];
    storage.data.evaluationCache = {
      changedPost: manual(false, ' latest direction'),
      newHide: manual(true, ' after cutover'),
      nativeAutomatic: { shouldHide: true, reasoning: 'native automatic' },
    };
    const rollback = projectNativeStorageForBrowserRollback(storage.data, oldBackendSnapshot());
    expect(rollback.evaluationCache).toEqual({
      changedPost: manual(false, ' latest direction'), newHide: manual(true, ' after cutover'),
    });
    const rolledBack = memoryStorage(rollback);
    await normalizeNativeStorage(rolledBack, closeLegacyRuntime);
    expect(rolledBack.data.evaluationCache).toEqual(rollback.evaluationCache);
    expect(rolledBack.data.descriptions_twitter).toEqual(['Sports', 'current ordered phrase']);
    expect(rolledBack.data.evaluationCache).not.toHaveProperty('untouchedRestore');
  });
});
