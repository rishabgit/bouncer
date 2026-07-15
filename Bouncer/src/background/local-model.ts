// Local model orchestrator: lifecycle, status, queue, keep-alive, preemption.
// Model-specific calls are delegated to a pluggable LocalBackend.

import type { LocalModelDef, LocalModelStatus, EvaluationPostData, ChatMessage } from '../types';
import { PREDEFINED_MODELS } from '../shared/models';
import { isGPUDeviceLostError, isNetworkError, formatLocalInferenceResult } from '../shared/utils';
import type { LocalPromptMode } from '../shared/prompts';
import { parseTableYesnoResponse } from '../shared/table-yesno';
import { buildTableYesnoRequest } from '../shared/table-yesno-request';
import { inferenceQueue } from './inference-queue';
import { getStorage, setStorage } from '../shared/storage';
import type { LocalBackend } from './backends/types';
import {
  LitertlmBackend,
  isLitertlmCached,
  deleteLitertlmCache,
  forceCloseLitertlmOffscreen,
} from './backends/litertlm-backend';

export { parseTableYesnoResponse } from '../shared/table-yesno';

declare global {
  interface Navigator {
    gpu?: unknown;
  }
}

// ==================== Constants ====================

const KEEP_ALIVE_INTERVAL_MS = 5000;
// Chrome MV3 and Firefox event pages can suspend during long local-model
// downloads unless an extension API is touched more frequently than their
// ~30s idle ceilings. Keep this comfortably below that boundary.
const DOWNLOAD_KEEP_ALIVE_MS = 5000;
const IDLE_TIMEOUT_MS = 60000;
// Cold LiteRT-LM inference (first call after load) compiles WebGPU shaders,
// prefills, and decodes — easily 30–60 s on a 4B model before the first token.
const LITERTLM_INFERENCE_TIMEOUT_MS = 90000;
const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2000;
const CANCEL_SETTLE_TIMEOUT_MS = 3000;
export const MODEL_MAINTENANCE_ERROR = 'Local model maintenance in progress';

interface InferenceBackendLease {
  countTokens(text: string): Promise<number>;
  truncateText(text: string, maxTokens: number): Promise<string>;
  generate(messages: ChatMessage[], maxTokens: number): Promise<string>;
}

// ==================== Pure helpers ====================

function resolveModel(modelId: string): LocalModelDef {
  const modelDef = PREDEFINED_MODELS.local.find(model => model.name === modelId);
  if (!modelDef) throw new Error(`Unknown local model: ${modelId}`);
  return modelDef;
}

// Probe whether a model's weights are already on disk, without loading them.
async function backendIsCached(modelDef: LocalModelDef): Promise<boolean> {
  return isLitertlmCached(modelDef);
}

// ==================== LocalEngine ====================

export class LocalEngine {
  // The active backend. Null when no model is loaded. Named `engine` for
  // backward compatibility with call sites that check it for truthiness.
  engine: LocalBackend | null;
  loadedModel: string | null;
  _modelConfig: LocalModelDef | null;

  // Initialization tracking
  _initializingModel: string | null;
  _initPromise: Promise<LocalBackend | null> | null;
  _initPromiseResolve: ((backend: LocalBackend | null) => void) | null;
  _initAbortController: AbortController | null;
  _initGeneration: number;
  _activeInitGeneration: number | null;
  _initSettledGeneration: number | null;
  _initSettledPromise: Promise<void> | null;
  _initSettledResolve: (() => void) | null;
  _statusWriteChain: Promise<void>;

  // Keep-alive and idle timeout
  _keepAliveInterval: ReturnType<typeof setInterval> | null;
  _downloadKeepAliveInterval: ReturnType<typeof setInterval> | null;
  _idleTimeoutId: ReturnType<typeof setTimeout> | null;

  // Preemption state
  _preempted: boolean;
  _interruptSettledPromise: Promise<void> | null;
  _maintenance: boolean;
  _maintenanceGeneration: number;
  // Includes prompt preparation (token counting/truncation), not only decode.
  // Maintenance and the idle timer must treat the whole backend interaction as
  // one operation because LiteRT cannot be unloaded between those steps.
  _activeModelOperations: number;
  _activityGeneration: number;
  _terminalErrorModels: Set<string>;

  constructor() {
    this.engine = null;
    this.loadedModel = null;
    this._modelConfig = null;

    this._initializingModel = null;
    this._initPromise = null;
    this._initPromiseResolve = null;
    this._initAbortController = null;
    this._initGeneration = 0;
    this._activeInitGeneration = null;
    this._initSettledGeneration = null;
    this._initSettledPromise = null;
    this._initSettledResolve = null;
    this._statusWriteChain = Promise.resolve();

    this._keepAliveInterval = null;
    this._downloadKeepAliveInterval = null;
    this._idleTimeoutId = null;

    this._preempted = false;
    this._interruptSettledPromise = null;
    this._maintenance = false;
    this._maintenanceGeneration = 0;
    this._activeModelOperations = 0;
    this._activityGeneration = 0;
    this._terminalErrorModels = new Set();
  }

  // ---- State queries ----

  isInitializing(): boolean { return this._initializingModel !== null; }
  isModelLoaded(modelId: string): boolean { return this.engine !== null && this.loadedModel === modelId; }
  isInitializingModel(modelId: string): boolean { return this._initializingModel === modelId; }
  isMaintaining(): boolean { return this._maintenance; }

  async runMaintenance<T>(fn: () => Promise<T>, prepare?: () => void): Promise<T> {
    if (this._maintenance) throw new Error(MODEL_MAINTENANCE_ERROR);
    this._maintenanceGeneration++;
    this._activityGeneration++;
    this._maintenance = true;
    this._stopIdleTimeout();
    this.preempt();
    try {
      prepare?.();
      return await this.drainQueue(fn);
    } finally {
      this._maintenance = false;
      if (this.engine && this._activeModelOperations === 0) {
        this._resetIdleTimeout();
      }
    }
  }

  // ---- Lifecycle ----

  async ensureLoaded(modelId: string): Promise<void> {
    const maintenanceGeneration = this._maintenanceGeneration;
    this._assertMaintenanceGeneration(maintenanceGeneration);
    await this.syncStatus(modelId);
    this._assertMaintenanceGeneration(maintenanceGeneration);
    if (this._terminalErrorModels.has(modelId)) {
      throw new Error('Local model requires an explicit Retry from the Bouncer popup.');
    }
    if (!this.isModelLoaded(modelId)) {
      const backend = await this.initialize(modelId, maintenanceGeneration, false);
      this._assertMaintenanceGeneration(maintenanceGeneration);
      if (!backend) {
        throw new Error('Local model not available. WebGPU may not be supported or model not downloaded.');
      }
    }
  }

  async initialize(
    modelId: string,
    expectedMaintenanceGeneration = this._maintenanceGeneration,
    explicitRetry = true,
  ): Promise<LocalBackend | null> {
    if (!modelId) {
      console.error('[LocalEngine] No model ID provided');
      return null;
    }

    this._assertMaintenanceGeneration(expectedMaintenanceGeneration);

    // Startup reconciliation may be in flight when the popup sends Retry.
    // Wait for that existing status transaction before observing the fence;
    // do not independently promote a transient same-worker UI error into one.
    if (explicitRetry) {
      await this._statusWriteChain;
      this._assertMaintenanceGeneration(expectedMaintenanceGeneration);
    }

    if (!explicitRetry && this._terminalErrorModels.has(modelId)) {
      throw new Error('Local model requires an explicit Retry from the Bouncer popup.');
    }
    const retryingTerminalError = explicitRetry && this._terminalErrorModels.delete(modelId);

    if (this.isInitializingModel(modelId)) {
      return this._initPromise;
    }

    // Only one backend may initialize at a time. If a different model was
    // requested, supersede the old operation but let its own context settle
    // before starting this one. Re-check in a loop because several model
    // switches can arrive while the first operation is winding down.
    while (this._initSettledPromise) {
      const previousInit = this._initSettledPromise;
      this._initAbortController?.abort();
      await previousInit;
      this._assertMaintenanceGeneration(expectedMaintenanceGeneration);
      if (this.isInitializingModel(modelId)) return this._initPromise;
    }

    // A terminal error can leave a logically loaded proxy whose offscreen
    // engine has disappeared. Retry must rebuild the physical engine instead
    // of publishing that stale proxy as ready again.
    if (retryingTerminalError && this.isModelLoaded(modelId)) {
      await this.reset();
      this._assertMaintenanceGeneration(expectedMaintenanceGeneration);
    }

    if (this.isModelLoaded(modelId)) {
      // An explicit popup retry may be recovering a terminal inference status
      // while the interrupted engine is still usable. Publish a genuine ready
      // transition so error posts are released exactly once.
      await this.updateStatus(modelId, { state: 'ready' });
      return this.engine;
    }

    if (!navigator.gpu) {
      await this.updateStatus(modelId, { state: 'unsupported', reason: 'WebGPU not supported' });
      return null;
    }

    const modelDef = resolveModel(modelId);
    this._assertMaintenanceGeneration(expectedMaintenanceGeneration);

    // Start tracking initialization BEFORE any async work so concurrent callers
    // see isInitializingModel() and wait on _initPromise.
    const initGeneration = this._startInit(modelId);
    const abortSignal = this._initAbortController!.signal;
    this._startDownloadKeepAlive();

    let attemptedBackend: LocalBackend | null = null;
    try {
      // If a different model is loaded, unload it first to free GPU memory.
      // Drain the inference queue so any in-flight task finishes before we dispose the engine.
      if (this.engine && this.loadedModel !== modelId) {
        await this.drainQueue(async () => {
          if (this.engine) {
            try {
              await this.engine.unload();
            } catch (e) {
              console.error('[LocalEngine] Error unloading engine:', e);
            }
          }
          this.engine = null;
          this.loadedModel = null;
          this._modelConfig = null;
          this._stopKeepAlive();
        });
      }

      const backend = new LitertlmBackend();
      attemptedBackend = backend;

      // Retry loop for network errors
      let retryCount = 0;
      while (true) {
        if (abortSignal.aborted) {
          this._completeInit(null, initGeneration);
          return null;
        }

        try {
          await this.updateStatus(modelId, { state: 'initializing', progress: 0, text: retryCount > 0 ? `Retrying (${retryCount}/${DOWNLOAD_MAX_RETRIES})...` : 'Starting...' });

          let lastProgressWrite = 0;
          this._assertMaintenanceGeneration(expectedMaintenanceGeneration);
          await backend.initialize(modelDef, (progress) => {
            if (abortSignal.aborted) return;
            const now = Date.now();
            if (progress.progress < 1 && now - lastProgressWrite < 250) return;
            lastProgressWrite = now;
            this.updateStatus(modelId, {
              // Once bytes reach 100%, the remaining work is cache/GPU startup;
              // do not leave the UI claiming a completed download is in flight.
              state: progress.progress >= 1 ? 'initializing' : 'downloading',
              progress: progress.progress,
              text: progress.text,
            }).catch(err => console.error('[LocalEngine] Failed to update download status:', err));
          }, abortSignal);

          if (abortSignal.aborted) {
            // A force-closed LiteRT host may already have been replaced. Its
            // proxy unload is host-global, so never let a stale generation tear
            // down the replacement document.
            if (backend.unloadAfterSuperseded
                || this._activeInitGeneration === initGeneration) {
              try { await backend.unload(); } catch { /* ignore */ }
            }
            this._completeInit(null, initGeneration);
            return null;
          }

          this.engine = backend;
          this.loadedModel = modelId;
          this._modelConfig = modelDef;

          await this.updateStatus(modelId, { state: 'ready' });
          if (retryingTerminalError) this._terminalErrorModels.delete(modelId);

          // Cancellation can arrive while the serialized storage write above
          // is pending. Do not let that stale operation restart timers or
          // publish an engine after cancel/replacement has won.
          if (abortSignal.aborted || this._activeInitGeneration !== initGeneration) {
            if (this.engine === backend) {
              this.engine = null;
              this.loadedModel = null;
              this._modelConfig = null;
            }
            if (backend.unloadAfterSuperseded
                || this._activeInitGeneration === initGeneration) {
              try { await backend.unload(); } catch { /* ignore */ }
            }
            this._completeInit(null, initGeneration);
            return null;
          }

          this._startKeepAlive();
          this._resetIdleTimeout();
          this._completeInit(this.engine, initGeneration);

          return this.engine;
        } catch (error) {
          const errorMsg = (error as Error).message;

          if (abortSignal.aborted || errorMsg === 'aborted') {
            this._completeInit(null, initGeneration);
            return null;
          }

          if (errorMsg === MODEL_MAINTENANCE_ERROR) {
            this._completeInit(null, initGeneration);
            return null;
          }

          console.error('[LocalEngine] Initialization failed:', error);

          if (isNetworkError(errorMsg) && retryCount < DOWNLOAD_MAX_RETRIES) {
            retryCount++;
            const delay = DOWNLOAD_RETRY_DELAY_MS * Math.pow(2, retryCount - 1);

            await this.updateStatus(modelId, {
              state: 'downloading',
              progress: 0,
              text: `Retrying download (${retryCount}/${DOWNLOAD_MAX_RETRIES})...`
            });

            await new Promise(resolve => setTimeout(resolve, delay));
            if (abortSignal.aborted) {
              this._completeInit(null, initGeneration);
              return null;
            }
            continue;
          }

          let errorMessage = errorMsg;
          if (isGPUDeviceLostError(errorMsg)) {
            errorMessage = 'GPU memory exhausted. Close other GPU-intensive tabs and retry.';
          } else if (isNetworkError(errorMsg)) {
            errorMessage = 'Download failed after multiple retries. Check your internet connection.';
          }

          this._terminalErrorModels.add(modelId);
          await this.updateStatus(modelId, { state: 'error', error: errorMessage });
          if (this.engine !== backend) {
            try { await backend.unload(); } catch { /* best effort */ }
          }
          await this.reset();
          return null;
        }
      }
    } finally {
      // A storage/status failure can escape from inside either the success or
      // recovery path. Always release logical init state, and dispose any
      // backend that was never successfully published, before allowing Retry.
      if (this._activeInitGeneration === initGeneration) {
        if (attemptedBackend && this.engine === attemptedBackend) {
          this.engine = null;
          this.loadedModel = null;
          this._modelConfig = null;
        }
        if (attemptedBackend) {
          try { await attemptedBackend.unload(); } catch { /* best effort */ }
        }
        this._completeInit(null, initGeneration);
      }
      this._settleInitOperation(initGeneration);
    }
  }

  async cancelDownload(modelId: string): Promise<boolean> {
    if (!this.isInitializingModel(modelId)) {
      return false;
    }
    const inFlight = this._initPromise;
    if (this._initAbortController) {
      this._initAbortController.abort();
    }

    // LiteRT owns an offscreen init request that can still emit progress after
    // abort. Give it a bounded window to settle before the terminal status is
    // written.
    resolveModel(modelId);
    if (inFlight) {
      let settled = false;
      let settleTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          inFlight.then(() => { settled = true; }),
          new Promise(resolve => {
            settleTimeout = setTimeout(resolve, CANCEL_SETTLE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (settleTimeout !== null) clearTimeout(settleTimeout);
      }
      if (!settled) {
        const hostWasClosed = await forceCloseLitertlmOffscreen();
        // Closing Chrome's offscreen document terminates the physical engine
        // factory, so a replacement may safely start. Firefox/Safari run the
        // factory in-page; if it cannot be force-closed, keep the physical
        // settlement barrier until that factory actually returns.
        if (hostWasClosed) this._settleInitOperation(this._activeInitGeneration);
      }
    }

    await this.reset();

    const cached = await this.checkCached(modelId);
    await this.updateStatus(modelId, { state: cached ? 'cached' : 'not_downloaded' });
    return true;
  }

  // Delete one model's cached weights from the browser Cache API. Frees the
  // model before wiping it (abort an in-flight download, or unload the engine
  // if this exact model is loaded); a different loaded model keeps running. The
  // actual cache wipe is delegated to the backend; on failure we re-sync status
  // to whatever actually remains in cache.
  async deleteModelCache(modelId: string): Promise<{ success: boolean; error?: string }> {
    if (!modelId) return { success: false, error: 'No model ID provided' };
    let modelDef: LocalModelDef;
    try {
      modelDef = resolveModel(modelId);
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }

    if (this.isInitializingModel(modelId)) {
      await this.cancelDownload(modelId);
      // Wait for the physical worker before deleting, otherwise its late cache
      // writes can resurrect a model immediately after a successful deletion.
      await this._initSettledPromise;
    } else if (this.isModelLoaded(modelId)) {
      await this.reset();
    }

    try {
      await deleteLitertlmCache(modelDef);
      await this.updateStatus(modelId, { state: 'not_downloaded' });
      return { success: true };
    } catch (e) {
      console.error('[LocalEngine] Error deleting model cache for', modelId, ':', e);
      const cached = await this.checkCached(modelId);
      await this.updateStatus(modelId, { state: cached ? 'cached' : 'not_downloaded' });
      return { success: false, error: (e as Error).message };
    }
  }

  // Synchronous teardown for service worker onSuspend: stop timers and null out
  // references without async unload (Chrome kills the worker before it completes).
  teardown(): void {
    this._stopIdleTimeout();
    this._stopKeepAlive();
    this._stopDownloadKeepAlive();
    this.engine = null;
    this.loadedModel = null;
    this._modelConfig = null;
    this._maintenance = false;
  }

  async reset(): Promise<void> {
    this._initAbortController?.abort();
    this._stopIdleTimeout();
    this._stopKeepAlive();
    if (this.engine) {
      try {
        await this.engine.unload();
      } catch (e) {
        console.error('[LocalEngine] Error unloading engine:', e);
      }
    }
    this.engine = null;
    this.loadedModel = null;
    this._modelConfig = null;
    this._initializingModel = null;
    this._initAbortController = null;
    this._preempted = false;
    this._interruptSettledPromise = null;
    this._completeInit(null);
    // reset() is the logical teardown boundary. Do not resolve the separate
    // physical-init barrier here: LiteRT Engine.create cannot always be
    // interrupted, and a replacement must not allocate a second GPU engine
    // until the old factory actually returns. Chrome can force-close the
    // offscreen host in cancelDownload when the bounded wait expires.
  }

  // ---- Inference ----

  // Run a completion: queue, handle preemption, timeout, strip think blocks.
  // The model-specific call (reset, request shape, think-strip) lives in the
  // backend; this method owns the queue, preemption, timeout, and idle reset.
  async generate(
    messages: ChatMessage[],
    maxTokens: number,
    { priority = 0, onStart }: { priority?: number; onStart?: () => void } = {}
  ): Promise<string> {
    return this.runInferenceOperation(async lease => {
      if (onStart) onStart();
      return lease.generate(messages, maxTokens);
    }, { priority });
  }

  // Serialize every interaction with one physical LiteRT backend. Keeping
  // prompt preparation and decode under the same queue lease prevents model
  // deletion/idle unload from disposing the backend between countTokens,
  // truncateText, and generate.
  async runInferenceOperation<T>(
    operation: (lease: InferenceBackendLease) => Promise<T>,
    { priority = 0 }: { priority?: number } = {},
  ): Promise<T> {
    const maintenanceGeneration = this._maintenanceGeneration;
    this._assertMaintenanceGeneration(maintenanceGeneration);
    const backend = this.engine;
    if (!backend) throw new Error('Engine not loaded');

    this._activeModelOperations++;
    this._activityGeneration++;
    this._stopIdleTimeout();
    try {
      return await inferenceQueue.enqueue(async () => {
        // Wait for any previous interrupt() to settle
        if (this._interruptSettledPromise) {
          await this._interruptSettledPromise;
          this._interruptSettledPromise = null;
        }

        this._assertMaintenanceGeneration(maintenanceGeneration);
        if (this.engine !== backend) throw new Error(MODEL_MAINTENANCE_ERROR);
        this._preempted = false;

        const assertLeaseActive = (): void => {
          this._assertMaintenanceGeneration(maintenanceGeneration);
          if (this.engine !== backend) throw new Error(MODEL_MAINTENANCE_ERROR);
          if (this._preempted) throw new Error('Inference preempted');
        };

        const lease: InferenceBackendLease = {
          countTokens: async (text: string) => {
            assertLeaseActive();
            const result = await backend.countTokens(text);
            assertLeaseActive();
            return result;
          },
          truncateText: async (text: string, maxTokens: number) => {
            assertLeaseActive();
            const result = await backend.truncateText(text, maxTokens);
            assertLeaseActive();
            return result;
          },
          generate: async (leaseMessages: ChatMessage[], leaseMaxTokens: number) => {
            assertLeaseActive();
            const result = await this._callWithTimeout(
              backend,
              leaseMessages,
              leaseMaxTokens,
            );
            assertLeaseActive();
            return result;
          },
        };

        try {
          return await operation(lease);
        } catch (error) {
          if ((error as Error).message === MODEL_MAINTENANCE_ERROR) throw error;
          if ((error as Error).message === 'Inference preempted') throw error;
          if (this._preempted) {
            throw new Error('Inference preempted', { cause: error });
          }

          if (isGPUDeviceLostError((error as Error).message)) {
            console.error('[LocalEngine] GPU device lost during inference, resetting engine...');
            const modelId = this.loadedModel;
            if (modelId) this._terminalErrorModels.add(modelId);
            await this.reset();
            await this.updateStatus(modelId!, {
              state: 'error',
              error: 'GPU memory exhausted during inference. Close other GPU-intensive tabs and retry.'
            });
          } else if ((error as Error).message.toLowerCase().includes('inference timeout')) {
            // Do not await LiteRT interrupt/unload here: a stuck prefill is the
            // reason the deadline fired, and both operations can wait on that
            // same executor chain. Fence this backend synchronously and close
            // Chrome's offscreen host out of band so the caller receives the
            // timeout at the promised deadline and Retry starts fresh.
            const modelId = this.loadedModel;
            if (modelId) this._terminalErrorModels.add(modelId);
            if (this.engine === backend) {
              this.engine = null;
              this.loadedModel = null;
              this._modelConfig = null;
              this._stopKeepAlive();
              this._stopIdleTimeout();
            }
            void forceCloseLitertlmOffscreen().catch(closeError =>
              console.error('[LocalEngine] Failed to close timed-out LiteRT host:', closeError)
            );
            if (modelId) {
              void this.updateStatus(modelId, {
                state: 'error',
                error: 'Local inference timed out. Retry from the Bouncer popup.',
              });
            }
          }

          throw error;
        }
      }, { priority });
    } finally {
      this._activeModelOperations--;
      if (this._activeModelOperations === 0 && this.engine && !this._maintenance) {
        this._resetIdleTimeout();
      }
    }
  }

  preempt(): void {
    if (this._preempted) return;
    this._preempted = true;
    if (this.engine) {
      this._interruptSettledPromise = this.engine.interrupt().catch(e =>
        console.error('[Preempt] Failed to interrupt generation:', e)
      );
    }
  }

  // ---- Token counting ----

  async countTokens(text: string): Promise<number> {
    return this.runInferenceOperation(lease => lease.countTokens(text));
  }

  async truncateText(text: string, maxTokens: number): Promise<string> {
    return this.runInferenceOperation(lease => lease.truncateText(text, maxTokens));
  }

  // ---- Queue operations ----

  clearQueue(): void { inferenceQueue.clear(); }
  drainQueue<T>(fn: () => Promise<T>): Promise<T> { return inferenceQueue.drain(fn); }

  // ---- Status helpers ----

  async updateStatus(modelId: string, status: LocalModelStatus): Promise<void> {
    const write = this._statusWriteChain.catch(() => undefined).then(async () => {
      const data = await getStorage(['localModelStatuses']);
      const statuses: Record<string, LocalModelStatus> = { ...(data.localModelStatuses ?? {}) };
      statuses[modelId] = status;
      await setStorage({ localModelStatuses: statuses });

    });
    this._statusWriteChain = write.catch(() => undefined);
    return write;
  }

  async markTerminalError(modelId: string, error: string): Promise<void> {
    this._terminalErrorModels.add(modelId);
    await this.updateStatus(modelId, { state: 'error', error });
  }

  async checkCached(modelId: string): Promise<boolean> {
    return backendIsCached(resolveModel(modelId));
  }

  async syncStatus(modelId: string): Promise<LocalModelStatus | undefined> {
    const sync = this._statusWriteChain.catch(() => undefined).then(async () => {
      const data = await getStorage(['localModelStatuses']);
      const statuses: Record<string, LocalModelStatus> = { ...(data.localModelStatuses ?? {}) };
      const storedStatus = statuses[modelId];

      if (!storedStatus) return storedStatus;

      let needsUpdate = false;

      if (storedStatus.state === 'ready' && !this.isModelLoaded(modelId)) {
        const cached = await this.checkCached(modelId);
        if (!cached) {
          statuses[modelId] = { state: 'not_downloaded' };
          needsUpdate = true;
        } else {
          statuses[modelId] = { state: 'cached' };
          needsUpdate = true;
        }
      }

      if ((storedStatus.state === 'downloading' || storedStatus.state === 'initializing') &&
          !this.isInitializing()) {
        const cached = await this.checkCached(modelId);
        statuses[modelId] = { state: cached ? 'cached' : 'not_downloaded' };
        needsUpdate = true;
      }

      // Error is a durable explicit-Retry fence, not merely a UI snapshot. An
      // MV3 service worker can restart after a timeout/GPU failure and lose all
      // in-memory state while the model remains cached. Rehydrate the fence
      // from storage so the next post cannot silently reload the same model.
      const reconciledStatus = statuses[modelId];
      if (reconciledStatus.state === 'error') {
        this._terminalErrorModels.add(modelId);
      }

      if (needsUpdate) {
        await setStorage({ localModelStatuses: statuses });
      }

      return reconciledStatus;
    });
    this._statusWriteChain = sync.then(() => undefined, () => undefined);
    return sync;
  }

  async syncAllStatuses(): Promise<void> {
    for (const model of PREDEFINED_MODELS.local) {
      await this.syncStatus(model.name);
    }
  }

  // ---- Private: initialization tracking ----

  _assertMaintenanceGeneration(expected: number): void {
    if (this._maintenance || this._maintenanceGeneration !== expected) {
      throw new Error(MODEL_MAINTENANCE_ERROR);
    }
  }

  _startInit(modelId: string): number {
    const generation = ++this._initGeneration;
    this._activeInitGeneration = generation;
    this._initSettledGeneration = generation;
    this._initSettledPromise = new Promise<void>(resolve => {
      this._initSettledResolve = resolve;
    });
    this._initializingModel = modelId;
    this._initAbortController = new AbortController();
    this._initPromise = new Promise<LocalBackend | null>(resolve => {
      this._initPromiseResolve = resolve;
    });
    return generation;
  }

  _completeInit(backend: LocalBackend | null, generation = this._activeInitGeneration): void {
    // A canceled, unabortable backend may finish after a replacement init has
    // started. Only the operation that owns the current generation may clear
    // its promise/controller; stale completions are local cleanup only.
    if (generation === null || generation !== this._activeInitGeneration) return;
    this._initializingModel = null;
    this._initAbortController = null;
    this._activeInitGeneration = null;
    this._stopDownloadKeepAlive();
    if (this._initPromiseResolve) {
      this._initPromiseResolve(backend);
      this._initPromiseResolve = null;
    }
    this._initPromise = null;
  }

  _settleInitOperation(generation: number | null): void {
    if (generation === null || generation !== this._initSettledGeneration) return;
    this._initSettledResolve?.();
    this._initSettledResolve = null;
    this._initSettledPromise = null;
    this._initSettledGeneration = null;
  }

  // ---- Private: keep-alive ----

  _startKeepAlive(): void {
    if (this._keepAliveInterval) return;
    this._keepAliveInterval = setInterval(() => {
      // Chrome MV3 only resets the service-worker idle timer on extension API
      // calls; touching local state is not enough.
      void chrome.storage.local.get('_keepAlive');
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  _stopKeepAlive(): void {
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }
  }

  // Prevent Firefox from suspending the event page during long model downloads.
  // Firefox kills event pages after 30 s of no extension-API activity; plain
  // fetch() doesn't count.  A periodic chrome.storage read resets the timer.
  _startDownloadKeepAlive(): void {
    if (this._downloadKeepAliveInterval) return;
    this._downloadKeepAliveInterval = setInterval(() => {
      void chrome.storage.local.get('_keepAlive');
    }, DOWNLOAD_KEEP_ALIVE_MS);
  }

  _stopDownloadKeepAlive(): void {
    if (this._downloadKeepAliveInterval) {
      clearInterval(this._downloadKeepAliveInterval);
      this._downloadKeepAliveInterval = null;
    }
  }

  // ---- Private: idle timeout ----

  _resetIdleTimeout(): void {
    if (this._idleTimeoutId !== null) {
      clearTimeout(this._idleTimeoutId);
    }
    // Give every armed deadline its own lease. This also distinguishes a new
    // timer from an older callback that was already queued before clearTimeout.
    const activityGeneration = ++this._activityGeneration;
    this._idleTimeoutId = setTimeout(
      () => { void this._onIdleTimeout(activityGeneration); },
      IDLE_TIMEOUT_MS,
    );
  }

  _stopIdleTimeout(): void {
    if (this._idleTimeoutId !== null) {
      clearTimeout(this._idleTimeoutId);
      this._idleTimeoutId = null;
    }
  }

  async _onIdleTimeout(activityGeneration: number): Promise<void> {
    // A callback that was already queued before clearTimeout() can run after a
    // newer deadline is armed. Do not let that stale callback erase the newer
    // timer handle.
    if (activityGeneration !== this._activityGeneration) return;
    this._idleTimeoutId = null;
    if (this._activeModelOperations > 0
        || !this.engine
        || this._maintenance) return;

    try {
      await this.runMaintenance(async () => {
        // runMaintenance blocks new leases before it owns the queue. The active
        // operation check protects against a stale callback defensively.
        if (this._activeModelOperations > 0 || !this.engine) return;
        const modelId = this.loadedModel;
        try {
          await this.engine.unload();
        } catch (e) {
          console.error('[LocalEngine] Error during idle unload:', e);
        }
        this.engine = null;
        this.loadedModel = null;
        this._modelConfig = null;
        this._stopKeepAlive();
        if (modelId) {
          await this.updateStatus(modelId, { state: 'cached' });
        }
      });
    } catch (e) {
      // A timer callback may already be queued when another maintenance starts.
      // That maintenance owns the lifecycle and will re-arm the idle deadline
      // in its finally block if it leaves the engine loaded.
      if ((e as Error).message !== MODEL_MAINTENANCE_ERROR) {
        console.error('[LocalEngine] Error during idle maintenance:', e);
      }
    }
  }

  // ---- Private: inference timeout ----

  _callWithTimeout(
    backend: LocalBackend,
    messages: ChatMessage[],
    maxTokens: number,
    timeoutMs?: number,
  ): Promise<string> {
    const ceiling = timeoutMs ?? LITERTLM_INFERENCE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let completed = false;

      const onTimeout = (): void => {
        if (completed) return;
        completed = true;
        console.warn(`[LocalEngine] Inference timeout after ${ceiling}ms, interrupting...`);
        reject(new Error('Inference timeout - model took too long to respond'));
        // Cleanup is best effort and deliberately detached. LiteRT's interrupt
        // waits for its executor chain, which is allowed to be the stuck work.
        void backend.interrupt().catch(e => {
          console.error('[LocalEngine] Failed to interrupt generation:', e);
        });
      };
      const timeoutId = setTimeout(() => { void onTimeout(); }, ceiling);

      backend.generate(messages, maxTokens)
        .then(result => {
          if (completed) return;
          completed = true;
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          if (completed) return;
          completed = true;
          clearTimeout(timeoutId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}

// ==================== Singleton & exports ====================

export const localEngine = new LocalEngine();

// ==================== Post inference orchestration ====================

// Orchestrates local inference for a single post: builds the prompt, calls
// generate, and parses the response. This is the post-filtering-specific
// wrapper around localEngine.generate().
export async function callLocalInference(
  postData: EvaluationPostData,
  bannedCategories: string[],
  modelConfig: LocalModelDef | null,
  modelId: string,
  { priority = 0, onInferenceStart, promptMode = 'baseline' }: {
    priority?: number;
    onInferenceStart?: () => void;
    promptMode?: LocalPromptMode;
  } = {}
): Promise<{ shouldHide: boolean; reasoning: string; category?: string | null; rawResponse?: string | null; inferenceTime?: number }> {
  await localEngine.ensureLoaded(modelId);
  const resolved = modelConfig ?? resolveModel(modelId);
  if (resolved.name !== modelId) throw new Error(`Model config mismatch: ${modelId}`);
  return callTableYesnoInference(
    postData,
    bannedCategories,
    resolved,
    { priority, onInferenceStart, promptMode },
  );
}

// table_yesno path (LiteRT-LM/Gemma): one pipe-delimited yes/no row per
// category — far fewer output tokens than a reasoning sentence. Matched
// categories are surfaced in `category` (comma-joined) so the filtered-posts
// UI renders one chip per match.
async function callTableYesnoInference(
  postData: EvaluationPostData,
  bannedCategories: string[],
  modelConfig: LocalModelDef,
  { priority = 0, onInferenceStart, promptMode = 'baseline' }: {
    priority?: number;
    onInferenceStart?: () => void;
    promptMode?: LocalPromptMode;
  } = {}
): Promise<{ shouldHide: boolean; reasoning: string; category?: string | null; rawResponse?: string | null; inferenceTime?: number }> {
  const contextWindowSize = modelConfig.litertlmConfig?.maxTokens ?? 1024;
  const buildRequest = (postText: string) =>
    buildTableYesnoRequest(postText, bannedCategories, promptMode);
  // Leave room for Gemma's occasional markdown/newline drift; the runtime
  // enforces this budget through sessionConfig.maxOutputTokens.
  const maxGenerationTokens = buildRequest('').maxOutputTokens;

  let inferenceStart: number;
  const onStart = (): void => {
    if (onInferenceStart) onInferenceStart();
    inferenceStart = Date.now();
  };

  const rawResponse = await localEngine.runInferenceOperation(async lease => {
    const overheadText = buildRequest('').messages
      .map(message => message.content)
      .join('\n');
    const overheadTokens = await lease.countTokens(overheadText);
    const postTextBudget = contextWindowSize - overheadTokens - maxGenerationTokens;
    const postText = postTextBudget > 0
      ? await lease.truncateText(postData.text, postTextBudget)
      : '';

    onStart();
    return lease.generate(
      buildRequest(postText).messages,
      maxGenerationTokens,
    );
  }, { priority });

  const inferenceTime = ((Date.now() - inferenceStart!) / 1000).toFixed(2);

  if (!rawResponse) {
    console.warn('[LocalEngine] Empty response from model');
  }

  const { shouldHide, reasoning, matches } = parseTableYesnoResponse(rawResponse, bannedCategories);
  const formatted = formatLocalInferenceResult(reasoning, shouldHide);
  return {
    shouldHide: formatted.shouldHide,
    reasoning: formatted.reasoning,
    category: matches.length > 0 ? matches.join(', ') : null,
    rawResponse,
    inferenceTime: parseFloat(inferenceTime),
  };
}
