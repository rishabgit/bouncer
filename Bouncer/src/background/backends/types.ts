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
