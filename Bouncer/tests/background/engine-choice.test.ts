import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callLocalInference, LocalAvailabilityError, LocalEngine, localEngine,
} from '../../src/background/local-model';
import { BrowserModelError, type BrowserBackend, type BrowserProgress, type BrowserState, type LocalBackend } from '../../src/background/backends/types';
import type { ChatMessage, InferenceEngineId } from '../../src/types';
import {
  BROWSER_CLASSIFIER_FINGERPRINT, BROWSER_MODEL, PRIMARY_LOCAL_MODEL,
} from '../../src/shared/models';
import { NativeModelError } from '../../src/shared/ollama-contract';
import { inferenceQueue } from '../../src/background/inference-queue';
import { TEST_MESSAGES, TEST_READINESS } from './native-fixtures';

let data: Record<string, unknown>;
let native: LocalBackend;
let browser: BrowserBackend;
let state: BrowserState;
let engine: LocalEngine;
const engines: LocalEngine[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function storage(initial: Record<string, unknown> = {}) {
  data = structuredClone(initial);
  chrome.storage.local = {
    get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter(key => key in data).map(key => [key, structuredClone(data[key])]))),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)); }),
    remove: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }),
  } as unknown as chrome.storage.LocalStorageArea;
  chrome.permissions = { contains: vi.fn().mockResolvedValue(true) } as unknown as typeof chrome.permissions;
}

function makeBrowser(): BrowserBackend {
  return {
    getState: vi.fn(async () => ({ ...state })),
    download: vi.fn(async progress => {
      state.downloading = true;
      progress({ progress: 50, text: 'Download', receivedBytes: 100, totalBytes: 200 });
      state.cached = true;
      state.downloading = false;
    }),
    initialize: vi.fn(async () => { state.loaded = true; }),
    generate: vi.fn(async () => 'no'),
    countTokens: vi.fn(async text => Math.ceil(text.length / 3)),
    truncateText: vi.fn(async (text, max) => text.slice(0, max * 3)),
    interrupt: vi.fn(async () => undefined),
    unload: vi.fn(async () => { state.loaded = false; }),
    forceClose: vi.fn(async () => { state.loaded = false; state.downloading = false; state.initializing = false; }),
    deleteCache: vi.fn(async () => { state.cached = false; }),
  };
}

function makeEngine(injected = true): LocalEngine {
  const value = new LocalEngine(injected ? native : undefined, browser);
  engines.push(value);
  return value;
}

async function chooseBrowser(cached = false) {
  state.cached = cached;
  await engine.selectEngine('litertlm');
}

beforeEach(() => {
  vi.useRealTimers();
  storage();
  inferenceQueue.reset();
  state = { cached: false, loaded: false, downloading: false, initializing: false };
  native = {
    check: vi.fn(async () => TEST_READINESS),
    generate: vi.fn(async (_messages, _maxTokens, hooks) => {
      await hooks.beforeSubmit(TEST_READINESS);
      hooks.assertCanSubmit();
      await hooks.onTerminal();
      return 'no';
    }),
  };
  browser = makeBrowser();
  engine = makeEngine();
});

afterEach(async () => {
  for (const item of engines.splice(0)) item.teardown();
  await Promise.resolve();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('explicit dual engine preference', () => {
  it('keeps a fresh profile unselected with no native check, host, GPU or download', async () => {
    engine = makeEngine(false);
    await engine.syncAllStatuses();
    expect(engine.getSelection()).toEqual({ engine: null, revision: 0 });
    expect(engine.getSelectedModel()).toBeNull();
    expect(engine.getClassifierFingerprint()).toBeNull();
    expect(await engine.getStatus()).toMatchObject({ state: 'not_configured', engine: null, selectionRevision: 0 });
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toBeInstanceOf(LocalAvailabilityError);
    expect(native.check).not.toHaveBeenCalled();
    expect(browser.getState).not.toHaveBeenCalled();
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(browser.download).not.toHaveBeenCalled();
  });

  it('adopts verified startup selection without retiring the receipt epoch', async () => {
    data.engineSelection = { engine: 'litertlm', revision: 8 };
    const epoch = engine.operationEpoch;
    await engine.syncAllStatuses();
    expect(engine.operationEpoch).toBe(epoch);
    expect(engine.getSelection()).toEqual(data.engineSelection);
    expect(await engine.getStatus()).toMatchObject({ state: 'needs_download', engine: 'litertlm', selectionRevision: 8 });
    expect(native.check).not.toHaveBeenCalled();
    expect(browser.initialize).not.toHaveBeenCalled();
  });

  it('requires a choice after a malformed or explicit null migrated selection', async () => {
    data.engineChoiceSchemaVersion = 1;
    data.engineSelection = { engine: 'custom', revision: 0 };
    await engine.syncAllStatuses();
    expect(engine.getSelection()).toEqual({ engine: null, revision: 0 });
    data.engineSelection = { engine: null, revision: 4 };
    await engine.syncAllStatuses();
    expect(engine.getSelection()).toEqual({ engine: null, revision: 4 });
    expect(native.check).not.toHaveBeenCalled();
  });

  it('validates the enum before retirement and returns immutable preference copies', async () => {
    const epoch = engine.operationEpoch;
    await expect(engine.selectEngine('custom' as InferenceEngineId)).rejects.toMatchObject({ reason: 'model_identity_changed' });
    expect(engine.operationEpoch).toBe(epoch);
    const selection = engine.getSelection();
    selection.engine = 'litertlm';
    selection.revision = 999;
    expect(engine.getSelection()).toEqual({ engine: 'ollama', revision: 0 });
  });

  it('commits preference and verified readback before any setup and retains it after failure', async () => {
    let readback = false;
    vi.mocked(chrome.storage.local.get).mockImplementation(async keys => {
      const result = Object.fromEntries((keys as string[]).filter(key => key in data).map(key => [key, structuredClone(data[key])]));
      if (Array.isArray(keys) && keys.includes('engineSelection') && data.engineSelection) readback = true;
      return result;
    });
    vi.mocked(browser.download).mockImplementation(async () => {
      expect(readback).toBe(true);
      expect(data.engineSelection).toEqual({ engine: 'litertlm', revision: 1 });
      throw new Error('Synthetic transfer failed');
    });
    await chooseBrowser();
    expect(browser.download).not.toHaveBeenCalled();
    expect(browser.initialize).not.toHaveBeenCalled();
    await expect(engine.downloadBrowserModel()).rejects.toThrow('Synthetic transfer failed');
    expect(engine.getSelection()).toEqual({ engine: 'litertlm', revision: 1 });
    expect(await engine.getStatus()).toMatchObject({ state: 'error', engine: 'litertlm', selectionRevision: 1 });
    expect(native.check).not.toHaveBeenCalled();
  });

  it('serializes racing popup choices and retires at each request receipt', async () => {
    const epoch = engine.operationEpoch;
    const one = engine.selectEngine('litertlm');
    const two = engine.selectEngine('ollama');
    expect(engine.operationEpoch).toBe(epoch + 2);
    expect(engine.isSelectingEngine()).toBe(true);
    await Promise.all([one, two]);
    expect(data.engineSelection).toEqual({ engine: 'ollama', revision: 2 });
    expect(engine.getSelection()).toEqual(data.engineSelection);
    expect(engine.isSelectingEngine()).toBe(false);
    expect(await engine.getStatus()).toMatchObject({ engine: 'ollama', selectionRevision: 2 });
    expect(native.check).not.toHaveBeenCalled();
    expect(browser.initialize).not.toHaveBeenCalled();
  });

  it('fails closed after preference readback failure and permits a fresh verified choice', async () => {
    let corruptReadback = true;
    vi.mocked(chrome.storage.local.get).mockImplementation(async keys => {
      const result = Object.fromEntries((keys as string[]).filter(key => key in data).map(key => [key, structuredClone(data[key])]));
      if (corruptReadback && (keys as string[]).includes('engineSelection') && data.engineSelection) result.engineSelection = { engine: 'ollama', revision: 0 };
      return result;
    });
    await expect(engine.selectEngine('litertlm')).rejects.toMatchObject({ reason: 'storage_failed' });
    expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'storage_failed' });
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'inference_preempted' });
    expect(native.check).not.toHaveBeenCalled();
    expect(browser.initialize).not.toHaveBeenCalled();
    corruptReadback = false;
    await engine.selectEngine('litertlm');
    expect(engine.getSelection()).toEqual({ engine: 'litertlm', revision: 2 });
  });

  it('fails closed on an external preference write until startup reconciliation', async () => {
    await chooseBrowser(true);
    data.engineSelection = { engine: 'ollama', revision: 2 };
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'inference_preempted' });
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
  });

  it('switches both directions while retaining downloaded weights and avoiding inactive probes', async () => {
    await chooseBrowser(true);
    expect(engine.getSelectedModel()).toEqual(BROWSER_MODEL);
    await engine.generate(TEST_MESSAGES, 64);
    await engine.selectEngine('ollama');
    expect(engine.getSelectedModel()).toEqual(PRIMARY_LOCAL_MODEL);
    expect(state.cached).toBe(true);
    expect(state.loaded).toBe(false);
    expect(browser.unload).toHaveBeenCalledTimes(1);
    expect(browser.deleteCache).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
    await engine.selectEngine('litertlm');
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(await engine.getStatus()).toMatchObject({ state: 'ready', engine: 'litertlm', selectionRevision: 3 });
  });
});

describe('native safety across engine choice', () => {
  it('persists browser selection while known native HTTP drains before new browser work', async () => {
    const terminal = deferred<void>();
    const started = deferred<void>();
    vi.mocked(native.generate).mockImplementation(async (_messages, _max, hooks) => {
      await hooks.beforeSubmit(TEST_READINESS);
      hooks.assertCanSubmit();
      started.resolve();
      await terminal.promise;
      await hooks.onTerminal();
      return 'yes';
    });
    state.cached = true;
    const old = engine.generate(TEST_MESSAGES, 64);
    const rejection = expect(old).rejects.toMatchObject({ reason: 'inference_preempted' });
    await started.promise;
    const switchToBrowser = engine.selectEngine('litertlm');
    await vi.waitFor(() => expect(data.engineSelection).toEqual({ engine: 'litertlm', revision: 1 }));
    expect(data.nativeOperationFence).toBeDefined();
    expect(await engine.getStatus()).toMatchObject({ state: 'switching', engine: 'litertlm' });
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'inference_preempted' });
    expect(browser.generate).not.toHaveBeenCalled();
    terminal.resolve();
    await rejection;
    await switchToBrowser;
    expect(data.nativeOperationFence).toBeUndefined();
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
    expect(browser.generate).toHaveBeenCalledTimes(1);
  });

  it.each([null, false, { startedAt: 0 }, { operationId: '' }, { operationId: 'old-worker' }])(
    'blocks either engine for unknown/malformed native fence %j before permission', async fence => {
      data.nativeOperationFence = fence;
      vi.mocked(chrome.permissions.contains).mockResolvedValue(false);
      await chooseBrowser(true);
      expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required', engine: 'litertlm' });
      await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'recovery_required' });
      expect(data.nativeOperationFence).toEqual(fence);
      expect(native.check).not.toHaveBeenCalled();
      expect(browser.initialize).not.toHaveBeenCalled();
      expect(chrome.permissions.contains).not.toHaveBeenCalled();
    },
  );

  it('preserves a native fence byte-for-byte through choices, Retry and browser cache work', async () => {
    const fence = { unusual: ['retain', 7], operationId: 'uncertain' };
    data.nativeOperationFence = structuredClone(fence);
    await chooseBrowser();
    await engine.retry();
    await engine.downloadBrowserModel();
    await engine.deleteBrowserModel();
    await engine.selectEngine('ollama');
    expect(data.nativeOperationFence).toEqual(fence);
    expect(native.generate).not.toHaveBeenCalled();
    expect(browser.generate).not.toHaveBeenCalled();
  });

  it('does not recognize a malformed marker as owned solely because its operation id matches', async () => {
    vi.mocked(native.generate).mockImplementation(async (_messages, _max, hooks) => {
      await hooks.beforeSubmit(TEST_READINESS); hooks.assertCanSubmit();
      const marker = data.nativeOperationFence as { operationId: string };
      data.nativeOperationFence = { operationId: marker.operationId };
      expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required' });
      await hooks.onTerminal();
      return 'no';
    });
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(data.nativeOperationFence).toEqual({ operationId: expect.any(String) });
    await chooseBrowser(true);
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(browser.initialize).not.toHaveBeenCalled();
  });

  it('recovers native uncertainty with its driver while retaining browser choice and readiness', async () => {
    data.nativeOperationFence = { operationId: 'restart-needed', malformed: true };
    await chooseBrowser(true);
    const selection = engine.getSelection();
    expect(await engine.recoverAfterOperatorRestart(true)).toMatchObject({ state: 'ready', engine: 'litertlm', selectionRevision: 1 });
    expect(engine.getSelection()).toEqual(selection);
    expect(data.engineSelection).toEqual(selection);
    expect(data.nativeOperationFence).toBeUndefined();
    expect(native.check).toHaveBeenCalledTimes(1);
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(browser.generate).not.toHaveBeenCalled();
  });

  it('suppresses a late native readiness publication after browser choice', async () => {
    const checked = deferred<typeof TEST_READINESS>();
    const started = deferred<void>();
    vi.mocked(native.check).mockImplementation(async () => { started.resolve(); return checked.promise; });
    const old = engine.generate(TEST_MESSAGES, 64);
    const rejection = expect(old).rejects.toMatchObject({ reason: 'inference_preempted' });
    await started.promise;
    const selecting = engine.selectEngine('litertlm');
    await vi.waitFor(() => expect(data.engineSelection).toEqual({ engine: 'litertlm', revision: 1 }));
    checked.resolve(TEST_READINESS);
    await rejection;
    await selecting;
    expect(await engine.getStatus()).toMatchObject({ state: 'needs_download', engine: 'litertlm' });
    expect(native.generate).not.toHaveBeenCalled();
    expect(data.localModelStatus).not.toMatchObject({ state: 'ready' });
  });
});

describe('owned browser lifecycle', () => {
  it('cancels an inherited cache-only download without a worker-owned setup promise', async () => {
    vi.useFakeTimers();
    data.engineSelection = { engine: 'litertlm', revision: 3 };
    state.downloading = true;
    state.progress = 0.25;
    state.receivedBytes = 25;
    state.totalBytes = 100;
    engine = makeEngine();
    await engine.syncAllStatuses();
    expect(await engine.getStatus()).toMatchObject({ state: 'downloading', progress: 0.25 });
    expect(await engine.cancelBrowserDownload()).toMatchObject({ state: 'needs_download', engine: 'litertlm', selectionRevision: 3 });
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(browser.download).not.toHaveBeenCalled();
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(state.downloading).toBe(false);
    vi.mocked(chrome.storage.local.get).mockClear();
    vi.mocked(browser.getState).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(browser.getState).not.toHaveBeenCalled();
  });

  it('switches to Ollama by closing inherited browser download work even without a controller', async () => {
    data.engineSelection = { engine: 'litertlm', revision: 3 };
    state.downloading = true;
    engine = makeEngine();
    await engine.syncAllStatuses();
    expect(await engine.selectEngine('ollama')).toMatchObject({ engine: 'ollama', selectionRevision: 4 });
    expect(state.downloading).toBe(false);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(browser.download).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
  });

  it('discovers and cancels an inherited initializer, retaining bytes and requiring Retry', async () => {
    await chooseBrowser(true);
    state.initializing = true;
    expect(await engine.getStatus()).toMatchObject({ state: 'loading' });
    expect(await engine.cancelBrowserDownload()).toMatchObject({ state: 'paused', reason: 'browser_cancelled' });
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.initializing).toBe(false);
    expect(state.cached).toBe(true);
    await expect(engine.ensureLoaded()).rejects.toMatchObject({ reason: 'browser_cancelled' });
    expect(browser.initialize).not.toHaveBeenCalled();
  });

  it.each(['loaded', 'initializing', 'downloading'] as const)(
    'closes inherited browser %s work on persisted Ollama startup without native metadata or deletion', async physical => {
      data.engineSelection = { engine: 'ollama', revision: 7 };
      data.nativeOperationFence = { operationId: 'retain-uncertainty', malformed: true };
      state.cached = true;
      state[physical] = true;
      engine = makeEngine();
      await engine.syncAllStatuses();
      expect(browser.forceClose).toHaveBeenCalledTimes(1);
      expect(state.loaded).toBe(false);
      expect(state.initializing).toBe(false);
      expect(state.downloading).toBe(false);
      expect(state.cached).toBe(true);
      expect(data.engineSelection).toEqual({ engine: 'ollama', revision: 7 });
      expect(data.nativeOperationFence).toEqual({ operationId: 'retain-uncertainty', malformed: true });
      expect(browser.initialize).not.toHaveBeenCalled();
      expect(browser.download).not.toHaveBeenCalled();
      expect(browser.deleteCache).not.toHaveBeenCalled();
      expect(native.check).not.toHaveBeenCalled();
    },
  );

  it.each(['loaded', 'initializing'] as const)(
    'closes orphan browser %s work after worker recreation and lazily retains valid bytes', async physical => {
      data.engineSelection = { engine: 'litertlm', revision: 7 };
      state.cached = true;
      state[physical] = true;
      engine = makeEngine();
      await engine.syncAllStatuses();
      expect(browser.forceClose).toHaveBeenCalledTimes(1);
      expect(await engine.getStatus()).toMatchObject({ state: 'ready', engine: 'litertlm', selectionRevision: 7 });
      expect(state.loaded).toBe(false);
      expect(state.initializing).toBe(false);
      expect(state.cached).toBe(true);
      expect(browser.initialize).not.toHaveBeenCalled();
      expect(browser.download).not.toHaveBeenCalled();
    },
  );

  it('closes a newly discovered orphan GPU before a real browser lease can replace it', async () => {
    await chooseBrowser(true);
    state.loaded = true;
    expect(await engine.getStatus()).toMatchObject({ state: 'ready' });
    vi.mocked(browser.initialize).mockImplementation(async () => {
      expect(browser.forceClose).toHaveBeenCalledTimes(1);
      expect(state.loaded).toBe(false);
      state.loaded = true;
    });
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(browser.generate).toHaveBeenCalledTimes(1);
  });

  it('keeps inherited download progress/completion coherent and stops its read-only keepalive after settlement', async () => {
    vi.useFakeTimers();
    data.engineSelection = { engine: 'litertlm', revision: 7 };
    state.downloading = true;
    state.progress = 0.25;
    state.receivedBytes = 25;
    state.totalBytes = 100;
    engine = makeEngine();
    await engine.syncAllStatuses();
    expect(data.localModelStatus).toMatchObject({ state: 'downloading', progress: 0.25 });
    state.progress = 0.5;
    state.receivedBytes = 50;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(data.localModelStatus).toMatchObject({ state: 'downloading', progress: 0.5, receivedBytes: 50, totalBytes: 100 });
    expect(browser.forceClose).not.toHaveBeenCalled();
    state.downloading = false;
    state.cached = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(data.localModelStatus).toMatchObject({ state: 'ready', engine: 'litertlm', selectionRevision: 7 });
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.cached).toBe(true);
    vi.mocked(chrome.storage.local.get).mockClear();
    vi.mocked(browser.getState).mockClear();
    vi.mocked(chrome.storage.local.set).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(browser.getState).not.toHaveBeenCalled();
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
  });

  it('settles inherited download completion observed by popup before its next keepalive tick', async () => {
    vi.useFakeTimers();
    data.engineSelection = { engine: 'litertlm', revision: 7 };
    state.downloading = true;
    engine = makeEngine();
    await engine.syncAllStatuses();
    state.downloading = false;
    state.cached = true;
    expect(await engine.getStatus()).toMatchObject({ state: 'ready' });
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.cached).toBe(true);
    vi.mocked(browser.getState).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(browser.getState).not.toHaveBeenCalled();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('closes failed initialization before releasing setup ownership or accepting a late GPU engine', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const closeStarted = deferred<void>();
    const closed = deferred<void>();
    vi.mocked(browser.initialize).mockImplementation(async () => { state.initializing = true; throw new BrowserModelError('browser_failed', 'Synthetic init RPC timeout'); });
    vi.mocked(browser.forceClose).mockImplementation(async () => {
      closeStarted.resolve(); await closed.promise; state.initializing = false; state.loaded = false;
    });
    const generation = engine.generate(TEST_MESSAGES, 64);
    const rejected = expect(generation).rejects.toThrow('Synthetic init RPC timeout');
    await closeStarted.promise;
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(await engine.retry()).toMatchObject({ state: 'loading' });
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    // Simulate non-abortable Engine.create finishing while host close is pending.
    state.loaded = true;
    closed.resolve();
    await rejected;
    expect(state.loaded).toBe(false);
    expect(state.initializing).toBe(false);
    expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_failed' });
    expect(browser.generate).not.toHaveBeenCalled();
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('quarantines failed initialization when observed physical work cannot be proved closed', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const selected = structuredClone(data.engineSelection);
    const started = deferred<void>();
    const initialized = deferred<void>();
    vi.mocked(browser.initialize).mockImplementation(async () => {
      state.initializing = true;
      started.resolve();
      await initialized.promise;
    });
    const generation = engine.generate(TEST_MESSAGES, 64);
    const failed = expect(generation).rejects.toThrow('Synthetic owned close rejection');
    await started.promise;
    expect(await engine.getStatus()).toMatchObject({ state: 'loading' });
    vi.mocked(browser.forceClose).mockRejectedValue(new Error('Synthetic owned close rejection'));
    initialized.reject(new BrowserModelError('webgpu_unavailable', 'Synthetic actual initializer failure'));
    await failed;
    expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed', engine: 'litertlm' });
    expect(state.initializing).toBe(true);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    const fence = { operationId: 'preserved-initialization-cleanup-fence', malformed: true };
    data.nativeOperationFence = structuredClone(fence);
    expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required' });
    expect(data.browserModelStatus).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed' });
    vi.mocked(chrome.storage.local.get).mockClear();
    vi.mocked(browser.getState).mockClear();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(browser.getState).not.toHaveBeenCalled();
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(browser.generate).not.toHaveBeenCalled();
    expect(browser.download).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
    expect(native.generate).not.toHaveBeenCalled();
    expect(data.engineSelection).toEqual(selected);
    expect(data.nativeOperationFence).toEqual(fence);
    vi.mocked(browser.forceClose).mockImplementation(async () => { state.initializing = false; });
  });

  it('does not let a deferred popup snapshot undo completed initialization or its idle release', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const initialized = deferred<void>();
    const started = deferred<void>();
    vi.mocked(browser.initialize).mockImplementation(async () => {
      state.initializing = true; started.resolve(); await initialized.promise;
      state.initializing = false; state.loaded = true;
    });
    const operation = engine.generate(TEST_MESSAGES, 64);
    await started.promise;
    const staleReply = deferred<BrowserState>();
    const snapshotStarted = deferred<void>();
    const captured = { ...state };
    vi.mocked(browser.getState).mockImplementationOnce(async () => { snapshotStarted.resolve(); return staleReply.promise; });
    const snapshot = engine.getStatus();
    await snapshotStarted.promise;
    initialized.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.loaded).toBe(true);
    staleReply.resolve(captured);
    await snapshot;
    expect(await operation).toBe('no');
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(browser.generate).toHaveBeenCalledTimes(1);
    expect(browser.forceClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(browser.unload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.unload).toHaveBeenCalledTimes(1);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.loaded).toBe(false);
    expect(state.cached).toBe(true);
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
  });

  it('retires a rejected popup state read spanning successful initialization without requiring Retry', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const initialized = deferred<void>();
    const started = deferred<void>();
    vi.mocked(browser.initialize).mockImplementation(async () => {
      state.initializing = true; started.resolve(); await initialized.promise;
      state.initializing = false; state.loaded = true;
    });
    const first = engine.generate(TEST_MESSAGES, 64);
    await started.promise;
    const staleReply = deferred<BrowserState>();
    const snapshotStarted = deferred<void>();
    vi.mocked(browser.getState).mockImplementationOnce(async () => { snapshotStarted.resolve(); return staleReply.promise; });
    const snapshot = engine.getStatus();
    await snapshotStarted.promise;
    initialized.resolve();
    await vi.advanceTimersByTimeAsync(0);
    staleReply.reject(new BrowserModelError('browser_failed', 'Obsolete host-state failure'));
    expect(await snapshot).not.toMatchObject({ state: 'error' });
    expect(await first).toBe('no');
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(browser.generate).toHaveBeenCalledTimes(2);
    expect(data.browserModelStatus).not.toMatchObject({ state: 'error' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.unload).toHaveBeenCalledTimes(1);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.cached).toBe(true);
  });

  it('retires a rejected old-engine snapshot during selection without poisoning later Browser use', async () => {
    await chooseBrowser(true);
    const staleReply = deferred<BrowserState>();
    const snapshotStarted = deferred<void>();
    vi.mocked(browser.getState).mockImplementationOnce(async () => { snapshotStarted.resolve(); return staleReply.promise; });
    const snapshot = engine.getStatus();
    await snapshotStarted.promise;
    const switching = engine.selectEngine('ollama');
    await vi.waitFor(() => expect(engine.getSelection()).toEqual({ engine: 'ollama', revision: 2 }));
    staleReply.reject(new BrowserModelError('browser_failed', 'Obsolete Browser failure'));
    expect(await snapshot).toMatchObject({ state: 'switching', engine: 'ollama', selectionRevision: 2 });
    await switching;
    expect(data.browserModelStatus).not.toMatchObject({ state: 'error' });
    await engine.selectEngine('litertlm');
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
    expect(native.check).not.toHaveBeenCalled();
  });

  it('retires a rejected state read spanning completed owned cleanup without a new Retry fence', async () => {
    await chooseBrowser(true);
    await engine.generate(TEST_MESSAGES, 64);
    const staleReply = deferred<BrowserState>();
    const snapshotStarted = deferred<void>();
    vi.mocked(browser.getState).mockImplementationOnce(async () => { snapshotStarted.resolve(); return staleReply.promise; });
    const snapshot = engine.getStatus();
    await snapshotStarted.promise;
    const released = engine.unloadBrowserModel();
    await vi.waitFor(() => expect(browser.forceClose).toHaveBeenCalledTimes(1));
    staleReply.reject(new BrowserModelError('browser_failed', 'Closed host cannot answer'));
    expect(await snapshot).not.toMatchObject({ state: 'error' });
    expect(await released).toMatchObject({ state: 'ready' });
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
    expect(browser.initialize).toHaveBeenCalledTimes(2);
    expect(browser.generate).toHaveBeenCalledTimes(2);
    expect(data.browserModelStatus).not.toMatchObject({ state: 'error' });
  });

  it('does not revive residency from a deferred popup snapshot spanning failed-init cleanup', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const initializing = deferred<void>();
    const started = deferred<void>();
    vi.mocked(browser.initialize).mockImplementation(async () => {
      state.initializing = true; started.resolve(); await initializing.promise;
      throw new BrowserModelError('browser_failed', 'Synthetic late initialization failure');
    });
    const operation = engine.generate(TEST_MESSAGES, 64);
    const rejection = expect(operation).rejects.toThrow('Synthetic late initialization failure');
    await started.promise;
    const staleReply = deferred<BrowserState>();
    const snapshotStarted = deferred<void>();
    vi.mocked(browser.getState).mockImplementationOnce(async () => { snapshotStarted.resolve(); return staleReply.promise; });
    const snapshot = engine.getStatus();
    await snapshotStarted.promise;
    initializing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.loaded).toBe(false);
    expect(state.initializing).toBe(false);
    staleReply.resolve({ cached: true, loaded: true, initializing: false, downloading: false });
    await snapshot;
    await rejection;
    expect(browser.generate).not.toHaveBeenCalled();
    expect(data.browserModelStatus).toMatchObject({ state: 'error', reason: 'browser_failed' });
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(browser.unload).not.toHaveBeenCalled();
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.cached).toBe(true);
  });

  it('awaits an idle unload barrier before the next browser lease lazily reloads', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    await engine.generate(TEST_MESSAGES, 64);
    const unloading = deferred<void>();
    const release = deferred<void>();
    vi.mocked(browser.unload).mockImplementation(async () => { unloading.resolve(); await release.promise; state.loaded = false; });
    await vi.advanceTimersByTimeAsync(60_000);
    await unloading.promise;
    const next = engine.generate(TEST_MESSAGES, 64);
    await Promise.resolve(); await Promise.resolve();
    expect(browser.generate).toHaveBeenCalledTimes(1);
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(data.browserModelStatus).not.toMatchObject({ state: 'error' });
    release.resolve();
    expect(await next).toBe('no');
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(browser.initialize).toHaveBeenCalledTimes(2);
    expect(browser.generate).toHaveBeenCalledTimes(2);
    expect(await engine.getStatus()).toMatchObject({ state: 'ready', engine: 'litertlm', selectionRevision: 1 });
  });

  it('reports missing cache as expected availability without fetch, GPU or retry poisoning', async () => {
    await chooseBrowser();
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'needs_download' });
    expect(await engine.retry()).toMatchObject({ state: 'needs_download' });
    expect(browser.download).not.toHaveBeenCalled();
    expect(browser.initialize).not.toHaveBeenCalled();
    await engine.downloadBrowserModel();
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
    expect(browser.download).toHaveBeenCalledTimes(1);
  });

  it('downloads cache only and popup snapshots/retry never prewarm downloaded bytes', async () => {
    await chooseBrowser();
    expect(await engine.downloadBrowserModel()).toMatchObject({ state: 'ready', engine: 'litertlm', selectionRevision: 1 });
    await engine.getStatus();
    await engine.retry();
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(browser.generate).not.toHaveBeenCalled();
    expect(state.loaded).toBe(false);
    expect(data.engineSelection).toEqual({ engine: 'litertlm', revision: 1 });
  });

  it('reconciles stale download/loading percentages after worker restart without host creation', async () => {
    data.engineSelection = { engine: 'litertlm', revision: 4 };
    data.browserModelStatus = { state: 'downloading', progress: 77, message: 'Old download', revision: 8 };
    await engine.syncAllStatuses();
    expect(await engine.getStatus()).toMatchObject({ state: 'needs_download', engine: 'litertlm', selectionRevision: 4 });
    expect(data.localModelStatus).not.toHaveProperty('progress');
    state.cached = true;
    data.browserModelStatus = { state: 'loading', progress: 100, message: 'Old load', revision: 9 };
    expect(await engine.getStatus()).toMatchObject({ state: 'ready' });
    expect(browser.initialize).not.toHaveBeenCalled();
  });

  it('persists a browser error requiring explicit Retry across worker recreation', async () => {
    await chooseBrowser(true);
    vi.mocked(browser.generate).mockRejectedValueOnce(new Error('Synthetic GPU failure'));
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toThrow('Synthetic GPU failure');
    expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_failed' });
    engine.teardown();
    engine = makeEngine();
    await engine.syncAllStatuses();
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'response_invalid' });
    expect(browser.generate).toHaveBeenCalledTimes(1);
    expect(await engine.retry()).toMatchObject({ state: 'ready' });
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
    expect(native.check).not.toHaveBeenCalled();
  });

  it('closes unresponsive owned browser state only on explicit Retry and retains cache', async () => {
    await chooseBrowser(true);
    vi.mocked(browser.getState).mockRejectedValueOnce(new Error('Synthetic blocked host'));
    expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_failed' });
    expect(browser.forceClose).not.toHaveBeenCalled();
    expect(await engine.retry()).toMatchObject({ state: 'ready' });
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.cached).toBe(true);
    expect(browser.initialize).not.toHaveBeenCalled();
  });

  it('quarantines rejected idle cleanup at 60 seconds without heartbeat or retry loops through 180 seconds', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    await engine.generate(TEST_MESSAGES, 64);
    const selection = structuredClone(data.engineSelection);
    vi.mocked(browser.unload).mockRejectedValue(new Error('Synthetic unload rejection'));
    vi.mocked(browser.forceClose).mockRejectedValue(new Error('Synthetic owned close rejection'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed', engine: 'litertlm' });
    expect(state.loaded).toBe(true);
    expect(state.cached).toBe(true);
    expect(browser.unload).toHaveBeenCalledTimes(1);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'browser_failed' });
    const fence = { operationId: 'preserved-native-uncertainty', malformed: true };
    data.nativeOperationFence = structuredClone(fence);
    expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required' });
    expect(data.browserModelStatus).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed' });
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(browser.unload).toHaveBeenCalledTimes(1);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(browser.generate).toHaveBeenCalledTimes(1);
    expect(browser.download).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
    expect(native.generate).not.toHaveBeenCalled();
    expect(data.engineSelection).toEqual(selection);
    expect(data.nativeOperationFence).toEqual(fence);
    vi.mocked(browser.forceClose).mockImplementation(async () => { state.loaded = false; });
  });

  it.each(['litertlm', 'ollama'] as const)(
    'keeps %s worker startup usable but blocked after repeated inherited owned-close rejection', async selected => {
      vi.useFakeTimers();
      const nativeStatus = { state: 'ready', message: 'Native metadata remains ready', engine: 'ollama', selectionRevision: 7, revision: 12 };
      data.engineSelection = { engine: selected, revision: 7 };
      data.nativeModelStatus = structuredClone(nativeStatus);
      state.cached = true; state.loaded = true;
      vi.mocked(browser.forceClose).mockRejectedValue(new Error('Synthetic inherited close rejection'));
      engine = makeEngine();
      await expect(engine.syncAllStatuses()).resolves.toBeUndefined();
      expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed', engine: selected, selectionRevision: 7 });
      expect(data.browserModelStatus).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed', engine: 'litertlm' });
      expect(data.nativeModelStatus).toEqual(nativeStatus);
      expect(data.engineSelection).toEqual({ engine: selected, revision: 7 });
      expect(state.loaded).toBe(true);
      await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'browser_failed' });
      vi.mocked(chrome.storage.local.get).mockClear();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(chrome.storage.local.get).not.toHaveBeenCalled();
      expect(browser.forceClose).toHaveBeenCalledTimes(2);
      expect(browser.initialize).not.toHaveBeenCalled();
      expect(browser.download).not.toHaveBeenCalled();
      expect(browser.generate).not.toHaveBeenCalled();
      expect(native.check).not.toHaveBeenCalled();
      expect(native.generate).not.toHaveBeenCalled();
      vi.mocked(browser.forceClose).mockImplementation(async () => { state.loaded = false; });
    },
  );

  it('recovers failed owned cleanup only through successful explicit Retry and returns lazy cached readiness', async () => {
    vi.useFakeTimers();
    data.engineSelection = { engine: 'litertlm', revision: 4 };
    state.cached = true; state.loaded = true;
    vi.mocked(browser.forceClose).mockRejectedValue(new Error('Synthetic close rejection'));
    engine = makeEngine();
    await expect(engine.syncAllStatuses()).resolves.toBeUndefined();
    expect(await engine.retry()).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed' });
    expect(state.loaded).toBe(true);
    expect(browser.forceClose).toHaveBeenCalledTimes(3);
    vi.mocked(browser.forceClose).mockImplementation(async () => { state.loaded = false; });
    expect(await engine.retry()).toMatchObject({ state: 'ready', engine: 'litertlm', selectionRevision: 4 });
    expect(browser.forceClose).toHaveBeenCalledTimes(4);
    expect(state.cached).toBe(true);
    expect(state.loaded).toBe(false);
    expect(data.engineSelection).toEqual({ engine: 'litertlm', revision: 4 });
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(browser.download).not.toHaveBeenCalled();
    expect(browser.generate).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
    expect(native.generate).not.toHaveBeenCalled();
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('keeps a malformed-output Retry fence eligible for its first ordinary idle cleanup', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    await engine.generate(TEST_MESSAGES, 64);
    await engine.reportFailure(new NativeModelError('response_invalid', 'Synthetic malformed verdict', 'terminal'));
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'response_invalid' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.unload).toHaveBeenCalledTimes(1);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.loaded).toBe(false);
    expect(state.cached).toBe(true);
    expect(data.browserModelStatus).toMatchObject({ state: 'error', reason: 'response_invalid' });
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(browser.generate).toHaveBeenCalledTimes(1);
    expect(browser.download).not.toHaveBeenCalled();
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('quarantines a rejected inherited-download state read and owned close without repeating its poll', async () => {
    vi.useFakeTimers();
    data.engineSelection = { engine: 'litertlm', revision: 9 };
    state.downloading = true;
    engine = makeEngine();
    await engine.syncAllStatuses();
    vi.mocked(browser.getState).mockRejectedValueOnce(new Error('Synthetic inherited download state rejection'));
    vi.mocked(browser.forceClose).mockRejectedValue(new Error('Synthetic inherited download close rejection'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed', selectionRevision: 9 });
    expect(state.downloading).toBe(true);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    const fence = { operationId: 'preserved-inherited-download-fence', malformed: true };
    data.nativeOperationFence = structuredClone(fence);
    expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required' });
    vi.mocked(chrome.storage.local.get).mockClear();
    vi.mocked(browser.getState).mockClear();
    await vi.advanceTimersByTimeAsync(175_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(browser.getState).not.toHaveBeenCalled();
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(browser.download).not.toHaveBeenCalled();
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(browser.generate).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
    expect(native.generate).not.toHaveBeenCalled();
    expect(data.engineSelection).toEqual({ engine: 'litertlm', revision: 9 });
    expect(data.nativeOperationFence).toEqual(fence);
    vi.mocked(browser.forceClose).mockImplementation(async () => { state.downloading = false; });
  });

  it.each(['litertlm', 'ollama'] as const)(
    'restores persisted cleanup quarantine with %s selected instead of resuming an inherited download', async selected => {
      vi.useFakeTimers();
      const nativeStatus = { state: 'ready', message: 'Native metadata remains ready', engine: 'ollama', selectionRevision: 7, revision: 12 };
      data.engineSelection = { engine: selected, revision: 7 };
      data.nativeModelStatus = structuredClone(nativeStatus);
      data.browserModelStatus = { state: 'error', reason: 'browser_cleanup_failed', message: 'Cleanup failed', engine: 'litertlm', selectionRevision: 7, revision: 4 };
      state.downloading = true; state.progress = 0.5;
      engine = makeEngine();
      await engine.syncAllStatuses();
      expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed', engine: selected, selectionRevision: 7 });
      expect(browser.forceClose).not.toHaveBeenCalled();
      expect(data.nativeModelStatus).toEqual(nativeStatus);
      vi.mocked(chrome.storage.local.get).mockClear();
      vi.mocked(browser.getState).mockClear();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(chrome.storage.local.get).not.toHaveBeenCalled();
      expect(browser.getState).not.toHaveBeenCalled();
      state.downloading = false; state.cached = true;
      expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed' });
      expect(data.browserModelStatus).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed' });
      expect(browser.forceClose).not.toHaveBeenCalled();
      expect(await engine.retry()).toMatchObject({ state: 'ready', engine: selected });
      expect(browser.forceClose).toHaveBeenCalledTimes(1);
      expect(data.browserModelStatus).toMatchObject({ state: 'ready', engine: 'litertlm' });
      expect(data.engineSelection).toEqual({ engine: selected, revision: 7 });
      expect(browser.download).not.toHaveBeenCalled();
      expect(browser.initialize).not.toHaveBeenCalled();
      expect(browser.generate).not.toHaveBeenCalled();
      expect(native.check).toHaveBeenCalledTimes(selected === 'ollama' ? 1 : 0);
      expect(native.generate).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'retires only proved cleanup failure after native Retry before lazy Browser selection (cached=%s)', async cached => {
      data.engineSelection = { engine: 'ollama', revision: 6 };
      state.cached = cached; state.loaded = true;
      vi.mocked(browser.forceClose).mockRejectedValue(new Error('Synthetic owned close rejection'));
      engine = makeEngine();
      await engine.syncAllStatuses();
      expect(await engine.getStatus()).toMatchObject({ reason: 'browser_cleanup_failed', engine: 'ollama' });
      vi.mocked(browser.forceClose).mockImplementation(async () => { state.loaded = false; });
      expect(await engine.retry()).toMatchObject({ state: 'ready', engine: 'ollama' });
      expect(data.browserModelStatus).toMatchObject({ state: cached ? 'ready' : 'needs_download', engine: 'litertlm' });
      expect(data.engineSelection).toEqual({ engine: 'ollama', revision: 6 });
      expect(browser.initialize).not.toHaveBeenCalled();
      expect(browser.download).not.toHaveBeenCalled();
      expect(browser.generate).not.toHaveBeenCalled();
      expect(native.generate).not.toHaveBeenCalled();
      expect(await engine.selectEngine('litertlm')).toMatchObject({ state: cached ? 'ready' : 'needs_download', selectionRevision: 7 });
      expect(browser.initialize).not.toHaveBeenCalled();
      if (cached) {
        expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
        expect(browser.initialize).toHaveBeenCalledTimes(1);
        expect(browser.generate).toHaveBeenCalledTimes(1);
      } else {
        await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'needs_download' });
        expect(browser.initialize).not.toHaveBeenCalled();
      }
      expect(browser.download).not.toHaveBeenCalled();
      expect(native.check).toHaveBeenCalledTimes(1);
      expect(native.generate).not.toHaveBeenCalled();
    },
  );

  it.each(['response_invalid', 'webgpu_unavailable'] as const)(
    'preserves unrelated Browser %s Retry ownership across owned cleanup and native Retry', async reason => {
      const browserStatus = { state: reason === 'webgpu_unavailable' ? 'blocked' : 'error', reason, message: 'Synthetic unrelated Browser fault', engine: 'litertlm', selectionRevision: 3, revision: 5 };
      data.engineSelection = { engine: 'ollama', revision: 3 };
      data.browserModelStatus = structuredClone(browserStatus);
      state.cached = true; state.loaded = true;
      engine = makeEngine();
      await engine.syncAllStatuses();
      expect(data.browserModelStatus).toEqual(browserStatus);
      expect(await engine.retry()).toMatchObject({ state: 'ready', engine: 'ollama' });
      expect(data.browserModelStatus).toEqual(browserStatus);
      expect(await engine.selectEngine('litertlm')).toMatchObject({ state: browserStatus.state, reason });
      await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'response_invalid' });
      expect(browser.initialize).not.toHaveBeenCalled();
      expect(browser.download).not.toHaveBeenCalled();
      expect(browser.generate).not.toHaveBeenCalled();
      expect(native.generate).not.toHaveBeenCalled();
    },
  );

  it('attributes delayed cleanup failure to the current stop selection without overwriting Ollama readiness', async () => {
    vi.useFakeTimers();
    const nativeStatus = { state: 'ready', message: 'Native metadata remains ready', engine: 'ollama', selectionRevision: 0, revision: 6 };
    data.nativeModelStatus = structuredClone(nativeStatus);
    await chooseBrowser(true);
    await engine.generate(TEST_MESSAGES, 64);
    const closing = deferred<void>();
    const rejected = deferred<void>();
    vi.mocked(browser.unload).mockRejectedValueOnce(new Error('Synthetic unload rejection'));
    vi.mocked(browser.forceClose).mockImplementationOnce(async () => { closing.resolve(); await rejected.promise; });
    await vi.advanceTimersByTimeAsync(60_000);
    await closing.promise;
    const switching = engine.selectEngine('ollama');
    const failure = expect(switching).rejects.toThrow('Synthetic delayed close rejection');
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.getSelection()).toEqual({ engine: 'ollama', revision: 2 });
    rejected.reject(new Error('Synthetic delayed close rejection'));
    await failure;
    expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_cleanup_failed', engine: 'ollama', selectionRevision: 2 });
    expect(data.nativeModelStatus).toEqual(nativeStatus);
    expect(data.browserModelStatus).toMatchObject({ reason: 'browser_cleanup_failed', selectionRevision: 2 });
    const failures = vi.mocked(chrome.storage.local.set).mock.calls.filter(([items]) => items.browserModelStatus?.reason === 'browser_cleanup_failed');
    expect(failures.every(([items]) => items.browserModelStatus?.selectionRevision === 2)).toBe(true);
    expect(native.check).not.toHaveBeenCalled();
    expect(native.generate).not.toHaveBeenCalled();
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(browser.generate).toHaveBeenCalledTimes(1);
    expect(browser.download).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)(
    'tolerates observational state failure during owned pending initialization before actual %s', async outcome => {
      await chooseBrowser(true);
      const starting = deferred<void>();
      const initialized = deferred<void>();
      vi.mocked(browser.initialize).mockImplementation(async () => {
        state.initializing = true; starting.resolve(); await initialized.promise;
        state.initializing = false; state.loaded = true;
      });
      const generation = engine.generate(TEST_MESSAGES, 64);
      const result = outcome === 'failure' ? expect(generation).rejects.toMatchObject({ reason: 'webgpu_unavailable' }) : undefined;
      await starting.promise;
      vi.mocked(browser.getState).mockRejectedValueOnce(new Error('Synthetic state RPC rejected while initialization is pending'));
      expect(await engine.getStatus()).toMatchObject({ state: 'loading' });
      expect(data.browserModelStatus).not.toMatchObject({ state: 'error' });
      if (outcome === 'failure') {
        initialized.reject(new BrowserModelError('webgpu_unavailable', 'Actual initialization failure'));
        await result;
        expect(await engine.getStatus()).toMatchObject({ state: 'blocked', reason: 'webgpu_unavailable' });
        await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'response_invalid' });
        expect(browser.generate).not.toHaveBeenCalled();
      } else {
        initialized.resolve();
        expect(await generation).toBe('no');
        expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
        expect(browser.generate).toHaveBeenCalledTimes(2);
        expect(data.browserModelStatus).not.toMatchObject({ state: 'error' });
      }
      expect(browser.initialize).toHaveBeenCalledTimes(1);
      expect(browser.download).not.toHaveBeenCalled();
      expect(native.check).not.toHaveBeenCalled();
      expect(native.generate).not.toHaveBeenCalled();
    },
  );

  it('keeps explicit cache-only download progress and completion owned across ordinary inference preemption', async () => {
    await chooseBrowser();
    const started = deferred<void>();
    const finished = deferred<void>();
    let signal!: AbortSignal;
    let progress!: (value: BrowserProgress) => void;
    vi.mocked(browser.download).mockImplementation(async (onProgress, abort) => {
      signal = abort; progress = onProgress; state.downloading = true; started.resolve();
      await finished.promise; state.cached = true; state.downloading = false;
    });
    const downloading = engine.downloadBrowserModel();
    await started.promise;
    const epoch = engine.operationEpoch;
    engine.preempt();
    expect(engine.operationEpoch).toBe(epoch + 1);
    expect(signal.aborted).toBe(false);
    expect(browser.interrupt).not.toHaveBeenCalled();
    state.progress = 0.5; state.receivedBytes = 100; state.totalBytes = 200;
    progress({ progress: 0.5, text: 'Download', receivedBytes: 100, totalBytes: 200 });
    expect(await engine.getStatus()).toMatchObject({ state: 'downloading', progress: 0.5, receivedBytes: 100, totalBytes: 200 });
    finished.resolve();
    expect(await downloading).toMatchObject({ state: 'ready', engine: 'litertlm', selectionRevision: 1 });
    expect(state.cached).toBe(true);
    expect(browser.download).toHaveBeenCalledTimes(1);
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(browser.generate).not.toHaveBeenCalled();
    expect(browser.forceClose).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
  });

  it('starts an authorized download after ordinary preemption while its initial status write is pending', async () => {
    await chooseBrowser();
    const writing = deferred<void>();
    const persisted = deferred<void>();
    vi.mocked(chrome.storage.local.set).mockImplementation(async values => {
      if (values.localModelStatus?.state === 'downloading') { writing.resolve(); await persisted.promise; }
      Object.assign(data, structuredClone(values));
    });
    const downloading = engine.downloadBrowserModel();
    await writing.promise;
    engine.preempt();
    persisted.resolve();
    expect(await downloading).toMatchObject({ state: 'ready' });
    expect(browser.download).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(browser.download).mock.calls[0][1];
    expect(signal.aborted).toBe(false);
    expect(state.cached).toBe(true);
    expect(browser.initialize).not.toHaveBeenCalled();
  });

  it('reconciles inherited download progress and completion across ordinary inference epoch changes', async () => {
    vi.useFakeTimers();
    data.engineSelection = { engine: 'litertlm', revision: 5 };
    state.downloading = true;
    engine = makeEngine();
    await engine.syncAllStatuses();
    const progressReply = deferred<BrowserState>();
    const progressStarted = deferred<void>();
    vi.mocked(browser.getState).mockImplementationOnce(async () => { progressStarted.resolve(); return progressReply.promise; });
    await vi.advanceTimersByTimeAsync(5_000);
    await progressStarted.promise;
    engine.preempt();
    state.progress = 0.5; state.receivedBytes = 50; state.totalBytes = 100;
    progressReply.resolve({ ...state });
    await vi.advanceTimersByTimeAsync(0);
    expect(data.localModelStatus).toMatchObject({ state: 'downloading', progress: 0.5, receivedBytes: 50, totalBytes: 100 });
    const completionReply = deferred<BrowserState>();
    const completionStarted = deferred<void>();
    vi.mocked(browser.getState).mockImplementationOnce(async () => { completionStarted.resolve(); return completionReply.promise; });
    await vi.advanceTimersByTimeAsync(5_000);
    await completionStarted.promise;
    engine.preempt();
    state.downloading = false; state.cached = true;
    completionReply.resolve({ ...state });
    await vi.advanceTimersByTimeAsync(0);
    expect(data.localModelStatus).toMatchObject({ state: 'ready', engine: 'litertlm', selectionRevision: 5 });
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.cached).toBe(true);
    vi.mocked(browser.getState).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(browser.getState).not.toHaveBeenCalled();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'switch', 'delete', 'teardown'] as const)(
    'still retires exact explicit download ownership on %s and rejects its late Ready/progress', async action => {
      vi.useFakeTimers();
      await chooseBrowser();
      const started = deferred<void>();
      const finished = deferred<void>();
      let signal!: AbortSignal;
      let progress!: (value: BrowserProgress) => void;
      vi.mocked(browser.download).mockImplementation(async (onProgress, abort) => {
        signal = abort; progress = onProgress; state.downloading = true; started.resolve();
        await finished.promise;
        // Real driver generation retirement prevents aborted bytes committing.
        if (!abort.aborted) state.cached = true;
        state.downloading = false;
      });
      const downloading = engine.downloadBrowserModel();
      await started.promise;
      engine.preempt();
      expect(signal.aborted).toBe(false);
      const retiring = action === 'cancel' ? engine.cancelBrowserDownload()
        : action === 'switch' ? engine.selectEngine('ollama')
          : action === 'delete' ? engine.deleteBrowserModel()
            : Promise.resolve(engine.teardown());
      await vi.advanceTimersByTimeAsync(3_000);
      await retiring;
      expect(signal.aborted).toBe(true);
      expect(browser.forceClose).toHaveBeenCalled();
      expect(state.cached).toBe(false);
      const settled = structuredClone(data.localModelStatus);
      progress({ progress: 1, text: 'Late old transfer', receivedBytes: 200, totalBytes: 200 });
      await vi.advanceTimersByTimeAsync(0);
      expect(data.localModelStatus).toEqual(settled);
      finished.resolve();
      const finalStatus = await downloading;
      expect(finalStatus).not.toMatchObject({ state: 'ready', engine: 'litertlm' });
      expect(data.browserModelStatus).not.toMatchObject({ state: 'ready' });
      expect(state.cached).toBe(false);
      expect(browser.initialize).not.toHaveBeenCalled();
      expect(native.check).not.toHaveBeenCalled();
      expect(data.engineSelection).toEqual(action === 'switch'
        ? { engine: 'ollama', revision: 2 } : { engine: 'litertlm', revision: 1 });
    },
  );

  it('bounds canceled download settlement, retains preference and ignores late progress', async () => {
    vi.useFakeTimers();
    await chooseBrowser();
    const pending = deferred<void>();
    const started = deferred<void>();
    let progress!: (value: BrowserProgress) => void;
    let signal!: AbortSignal;
    vi.mocked(browser.download).mockImplementation(async (onProgress, abort) => {
      progress = onProgress; signal = abort; state.downloading = true; started.resolve(); await pending.promise;
    });
    vi.mocked(browser.forceClose).mockImplementation(async () => { state.downloading = false; pending.reject(new Error('Owned host closed')); });
    const downloading = engine.downloadBrowserModel();
    await started.promise;
    const canceled = engine.cancelBrowserDownload();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await canceled).toMatchObject({ state: 'needs_download', engine: 'litertlm', selectionRevision: 1 });
    await downloading;
    expect(signal.aborted).toBe(true);
    expect(browser.forceClose).toHaveBeenCalled();
    const before = structuredClone(data.localModelStatus);
    progress({ progress: 99, text: 'Old download', receivedBytes: 999, totalBytes: 1000 });
    await Promise.resolve();
    expect(data.localModelStatus).toEqual(before);
    expect(data.engineSelection).toEqual({ engine: 'litertlm', revision: 1 });
    expect(browser.initialize).not.toHaveBeenCalled();
  });

  it('closes canceled initialization before replacement and rejects stale progress/ready', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const pending = deferred<void>();
    const started = deferred<void>();
    let progress!: (value: BrowserProgress) => void;
    vi.mocked(browser.initialize).mockImplementation(async onProgress => { progress = onProgress; started.resolve(); await pending.promise; });
    vi.mocked(browser.forceClose).mockImplementation(async () => { state.loaded = false; pending.reject(new Error('Owned host closed')); });
    const old = engine.generate(TEST_MESSAGES, 64);
    const rejection = expect(old).rejects.toMatchObject({ reason: 'inference_preempted' });
    await started.promise;
    const selecting = engine.selectEngine('ollama');
    await vi.advanceTimersByTimeAsync(3_000);
    await rejection;
    await selecting;
    progress({ progress: 100, text: 'Old GPU ready' });
    await Promise.resolve();
    expect(await engine.getStatus()).toMatchObject({ engine: 'ollama', selectionRevision: 2 });
    expect(data.localModelStatus).not.toMatchObject({ engine: 'litertlm', state: 'ready' });
    expect(browser.generate).not.toHaveBeenCalled();
  });

  it('cancels GPU initialization and pauses automatic Browser work until explicit Retry', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const pending = deferred<void>();
    const started = deferred<void>();
    vi.mocked(browser.initialize).mockImplementation(async () => { started.resolve(); await pending.promise; });
    vi.mocked(browser.forceClose).mockImplementation(async () => { state.loaded = false; pending.reject(new Error('Owned host closed')); });
    const loading = engine.generate(TEST_MESSAGES, 64);
    const retired = expect(loading).rejects.toMatchObject({ reason: 'inference_preempted' });
    await started.promise;
    const canceling = engine.cancelBrowserDownload();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await canceling).toMatchObject({ state: 'paused', reason: 'browser_cancelled', engine: 'litertlm', selectionRevision: 1 });
    await retired;
    expect(state.cached).toBe(true);
    expect(state.loaded).toBe(false);
    expect(data.engineSelection).toEqual({ engine: 'litertlm', revision: 1 });
    expect(data.browserModelStatus).not.toMatchObject({ state: 'error' });
    expect(browser.download).not.toHaveBeenCalled();
    expect(browser.generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(engine.ensureLoaded()).rejects.toMatchObject({ reason: 'browser_cancelled' });
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'browser_cancelled' });
    await expect(engine.downloadBrowserModel()).rejects.toMatchObject({ reason: 'browser_cancelled' });
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(await engine.getStatus()).toMatchObject({ state: 'paused', reason: 'browser_cancelled' });
    vi.mocked(browser.initialize).mockImplementation(async () => { state.loaded = true; });
    expect(await engine.retry()).toMatchObject({ state: 'ready' });
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
    expect(browser.initialize).toHaveBeenCalledTimes(2);
  });

  it('preserves the explicit browser cancellation pause across worker recreation', async () => {
    data.engineSelection = { engine: 'litertlm', revision: 2 };
    data.browserModelStatus = { state: 'paused', reason: 'browser_cancelled', message: 'Setup canceled', engine: 'litertlm', selectionRevision: 2, revision: 6 };
    state.cached = true;
    engine = makeEngine();
    await engine.syncAllStatuses();
    expect(await engine.getStatus()).toMatchObject({ state: 'paused', reason: 'browser_cancelled' });
    await expect(engine.ensureLoaded()).rejects.toMatchObject({ reason: 'browser_cancelled' });
    expect(browser.initialize).not.toHaveBeenCalled();
    expect(await engine.retry()).toMatchObject({ state: 'ready' });
    expect(browser.initialize).not.toHaveBeenCalled();
    await engine.ensureLoaded();
    expect(browser.initialize).toHaveBeenCalledTimes(1);
  });

  it('deletes inactive browser files without retiring or waiting for native inference', async () => {
    state.cached = true;
    const terminal = deferred<void>();
    const started = deferred<void>();
    vi.mocked(native.generate).mockImplementation(async (_messages, _max, hooks) => {
      await hooks.beforeSubmit(TEST_READINESS); hooks.assertCanSubmit(); started.resolve();
      await terminal.promise; await hooks.onTerminal(); return 'yes';
    });
    const generating = engine.generate(TEST_MESSAGES, 64);
    await started.promise;
    const fence = structuredClone(data.nativeOperationFence);
    const epoch = engine.operationEpoch;
    expect(await engine.deleteBrowserModel()).toMatchObject({ state: 'loading', engine: 'ollama' });
    expect(engine.operationEpoch).toBe(epoch);
    expect(data.nativeOperationFence).toEqual(fence);
    expect(state.cached).toBe(false);
    expect(browser.deleteCache).toHaveBeenCalledTimes(1);
    terminal.resolve();
    expect(await generating).toBe('yes');
    expect(data.nativeOperationFence).toBeUndefined();
  });

  it('keeps global native recovery visible through browser download progress and Ready writes', async () => {
    data.nativeOperationFence = { operationId: 'uncertain' };
    await chooseBrowser();
    vi.mocked(browser.download).mockImplementation(async onProgress => {
      onProgress({ progress: 0.5, text: 'Download', receivedBytes: 100, totalBytes: 200 });
      await Promise.resolve(); await Promise.resolve();
      expect(data.localModelStatus).toMatchObject({ state: 'recovery_required', engine: 'litertlm' });
      state.cached = true;
    });
    expect(await engine.downloadBrowserModel()).toMatchObject({ state: 'recovery_required', engine: 'litertlm' });
    expect(data.browserModelStatus).toMatchObject({ state: 'ready', engine: 'litertlm' });
    expect(data.nativeOperationFence).toEqual({ operationId: 'uncertain' });
  });

  it('preserves actionable fixed browser reasons and expected missing-cache state', async () => {
    await chooseBrowser(true);
    vi.mocked(browser.initialize).mockRejectedValueOnce(new BrowserModelError('webgpu_unavailable', 'Untrusted SDK detail'));
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'webgpu_unavailable' });
    expect(await engine.getStatus()).toMatchObject({ state: 'blocked', reason: 'webgpu_unavailable' });
    expect(JSON.stringify(data.browserModelStatus)).not.toContain('Untrusted SDK detail');
    await engine.retry();
    vi.mocked(browser.initialize).mockRejectedValueOnce(new BrowserModelError('needs_download', 'Untrusted SDK detail'));
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'needs_download' });
    expect(data.browserModelStatus).toMatchObject({ state: 'needs_download', reason: 'needs_download' });
    expect(browser.download).not.toHaveBeenCalled();
  });

  it('does not permit an escaped browser lease to generate or count after release', async () => {
    await chooseBrowser(true);
    let generate!: () => Promise<string>;
    let count!: () => Promise<number>;
    await engine.runInferenceOperation(async lease => {
      generate = () => lease.generate(TEST_MESSAGES, 64);
      count = () => lease.countTokens('Synthetic');
    });
    await expect(generate()).rejects.toMatchObject({ reason: 'inference_preempted' });
    expect(() => count()).toThrow('Inference lease ended');
    expect(browser.generate).not.toHaveBeenCalled();
  });

  it('pins full prompt preparation and unloads after one minute without popup touches extending idle', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const preparation = deferred<number>();
    const started = deferred<void>();
    vi.mocked(browser.countTokens).mockImplementation(async () => { started.resolve(); return preparation.promise; });
    const pending = engine.runInferenceOperation(async lease => {
      await lease.countTokens('Synthetic prompt');
      return lease.generate(TEST_MESSAGES, 64);
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(65_000);
    expect(browser.unload).not.toHaveBeenCalled();
    expect(browser.forceClose).not.toHaveBeenCalled();
    preparation.resolve(5);
    await pending;
    await vi.advanceTimersByTimeAsync(30_000);
    await engine.getStatus();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(browser.unload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.unload).toHaveBeenCalledTimes(1);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.cached).toBe(true);
    expect(state.loaded).toBe(false);
    expect(native.check).not.toHaveBeenCalled();
  });

  it('releases idle GPU residency at the original deadline despite ordinary inference preemption', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    await engine.generate(TEST_MESSAGES, 64);
    await vi.advanceTimersByTimeAsync(20_000);
    const epoch = engine.operationEpoch;
    engine.preempt();
    expect(engine.operationEpoch).toBe(epoch + 1);
    expect(state.loaded).toBe(true);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(browser.unload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.unload).toHaveBeenCalledTimes(1);
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(state.loaded).toBe(false);
    expect(state.cached).toBe(true);
    expect(browser.initialize).toHaveBeenCalledTimes(1);
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
  });

  it('uses read-only browser keepalive only while resident/setup and stops after unload', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const initialReads = vi.mocked(chrome.storage.local.get).mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(vi.mocked(chrome.storage.local.get).mock.calls.length).toBe(initialReads);
    await engine.generate(TEST_MESSAGES, 64);
    vi.mocked(chrome.storage.local.set).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    const touches = vi.mocked(chrome.storage.local.get).mock.calls.filter(([keys]) => JSON.stringify(keys) === '["browserCacheGeneration"]');
    expect(touches).toHaveLength(6);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    await engine.unloadBrowserModel();
    vi.mocked(chrome.storage.local.get).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();
  });

  it('bounds browser inference and closes owned compute with an explicit Retry fence', async () => {
    vi.useFakeTimers();
    await chooseBrowser(true);
    const started = deferred<void>();
    const physical = deferred<string>();
    vi.mocked(browser.generate).mockImplementation(async () => { started.resolve(); return physical.promise; });
    vi.mocked(browser.forceClose).mockImplementation(async () => { state.loaded = false; physical.reject(new Error('Owned host closed')); });
    const pending = engine.generate(TEST_MESSAGES, 64);
    const rejection = expect(pending).rejects.toThrow('Browser inference timed out');
    await started.promise;
    await vi.advanceTimersByTimeAsync(90_000);
    await rejection;
    expect(browser.forceClose).toHaveBeenCalledTimes(1);
    expect(await engine.getStatus()).toMatchObject({ state: 'error', reason: 'browser_failed' });
    expect(data.engineSelection).toEqual({ engine: 'litertlm', revision: 1 });
  });

  it('deletes only browser weights after owned cleanup and keeps native uncertainty', async () => {
    await chooseBrowser(true);
    await engine.generate(TEST_MESSAGES, 64);
    data.nativeOperationFence = { operationId: 'unknown', preserve: 1 };
    const selection = engine.getSelection();
    expect(await engine.deleteBrowserModel()).toMatchObject({ state: 'recovery_required' });
    expect(state.cached).toBe(false);
    expect(engine.getSelection()).toEqual(selection);
    expect(data.nativeOperationFence).toEqual({ operationId: 'unknown', preserve: 1 });
    expect(browser.deleteCache).toHaveBeenCalledTimes(1);
    expect(native.generate).toHaveBeenCalledTimes(0);
  });
});

describe('immutable classifier identity', () => {
  it('uses the browser comma baseline and captured artifact fingerprint in returned results', async () => {
    const selected = { engine: 'litertlm' as const, revision: 7 };
    vi.spyOn(localEngine, 'getSelection').mockReturnValue(selected);
    vi.spyOn(localEngine, 'getSelectedModel').mockReturnValue(BROWSER_MODEL);
    const ensure = vi.spyOn(localEngine, 'ensureLoaded');
    let sent: ChatMessage[] = [];
    vi.spyOn(localEngine, 'runInferenceOperation').mockImplementation(async fn => fn({
      countTokens: async text => Math.ceil(text.length / 3),
      truncateText: async text => text,
      generate: async messages => { sent = messages; return 'no | no'; },
    }));
    const result = await callLocalInference({ text: 'Synthetic bicycle post' }, ['sports', 'politics']);
    expect(sent[1].content).toContain('Categories (in order): sports, politics');
    expect(sent[1].content).not.toContain('1. sports');
    expect(result).toMatchObject({ modelId: BROWSER_MODEL.name, engine: 'litertlm', selectionRevision: 7, classifierFingerprint: BROWSER_CLASSIFIER_FINGERPRINT, malformed: false });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('never stamps a finished browser result with a newer preference read after awaits', async () => {
    const selection = vi.spyOn(localEngine, 'getSelection').mockReturnValue({ engine: 'litertlm', revision: 1 });
    vi.spyOn(localEngine, 'getSelectedModel').mockReturnValue(BROWSER_MODEL);
    vi.spyOn(localEngine, 'runInferenceOperation').mockImplementation(async fn => fn({
      countTokens: async () => 1,
      truncateText: async text => text,
      generate: async () => { selection.mockReturnValue({ engine: 'ollama', revision: 2 }); return 'no'; },
    }));
    expect(await callLocalInference({ text: 'Synthetic bicycle post' }, ['sports'])).toMatchObject({ engine: 'litertlm', modelId: BROWSER_MODEL.name, selectionRevision: 1, classifierFingerprint: BROWSER_CLASSIFIER_FINGERPRINT });
  });

  it('rejects arbitrary or other-engine models before dispatch', async () => {
    vi.spyOn(localEngine, 'getSelection').mockReturnValue({ engine: 'litertlm', revision: 1 });
    const dispatch = vi.spyOn(localEngine, 'runInferenceOperation');
    await expect(callLocalInference({ text: 'Synthetic post' }, ['sports'], PRIMARY_LOCAL_MODEL, PRIMARY_LOCAL_MODEL.name)).rejects.toBeInstanceOf(NativeModelError);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
