import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeState = vi.hoisted(() => ({ digest: 'a'.repeat(64), recovery: false }));
vi.mock('../../src/shared/models.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/shared/models.js')>(),
  get ACCEPTED_NATIVE_MANIFEST_DIGEST() { return nativeState.digest; },
  get OPERATOR_RESTART_RECOVERY_QUALIFIED() { return nativeState.recovery; },
}));
import { callLocalInference, LocalEngine, localEngine, MODEL_MAINTENANCE_ERROR } from '../../src/background/local-model.js';
import { OllamaBackend } from '../../src/background/backends/ollama-backend.js';
import type { LocalBackend, NativeGenerationHooks } from '../../src/background/backends/types.js';
import { inferenceQueue } from '../../src/background/inference-queue.js';
import { NativeModelError, NATIVE_REQUEST_DEADLINE_MS } from '../../src/shared/ollama-contract.js';
import { completion, TEST_DIGEST, TEST_MESSAGES, TEST_READINESS, TEST_SHOW, TEST_TAGS } from './native-fixtures.js';

let data: Record<string, unknown>;
let backend: LocalBackend;
let engine: LocalEngine;
function storedFence(operationId = 'old-worker') {
  return { schemaVersion: 1, operationId, epoch: 1, startedAt: Date.now(), modelDigest: TEST_DIGEST };
}
function installStorage(initial: Record<string, unknown> = {}) {
  data = structuredClone(initial);
  chrome.storage.local = {
    get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter(key => key in data).map(key => [key, structuredClone(data[key])]))),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)); }),
    remove: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }),
  } as unknown as chrome.storage.LocalStorageArea;
  chrome.permissions = { contains: vi.fn().mockResolvedValue(true) } as unknown as typeof chrome.permissions;
}
function makeBackend(overrides: Partial<LocalBackend> = {}): LocalBackend {
  return {
    check: vi.fn().mockResolvedValue({ version: '0.40.3', modelDigest: TEST_DIGEST, resident: false, otherModelResident: false }),
    generate: vi.fn(async (_messages: unknown, _max: number, hooks: NativeGenerationHooks) => {
      await hooks.beforeSubmit(TEST_READINESS); hooks.assertCanSubmit(); await hooks.onTerminal(); return 'no';
    }),
    ...overrides,
  };
}
function metadataFetch(chat: () => Promise<Response>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/chat') return chat();
    const responses: Record<string, unknown> = {
      '/api/version': { version: '0.40.3' }, '/api/tags': TEST_TAGS,
      '/api/show': TEST_SHOW, '/api/ps': { models: [] },
    };
    return new Response(JSON.stringify(responses[path]));
  });
}

beforeEach(async () => {
  vi.useRealTimers(); nativeState.digest = TEST_DIGEST; nativeState.recovery = false;
  installStorage({ engineSelection: { engine: 'ollama', revision: 0 } });
  await localEngine.syncAllStatuses();
  installStorage(); inferenceQueue.reset(); backend = makeBackend(); engine = new LocalEngine(backend);
});
afterEach(() => { engine.teardown(); localEngine.teardown(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('native readiness and durable restart recovery', () => {
  it('keeps popup snapshots and startup free of metadata or generation', async () => {
    expect(await engine.getStatus()).toEqual({ state: 'not_connected', message: 'Connect to Ollama', revision: 1, engine: 'ollama', selectionRevision: 0 });
    await engine.syncAllStatuses(); expect(backend.check).not.toHaveBeenCalled(); expect(backend.generate).not.toHaveBeenCalled();
  });
  it('makes Retry metadata-only with healthy unloaded status', async () => {
    expect(await engine.retry()).toMatchObject({ state: 'ready', message: 'Ready — loads when needed', revision: 2 });
    expect(backend.check).toHaveBeenCalledTimes(1); expect(backend.generate).not.toHaveBeenCalled();
  });
  it('reflects permission revocation without HTTP and preserves an unresolved fence', async () => {
    const fence = storedFence();
    installStorage({ nativeOperationFence: fence, nativeModelStatus: { state: 'ready', message: 'Ready', revision: 4 } });
    vi.mocked(chrome.permissions.contains).mockResolvedValue(false);
    expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required', revision: 5 });
    expect(data.nativeOperationFence).toEqual(fence);
    expect(backend.check).not.toHaveBeenCalled();
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(backend.generate).not.toHaveBeenCalled();
    vi.mocked(chrome.permissions.contains).mockResolvedValue(true);
    expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required' });
  });
  it('never clears worker uncertainty on Retry, metadata or worker teardown', async () => {
    const fence = storedFence(); installStorage({ nativeOperationFence: fence });
    expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required', recoveryQualified: false });
    expect(await engine.retry()).toMatchObject({ state: 'recovery_required' });
    engine.teardown(); expect(data.nativeOperationFence).toEqual(fence);
    engine = new LocalEngine(backend);
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(backend.generate).not.toHaveBeenCalled();
  });
  it('does not infer settlement from age or malformed persisted fence data', async () => {
    installStorage({ nativeOperationFence: { startedAt: 0 } });
    expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required' });
    await expect(engine.recoverAfterOperatorRestart(true)).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(data.nativeOperationFence).toEqual({ startedAt: 0 });
  });
  it('requires qualification and explicit operator restart confirmation', async () => {
    installStorage({ nativeOperationFence: storedFence() }); nativeState.recovery = true;
    await expect(engine.recoverAfterOperatorRestart(false)).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(data.nativeOperationFence).toBeDefined();
    expect(await engine.recoverAfterOperatorRestart(true)).toMatchObject({ state: 'ready' });
    expect(data.nativeOperationFence).toBeUndefined(); expect(backend.generate).not.toHaveBeenCalled();
  });
  it('keeps uncertainty when recovery metadata fails', async () => {
    const fence = storedFence(); installStorage({ nativeOperationFence: fence }); nativeState.recovery = true;
    vi.mocked(backend.check).mockRejectedValue(new NativeModelError('service_unreachable', 'Open Ollama'));
    await expect(engine.recoverAfterOperatorRestart(true)).rejects.toMatchObject({ reason: 'service_unreachable' });
    expect(data.nativeOperationFence).toEqual(fence);
  });
  it('refuses to erase a changed fence during recovery', async () => {
    installStorage({ nativeOperationFence: storedFence() }); nativeState.recovery = true;
    vi.mocked(backend.check).mockImplementation(async () => {
      data.nativeOperationFence = storedFence('new-operation');
      return { version: '0.40.3', modelDigest: TEST_DIGEST, resident: false, otherModelResident: false };
    });
    await expect(engine.recoverAfterOperatorRestart(true)).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(data.nativeOperationFence).toMatchObject({ operationId: 'new-operation' });
  });
  it('rate limits failed automatic metadata probes but allows Retry', async () => {
    vi.mocked(backend.check).mockRejectedValue(new NativeModelError('service_unreachable', 'Open Ollama'));
    await expect(engine.ensureLoaded()).rejects.toMatchObject({ reason: 'service_unreachable' });
    await expect(engine.ensureLoaded()).rejects.toMatchObject({ reason: 'service_unreachable' });
    expect(backend.check).toHaveBeenCalledTimes(1); await engine.retry(); expect(backend.check).toHaveBeenCalledTimes(2);
  });
  it('serializes singleton revisions without idle timers', async () => {
    const one = engine.updateStatus({ state: 'ready', message: 'Ready' });
    const two = engine.updateStatus({ state: 'paused', message: 'Paused' });
    expect((await one).revision).toBe(1); expect((await two).revision).toBe(2);
    expect((await engine.getStatus()).state).toBe('paused'); expect(Object.keys(data).sort()).toEqual(['localModelStatus', 'nativeModelStatus']);
  });
});

describe('native serial lease, persistence and cancellation', () => {
  it('rejects caller ownership that is already retired without readiness or generation', async () => {
    const retired = new Error('Synthetic document retired');
    await expect(engine.runInferenceOperation(lease => lease.generate(TEST_MESSAGES, 64), {
      assertCurrent: () => { throw retired; },
    })).rejects.toBe(retired);
    expect(backend.check).not.toHaveBeenCalled();
    expect(backend.generate).not.toHaveBeenCalled();
    expect(data.nativeOperationFence).toBeUndefined();
  });
  it('rechecks caller ownership after readiness before entering actual generation', async () => {
    let finishReadiness!: () => void;
    let readinessStarted!: () => void;
    const started = new Promise<void>(resolve => { readinessStarted = resolve; });
    vi.mocked(backend.check).mockImplementation(async () => {
      readinessStarted();
      await new Promise<void>(resolve => { finishReadiness = resolve; });
      return TEST_READINESS;
    });
    let current = true;
    const retired = new Error('Synthetic deadline expired');
    const pending = engine.runInferenceOperation(lease => lease.generate(TEST_MESSAGES, 64), {
      assertCurrent: () => { if (!current) throw retired; },
    });
    const rejection = expect(pending).rejects.toBe(retired);
    await started;
    current = false;
    finishReadiness();
    await rejection;
    expect(backend.generate).not.toHaveBeenCalled();
    expect(data.nativeOperationFence).toBeUndefined();
    expect(data.nativeModelStatus).not.toMatchObject({ state: 'error' });
  });
  it('rechecks caller ownership after native metadata awaits before any chat POST', async () => {
    let showCount = 0;
    let metadataStarted!: () => void;
    let finishMetadata!: (response: Response) => void;
    const started = new Promise<void>(resolve => { metadataStarted = resolve; });
    const normal = metadataFetch(async () => new Response(JSON.stringify(completion())));
    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/api/show') && ++showCount === 2) {
        metadataStarted();
        return new Promise<Response>(resolve => { finishMetadata = resolve; });
      }
      return normal(url);
    });
    engine = new LocalEngine(new OllamaBackend(request as typeof fetch));
    let current = true;
    const retired = new Error('Synthetic document replaced');
    const pending = engine.runInferenceOperation(lease => lease.generate(TEST_MESSAGES, 64), {
      assertCurrent: () => { if (!current) throw retired; },
    });
    const rejection = expect(pending).rejects.toBe(retired);
    await started;
    current = false;
    finishMetadata(new Response(JSON.stringify(TEST_SHOW)));
    await rejection;
    expect(request.mock.calls.some(([url]) => url.endsWith('/api/chat'))).toBe(false);
    expect(data.nativeOperationFence).toBeUndefined();
  });
  it('clears a proved pre-submission fence when caller ownership retires during persistence', async () => {
    const request = metadataFetch(async () => new Response(JSON.stringify(completion())));
    engine = new LocalEngine(new OllamaBackend(request as typeof fetch));
    let current = true;
    const retired = new Error('Synthetic caller no longer current');
    vi.mocked(chrome.storage.local.set).mockImplementation(async items => {
      Object.assign(data, structuredClone(items));
      if ('nativeOperationFence' in items) current = false;
    });
    await expect(engine.runInferenceOperation(lease => lease.generate(TEST_MESSAGES, 64), {
      assertCurrent: () => { if (!current) throw retired; },
    })).rejects.toBe(retired);
    expect(request.mock.calls.some(([url]) => url.endsWith('/api/chat'))).toBe(false);
    expect(data.nativeOperationFence).toBeUndefined();
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
  });
  it('drains submitted work before fresh callers while suppressing a retired caller result', async () => {
    let finish!: (response: Response) => void;
    let chatStarted!: () => void;
    let chats = 0;
    const started = new Promise<void>(resolve => { chatStarted = resolve; });
    const request = metadataFetch(async () => {
      if (++chats > 1) return new Response(JSON.stringify(completion()));
      chatStarted();
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    engine = new LocalEngine(new OllamaBackend(request as typeof fetch));
    let current = true;
    const retired = new Error('Synthetic caller deadline expired');
    const pending = engine.runInferenceOperation(lease => lease.generate(TEST_MESSAGES, 64), {
      assertCurrent: () => { if (!current) throw retired; },
    });
    const rejection = expect(pending).rejects.toBe(retired);
    await started;
    current = false;
    const next = engine.generate(TEST_MESSAGES, 64);
    expect(data.nativeOperationFence).toBeDefined();
    expect(chats).toBe(1);
    finish(new Response(JSON.stringify(completion('yes'))));
    await rejection;
    expect(await next).toBe('no');
    expect(chats).toBe(2);
    expect(data.nativeOperationFence).toBeUndefined();
    expect(await engine.getStatus()).toMatchObject({ state: 'ready' });
  });
  it('does not allow an escaped lease to submit after its serial operation ends', async () => {
    let escapedGenerate!: () => Promise<string>;
    await engine.runInferenceOperation(async lease => {
      escapedGenerate = () => lease.generate(TEST_MESSAGES, 64);
      await lease.countTokens('synthetic');
    });
    await expect(escapedGenerate()).rejects.toMatchObject({ reason: 'inference_preempted', message: 'Inference lease ended' });
    expect(backend.generate).not.toHaveBeenCalled();
    expect(data.nativeOperationFence).toBeUndefined();
  });
  it('uses fresh residency on real use after native idle expiry', async () => {
    let resident = true;
    vi.mocked(backend.generate).mockImplementation(async (_messages, _max, hooks) => {
      await hooks.beforeSubmit({ ...TEST_READINESS, resident });
      hooks.assertCanSubmit();
      await hooks.onTerminal();
      return 'no';
    });
    await engine.generate(TEST_MESSAGES, 64);
    expect(vi.mocked(chrome.storage.local.set).mock.calls.some(([items]) => items.nativeModelStatus?.state === 'filtering')).toBe(true);
    resident = false;
    vi.mocked(chrome.storage.local.set).mockClear();
    await engine.generate(TEST_MESSAGES, 64);
    expect(vi.mocked(chrome.storage.local.set).mock.calls.some(([items]) => items.nativeModelStatus?.state === 'loading')).toBe(true);
  });
  it('awaits a content-free durable marker before transmission', async () => {
    vi.mocked(backend.generate).mockImplementation(async (messages, _max, hooks) => {
      expect(data.nativeOperationFence).toBeUndefined(); await hooks.beforeSubmit(TEST_READINESS); hooks.assertCanSubmit();
      expect(data.nativeOperationFence).toMatchObject({ schemaVersion: 1, modelDigest: TEST_DIGEST });
      expect(JSON.stringify(data.nativeOperationFence)).not.toContain(messages[1].content);
      expect(Object.keys(data.nativeOperationFence as object).sort()).toEqual(['epoch', 'modelDigest', 'operationId', 'schemaVersion', 'startedAt']);
      await hooks.onTerminal(); return 'no';
    });
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no'); expect(data.nativeOperationFence).toBeUndefined();
  });
  it('sends nothing when fence persistence fails', async () => {
    vi.mocked(chrome.storage.local.set).mockImplementation(async items => {
      if ('nativeOperationFence' in items) throw new Error('synthetic storage failure'); Object.assign(data, items);
    });
    let submitted = false;
    vi.mocked(backend.generate).mockImplementation(async (_messages, _max, hooks) => {
      await hooks.beforeSubmit(TEST_READINESS); hooks.assertCanSubmit(); submitted = true; return 'no';
    });
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toThrow('synthetic storage failure'); expect(submitted).toBe(false);
  });
  it('does not mistake its own fence persistence for worker-restart uncertainty', async () => {
    let fenceStored!: () => void;
    let settlePersistence!: () => void;
    const stored = new Promise<void>(resolve => { fenceStored = resolve; });
    vi.mocked(chrome.storage.local.set).mockImplementation(async items => {
      Object.assign(data, structuredClone(items));
      if ('nativeOperationFence' in items) {
        fenceStored();
        await new Promise<void>(resolve => { settlePersistence = resolve; });
      }
    });
    const result = engine.generate(TEST_MESSAGES, 64);
    await stored;
    expect(await engine.getStatus()).toMatchObject({ state: 'loading' });
    settlePersistence();
    expect(await result).toBe('no');
    vi.mocked(chrome.storage.local.set).mockImplementation(async items => { Object.assign(data, structuredClone(items)); });
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
  });
  it('invalidates preparation at call-time epochs and accepts fresh work', async () => {
    const pending = engine.runInferenceOperation(async lease => {
      await lease.countTokens('synthetic'); engine.preempt(); return lease.generate(TEST_MESSAGES, 64);
    });
    await expect(pending).rejects.toMatchObject({ reason: 'inference_preempted' }); expect(backend.generate).not.toHaveBeenCalled();
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no');
  });
  it('drains active work before manual-priority work and rejects stale results', async () => {
    let finish!: () => void; let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; }); const order: string[] = [];
    vi.mocked(backend.generate).mockImplementationOnce(async (_messages, _max, hooks) => {
      await hooks.beforeSubmit(TEST_READINESS); hooks.assertCanSubmit(); order.push('old'); firstStarted();
      await new Promise<void>(resolve => { finish = resolve; }); await hooks.onTerminal(); return 'yes';
    });
    const old = engine.generate(TEST_MESSAGES, 64); const oldRejection = expect(old).rejects.toMatchObject({ reason: 'inference_preempted' });
    await started; engine.preempt();
    const manual = engine.runInferenceOperation(lease => { order.push('manual'); return lease.generate(TEST_MESSAGES, 64); }, { priority: 1 });
    const automatic = engine.runInferenceOperation(lease => { order.push('automatic'); return lease.generate(TEST_MESSAGES, 64); });
    expect(order).toEqual(['old']); finish(); await oldRejection; await Promise.all([manual, automatic]);
    expect(order).toEqual(['old', 'manual', 'automatic']); expect(data.nativeOperationFence).toBeUndefined();
  });
  it('deletes pending stale work immediately', async () => {
    let finish!: () => void;
    let activeStarted!: () => void;
    const started = new Promise<void>(resolve => { activeStarted = resolve; });
    const hold = engine.runInferenceOperation(async () => new Promise<void>(resolve => { finish = resolve; activeStarted(); }));
    await started;
    const queued = engine.generate(TEST_MESSAGES, 64); const rejection = expect(queued).rejects.toThrow('Inference queue cleared');
    engine.preempt(); await rejection; finish(); await hold; expect(backend.generate).not.toHaveBeenCalled();
  });
  it('never starts another chat after uncertain post-submit failure', async () => {
    vi.mocked(backend.generate).mockImplementation(async (_messages, _max, hooks) => {
      await hooks.beforeSubmit(TEST_READINESS); hooks.assertCanSubmit(); throw new NativeModelError('service_unreachable', 'Disconnected', 'uncertain');
    });
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ submission: 'uncertain' }); expect(data.nativeOperationFence).toBeDefined();
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(backend.generate).toHaveBeenCalledTimes(1); expect(await engine.retry()).toMatchObject({ state: 'recovery_required' });
  });
  it('rejects at the transport deadline while retaining unresolved cleanup', async () => {
    vi.useFakeTimers(); const request = metadataFetch(() => new Promise<Response>(() => undefined));
    engine = new LocalEngine(new OllamaBackend(request as typeof fetch));
    const result = engine.generate(TEST_MESSAGES, 64); const rejection = expect(result).rejects.toMatchObject({ reason: 'native_timeout', submission: 'uncertain' });
    await vi.advanceTimersByTimeAsync(NATIVE_REQUEST_DEADLINE_MS); await rejection;
    expect(data.nativeOperationFence).toBeDefined(); expect(await engine.getStatus()).toMatchObject({ state: 'recovery_required' });
  });
  it('settles only its own late response and still requires explicit Retry', async () => {
    vi.useFakeTimers(); let finish!: (response: Response) => void;
    const request = metadataFetch(() => new Promise<Response>(resolve => { finish = resolve; }));
    engine = new LocalEngine(new OllamaBackend(request as typeof fetch));
    const pending = engine.generate(TEST_MESSAGES, 64); const rejection = expect(pending).rejects.toMatchObject({ reason: 'native_timeout' });
    await vi.advanceTimersByTimeAsync(NATIVE_REQUEST_DEADLINE_MS); await rejection;
    finish(new Response(JSON.stringify(completion()))); await vi.advanceTimersByTimeAsync(0); expect(data.nativeOperationFence).toBeUndefined();
    await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(await engine.retry()).toMatchObject({ state: 'ready' });
  });
  it('keeps maintenance as a boundary without shared native unload', async () => {
    await engine.runMaintenance(async () => { await expect(engine.generate(TEST_MESSAGES, 64)).rejects.toThrow(MODEL_MAINTENANCE_ERROR); });
    expect(await engine.generate(TEST_MESSAGES, 64)).toBe('no'); expect('unload' in backend).toBe(false); expect('interrupt' in backend).toBe(false);
  });
});

describe('fixed native table orchestration', () => {
  it('retains caller ownership across the pre-lease readiness await', async () => {
    let finishReadiness!: () => void;
    let readinessStarted!: () => void;
    const started = new Promise<void>(resolve => { readinessStarted = resolve; });
    vi.spyOn(localEngine, 'ensureLoaded').mockImplementation(async () => {
      readinessStarted();
      await new Promise<void>(resolve => { finishReadiness = resolve; });
    });
    const operation = vi.spyOn(localEngine, 'runInferenceOperation');
    let current = true;
    const retired = new Error('Synthetic document ownership expired');
    const pending = callLocalInference({ text: 'Synthetic post' }, ['sports'], null, undefined, {
      assertCurrent: () => { if (!current) throw retired; },
    });
    const rejection = expect(pending).rejects.toBe(retired);
    await started;
    current = false;
    finishReadiness();
    await rejection;
    expect(operation).not.toHaveBeenCalled();
    expect(data.nativeOperationFence).toBeUndefined();
  });
  it('forwards the same caller guard into the classification lease', async () => {
    vi.spyOn(localEngine, 'ensureLoaded').mockResolvedValue(undefined);
    const guard = vi.fn();
    const operation = vi.spyOn(localEngine, 'runInferenceOperation').mockImplementation(async fn => fn({
      countTokens: async text => Math.ceil(text.length / 3),
      truncateText: async (text, max) => text.slice(0, max * 3),
      generate: async () => 'no',
    }));
    expect(await callLocalInference({ text: 'Synthetic post' }, ['sports'], null, undefined, { assertCurrent: guard }))
      .toMatchObject({ shouldHide: false, malformed: false });
    expect(operation.mock.calls[0][1]).toMatchObject({ assertCurrent: guard });
    expect(guard).toHaveBeenCalled();
  });
  it('keeps malformed timeline output explicit without per-category retry', async () => {
    vi.spyOn(localEngine, 'ensureLoaded').mockResolvedValue(undefined);
    const operation = vi.spyOn(localEngine, 'runInferenceOperation').mockImplementation(async fn => fn({
      countTokens: async text => Math.ceil(text.length / 3), truncateText: async (text, max) => text.slice(0, max * 3), generate: async () => '| yes |',
    }));
    const result = await callLocalInference({ text: 'Synthetic post' }, ['crypto', 'sports']);
    expect(result).toMatchObject({ shouldHide: false, malformed: true, matches: [], reasoning: 'Malformed classifier response' });
    expect(operation).toHaveBeenCalledTimes(1); expect(data.nativeModelStatus).toMatchObject({ state: 'error', reason: 'response_invalid' });
  });
  it('rejects empty posts or arbitrary models before any operation', async () => {
    await expect(callLocalInference({ text: '' }, ['sports'])).rejects.toMatchObject({ reason: 'input_budget' });
    await expect(callLocalInference({ text: 'post' }, ['sports'], null, 'untrusted-model')).rejects.toMatchObject({ reason: 'model_identity_changed' });
  });
});
