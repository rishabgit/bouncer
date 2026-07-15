// Local model orchestrator: lifecycle, status, queue, keep-alive, preemption.
// Model-specific calls are delegated to a pluggable LocalBackend.

import type { LocalModelDef, LocalModelStatus, EvaluationPostData, ChatMessage } from '../types';
import { PREDEFINED_MODELS } from '../shared/models';
import { isGPUDeviceLostError, isNetworkError, formatLocalInferenceResult } from '../shared/utils';
import {
  buildLocalUserMessage,
  buildSingleYesnoUserMessage,
  buildTableYesnoUserMessage,
  localSystemPrompt,
  tableYesnoSingleSystemPrompt,
  tableYesnoSystemPrompt,
  type LocalPromptMode,
} from '../shared/prompts';
import { parseTableYesnoResponse } from '../shared/table-yesno';
import { inferenceQueue } from './inference-queue';
import { getStorage, setStorage } from '../shared/storage';
import type { LocalBackend } from './backends/types';
import type { CompletionUsage } from '@mlc-ai/web-llm';
import { WebllmBackend, isWebllmCached, deleteWebllmCache } from './backends/webllm-backend';
import {
  LitertlmBackend,
  isLitertlmCached,
  deleteLitertlmCache,
  forceCloseLitertlmOffscreen,
} from './backends/litertlm-backend';

// Re-exported so existing importers (and tests) keep their import path.
export { buildModelConfig } from './backends/webllm-backend';
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
const INFERENCE_TIMEOUT_MS = 30000;
// Cold LiteRT-LM inference (first call after load) compiles WebGPU shaders,
// prefills, and decodes — easily 30–60 s on a 4B model before the first token.
const LITERTLM_INFERENCE_TIMEOUT_MS = 90000;
const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2000;
const CANCEL_SETTLE_TIMEOUT_MS = 3000;

// ==================== Pure helpers ====================

// Pick the backend for a model by its declared engine. Models with no backend
// (custom/user-added) default to WebLLM.
function selectBackend(modelDef: LocalModelDef): LocalBackend {
  return modelDef.backend === 'litertlm' ? new LitertlmBackend() : new WebllmBackend();
}

// Probe whether a model's weights are already on disk, without loading them.
async function backendIsCached(modelDef: LocalModelDef): Promise<boolean> {
  return modelDef.backend === 'litertlm' ? isLitertlmCached(modelDef) : isWebllmCached(modelDef);
}

// Parse a local model's freeform response to extract a hide/show decision and reasoning.
// Uses last-index-wins: if "Matches <topic>" appears after any "No match", it's a hide.
export function parseLocalModelResponse(rawResponse: string | null): { shouldHide: boolean; reasoning: string } {
  if (!rawResponse) {
    return { shouldHide: false, reasoning: 'Empty model response — model returned no output' };
  }

  let reasoning = rawResponse;
  let shouldHide = false;

  const lower = rawResponse.toLowerCase();
  const matchesIdx = lower.lastIndexOf('matches ');
  const noMatchIdx = lower.lastIndexOf('no match');
  if (matchesIdx !== -1 && matchesIdx > noMatchIdx) {
    shouldHide = true;
    const matchedTopic = rawResponse.slice(matchesIdx + 'matches '.length).replace(/\.$/, '').trim();
    reasoning = matchedTopic ? `${rawResponse} (Matched: ${matchedTopic})` : rawResponse;
  }

  return { shouldHide, reasoning };
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
  }

  // ---- State queries ----

  isInitializing(): boolean { return this._initializingModel !== null; }
  isModelLoaded(modelId: string): boolean { return this.engine !== null && this.loadedModel === modelId; }
  isInitializingModel(modelId: string): boolean { return this._initializingModel === modelId; }

  // Dev benchmark only: token + timing stats from the loaded backend's last
  // completion. WebLLM returns its `usage`; LiteRT-LM has no such method, so the
  // optional-chained call yields null.
  getLastUsage(): CompletionUsage | null { return this.engine?.getLastUsage?.() ?? null; }

  // ---- Lifecycle ----

  async ensureLoaded(modelId: string): Promise<void> {
    await this.syncStatus(modelId);
    if (!this.isModelLoaded(modelId)) {
      const backend = await this.initialize(modelId);
      if (!backend) {
        throw new Error('Local model not available. WebGPU may not be supported or model not downloaded.');
      }
    }
  }

  async initialize(modelId: string): Promise<LocalBackend | null> {
    if (!modelId) {
      console.error('[LocalEngine] No model ID provided');
      return null;
    }

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
      if (this.isInitializingModel(modelId)) return this._initPromise;
    }

    if (this.isModelLoaded(modelId)) {
      return this.engine;
    }

    if (!navigator.gpu) {
      await this.updateStatus(modelId, { state: 'unsupported', reason: 'WebGPU not supported' });
      return null;
    }

    // Resolve the model definition. `_modelConfig` keeps the historical
    // "found-or-null" value; the backend always gets a non-null def so a
    // user-added/custom model id still resolves via the prebuilt registry.
    const modelDef = PREDEFINED_MODELS.local.find(m => m.name === modelId) || null;
    const backendModelDef = modelDef ?? ({ name: modelId } as LocalModelDef);

    // Start tracking initialization BEFORE any async work so concurrent callers
    // see isInitializingModel() and wait on _initPromise.
    const initGeneration = this._startInit(modelId);
    const abortSignal = this._initAbortController!.signal;
    this._startDownloadKeepAlive();

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

      const backend = selectBackend(backendModelDef);

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
          await backend.initialize(backendModelDef, (progress) => {
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
            // down the replacement document. WebLLM unload targets only this
            // backend instance and is always safe cleanup.
            if (backendModelDef.backend !== 'litertlm'
                || backend.unloadAfterSuperseded
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

          // Cancellation can arrive while the serialized storage write above
          // is pending. Do not let that stale operation restart timers or
          // publish an engine after cancel/replacement has won.
          if (abortSignal.aborted || this._activeInitGeneration !== initGeneration) {
            if (this.engine === backend) {
              this.engine = null;
              this.loadedModel = null;
              this._modelConfig = null;
            }
            if (backendModelDef.backend !== 'litertlm'
                || backend.unloadAfterSuperseded
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
            errorMessage = 'GPU memory exhausted. Try a smaller model or close other GPU-intensive tabs.';
          } else if (isNetworkError(errorMsg)) {
            errorMessage = 'Download failed after multiple retries. Check your internet connection.';
          }

          await this.updateStatus(modelId, { state: 'error', error: errorMessage });
          await this.reset();
          return null;
        }
      }
    } finally {
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
    // written. WebLLM's callback checks the same signal synchronously and its
    // engine factory is not abortable, so waiting there would only add delay.
    const modelDef = PREDEFINED_MODELS.local.find(model => model.name === modelId);
    if (inFlight && modelDef?.backend === 'litertlm') {
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

    if (this.isInitializingModel(modelId)) {
      await this.cancelDownload(modelId);
      // WebLLM's engine factory cannot be externally interrupted. Wait for
      // the physical worker before deleting, otherwise its late cache writes
      // can resurrect a model immediately after a successful deletion.
      await this._initSettledPromise;
    } else if (this.isModelLoaded(modelId)) {
      await this.reset();
    }

    try {
      const modelDef = PREDEFINED_MODELS.local.find(m => m.name === modelId) ?? ({ name: modelId } as LocalModelDef);
      await (modelDef.backend === 'litertlm' ? deleteLitertlmCache(modelDef) : deleteWebllmCache(modelDef));
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
    // physical-init barrier here: WebLLM and direct LiteRT engine factories
    // cannot always be interrupted, and a replacement must not allocate a
    // second GPU engine until the old factory actually returns. A Chrome
    // offscreen force-close explicitly settles that barrier in cancelDownload.
  }

  // ---- Inference ----

  // Run a completion: queue, handle preemption, timeout, strip think blocks.
  // The model-specific call (reset, request shape, think-strip) lives in the
  // backend; this method owns the queue, preemption, timeout, and idle reset.
  async generate(
    messages: ChatMessage[],
    maxTokens: number,
    { priority = 0, temperature, onStart }: { priority?: number; temperature?: number; onStart?: () => void } = {}
  ): Promise<string> {
    const params: Record<string, unknown> = {};
    if (temperature !== undefined) params.temperature = temperature;

    return inferenceQueue.enqueue(async () => {
      // Wait for any previous interrupt() to settle
      if (this._interruptSettledPromise) {
        await this._interruptSettledPromise;
        this._interruptSettledPromise = null;
      }

      this._preempted = false;
      if (onStart) onStart();
      try {
        const raw = await this._callWithTimeout(messages, maxTokens, params);

        if (this._preempted) throw new Error('Inference preempted');

        this._resetIdleTimeout();
        return raw;
      } catch (error) {
        if ((error as Error).message === 'Inference preempted') throw error;
        if (this._preempted) {
          throw new Error('Inference preempted', { cause: error });
        }

        if (isGPUDeviceLostError((error as Error).message)) {
          console.error('[LocalEngine] GPU device lost during inference, resetting engine...');
          const modelId = this.loadedModel;
          await this.reset();
          await this.updateStatus(modelId!, {
            state: 'error',
            error: 'GPU memory exhausted during inference. Try a smaller model or close other tabs.'
          });
        }

        throw error;
      }
    }, { priority });
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
    if (!this.engine) throw new Error('Engine not loaded');
    return await this.engine.countTokens(text);
  }

  async truncateText(text: string, maxTokens: number): Promise<string> {
    if (!this.engine) throw new Error('Engine not loaded');
    return await this.engine.truncateText(text, maxTokens);
  }

  async getImageEmbedSize(): Promise<number> {
    if (!this.engine) throw new Error('Engine not loaded');
    return await this.engine.getImageEmbedSize();
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

  async checkCached(modelId: string): Promise<boolean> {
    const modelDef = PREDEFINED_MODELS.local.find(m => m.name === modelId) ?? ({ name: modelId } as LocalModelDef);
    return backendIsCached(modelDef);
  }

  async syncStatus(modelId: string): Promise<LocalModelStatus | undefined> {
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

    // After a background restart, a stale 'error' status no longer reflects
    // reality — the engine isn't running.  Re-check the cache so the UI shows
    // an actionable state instead of a stale error.
    if (storedStatus.state === 'error' && !this.isInitializing()) {
      const cached = await this.checkCached(modelId);
      statuses[modelId] = { state: cached ? 'cached' : 'not_downloaded' };
      needsUpdate = true;
    }

    if (needsUpdate) {
      await setStorage({ localModelStatuses: statuses });
    }

    return statuses[modelId];
  }

  async syncAllStatuses(): Promise<void> {
    for (const model of PREDEFINED_MODELS.local) {
      await this.syncStatus(model.name);
    }
  }

  async autoInitSelected(): Promise<void> {
    try {
      const data = await getStorage(['selectedModel', 'localModelStatuses']);
      const selectedModel = data.selectedModel;

      if (!selectedModel || !selectedModel.startsWith('local:')) return;

      const modelId = selectedModel.split(':')[1];

      if (this.isModelLoaded(modelId)) return;

      // Don't auto-init a model that previously errored — the user must
      // manually retry from the popup.  Without this guard, a partially-
      // cached model that fails to download loops: error → restart →
      // hasModelInCache(true) → auto-init → error → …
      const statuses: Record<string, LocalModelStatus> = data.localModelStatuses ?? {};
      if (statuses[modelId]?.state === 'error') return;

      const cached = await this.checkCached(modelId);
      if (!cached) return;

      this.initialize(modelId).catch(err => {
        console.error('[LocalEngine] Auto-init failed:', err);
      });
    } catch (e) {
      console.error('[LocalEngine] Error in autoInitSelected:', e);
    }
  }

  // ---- Private: initialization tracking ----

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
    this._idleTimeoutId = setTimeout(() => this._onIdleTimeout(), IDLE_TIMEOUT_MS);
  }

  _stopIdleTimeout(): void {
    if (this._idleTimeoutId !== null) {
      clearTimeout(this._idleTimeoutId);
      this._idleTimeoutId = null;
    }
  }

  async _onIdleTimeout(): Promise<void> {
    this._idleTimeoutId = null;
    if (!this.engine) return;
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
  }

  // ---- Private: inference timeout ----

  _callWithTimeout(messages: ChatMessage[], maxTokens: number, params: Record<string, unknown>, timeoutMs?: number): Promise<string> {
    // Cold LiteRT-LM inference needs a longer ceiling than WebLLM's steady state.
    const ceiling = timeoutMs ?? (this._modelConfig?.backend === 'litertlm' ? LITERTLM_INFERENCE_TIMEOUT_MS : INFERENCE_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      let completed = false;

      const onTimeout = async (): Promise<void> => {
        if (completed) return;
        completed = true;
        console.warn(`[LocalEngine] Inference timeout after ${ceiling}ms, interrupting...`);
        try {
          await this.engine!.interrupt();
        } catch (e) {
          console.error('[LocalEngine] Failed to interrupt generation:', e);
        }
        reject(new Error('Inference timeout - model took too long to respond'));
      };
      const timeoutId = setTimeout(() => { void onTimeout(); }, ceiling);

      this.engine!.generate(messages, maxTokens, params)
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

// Orchestrates local inference for a single post: builds prompt, calls generate,
// handles image fallback, parses response. This is the post-filtering-specific
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

  // Per-model prompt style: LiteRT-LM/Gemma uses the terse table_yesno verdict
  // row; WebLLM/Qwen keeps the reasoning-before-label prose (below, unchanged).
  if (modelConfig?.backend === 'litertlm') {
    return callTableYesnoInference(postData, bannedCategories, modelConfig, { priority, onInferenceStart, promptMode });
  }

  const post = postData;
  const contextWindowSize = (modelConfig?.webllmConfig?.overrides?.context_window_size as number) || 1024;
  const maxGenerationTokens = 40;
  const supportsImages = modelConfig?.supportsImages === true;
  let useImages = supportsImages && post.imageUrls && post.imageUrls.length > 0;

  // Calculate token budget and truncate post text to fit within context window
  const systemPrompt = localSystemPrompt(promptMode);
  const overheadPrompt = buildLocalUserMessage('', bannedCategories, useImages);
  const [systemTokens, overheadTokens] = await Promise.all([
    localEngine.countTokens(systemPrompt),
    localEngine.countTokens(overheadPrompt),
  ]);

  let imageTokens = 0;
  if (useImages) {
    const perImageTokens = await localEngine.getImageEmbedSize();
    imageTokens = perImageTokens * post.imageUrls.length;
  }

  let postTextBudget = contextWindowSize - systemTokens - overheadTokens - maxGenerationTokens - imageTokens;

  // If images leave no room for text, drop images and recalculate
  if (useImages && postTextBudget < 1) {
    console.log('[LocalEngine] Images consume too much context, falling back to text-only');
    useImages = false;
    const textOnlyOverhead = await localEngine.countTokens(buildLocalUserMessage('', bannedCategories, false));
    postTextBudget = contextWindowSize - systemTokens - textOnlyOverhead - maxGenerationTokens;
  }

  // Truncate post text to fit budget (tokenize, slice, decode — only if needed)
  const postText = postTextBudget > 0
    ? await localEngine.truncateText(post.text, postTextBudget)
    : '';
  const userPrompt = buildLocalUserMessage(postText, bannedCategories, useImages);

  let userContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  if (useImages) {
    userContent = [{ type: "text", text: userPrompt }];
    for (const url of post.imageUrls) {
      (userContent as Array<{ type: string; text?: string; image_url?: { url: string } }>).push({ type: "image_url", image_url: { url } });
    }
  } else {
    userContent = userPrompt;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];

  let inferenceStart: number;
  const onStart = (): void => {
    if (onInferenceStart) onInferenceStart();
    inferenceStart = Date.now();
  };

  let rawResponse: string;
  try {
    rawResponse = await localEngine.generate(messages, 40, { priority, onStart });
  } catch (imgError) {
    if ((imgError as Error).message === 'Inference preempted') throw imgError;
    if (useImages) {
      console.warn('[LocalEngine] Image processing failed, retrying with text only:', (imgError as Error).message);
      const textOnlyContent = buildLocalUserMessage(postText, bannedCategories, false);
      const textMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: textOnlyContent }
      ];
      rawResponse = await localEngine.generate(textMessages, 40, { priority, onStart });
    } else {
      throw imgError;
    }
  }

  const inferenceTime = ((Date.now() - inferenceStart!) / 1000).toFixed(2);

  const { shouldHide, reasoning } = parseLocalModelResponse(rawResponse);
  if (!rawResponse) {
    console.warn('[LocalEngine] Empty response from model');
  }

  const result: { shouldHide: boolean; reasoning: string; category?: string | null; rawResponse?: string | null; inferenceTime?: number } =
    formatLocalInferenceResult(reasoning, shouldHide);
  result.category = null;
  result.rawResponse = rawResponse;
  result.inferenceTime = parseFloat(inferenceTime);

  return result;
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
  // Leave room for Gemma's occasional markdown/newline drift; the runtime now
  // enforces this budget through sessionConfig.maxOutputTokens.
  const maxGenerationTokens = Math.max(64, 6 + 4 * bannedCategories.length);
  const supportsImages = modelConfig.supportsImages === true;
  let useImages = !!(supportsImages && postData.imageUrls && postData.imageUrls.length > 0);
  const isSingleCategory = bannedCategories.length === 1;
  const systemPrompt = isSingleCategory
    ? tableYesnoSingleSystemPrompt(promptMode)
    : tableYesnoSystemPrompt(promptMode);

  const buildUserContent = (postText: string, includeImages: boolean): ChatMessage['content'] => {
    const userText = isSingleCategory
      ? buildSingleYesnoUserMessage(postText, bannedCategories[0], includeImages, promptMode)
      : buildTableYesnoUserMessage(postText, bannedCategories, includeImages, promptMode);
    if (!includeImages) return userText;
    return [
      { type: 'text', text: userText },
      ...postData.imageUrls.map(url => ({ type: 'image_url' as const, image_url: { url } })),
    ];
  };
  const buildMessages = (postText: string, includeImages: boolean): ChatMessage[] => [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildUserContent(postText, includeImages) },
  ];

  // Estimate overhead from system + user-with-empty-post text. Image entries
  // don't surface in the joined string; their cost is added separately.
  const overheadText = (includeImages: boolean): string => buildMessages('', includeImages).map(m =>
    typeof m.content === 'string'
      ? m.content
      : m.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
  ).join('\n');
  const overheadTokens = await localEngine.countTokens(overheadText(useImages));

  let imageTokens = 0;
  if (useImages) {
    const perImageTokens = await localEngine.getImageEmbedSize();
    imageTokens = perImageTokens * postData.imageUrls.length;
  }

  let postTextBudget = contextWindowSize - overheadTokens - maxGenerationTokens - imageTokens;

  // If images leave no room for text, drop them and recompute.
  if (useImages && postTextBudget < 1) {
    console.log('[LocalEngine] Images consume too much context, falling back to text-only');
    useImages = false;
    const textOnlyOverhead = await localEngine.countTokens(overheadText(false));
    postTextBudget = contextWindowSize - textOnlyOverhead - maxGenerationTokens;
  }

  const postText = postTextBudget > 0
    ? await localEngine.truncateText(postData.text, postTextBudget)
    : '';

  let inferenceStart: number;
  const onStart = (): void => {
    if (onInferenceStart) onInferenceStart();
    inferenceStart = Date.now();
  };

  let rawResponse: string;
  try {
    rawResponse = await localEngine.generate(buildMessages(postText, useImages), maxGenerationTokens, { priority, onStart });
  } catch (imgError) {
    if ((imgError as Error).message === 'Inference preempted') throw imgError;
    if (useImages) {
      console.warn('[LocalEngine] Image processing failed, retrying with text only:', (imgError as Error).message);
      rawResponse = await localEngine.generate(buildMessages(postText, false), maxGenerationTokens, { priority, onStart });
    } else {
      throw imgError;
    }
  }

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
