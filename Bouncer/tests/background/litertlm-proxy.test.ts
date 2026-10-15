import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserProgress } from '../../src/background/backends/types';
import { BROWSER_MODEL_URL } from '../../src/shared/models';
const HOST_A = 'ab9b47f8-60a1-4422-9bb4-5e09e37379d4';
const HOST_B = 'dacfe4bc-c617-4d8a-a3fb-c4fdbb2fe0f9';
let exists: boolean;
let host: string;
let saved: Record<string, unknown>;
let entries: Set<string>;
let listener: (message: unknown, sender: chrome.runtime.MessageSender) => boolean;
let send: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules(); exists = false; host = HOST_A; saved = {}; entries = new Set();
  create = vi.fn(async () => { exists = true; }); close = vi.fn(async () => { exists = false; });
  send = vi.fn(async (message: { method: string }) => ({ ok: true, value: message.method === 'state' ? { hostId: host, loaded: false, initializing: false, downloading: false } : 'yes' }));
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: send, onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } },
    offscreen: { Reason: { WORKERS: 'WORKERS' }, hasDocument: vi.fn(async () => exists), createDocument: create, closeDocument: close },
    storage: { local: { get: vi.fn(async () => saved), set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(saved, values); }) } },
  });
  vi.stubGlobal('caches', { open: async () => ({ match: async (url: string) => entries.has(url) ? new Response('bytes') : undefined, keys: async () => [...entries].map(url => new Request(url)), delete: async (request: Request | string) => entries.delete(typeof request === 'string' ? request : request.url) }) });
});
afterEach(() => vi.unstubAllGlobals());
async function proxy() { const { LitertlmProxy } = await import('../../src/background/backends/litertlm-proxy'); return new LitertlmProxy(); }
describe('fixed Chrome offscreen proxy', () => {
  it('state, cleanup, and cache presence never create an absent host', async () => {
    const driver = await proxy(); entries.add(BROWSER_MODEL_URL);
    expect(await driver.getState()).toEqual({ cached: true, loaded: false, initializing: false, downloading: false });
    await driver.interrupt(); await driver.unload(); await driver.forceClose();
    expect(create).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('refuses evicted bytes before creating a host or fetching', async () => {
    const driver = await proxy();
    await expect(driver.initialize(vi.fn(), new AbortController().signal)).rejects.toThrow('not downloaded');
    expect(create).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('coalesces simultaneous creation and sends only fixed generation tokens', async () => {
    const first = await proxy(); const second = await proxy(); entries.add(BROWSER_MODEL_URL);
    await Promise.all([first.initialize(vi.fn(), new AbortController().signal), second.initialize(vi.fn(), new AbortController().signal)]);
    expect(create).toHaveBeenCalledOnce();
    for (const [message] of send.mock.calls.filter(([message]) => message.method === 'init')) {
      expect(message).toMatchObject({ method: 'init', generation: 'legacy', hostId: HOST_A });
      expect(message).not.toHaveProperty('modelDef'); expect(message).not.toHaveProperty('url');
    }
  });
  it('accepts progress only for a trusted offscreen sender and matching host/request', async () => {
    const driver = await proxy();
    let release!: () => void;
    let request: Record<string, unknown> = {};
    send.mockImplementation(async (message: Record<string, unknown>) => {
      if (message.method === 'state') return { ok: true, value: { hostId: host, loaded: false, initializing: false, downloading: false } };
      if (message.method === 'prefetch') { request = message; await new Promise<void>(resolve => { release = resolve; }); entries.add(`${BROWSER_MODEL_URL}?bouncer-generation=${String(message.generation)}`); }
      return { ok: true };
    });
    const progress = vi.fn<(value: BrowserProgress) => void>();
    const operation = driver.download(progress, new AbortController().signal);
    await vi.waitFor(() => expect(request.id).toBeDefined());
    const event = { channel: 'litertlm-progress', id: request.id, hostId: HOST_A, progress: 0.5, text: '' };
    listener(event, { id: 'test', url: 'chrome-extension://test/popup.html' });
    listener({ ...event, hostId: HOST_B }, { id: 'test', url: 'chrome-extension://test/offscreen.html' });
    listener(event, { id: 'test', url: 'chrome-extension://test/offscreen.html', tab: { id: 3 } as chrome.tabs.Tab });
    expect(progress).not.toHaveBeenCalled();
    listener(event, { id: 'test', url: 'chrome-extension://test/offscreen.html' });
    expect(progress).toHaveBeenCalledOnce(); release(); await operation;
  });
  it('reconstructs only the fixed sanitized actionable failure reason', async () => {
    const driver = await proxy(); entries.add(BROWSER_MODEL_URL);
    await driver.initialize(vi.fn(), new AbortController().signal);
    send.mockResolvedValue({ ok: false, reason: 'webgpu_unavailable', error: 'GPU unavailable' });
    await expect(driver.generate([{ role: 'user', content: 'post' }], 37)).rejects.toMatchObject({ reason: 'webgpu_unavailable' });
    send.mockResolvedValue({ ok: false, reason: 'arbitrary', error: 'Failed' });
    await expect(driver.generate([{ role: 'user', content: 'post' }], 37)).rejects.toMatchObject({ reason: 'browser_failed' });
  });
  it('adopts an in-flight download generation after worker restart and retires it before closing', async () => {
    exists = true; saved.browserCacheGeneration = HOST_A;
    const driver = await proxy();
    send.mockResolvedValue({ ok: true, value: { hostId: host, loaded: false, initializing: false, downloading: true, downloadGeneration: HOST_A } });
    expect((await driver.getState()).downloading).toBe(true);
    await driver.forceClose();
    expect(saved.browserCacheGeneration).not.toBe(HOST_A);
    expect(close).toHaveBeenCalledOnce();
  });
  it('exposes inherited initialization and cleanup owns that existing host without creating one', async () => {
    exists = true; entries.add(BROWSER_MODEL_URL);
    send.mockResolvedValue({ ok: true, value: { hostId: host, loaded: false, initializing: true, downloading: false } });
    const driver = await proxy();
    expect(await driver.getState()).toMatchObject({ cached: true, initializing: true, loaded: false });
    await driver.forceClose();
    expect(close).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
    expect(entries.has(BROWSER_MODEL_URL)).toBe(true);
  });
  it('requires strict initialization state rather than guessing absent work', async () => {
    exists = true;
    send.mockResolvedValue({ ok: true, value: { hostId: host, loaded: false, downloading: false } });
    const driver = await proxy();
    await expect(driver.getState()).rejects.toThrow('host unavailable');
    expect(create).not.toHaveBeenCalled();
  });
  it('a download completing during the state RPC reports saved bytes in its first idle snapshot', async () => {
    exists = true; saved.browserCacheGeneration = HOST_A;
    send.mockImplementation(async () => {
      entries.add(`${BROWSER_MODEL_URL}?bouncer-generation=${HOST_A}`);
      return { ok: true, value: { hostId: host, loaded: false, initializing: false, downloading: false } };
    });
    const driver = await proxy();
    expect(await driver.getState()).toMatchObject({ cached: true, downloading: false, initializing: false });
  });
  it('a concurrent generation retirement cannot authorize a stale cache snapshot', async () => {
    exists = true; saved.browserCacheGeneration = HOST_A;
    const key = `${BROWSER_MODEL_URL}?bouncer-generation=${HOST_A}`;
    entries.add(key);
    vi.stubGlobal('caches', { open: async () => ({
      keys: async () => [new Request(key)],
      match: async () => { saved.browserCacheGeneration = HOST_B; return new Response('old bytes'); },
    }) });
    const driver = await proxy();
    expect((await driver.getState()).cached).toBe(false);
  });
  it('initialization timeout holds caller ownership until captured GPU document cleanup settles', async () => {
    vi.useFakeTimers();
    try {
      chrome.runtime.getContexts = vi.fn(async () => exists ? [{ contextId: 'document-A' }] : []) as unknown as typeof chrome.runtime.getContexts;
      const driver = await proxy(); entries.add(BROWSER_MODEL_URL);
      let finishInit!: (response: unknown) => void;
      let finishClose!: () => void;
      send.mockImplementation(async (message: { method: string }) => {
        if (message.method === 'state') return { ok: true, value: { hostId: host, loaded: false, initializing: false, downloading: false } };
        if (message.method === 'init') return new Promise(resolve => { finishInit = resolve; });
        return { ok: true };
      });
      close.mockImplementation(async () => { await new Promise<void>(resolve => { finishClose = resolve; }); exists = false; });
      const initialization = driver.initialize(vi.fn(), new AbortController().signal);
      const rejected = expect(initialization).rejects.toThrow('timed out');
      let settled = false; void initialization.catch(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(180001);
      expect(close).toHaveBeenCalledOnce(); expect(settled).toBe(false);
      finishClose(); await rejected;
      expect(entries.has(BROWSER_MODEL_URL)).toBe(true);
      // A response arriving after host closure cannot republish initialization.
      finishInit({ ok: true }); await Promise.resolve();
      expect((await driver.getState()).loaded).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('late failed initialization never closes or clears a replacement host owner', async () => {
    let identity = 'document-A';
    chrome.runtime.getContexts = vi.fn(async () => exists ? [{ contextId: identity }] : []) as unknown as typeof chrome.runtime.getContexts;
    const driver = await proxy(); entries.add(BROWSER_MODEL_URL);
    let finishOld!: (response: unknown) => void;
    let first = true;
    send.mockImplementation(async (message: { method: string }) => {
      if (message.method === 'state') return { ok: true, value: { hostId: host, loaded: false, initializing: false, downloading: false } };
      if (message.method === 'init' && first) { first = false; return new Promise(resolve => { finishOld = resolve; }); }
      return { ok: true, value: message.method === 'generate' ? 'yes' : undefined };
    });
    const old = driver.initialize(vi.fn(), new AbortController().signal);
    const rejected = expect(old).rejects.toThrow('old initialization failed');
    await vi.waitFor(() => expect(finishOld).toBeDefined());
    identity = 'document-B'; host = HOST_B;
    await driver.initialize(vi.fn(), new AbortController().signal);
    finishOld({ ok: false, error: 'old initialization failed' }); await rejected;
    expect(close).not.toHaveBeenCalled();
    await expect(driver.generate([{ role: 'user', content: 'post' }], 37)).resolves.toBe('yes');
    expect(send.mock.calls[send.mock.calls.length - 1]?.[0].hostId).toBe(HOST_B);
  });
  it('retains discovered physical ownership when cache inspection fails', async () => {
    exists = true;
    chrome.runtime.getContexts = vi.fn(async () => [{ contextId: 'document-A' }]) as unknown as typeof chrome.runtime.getContexts;
    vi.stubGlobal('caches', { open: async () => { throw new Error('cache storage failed'); } });
    const driver = await proxy();
    await expect(driver.getState()).rejects.toThrow('cache storage failed');
    await driver.forceClose();
    expect(close).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
  });
  it('force close captures old host before asynchronous download retirement and preserves a new owner', async () => {
    exists = true; saved.browserCacheGeneration = HOST_A;
    let identity = 'document-A';
    chrome.runtime.getContexts = vi.fn(async () => [{ contextId: identity }]) as unknown as typeof chrome.runtime.getContexts;
    send.mockImplementation(async (message: { method: string }) => message.method === 'state'
      ? { ok: true, value: { hostId: host, loaded: false, initializing: false, downloading: host === HOST_A, downloadGeneration: host === HOST_A ? HOST_A : undefined } }
      : { ok: true, value: message.method === 'generate' ? 'yes' : undefined });
    const driver = await proxy(); await driver.getState();
    let finishRetirement!: () => void;
    chrome.storage.local.set = vi.fn(async (values: Record<string, unknown>) => {
      await new Promise<void>(resolve => { finishRetirement = resolve; }); Object.assign(saved, values);
    });
    const closing = driver.forceClose();
    await vi.waitFor(() => expect(finishRetirement).toBeDefined());
    identity = 'document-B'; host = HOST_B;
    entries.add(`${BROWSER_MODEL_URL}?bouncer-generation=${HOST_A}`);
    await driver.initialize(vi.fn(), new AbortController().signal);
    finishRetirement(); await closing;
    expect(close).not.toHaveBeenCalled();
    await expect(driver.generate([{ role: 'user', content: 'post' }], 37)).resolves.toBe('yes');
    expect(send.mock.calls[send.mock.calls.length - 1]?.[0].hostId).toBe(HOST_B);
  });
  it('force close rejects owned pending work without waiting for its RPC to respond', async () => {
    const driver = await proxy(); entries.add(BROWSER_MODEL_URL);
    await driver.initialize(vi.fn(), new AbortController().signal);
    send.mockImplementation(async (message: { method: string }) => message.method === 'state' ? { ok: true, value: { hostId: host, loaded: true, initializing: false, downloading: false } } : new Promise(() => undefined));
    const generation = driver.generate([{ role: 'user', content: 'post' }], 37);
    const rejection = expect(generation).rejects.toThrow('host closed');
    await driver.forceClose(); await rejection;
    expect(close).toHaveBeenCalledOnce();
    expect(entries.has(BROWSER_MODEL_URL)).toBe(true);
  });
  it('closes an owned stuck message loop using Chrome document identity', async () => {
    chrome.runtime.getContexts = vi.fn(async () => [{ contextId: 'document-A' }]) as unknown as typeof chrome.runtime.getContexts;
    const driver = await proxy(); entries.add(BROWSER_MODEL_URL);
    await driver.initialize(vi.fn(), new AbortController().signal);
    send.mockImplementation(() => new Promise(() => undefined));
    const generation = driver.generate([{ role: 'user', content: 'post' }], 37);
    const rejected = expect(generation).rejects.toThrow('host closed');
    await driver.forceClose(); await rejected;
    expect(close).toHaveBeenCalledOnce();
  });
  it('cannot close a replacement Chrome document even when its message loop is stuck', async () => {
    let identity = 'document-A';
    chrome.runtime.getContexts = vi.fn(async () => [{ contextId: identity }]) as unknown as typeof chrome.runtime.getContexts;
    const driver = await proxy(); entries.add(BROWSER_MODEL_URL);
    await driver.initialize(vi.fn(), new AbortController().signal);
    identity = 'document-B';
    send.mockImplementation(() => new Promise(() => undefined));
    await driver.forceClose();
    expect(close).not.toHaveBeenCalled();
  });
  it('an explicit retry can close the same unresponsive host discovered after worker restart', async () => {
    vi.useFakeTimers();
    try {
      exists = true;
      chrome.runtime.getContexts = vi.fn(async () => [{ contextId: 'old-document' }]) as unknown as typeof chrome.runtime.getContexts;
      send.mockImplementation(() => new Promise(() => undefined));
      const driver = await proxy();
      const state = driver.getState();
      const rejected = expect(state).rejects.toThrow('host unavailable');
      await vi.advanceTimersByTimeAsync(3100); await rejected;
      await driver.forceClose();
      expect(close).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('a stale proxy cannot unload or close the replacement host', async () => {
    const old = await proxy(); entries.add(BROWSER_MODEL_URL);
    await old.initialize(vi.fn(), new AbortController().signal);
    host = HOST_B;
    await old.forceClose();
    expect(close).not.toHaveBeenCalled();
  });
  it('cancellation retires the in-flight generation, leaving a late write ineligible', async () => {
    const driver = await proxy(); let finish!: () => void;
    let generation = '';
    send.mockImplementation(async (message: { method: string; generation?: string }) => {
      if (message.method === 'state') return { ok: true, value: { hostId: host, loaded: false, initializing: false, downloading: false } };
      if (message.method === 'prefetch') { generation = message.generation!; await new Promise<void>(resolve => { finish = resolve; }); entries.add(`${BROWSER_MODEL_URL}?bouncer-generation=${generation}`); }
      return { ok: true };
    });
    const controller = new AbortController();
    const download = driver.download(vi.fn(), controller.signal);
    const rejection = expect(download).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(generation).not.toBe(''));
    controller.abort();
    await vi.waitFor(() => expect(saved.browserCacheGeneration).not.toBe(generation));
    finish(); await rejection;
    expect((await driver.getState()).cached).toBe(false);
    expect(entries.size).toBe(0);
  });
});
