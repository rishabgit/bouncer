// Staged local-model switching. Downloads the target into the browser cache
// without touching the active GPU engine, then promotes it to selectedModel.

import type { LocalModelDef, LocalModelStatus, PendingLocalModelSelection } from '../types';
import { PREDEFINED_MODELS } from '../shared/models';
import { getStorage, setStorage } from '../shared/storage';
import { prefetchWebllmModel } from './backends/webllm-backend';
import { prefetchLitertlmModel } from './backends/litertlm-backend';
import type { InitProgress } from './backends/types';
import { localEngine } from './local-model';

const DOWNLOAD_KEEP_ALIVE_MS = 20_000;

export interface PendingSelectionResult {
  success: boolean;
  activated?: boolean;
  pending?: PendingLocalModelSelection | null;
  error?: string;
}

/** Return the persisted choice that an atomic storage write superseded. A
 *  cache-complete promotion writes selectedModel to that choice's modelKey in
 *  the same batch and must not be mistaken for cancellation. */
export function supersededPendingSelection(
  oldPending: PendingLocalModelSelection | null | undefined,
  newPending: PendingLocalModelSelection | null | undefined,
  newSelectedModel: string | undefined,
): PendingLocalModelSelection | null {
  if (!oldPending || newPending) return null;
  return newSelectedModel === oldPending.modelKey ? null : oldPending;
}

interface PendingSelectionDeps {
  read: typeof getStorage;
  write: typeof setStorage;
  isCached: (modelId: string) => Promise<boolean>;
  updateStatus: (modelId: string, status: LocalModelStatus) => Promise<void>;
  prefetch: (
    modelDef: LocalModelDef,
    onProgress: (progress: InitProgress) => void,
    abortSignal: AbortSignal,
  ) => Promise<void>;
  resolveModel: (modelId: string) => LocalModelDef;
  makeOperationId: () => string;
  keepAlive: () => void;
}

function defaultOperationId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const defaultDeps: PendingSelectionDeps = {
  read: getStorage,
  write: setStorage,
  isCached: modelId => localEngine.checkCached(modelId),
  updateStatus: (modelId, status) => localEngine.updateStatus(modelId, status),
  prefetch: (modelDef, onProgress, abortSignal) => modelDef.backend === 'litertlm'
    ? prefetchLitertlmModel(modelDef, onProgress, abortSignal)
    : prefetchWebllmModel(modelDef, onProgress, abortSignal),
  resolveModel: modelId => PREDEFINED_MODELS.local.find(model => model.name === modelId)
    ?? ({ name: modelId, display: modelId, backend: 'webllm' } as LocalModelDef),
  makeOperationId: defaultOperationId,
  keepAlive: () => { void chrome.storage.local.get('_keepAlive'); },
};

export class PendingLocalModelSelectionManager {
  private readonly deps: PendingSelectionDeps;
  private generation = 0;
  private activeModelId: string | null = null;
  private activeOperationId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private readonly unsettledDownloads = new Map<string, Set<Promise<boolean>>>();
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private transitionChain: Promise<unknown> = Promise.resolve();

  constructor(deps: Partial<PendingSelectionDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  private transition<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transitionChain.catch(() => undefined).then(operation);
    this.transitionChain = next.catch(() => undefined);
    return next;
  }

  private invalidateActiveDownload(): number {
    const generation = ++this.generation;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.activeModelId = null;
    this.activeOperationId = null;
    this.stopKeepAlive();
    return generation;
  }

  private trackDownload(modelId: string, operation: Promise<boolean>): void {
    const downloads = this.unsettledDownloads.get(modelId) ?? new Set<Promise<boolean>>();
    downloads.add(operation);
    this.unsettledDownloads.set(modelId, downloads);
    const clear = (): void => {
      downloads.delete(operation);
      if (downloads.size === 0) this.unsettledDownloads.delete(modelId);
    };
    void operation.then(clear, clear);
  }

  private async waitForDownloads(modelId?: string): Promise<void> {
    for (;;) {
      const pending = modelId
        ? [...(this.unsettledDownloads.get(modelId) ?? [])]
        : [...this.unsettledDownloads.values()].flatMap(downloads => [...downloads]);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private isCurrent(generation: number, signal?: AbortSignal): boolean {
    return generation === this.generation && !signal?.aborted;
  }

  private startKeepAlive(): void {
    if (this.keepAliveInterval) return;
    this.keepAliveInterval = setInterval(this.deps.keepAlive, DOWNLOAD_KEEP_ALIVE_MS);
  }

  private stopKeepAlive(): void {
    if (!this.keepAliveInterval) return;
    clearInterval(this.keepAliveInterval);
    this.keepAliveInterval = null;
  }

  /** Stage a picker choice. Cached targets activate immediately; uncached
   *  targets become pending while selectedModel (and its engine) stay put. */
  async select(modelId: string): Promise<PendingSelectionResult> {
    if (!modelId) return { success: false, error: 'No model ID provided' };
    const generation = this.invalidateActiveDownload();
    const operationId = this.deps.makeOperationId();

    return this.transition(async () => {
      if (!this.isCurrent(generation)) return { success: false, error: 'Selection superseded' };
      const data = await this.deps.read(['selectedModel', 'pendingLocalModelSelection']);
      if (!this.isCurrent(generation)) return { success: false, error: 'Selection superseded' };

      const previous = data.pendingLocalModelSelection;
      if (previous && previous.modelId !== modelId) {
        const previousCached = await this.deps.isCached(previous.modelId);
        if (!this.isCurrent(generation)) return { success: false, error: 'Selection superseded' };
        await this.deps.updateStatus(previous.modelId, { state: previousCached ? 'cached' : 'not_downloaded' });
      }

      const modelKey = `local:${modelId}`;
      if (data.selectedModel === modelKey) {
        await this.deps.write({ pendingLocalModelSelection: null });
        return { success: true, activated: true, pending: null };
      }

      const cached = await this.deps.isCached(modelId);
      if (!this.isCurrent(generation)) return { success: false, error: 'Selection superseded' };
      if (cached) {
        await this.deps.updateStatus(modelId, { state: 'cached' });
        if (!this.isCurrent(generation)) return { success: false, error: 'Selection superseded' };
        await this.deps.write({ selectedModel: modelKey, pendingLocalModelSelection: null });
        return { success: true, activated: true, pending: null };
      }

      const pending: PendingLocalModelSelection = { modelId, modelKey, operationId };
      await this.deps.updateStatus(modelId, { state: 'not_downloaded' });
      if (!this.isCurrent(generation)) return { success: false, error: 'Selection superseded' };
      await this.deps.write({ pendingLocalModelSelection: pending });
      return { success: true, activated: false, pending };
    });
  }

  /** Begin or resume the staged cache-only download. Resolves when the download
   *  finishes, but callers should fire-and-forget so a runtime message channel
   *  is not held open for several gigabytes. */
  start(modelId: string): Promise<boolean> {
    const operation = this.runStart(modelId);
    this.trackDownload(modelId, operation);
    return operation;
  }

  private async runStart(modelId: string): Promise<boolean> {
    if (!modelId) return false;
    const generation = ++this.generation;
    this.activeAbortController?.abort();
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.activeModelId = modelId;
    const operationId = this.deps.makeOperationId();
    this.activeOperationId = operationId;

    const canStart = await this.transition(async () => {
      if (!this.isCurrent(generation, controller.signal)) return false;
      const data = await this.deps.read(['pendingLocalModelSelection']);
      if (!this.isCurrent(generation, controller.signal)) return false;
      if (data.pendingLocalModelSelection?.modelId !== modelId) return false;
      const pending: PendingLocalModelSelection = {
        modelId,
        modelKey: `local:${modelId}`,
        operationId,
      };
      await this.deps.write({ pendingLocalModelSelection: pending });
      if (!this.isCurrent(generation, controller.signal)) return false;
      await this.deps.updateStatus(modelId, { state: 'downloading', progress: 0, text: 'Starting download...' });
      return this.isCurrent(generation, controller.signal);
    });

    if (!canStart) {
      if (this.generation === generation) {
        this.activeAbortController = null;
        this.activeModelId = null;
        this.activeOperationId = null;
      }
      return false;
    }

    this.startKeepAlive();
    const modelDef = this.deps.resolveModel(modelId);
    let lastProgressWrite = 0;

    try {
      await this.deps.prefetch(modelDef, progress => {
        if (!this.isCurrent(generation, controller.signal)) return;
        const now = Date.now();
        if (progress.progress < 1 && now - lastProgressWrite < 250) return;
        lastProgressWrite = now;
        void this.deps.updateStatus(modelId, {
          state: 'downloading',
          progress: progress.progress,
          text: progress.text,
        });
      }, controller.signal);

      await this.transition(async () => {
        if (!this.isCurrent(generation, controller.signal)) return;
        const cached = await this.deps.isCached(modelId);
        if (!this.isCurrent(generation, controller.signal)) return;
        if (!cached) throw new Error('Model download completed without a complete cache');

        const data = await this.deps.read(['pendingLocalModelSelection']);
        if (!this.isCurrent(generation, controller.signal)) return;
        if (data.pendingLocalModelSelection?.operationId !== operationId) return;

        await this.deps.updateStatus(modelId, { state: 'cached' });
        if (!this.isCurrent(generation, controller.signal)) return;
        // Invoked synchronously after the last token check. A newer picker
        // transition increments generation before it can enqueue its own write,
        // so stale completions cannot promote their target.
        await this.deps.write({
          selectedModel: `local:${modelId}`,
          pendingLocalModelSelection: null,
        });
      });
    } catch (error) {
      if (this.isCurrent(generation, controller.signal)) {
        await this.transition(async () => {
          if (!this.isCurrent(generation, controller.signal)) return;
          await this.deps.updateStatus(modelId, { state: 'error', error: (error as Error).message });
        });
      }
    } finally {
      if (this.generation === generation) {
        this.activeAbortController = null;
        this.activeModelId = null;
        this.activeOperationId = null;
        this.stopKeepAlive();
      }
    }
    return true;
  }

  /** Cancel only the matching pending target. Partial artifacts remain safely
   *  resumable, but the pending picker state is cleared. */
  async cancel(modelId?: string): Promise<boolean> {
    // A superseded transfer for model A can still be settling while model B
    // is the active pending choice. Deleting A must wait for every old A write
    // without aborting B.
    if (modelId && this.activeModelId && this.activeModelId !== modelId) {
      await this.waitForDownloads(modelId);
      return false;
    }
    const generation = this.invalidateActiveDownload();
    // Cache.put() is asynchronous. Wait for the aborted write to settle before
    // deleteLocalModel can proceed, otherwise a late put could resurrect bytes
    // immediately after the cache was deleted.
    await this.waitForDownloads(modelId);
    return this.transition(async () => {
      const data = await this.deps.read(['pendingLocalModelSelection']);
      const pending = data.pendingLocalModelSelection;
      if (!pending || (modelId && pending.modelId !== modelId)) return false;
      const cached = await this.deps.isCached(pending.modelId);
      if (!this.isCurrent(generation)) return false;
      await this.deps.updateStatus(pending.modelId, { state: cached ? 'cached' : 'not_downloaded' });
      if (!this.isCurrent(generation)) return false;
      await this.deps.write({ pendingLocalModelSelection: null });
      return true;
    });
  }

  /** Complete cancellation after another component atomically cleared the
   *  persisted pending record. Operation IDs prevent an old storage event from
   *  canceling a newly restarted download of the same model. */
  async cancelClearedSelection(cleared: PendingLocalModelSelection): Promise<boolean> {
    if (this.activeModelId === cleared.modelId && this.activeOperationId !== cleared.operationId) {
      return false;
    }
    if (this.activeModelId && this.activeModelId !== cleared.modelId) {
      await this.waitForDownloads(cleared.modelId);
      return false;
    }

    const generation = this.invalidateActiveDownload();
    await this.waitForDownloads(cleared.modelId);
    return this.transition(async () => {
      const data = await this.deps.read(['pendingLocalModelSelection']);
      // A newer choice appeared after the clearing event; leave it and its
      // authoritative downloading status untouched.
      if (data.pendingLocalModelSelection) return false;
      const cached = await this.deps.isCached(cleared.modelId);
      if (!this.isCurrent(generation)) return false;
      await this.deps.updateStatus(cleared.modelId, { state: cached ? 'cached' : 'not_downloaded' });
      return true;
    });
  }

  /** Recover a persisted pending choice after a service-worker restart. A
   *  complete cache is promoted; a partial cache remains pending for an
   *  explicit resume so no multi-GB transfer starts unexpectedly. */
  async reconcile(): Promise<void> {
    const generation = this.invalidateActiveDownload();
    const operationId = this.deps.makeOperationId();
    await this.transition(async () => {
      const data = await this.deps.read(['selectedModel', 'pendingLocalModelSelection']);
      const pending = data.pendingLocalModelSelection;
      if (!pending) return;
      if (data.selectedModel === pending.modelKey) {
        await this.deps.write({ pendingLocalModelSelection: null });
        return;
      }

      const cached = await this.deps.isCached(pending.modelId);
      if (!this.isCurrent(generation)) return;
      await this.deps.updateStatus(pending.modelId, { state: cached ? 'cached' : 'not_downloaded' });
      if (!this.isCurrent(generation)) return;
      if (cached) {
        await this.deps.write({ selectedModel: pending.modelKey, pendingLocalModelSelection: null });
      } else {
        await this.deps.write({
          pendingLocalModelSelection: { ...pending, operationId },
        });
      }
    });
  }

  teardown(): void {
    this.invalidateActiveDownload();
  }
}

export const pendingLocalModelSelectionManager = new PendingLocalModelSelectionManager();
