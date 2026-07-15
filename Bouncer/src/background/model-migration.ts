import {
  DEFAULT_MODEL,
  PRIMARY_LOCAL_MODEL_ID,
  PRIMARY_LOCAL_MODEL_URL,
} from '../shared/models';

// Bump the schema version when the canonical model ID or normalized fields
// change; bump cleanup when the canonical URL or retired cache set changes.
export const GEMMA_ONLY_STORAGE_SCHEMA_VERSION = 1;
export const GEMMA_ONLY_CACHE_CLEANUP_VERSION = 1;

export const GEMMA_ONLY_STORAGE_SCHEMA_KEY = 'gemmaOnlySchemaVersion';
export const GEMMA_ONLY_CACHE_CLEANUP_KEY = 'retiredModelCacheCleanupVersion';

const RETIRED_WEBLLM_CACHE_PREFIX = 'webllm/';
const LITERTLM_CACHE_NAME = 'litertlm-cache';

interface UntypedStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ModelMigrationDeps {
  storage: UntypedStorageArea;
  cacheStorage: CacheStorage;
}

export interface ModelMigrationResult {
  storageNormalized: boolean;
  retiredCachesCleaned: boolean;
}

function defaultDeps(): ModelMigrationDeps {
  return {
    // Deliberately bypass StorageSchema here: this migration must read and
    // remove keys whose types or definitions may already have been retired.
    storage: chrome.storage.local as unknown as UntypedStorageArea,
    cacheStorage: globalThis.caches,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retainPrimaryStatus(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};

  const status = value[PRIMARY_LOCAL_MODEL_ID];
  return isRecord(status) ? { [PRIMARY_LOCAL_MODEL_ID]: status } : {};
}

/**
 * Normalize legacy model-related storage before any runtime settings are read.
 * The marker is deliberately written last so a partial failure is retried.
 */
export async function normalizeGemmaOnlyStorage(
  storage: UntypedStorageArea = defaultDeps().storage,
): Promise<boolean> {
  const data = await storage.get([
    GEMMA_ONLY_STORAGE_SCHEMA_KEY,
    'localModelStatuses',
  ]);
  if (data[GEMMA_ONLY_STORAGE_SCHEMA_KEY] === GEMMA_ONLY_STORAGE_SCHEMA_VERSION) {
    return false;
  }

  await storage.set({
    selectedModel: DEFAULT_MODEL,
    localModelStatuses: retainPrimaryStatus(data.localModelStatuses),
    evaluationCache: {},
  });
  await storage.remove([
    'pendingLocalModelSelection',
    'customModels',
    'predefinedModelKwargs',
  ]);
  await storage.set({
    [GEMMA_ONLY_STORAGE_SCHEMA_KEY]: GEMMA_ONLY_STORAGE_SCHEMA_VERSION,
  });
  return true;
}

async function assertRetiredWebllmCachesAbsent(cacheStorage: CacheStorage): Promise<void> {
  const survivor = (await cacheStorage.keys()).find(
    name => name.startsWith(RETIRED_WEBLLM_CACHE_PREFIX),
  );
  if (survivor) {
    throw new Error(`Retired WebLLM cache still exists after cleanup: ${survivor}`);
  }
}

async function removeRetiredLitertRequests(cacheStorage: CacheStorage): Promise<void> {
  const cacheNames = await cacheStorage.keys();
  if (!cacheNames.includes(LITERTLM_CACHE_NAME)) return;

  const cache = await cacheStorage.open(LITERTLM_CACHE_NAME);
  const requests = await cache.keys();
  for (const request of requests) {
    if (request.url !== PRIMARY_LOCAL_MODEL_URL) {
      await cache.delete(request);
    }
  }

  const survivors = (await cache.keys()).filter(
    request => request.url !== PRIMARY_LOCAL_MODEL_URL,
  );
  if (survivors.length > 0) {
    throw new Error(`Retired LiteRT-LM cache entries remain after cleanup: ${survivors.length}`);
  }
}

/**
 * Delete retired engine/model caches, preserving only the exact current E2B
 * request. The cleanup marker is written only after deletion is verified.
 */
export async function cleanupRetiredModelCaches(
  storage: UntypedStorageArea = defaultDeps().storage,
  cacheStorage: CacheStorage = defaultDeps().cacheStorage,
): Promise<boolean> {
  const data = await storage.get(GEMMA_ONLY_CACHE_CLEANUP_KEY);
  if (data[GEMMA_ONLY_CACHE_CLEANUP_KEY] === GEMMA_ONLY_CACHE_CLEANUP_VERSION) {
    return false;
  }

  const retiredWebllmCaches = (await cacheStorage.keys()).filter(
    name => name.startsWith(RETIRED_WEBLLM_CACHE_PREFIX),
  );
  for (const cacheName of retiredWebllmCaches) {
    await cacheStorage.delete(cacheName);
  }
  await assertRetiredWebllmCachesAbsent(cacheStorage);
  await removeRetiredLitertRequests(cacheStorage);

  await storage.set({
    [GEMMA_ONLY_CACHE_CLEANUP_KEY]: GEMMA_ONLY_CACHE_CLEANUP_VERSION,
  });
  return true;
}

/** Run the independently marked storage and cache phases in order. */
export async function migrateToGemmaOnlyModel(
  overrides: Partial<ModelMigrationDeps> = {},
): Promise<ModelMigrationResult> {
  const defaults = defaultDeps();
  const deps: ModelMigrationDeps = {
    storage: overrides.storage ?? defaults.storage,
    cacheStorage: overrides.cacheStorage ?? defaults.cacheStorage,
  };

  const storageNormalized = await normalizeGemmaOnlyStorage(deps.storage);
  let retiredCachesCleaned = false;
  try {
    retiredCachesCleaned = await cleanupRetiredModelCaches(
      deps.storage,
      deps.cacheStorage,
    );
  } catch (error) {
    // Stale model bytes do not affect inference once storage points at E2B.
    // Keep startup usable and leave the cleanup marker absent for next wake.
    console.warn('[Model migration] Retired cache cleanup failed; will retry', error);
  }
  return { storageNormalized, retiredCachesCleaned };
}
