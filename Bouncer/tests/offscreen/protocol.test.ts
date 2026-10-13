import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserProgress } from '../../src/background/backends/types';
const hooks = vi.hoisted(() => ({ prefetch: vi.fn(), initialize: vi.fn() }));
vi.mock('../../src/offscreen/litertlm-runtime', () => ({
  LitertlmRuntime: class { loaded = false; initialize = hooks.initialize; prefetch = hooks.prefetch; generate = vi.fn(); interrupt = vi.fn(); unload = vi.fn(); },
}));
let listener: (message: unknown, sender: chrome.runtime.MessageSender, reply: (response: unknown) => void) => boolean;
let parse: (message: unknown) => unknown;
let hostId: string;
beforeEach(async () => {
  vi.resetModules(); hooks.prefetch.mockReset(); hooks.initialize.mockReset();
  chrome.runtime.sendMessage = vi.fn().mockResolvedValue(undefined);
  chrome.runtime.getURL = path => `chrome-extension://test-extension-id/${path}`;
  chrome.runtime.onMessage.addListener = vi.fn(callback => { listener = callback as typeof listener; });
  const module = await import('../../src/offscreen/index'); parse = module.parseOffscreenRequest;
  const reply = vi.fn();
  listener({ target: 'litertlm-offscreen', method: 'state', id: 'state-1' }, { id: chrome.runtime.id }, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
  hostId = reply.mock.calls[0][0].value.hostId;
});
afterEach(() => vi.useRealTimers());
function request(extra: Record<string, unknown> = {}) { return { target: 'litertlm-offscreen', method: 'generate', id: 'request-1', hostId, messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'post' }], maxTokens: 37, ...extra }; }
describe('fixed offscreen authority boundary', () => {
  it.each([
    { id: 'foreign' }, { id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup.html' },
    { id: 'test-extension-id', url: 'https://x.com', tab: { id: 1 } },
    { id: 'test-extension-id', tab: { id: 1 } },
  ])('rejects popup/content/foreign senders without replying: %s', sender => {
    const reply = vi.fn();
    expect(listener(request(), sender as chrome.runtime.MessageSender, reply)).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
  it('accepts only an absent worker URL or exact packaged worker URL', async () => {
    const { isTrustedBackground } = await import('../../src/offscreen/index');
    expect(isTrustedBackground({ id: chrome.runtime.id })).toBe(true);
    expect(isTrustedBackground({ id: chrome.runtime.id, url: chrome.runtime.getURL('dist/background.js') })).toBe(true);
    expect(isTrustedBackground({ id: chrome.runtime.id, url: chrome.runtime.getURL('background.js') })).toBe(false);
  });
  it.each([{ url: 'https://example.test' }, { modelDef: {} }, { config: {} }, { model: 'alternate' }, { media: [] }])('rejects arbitrary runtime fields %s', fields => {
    expect(parse(request(fields))).toBeNull();
  });
  it('rejects wrong ownership, unbounded output/text, unknown roles, and media content', () => {
    for (const fields of [
      { hostId: 'replacement' }, { maxTokens: 0 }, { maxTokens: 257 }, { maxTokens: 1.5 },
      { messages: [{ role: 'user', content: 'x'.repeat(32769) }] },
      { messages: [{ role: 'tool', content: 'text' }] },
      { messages: [{ role: 'user', content: [{ type: 'image', url: 'example' }] }] },
      { messages: [{ role: 'assistant', content: 'last' }] },
    ]) expect(parse(request(fields))).toBeNull();
    expect(parse(request())).not.toBeNull();
    expect(parse(request({ method: 'toString' }))).toBeNull();
  });
  it('reports initialization while uncancellable engine creation is pending, including after cancel', async () => {
    let finish!: () => void;
    hooks.initialize.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const initReply = vi.fn();
    const id = 'inherited-init';
    listener({ target: 'litertlm-offscreen', method: 'init', id, hostId, generation: 'legacy' }, { id: chrome.runtime.id }, initReply);
    const state = async () => {
      const reply = vi.fn();
      listener({ target: 'litertlm-offscreen', method: 'state', id: crypto.randomUUID() }, { id: chrome.runtime.id }, reply);
      await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
      return reply.mock.calls[0][0].value;
    };
    expect(await state()).toMatchObject({ initializing: true, loaded: false, downloading: false });
    const cancelReply = vi.fn();
    listener({ target: 'litertlm-offscreen', method: 'cancel', id: 'cancel-init', hostId, requestId: id }, { id: chrome.runtime.id }, cancelReply);
    expect(await state()).toMatchObject({ initializing: true });
    expect(initReply).not.toHaveBeenCalled();
    finish(); await vi.waitFor(() => expect(initReply).toHaveBeenCalledOnce());
    expect(await state()).toMatchObject({ initializing: false });
  });
  it('returns a sanitized actionable quota reason without leaking provider text', async () => {
    hooks.prefetch.mockRejectedValueOnce({ name: 'QuotaExceededError', message: 'private SDK details' });
    const reply = vi.fn();
    listener({ target: 'litertlm-offscreen', method: 'prefetch', id: 'download-1', hostId, generation: 'ab9b47f8-60a1-4422-9bb4-5e09e37379d4' }, { id: chrome.runtime.id }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(reply.mock.calls[0][0]).toEqual({ ok: false, reason: 'storage_full', error: 'Browser storage is full. Free space and download again.' });
  });
  it('accepts only the fixed legacy or strict UUID generation token', () => {
    const common = { target: 'litertlm-offscreen', method: 'init', id: 'init-1', hostId };
    expect(parse({ ...common, generation: 'legacy' })).not.toBeNull();
    expect(parse({ ...common, generation: 'ab9b47f8-60a1-4422-9bb4-5e09e37379d4' })).not.toBeNull();
    expect(parse({ ...common, generation: 'https://example.test/model' })).toBeNull();
    expect(parse({ ...common, method: 'prefetch', generation: 'legacy' })).toBeNull();
  });
});


function sendRequest(message: Record<string, unknown>): Promise<unknown> {
  return new Promise(resolve => listener({ target: 'litertlm-offscreen', ...message }, { id: chrome.runtime.id }, resolve));
}
function readState(): Promise<{ ok: boolean; value: { progress?: number; receivedBytes?: number; downloading: boolean } }> {
  return sendRequest({ method: 'state', id: crypto.randomUUID() }) as ReturnType<typeof readState>;
}
function downloadRequest(id: string): Promise<unknown> {
  return sendRequest({ method: 'prefetch', id, hostId, generation: 'ab9b47f8-60a1-4422-9bb4-5e09e37379d4' });
}
function progress(value: number): BrowserProgress { return { progress: value / 1000, text: '', receivedBytes: value, totalBytes: 1000 }; }

describe('bounded offscreen progress delivery', () => {
  it('coalesces a thousand synchronous chunks to one final message even when delivery never settles', async () => {
    vi.useFakeTimers();
    chrome.runtime.sendMessage = vi.fn(() => new Promise(() => undefined));
    hooks.prefetch.mockImplementation((_generation: string, report: (value: BrowserProgress) => void) => {
      for (let value = 1; value <= 1000; value++) report(progress(value));
      return Promise.resolve();
    });
    await downloadRequest('burst-download');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ channel: 'litertlm-progress', hostId, id: 'burst-download', ...progress(1000) });
    expect((await readState()).value).toMatchObject({ progress: 1, receivedBytes: 1000, downloading: false });
    await vi.advanceTimersByTimeAsync(10000);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it('sends only latest metadata at 250ms cadence and permits just one ordinary message in flight', async () => {
    vi.useFakeTimers();
    let report!: (value: BrowserProgress) => void;
    let finish!: () => void;
    const deliveries: Array<() => void> = [];
    chrome.runtime.sendMessage = vi.fn(() => new Promise<void>(resolve => { deliveries.push(resolve); }));
    hooks.prefetch.mockImplementation((_generation: string, onProgress: typeof report) => {
      report = onProgress;
      return new Promise<void>(resolve => { finish = resolve; });
    });
    const operation = downloadRequest('paced-download');
    for (let value = 1; value <= 200; value++) report(progress(value));
    expect((await readState()).value).toMatchObject({ progress: 0.2, receivedBytes: 200, downloading: true });
    await vi.advanceTimersByTimeAsync(249);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ channel: 'litertlm-progress', hostId, id: 'paced-download', ...progress(200) });
    for (let value = 201; value <= 600; value++) report(progress(value));
    await vi.advanceTimersByTimeAsync(5000);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
    expect((await readState()).value).toMatchObject({ progress: 0.6, receivedBytes: 600 });
    deliveries[0](); await vi.advanceTimersByTimeAsync(0);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ channel: 'litertlm-progress', hostId, id: 'paced-download', ...progress(600) });
    // Successful completion bypasses the one still-pending ordinary message once.
    report(progress(1000)); finish(); await operation;
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ channel: 'litertlm-progress', hostId, id: 'paced-download', ...progress(1000) });
    deliveries[1](); await vi.advanceTimersByTimeAsync(10000);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
  });

  it.each(['cancel', 'error'] as const)('retires pending timers and callback ownership on %s', async ending => {
    vi.useFakeTimers();
    let report!: (value: BrowserProgress) => void;
    let fail!: (error: Error) => void;
    let settleMessage!: () => void;
    chrome.runtime.sendMessage = vi.fn(() => new Promise<void>(resolve => { settleMessage = resolve; }));
    hooks.prefetch.mockImplementation((_generation: string, onProgress: typeof report) => {
      report = onProgress;
      return new Promise<void>((_resolve, reject) => { fail = reject; });
    });
    const operation = downloadRequest('retired-download');
    report(progress(100)); await vi.advanceTimersByTimeAsync(250);
    report(progress(200));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
    if (ending === 'cancel') await sendRequest({ method: 'cancel', id: 'cancel-retired', hostId, requestId: 'retired-download' });
    fail(new Error(ending === 'cancel' ? 'Browser operation cancelled' : 'Browser model download failed'));
    await expect(operation).resolves.toMatchObject({ ok: false });
    settleMessage(); report(progress(1000)); await vi.advanceTimersByTimeAsync(10000);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
    expect((await readState()).value.progress).toBeUndefined();
    // A new request can report its own final state without an older send reviving.
    hooks.prefetch.mockImplementationOnce((_generation: string, currentReport: typeof report) => { currentReport(progress(1000)); return Promise.resolve(); });
    await downloadRequest('replacement-download');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ channel: 'litertlm-progress', hostId, id: 'replacement-download', ...progress(1000) });
  });
});
