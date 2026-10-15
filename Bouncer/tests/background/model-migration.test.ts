import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ENGINE_CHOICE_STORAGE_SCHEMA_KEY,
  ENGINE_CHOICE_STORAGE_SCHEMA_VERSION,
  ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY,
  ENGINE_CHOICE_MODEL_CACHE_CLEANUP_VERSION,
  RETIRED_BROWSER_MODEL_STORAGE_KEYS,
  cleanupRetiredModelCaches,
  migrateEngineChoice,
  normalizeEngineChoice,
  isValidEngineSelection,
  migrateToNativeModel,
  normalizeNativeStorage,
  projectNativeStorageForBrowserRollback,
  projectSettledManualCache,
  stripNativeCutoverStorageChanges,
  type StorageChange,
} from '../../src/background/model-migration.js';

import {
  BROWSER_CLASSIFIER_FINGERPRINT, BROWSER_MODEL_ID, BROWSER_MODEL_URL,
  NATIVE_CLASSIFIER_FINGERPRINT, PRIMARY_LOCAL_MODEL_ID,
} from '../../src/shared/models.js';

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
  deleteEntry: Mock<(name: string, url: string) => Promise<boolean>>;
}

function memoryCaches(initial: Record<string, string[]> = {}): MemoryCacheStorage {
  const entries = new Map(Object.entries(structuredClone(initial)));
  const remove = vi.fn(async (name: string) => entries.delete(name));
  const deleteEntry = vi.fn(async (name: string, url: string) => {
    const values = entries.get(name) ?? [];
    const existed = values.includes(url);
    entries.set(name, values.filter(value => value !== url));
    return existed;
  });
  const api = {
    keys: vi.fn(async () => [...entries.keys()]),
    delete: remove,
    open: vi.fn(async (name: string) => {
      if (!entries.has(name)) throw new Error('Migration must not create model buckets');
      return {
        keys: vi.fn(async () => (entries.get(name) ?? []).map(url => new Request(url))),
        delete: vi.fn(async (request: Request) => deleteEntry(name, request.url)),
        match: vi.fn(async () => { throw new Error('Migration must not read model bytes'); }),
        put: vi.fn(async () => { throw new Error('Migration must not replace model bytes'); }),
      };
    }),
  } as unknown as CacheStorage;
  return { api, entries, delete: remove, deleteEntry };
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

describe('engine choice provenance and current data', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ['fresh', {}, null],
    ['validated historical LiteRT', oldBackendSnapshot(), 'litertlm'],
    ['unvalidated historical LiteRT', { selectedModel: OLD_MODEL_KEY }, null],
    ['corrupt browser marker', { selectedModel: OLD_MODEL_KEY, gemmaOnlySchemaVersion: 2 }, null],
    ['retired model', { selectedModel: 'local:retired-model', gemmaOnlySchemaVersion: 1 }, null],
    ['completed native cutover', { nativeCutoverSchemaVersion: 1 }, 'ollama'],
    ['native provenance beats old browser markers', { ...oldBackendSnapshot(), nativeCutoverSchemaVersion: 1 }, 'ollama'],
    ['incomplete native cutover', { nativeCutoverSchemaVersion: 0 }, null],
    ['ready statuses do not select', { nativeModelStatus: { state: 'ready' }, browserModelStatus: { state: 'ready' } }, null],
  ])('selects only from validated provenance: %s', async (_name, initial, engine) => {
    const storage = memoryStorage(initial);
    await normalizeEngineChoice(storage, closeLegacyRuntime);
    expect(storage.data.engineSelection).toEqual({ engine, revision: 0 });
    expect(storage.data[ENGINE_CHOICE_STORAGE_SCHEMA_KEY]).toBe(ENGINE_CHOICE_STORAGE_SCHEMA_VERSION);
    expect(storage.data.nativeCutoverSchemaVersion).toBe(initial.nativeCutoverSchemaVersion);
    for (const key of RETIRED_BROWSER_MODEL_STORAGE_KEYS) expect(storage.data).not.toHaveProperty(key);
  });

  it.each(['ollama', 'litertlm', null])('preserves explicit choice %j ahead of both historical markers', async engine => {
    const selection = { engine, revision: 12 };
    const storage = memoryStorage({ ...oldBackendSnapshot(), nativeCutoverSchemaVersion: 1, engineSelection: selection });
    await normalizeEngineChoice(storage, closeLegacyRuntime);
    expect(storage.data.engineSelection).toEqual(selection);
    expect(closeLegacyRuntime).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, [], 'ollama', {}, { engine: 'unknown', revision: 8 },
    { engine: 'ollama', revision: -1 }, { engine: 'litertlm', revision: 1.1 },
    { engine: null, revision: Number.NaN }, { engine: 'ollama', revision: Number.MAX_SAFE_INTEGER + 1 },
  ])('fails corrupt new choice closed without consulting native provenance: %j', async selection => {
    const storage = memoryStorage({ ...oldBackendSnapshot(), nativeCutoverSchemaVersion: 1, engineSelection: selection });
    await normalizeEngineChoice(storage, closeLegacyRuntime);
    expect(storage.data.engineSelection).toEqual({ engine: null, revision: 0 });
    expect(closeLegacyRuntime).not.toHaveBeenCalled();
  });

  it.each([{}, { engineSelection: { engine: 'unknown', revision: 2 } }])('invalidates completed corrupt new schema and requires choice: %j', async values => {
    const storage = memoryStorage({ ...values, engineChoiceSchemaVersion: 1, nativeCutoverSchemaVersion: 1 });
    await normalizeEngineChoice(storage, closeLegacyRuntime);
    expect(storage.data.engineSelection).toEqual({ engine: null, revision: 0 });
    expect(storage.operations[1]).toBe(`remove:${ENGINE_CHOICE_STORAGE_SCHEMA_KEY}`);
    expect(closeLegacyRuntime).not.toHaveBeenCalled();
  });

  it('validates fixed engine names and nonnegative safe integer revisions', () => {
    expect(isValidEngineSelection({ engine: 'litertlm', revision: 0 })).toBe(true);
    expect(isValidEngineSelection({ engine: null, revision: 4 })).toBe(true);
    expect(isValidEngineSelection({ engine: 'ollama', revision: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(isValidEngineSelection({ engine: 'OLLAMA', revision: 0 })).toBe(false);
    expect(migrateToNativeModel).toBe(migrateEngineChoice);
    expect(normalizeNativeStorage).toBe(normalizeEngineChoice);
  });

  it.each([undefined, null, 'corrupt fence', false, { malformed: true, opaque: [null, 0, 'preserve'] }])('preserves any native fence byte-for-byte: %j', async fence => {
    const compatible = {
      nativeOperationFence: fence,
      nativeModelStatus: { state: 'blocked', revision: 4 },
      localModelStatus: { state: 'blocked', engine: 'litertlm', revision: 2 },
      browserModelStatus: { state: 'ready', engine: 'litertlm', revision: 5 },
      browserCacheGeneration: '52427f77-6003-4356-9917-90c39c212ee5',
    };
    const storage = memoryStorage({ ...compatible, nativeCutoverSchemaVersion: 1 });
    await migrateEngineChoice({ storage, cacheStorage: memoryCaches().api, closeLegacyRuntime });
    expect(storage.data).toMatchObject(compatible);
    expect(Object.hasOwn(storage.data, 'nativeOperationFence')).toBe(true);
    expect(storage.data.nativeOperationFence).toEqual(fence);
    expect(storage.set.mock.calls.some(([items]) => 'nativeOperationFence' in items)).toBe(false);
    expect(storage.remove.mock.calls.some(([keys]) => (Array.isArray(keys) ? keys : [keys]).includes('nativeOperationFence'))).toBe(false);
  });

  it.each(['ollama', 'litertlm', null])('keeps only current selected-engine automatic results: %j', async engine => {
    const native = { shouldHide: true, reasoning: 'synthetic native', model: PRIMARY_LOCAL_MODEL_ID, classifierFingerprint: NATIVE_CLASSIFIER_FINGERPRINT };
    const browser = { shouldHide: false, reasoning: 'synthetic browser', model: BROWSER_MODEL_ID, classifierFingerprint: BROWSER_CLASSIFIER_FINGERPRINT };
    const storage = memoryStorage({
      engineSelection: { engine, revision: 3 },
      evaluationCache: {
        hide: manual(true), restore: manual(false), native, browser,
        oldBrowser: { shouldHide: true, reasoning: 'historical browser', model: OLD_MODEL_KEY },
        wrongModel: { ...native, model: 'retired' }, malformed: { ...native, malformed: true }, unresolved: { ...native, pending: true },
      },
    });
    await normalizeEngineChoice(storage, closeLegacyRuntime);
    expect(storage.data.evaluationCache).toEqual({
      hide: manual(true), restore: manual(false),
      ...(engine === 'ollama' ? { native: { ...native, engine, selectionRevision: 3 } } : {}),
      ...(engine === 'litertlm' ? { browser: { ...browser, engine, selectionRevision: 3 } } : {}),
    });
  });

  it.each([
    ['ollama', 0, { nativeCutoverSchemaVersion: 1 }],
    ['litertlm', 7, { engineSelection: { engine: 'litertlm', revision: 7 } }],
  ])('adopts valid older %s automatic rows into the committed selection identity', async (engine, revision, provenance) => {
    const fingerprint = engine === 'ollama' ? NATIVE_CLASSIFIER_FINGERPRINT : BROWSER_CLASSIFIER_FINGERPRINT;
    const model = engine === 'ollama' ? PRIMARY_LOCAL_MODEL_ID : BROWSER_MODEL_ID;
    const result = { shouldHide: true, reasoning: 'synthetic compatible cached verdict', model, classifierFingerprint: fingerprint };
    const manualWithHistoricalIdentity = { ...manual(false), engine: 'retired', selectionRevision: -9 };
    const storage = memoryStorage({
      ...provenance,
      evaluationCache: {
        legacy: result,
        missingEngine: { ...result, selectionRevision: revision },
        missingRevision: { ...result, engine },
        mismatchedIdentity: { ...result, engine: engine === 'ollama' ? 'litertlm' : 'ollama', selectionRevision: revision + 10 },
        corruptIdentity: { ...result, engine: 'retired', selectionRevision: 'corrupt' },
        current: { ...result, engine, selectionRevision: revision },
        wrongFingerprint: { ...result, engine, selectionRevision: revision, classifierFingerprint: 'obsolete contract' },
        wrongModel: { ...result, engine, selectionRevision: revision, model: 'retired model' },
        manual: manualWithHistoricalIdentity,
      },
    });
    await normalizeEngineChoice(storage, closeLegacyRuntime);
    const adopted = { ...result, engine, selectionRevision: revision };
    expect(storage.data.engineSelection).toEqual({ engine, revision });
    expect(storage.data.evaluationCache).toEqual({
      legacy: adopted, missingEngine: adopted, missingRevision: adopted, current: adopted,
      manual: manualWithHistoricalIdentity,
    });
  });

  it('uses delayed latest manual and current native writes after closing old code and removing catalog keys', async () => {
    const native = { shouldHide: true, reasoning: 'synthetic current native', classifierFingerprint: NATIVE_CLASSIFIER_FINGERPRINT, engine: 'ollama', selectionRevision: 0 };
    const storage = memoryStorage({ nativeCutoverSchemaVersion: 1, evaluationCache: { changed: manual(true), stale: { shouldHide: true } } });
    const close = vi.fn(async () => {
      storage.data.evaluationCache = { changed: manual(false, ' during close'), native };
    });
    const realRemove = storage.remove.getMockImplementation()!;
    storage.remove.mockImplementation(async keys => {
      await realRemove(keys);
      if (Array.isArray(keys) && keys.includes('selectedModel')) {
        storage.data.evaluationCache = { changed: manual(false, ' latest'), native, newest: manual(true) };
      }
    });
    await normalizeEngineChoice(storage, close);
    expect(storage.data.evaluationCache).toEqual({ changed: manual(false, ' latest'), native, newest: manual(true) });
    expect(storage.set.mock.calls.some(([items]) => 'evaluationCache' in items)).toBe(false);
  });

  it('closes legacy code only once after a successful close even if the first transform fails', async () => {
    const storage = memoryStorage(oldBackendSnapshot());
    storage.set.mockRejectedValueOnce(new Error('synthetic storage failure'));
    await expect(normalizeEngineChoice(storage, closeLegacyRuntime)).rejects.toThrow('synthetic storage failure');
    await normalizeEngineChoice(storage, closeLegacyRuntime);
    expect(closeLegacyRuntime).toHaveBeenCalledTimes(1);
  });

  it('does not close the current browser host or rewrite completed selection/resources on another wake', async () => {
    const original = {
      engineSelection: { engine: 'litertlm', revision: 6 }, engineChoiceSchemaVersion: 1,
      engineChoiceModelCacheCleanupVersion: 1, nativeCutoverSchemaVersion: 1,
      browserModelStatus: { state: 'ready', revision: 20 },
      evaluationCache: { newest: manual(false), current: { shouldHide: true, reasoning: 'current browser', classifierFingerprint: BROWSER_CLASSIFIER_FINGERPRINT } },
    };
    const storage = memoryStorage(original);
    await expect(migrateEngineChoice({ storage, cacheStorage: memoryCaches().api, closeLegacyRuntime })).resolves.toEqual({ storageNormalized: false, retiredCachesCleaned: false });
    expect(storage.data).toEqual(original);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(closeLegacyRuntime).not.toHaveBeenCalled();
  });

  it('fails cache-independent selection readback and never overwrites a changed explicit choice', async () => {
    const storage = memoryStorage({ ...oldBackendSnapshot(), evaluationCache: { saved: manual(false) } });
    const realSet = storage.set.getMockImplementation()!;
    storage.set.mockImplementation(async items => {
      await realSet(items);
      if ('engineSelection' in items) storage.data.engineSelection = { engine: 'ollama', revision: 9 };
    });
    await expect(normalizeEngineChoice(storage, closeLegacyRuntime)).rejects.toThrow('engine selection differs');
    expect(storage.data.evaluationCache).toEqual({ saved: manual(false) });
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_STORAGE_SCHEMA_KEY);
  });

  it('verifies captured provenance before removing legacy choice when a selection write silently fails', async () => {
    const storage = memoryStorage(oldBackendSnapshot());
    storage.set.mockResolvedValueOnce(undefined);
    await expect(normalizeEngineChoice(storage, closeLegacyRuntime)).rejects.toThrow('engine selection differs');
    expect(storage.data.selectedModel).toBe(OLD_MODEL_KEY);
    expect(storage.data.gemmaOnlySchemaVersion).toBe(1);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_STORAGE_SCHEMA_KEY);
    await normalizeEngineChoice(storage, closeLegacyRuntime);
    expect(storage.data.engineSelection).toEqual({ engine: 'litertlm', revision: 0 });
  });

  it('detects a silently lost final marker and retries with captured choice intact', async () => {
    const storage = memoryStorage(oldBackendSnapshot());
    const realSet = storage.set.getMockImplementation()!;
    storage.set.mockImplementation(async items => {
      await realSet(items);
      if (ENGINE_CHOICE_STORAGE_SCHEMA_KEY in items) delete storage.data[ENGINE_CHOICE_STORAGE_SCHEMA_KEY];
    });
    await expect(normalizeEngineChoice(storage, closeLegacyRuntime)).rejects.toThrow('completion marker differs');
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_STORAGE_SCHEMA_KEY);
    expect(storage.data.engineSelection).toEqual({ engine: 'litertlm', revision: 0 });
    storage.set.mockImplementation(realSet);
    await normalizeEngineChoice(storage, closeLegacyRuntime);
  });

  it('keeps meaningful selection/status/settings events while stripping only housekeeping', () => {
    const visible = {
      engineSelection: { newValue: { engine: 'litertlm', revision: 1 } },
      localModelStatus: { newValue: { state: 'ready', engine: 'litertlm', revision: 5 } },
      nativeOperationFence: { newValue: { malformed: true } },
      browserModelStatus: { newValue: { state: 'downloading', revision: 5 } },
      descriptions_twitter: { oldValue: ['old'], newValue: ['new'] }, enabled: { oldValue: true, newValue: false },
    };
    expect(stripNativeCutoverStorageChanges({
      ...visible, selectedModel: { oldValue: OLD_MODEL_KEY }, gemmaOnlySchemaVersion: { oldValue: 1 },
      [ENGINE_CHOICE_STORAGE_SCHEMA_KEY]: { newValue: 1 }, [ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY]: { newValue: 1 },
      nativeCutoverSchemaVersion: { newValue: 1 }, nativeModelCacheCleanupVersion: { newValue: 1 },
    })).toEqual(visible);
  });
});

describe('explicit engine choice migration', () => {
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
      engineSelection: { engine: null, revision: 0 },
      [ENGINE_CHOICE_STORAGE_SCHEMA_KEY]: ENGINE_CHOICE_STORAGE_SCHEMA_VERSION,
      [ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY]: ENGINE_CHOICE_MODEL_CACHE_CLEANUP_VERSION,
    });
    expect(storage.operations.indexOf('close')).toBeLessThan(
      storage.operations.indexOf('set:evaluationCache'),
    );
    expect(storage.operations.indexOf(`set:${ENGINE_CHOICE_STORAGE_SCHEMA_KEY}`)).toBeGreaterThan(
      storage.operations.indexOf(`get:engineSelection,evaluationCache,${RETIRED_BROWSER_MODEL_STORAGE_KEYS.join(',')}`),
    );
    expect(storage.set.mock.calls.at(-1)).toEqual([{
      [ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY]: ENGINE_CHOICE_MODEL_CACHE_CLEANUP_VERSION,
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
    const cache = { native: { shouldHide: true, reasoning: 'current automatic', classifierFingerprint: NATIVE_CLASSIFIER_FINGERPRINT } };
    const storage = memoryStorage({
      engineSelection: { engine: 'ollama', revision: 6 },
      [ENGINE_CHOICE_STORAGE_SCHEMA_KEY]: ENGINE_CHOICE_STORAGE_SCHEMA_VERSION,
      [ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY]: ENGINE_CHOICE_MODEL_CACHE_CLEANUP_VERSION,
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
    const cacheStorage = memoryCaches({ 'litertlm-cache': [BROWSER_MODEL_URL] });
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
    const cacheStorage = memoryCaches({ 'litertlm-cache': [BROWSER_MODEL_URL] });

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
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_STORAGE_SCHEMA_KEY);
    expect(storage.data.evaluationCache).toEqual({ hide: manual(true), restore: manual(false), automatic: { shouldHide: true } });
    expect(storage.data.engineSelection).toEqual({ engine: 'litertlm', revision: 0 });
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

    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).rejects.toThrow('compatible cache differs');
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_STORAGE_SCHEMA_KEY);
    expect(storage.data.evaluationCache).toEqual({ saved: manual(false) });
    storage.get.mockImplementation(realGet);
    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).resolves.toBe(true);
  });

  it('does not publish success when a removal silently leaves retired keys', async () => {
    const storage = memoryStorage({ ...oldBackendSnapshot(), evaluationCache: { saved: manual(true) } });
    storage.remove.mockImplementationOnce(async () => undefined);

    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).rejects.toThrow('retired storage keys remain');
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_STORAGE_SCHEMA_KEY);
    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).resolves.toBe(true);
    expect(storage.data.evaluationCache).toEqual({ saved: manual(true) });
  });

  it('removes a partially committed marker after a rejected marker write', async () => {
    const storage = memoryStorage({ evaluationCache: { saved: manual(true) } });
    const realSet = storage.set.getMockImplementation()!;
    storage.set.mockImplementation(async items => {
      await realSet(items);
      if (ENGINE_CHOICE_STORAGE_SCHEMA_KEY in items) throw new Error('synthetic marker failure');
    });

    await expect(normalizeNativeStorage(storage, closeLegacyRuntime)).rejects.toThrow('synthetic marker failure');
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_STORAGE_SCHEMA_KEY);
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
      ['engineSelection'],
      ['selectedModel', 'localModelStatuses', 'gemmaOnlySchemaVersion', 'retiredModelCacheCleanupVersion'],
      [ENGINE_CHOICE_STORAGE_SCHEMA_KEY],
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

const GENERATION = '52427f77-6003-4356-9917-90c39c212ee5';
const CURRENT_GENERATION_KEY = `${BROWSER_MODEL_URL}?bouncer-generation=${GENERATION}`;
const RETIRED_MODEL_URL = BROWSER_MODEL_URL.replaceAll('E2B', 'E4B');

describe('preservation-aware browser model cache cleanup', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('preserves exact pinned and strict generation entries, unrelated buckets, and unrelated assets', async () => {
    const generation2 = `${BROWSER_MODEL_URL}?bouncer-generation=722863c7-aac0-4633-838f-4ca9368fc319`;
    const unrelatedAsset = 'https://example.test/synthetic-logo.png';
    const caches = memoryCaches({
      'litertlm-cache': [BROWSER_MODEL_URL, CURRENT_GENERATION_KEY, generation2, RETIRED_MODEL_URL,
        `${BROWSER_MODEL_URL}?bouncer-generation=not-a-uuid`, `${CURRENT_GENERATION_KEY}&unexpected=1`,
        `${BROWSER_MODEL_URL}?unqualified=1`, unrelatedAsset],
      'webllm/model': ['https://example.test/model'], 'webllm/config': ['https://example.test/config'],
      'bouncer-model-old': ['https://example.test/old-runtime'],
      'unrelated-cache': [RETIRED_MODEL_URL], 'litertlm-cache-backup': [RETIRED_MODEL_URL],
      'other/webllm/model': [RETIRED_MODEL_URL], webllmish: [RETIRED_MODEL_URL],
    });
    const storage = memoryStorage({ nativeModelCacheCleanupVersion: 1, browserCacheGeneration: GENERATION });
    await expect(cleanupRetiredModelCaches(storage, caches.api)).resolves.toBe(true);
    expect(caches.entries.get('litertlm-cache')).toEqual([BROWSER_MODEL_URL, CURRENT_GENERATION_KEY, generation2, unrelatedAsset]);
    expect([...caches.entries.keys()].sort()).toEqual(['litertlm-cache', 'litertlm-cache-backup', 'other/webllm/model', 'unrelated-cache', 'webllmish']);
    expect(caches.api.delete).not.toHaveBeenCalledWith('litertlm-cache');
    expect(storage.data.browserCacheGeneration).toBe(GENERATION);
    expect(storage.data.nativeModelCacheCleanupVersion).toBe(1);
    expect(storage.data[ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY]).toBe(1);
  });

  it('does not create absent model buckets or initialize/download browser or native resources', async () => {
    const storage = memoryStorage(oldBackendSnapshot());
    const caches = memoryCaches({ unrelated: ['https://example.test/keep'] });
    const fetch = vi.fn(async () => { throw new Error('Unexpected network'); });
    vi.stubGlobal('fetch', fetch);
    try {
      await migrateEngineChoice({ storage, cacheStorage: caches.api, closeLegacyRuntime });
      expect(caches.api.open).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(storage.data).not.toHaveProperty('browserModelStatus');
      expect(storage.data).not.toHaveProperty('nativeModelStatus');
      expect(closeLegacyRuntime).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['bucket', 'entry'])('retries false-returning %s deletion independently of choice and manual state', async kind => {
    const storage = memoryStorage({ evaluationCache: { saved: manual(false) } });
    const caches = memoryCaches(kind === 'bucket'
      ? { 'webllm/model': [RETIRED_MODEL_URL] }
      : { 'litertlm-cache': [BROWSER_MODEL_URL, RETIRED_MODEL_URL] });
    if (kind === 'bucket') caches.delete.mockResolvedValueOnce(false);
    else caches.deleteEntry.mockResolvedValueOnce(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const overrides = { storage, cacheStorage: caches.api, closeLegacyRuntime };
    await expect(migrateEngineChoice(overrides)).resolves.toEqual({ storageNormalized: true, retiredCachesCleaned: false });
    expect(storage.data[ENGINE_CHOICE_STORAGE_SCHEMA_KEY]).toBe(1);
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY);
    expect(storage.data.evaluationCache).toEqual({ saved: manual(false) });
    expect(warn).toHaveBeenCalled();
    await expect(migrateEngineChoice(overrides)).resolves.toEqual({ storageNormalized: false, retiredCachesCleaned: true });
    expect(closeLegacyRuntime).toHaveBeenCalledTimes(1);
    if (kind === 'entry') expect(caches.entries.get('litertlm-cache')).toEqual([BROWSER_MODEL_URL]);
  });

  it('retries partial cache failure without deleting pinned bytes or unrelated data', async () => {
    const storage = memoryStorage();
    const caches = memoryCaches({
      'webllm/model': [RETIRED_MODEL_URL],
      'litertlm-cache': [BROWSER_MODEL_URL, CURRENT_GENERATION_KEY, RETIRED_MODEL_URL],
      unrelated: [RETIRED_MODEL_URL],
    });
    caches.deleteEntry.mockRejectedValueOnce(new Error('synthetic blocked deletion'));
    await expect(cleanupRetiredModelCaches(storage, caches.api)).rejects.toThrow('synthetic blocked deletion');
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY);
    expect(caches.entries.get('litertlm-cache')).toContain(BROWSER_MODEL_URL);
    await cleanupRetiredModelCaches(storage, caches.api);
    expect(caches.entries.get('litertlm-cache')).toEqual([BROWSER_MODEL_URL, CURRENT_GENERATION_KEY]);
    expect(caches.entries.get('unrelated')).toEqual([RETIRED_MODEL_URL]);
  });

  it('removes partially committed failed cleanup markers', async () => {
    const storage = memoryStorage();
    const realSet = storage.set.getMockImplementation()!;
    storage.set.mockImplementation(async items => { await realSet(items); throw new Error('synthetic cleanup marker failure'); });
    await expect(cleanupRetiredModelCaches(storage, memoryCaches().api)).rejects.toThrow('synthetic cleanup marker failure');
    expect(storage.data).not.toHaveProperty(ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY);
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
      nativeCutoverSchemaVersion: 1, nativeModelCacheCleanupVersion: 1,
      [ENGINE_CHOICE_STORAGE_SCHEMA_KEY]: ENGINE_CHOICE_STORAGE_SCHEMA_VERSION,
      [ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY]: ENGINE_CHOICE_MODEL_CACHE_CLEANUP_VERSION,
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
    expect(projected).not.toHaveProperty(ENGINE_CHOICE_STORAGE_SCHEMA_KEY);
    expect(projected).not.toHaveProperty(ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY);
    expect(projected).not.toHaveProperty('nativeModelStatus');
    expect(projected).not.toHaveProperty('nativeCutoverSchemaVersion');
    expect(projected).not.toHaveProperty('nativeModelCacheCleanupVersion');
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
