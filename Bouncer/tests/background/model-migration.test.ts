import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  GEMMA_ONLY_CACHE_CLEANUP_KEY,
  GEMMA_ONLY_CACHE_CLEANUP_VERSION,
  GEMMA_ONLY_STORAGE_SCHEMA_KEY,
  GEMMA_ONLY_STORAGE_SCHEMA_VERSION,
  cleanupRetiredModelCaches,
  migrateToGemmaOnlyModel,
  normalizeGemmaOnlyStorage,
} from '../../src/background/model-migration.js';
import {
  DEFAULT_MODEL,
  PRIMARY_LOCAL_MODEL_ID,
  PRIMARY_LOCAL_MODEL_URL,
} from '../../src/shared/models.js';

interface MemoryStorage {
  data: Record<string, unknown>;
  get: Mock<(keys: string | string[]) => Promise<Record<string, unknown>>>;
  set: Mock<(items: Record<string, unknown>) => Promise<void>>;
  remove: Mock<(keys: string | string[]) => Promise<void>>;
}

function memoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
  const data = structuredClone(initial);
  return {
    data,
    get: vi.fn(async (keys: string | string[]) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter(key => Object.prototype.hasOwnProperty.call(data, key))
          .map(key => [key, data[key]]),
      );
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, structuredClone(items));
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
  };
}

interface MemoryCacheStorage {
  api: CacheStorage;
  entries: Map<string, Map<string, Request>>;
  failNextLitertDelete: () => void;
}

function memoryCaches(initial: Record<string, string[]> = {}): MemoryCacheStorage {
  const entries = new Map(
    Object.entries(initial).map(([name, urls]) => [
      name,
      new Map(urls.map(url => [url, { url } as Request])),
    ]),
  );
  let failLitertDelete = false;

  const api = {
    keys: vi.fn(async () => [...entries.keys()]),
    delete: vi.fn(async (name: string) => entries.delete(name)),
    open: vi.fn(async (name: string) => {
      const cacheEntries = entries.get(name) ?? new Map<string, Request>();
      entries.set(name, cacheEntries);
      return {
        keys: vi.fn(async () => [...cacheEntries.values()]),
        delete: vi.fn(async (request: Request) => {
          if (failLitertDelete) {
            failLitertDelete = false;
            return false;
          }
          return cacheEntries.delete(request.url);
        }),
      } as unknown as Cache;
    }),
  } as unknown as CacheStorage;

  return {
    api,
    entries,
    failNextLitertDelete: () => { failLitertDelete = true; },
  };
}

describe('Gemma-only model migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes fresh storage and completes both independently marked phases', async () => {
    const storage = memoryStorage();
    const cacheStorage = memoryCaches();

    await expect(migrateToGemmaOnlyModel({
      storage,
      cacheStorage: cacheStorage.api,
    })).resolves.toEqual({ storageNormalized: true, retiredCachesCleaned: true });

    expect(storage.data).toEqual({
      selectedModel: DEFAULT_MODEL,
      localModelStatuses: {},
      evaluationCache: {},
      [GEMMA_ONLY_STORAGE_SCHEMA_KEY]: GEMMA_ONLY_STORAGE_SCHEMA_VERSION,
      [GEMMA_ONLY_CACHE_CLEANUP_KEY]: GEMMA_ONLY_CACHE_CLEANUP_VERSION,
    });

    await expect(migrateToGemmaOnlyModel({
      storage,
      cacheStorage: cacheStorage.api,
    })).resolves.toEqual({ storageNormalized: false, retiredCachesCleaned: false });
    expect(storage.set).toHaveBeenCalledTimes(3);
    // Cleanup discovers retired WebLLM buckets by prefix. Fresh storage has
    // none, so it must not issue deletes for names that do not exist.
    expect(cacheStorage.api.delete).not.toHaveBeenCalled();
  });

  it('replaces Qwen, E4B, custom, pending, status, and evaluation legacy state', async () => {
    const e2bStatus = { state: 'cached', progress: 1 };
    const storage = memoryStorage({
      selectedModel: 'local:Qwen3_5-4B-q4f16_1-MLC',
      customModels: [{ name: 'custom-mlc' }],
      predefinedModelKwargs: { local: { temperature: 0.9 } },
      pendingLocalModelSelection: {
        modelId: 'gemma-4-E4B-it-web',
        modelKey: 'local:gemma-4-E4B-it-web',
        operationId: 'old-download',
      },
      localModelStatuses: {
        'Qwen3_5-4B-q4f16_1-MLC': { state: 'ready' },
        'gemma-4-E4B-it-web': { state: 'cached' },
        [PRIMARY_LOCAL_MODEL_ID]: e2bStatus,
        'custom-mlc': { state: 'error' },
      },
      evaluationCache: { stale: { shouldFilter: true } },
      unrelatedSetting: 'preserved',
    });

    await expect(normalizeGemmaOnlyStorage(storage)).resolves.toBe(true);

    expect(storage.data).toMatchObject({
      selectedModel: DEFAULT_MODEL,
      localModelStatuses: { [PRIMARY_LOCAL_MODEL_ID]: e2bStatus },
      evaluationCache: {},
      unrelatedSetting: 'preserved',
      [GEMMA_ONLY_STORAGE_SCHEMA_KEY]: GEMMA_ONLY_STORAGE_SCHEMA_VERSION,
    });
    expect(storage.data).not.toHaveProperty('pendingLocalModelSelection');
    expect(storage.data).not.toHaveProperty('customModels');
    expect(storage.data).not.toHaveProperty('predefinedModelKwargs');
  });

  it('does not rerun schema normalization after its marker is current', async () => {
    const currentStatuses = { [PRIMARY_LOCAL_MODEL_ID]: { state: 'ready' } };
    const storage = memoryStorage({
      [GEMMA_ONLY_STORAGE_SCHEMA_KEY]: GEMMA_ONLY_STORAGE_SCHEMA_VERSION,
      selectedModel: DEFAULT_MODEL,
      localModelStatuses: currentStatuses,
      evaluationCache: { current: { shouldFilter: false } },
    });

    await expect(normalizeGemmaOnlyStorage(storage)).resolves.toBe(false);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.data.localModelStatuses).toEqual(currentStatuses);
    expect(storage.data.evaluationCache).toEqual({ current: { shouldFilter: false } });
  });

  it('fails hard before cache cleanup when storage normalization is incomplete', async () => {
    const storage = memoryStorage({
      selectedModel: 'local:gemma-4-E4B-it-web',
      pendingLocalModelSelection: { modelId: 'gemma-4-E4B-it-web' },
    });
    storage.remove.mockRejectedValueOnce(new Error('storage remove failed'));
    const cacheStorage = memoryCaches({
      'webllm/model': ['https://example.test/qwen'],
    });

    await expect(migrateToGemmaOnlyModel({
      storage,
      cacheStorage: cacheStorage.api,
    })).rejects.toThrow('storage remove failed');
    expect(storage.data).not.toHaveProperty(GEMMA_ONLY_STORAGE_SCHEMA_KEY);
    expect(storage.data).not.toHaveProperty(GEMMA_ONLY_CACHE_CLEANUP_KEY);
    expect(cacheStorage.api.delete).not.toHaveBeenCalled();

    await expect(migrateToGemmaOnlyModel({
      storage,
      cacheStorage: cacheStorage.api,
    })).resolves.toEqual({ storageNormalized: true, retiredCachesCleaned: true });
    expect(storage.data).not.toHaveProperty('pendingLocalModelSelection');
  });

  it('deletes all retired engine/model entries and preserves only exact E2B', async () => {
    const storage = memoryStorage();
    const cacheStorage = memoryCaches({
      'webllm/model': ['https://example.test/qwen-weights'],
      'webllm/config': ['https://example.test/qwen-config'],
      'webllm/wasm': ['https://example.test/qwen.wasm'],
      'litertlm-cache': [
        PRIMARY_LOCAL_MODEL_URL,
        'https://example.test/gemma-4-E4B-it-web.litertlm',
        `${PRIMARY_LOCAL_MODEL_URL}?stale=1`,
      ],
      unrelated: ['https://example.test/keep'],
    });

    await expect(
      cleanupRetiredModelCaches(storage, cacheStorage.api),
    ).resolves.toBe(true);

    expect([...cacheStorage.entries.keys()].sort()).toEqual([
      'litertlm-cache',
      'unrelated',
    ]);
    expect([...cacheStorage.entries.get('litertlm-cache')!.keys()]).toEqual([
      PRIMARY_LOCAL_MODEL_URL,
    ]);
    expect(storage.data[GEMMA_ONLY_CACHE_CLEANUP_KEY]).toBe(
      GEMMA_ONLY_CACHE_CLEANUP_VERSION,
    );
  });

  it('leaves cleanup unmarked after a partial failure and succeeds on retry', async () => {
    const storage = memoryStorage();
    const retiredUrl = 'https://example.test/retired.litertlm';
    const cacheStorage = memoryCaches({
      'litertlm-cache': [PRIMARY_LOCAL_MODEL_URL, retiredUrl],
    });
    cacheStorage.failNextLitertDelete();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      migrateToGemmaOnlyModel({ storage, cacheStorage: cacheStorage.api }),
    ).resolves.toEqual({ storageNormalized: true, retiredCachesCleaned: false });
    expect(storage.data).not.toHaveProperty(GEMMA_ONLY_CACHE_CLEANUP_KEY);
    expect(storage.data[GEMMA_ONLY_STORAGE_SCHEMA_KEY]).toBe(
      GEMMA_ONLY_STORAGE_SCHEMA_VERSION,
    );
    expect(cacheStorage.entries.get('litertlm-cache')!.has(retiredUrl)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      '[Model migration] Retired cache cleanup failed; will retry',
      expect.objectContaining({
        message: 'Retired LiteRT-LM cache entries remain after cleanup: 1',
      }),
    );

    await expect(
      migrateToGemmaOnlyModel({ storage, cacheStorage: cacheStorage.api }),
    ).resolves.toEqual({ storageNormalized: false, retiredCachesCleaned: true });
    expect(cacheStorage.entries.get('litertlm-cache')!.has(retiredUrl)).toBe(false);
    expect(storage.data[GEMMA_ONLY_CACHE_CLEANUP_KEY]).toBe(
      GEMMA_ONLY_CACHE_CLEANUP_VERSION,
    );
    warn.mockRestore();
  });
});
