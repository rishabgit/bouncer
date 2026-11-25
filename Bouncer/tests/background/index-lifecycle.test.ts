import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentToBackgroundMessage, EvaluationResult, LocalModelStatus } from '../../src/types';

const state = vi.hoisted(() => ({
  loadCache: vi.fn(),
  readCachedEvaluation: vi.fn(),
  handleSettingsChange: vi.fn(),
  handlePageLoad: vi.fn(),
  clearTabQueue: vi.fn(),
  enqueuePost: vi.fn(),
  setActiveTab: vi.fn(),
  scheduleBatch: vi.fn(),
  captureInferenceRequest: vi.fn(),
  overridePost: vi.fn(),
  engine: {
    getStatus: vi.fn(), checkReadiness: vi.fn(),
    teardown: vi.fn(),
  },
}));

vi.mock('../../src/background/local-model.js', () => ({
  localEngine: state.engine,
}));
vi.mock('../../src/background/pipeline.js', () => ({
  initPipeline: vi.fn(), loadCache: state.loadCache, readCachedEvaluation: state.readCachedEvaluation,
  setActiveTab: state.setActiveTab, enqueuePost: state.enqueuePost, isKeyPending: vi.fn(() => false),
  clearTabQueue: state.clearTabQueue, scheduleBatch: state.scheduleBatch,
  getSettings: vi.fn().mockResolvedValue({ enabled: true, descriptions: ['Sports'], filterReplies: true }),
  errorState: { type: null, count: 0 }, clearEvaluationCache: vi.fn().mockResolvedValue(undefined),
  overridePost: state.overridePost, clearPost: vi.fn().mockResolvedValue(undefined),
  handleSettingsChange: state.handleSettingsChange, handleFilterChange: vi.fn().mockResolvedValue(undefined),
  handlePageLoad: state.handlePageLoad,
  captureInferenceRequest: state.captureInferenceRequest,
  replayDetectorStates: vi.fn(),
}));

let onMessage: (message: ContentToBackgroundMessage, sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void) => unknown;
let onInstalled: (details: { reason: string }) => void;
let onStorageChanged: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let onRemoved: (tabId: number) => void;
let onUpdated: (tabId: number, changes: { status?: string }) => void;
let onActivated: (details: { tabId: number }) => void;
let onFocusChanged: (windowId: number) => void;

const contentSender = { id: 'test-extension', url: 'https://x.com/home', frameId: 0, documentId: 'document-one', tab: { id: 1 } };
const popupSender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
const status: LocalModelStatus = { state: 'ready', message: 'Ready', revision: 1 };

function send(message: ContentToBackgroundMessage, sender: chrome.runtime.MessageSender = contentSender): Promise<unknown> {
  return new Promise(resolve => onMessage(message, sender, resolve));
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.loadCache.mockResolvedValue(undefined);
  state.readCachedEvaluation.mockResolvedValue(undefined);
  state.enqueuePost.mockImplementation((_tabId: number, item: { resolve: (result: unknown) => void }) => {
    item.resolve({ shouldHide: false, reasoning: 'new document queued' });
    return false;
  });
  state.handleSettingsChange.mockResolvedValue(undefined);
  state.overridePost.mockResolvedValue(undefined);
  state.captureInferenceRequest.mockImplementation((assertCurrent: () => void) => ({ assertCurrent }));
  state.engine.getStatus.mockResolvedValue(status);
  state.engine.checkReadiness.mockResolvedValue(status);
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: vi.fn(listener => { onMessage = listener; }) },
      onInstalled: { addListener: vi.fn(listener => { onInstalled = listener; }) },
      onSuspend: { addListener: vi.fn() },
    },
    storage: {
      local: { get: vi.fn().mockResolvedValue({ descriptions_twitter: ['Sports'] }), set: vi.fn().mockResolvedValue(undefined) },
      onChanged: { addListener: vi.fn(listener => { onStorageChanged = listener; }) },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue({ id: 1, status: 'complete' }),
      sendMessage: vi.fn().mockResolvedValue({ alive: true }),
      onActivated: { addListener: vi.fn(listener => { onActivated = listener; }) },
      onRemoved: { addListener: vi.fn(listener => { onRemoved = listener; }) },
      onUpdated: { addListener: vi.fn(listener => { onUpdated = listener; }) },
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: vi.fn(listener => { onFocusChanged = listener; }) } },
  } as unknown as typeof chrome;
});
afterEach(() => { vi.useRealTimers(); });

async function initialize(): Promise<void> {
  await import('../../src/background/index');
  await vi.waitFor(() => expect(chrome.tabs.query).toHaveBeenCalled());
}

describe('native background lifecycle and sender boundary', () => {
  it('starts without model requests and keeps install callbacks snapshot-only', async () => {
    await initialize();
    expect(state.engine.checkReadiness).not.toHaveBeenCalled();
    onInstalled({ reason: 'update' });
    await vi.waitFor(() => expect(state.engine.getStatus).toHaveBeenCalledOnce());
    expect(state.engine.checkReadiness).not.toHaveBeenCalled();
    expect(state.engine.teardown).not.toHaveBeenCalled();
  });

  it('awaits initial cache loading before page registration and install handlers', async () => {
    const gate = deferred();
    state.loadCache.mockReturnValueOnce(gate.promise);
    await import('../../src/background/index');
    const page = send({ type: 'pageLoad' });
    onInstalled({ reason: 'update' });
    await Promise.resolve();
    expect(state.loadCache).toHaveBeenCalledOnce();
    expect(state.handlePageLoad).not.toHaveBeenCalled();
    expect(state.engine.getStatus).not.toHaveBeenCalled();
    expect(state.engine.checkReadiness).not.toHaveBeenCalled();
    gate.resolve();
    await page;
    await vi.waitFor(() => expect(state.engine.getStatus).toHaveBeenCalledOnce());
    expect(state.handlePageLoad).toHaveBeenCalledWith(1);
    expect(state.engine.checkReadiness).not.toHaveBeenCalled();
  });

  it.each(['navigation', 'removal'] as const)('keeps a replacement document when startup defers old %s cleanup', async event => {
    const gate = deferred();
    state.loadCache.mockReturnValueOnce(gate.promise);
    await import('../../src/background/index');
    const oldWork = send({
      type: 'evaluatePost', evaluationId: 'old-eval', post: 'retired document post', postUrl: null, siteId: 'twitter',
    });
    if (event === 'navigation') onUpdated(1, { status: 'loading' });
    else onRemoved(1);
    const replacement = { ...contentSender, documentId: 'replacement-document' };
    const newPage = send({ type: 'pageLoad' }, replacement);
    expect(state.clearTabQueue).not.toHaveBeenCalled();
    gate.resolve();
    await expect(newPage).resolves.toEqual({ success: true });
    await expect(oldWork).resolves.toMatchObject({ retry: true, reasoning: expect.stringContaining('document') });
    expect(state.clearTabQueue).not.toHaveBeenCalled();
    expect(state.handlePageLoad).toHaveBeenCalledWith(1);
    await expect(send({
      type: 'evaluatePost', evaluationId: 'replacement-eval', post: 'replacement post', postUrl: null, siteId: 'twitter',
    }, replacement)).resolves.toMatchObject({ shouldHide: false, reasoning: 'new document queued' });
    expect(state.enqueuePost).toHaveBeenCalledOnce();
    expect(state.enqueuePost).toHaveBeenCalledWith(1, expect.objectContaining({ post: 'replacement post' }));
    expect(state.clearTabQueue).not.toHaveBeenCalled();
  });

  it('retries a failed startup cache read before exposing state', async () => {
    state.loadCache.mockRejectedValueOnce(new Error('Cache storage failed')).mockResolvedValueOnce(undefined);
    await import('../../src/background/index');
    await vi.waitFor(() => expect(state.loadCache).toHaveBeenCalledOnce());
    await expect(send({ type: 'getLocalModelStatus' }, popupSender)).resolves.toEqual({ success: true, status });
    expect(state.loadCache).toHaveBeenCalledTimes(2);
  });

  it('returns saved manual hide and restore without probing native availability', async () => {
    await initialize();
    state.engine.checkReadiness.mockRejectedValue(new Error('llama.app stopped'));
    for (const shouldHide of [true, false]) {
      const manual: EvaluationResult = { shouldHide, reasoning: 'manual', userOverride: true };
      state.readCachedEvaluation.mockResolvedValueOnce(manual);
      await expect(send({ type: 'evaluatePost', evaluationId: 'post-evaluation', post: 'saved post', postUrl: null, siteId: 'twitter' }))
        .resolves.toEqual({ ...manual, cached: true });
    }
    expect(state.engine.getStatus).not.toHaveBeenCalled();
    expect(state.engine.checkReadiness).not.toHaveBeenCalled();
  });

  it('checks metadata when the popup asks for status without invoking inference', async () => {
    await initialize();
    await expect(send({ type: 'getLocalModelStatus' }, popupSender)).resolves.toEqual({ success: true, status });
    expect(state.engine.checkReadiness).toHaveBeenCalledOnce();
    expect(state.enqueuePost).not.toHaveBeenCalled();
  });

  it('fresh installs report unavailable settings without starting inference', async () => {
    const unavailable: LocalModelStatus = { state: 'unavailable', message: 'Start llama.app.', revision: 1 };
    state.engine.checkReadiness.mockResolvedValue(unavailable);
    await initialize();
    expect(state.engine.checkReadiness).not.toHaveBeenCalled();
    await expect(send({ type: 'getLocalModelStatus' }, popupSender)).resolves.toEqual({ success: true, status: unavailable });
    expect(state.enqueuePost).not.toHaveBeenCalled();
  });

  it('rejects extra native setup fields', async () => {
    await initialize();
    await expect(send({ type: 'getLocalModelStatus', endpoint: 'http://localhost:9999' } as unknown as ContentToBackgroundMessage, popupSender))
      .resolves.toMatchObject({ success: false, error: expect.any(String) });
    expect(state.engine.checkReadiness).not.toHaveBeenCalled();
  });

  it.each([
    { ...contentSender, id: 'other-extension' },
    { ...contentSender, url: 'https://x.com.evil.example/home' },
    { ...contentSender, url: 'http://x.com/home' },
    { ...contentSender, frameId: 2 },
    { ...contentSender, url: 'https://example.com' },
  ])('rejects an untrusted native operation sender %#', async sender => {
    await initialize();
    await expect(send({ type: 'evaluatePost', evaluationId: 'untrusted', post: 'synthetic post', postUrl: null, siteId: 'twitter' }, sender))
      .resolves.toMatchObject({ retry: true, reasoning: expect.stringContaining('Untrusted') });
  });

  it('rejects endpoint/model overrides and content-script native control calls', async () => {
    await initialize();
    await expect(send({ type: 'evaluatePost', evaluationId: 'override', post: 'post', postUrl: null, siteId: 'twitter', endpoint: 'https://external.example' } as unknown as ContentToBackgroundMessage))
      .resolves.toMatchObject({ retry: true, reasoning: expect.stringContaining('fixed') });
    await expect(send({ type: 'retryNativeModel' } as unknown as ContentToBackgroundMessage)).resolves.toMatchObject({ error: expect.stringContaining('Unknown message type') });
    expect(state.engine.checkReadiness).not.toHaveBeenCalled();
  });

  it('cleans navigation and tab document queues', async () => {
    await initialize();
    await send({ type: 'pageLoad' });
    onUpdated(1, { status: 'loading' });
    await send({ type: 'pageLoad' }, { ...contentSender, documentId: 'document-two' });
    onRemoved(1);
    expect(state.clearTabQueue).toHaveBeenCalledWith(1);
    expect(state.engine.checkReadiness).not.toHaveBeenCalled();
  });

  describe('same-document SPA completion', () => {
    const completeTab = { id: 1, status: 'complete' } as chrome.tabs.Tab;
    const evaluate = (post: string, sender: chrome.runtime.MessageSender = contentSender) => send({
      type: 'evaluatePost', evaluationId: post, post, postUrl: null, siteId: 'twitter',
    }, sender);

    async function evaluateCached(post: string): Promise<unknown> {
      state.readCachedEvaluation.mockResolvedValueOnce({ shouldHide: false, reasoning: 'saved verdict' });
      return evaluate(post);
    }

    async function registerFocusedPage(): Promise<void> {
      await initialize();
      vi.mocked(chrome.tabs.query).mockResolvedValue([completeTab]);
      await expect(send({ type: 'pageLoad' })).resolves.toEqual({ success: true });
      expect(state.setActiveTab).toHaveBeenLastCalledWith(1);
    }

    it('creates a fresh owner for surviving content and keeps captured evaluations and inference fences retired', async () => {
      await registerFocusedPage();
      const cacheGate = deferred();
      state.loadCache.mockReturnValueOnce(cacheGate.promise);
      const oldEvaluation = evaluate('old evaluation');
      await vi.waitFor(() => {
        expect(state.loadCache).toHaveBeenCalledTimes(2);
      });
      const retiredFence = state.captureInferenceRequest.mock.results[0].value as { assertCurrent: () => void };
      onUpdated(1, { status: 'loading' });
      expect(state.clearTabQueue).toHaveBeenCalledOnce();
      expect(state.setActiveTab).toHaveBeenLastCalledWith(null);
      await expect(send({ type: 'pageLoad' })).resolves.toMatchObject({ success: false, error: expect.stringContaining('document') });
      onUpdated(1, { status: 'complete' });
      await vi.waitFor(() => expect(state.setActiveTab).toHaveBeenLastCalledWith(1));
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'ping' }, { documentId: 'document-one' });
      expect(chrome.tabs.get).toHaveBeenCalledWith(1);
      expect(retiredFence.assertCurrent).toThrow('originating X document has changed');
      cacheGate.resolve();
      await expect(oldEvaluation).resolves.toMatchObject({ retry: true, reasoning: expect.stringContaining('document') });
      await expect(evaluate('new SPA evaluation')).resolves.toMatchObject({ shouldHide: false, reasoning: 'new document queued' });
      expect(state.captureInferenceRequest.mock.results.at(-1)!.value.assertCurrent).not.toThrow();
      expect(retiredFence.assertCurrent).toThrow('originating X document has changed');
      expect(state.handlePageLoad).toHaveBeenCalledOnce();
      expect(state.scheduleBatch).toHaveBeenCalledOnce();
    });

    it('settles queued work as cancellation and accepts a fresh surviving-document request after recovery', async () => {
      await registerFocusedPage();
      let cancelQueued!: (response: null) => void;
      state.enqueuePost.mockImplementationOnce((_tabId, item: { resolve: (response: null) => void }) => {
        cancelQueued = item.resolve;
        return false;
      });
      state.clearTabQueue.mockImplementationOnce(() => cancelQueued(null));
      const cancelled = evaluate('queued SPA survivor');
      await vi.waitFor(() => expect(state.enqueuePost).toHaveBeenCalledOnce());
      onUpdated(1, { status: 'loading' });
      await expect(cancelled).resolves.toBeNull();
      onUpdated(1, { status: 'complete' });
      await vi.waitFor(() => expect(state.setActiveTab).toHaveBeenLastCalledWith(1));
      await expect(send({
        type: 'evaluatePost', evaluationId: 'fresh survivor operation', post: 'queued SPA survivor', postUrl: null, siteId: 'twitter',
      })).resolves.toMatchObject({ shouldHide: false, reasoning: 'new document queued' });
      expect(state.enqueuePost).toHaveBeenCalledTimes(2);
      expect(state.enqueuePost).toHaveBeenLastCalledWith(1, expect.objectContaining({ evaluationId: 'fresh survivor operation' }));
      expect(state.clearTabQueue).toHaveBeenCalledOnce();
    });

    it.each(['loading', 'removal', 'replacement'] as const)('lets a newer %s event beat recovery waiting for startup', async event => {
      const startupGate = deferred();
      state.loadCache.mockReturnValueOnce(startupGate.promise);
      await import('../../src/background/index');
      const oldEvaluation = evaluate('startup evaluation');
      onUpdated(1, { status: 'loading' });
      onUpdated(1, { status: 'complete' });
      const replacement = { ...contentSender, documentId: 'replacement-document' };
      let replacementPage: Promise<unknown> | undefined;
      if (event === 'loading') onUpdated(1, { status: 'loading' });
      else if (event === 'removal') onRemoved(1);
      else replacementPage = send({ type: 'pageLoad' }, replacement);
      startupGate.resolve();
      await expect(oldEvaluation).resolves.toMatchObject({ retry: true });
      if (replacementPage) {
        await expect(replacementPage).resolves.toEqual({ success: true });
        await expect(evaluate('replacement startup evaluation', replacement)).resolves.toMatchObject({ shouldHide: false });
      }
      await expect(send({ type: 'getLocalModelStatus' }, popupSender)).resolves.toEqual({ success: true, status });
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chrome.tabs.get).not.toHaveBeenCalled();
    });

    it.each([
      ['ping', 'loading'], ['ping', 'removal'], ['ping', 'replacement'],
      ['tab status', 'loading'], ['tab status', 'removal'], ['tab status', 'replacement'],
      ['focused tab', 'loading'], ['focused tab', 'removal'], ['focused tab', 'replacement'],
    ] as const)('lets a newer %s / %s race beat recovery and active-tab scheduling', async (stage, event) => {
      await registerFocusedPage();
      await expect(evaluateCached('captured before navigation')).resolves.toMatchObject({ cached: true });
      let nativeFence = state.captureInferenceRequest.mock.results[0].value as { assertCurrent: () => void };
      const pingGate = deferred<{ alive: true }>();
      const tabGate = deferred<chrome.tabs.Tab>();
      const focusGate = deferred<chrome.tabs.Tab[]>();
      if (stage === 'ping') vi.mocked(chrome.tabs.sendMessage).mockReturnValueOnce(pingGate.promise);
      else if (stage === 'tab status') vi.mocked(chrome.tabs.get).mockReturnValueOnce(tabGate.promise);
      else vi.mocked(chrome.tabs.query).mockReturnValueOnce(focusGate.promise);
      onUpdated(1, { status: 'loading' });
      onUpdated(1, { status: 'complete' });
      await vi.waitFor(() => {
        if (stage === 'ping') expect(chrome.tabs.sendMessage).toHaveBeenCalledOnce();
        else if (stage === 'tab status') expect(chrome.tabs.get).toHaveBeenCalledOnce();
        else expect(chrome.tabs.query).toHaveBeenCalledTimes(3);
      });
      if (stage === 'focused tab') {
        await expect(evaluateCached('captured during focus detection')).resolves.toMatchObject({ cached: true });
        nativeFence = state.captureInferenceRequest.mock.results[1].value as { assertCurrent: () => void };
        expect(nativeFence.assertCurrent).not.toThrow();
      }
      const replacement = { ...contentSender, documentId: 'replacement-document' };
      if (event === 'loading') onUpdated(1, { status: 'loading' });
      else if (event === 'removal') onRemoved(1);
      else await expect(send({ type: 'pageLoad' }, replacement)).resolves.toEqual({ success: true });
      pingGate.resolve({ alive: true });
      tabGate.resolve(completeTab);
      focusGate.resolve([completeTab]);
      // Flush the completed recovery independently of any content request.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(state.setActiveTab).toHaveBeenLastCalledWith(event === 'replacement' ? 1 : null);
      expect(nativeFence.assertCurrent).toThrow('originating X document has changed');
      if (event !== 'removal') {
        await expect(evaluate('obsolete SPA evaluation')).resolves.toMatchObject({ retry: true, reasoning: expect.stringContaining('document') });
      }
      if (stage === 'ping') expect(chrome.tabs.get).not.toHaveBeenCalled();
      const expectedQueries = (stage === 'focused tab' ? 3 : 2) + (event === 'replacement' ? 1 : 0);
      expect(chrome.tabs.query).toHaveBeenCalledTimes(expectedQueries);
      if (event === 'replacement') {
        await expect(evaluate('replacement SPA evaluation', replacement)).resolves.toMatchObject({ shouldHide: false });
        expect(state.clearTabQueue).toHaveBeenCalledOnce();
      }
    });

    it.each([undefined, null, {}, { alive: false }, { alive: 1 }, { alive: 'true' }])('does not recover from an unproved ping response %#', async response => {
      await registerFocusedPage();
      vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce(response);
      onUpdated(1, { status: 'loading' });
      onUpdated(1, { status: 'complete' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'ping' }, { documentId: 'document-one' });
      expect(chrome.tabs.get).not.toHaveBeenCalled();
      expect(state.setActiveTab).toHaveBeenLastCalledWith(null);
      await expect(evaluate('unproved SPA evaluation')).resolves.toMatchObject({ retry: true });
    });

    it.each(['ping failed', 'tab failed', 'still loading'] as const)('does not recover when %s', async failure => {
      await registerFocusedPage();
      if (failure === 'ping failed') vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(new Error('No matching document'));
      else if (failure === 'tab failed') vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error('Tab closed'));
      else vi.mocked(chrome.tabs.get).mockResolvedValueOnce({ ...completeTab, status: 'loading' });
      onUpdated(1, { status: 'loading' });
      onUpdated(1, { status: 'complete' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'ping' }, { documentId: 'document-one' });
      expect(state.setActiveTab).toHaveBeenLastCalledWith(null);
      await expect(evaluate('failed SPA evaluation')).resolves.toMatchObject({ retry: true });
    });

    it('ignores completion for an unknown or already current document', async () => {
      await initialize();
      onUpdated(1, { status: 'complete' });
      await send({ type: 'pageLoad' });
      onUpdated(1, { status: 'complete' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chrome.tabs.get).not.toHaveBeenCalled();
      await expect(evaluate('current document evaluation')).resolves.toMatchObject({ shouldHide: false });
    });

    it('does not retire the fresh owner when a duplicate completion probe resolves later', async () => {
      await registerFocusedPage();
      const duplicatePing = deferred<{ alive: true }>();
      vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({ alive: true }).mockReturnValueOnce(duplicatePing.promise);
      onUpdated(1, { status: 'loading' });
      onUpdated(1, { status: 'complete' });
      onUpdated(1, { status: 'complete' });
      await vi.waitFor(() => expect(state.setActiveTab).toHaveBeenLastCalledWith(1));
      await expect(evaluateCached('fresh owner captured evaluation')).resolves.toMatchObject({ cached: true });
      const freshFence = state.captureInferenceRequest.mock.results[0].value as { assertCurrent: () => void };
      duplicatePing.resolve({ alive: true });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(freshFence.assertCurrent).not.toThrow();
      expect(chrome.tabs.get).toHaveBeenCalledOnce();
      await expect(evaluate('fresh owner evaluation')).resolves.toMatchObject({ shouldHide: false });
    });

    it.each(['tab activation', 'window focus', 'window blur'] as const)('lets a newer %s beat a stale recovery focus snapshot', async event => {
      await registerFocusedPage();
      const otherTab = { id: 2, status: 'complete' } as chrome.tabs.Tab;
      await expect(send({ type: 'pageLoad' }, { ...contentSender, tab: { id: 2 }, documentId: 'document-other-tab' }))
        .resolves.toEqual({ success: true });
      const focusGate = deferred<chrome.tabs.Tab[]>();
      vi.mocked(chrome.tabs.query).mockReturnValueOnce(focusGate.promise).mockResolvedValue([otherTab]);
      onUpdated(1, { status: 'loading' });
      onUpdated(1, { status: 'complete' });
      await vi.waitFor(() => expect(chrome.tabs.query).toHaveBeenCalledTimes(4));
      if (event === 'tab activation') onActivated({ tabId: 2 });
      else if (event === 'window focus') onFocusChanged(2);
      else onFocusChanged(chrome.windows.WINDOW_ID_NONE);
      const expectedActiveTab = event === 'window blur' ? null : 2;
      await vi.waitFor(() => expect(state.setActiveTab).toHaveBeenLastCalledWith(expectedActiveTab));
      focusGate.resolve([completeTab]);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(state.setActiveTab).toHaveBeenLastCalledWith(expectedActiveTab);
      await expect(evaluateCached('still current unfocused SPA')).resolves.toMatchObject({ cached: true });
      expect(state.captureInferenceRequest.mock.results[0].value.assertCurrent).not.toThrow();
    });
  });

  it('disabling filtering retires the active verdict boundary', async () => {
    await initialize();
    const changes = { enabled: { oldValue: true, newValue: false } };
    onStorageChanged(changes, 'local');
    await vi.waitFor(() => expect(state.handleSettingsChange).toHaveBeenCalledWith(changes));
  });
});
