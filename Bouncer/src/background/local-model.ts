// Local model orchestrator: lifecycle, status, queue, keep-alive, preemption.
// Model-specific calls are delegated to a pluggable LocalBackend.

import type { LocalModelDef, LocalModelStatus, EvaluationPostData, ChatMessage } from '../types';
import { PREDEFINED_MODELS } from '../shared/models';
import { isGPUDeviceLostError, isNetworkError, formatLocalInferenceResult } from '../shared/utils';
import { LOCAL_SYSTEM_PROMPT, buildLocalUserMessage, TABLE_YESNO_SYSTEM_PROMPT, buildTableYesnoUserMessage } from '../shared/prompts';
import { inferenceQueue } from './inference-queue';
import { getStorage, setStorage } from '../shared/storage';
import type { LocalBackend } from './backends/types';
import { WebllmBackend, isWebllmCached, deleteWebllmCache } from './backends/webllm-backend';
import { LitertlmBackend, isLitertlmCached, deleteLitertlmCache } from './backends/litertlm-backend';

// Re-exported so existing importers (and tests) keep their import path.
export { buildModelConfig } from './backends/webllm-backend';

declare global {
  interface Navigator {
    gpu?: unknown;
  }
}

// ==================== Constants ====================

const KEEP_ALIVE_INTERVAL_MS = 5000;
const DOWNLOAD_KEEP_ALIVE_MS = 20000;  // Firefox suspends event pages after 30 s idle
const IDLE_TIMEOUT_MS = 60000;
const INFERENCE_TIMEOUT_MS = 30000;
// Cold LiteRT-LM inference (first call after load) compiles WebGPU shaders,
// prefills, and decodes — easily 30–60 s on a 4B model before the first token.
const LITERTLM_INFERENCE_TIMEOUT_MS = 90000;
const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2000;

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

// Gemma .litertlm builds sometimes leak chat-template terminators into the
// generated text. Trim a leading echoed <start_of_turn>... and truncate at the
// first <end_of_turn> so the parser doesn't see those markers as verdict cells.
function stripGemmaMarkers(raw: string): string {
  let s = raw.replace(/^<start_of_turn>\w*\s*/m, '');
  const stopIdx = s.indexOf('<end_of_turn>');
  if (stopIdx !== -1) s = s.slice(0, stopIdx);
  return s.replace(/<(?:eos|bos|pad)>/gi, '').trim();
}

// Lenient port of bouncer-evals-and-results' table_yesno.parse(). The model is
// asked for `| yes | no | yes | …` — one verdict per category, in order.
// Without constrained decoding we handle malformed output gracefully: any
// deviation falls back to SHOW with the raw response in the reasoning so the
// user can debug from the popup.
export function parseTableYesnoResponse(
  rawResponse: string | null,
  categories: string[],
): { shouldHide: boolean; reasoning: string; matches: string[] } {
  if (!rawResponse) {
    return { shouldHide: false, reasoning: 'Empty model response — model returned no output', matches: [] };
  }
  const raw = stripGemmaMarkers(rawResponse);
  // Some checkpoints prepend a stray space or prefix; tolerate anything up to
  // the first `|`. If there is no `|` at all the row is junk.
  const pipeIdx = raw.indexOf('|');
  if (pipeIdx === -1) {
    return { shouldHide: false, reasoning: `Malformed verdict row (no '|'): ${rawResponse}`, matches: [] };
  }
  const row = raw.slice(pipeIdx);
  const parts = row.split('|').map(s => s.trim()).slice(1);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();

  if (parts.length !== categories.length) {
    return {
      shouldHide: false,
      reasoning: `Malformed verdict row (expected ${categories.length} verdicts, got ${parts.length}): ${rawResponse}`,
      matches: [],
    };
  }
  const matches: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const v = parts[i].toLowerCase();
    if (v !== 'yes' && v !== 'no') {
      return {
        shouldHide: false,
        reasoning: `Malformed verdict row (verdict ${i} = ${JSON.stringify(parts[i])}): ${rawResponse}`,
        matches: [],
      };
    }
    if (v === 'yes') matches.push(categories[i]);
  }
  const shouldHide = matches.length > 0;
  const reasoning = shouldHide
    ? `${rawResponse} (Matched: ${matches.join(', ')})`
    : rawResponse;
  return { shouldHide, reasoning, matches };
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
    void this._startInit(modelId);
    const abortSignal = this._initAbortController!.signal;
    this._startDownloadKeepAlive();

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
        this._completeInit(null);
        return null;
      }

      try {
        await this.updateStatus(modelId, { state: 'initializing', progress: 0, text: retryCount > 0 ? `Retrying (${retryCount}/${DOWNLOAD_MAX_RETRIES})...` : 'Starting...' });

        await backend.initialize(backendModelDef, (progress) => {
          if (abortSignal.aborted) return;
          this.updateStatus(modelId, {
            state: 'downloading',
            progress: progress.progress,
            text: progress.text,
          }).catch(err => console.error('[LocalEngine] Failed to update download status:', err));
        }, abortSignal);

        if (abortSignal.aborted) {
          try { await backend.unload(); } catch { /* ignore */ }
          this._completeInit(null);
          return null;
        }

        this.engine = backend;
        this.loadedModel = modelId;
        this._modelConfig = modelDef;

        await this.updateStatus(modelId, { state: 'ready' });

        this._startKeepAlive();
        this._resetIdleTimeout();
        this._completeInit(this.engine);

        return this.engine;
      } catch (error) {
        console.error('[LocalEngine] Initialization failed:', error);

        const errorMsg = (error as Error).message;

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
            this._completeInit(null);
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
  }

  async cancelDownload(modelId: string): Promise<boolean> {
    if (!this.isInitializingModel(modelId)) {
      return false;
    }
    if (this._initAbortController) {
      this._initAbortController.abort();
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
      if (this._initAbortController) {
        this._initAbortController.abort();
      }
      await this.reset();
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
    const data = await getStorage(['localModelStatuses']);
    const statuses: Record<string, LocalModelStatus> = { ...(data.localModelStatuses ?? {}) };
    statuses[modelId] = status;
    await setStorage({ localModelStatuses: statuses });
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

  _startInit(modelId: string): Promise<LocalBackend | null> {
    this._initializingModel = modelId;
    this._initAbortController = new AbortController();
    this._initPromise = new Promise<LocalBackend | null>(resolve => {
      this._initPromiseResolve = resolve;
    });
    return this._initPromise;
  }

  _completeInit(backend: LocalBackend | null): void {
    this._initializingModel = null;
    this._initAbortController = null;
    this._stopDownloadKeepAlive();
    if (this._initPromiseResolve) {
      this._initPromiseResolve(backend);
      this._initPromiseResolve = null;
    }
    this._initPromise = null;
  }

  // ---- Private: keep-alive ----

  _startKeepAlive(): void {
    if (this._keepAliveInterval) return;
    this._keepAliveInterval = setInterval(() => {
      // Keep-alive: accessing this.engine prevents service worker from idling
      void this.engine;
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
  { priority = 0, onInferenceStart }: { priority?: number; onInferenceStart?: () => void } = {}
): Promise<{ shouldHide: boolean; reasoning: string; category?: string | null; rawResponse?: string | null; inferenceTime?: number }> {
  await localEngine.ensureLoaded(modelId);

  // Per-model prompt style: LiteRT-LM/Gemma uses the terse table_yesno verdict
  // row; WebLLM/Qwen keeps the reasoning-before-label prose (below, unchanged).
  if (modelConfig?.backend === 'litertlm') {
    return callTableYesnoInference(postData, bannedCategories, modelConfig, { priority, onInferenceStart });
  }

  const post = postData;
  const contextWindowSize = (modelConfig?.webllmConfig?.overrides?.context_window_size as number) || 1024;
  const maxGenerationTokens = 40;
  const supportsImages = modelConfig?.supportsImages === true;
  let useImages = supportsImages && post.imageUrls && post.imageUrls.length > 0;

  // Calculate token budget and truncate post text to fit within context window
  const overheadPrompt = buildLocalUserMessage('', bannedCategories, useImages);
  const [systemTokens, overheadTokens] = await Promise.all([
    localEngine.countTokens(LOCAL_SYSTEM_PROMPT),
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
    { role: "system", content: LOCAL_SYSTEM_PROMPT },
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
        { role: "system", content: LOCAL_SYSTEM_PROMPT },
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
  { priority = 0, onInferenceStart }: { priority?: number; onInferenceStart?: () => void } = {}
): Promise<{ shouldHide: boolean; reasoning: string; category?: string | null; rawResponse?: string | null; inferenceTime?: number }> {
  const contextWindowSize = modelConfig.litertlmConfig?.maxTokens ?? 1024;
  // Output is the verdict row (~3 tokens × N categories). Pad so a long topic
  // name or extra category never truncates.
  const maxGenerationTokens = Math.max(20, 6 + 4 * bannedCategories.length);
  const supportsImages = modelConfig.supportsImages === true;
  let useImages = !!(supportsImages && postData.imageUrls && postData.imageUrls.length > 0);

  const buildUserContent = (postText: string, includeImages: boolean): ChatMessage['content'] => {
    const userText = buildTableYesnoUserMessage(postText, bannedCategories, includeImages);
    if (!includeImages) return userText;
    return [
      { type: 'text', text: userText },
      ...postData.imageUrls.map(url => ({ type: 'image_url' as const, image_url: { url } })),
    ];
  };
  const buildMessages = (postText: string, includeImages: boolean): ChatMessage[] => [
    { role: 'system', content: TABLE_YESNO_SYSTEM_PROMPT },
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
