// WebLLM (MLC) backend: runs Qwen MLC builds via WebGPU. Implements the
// engine-agnostic LocalBackend seam; the orchestrator (local-model.ts) owns
// lifecycle, the inference queue, keep-alive, idle-unload, and preemption.

import { CreateMLCEngine, hasModelInCache, deleteModelAllInfoInCache, prebuiltAppConfig } from "@mlc-ai/web-llm";
import type { MLCEngine, AppConfig, ChatCompletion, MLCEngineConfig } from "@mlc-ai/web-llm";
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

export class WebllmBackend implements LocalBackend {
  private engine: MLCEngine | null = null;
  private modelDef: LocalModelDef | null = null;

  async initialize(modelDef: LocalModelDef, onProgress: (p: InitProgress) => void, abortSignal: AbortSignal): Promise<void> {
    this.modelDef = modelDef;
    const modelId = modelDef.name;

    const engineConfig: MLCEngineConfig & { initProgressCallback: (progress: { progress: number; text: string }) => void } = {
      initProgressCallback: (progress: { progress: number; text: string }) => {
        if (abortSignal.aborted) return;
        const displayText = progress.text
          .replace(/^Fetching param cache/, 'Downloading param cache')
          .replace(/\bcache\[(\d+)\s*\/\s*(\d+)\]/, 'cache [$1 / $2]')
          .replace(/\. It can take a while.*$/, '');
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

    return (completion.choices[0]?.message?.content || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
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
