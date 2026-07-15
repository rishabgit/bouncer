// Common boundary between the model lifecycle orchestrator and LiteRT-LM.
// Keeping this seam makes the runtime testable without carrying multiple
// product backends.

import type { LocalModelDef, ChatMessage } from '../../types';

export interface InitProgress {
  progress: number;   // 0..1
  text: string;
}

export interface LocalBackend {
  // True when this backend owns an isolated runtime and can safely unload a
  // late engine after its initialization was superseded. Chrome LiteRT uses a
  // shared offscreen host, so its proxy leaves this false.
  unloadAfterSuperseded?: boolean;

  // Load weights, tokenizer, and the GPU context. Resolves once the backend is
  // ready to accept generate() calls. Should honor abortSignal during downloads.
  initialize(
    modelDef: LocalModelDef,
    onProgress: (p: InitProgress) => void,
    abortSignal: AbortSignal,
  ): Promise<void>;

  // Free GPU memory and tokenizer state.
  unload(): Promise<void>;

  // Run a single completion and return trimmed text with think blocks removed.
  generate(
    messages: ChatMessage[],
    maxTokens: number,
  ): Promise<string>;

  // Cancel an in-flight generate(). Should be cheap to call when idle.
  interrupt(): Promise<void>;

  // Tokenizer helpers used by the post-evaluation orchestration to fit prompts
  // inside the context window.
  countTokens(text: string): Promise<number>;
  truncateText(text: string, maxTokens: number): Promise<string>;

}

// Backend-level static cache check — answered without an initialized engine.
// A standalone function (not a method) because the orchestrator probes cache
// state for models that aren't currently loaded.
export type IsCachedFn = (modelDef: LocalModelDef) => Promise<boolean>;
