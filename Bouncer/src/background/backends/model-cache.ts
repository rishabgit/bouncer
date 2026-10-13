import { sha256 } from '@noble/hashes/sha2.js';
import { BROWSER_MODEL_URL, BROWSER_MODEL_BYTES, BROWSER_MODEL_SHA256 } from '../../shared/models';
import type { BrowserProgress } from './types';

export const MODEL_CACHE_NAME = 'litertlm-cache';
export type CacheGeneration = string;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isCacheGeneration(value: unknown): value is CacheGeneration {
  return value === 'legacy' || (typeof value === 'string' && UUID.test(value));
}
export function modelCacheKey(generation: CacheGeneration): string {
  if (!isCacheGeneration(generation)) throw new Error('Invalid browser cache generation');
  return generation === 'legacy' ? BROWSER_MODEL_URL : `${BROWSER_MODEL_URL}?bouncer-generation=${generation}`;
}
export function isOwnedModelCacheKey(url: string): boolean {
  if (url === BROWSER_MODEL_URL) return true;
  const prefix = `${BROWSER_MODEL_URL}?bouncer-generation=`;
  return url.startsWith(prefix) && UUID.test(url.slice(prefix.length));
}
function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Browser operation cancelled');
}

/** Tiny fixtures can exercise this primitive; production routes supply only the fixed contract. */
export interface IntegrityContract { sizeBytes: number; sha256: string }
const FIXED_CONTRACT: IntegrityContract = { sizeBytes: BROWSER_MODEL_BYTES, sha256: BROWSER_MODEL_SHA256 };

/** One pull equals one upstream chunk: Cache.put provides all downstream pressure. */
export function integrityStream(
  source: ReadableStream<Uint8Array>, contract: IntegrityContract,
  signal: AbortSignal, onProgress: (progress: BrowserProgress) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const hash = sha256.create();
  const report = (progress: BrowserProgress): void => { try { onProgress(progress); } catch { /* progress cannot break the integrity stream */ } };
  let receivedBytes = 0;
  let settled = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = (): void => { settled = true; signal.removeEventListener('abort', abort); hash.destroy(); };
  const abort = (): void => {
    if (settled) return;
    cleanup();
    output.error(new Error('Browser operation cancelled'));
    void reader.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      if (settled) return;
      try {
        assertNotAborted(signal);
        const { done, value } = await reader.read();
        assertNotAborted(signal);
        if (done) {
          const digest = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
          if (receivedBytes !== contract.sizeBytes || digest !== contract.sha256) {
            throw new Error('Browser model integrity verification failed');
          }
          cleanup();
          report({ progress: 1, text: '', receivedBytes, totalBytes: contract.sizeBytes });
          controller.close();
          return;
        }
        receivedBytes += value.byteLength;
        if (receivedBytes > contract.sizeBytes) throw new Error('Browser model integrity verification failed');
        hash.update(value);
        report({ progress: Math.min(receivedBytes / contract.sizeBytes, 0.999999), text: '', receivedBytes, totalBytes: contract.sizeBytes });
        controller.enqueue(value);
      } catch (error) {
        if (!settled) { cleanup(); controller.error(error); }
        void reader.cancel().catch(() => undefined);
      }
    },
    async cancel() { if (!settled) cleanup(); await reader.cancel(); },
  }, { highWaterMark: 0 });
}

export async function cachedModelExists(generation: CacheGeneration): Promise<boolean> {
  const cache = await caches.open(MODEL_CACHE_NAME);
  return !!await cache.match(modelCacheKey(generation));
}

/** Cache fixture primitive; production always supplies the immutable artifact contract. */
export async function verifySavedEntry(cache: Cache, key: string, contract: IntegrityContract, signal: AbortSignal): Promise<Response> {
  assertNotAborted(signal);
  const saved = await cache.match(key);
  if (!saved?.body) throw new Error('Browser model is not downloaded. Download it in setup.');
  const reader = integrityStream(saved.body, contract, signal, () => undefined).getReader();
  try { while (!(await reader.read()).done) { /* discard bounded verification chunks */ } }
  catch (error) {
    if (!signal.aborted) await cache.delete(key);
    throw error;
  }
  assertNotAborted(signal);
  const verified = await cache.match(key);
  if (!verified?.body) throw new Error('Browser model cache was removed. Download it in setup.');
  return verified;
}

/** Verify saved legacy bytes lazily before loading wasm or a GPU engine. Never fetches. */
export async function readVerifiedCachedModel(generation: CacheGeneration, signal: AbortSignal): Promise<Response> {
  const cache = await caches.open(MODEL_CACHE_NAME);
  return verifySavedEntry(cache, modelCacheKey(generation), FIXED_CONTRACT, signal);
}

/** A single stream feeds Cache.put and checks integrity before the cache can commit. */
export async function writeVerifiedCacheEntry(cache: Cache, key: string, upstream: Response, contract: IntegrityContract, signal: AbortSignal, onProgress: (p: BrowserProgress) => void): Promise<void> {
  if (!upstream.body) throw new Error('Browser model download failed');
  try {
    const body = integrityStream(upstream.body, contract, signal, onProgress);
    await cache.put(key, new Response(body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(contract.sizeBytes) } }));
    assertNotAborted(signal);
    if (!await cache.match(key)) throw new Error('Browser model could not be saved');
  } catch (error) {
    await cache.delete(key);
    throw error;
  }
}

/** Explicit cache-only transfer: no wasm, GPU engine, or resident model. */
export async function prefetchFixedModel(generation: CacheGeneration, onProgress: (p: BrowserProgress) => void, signal: AbortSignal): Promise<void> {
  if (!isCacheGeneration(generation) || generation === 'legacy') throw new Error('Invalid download generation');
  assertNotAborted(signal);
  const cache = await caches.open(MODEL_CACHE_NAME);
  const key = modelCacheKey(generation);
  let upstream: Response;
  try { upstream = await fetch(BROWSER_MODEL_URL, { signal, credentials: 'omit' }); }
  catch { throw new Error(signal.aborted ? 'Browser operation cancelled' : 'Browser model download failed'); }
  if (!upstream.ok || !upstream.body) throw new Error('Browser model download failed');
  const claimedSize = upstream.headers.get('content-length');
  if (claimedSize !== null && Number(claimedSize) !== BROWSER_MODEL_BYTES) {
    await upstream.body.cancel();
    throw new Error('Browser model integrity verification failed');
  }
  try {
    await writeVerifiedCacheEntry(cache, key, upstream, FIXED_CONTRACT, signal, onProgress);
  } catch (error) {
    await cache.delete(key);
    if (signal.aborted) throw new Error('Browser operation cancelled', { cause: error });
    if (error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError') throw error;
    if (error instanceof Error && error.message === 'Browser model integrity verification failed') throw error;
    throw new Error('Browser model download failed', { cause: error });
  }
}

let storageTail: Promise<unknown> = Promise.resolve();
function serializedStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageTail.catch(() => undefined).then(operation);
  storageTail = result.catch(() => undefined);
  return result;
}
export async function currentCacheGeneration(): Promise<CacheGeneration> {
  const values = await chrome.storage.local.get('browserCacheGeneration');
  const value: unknown = values.browserCacheGeneration;
  if (value === undefined || value === '') return 'legacy';
  if (!isCacheGeneration(value) || value === 'legacy') throw new Error('Invalid saved browser cache state');
  return value;
}
export function beginCacheGeneration(): Promise<CacheGeneration> {
  return serializedStorage(async () => {
    const generation = crypto.randomUUID();
    await chrome.storage.local.set({ browserCacheGeneration: generation });
    return generation;
  });
}
export function retireCacheGeneration(expected?: CacheGeneration): Promise<void> {
  return serializedStorage(async () => {
    if (expected && await currentCacheGeneration() !== expected) return;
    await chrome.storage.local.set({ browserCacheGeneration: crypto.randomUUID() });
  });
}
export function pruneStaleModelCaches(): Promise<void> {
  return serializedStorage(async () => {
    const generation = await currentCacheGeneration();
    const current = modelCacheKey(generation);
    const cache = await caches.open(MODEL_CACHE_NAME);
    for (const request of await cache.keys()) {
      if (request.url !== current && isOwnedModelCacheKey(request.url)) await cache.delete(request);
    }
  });
}
export function removeModelCaches(): Promise<void> {
  return serializedStorage(async () => {
    // Retirement and deletion hold the same storage-generation lock. A newer
    // download cannot publish its key while this cleanup selects stale keys.
    await chrome.storage.local.set({ browserCacheGeneration: crypto.randomUUID() });
    const cache = await caches.open(MODEL_CACHE_NAME);
    for (const request of await cache.keys()) {
      if (isOwnedModelCacheKey(request.url)) {
        await cache.delete(request);
        if (await cache.match(request)) throw new Error('Browser model cache survived deletion');
      }
    }
  });
}
