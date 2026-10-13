import {
  BROWSER_CLASSIFIER_FINGERPRINT,
  BROWSER_MODEL_ID,
  BROWSER_MODEL_URL,
  NATIVE_CLASSIFIER_FINGERPRINT,
  PRIMARY_LOCAL_MODEL_ID,
  isInferenceEngine,
} from '../shared/models';
import type { EngineSelection } from '../types';

export const ENGINE_CHOICE_STORAGE_SCHEMA_VERSION = 1;
export const ENGINE_CHOICE_STORAGE_SCHEMA_KEY = 'engineChoiceSchemaVersion';
export const ENGINE_CHOICE_MODEL_CACHE_CLEANUP_VERSION = 1;
export const ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY = 'engineChoiceModelCacheCleanupVersion';

// Historical native markers supply provenance only. Never run the destructive
// native cutover before this independent choice migration.
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

const LEGACY_MODEL_KEY = `local:${BROWSER_MODEL_ID}`;
const LEGACY_MODEL_ID = BROWSER_MODEL_ID;
const LEGACY_STORAGE_SCHEMA_VERSION = 1;
const MODEL_CACHE_NAME = 'litertlm-cache';
const GENERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface UntypedStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ModelMigrationDeps {
  storage: UntypedStorageArea;
  cacheStorage: CacheStorage;
  /** Close an existing legacy document; never create or initialize a host. */
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

const storageNormalizations = new WeakMap<UntypedStorageArea, Promise<boolean>>();
const migrationBarriers = new WeakMap<UntypedStorageArea, Promise<ModelMigrationResult>>();
const legacyRuntimesClosed = new WeakSet<UntypedStorageArea>();

function defaultStorage(): UntypedStorageArea {
  return chrome.storage.local as unknown as UntypedStorageArea;
}

async function closeLegacyOffscreenRuntime(): Promise<void> {
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

/** Only a complete explicit choice may carry authority over legacy markers. */
export function isValidEngineSelection(value: unknown): value is EngineSelection {
  return isRecord(value)
    && (value.engine === null || isInferenceEngine(value.engine))
    && typeof value.revision === 'number'
    && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function selectionFromProvenance(data: Record<string, unknown>): EngineSelection {
  if (Object.prototype.hasOwnProperty.call(data, 'engineSelection')) {
    return isValidEngineSelection(data.engineSelection)
      ? structuredClone(data.engineSelection) : { engine: null, revision: 0 };
  }
  if (data[NATIVE_CUTOVER_STORAGE_SCHEMA_KEY] === NATIVE_CUTOVER_STORAGE_SCHEMA_VERSION) {
    return { engine: 'ollama', revision: 0 };
  }
  if (data.selectedModel === LEGACY_MODEL_KEY
      && data.gemmaOnlySchemaVersion === LEGACY_STORAGE_SCHEMA_VERSION) {
    return { engine: 'litertlm', revision: 0 };
  }
  return { engine: null, revision: 0 };
}

function isCurrentAutomaticRow(
  value: unknown, selection: EngineSelection,
): value is Record<string, unknown> {
  if (selection.engine === null || !isRecord(value) || value.userOverride === true
      || typeof value.shouldHide !== 'boolean' || typeof value.reasoning !== 'string'
      || (value.userOverride !== undefined && value.userOverride !== false)
      || (value.malformed !== undefined && value.malformed !== false)) return false;
  const fingerprint = selection.engine === 'ollama'
    ? NATIVE_CLASSIFIER_FINGERPRINT : BROWSER_CLASSIFIER_FINGERPRINT;
  const model = selection.engine === 'ollama' ? PRIMARY_LOCAL_MODEL_ID : BROWSER_MODEL_ID;
  return value.classifierFingerprint === fingerprint
    && (value.engine === undefined || value.engine === selection.engine)
    && (value.selectionRevision === undefined || value.selectionRevision === selection.revision)
    && (value.model === undefined || value.model === model)
    && isOptionalNullableString(value.category)
    && isOptionalStringList(value.matches)
    && isOptionalNullableString(value.rawResponse)
    && (value.timestamp === undefined
      || (typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) && value.timestamp >= 0))
    && isOptionalBoolean(value.cached)
    && hasValidDetectorStates(value.detectorStates)
    && value.error === undefined && value.retry === undefined
    && (value.pending === undefined || value.pending === false)
    && (value.settled === undefined || value.settled === true);
}

function projectCompatibleCache(value: unknown, selection: EngineSelection): Record<string, unknown> {
  const manual = projectSettledManualCache(value);
  if (!isRecord(value)) return manual;
  for (const [key, row] of Object.entries(value)) {
    if (key.length > 0 && isCurrentAutomaticRow(row, selection)) {
      // The fixed classifier contract authenticates compatible older rows.
      // Add missing identity fields for this committed choice. Explicit stale
      // identities were rejected above and can never become a new-epoch result.
      manual[key] = { ...structuredClone(row), engine: selection.engine, selectionRevision: selection.revision };
    }
  }
  return manual;
}

async function writeCompletionMarker(
  storage: UntypedStorageArea,
  key: string,
  version: number,
): Promise<void> {
  try {
    await storage.set({ [key]: version });
    if ((await storage.get(key))[key] !== version) {
      throw new Error('Engine choice migration verification failed: completion marker differs');
    }
  } catch (error) {
    // Rejected writes can partially commit. Never retain an acknowledged failed
    // completion marker, including a silently lost write detected by readback.
    await storage.remove(key);
    throw error;
  }
}

const PROVENANCE_KEYS = [
  ENGINE_CHOICE_STORAGE_SCHEMA_KEY, 'engineSelection',
  NATIVE_CUTOVER_STORAGE_SCHEMA_KEY, 'selectedModel', 'gemmaOnlySchemaVersion',
];

async function normalizeChoiceStorage(
  storage: UntypedStorageArea,
  closeLegacyRuntime: () => Promise<void>,
): Promise<boolean> {
  const initial = await storage.get(PROVENANCE_KEYS);
  const completed = initial[ENGINE_CHOICE_STORAGE_SCHEMA_KEY] === ENGINE_CHOICE_STORAGE_SCHEMA_VERSION;
  if (completed && isValidEngineSelection(initial.engineSelection)) return false;

  // A completed but corrupt new selection must require an explicit choice;
  // historical native/browser markers cannot repair it into an engine choice.
  if (completed) await storage.remove(ENGINE_CHOICE_STORAGE_SCHEMA_KEY);
  if (!completed && !Object.prototype.hasOwnProperty.call(initial, 'engineSelection')
      && !legacyRuntimesClosed.has(storage)) {
    await closeLegacyRuntime();
    legacyRuntimesClosed.add(storage);
  }

  // Closing old code can release queued storage writes. Capture the latest
  // choice and decisions, and persist provenance before retiring catalog keys.
  const latest = await storage.get(PROVENANCE_KEYS);
  const selection: EngineSelection = !Object.prototype.hasOwnProperty.call(latest, 'engineSelection')
      && (completed || Object.prototype.hasOwnProperty.call(initial, 'engineSelection'))
    ? { engine: null, revision: 0 } : selectionFromProvenance(latest);
  if (!equalStorageValue(latest.engineSelection, selection)) {
    await storage.set({ engineSelection: selection });
  }
  if (!equalStorageValue((await storage.get('engineSelection')).engineSelection, selection)) {
    throw new Error('Engine choice migration verification failed: engine selection differs');
  }
  await storage.remove([...RETIRED_BROWSER_MODEL_STORAGE_KEYS]);

  // Re-read after asynchronous key removal rather than projecting an early
  // snapshot over delayed manual decisions or current classifier writes.
  const current = await storage.get(['engineSelection', 'evaluationCache']);
  if (!equalStorageValue(current.engineSelection, selection)) {
    throw new Error('Engine choice migration verification failed: engine selection differs');
  }
  const evaluationCache = projectCompatibleCache(current.evaluationCache, selection);
  if (!equalStorageValue(current.evaluationCache, evaluationCache)) {
    await storage.set({ evaluationCache });
  }
  const readback = await storage.get([
    'engineSelection', 'evaluationCache', ...RETIRED_BROWSER_MODEL_STORAGE_KEYS,
  ]);
  if (!equalStorageValue(readback.engineSelection, selection)) {
    throw new Error('Engine choice migration verification failed: engine selection differs');
  }
  if (!equalStorageValue(readback.evaluationCache, evaluationCache)) {
    throw new Error('Engine choice migration verification failed: compatible cache differs');
  }
  if (RETIRED_BROWSER_MODEL_STORAGE_KEYS.some(key =>
    Object.prototype.hasOwnProperty.call(readback, key))) {
    throw new Error('Engine choice migration verification failed: retired storage keys remain');
  }

  await writeCompletionMarker(storage, ENGINE_CHOICE_STORAGE_SCHEMA_KEY, ENGINE_CHOICE_STORAGE_SCHEMA_VERSION);
  return true;
}

/** Idempotent storage barrier. Native leases/status and browser resources are untouched. */
export function normalizeEngineChoice(
  storage: UntypedStorageArea = defaultStorage(),
  closeLegacyRuntime: () => Promise<void> = closeLegacyOffscreenRuntime,
): Promise<boolean> {
  const running = storageNormalizations.get(storage);
  if (running) return running;
  const normalization = normalizeChoiceStorage(storage, closeLegacyRuntime);
  storageNormalizations.set(storage, normalization);
  const release = (): void => { storageNormalizations.delete(storage); };
  void normalization.then(release, release);
  return normalization;
}

function isOwnedRetiredCache(name: string): boolean {
  return name.startsWith('webllm/') || name.startsWith('bouncer-model-');
}

function isSupportedBrowserCacheKey(url: string): boolean {
  if (url === BROWSER_MODEL_URL) return true;
  const prefix = `${BROWSER_MODEL_URL}?bouncer-generation=`;
  return url.startsWith(prefix) && GENERATION_UUID.test(url.slice(prefix.length));
}

function isUnsupportedOwnedBrowserEntry(url: string): boolean {
  if (isSupportedBrowserCacheKey(url)) return false;
  if (url.startsWith(BROWSER_MODEL_URL)) return true;
  try {
    // LiteRT owns model artifacts in this bucket, not unrelated cached assets.
    return new URL(url).pathname.endsWith('.litertlm');
  } catch {
    return false;
  }
}

/** Keep pinned browser bytes; remove unsupported model entries and old runtime buckets. */
export async function cleanupRetiredModelCaches(
  storage: UntypedStorageArea = defaultStorage(),
  cacheStorage: CacheStorage = globalThis.caches,
): Promise<boolean> {
  const data = await storage.get(ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY);
  if (data[ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY] === ENGINE_CHOICE_MODEL_CACHE_CLEANUP_VERSION) {
    return false;
  }
  const names = await cacheStorage.keys();
  for (const name of names.filter(isOwnedRetiredCache)) await cacheStorage.delete(name);
  if (names.includes(MODEL_CACHE_NAME)) {
    const cache = await cacheStorage.open(MODEL_CACHE_NAME);
    for (const request of await cache.keys()) {
      if (isUnsupportedOwnedBrowserEntry(request.url)) await cache.delete(request);
    }
    if ((await cache.keys()).some(request => isUnsupportedOwnedBrowserEntry(request.url))) {
      throw new Error('Unsupported browser model cache entries remain after cleanup');
    }
  }
  if ((await cacheStorage.keys()).some(isOwnedRetiredCache)) {
    throw new Error('Retired browser model caches remain after cleanup');
  }
  await writeCompletionMarker(storage, ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY, ENGINE_CHOICE_MODEL_CACHE_CLEANUP_VERSION);
  return true;
}

/** Await before serving settings/cache readers; cache cleanup retries independently. */
export function migrateEngineChoice(overrides: Partial<ModelMigrationDeps> = {}): Promise<ModelMigrationResult> {
  const storage = overrides.storage ?? defaultStorage();
  const running = migrationBarriers.get(storage);
  if (running) return running;
  const migration = (async (): Promise<ModelMigrationResult> => {
    const storageNormalized = await normalizeEngineChoice(storage, overrides.closeLegacyRuntime ?? closeLegacyOffscreenRuntime);
    let retiredCachesCleaned = false;
    try {
      retiredCachesCleaned = await cleanupRetiredModelCaches(storage, overrides.cacheStorage ?? globalThis.caches);
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

// Compatibility names no longer perform the destructive native-only cutover.
export const normalizeNativeStorage = normalizeEngineChoice;
export const migrateToNativeModel = migrateEngineChoice;

/** Preserve meaningful selection/status events and simultaneous settings edits. */
export function stripNativeCutoverStorageChanges(
  changes: Record<string, StorageChange>,
): Record<string, StorageChange> {
  return Object.fromEntries(Object.entries(changes).filter(([key, change]) => {
    if (key === ENGINE_CHOICE_STORAGE_SCHEMA_KEY || key === ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY
        || key === NATIVE_CUTOVER_STORAGE_SCHEMA_KEY || key === NATIVE_MODEL_CACHE_CLEANUP_KEY) return false;
    return !RETIRED_BROWSER_MODEL_STORAGE_KEYS.some(retired => retired === key)
      || change.newValue !== undefined;
  }));
}

/**
 * Historical, pure operator rollback projection for the retired browser-only build.
 * Only CURRENT cache/settings are used; an older snapshot supplies the validated old backend markers, never user data.
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
  delete projection[ENGINE_CHOICE_STORAGE_SCHEMA_KEY];
  delete projection[ENGINE_CHOICE_MODEL_CACHE_CLEANUP_KEY];
  delete projection.engineSelection;
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
