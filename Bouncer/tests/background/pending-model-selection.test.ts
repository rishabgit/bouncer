import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalModelDef, LocalModelStatus, PendingLocalModelSelection, StorageSchema } from '../../src/types.js';

vi.mock('../../src/background/local-model.js', () => ({
  localEngine: {
    checkCached: vi.fn(),
    updateStatus: vi.fn(),
  },
}));
vi.mock('../../src/background/backends/webllm-backend.js', () => ({ prefetchWebllmModel: vi.fn() }));
vi.mock('../../src/background/backends/litertlm-backend.js', () => ({ prefetchLitertlmModel: vi.fn() }));

import {
  PendingLocalModelSelectionManager,
  supersededPendingSelection,
} from '../../src/background/pending-model-selection.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('PendingLocalModelSelectionManager', () => {
  let storage: Partial<StorageSchema>;
  let cached: Set<string>;
  let statuses: Record<string, LocalModelStatus>;
  let operationNumber: number;

  const makeManager = (prefetch = vi.fn().mockResolvedValue(undefined)) => new PendingLocalModelSelectionManager({
    read: vi.fn(async (keys: (keyof StorageSchema)[]) => Object.fromEntries(keys.map(key => [key, storage[key]]))),
    write: vi.fn(async (items: Partial<StorageSchema>) => { Object.assign(storage, items); }),
    isCached: vi.fn(async (modelId: string) => cached.has(modelId)),
    updateStatus: vi.fn(async (modelId: string, status: LocalModelStatus) => { statuses[modelId] = status; }),
    prefetch,
    resolveModel: (modelId: string) => ({ name: modelId, display: modelId, backend: 'webllm' } as LocalModelDef),
    makeOperationId: () => `op-${++operationNumber}`,
    keepAlive: vi.fn(),
  });

  beforeEach(() => {
    storage = { selectedModel: 'local:active', pendingLocalModelSelection: null };
    cached = new Set(['active']);
    statuses = {};
    operationNumber = 0;
  });

  it('stages an uncached target without replacing the active filtering model', async () => {
    const manager = makeManager();

    const result = await manager.select('target');

    expect(result).toMatchObject({ success: true, activated: false });
    expect(storage.selectedModel).toBe('local:active');
    expect(storage.pendingLocalModelSelection).toMatchObject({
      modelId: 'target',
      modelKey: 'local:target',
    });
    expect(statuses.target).toEqual({ state: 'not_downloaded' });
  });

  it('keeps the active model selected during prefetch and promotes only after a complete cache', async () => {
    const download = deferred();
    const prefetch = vi.fn(async (_model, onProgress: (p: { progress: number; text: string }) => void) => {
      onProgress({ progress: 0.5, text: 'halfway' });
      await download.promise;
    });
    const manager = makeManager(prefetch);
    await manager.select('target');

    const startPromise = manager.start('target');
    await vi.waitFor(() => expect(prefetch).toHaveBeenCalled());
    expect(storage.selectedModel).toBe('local:active');
    expect(storage.pendingLocalModelSelection?.modelId).toBe('target');

    cached.add('target');
    download.resolve();
    await startPromise;

    expect(storage.selectedModel).toBe('local:target');
    expect(storage.pendingLocalModelSelection).toBeNull();
    expect(statuses.target).toEqual({ state: 'cached' });
  });

  it('does not let an unabortable stale completion activate after superseding it', async () => {
    const firstDownload = deferred();
    const prefetch = vi.fn(async (model: LocalModelDef) => {
      if (model.name === 'first') await firstDownload.promise;
    });
    const manager = makeManager(prefetch);
    await manager.select('first');
    const firstStart = manager.start('first');
    await vi.waitFor(() => expect(prefetch).toHaveBeenCalled());

    await manager.select('second');
    cached.add('first');
    firstDownload.resolve();
    await firstStart;

    expect(storage.selectedModel).toBe('local:active');
    expect(storage.pendingLocalModelSelection?.modelId).toBe('second');
  });

  it('cancels only the matching pending target and restores cache-derived status', async () => {
    const manager = makeManager();
    await manager.select('target');

    expect(await manager.cancel('other')).toBe(false);
    expect(storage.pendingLocalModelSelection?.modelId).toBe('target');

    expect(await manager.cancel('target')).toBe(true);
    expect(storage.selectedModel).toBe('local:active');
    expect(storage.pendingLocalModelSelection).toBeNull();
    expect(statuses.target).toEqual({ state: 'not_downloaded' });
  });

  it('waits for every superseded transfer before cancellation can finish', async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    const prefetch = vi.fn(async () => {
      await (call++ === 0 ? first.promise : second.promise);
    });
    const manager = makeManager(prefetch);
    await manager.select('target');

    const firstStart = manager.start('target');
    await vi.waitFor(() => expect(prefetch).toHaveBeenCalledTimes(1));
    const secondStart = manager.start('target');
    await vi.waitFor(() => expect(prefetch).toHaveBeenCalledTimes(2));

    let cancelSettled = false;
    const cancel = manager.cancel('target').then(result => {
      cancelSettled = true;
      return result;
    });
    second.resolve();
    await secondStart;
    await Promise.resolve();
    expect(cancelSettled).toBe(false);

    first.resolve();
    await firstStart;
    await expect(cancel).resolves.toBe(true);
    expect(storage.pendingLocalModelSelection).toBeNull();
  });

  it('cleans up an externally cleared pending download but ignores a stale same-model event', async () => {
    const download = deferred();
    const manager = makeManager(vi.fn(async () => download.promise));
    await manager.select('target');
    const start = manager.start('target');
    await vi.waitFor(() => expect(storage.pendingLocalModelSelection?.operationId).toBe('op-2'));
    const cleared = storage.pendingLocalModelSelection!;
    storage.pendingLocalModelSelection = null;

    const cleanup = manager.cancelClearedSelection(cleared);
    download.resolve();
    await start;
    await expect(cleanup).resolves.toBe(true);
    expect(statuses.target).toEqual({ state: 'not_downloaded' });

    await manager.select('target');
    const restarted = manager.start('target');
    await vi.waitFor(() => expect(storage.pendingLocalModelSelection?.operationId).toBe('op-4'));
    await expect(manager.cancelClearedSelection(cleared)).resolves.toBe(false);
    expect(storage.pendingLocalModelSelection?.operationId).toBe('op-4');
    // This prefetch reuses the already-resolved test promise and completes;
    // leave the manager fully settled for timer cleanup.
    await restarted;
  });

  it('reconciles a complete pending cache after restart, but leaves partial work pending', async () => {
    storage.pendingLocalModelSelection = {
      modelId: 'target', modelKey: 'local:target', operationId: 'dead-worker',
    } satisfies PendingLocalModelSelection;
    const manager = makeManager();

    await manager.reconcile();
    expect(storage.selectedModel).toBe('local:active');
    expect(storage.pendingLocalModelSelection).toMatchObject({ modelId: 'target', operationId: 'op-1' });

    cached.add('target');
    await manager.reconcile();
    expect(storage.selectedModel).toBe('local:target');
    expect(storage.pendingLocalModelSelection).toBeNull();
  });
});

describe('supersededPendingSelection', () => {
  const pending: PendingLocalModelSelection = {
    modelId: 'target', modelKey: 'local:target', operationId: 'op-1',
  };

  it('returns an atomically cleared choice when selection switched elsewhere', () => {
    expect(supersededPendingSelection(pending, null, 'local:active')).toBe(pending);
  });

  it('ignores the atomic clear that promotes the completed target', () => {
    expect(supersededPendingSelection(pending, null, 'local:target')).toBeNull();
  });
});
