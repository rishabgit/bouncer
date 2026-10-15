// Wraps LiteRT-LM's Engine + Conversation for use as a Bouncer LocalBackend.
// Runs only in the Chrome offscreen document. Chrome's MV3
// service worker proxies through litertlm-proxy.ts because @litertjs/wasm-utils
// uses <script> tag injection to load the wasm runner, which a module SW
// cannot do.

import {
  Engine,
  loadLiteRtLm,
  unloadLiteRtLm,
  SamplerType,
  type Conversation,
  type ConversationConfig,
  type Message,
} from '@litert-lm/core';
import type { ChatMessage } from '../types';
import { getLitertlmLoaderUrl } from './litertlm-loader';

import { BROWSER_MODEL } from '../shared/models';
import { readVerifiedCachedModel, prefetchFixedModel, type CacheGeneration } from '../background/backends/model-cache';
import { BrowserModelError, type BrowserProgress } from '../background/backends/types';

const CHARS_PER_TOKEN = 3;
export type InitProgress = BrowserProgress;
function getWasmBaseUrl(): string {
  return chrome.runtime.getURL('dist/litertlm-wasm/');
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
      .then(() => loadLiteRtLm(getLitertlmLoaderUrl(getWasmBaseUrl())))
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

export class LitertlmRuntime {
  private engine: Engine | null = null;
  private activeConversation: Conversation | null = null;
  private baseConversation: Conversation | null = null;
  private baseKey: string | null = null;
  // Keep the previous clone until its successor has been cloned. LiteRT's
  // executor may still use it as a dependency of the next clone operation.
  private retiredConversation: Conversation | null = null;
  private generating = false;
  private generationEpoch = 0;
  private unloading: Promise<void> | null = null;
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
    generation: CacheGeneration,
    _onProgress: (p: InitProgress) => void,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const cfg = BROWSER_MODEL.litertlmConfig;
    if (this.unloading) throw new Error('Runtime unloading');

    // Engine creation shares the generation queue so unload cannot delete
    // engine state while an uncancellable model load is still settling.
    return this.enqueue(async () => {
      this.checkInitialization(abortSignal);
      if (this.engine) return;
      // Only the real network path emits progress. Wasm startup, cache hits,
      // and cache-to-GPU loading remain in the caller's initializing state.
      const cached = await readVerifiedCachedModel(generation, abortSignal);
      this.checkInitialization(abortSignal);
      if (!(globalThis.navigator as Navigator & { gpu?: unknown } | undefined)?.gpu) throw new BrowserModelError('webgpu_unavailable', 'Browser GPU support is unavailable. Use a supported Chrome device.');
      await ensureWasmLoaded();
      this.checkInitialization(abortSignal);

      // Stream the model into GPU memory instead of creating a multi-GB blob.
      if (!cached.body) throw new Error('Cached model response has no body');
      const engine = await Engine.create({
        model: cached.body,
        mainExecutorSettings: { maxNumTokens: cfg.maxTokens ?? 1024 },
      });
      try {
        this.checkInitialization(abortSignal);
      } catch (error) {
        try { await engine.delete(); } catch { /* preserve cancellation */ }
        throw error;
      }
      this.engine = engine;
    });
  }

  private checkInitialization(abortSignal: AbortSignal): void {
    if (abortSignal.aborted) throw new Error('aborted');
    if (this.unloading) throw new Error('Runtime unloading');
  }

  private cancelActiveConversation(): void {
    if (this.activeConversation && this.generating) {
      try { this.activeConversation.cancel(); }
      catch (error) { console.error('[LiteRT-LM] Error cancelling conversation:', error); }
    }
  }

  private async deleteConversation(conversation: Conversation | null): Promise<void> {
    if (!conversation) return;
    try { await conversation.delete(); }
    catch (error) { console.error('[LiteRT-LM] Error deleting conversation:', error); }
  }

  private async clearPrefixCache(): Promise<void> {
    const retired = this.retiredConversation;
    const base = this.baseConversation;
    this.retiredConversation = null;
    this.baseConversation = null;
    this.baseKey = null;
    await this.deleteConversation(retired);
    await this.deleteConversation(base);
  }

  unload(): Promise<void> {
    // Invalidate queued requests synchronously, including those still awaiting
    // prefill or clone setup. Cancellation alone only interrupts active decode.
    this.generationEpoch++;
    this.cancelActiveConversation();
    if (this.unloading) return this.unloading;

    const unloading = this.enqueue(async () => {
      await this.clearPrefixCache();
      await this.deleteConversation(this.activeConversation);
      this.activeConversation = null;
      try { await this.engine?.delete(); }
      catch (error) { console.error('[LiteRT-LM] Error deleting engine:', error); }
      this.engine = null;
      this.generating = false;
    });
    const completed = unloading.finally(() => {
      if (this.unloading === completed) this.unloading = null;
    });
    this.unloading = completed;
    return completed;
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

  private checkGeneration(epoch: number): void {
    if (epoch !== this.generationEpoch) throw new Error('Generation interrupted');
    if (this.unloading) throw new Error('Runtime unloading');
    if (!this.engine) throw new Error('Engine not loaded');
  }

  private async getOrBuildBase(prefaceMessages: Message[], maxTokens: number, epoch: number): Promise<Conversation> {
    const key = JSON.stringify({ prefaceMessages, maxTokens });
    if (this.baseConversation && this.baseKey === key) return this.baseConversation;

    const retired = this.retiredConversation;
    this.retiredConversation = null;
    await this.deleteConversation(retired);
    this.checkGeneration(epoch);
    const previousBase = this.baseConversation;
    this.baseConversation = null;
    this.baseKey = null;
    await this.deleteConversation(previousBase);
    this.checkGeneration(epoch);

    // The web GPU backend defaults max_top_k to 1. Preserve deterministic
    // greedy sampling and the caller's output ceiling for the cached session.
    const config: ConversationConfig = {
      preface: { messages: prefaceMessages },
      prefillPrefaceOnInit: true,
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
    const base = await this.engine!.createConversation(config);
    this.baseConversation = base;
    this.baseKey = key;
    this.checkGeneration(epoch);
    return base;
  }

  generate(messages: ChatMessage[], maxTokens: number): Promise<string> {
    if (this.unloading) throw new Error('Runtime unloading');
    if (!this.engine) throw new Error('Engine not loaded');
    // Capture at call time: an interrupt must also invalidate requests that
    // have not reached the front of the queue yet.
    const epoch = this.generationEpoch;
    return this.enqueue(async () => {
      this.checkGeneration(epoch);
      const { prefaceMessages, userText } = this.splitMessages(messages);
      let conversation: Conversation | null = null;
      try {
        const base = await this.getOrBuildBase(prefaceMessages, maxTokens, epoch);
        this.checkGeneration(epoch);
        // Clone only the prefetched prefix. Post text and assistant histories
        // live exclusively in independent, short-lived clones.
        conversation = await base.clone();
        this.activeConversation = conversation;
        this.checkGeneration(epoch);

        // Scheduling the successor clone above releases the old clone's
        // dependency. At most base + retired + current are resident briefly.
        const retired = this.retiredConversation;
        this.retiredConversation = null;
        await this.deleteConversation(retired);
        this.checkGeneration(epoch);

        this.generating = true;
        this.checkGeneration(epoch);
        const response = await conversation.sendMessage(userText);
        this.checkGeneration(epoch);
        const raw = this.extractText(response);
        const result = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        this.checkGeneration(epoch);
        this.retiredConversation = conversation;
        conversation = null;
        return result;
      } catch (error) {
        // Drop the entire session on failure/cancellation so a fresh request
        // never inherits a poisoned executor or partially prepared prefix.
        await this.deleteConversation(conversation);
        await this.clearPrefixCache();
        throw error;
      } finally {
        this.generating = false;
        this.activeConversation = null;
      }
    });
  }

  private extractText(message: Message): string {
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!content) return '';
    return content.map(item => (item.type === 'text' ? (item.text ?? '') : '')).join('');
  }

  // Interrupt active decode and invalidate queued/setup work immediately.
  // Prefill may not be cancellable, so cleanup waits for it to settle.
  interrupt(): Promise<void> {
    this.generationEpoch++;
    this.cancelActiveConversation();
    return this.enqueue(() => this.clearPrefixCache());
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

  get loaded(): boolean { return this.engine !== null; }

  async prefetch(generation: CacheGeneration, onProgress: (p: InitProgress) => void, signal: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      this.checkInitialization(signal);
      await prefetchFixedModel(generation, onProgress, signal);
    });
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
