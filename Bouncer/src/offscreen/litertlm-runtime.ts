// Wraps LiteRT-LM's Engine + Conversation for use as a Bouncer LocalBackend.
// Runs in any DOM-backed context — the Firefox event-page background and the
// Chrome offscreen document both instantiate this directly. Chrome's MV3
// service worker proxies through litertlm-proxy.ts because @litertjs/wasm-utils
// uses <script> tag injection to load the wasm runner, which a module SW
// cannot do.

import {
  Engine,
  loadLiteRtLm,
  unloadLiteRtLm,
  Backend,
  SamplerType,
  type Conversation,
  type ConversationConfig,
  type Message,
} from '@litert-lm/core';
import type { LocalModelDef, ChatMessage } from '../types';

// Cache the .litertlm model in the standard Cache Storage so a reload skips
// the multi-GB download. Keyed by the model URL so multiple models coexist.
const LITERTLM_CACHE_KEY = 'litertlm-cache';

// Path inside the extension where build.js drops the LiteRT-LM wasm loader
// + binaries. Has to be reachable via chrome.runtime.getURL.
const WASM_BASE = 'dist/litertlm-wasm';

// Rough chars-per-token for Gemma's BPE tokenizer. LiteRT-LM's JS layer
// doesn't expose a tokenizer, so we use a conservative estimate — round down
// in chars-to-tokens (estimateTokens) and round down in tokens-to-chars
// (truncateText) to err on the side of fitting in the budget.
const CHARS_PER_TOKEN = 3;

export interface InitProgress {
  progress: number;
  text: string;
}

function getWasmBaseUrl(): string {
  // Production runs inside an extension and resolves through its URL scheme.
  // The dev-only Gemma comparison page is served from localhost, where Chrome
  // exposes `window.chrome` but not `chrome.runtime.getURL`; in that case the
  // copied wasm directory sits next to the comparison bundle under dist/.
  // LiteRT-LM appends litertlm_wasm_internal.js (or its compat variant).
  const runtime = globalThis.chrome?.runtime;
  return runtime?.getURL
    ? runtime.getURL(`${WASM_BASE}/`)
    : new URL('./litertlm-wasm/', import.meta.url).href;
}

// Stream a remote model into the Cache Storage while reporting progress.
// Returns a fresh Response for the now-cached entry so the caller can pull
// the body without re-downloading.
export async function fetchAndCacheModel(
  url: string,
  onProgress: (p: InitProgress) => void,
  abortSignal: AbortSignal,
): Promise<Response> {
  const cache = await caches.open(LITERTLM_CACHE_KEY);
  const cached = await cache.match(url);
  if (cached) {
    // A cache hit is initialization, not a network download. Emitting 100%
    // here leaves the in-feed UI stuck on "Downloading" while weights stream
    // from Cache Storage into the GPU.
    return cached;
  }

  const upstream = await fetch(url, { signal: abortSignal });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Failed to fetch model: ${upstream.status} ${upstream.statusText}`);
  }

  const total = Number(upstream.headers.get('content-length') ?? 0);
  let received = 0;

  // Tee the response so we can both forward progress and store the bytes
  // in Cache Storage. The Cache API takes a Response object whose body
  // hasn't been consumed yet, so build a new Response from the tee.
  const [forCache, forCount] = upstream.body.tee();

  const counter = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = forCount.getReader();
      for (;;) {
        if (abortSignal.aborted) {
          controller.error(new Error('aborted'));
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (total > 0) {
          onProgress({ progress: received / total, text: '' });
        }
        controller.enqueue(value);
      }
      controller.close();
    },
  });

  // The progress stream needs to be drained — Cache Storage will read
  // `forCache`, but if nothing pulls from `forCount` the tee will stall.
  // Drive it explicitly and discard.
  void (async (): Promise<void> => {
    const reader = counter.getReader();
    while (!(await reader.read()).done) { /* drained for progress */ }
  })().catch(() => { /* abort/error is reported by cache.put/fetch path */ });

  const responseForCache = new Response(forCache, { headers: upstream.headers });
  await cache.put(url, responseForCache);
  const cachedAfter = await cache.match(url);
  if (!cachedAfter) throw new Error('Failed to cache model after download');
  onProgress({ progress: 1, text: '' });
  return cachedAfter;
}

/** Cache-only LiteRT download used by the development comparison runner. */
export async function prefetchLitertlmModel(
  modelDef: LocalModelDef,
  onProgress: (p: InitProgress) => void,
  abortSignal: AbortSignal,
): Promise<void> {
  const modelUrl = modelDef.litertlmConfig?.modelUrl;
  if (!modelUrl) throw new Error(`Model ${modelDef.name} is missing litertlmConfig`);
  await fetchAndCacheModel(modelUrl, onProgress, abortSignal);
}

// `loadLiteRtLm` throws if called twice. Track our own load promise so the
// offscreen page survives engine reloads without unloading the wasm module —
// reloading the wasm would re-fetch ~19 MB. unloadLiteRtLm() is only used
// when the runtime itself is torn down.
let wasmLoaded: Promise<void> | null = null;
function ensureWasmLoaded(): Promise<void> {
  if (!wasmLoaded) {
    // Defer the loader call so even a synchronous loader failure is captured
    // by the shared promise. Keep that exact promise in the cache: comparing
    // against a derived catch promise would never match and would permanently
    // poison retries after the first failure.
    const loading = Promise.resolve()
      .then(() => loadLiteRtLm(getWasmBaseUrl()))
      .then(() => undefined);
    wasmLoaded = loading;
    void loading.catch(() => {
      // Clear only this failed attempt. A teardown followed by a newer load
      // must not be invalidated by an older promise settling late.
      if (wasmLoaded === loading) wasmLoaded = null;
    });
  }
  return wasmLoaded;
}

// The dev comparison warms this separately so first-model load time is not
// charged for one-time LiteRT wasm startup. Production initialization still
// calls the same idempotent helper through initialize().
export function warmLitertlmWasm(): Promise<void> {
  return ensureWasmLoaded();
}

export class LitertlmRuntime {
  private engine: Engine | null = null;
  private modelDef: LocalModelDef | null = null;
  private activeConversation: Conversation | null = null;
  private generating = false;
  // LiteRT-LM serializes work through its own executor mutex, but we keep an
  // explicit chain here for the same reason as before: unload() and
  // interrupt() must wait for any in-flight generate() to settle before
  // touching engine state, and the chain provides that ordering.
  private chain: Promise<unknown> = Promise.resolve();

  private enqueue<T>(op: () => T | Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(() => op());
    // Reassign before returning so back-to-back enqueue() calls all chain
    // off the same in-flight tail rather than racing against `this.chain`.
    this.chain = next.catch(() => undefined);
    return next;
  }

  async initialize(
    modelDef: LocalModelDef,
    onProgress: (p: InitProgress) => void,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const cfg = modelDef.litertlmConfig;
    if (!cfg) throw new Error(`Model ${modelDef.name} is missing litertlmConfig`);

    // Only the real network path emits progress. Wasm startup, cache hits, and
    // cache-to-GPU loading remain in the caller's `initializing` state.
    await ensureWasmLoaded();
    if (abortSignal.aborted) throw new Error('aborted');

    const cached = await fetchAndCacheModel(cfg.modelUrl, onProgress, abortSignal);
    if (abortSignal.aborted) throw new Error('aborted');

    // LiteRT-LM's default backend (GPU_ARTISAN) supports streaming load:
    // pass the ReadableStream straight into Engine.create so the multi-GB
    // blob is streamed into the GPU instead of materialized contiguously.
    if (!cached.body) throw new Error('Cached model response has no body');

    this.engine = await Engine.create({
      model: cached.body,
      mainExecutorSettings: { maxNumTokens: cfg.maxTokens ?? 1024 },
    });

    if (abortSignal.aborted) {
      await this.engine.delete();
      this.engine = null;
      throw new Error('aborted');
    }
    this.modelDef = modelDef;
  }

  async unload(): Promise<void> {
    // cancel() in-flight generation, then drain the chain (prefill may not be
    // cancellable; the executor mutex will settle once it completes), then
    // delete the engine. delete() while generation is in flight would race.
    if (this.activeConversation && this.generating) {
      this.activeConversation.cancel();
    }
    await this.chain.catch(() => undefined);
    if (this.activeConversation) {
      try { await this.activeConversation.delete(); }
      catch (e) { console.error('[LiteRT-LM] Error deleting conversation:', e); }
      this.activeConversation = null;
    }
    try { await this.engine?.delete(); }
    catch (e) { console.error('[LiteRT-LM] Error deleting engine:', e); }
    this.engine = null;
    this.modelDef = null;
    this.generating = false;
    this.chain = Promise.resolve();
  }

  // Translate Bouncer's ChatMessage[] into LiteRT-LM's Preface + final user
  // message. The system message goes into the preface; the last user message
  // is what gets sent. LiteRT-LM applies the model's chat template internally.
  private splitMessages(messages: ChatMessage[]): { prefaceMessages: Message[]; userText: string } {
    const prefaceMessages: Message[] = [];
    let userText = '';
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const text = m.content;
      const isLastUser = i === messages.length - 1 && m.role === 'user';
      if (isLastUser) {
        userText = text;
      } else {
        prefaceMessages.push({ role: m.role, content: text });
      }
    }
    return { prefaceMessages, userText };
  }

  generate(messages: ChatMessage[], maxTokens: number): Promise<string> {
    if (!this.engine) throw new Error('Engine not loaded');
    return this.enqueue(async () => {
      if (!this.engine) throw new Error('Engine not loaded');

      const { prefaceMessages, userText } = this.splitMessages(messages);
      // The web GPU backend defaults max_top_k to 1. Creating a TOP_K(40)
      // session is rejected and can poison the engine's context handler, so
      // clamp every LiteRT call to deterministic top-1 until Engine.create can
      // be given a complete, supported GPU configuration with a larger cap.
      const conversationConfig: ConversationConfig = {
        preface: { messages: prefaceMessages },
        sessionConfig: {
          ...(maxTokens > 0 ? { maxOutputTokens: maxTokens } : {}),
          samplerParams: {
            type: SamplerType.GREEDY,
            k: 1,
            temperature: 0,
            seed: 0,
          },
        },
      };

      // Create a fresh Conversation per call so each classification is
      // stateless — no KV-cache carryover between unrelated posts.
      const conversation = await this.engine.createConversation(conversationConfig);
      this.activeConversation = conversation;
      this.generating = true;
      try {
        const response = await conversation.sendMessage(userText);
        const raw = this.extractText(response);
        return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      } finally {
        this.generating = false;
        this.activeConversation = null;
        // Best-effort dispose. Errors here would mask a generation error.
        try { await conversation.delete(); } catch { /* noop */ }
      }
    });
  }

  private extractText(message: Message): string {
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!content) return '';
    return content.map(item => (item.type === 'text' ? (item.text ?? '') : '')).join('');
  }

  // Signals LiteRT-LM to abort decode, then awaits the chain so the caller
  // can rely on "interrupt resolved → engine idle". Prefill may not be
  // cancellable, so this may still take seconds on a fresh prompt.
  interrupt(): Promise<void> {
    if (this.activeConversation && this.generating) {
      this.activeConversation.cancel();
    }
    return this.chain.then(() => undefined, () => undefined);
  }

  // LiteRT-LM's JS layer doesn't expose a tokenizer. Approximate via
  // character count — Gemma BPE averages ~3.5 chars/token; we use 3 to
  // round up in token count so the orchestrator's budget math is
  // conservative.
  countTokens(text: string): Promise<number> {
    return Promise.resolve(Math.ceil(text.length / CHARS_PER_TOKEN));
  }

  truncateText(text: string, maxTokens: number): Promise<string> {
    if (Math.ceil(text.length / CHARS_PER_TOKEN) <= maxTokens) {
      return Promise.resolve(text);
    }
    return Promise.resolve(text.slice(0, maxTokens * CHARS_PER_TOKEN));
  }

  // Static cache probe so the orchestrator can ask "is this model on disk"
  // without instantiating Engine (which requires WebGPU and big memory).
  static async isCached(modelDef: LocalModelDef): Promise<boolean> {
    try {
      const url = modelDef.litertlmConfig?.modelUrl;
      if (!url) return false;
      if (typeof caches === 'undefined') return false;
      const cache = await caches.open(LITERTLM_CACHE_KEY);
      const hit = await cache.match(url);
      return hit !== undefined;
    } catch (e) {
      console.error('[LiteRT-LM] Error checking cache for', modelDef.name, ':', e);
      return false;
    }
  }

  // Static cache delete — symmetric with isCached(). Removes the cached
  // `.litertlm` blob (multiple GB) without instantiating Engine. Used by the
  // orchestrator's deleteModelCache dispatch.
  static async deleteCache(modelDef: LocalModelDef): Promise<void> {
    const url = modelDef.litertlmConfig?.modelUrl;
    if (!url) return;
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(LITERTLM_CACHE_KEY);
    const deleted = await cache.delete(url);
    const survivor = await cache.match(url);
    if (survivor) {
      throw new Error(
        `LiteRT-LM cache entry survived deletion (${deleted ? 'delete reported success' : 'delete reported failure'}).`,
      );
    }
  }
}

// Exposed for tests / teardown paths. The runtime itself never calls this
// during a normal session — the wasm module survives engine reloads.
export function unloadLitertlmWasm(): void {
  if (wasmLoaded) {
    try { unloadLiteRtLm(); } catch { /* noop */ }
    wasmLoaded = null;
  }
}

// Suppress unused-import warning on Backend. We don't override the default
// (GPU_ARTISAN, set by Engine.create) yet, but re-exporting keeps the import
// list tied to the API surface the runtime depends on.
export { Backend };
