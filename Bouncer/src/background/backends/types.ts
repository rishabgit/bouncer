// Common interface for local-inference backends (WebLLM/Qwen, LiteRT-LM/Gemma).
// LocalEngine (the orchestrator) holds one of these and delegates the
// model-specific calls. Lifecycle, status, the inference queue, keep-alive,
// idle-unload, and preemption all live in the orchestrator and are shared
// across backends.

import type { LocalModelDef, ChatMessage } from '../../types';

export interface InitProgress {
  progress: number;   // 0..1
  text: string;
}

export interface LocalBackend {
  // Load weights, tokenizer, and the GPU context. Resolves once the backend is
  // ready to accept generate() calls. Should honor abortSignal during downloads.
  initialize(
    modelDef: LocalModelDef,
    onProgress: (p: InitProgress) => void,
    abortSignal: AbortSignal,
  ): Promise<void>;

  // Free GPU memory and tokenizer state.
  unload(): Promise<void>;

  // Run a single completion. The backend is responsible for any per-call reset
  // (e.g. WebLLM's resetChat) and for image/text formatting. Returns the
  // trimmed text content with <think> blocks stripped.
  generate(
    messages: ChatMessage[],
    maxTokens: number,
    params: Record<string, unknown>,
  ): Promise<string>;

  // Cancel an in-flight generate(). Should be cheap to call when idle.
  interrupt(): Promise<void>;

  // Tokenizer helpers used by the post-evaluation orchestration to fit prompts
  // inside the context window.
  countTokens(text: string): Promise<number>;
  truncateText(text: string, maxTokens: number): Promise<string>;

  // 0 if the backend does not support images for the loaded model.
  getImageEmbedSize(): Promise<number>;
}

// Backend-level static cache check — answered without an initialized engine.
// A standalone function (not a method) because the orchestrator probes cache
// state for models that aren't currently loaded.
export type IsCachedFn = (modelDef: LocalModelDef) => Promise<boolean>;
