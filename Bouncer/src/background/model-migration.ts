// The native cutover is independent of model definitions: the browser model
// catalog and its cache-wiping normalizer are retired with the old runtime.
export const NATIVE_CUTOVER_STORAGE_SCHEMA_VERSION = 1;
export const NATIVE_MODEL_CACHE_CLEANUP_VERSION = 1;

export const NATIVE_CUTOVER_STORAGE_SCHEMA_KEY = 'nativeCutoverSchemaVersion';
export const NATIVE_MODEL_CACHE_CLEANUP_KEY = 'nativeModelCacheCleanupVersion';

export const RETIRED_BROWSER_MODEL_STORAGE_KEYS = [
  'selectedModel',
  'localModelStatuses',
  'pendingLocalModelSelection',
  'customModels',
  'predefinedModelKwargs',
  'gemmaOnlySchemaVersion',
  'retiredModelCacheCleanupVersion',
] as const;

const LEGACY_MODEL_KEY = 'local:gemma-4-E2B-it-web';
const LEGACY_MODEL_ID = 'gemma-4-E2B-it-web';
const LEGACY_STORAGE_SCHEMA_VERSION = 1;

export interface UntypedStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ModelMigrationDeps {
  storage: UntypedStorageArea;
  cacheStorage: CacheStorage;
  /** Close the retired extension-owned offscreen document before state writes. */
  closeLegacyRuntime: () => Promise<void>;
}

export interface ModelMigrationResult {
  storageNormalized: boolean;
  retiredCachesCleaned: boolean;
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

const storageCutovers = new WeakMap<UntypedStorageArea, Promise<boolean>>();
const migrationBarriers = new WeakMap<UntypedStorageArea, Promise<ModelMigrationResult>>();

function defaultStorage(): UntypedStorageArea {
  // The migration must read and remove keys retired from StorageSchema.
  return chrome.storage.local as unknown as UntypedStorageArea;
}

async function closeLegacyOffscreenRuntime(): Promise<void> {
  // An extension update can leave the old document alive. Do not load the old
  // runtime just to close it, or create a new offscreen document during cutover.
  if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalStringList(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function isOptionalNullableString(value: unknown): boolean {
  return value === null || isOptionalString(value);
}

function hasValidDetectorStates(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !Array.isArray(value.names)
      || !value.names.every(name => typeof name === 'string')
      || !isRecord(value.map)) return false;

  return Object.values(value.map).every(snapshot => isRecord(snapshot)
    && ['success', 'error', 'skipped'].includes(String(snapshot.status))
    && isOptionalBoolean(snapshot.shouldHide)
    && isOptionalString(snapshot.reasoning)
    && isOptionalNullableString(snapshot.category)
    && isOptionalStringList(snapshot.matches)
    && isOptionalString(snapshot.error)
    && isOptionalString(snapshot.skipReason));
}

/** Validate durable manual verdicts without adding a separate override store. */
function isSettledManualRow(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.userOverride !== true
      || typeof value.shouldHide !== 'boolean' || typeof value.reasoning !== 'string') {
    return false;
  }

  return isOptionalNullableString(value.category)
    && isOptionalStringList(value.matches)
    && isOptionalNullableString(value.rawResponse)
    && (value.timestamp === undefined
      || (typeof value.timestamp === 'number'
        && Number.isFinite(value.timestamp) && value.timestamp >= 0))
    && isOptionalString(value.model)
    && isOptionalBoolean(value.cached)
    && hasValidDetectorStates(value.detectorStates)
    && value.error === undefined && value.retry === undefined
    && (value.pending === undefined || value.pending === false)
    && (value.settled === undefined || value.settled === true);
}

/** Retain all settled hide AND restore decisions, without the panel's 500 cap. */
export function projectSettledManualCache(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, row]) => key.length > 0 && isSettledManualRow(row))
    .map(([key, row]) => [key, structuredClone(row)]));
}

function equalStorageValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((item, index) => equalStorageValue(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
      && equalStorageValue(left[key], right[key]));
}

async function writeCompletionMarker(
  storage: UntypedStorageArea,
  key: string,
  version: number,
): Promise<void> {
  try {
    await storage.set({ [key]: version });
  } catch (error) {
    // A rejected write may have partially committed. Do not leave a successful
    // marker after an acknowledged failure; the next wake must retry.
    await storage.remove(key);
    throw error;
  }
}

async function cutOverStorage(
  storage: UntypedStorageArea,
  closeLegacyRuntime: () => Promise<void>,
): Promise<boolean> {
  const data = await storage.get([
    NATIVE_CUTOVER_STORAGE_SCHEMA_KEY,
    'evaluationCache',
  ]);
  if (data[NATIVE_CUTOVER_STORAGE_SCHEMA_KEY] === NATIVE_CUTOVER_STORAGE_SCHEMA_VERSION) {
    return false;
  }

  await closeLegacyRuntime();
  const evaluationCache = projectSettledManualCache(data.evaluationCache);
  await storage.set({ evaluationCache });
  await storage.remove([...RETIRED_BROWSER_MODEL_STORAGE_KEYS]);

  const readback = await storage.get([
    'evaluationCache',
    ...RETIRED_BROWSER_MODEL_STORAGE_KEYS,
  ]);
  if (!equalStorageValue(readback.evaluationCache, evaluationCache)) {
    throw new Error('Native cutover verification failed: manual cache differs');
  }
  if (RETIRED_BROWSER_MODEL_STORAGE_KEYS.some(key =>
    Object.prototype.hasOwnProperty.call(readback, key))) {
    throw new Error('Native cutover verification failed: retired storage keys remain');
  }

  // This is the final storage mutation: readers may proceed only after it
  // resolves. A failed transformation/verification never publishes success.
  await writeCompletionMarker(
    storage, NATIVE_CUTOVER_STORAGE_SCHEMA_KEY, NATIVE_CUTOVER_STORAGE_SCHEMA_VERSION,
  );
  return true;
}

/** Idempotent asynchronous storage barrier; concurrent callers share one run. */
export function normalizeNativeStorage(
  storage: UntypedStorageArea = defaultStorage(),
  closeLegacyRuntime: () => Promise<void> = closeLegacyOffscreenRuntime,
): Promise<boolean> {
  const running = storageCutovers.get(storage);
  if (running) return running;

  const cutover = cutOverStorage(storage, closeLegacyRuntime);
  storageCutovers.set(storage, cutover);
  const release = (): void => { storageCutovers.delete(storage); };
  void cutover.then(release, release);
  return cutover;
}

function isOwnedRetiredCache(name: string): boolean {
  return name === 'litertlm-cache'
    || name.startsWith('webllm/')
    || name.startsWith('bouncer-model-');
}

/** Delete only the retired extension-origin model buckets, including all LiteRT bytes. */
export async function cleanupRetiredModelCaches(
  storage: UntypedStorageArea = defaultStorage(),
  cacheStorage: CacheStorage = globalThis.caches,
): Promise<boolean> {
  const data = await storage.get(NATIVE_MODEL_CACHE_CLEANUP_KEY);
  if (data[NATIVE_MODEL_CACHE_CLEANUP_KEY] === NATIVE_MODEL_CACHE_CLEANUP_VERSION) {
    return false;
  }

  for (const name of (await cacheStorage.keys()).filter(isOwnedRetiredCache)) {
    await cacheStorage.delete(name);
  }
  if ((await cacheStorage.keys()).some(isOwnedRetiredCache)) {
    throw new Error('Retired browser model caches remain after cleanup');
  }

  await writeCompletionMarker(
    storage, NATIVE_MODEL_CACHE_CLEANUP_KEY, NATIVE_MODEL_CACHE_CLEANUP_VERSION,
  );
  return true;
}

/**
 * Await before reading cache/settings or serving message/install handlers.
 * Cache failures are nonfatal and separately retried on a later worker wake.
 */
export function migrateToNativeModel(
  overrides: Partial<ModelMigrationDeps> = {},
): Promise<ModelMigrationResult> {
  const storage = overrides.storage ?? defaultStorage();
  const running = migrationBarriers.get(storage);
  if (running) return running;

  const migration = (async (): Promise<ModelMigrationResult> => {
    const storageNormalized = await normalizeNativeStorage(
      storage, overrides.closeLegacyRuntime ?? closeLegacyOffscreenRuntime,
    );
    let retiredCachesCleaned = false;
    try {
      retiredCachesCleaned = await cleanupRetiredModelCaches(
        storage, overrides.cacheStorage ?? globalThis.caches,
      );
    } catch (error) {
      console.warn('[Model migration] Retired cache cleanup failed; will retry', error);
    }
    return { storageNormalized, retiredCachesCleaned };
  })();
  migrationBarriers.set(storage, migration);
  const release = (): void => { migrationBarriers.delete(storage); };
  void migration.then(release, release);
  return migration;
}

/**
 * Storage events arrive separately for cache, key removal and the last marker.
 * Strip only cutover housekeeping; simultaneous genuine settings edits remain.
 */
export function stripNativeCutoverStorageChanges(
  changes: Record<string, StorageChange>,
): Record<string, StorageChange> {
  return Object.fromEntries(Object.entries(changes).filter(([key, change]) => {
    if (key === NATIVE_CUTOVER_STORAGE_SCHEMA_KEY
        || key === NATIVE_MODEL_CACHE_CLEANUP_KEY) return false;
    return !RETIRED_BROWSER_MODEL_STORAGE_KEYS.some(retired => retired === key)
      || change.newValue !== undefined;
  }));
}

/**
 * Pure operator rollback projection. Only the CURRENT cache/settings are used;
 * an older snapshot supplies the validated old backend markers, never user data.
 * Any native fence, including malformed state, requires qualified settlement
 * before rollback: the old browser runtime cannot enforce the native fence.
 * This helper never erases a fence. Exact old weights must be restored separately.
 */
export function projectNativeStorageForBrowserRollback(
  current: Record<string, unknown>,
  oldBackendSnapshot: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(current, 'nativeOperationFence')) {
    throw new Error('Rollback requires qualified native-operation settlement before restoring browser execution');
  }
  if (oldBackendSnapshot.selectedModel !== LEGACY_MODEL_KEY
      || oldBackendSnapshot.gemmaOnlySchemaVersion !== LEGACY_STORAGE_SCHEMA_VERSION) {
    throw new Error('Rollback requires the verified Gemma E2B browser schema markers');
  }

  const projection = structuredClone(current);
  for (const key of RETIRED_BROWSER_MODEL_STORAGE_KEYS) delete projection[key];
  delete projection[NATIVE_CUTOVER_STORAGE_SCHEMA_KEY];
  delete projection[NATIVE_MODEL_CACHE_CLEANUP_KEY];
  delete projection.nativeModelStatus;
  projection.evaluationCache = projectSettledManualCache(current.evaluationCache);
  projection.selectedModel = LEGACY_MODEL_KEY;
  projection.gemmaOnlySchemaVersion = LEGACY_STORAGE_SCHEMA_VERSION;
  const oldStatuses = oldBackendSnapshot.localModelStatuses;
  const oldStatus = isRecord(oldStatuses) ? oldStatuses[LEGACY_MODEL_ID] : undefined;
  projection.localModelStatuses = isRecord(oldStatus)
    ? { [LEGACY_MODEL_ID]: structuredClone(oldStatus) } : {};
  if (oldBackendSnapshot.retiredModelCacheCleanupVersion === 1) {
    projection.retiredModelCacheCleanupVersion = 1;
  }
  return projection;
}
