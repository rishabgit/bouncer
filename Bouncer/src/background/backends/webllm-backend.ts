// WebLLM (MLC) backend: runs Qwen MLC builds via WebGPU. Implements the
// engine-agnostic LocalBackend seam; the orchestrator (local-model.ts) owns
// lifecycle, the inference queue, keep-alive, idle-unload, and preemption.

import { CreateMLCEngine, hasModelInCache, deleteModelAllInfoInCache, prebuiltAppConfig, verifyIntegrity } from "@mlc-ai/web-llm";
import type { MLCEngine, AppConfig, ChatCompletion, CompletionUsage, MLCEngineConfig, ModelRecord } from "@mlc-ai/web-llm";
import type { LocalModelDef, ChatMessage } from '../../types';
import { PREDEFINED_MODELS } from '../../shared/models';
import type { LocalBackend, InitProgress, IsCachedFn } from './types';

// Keys that belong on the ModelRecord (appConfig), not chatOpts.
const MODEL_RECORD_KEYS = new Set(['model', 'model_lib', 'model_type']);

// Build both the appConfig (ModelRecord for CreateMLCEngine) and chatOpts
// (chat-level overrides) from a model's webllmConfig. Keeps the
// "which keys go where" split defined in one place.
export function buildModelConfig(modelId: string): { appConfig: AppConfig | undefined; chatOpts: Record<string, unknown> } {
  const modelDef = PREDEFINED_MODELS.local.find(m => m.name === modelId);
  const webllmConfig = modelDef?.webllmConfig;
  const { overrides, ...recordFields } = webllmConfig || {};

  let appConfig: AppConfig | undefined;
  if (recordFields.model) {
    appConfig = { model_list: [{ model_id: modelId, ...recordFields, ...(overrides && { overrides }) } as AppConfig['model_list'][number]] };
  } else {
    const prebuiltRecord = prebuiltAppConfig.model_list.find(m => m.model_id === modelId);
    const hasRecordFields = Object.keys(recordFields).length > 0;
    if (prebuiltRecord && hasRecordFields) {
      appConfig = { model_list: [{ ...prebuiltRecord, ...recordFields, ...(overrides && { overrides }) }] };
    }
  }

  const chatOpts: Record<string, unknown> = { context_window_size: 1024 };
  if (overrides) Object.assign(chatOpts, overrides);
  for (const [key, value] of Object.entries(recordFields)) {
    if (!MODEL_RECORD_KEYS.has(key)) chatOpts[key] = value;
  }

  return { appConfig, chatOpts };
}

// Merge model-level inference params with per-call overrides into a single request object.
function buildInferenceRequest(modelConfig: LocalModelDef | Record<string, never>, requestOpts: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(modelConfig as LocalModelDef).inferenceParams,
    ...requestOpts,
    ...((modelConfig as LocalModelDef).extraBody && { extra_body: (modelConfig as LocalModelDef).extraBody }),
  };
}

interface CachedFetch {
  response: Response;
  fromCache: boolean;
}

// Cache one artifact using the exact scopes and URL keys used by WebLLM's
// default Cache API backend. Counting the second tee branch gives the pending
// switch UI honest byte progress without instantiating a WebGPU engine.
async function fetchIntoWebllmCache(
  scope: 'webllm/config' | 'webllm/wasm' | 'webllm/model',
  url: string,
  abortSignal: AbortSignal,
  onChunk?: (bytes: number) => void,
): Promise<CachedFetch> {
  const cache = await caches.open(scope);
  const cached = await cache.match(url);
  if (cached) return { response: cached, fromCache: true };

  const upstream = await fetch(url, { signal: abortSignal });
  if (!upstream.ok) {
    throw new Error(`Failed to fetch ${url}: ${upstream.status} ${upstream.statusText}`);
  }

  if (!upstream.body) {
    await cache.put(url, upstream.clone());
  } else {
    const [forCache, forCount] = upstream.body.tee();
    const countPromise = (async (): Promise<void> => {
      const reader = forCount.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        onChunk?.(value.byteLength);
      }
    })();
    const cachedResponse = new Response(forCache, {
      headers: upstream.headers,
      status: upstream.status,
      statusText: upstream.statusText,
    });
    await Promise.all([cache.put(url, cachedResponse), countPromise]);
  }

  const stored = await cache.match(url);
  if (!stored) throw new Error(`Failed to cache ${url}`);
  return { response: stored, fromCache: false };
}

function cleanWebllmModelUrl(modelUrl: string): string {
  const extensionBase = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('')
    : (globalThis.location?.href ?? 'https://extension.invalid/');
  let resolved = new URL(modelUrl, extensionBase).href;
  resolved += resolved.endsWith('/') ? '' : '/';
  if (!resolved.match(/.+\/resolve\/.+\//)) resolved += 'resolve/main/';
  return new URL(resolved).href;
}

function resolveWebllmRecord(modelId: string): { record: ModelRecord; appConfig: AppConfig } {
  const { appConfig } = buildModelConfig(modelId);
  const effectiveConfig = appConfig ?? prebuiltAppConfig;
  if (effectiveConfig.cacheBackend && effectiveConfig.cacheBackend !== 'cache') {
    throw new Error(`Cache-only prefetch requires WebLLM's Cache API backend, got ${effectiveConfig.cacheBackend}`);
  }
  const record = effectiveConfig.model_list.find(item => item.model_id === modelId);
  if (!record) throw new Error(`Unknown WebLLM model: ${modelId}`);
  return { record, appConfig: effectiveConfig };
}

interface TensorCacheRecord {
  dataPath: string;
  nbytes: number;
}

/** Download every artifact CreateMLCEngine needs into WebLLM's Cache API
 *  buckets without creating a GPU device or unloading the active model. */
export async function prefetchWebllmModel(
  modelDef: LocalModelDef,
  onProgress: (progress: InitProgress) => void,
  abortSignal: AbortSignal,
): Promise<void> {
  const { record } = resolveWebllmRecord(modelDef.name);
  const modelUrl = cleanWebllmModelUrl(record.model);
  const configUrl = new URL('mlc-chat-config.json', modelUrl).href;

  const configFetch = await fetchIntoWebllmCache('webllm/config', configUrl, abortSignal);
  const configBuffer = await configFetch.response.clone().arrayBuffer();
  if (record.integrity?.config) {
    await verifyIntegrity(configBuffer, record.integrity.config, configUrl, record.integrity.onFailure);
  }
  const config = JSON.parse(new TextDecoder().decode(configBuffer)) as { tokenizer_files?: string[] };

  const extensionBase = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('')
    : modelUrl;
  const wasmUrl = new URL(record.model_lib, extensionBase).href;
  const wasmFetch = await fetchIntoWebllmCache('webllm/wasm', wasmUrl, abortSignal);
  if (record.integrity?.model_lib) {
    await verifyIntegrity(
      await wasmFetch.response.clone().arrayBuffer(),
      record.integrity.model_lib,
      wasmUrl,
      record.integrity.onFailure,
    );
  }

  const tokenizerFile = config.tokenizer_files?.includes('tokenizer.json')
    ? 'tokenizer.json'
    : config.tokenizer_files?.includes('tokenizer.model')
      ? 'tokenizer.model'
      : null;
  if (!tokenizerFile) throw new Error(`Unsupported tokenizer files for ${modelDef.name}`);
  const tokenizerUrl = new URL(tokenizerFile, modelUrl).href;
  const tokenizerFetch = await fetchIntoWebllmCache('webllm/model', tokenizerUrl, abortSignal);
  const tokenizerIntegrity = record.integrity?.tokenizer?.[tokenizerFile];
  if (tokenizerIntegrity) {
    await verifyIntegrity(
      await tokenizerFetch.response.clone().arrayBuffer(),
      tokenizerIntegrity,
      tokenizerUrl,
      record.integrity?.onFailure,
    );
  }

  const manifestUrl = new URL('tensor-cache.json', modelUrl).href;
  const manifestFetch = await fetchIntoWebllmCache('webllm/model', manifestUrl, abortSignal);
  const manifest = await manifestFetch.response.clone().json() as { records?: TensorCacheRecord[] };
  if (!Array.isArray(manifest.records)) throw new Error(`Invalid tensor cache manifest for ${modelDef.name}`);

  const records = manifest.records;
  const totalBytes = records.reduce((sum, item) => sum + Math.max(0, item.nbytes || 0), 0);
  let completedBytes = 0;
  let completedShards = 0;
  let nextIndex = 0;
  const report = (): void => {
    const progress = totalBytes > 0 ? Math.min(1, completedBytes / totalBytes) : 1;
    onProgress({
      progress,
      text: `Downloading model cache [${completedShards} / ${records.length}]`,
    });
  };
  report();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= records.length) return;
      const shard = records[index];
      const expectedBytes = Math.max(0, shard.nbytes || 0);
      let receivedBytes = 0;
      const shardUrl = new URL(shard.dataPath, modelUrl).href;
      const result = await fetchIntoWebllmCache('webllm/model', shardUrl, abortSignal, bytes => {
        receivedBytes += bytes;
        completedBytes += bytes;
        report();
      });
      if (result.fromCache) {
        completedBytes += expectedBytes;
      } else if (receivedBytes < expectedBytes) {
        completedBytes += expectedBytes - receivedBytes;
      }
      completedShards++;
      report();
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, records.length)) }, () => worker()));
  onProgress({ progress: 1, text: `Downloaded model cache [${records.length} / ${records.length}]` });
}

export class WebllmBackend implements LocalBackend {
  private engine: MLCEngine | null = null;
  private modelDef: LocalModelDef | null = null;
  // Token + timing stats from the most recent completion (dev benchmark only).
  private lastUsage: CompletionUsage | null = null;

  async initialize(modelDef: LocalModelDef, onProgress: (p: InitProgress) => void, abortSignal: AbortSignal): Promise<void> {
    this.modelDef = modelDef;
    const modelId = modelDef.name;

    const engineConfig: MLCEngineConfig & { initProgressCallback: (progress: { progress: number; text: string }) => void } = {
      initProgressCallback: (progress: { progress: number; text: string }) => {
        if (abortSignal.aborted) return;
        const displayText = progress.text
          .replace(/^Fetching param cache/, 'Downloading param cache')
          .replace(/^Loading model from cache/, 'Loading from cache')
          .replace(/\bcache\[(\d+)\s*\/\s*(\d+)\]/, 'cache [$1 / $2]')
          .replace(/:\s*\d+\s*MB loaded\b.*$/i, '')
          .replace(/,?\s*\d+\s*secs?\s+elapsed\.?/i, '')
          .replace(/\. It can take a while.*$/, '')
          .trim();
        onProgress({ progress: progress.progress, text: displayText });
      }
    };

    const { appConfig, chatOpts } = buildModelConfig(modelId);
    if (appConfig) {
      (engineConfig as MLCEngineConfig & { appConfig?: AppConfig }).appConfig = appConfig;
    }

    this.engine = await CreateMLCEngine(modelId, engineConfig as MLCEngineConfig, chatOpts);
  }

  async unload(): Promise<void> {
    if (this.engine) {
      await this.engine.unload();
    }
    this.engine = null;
    this.modelDef = null;
    this.lastUsage = null;
  }

  // Run a completion: clear WebLLM's stale interrupt flag, resetChat, call the
  // model, strip <think> blocks. Timeout/preemption/queueing are the
  // orchestrator's job — this is just the raw model call.
  async generate(messages: ChatMessage[], maxTokens: number, params: Record<string, unknown>): Promise<string> {
    if (!this.engine) throw new Error('Engine not loaded');

    // WebLLM bug workaround: clear stale interruptSignal left by a prior interrupt.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    if ((this.engine as any).interruptSignal) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (this.engine as any).interruptSignal = false;
    }

    const requestOpts: Record<string, unknown> = { messages, max_tokens: maxTokens, ...params };
    const request = buildInferenceRequest(this.modelDef || ({} as Record<string, never>), requestOpts);

    await this.engine.resetChat();
    const completion = await this.engine.chat.completions.create(
      request as unknown as Parameters<MLCEngine['chat']['completions']['create']>[0]
    ) as ChatCompletion;

    this.lastUsage = completion.usage ?? null;

    return (completion.choices[0]?.message?.content || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  getLastUsage(): CompletionUsage | null {
    return this.lastUsage;
  }

  async interrupt(): Promise<void> {
    if (this.engine) {
      await this.engine.interruptGenerate();
    }
  }

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
}

// Backend-level cache probe — works without an initialized engine.
// deleteModelAllInfoInCache/hasModelInCache derive the same keys from
// buildModelConfig, scoped to this one model.
export const isWebllmCached: IsCachedFn = async (modelDef: LocalModelDef): Promise<boolean> => {
  try {
    const { appConfig } = buildModelConfig(modelDef.name);
    return await hasModelInCache(modelDef.name, appConfig);
  } catch (e) {
    console.error('[WebLLM] Error checking cache for', modelDef.name, ':', e);
    return false;
  }
};

// Delete one model's cached weights/wasm/tokenizer/chat-config from the browser
// Cache API. Other cached models are untouched: deleteModelAllInfoInCache derives
// the same keys (findModelRecord + cleanModelUrl) scoped to this modelId only. It
// throws ModelNotFoundError if the id can't be resolved, so callers re-sync status
// on failure.
export async function deleteWebllmCache(modelDef: LocalModelDef): Promise<void> {
  const { appConfig } = buildModelConfig(modelDef.name);
  await deleteModelAllInfoInCache(modelDef.name, appConfig);
  await purgeTensorManifest(modelDef.name, appConfig);
}

// WebLLM's deleteTensorCache (vendor/web-llm) deletes every weight shard but
// leaves the tensor-cache.json manifest orphaned in the "webllm/model" Cache
// Storage bucket — so deleteModelAllInfoInCache never fully cleans up. Remove
// that one leftover so a delete is actually complete and these ~KB manifests
// don't accumulate across delete/re-download cycles. cleanModelUrl only ever
// appends ("/", "resolve/main/") to the record's `model`, so the stored key
// always startsWith that bare URL — a scoping match unique to this model that
// doesn't depend on reimplementing cleanModelUrl. Best-effort: never throws.
async function purgeTensorManifest(modelId: string, appConfig: AppConfig | undefined): Promise<void> {
  if (typeof caches === 'undefined') return;
  const record = appConfig?.model_list?.find(m => m.model_id === modelId)
    ?? prebuiltAppConfig.model_list.find(m => m.model_id === modelId);
  const modelBaseUrl = record?.model?.replace(/\/+$/, '');
  if (!modelBaseUrl) return;
  try {
    const modelCache = await caches.open('webllm/model');
    for (const req of await modelCache.keys()) {
      if (req.url.startsWith(modelBaseUrl) && req.url.endsWith('/tensor-cache.json')) {
        await modelCache.delete(req);
      }
    }
  } catch (e) {
    console.warn('[WebLLM] Could not purge orphaned tensor-cache.json for', modelId, ':', (e as Error).message);
  }
}
