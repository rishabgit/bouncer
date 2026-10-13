import type { ChatMessage } from '../../types';

export interface NativeReadiness {
  version: string;
  modelDigest: string;
  resident: boolean;
  otherModelResident: boolean;
}

export interface NativeGenerationHooks {
  /** Persist the durable lease and recheck cancellation before any POST. */
  beforeSubmit(readiness: NativeReadiness): Promise<void>;
  /** Final synchronous epoch check immediately before fetch invocation. */
  assertCanSubmit(): void;
  /** Called only for a terminal, local response, even after caller timeout. */
  onTerminal(): Promise<void>;
}

/** Narrow boundary for the sole fixed native classifier. */
export interface LocalBackend {
  check(): Promise<NativeReadiness>;
  generate(messages: ChatMessage[], maxTokens: number, hooks: NativeGenerationHooks): Promise<string>;
}


export interface BrowserProgress {
  progress: number;
  text: string;
  receivedBytes?: number;
  totalBytes?: number;
}

export interface BrowserState {
  cached: boolean;
  loaded: boolean;
  /** Includes queued verification and uncancellable cache-to-GPU creation. */
  initializing: boolean;
  downloading: boolean;
  progress?: number;
  receivedBytes?: number;
  totalBytes?: number;
}

/** Fixed browser artifact; lifecycle/cache probes never create a GPU host. */
export interface BrowserBackend {
  getState(): Promise<BrowserState>;
  download(onProgress: (progress: BrowserProgress) => void, signal: AbortSignal): Promise<void>;
  initialize(onProgress: (progress: BrowserProgress) => void, signal: AbortSignal): Promise<void>;
  generate(messages: ChatMessage[], maxTokens: number): Promise<string>;
  countTokens(text: string): Promise<number>;
  truncateText(text: string, maxTokens: number): Promise<string>;
  interrupt(): Promise<void>;
  unload(): Promise<void>;
  forceClose(): Promise<void>;
  deleteCache(): Promise<void>;
}


export type BrowserFailureReason = 'webgpu_unavailable' | 'storage_full' | 'download_failed' | 'artifact_integrity' | 'needs_download' | 'browser_failed' | 'browser_cancelled';
const BROWSER_FAILURE_REASONS: readonly string[] = ['webgpu_unavailable', 'storage_full', 'download_failed', 'artifact_integrity', 'needs_download', 'browser_failed', 'browser_cancelled'];
export function isBrowserFailureReason(value: unknown): value is BrowserFailureReason {
  return typeof value === 'string' && BROWSER_FAILURE_REASONS.includes(value);
}
export class BrowserModelError extends Error {
  constructor(readonly reason: BrowserFailureReason, message: string) { super(message); this.name = 'BrowserModelError'; }
}
