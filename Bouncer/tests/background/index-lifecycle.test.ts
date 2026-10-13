import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentToBackgroundMessage, EvaluationResult, LocalModelStatus } from '../../src/types';
import type { LocalEngine } from '../../src/background/local-model';
import type { LocalBackend } from '../../src/background/backends/types';

const state = vi.hoisted(() => ({
  migration: vi.fn(),
  loadCache: vi.fn(),
  readCachedEvaluation: vi.fn(),
  handleSettingsChange: vi.fn(),
  handlePageLoad: vi.fn(),
  clearTabQueue: vi.fn(),
  enqueuePost: vi.fn(),
  setActiveTab: vi.fn(),
  scheduleBatch: vi.fn(),
  suggestAnnoyingReasons: vi.fn(),
  captureInferenceRequest: vi.fn(),
  overridePost: vi.fn(),
  triggerErrorRetry: vi.fn(),
  engineOverride: null as LocalEngine | null,
  engine: {
    getStatus: vi.fn(), retry: vi.fn(), recoverAfterOperatorRestart: vi.fn(),
    syncAllStatuses: vi.fn(), preempt: vi.fn(), teardown: vi.fn(),
    isMaintaining: vi.fn(() => false),
  },
}));

vi.mock('../../src/background/local-model.js', () => ({ get localEngine() { return state.engineOverride ?? state.engine; } }));
vi.mock('../../src/background/model-migration.js', () => ({
  migrateToNativeModel: state.migration,
  stripNativeCutoverStorageChanges: (changes: Record<string, chrome.storage.StorageChange>) =>
    Object.fromEntries(Object.entries(changes).filter(([key]) => ![
      'selectedModel', 'localModelStatuses', 'nativeCutoverSchemaVersion', 'nativeModelCacheCleanupVersion',
    ].includes(key))),
}));
vi.mock('../../src/background/benchmark.js', () => ({ handleBenchmark: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/background/pipeline.js', () => ({
  initPipeline: vi.fn(), loadCache: state.loadCache, readCachedEvaluation: state.readCachedEvaluation,
  setActiveTab: state.setActiveTab, enqueuePost: state.enqueuePost, isKeyPending: vi.fn(() => false),
  clearTabQueue: state.clearTabQueue, scheduleBatch: state.scheduleBatch,
  getSettings: vi.fn().mockResolvedValue({ enabled: true, descriptions: ['Sports'], filterReplies: true }),
  errorState: { type: null, count: 0 }, clearEvaluationCache: vi.fn().mockResolvedValue(undefined),
  overridePost: state.overridePost, clearPost: vi.fn().mockResolvedValue(undefined),
  handleSettingsChange: state.handleSettingsChange, handleFilterPackChange: vi.fn().mockResolvedValue(undefined),
  handlePageLoad: state.handlePageLoad, suggestAnnoyingReasons: state.suggestAnnoyingReasons,
  captureInferenceRequest: state.captureInferenceRequest,
  runInferenceRequest: (request: { startedAt: number; assertCurrent: () => void }, operation: (request: unknown) => Promise<unknown>) => operation(request),
  replayDetectorStates: vi.fn(), triggerErrorRetry: state.triggerErrorRetry,
}));

let onMessage: (message: ContentToBackgroundMessage, sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void) => unknown;
let onInstalled: (details: { reason: string }) => void;
let onStorageChanged: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let onRemoved: (tabId: number) => void;
let onUpdated: (tabId: number, changes: { status?: string }) => void;
let onActivated: (details: { tabId: number }) => void;
let onFocusChanged: (windowId: number) => void;
let onPermissionRemoved: (permissions: { origins?: string[] }) => void;
let onPermissionAdded: (permissions: { origins?: string[] }) => void;

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
  state.engineOverride = null;
  state.migration.mockResolvedValue({});
  state.loadCache.mockResolvedValue(undefined);
  state.readCachedEvaluation.mockResolvedValue(undefined);
  state.enqueuePost.mockImplementation((_tabId: number, item: { resolve: (result: unknown) => void }) => {
    item.resolve({ shouldHide: false, reasoning: 'new document queued' });
    return false;
  });
  state.handleSettingsChange.mockResolvedValue(undefined);
  state.overridePost.mockResolvedValue(undefined);
  state.triggerErrorRetry.mockResolvedValue(undefined);
  state.suggestAnnoyingReasons.mockResolvedValue([]);
  state.captureInferenceRequest.mockImplementation((assertCurrent: () => void) => ({ startedAt: Date.now(), assertCurrent }));
  state.engine.getStatus.mockResolvedValue(status);
  state.engine.retry.mockResolvedValue(status);
  state.engine.recoverAfterOperatorRestart.mockResolvedValue(status);
  state.engine.syncAllStatuses.mockResolvedValue(undefined);
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
    permissions: {
      onRemoved: { addListener: vi.fn(listener => { onPermissionRemoved = listener; }) },
      onAdded: { addListener: vi.fn(listener => { onPermissionAdded = listener; }) },
    },
  } as unknown as typeof chrome;
});
afterEach(() => { state.engineOverride?.teardown(); vi.useRealTimers(); });

async function initialize(): Promise<void> {
  await import('../../src/background/index');
  await vi.waitFor(() => expect(state.engine.syncAllStatuses).toHaveBeenCalled());
}

describe('native background lifecycle and sender boundary', () => {
  it('awaits cutover before cache loading, page registration, preemption, and install handlers', async () => {
    const gate = deferred();
    state.migration.mockReturnValueOnce(gate.promise);
    await import('../../src/background/index');
    const page = send({ type: 'pageLoad' });
    const preempt = send({ type: 'preemptInference' });
    onInstalled({ reason: 'update' });
    await Promise.resolve();
    expect(state.loadCache).not.toHaveBeenCalled();
    expect(state.handlePageLoad).not.toHaveBeenCalled();
    expect(state.engine.preempt).not.toHaveBeenCalled();
    expect(state.engine.syncAllStatuses).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([page, preempt]);
    expect(state.loadCache).toHaveBeenCalled();
    expect(state.handlePageLoad).toHaveBeenCalledWith(1);
    expect(state.engine.preempt).toHaveBeenCalledOnce();
    expect(state.engine.syncAllStatuses).toHaveBeenCalled();
  });

  it.each(['navigation', 'removal'] as const)('keeps a replacement document when startup defers old %s cleanup', async event => {
    const gate = deferred();
    state.migration.mockReturnValueOnce(gate.promise);
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

  it('retries an unsuccessful cutover on the next request before exposing state', async () => {
    state.migration.mockRejectedValueOnce(new Error('Cutover storage failed')).mockResolvedValueOnce({});
    await import('../../src/background/index');
    await vi.waitFor(() => expect(state.migration).toHaveBeenCalledOnce());
    await expect(send({ type: 'getNativeModelStatus' }, popupSender)).resolves.toEqual({ status });
    expect(state.migration).toHaveBeenCalledTimes(2);
  });

  it('returns saved manual hide and restore without probing native availability', async () => {
    await initialize();
    state.engine.getStatus.mockRejectedValue(new Error('Ollama stopped'));
    for (const shouldHide of [true, false]) {
      const manual: EvaluationResult = { shouldHide, reasoning: 'manual', userOverride: true };
      state.readCachedEvaluation.mockResolvedValueOnce(manual);
      await expect(send({ type: 'evaluatePost', evaluationId: 'post-evaluation', post: 'saved post', postUrl: null, siteId: 'twitter' }))
        .resolves.toEqual({ ...manual, cached: true });
    }
    expect(state.engine.getStatus).not.toHaveBeenCalled();
    expect(state.engine.retry).not.toHaveBeenCalled();
  });

  it('provides a metadata snapshot and popup connection retry without an initialization/download route', async () => {
    await initialize();
    await expect(send({ type: 'getNativeModelStatus' }, popupSender)).resolves.toEqual({ status });
    await expect(send({ type: 'connectNativeModel' }, popupSender)).resolves.toEqual({ success: true, status });
    await expect(send({ type: 'retryNativeModel' }, popupSender)).resolves.toEqual({ success: true, status });
    expect(state.engine.retry).toHaveBeenCalledTimes(2);
    expect(state.triggerErrorRetry).toHaveBeenCalledWith(true, true);
  });

  describe('explicit native permission grant completion', () => {
    const origins = ['http://127.0.0.1:11434/*'];
    const disconnected: LocalModelStatus = {
      state: 'not_connected', message: 'Connect to Ollama to allow local filtering.', reason: 'permission_required', revision: 2,
    };

    async function realDeferredMetadata(withFence = false) {
      const { LocalEngine } = await vi.importActual<typeof import('../../src/background/local-model')>('../../src/background/local-model');
      const { NativeModelError } = await import('../../src/shared/ollama-contract');
      const permission = deferred<boolean>();
      let permitted = false;
      let holdPermissionCheck = false;
      const fence = { schemaVersion: 1, operationId: 'unresolved-native-work', epoch: 1, startedAt: Date.now(), modelDigest: 'a'.repeat(64) };
      const stored: Record<string, unknown> = {
        descriptions_twitter: ['Sports'], ...(withFence ? { nativeOperationFence: fence } : {}),
      };
      chrome.storage.local.get = vi.fn(async (keys: string[]) => Object.fromEntries(keys
        .filter(key => key in stored).map(key => [key, structuredClone(stored[key])])));
      chrome.storage.local.set = vi.fn(async items => { Object.assign(stored, structuredClone(items)); });
      chrome.storage.local.remove = vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
      });
      chrome.permissions.contains = vi.fn(() => {
        if (holdPermissionCheck) { holdPermissionCheck = false; return permission.promise; }
        return Promise.resolve(permitted);
      });
      const backend: LocalBackend = {
        check: vi.fn(async () => {
          if (!await chrome.permissions.contains({ origins })) {
            throw new NativeModelError('permission_required', 'Connect to Ollama to allow local filtering.');
          }
          return { version: '0.40.3', modelDigest: 'a'.repeat(64), resident: false, otherModelResident: false };
        }),
        generate: vi.fn().mockResolvedValue('no'),
      };
      const engine = new LocalEngine(backend);
      const retry = vi.spyOn(engine, 'retry');
      state.engineOverride = engine;
      await import('../../src/background/index');
      await expect(send({ type: 'getNativeModelStatus' }, popupSender)).resolves.toMatchObject({ status: { state: 'not_connected' } });
      permitted = true;
      holdPermissionCheck = true;
      onPermissionAdded({ origins });
      await vi.waitFor(() => expect(backend.check).toHaveBeenCalledOnce());
      return {
        backend, engine, retry, permission, stored, fence,
        revoke: () => { permitted = false; onPermissionRemoved({ origins }); },
        regrant: () => { permitted = true; onPermissionAdded({ origins }); },
      };
    }

    it.each([false, true])('checks fresh metadata after revoked readiness settles (unresolved fence=%s)', async withFence => {
      const operation = await realDeferredMetadata(withFence);
      operation.revoke();
      operation.regrant();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(operation.backend.check).toHaveBeenCalledOnce();
      // A captured contains(false) result arrives after permission was regranted.
      operation.permission.resolve(false);
      await vi.waitFor(() => expect(operation.backend.check).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => expect(await operation.engine.getStatus()).toMatchObject({
        state: withFence ? 'recovery_required' : 'ready',
      }));
      if (withFence) {
        expect(operation.stored.nativeOperationFence).toEqual(operation.fence);
        expect(chrome.storage.local.remove).not.toHaveBeenCalled();
        expect(state.triggerErrorRetry).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(state.triggerErrorRetry).toHaveBeenCalledWith(true, true));
        expect(state.triggerErrorRetry).toHaveBeenCalledOnce();
      }
      expect(operation.retry).toHaveBeenCalledTimes(2);
      expect(operation.backend.generate).not.toHaveBeenCalled();
    });

    it('skips a superseded regrant and coalesces only the final revision after old readiness settles', async () => {
      const operation = await realDeferredMetadata();
      operation.revoke();
      operation.regrant();
      await new Promise(resolve => setTimeout(resolve, 0));
      operation.revoke();
      operation.regrant();
      const survivingPopup = send({ type: 'connectNativeModel' }, popupSender);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(operation.backend.check).toHaveBeenCalledOnce();
      operation.permission.resolve(false);
      await expect(survivingPopup).resolves.toMatchObject({ success: true, status: { state: 'ready' } });
      expect(operation.retry).toHaveBeenCalledTimes(2);
      expect(operation.backend.check).toHaveBeenCalledTimes(2);
      expect(state.triggerErrorRetry).toHaveBeenCalledOnce();
      // Settled predecessor cleanup must not retain or erase the final check.
      await expect(send({ type: 'retryNativeModel' }, popupSender)).resolves.toMatchObject({ success: true, status: { state: 'ready' } });
      expect(operation.backend.check).toHaveBeenCalledTimes(3);
      expect(state.triggerErrorRetry).toHaveBeenCalledTimes(2);
      expect(operation.backend.generate).not.toHaveBeenCalled();
    });

    it('finishes metadata verification when the exact grant closes the popup before its continuation', async () => {
      await initialize();
      onPermissionAdded({ origins });
      await vi.waitFor(() => expect(state.engine.retry).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(state.triggerErrorRetry).toHaveBeenCalledWith(true, true));
      expect(state.engine.syncAllStatuses).toHaveBeenCalledOnce();
      expect(state.engine.preempt).not.toHaveBeenCalled();
      expect(state.engine.recoverAfterOperatorRestart).not.toHaveBeenCalled();
      expect(state.enqueuePost).not.toHaveBeenCalled();
      expect(state.suggestAnnoyingReasons).not.toHaveBeenCalled();
    });

    it('keeps denial, unrelated grants and popup opening snapshot-only', async () => {
      await initialize();
      onPermissionAdded({ origins: [] });
      for (const origin of ['https://unrelated.example/*', 'http://localhost:11434/*', 'http://127.0.0.1:11435/*']) {
        onPermissionAdded({ origins: [origin] });
      }
      await expect(send({ type: 'getNativeModelStatus' }, popupSender)).resolves.toEqual({ status });
      expect(state.engine.retry).not.toHaveBeenCalled();
      expect(state.triggerErrorRetry).not.toHaveBeenCalled();
      expect(state.engine.syncAllStatuses).toHaveBeenCalledOnce();
    });

    it.each(['grant first', 'popup first'] as const)('coalesces the surviving popup continuation with metadata verification (%s)', async order => {
      await initialize();
      const metadata = deferred<LocalModelStatus>();
      state.engine.retry.mockReturnValue(metadata.promise);
      let popup: Promise<unknown>;
      if (order === 'grant first') {
        onPermissionAdded({ origins });
        await vi.waitFor(() => expect(state.engine.retry).toHaveBeenCalledOnce());
        popup = send({ type: 'connectNativeModel' }, popupSender);
      } else {
        popup = send({ type: 'connectNativeModel' }, popupSender);
        await vi.waitFor(() => expect(state.engine.retry).toHaveBeenCalledOnce());
        onPermissionAdded({ origins });
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(state.engine.retry).toHaveBeenCalledOnce();
      metadata.resolve(status);
      await expect(popup).resolves.toEqual({ success: true, status });
      expect(state.triggerErrorRetry).toHaveBeenCalledOnce();
    });

    it.each([
      { state: 'error', reason: 'service_unreachable', message: 'Open Ollama and Retry.' },
      { state: 'blocked', reason: 'origin_rejected', message: 'Allow the exact extension origin and Retry.' },
    ] as const)('retains the specific %s failure and waits for explicit Retry', async failure => {
      await initialize();
      const failed: LocalModelStatus = { ...failure, revision: 2 };
      state.engine.retry.mockResolvedValue(failed);
      state.engine.getStatus.mockResolvedValue(failed);
      onPermissionAdded({ origins });
      await vi.waitFor(() => expect(state.engine.retry).toHaveBeenCalledOnce());
      await expect(send({ type: 'getNativeModelStatus' }, popupSender)).resolves.toEqual({ status: failed });
      expect(state.triggerErrorRetry).not.toHaveBeenCalled();
      state.engine.retry.mockResolvedValue(status);
      await expect(send({ type: 'retryNativeModel' }, popupSender)).resolves.toEqual({ success: true, status });
      expect(state.engine.retry).toHaveBeenCalledTimes(2);
      expect(state.triggerErrorRetry).toHaveBeenCalledOnce();
    });

    it('keeps unresolved native work blocked after a grant without recovery or storage writes', async () => {
      await initialize();
      const recovery: LocalModelStatus = {
        state: 'recovery_required', message: 'Restart Ollama before resuming filtering.', reason: 'recovery_required', revision: 2,
      };
      state.engine.retry.mockResolvedValue(recovery);
      state.engine.getStatus.mockResolvedValue(recovery);
      onPermissionAdded({ origins });
      await vi.waitFor(() => expect(state.engine.retry).toHaveBeenCalledOnce());
      await expect(send({ type: 'getNativeModelStatus' }, popupSender)).resolves.toEqual({ status: recovery });
      expect(state.engine.recoverAfterOperatorRestart).not.toHaveBeenCalled();
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
      expect(state.triggerErrorRetry).not.toHaveBeenCalled();
      expect(state.enqueuePost).not.toHaveBeenCalled();
      expect(state.suggestAnnoyingReasons).not.toHaveBeenCalled();
    });

    it.each(['grant event', 'popup request'] as const)('lets revocation beat pending %s metadata completion', async source => {
      await initialize();
      const metadata = deferred<LocalModelStatus>();
      state.engine.retry.mockReturnValue(metadata.promise);
      let popup: Promise<unknown> | undefined;
      if (source === 'grant event') onPermissionAdded({ origins });
      else popup = send({ type: 'connectNativeModel' }, popupSender);
      await vi.waitFor(() => expect(state.engine.retry).toHaveBeenCalledOnce());
      state.engine.getStatus.mockResolvedValue(disconnected);
      onPermissionRemoved({ origins });
      expect(state.engine.preempt).toHaveBeenCalledOnce();
      metadata.resolve(status);
      if (popup) await expect(popup).resolves.toEqual({ success: false, status: disconnected });
      await expect(send({ type: 'getNativeModelStatus' }, popupSender)).resolves.toEqual({ status: disconnected });
      expect(state.triggerErrorRetry).not.toHaveBeenCalled();
    });

    it('skips a grant superseded by revocation while startup is deferred', async () => {
      const startup = deferred();
      state.migration.mockReturnValueOnce(startup.promise);
      await import('../../src/background/index');
      onPermissionAdded({ origins });
      onPermissionRemoved({ origins });
      state.engine.getStatus.mockResolvedValue(disconnected);
      expect(state.engine.retry).not.toHaveBeenCalled();
      expect(state.engine.preempt).not.toHaveBeenCalled();
      startup.resolve();
      await expect(send({ type: 'getNativeModelStatus' }, popupSender)).resolves.toEqual({ status: disconnected });
      expect(state.engine.preempt).toHaveBeenCalledOnce();
      expect(state.engine.retry).not.toHaveBeenCalled();
      expect(state.triggerErrorRetry).not.toHaveBeenCalled();
    });
  });

  it('permits recovery only for an exact popup confirmation request', async () => {
    await initialize();
    const recovery = { type: 'recoverNativeModel', operatorRestartConfirmed: true } as const;
    await expect(send(recovery)).resolves.toMatchObject({ success: false, error: expect.any(String) });
    await expect(send({ ...recovery, operatorRestartConfirmed: false } as unknown as ContentToBackgroundMessage, popupSender))
      .resolves.toMatchObject({ success: false, error: expect.any(String) });
    await expect(send(recovery, popupSender)).resolves.toEqual({ success: true, status });
    expect(state.engine.recoverAfterOperatorRestart).toHaveBeenCalledOnce();
    expect(state.engine.recoverAfterOperatorRestart).toHaveBeenCalledWith(true);
  });

  it.each([
    { ...contentSender, id: 'other-extension' },
    { ...contentSender, url: 'https://x.com.evil.example/home' },
    { ...contentSender, url: 'http://x.com/home' },
    { ...contentSender, frameId: 2 },
    { ...contentSender, url: 'https://example.com' },
  ])('rejects an untrusted native operation sender %#', async sender => {
    await initialize();
    await expect(send({ type: 'suggestAnnoyingReasons', post: 'synthetic post', siteId: 'twitter' }, sender))
      .resolves.toMatchObject({ reasons: [], error: expect.stringContaining('Untrusted') });
  });

  it('rejects endpoint/model overrides and content-script native control calls', async () => {
    await initialize();
    await expect(send({ type: 'suggestAnnoyingReasons', post: 'post', endpoint: 'https://external.example' } as unknown as ContentToBackgroundMessage))
      .resolves.toMatchObject({ reasons: [], error: expect.stringContaining('fixed') });
    await expect(send({ type: 'retryNativeModel' })).resolves.toMatchObject({ success: false });
    expect(state.engine.retry).not.toHaveBeenCalled();
  });

  it('cleans navigation/tab document queues without unloading native residency', async () => {
    await initialize();
    await send({ type: 'pageLoad' });
    onUpdated(1, { status: 'loading' });
    await send({ type: 'pageLoad' }, { ...contentSender, documentId: 'document-two' });
    onRemoved(1);
    expect(state.clearTabQueue).toHaveBeenCalledWith(1);
    expect(state.engine.retry).not.toHaveBeenCalled();
  });

  describe('same-document SPA completion', () => {
    const completeTab = { id: 1, status: 'complete' } as chrome.tabs.Tab;
    const evaluate = (post: string, sender: chrome.runtime.MessageSender = contentSender) => send({
      type: 'evaluatePost', evaluationId: post, post, postUrl: null, siteId: 'twitter',
    }, sender);

    async function registerFocusedPage(): Promise<void> {
      await initialize();
      vi.mocked(chrome.tabs.query).mockResolvedValue([completeTab]);
      await expect(send({ type: 'pageLoad' })).resolves.toEqual({ success: true });
      expect(state.setActiveTab).toHaveBeenLastCalledWith(1);
    }

    it('creates a fresh owner for surviving content and keeps captured evaluations and native fences retired', async () => {
      await registerFocusedPage();
      const cacheGate = deferred();
      const suggestionGate = deferred();
      state.loadCache.mockReturnValueOnce(cacheGate.promise);
      state.suggestAnnoyingReasons.mockImplementationOnce(async (_post, _site, _tab, request: { assertCurrent: () => void }) => {
        await suggestionGate.promise;
        request.assertCurrent();
        return ['obsolete suggestion'];
      });
      const oldEvaluation = evaluate('old evaluation');
      const oldSuggestion = send({ type: 'suggestAnnoyingReasons', post: 'old suggestion', siteId: 'twitter' });
      await vi.waitFor(() => {
        expect(state.loadCache).toHaveBeenCalledTimes(2);
        expect(state.suggestAnnoyingReasons).toHaveBeenCalledOnce();
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
      suggestionGate.resolve();
      await expect(oldEvaluation).resolves.toMatchObject({ retry: true, reasoning: expect.stringContaining('document') });
      await expect(oldSuggestion).resolves.toMatchObject({ reasons: [], error: expect.stringContaining('document') });
      await expect(evaluate('new SPA evaluation')).resolves.toMatchObject({ shouldHide: false, reasoning: 'new document queued' });
      await expect(send({ type: 'suggestAnnoyingReasons', post: 'new SPA suggestion', siteId: 'twitter' }))
        .resolves.toEqual({ reasons: [] });
      expect(state.captureInferenceRequest.mock.results[1].value.assertCurrent).not.toThrow();
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
      state.migration.mockReturnValueOnce(startupGate.promise);
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
      await expect(send({ type: 'getNativeModelStatus' }, popupSender)).resolves.toEqual({ status });
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chrome.tabs.get).not.toHaveBeenCalled();
    });

    it.each([
      ['ping', 'loading'], ['ping', 'removal'], ['ping', 'replacement'],
      ['tab status', 'loading'], ['tab status', 'removal'], ['tab status', 'replacement'],
      ['focused tab', 'loading'], ['focused tab', 'removal'], ['focused tab', 'replacement'],
    ] as const)('lets a newer %s / %s race beat recovery and active-tab scheduling', async (stage, event) => {
      await registerFocusedPage();
      await send({ type: 'suggestAnnoyingReasons', post: 'captured before navigation', siteId: 'twitter' });
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
        await send({ type: 'suggestAnnoyingReasons', post: 'captured during focus detection', siteId: 'twitter' });
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
      await expect(send({ type: 'suggestAnnoyingReasons', post: 'fresh owner suggestion', siteId: 'twitter' }))
        .resolves.toEqual({ reasons: [] });
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
      await expect(send({ type: 'suggestAnnoyingReasons', post: 'still current unfocused SPA', siteId: 'twitter' }))
        .resolves.toEqual({ reasons: [] });
      expect(state.captureInferenceRequest.mock.results[0].value.assertCurrent).not.toThrow();
    });
  });

  it('retires work and refreshes metadata-free status only for the fixed permission', async () => {
    await initialize();
    state.engine.preempt.mockClear();
    state.engine.syncAllStatuses.mockClear();
    onPermissionRemoved({ origins: ['https://unrelated.example/*'] });
    expect(state.engine.preempt).not.toHaveBeenCalled();
    expect(state.engine.syncAllStatuses).not.toHaveBeenCalled();
    onPermissionRemoved({ origins: ['http://127.0.0.1:11434/*'] });
    expect(state.engine.preempt).toHaveBeenCalledOnce();
    expect(state.engine.syncAllStatuses).toHaveBeenCalledOnce();
    onPermissionAdded({ origins: ['http://127.0.0.1:11434/*'] });
    await vi.waitFor(() => expect(state.engine.retry).toHaveBeenCalledOnce());
    expect(state.engine.syncAllStatuses).toHaveBeenCalledOnce();
  });

  it('ignores removed browser-model keys while preserving a disable verdict boundary', async () => {
    await initialize();
    onStorageChanged({ selectedModel: { oldValue: 'local:old' }, nativeCutoverSchemaVersion: { newValue: 1 } }, 'local');
    await Promise.resolve();
    expect(state.handleSettingsChange).not.toHaveBeenCalled();
    const changes = { enabled: { oldValue: true, newValue: false } };
    onStorageChanged(changes, 'local');
    await vi.waitFor(() => expect(state.handleSettingsChange).toHaveBeenCalledWith(changes));
  });
});
