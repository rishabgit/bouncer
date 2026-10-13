import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  integrityStream, modelCacheKey, isOwnedModelCacheKey, currentCacheGeneration,
  beginCacheGeneration, retireCacheGeneration, pruneStaleModelCaches, readVerifiedCachedModel, writeVerifiedCacheEntry, verifySavedEntry,
} from '../../src/background/backends/model-cache';
import { BROWSER_MODEL_URL } from '../../src/shared/models';
const GENERATION = 'ab9b47f8-60a1-4422-9bb4-5e09e37379d4';
const OTHER = 'dacfe4bc-c617-4d8a-a3fb-c4fdbb2fe0f9';
const bytes = new Uint8Array([1, 2, 3, 4, 5]);
const contract = { sizeBytes: 5, sha256: createHash('sha256').update(bytes).digest('hex') };
afterEach(() => vi.unstubAllGlobals());
async function drain(stream: ReadableStream<Uint8Array>) { const reader = stream.getReader(); while (!(await reader.read()).done) { /* drain bounded chunks */ } }
describe('browser model integrity and cache ownership', () => {
  it('increments SHA/progress only as downstream pulls, with no tee branch', async () => {
    let index = 0;
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index)); else controller.close();
    });
    const source = new ReadableStream({ pull }, { highWaterMark: 0 });
    const progress = vi.fn();
    const output = integrityStream(source, contract, new AbortController().signal, progress);
    await Promise.resolve();
    expect(pull).not.toHaveBeenCalled();
    const reader = output.getReader();
    await reader.read();
    expect(pull).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(pull).toHaveBeenCalledOnce();
    while (!(await reader.read()).done) { /* consume */ }
    expect(progress).toHaveBeenLastCalledWith({ progress: 1, text: '', receivedBytes: 5, totalBytes: 5 });
  });
  it.each([
    { sizeBytes: 4, sha256: contract.sha256 }, { sizeBytes: 6, sha256: contract.sha256 },
    { sizeBytes: 5, sha256: '0'.repeat(64) },
  ])('rejects a wrong exact size or digest at stream EOF/overflow', async invalid => {
    await expect(drain(integrityStream(new Response(bytes).body!, invalid, new AbortController().signal, vi.fn()))).rejects.toThrow('integrity verification failed');
  });
  it('cancels a pending upstream read without leaving an independent consumer', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel }, { highWaterMark: 0 });
    const controller = new AbortController();
    const read = integrityStream(source, contract, controller.signal, vi.fn()).getReader().read();
    const rejection = expect(read).rejects.toThrow('cancelled');
    controller.abort();
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('commits only a complete correctly hashed cache stream', async () => {
    let saved: Response | undefined;
    const cache = {
      put: vi.fn(async (_key: string, response: Response) => { const body = await response.arrayBuffer(); saved = new Response(body); }),
      match: vi.fn(async () => saved?.clone()), delete: vi.fn(async () => { saved = undefined; return true; }),
    } as unknown as Cache;
    const signal = new AbortController().signal;
    await writeVerifiedCacheEntry(cache, modelCacheKey(GENERATION), new Response(bytes), contract, signal, vi.fn());
    expect(await verifySavedEntry(cache, modelCacheKey(GENERATION), contract, signal)).toBeInstanceOf(Response);
    await expect(writeVerifiedCacheEntry(cache, modelCacheKey(OTHER), new Response(bytes), { ...contract, sha256: '0'.repeat(64) }, signal, vi.fn())).rejects.toThrow('integrity verification failed');
    expect(saved).toBeUndefined();
  });
  it('cancellation while verifying saved bytes retains a valid complete cache', async () => {
    const remove = vi.fn();
    const controller = new AbortController();
    const cache = { match: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes); controller.abort(); stream.close(); } })), delete: remove } as unknown as Cache;
    await expect(verifySavedEntry(cache, modelCacheKey(GENERATION), contract, controller.signal)).rejects.toThrow('cancelled');
    expect(remove).not.toHaveBeenCalled();
  });
  it('accepts only the exact legacy URL and strict local generation keys', () => {
    expect(modelCacheKey('legacy')).toBe(BROWSER_MODEL_URL);
    expect(modelCacheKey(GENERATION)).toBe(`${BROWSER_MODEL_URL}?bouncer-generation=${GENERATION}`);
    expect(isOwnedModelCacheKey(modelCacheKey(GENERATION))).toBe(true);
    expect(isOwnedModelCacheKey(`${modelCacheKey(GENERATION)}&other=1`)).toBe(false);
    expect(isOwnedModelCacheKey(`${BROWSER_MODEL_URL}?bouncer-generation=arbitrary`)).toBe(false);
    expect(() => modelCacheKey('https://example.test')).toThrow('Invalid browser cache generation');
  });
  it('retiring an old cancelled writer never retires the new generation', async () => {
    let value: string | undefined;
    chrome.storage.local.get = vi.fn(async () => ({ browserCacheGeneration: value })) as typeof chrome.storage.local.get;
    chrome.storage.local.set = vi.fn(async (values: Record<string, string>) => { value = values.browserCacheGeneration; });
    expect(await currentCacheGeneration()).toBe('legacy');
    const old = await beginCacheGeneration();
    const current = await beginCacheGeneration();
    await retireCacheGeneration(old);
    expect(await currentCacheGeneration()).toBe(current);
  });
  it('prunes only stale owned blobs and preserves unrelated cache entries', async () => {
    chrome.storage.local.get = vi.fn(async () => ({ browserCacheGeneration: GENERATION })) as typeof chrome.storage.local.get;
    const keys = [modelCacheKey(GENERATION), modelCacheKey(OTHER), BROWSER_MODEL_URL, 'https://example.test/unrelated'];
    const removed: string[] = [];
    vi.stubGlobal('caches', { open: async () => ({ keys: async () => keys.map(url => new Request(url)), delete: async (request: Request) => { removed.push(request.url); return true; } }) });
    await pruneStaleModelCaches();
    expect(removed).toEqual([modelCacheKey(OTHER), BROWSER_MODEL_URL]);
  });
  it('never refills an evicted cache on actual initialize', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined }) });
    await expect(readVerifiedCachedModel('legacy', new AbortController().signal)).rejects.toThrow('not downloaded');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('verifies legacy saved bytes and rejects an invalid artifact without network', async () => {
    const fetch = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('caches', { open: async () => ({ match: async () => new Response(bytes), delete: remove }) });
    await expect(readVerifiedCachedModel('legacy', new AbortController().signal)).rejects.toThrow('integrity verification failed');
    expect(remove).toHaveBeenCalledWith(BROWSER_MODEL_URL);
    expect(fetch).not.toHaveBeenCalled();
  });
});
