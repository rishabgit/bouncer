import type { ChatMessage, LocalModelStatus } from '../types';
import {
  ACCEPTED_NATIVE_MANIFEST_DIGEST,
  ACCEPTED_NATIVE_WEIGHT_DIGEST,
  ACCEPTED_NATIVE_QUANTIZATION,
  ACCEPTED_OLLAMA_VERSION,
  NATIVE_CONTEXT_TOKENS,
  PRIMARY_LOCAL_MODEL_ID,
} from './models';

export const OLLAMA_ORIGIN = 'http://127.0.0.1:11434';
export const OLLAMA_HOST_PERMISSION = `${OLLAMA_ORIGIN}/*`;
export const NATIVE_REQUEST_DEADLINE_MS = 25000;
export const NATIVE_METADATA_RETRY_MS = 5000;
export const NATIVE_METADATA_BODY_BYTES = 256 * 1024;
export const NATIVE_GENERATION_BODY_BYTES = 32 * 1024;

export type NativeFailureReason =
  | 'permission_required' | 'service_unreachable' | 'origin_rejected'
  | 'model_missing' | 'model_unqualified' | 'model_identity_changed'
  | 'runtime_incompatible' | 'metadata_invalid' | 'other_model_resident'
  | 'input_budget' | 'response_invalid' | 'native_timeout'
  | 'recovery_required' | 'inference_preempted' | 'storage_failed';

export class NativeModelError extends Error {
  constructor(
    public readonly reason: NativeFailureReason,
    message: string,
    public readonly submission: 'not_submitted' | 'uncertain' | 'terminal' = 'not_submitted',
  ) {
    super(message);
    this.name = 'NativeModelError';
  }
}

export function nativeFailureStatus(error: unknown): Omit<LocalModelStatus, 'revision'> {
  const failure = error instanceof NativeModelError ? error : null;
  const reason = failure?.reason ?? 'service_unreachable';
  const message = failure?.message ?? 'Cannot reach Ollama. Open Ollama, then Retry.';
  const state: LocalModelStatus['state'] = reason === 'permission_required' ? 'not_connected'
    : reason === 'model_missing' ? 'missing_model'
      : reason === 'other_model_resident' ? 'paused'
        : reason === 'recovery_required' || failure?.submission === 'uncertain' ? 'recovery_required'
          : ['origin_rejected', 'model_unqualified', 'model_identity_changed', 'runtime_incompatible', 'metadata_invalid'].includes(reason) ? 'blocked'
            : 'error';
  return { state, message, reason };
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function metadataError(message: string): never {
  throw new NativeModelError('metadata_invalid', message);
}

export function assertLocalMetadata(value: unknown): void {
  const body = record(value);
  for (const field of ['remote_host', 'remote_model']) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== '') {
      throw new NativeModelError('model_identity_changed', 'The classifier must use local weights. Repair the fixed model setup, then Retry.');
    }
  }
}

export function acceptedDigest(): string {
  if (!ACCEPTED_NATIVE_MANIFEST_DIGEST || !/^[a-f0-9]{64}$/.test(ACCEPTED_NATIVE_MANIFEST_DIGEST)) {
    throw new NativeModelError('model_unqualified', 'The fixed native classifier has not been qualified. Complete model setup before filtering.');
  }
  return ACCEPTED_NATIVE_MANIFEST_DIGEST;
}

export function acceptedModelReference(): string {
  return `sha256:${acceptedDigest()}`;
}

export function assertVersion(value: unknown): string {
  const version = record(value).version;
  if (version !== ACCEPTED_OLLAMA_VERSION) {
    throw new NativeModelError('runtime_incompatible', `Bouncer requires the qualified Ollama ${ACCEPTED_OLLAMA_VERSION} runtime. Check setup before filtering.`);
  }
  return version;
}

function assertDetails(value: unknown): void {
  const details = record(value);
  if (details.format !== 'gguf' || details.family !== 'gemma4'
      || details.quantization_level !== ACCEPTED_NATIVE_QUANTIZATION
      || details.runner !== 'llamacpp' || details.parameter_size !== '4.6B'
      || details.parent_model !== `sha256-${ACCEPTED_NATIVE_WEIGHT_DIGEST}`
      || !Array.isArray(details.families) || details.families.length !== 1
      || details.families[0] !== 'gemma4') {
    metadataError('The fixed classifier metadata changed. Repair model setup, then Retry.');
  }
  assertLocalMetadata(details);
}

/** The alias is a disk reference; every inference is pinned to its full digest. */
export function assertModelTag(value: unknown): void {
  const body = record(value);
  if (!Array.isArray(body.models)) metadataError('Ollama returned invalid model metadata.');
  const models = body.models.map(record);
  const selected = models.filter(model => model.name === PRIMARY_LOCAL_MODEL_ID || model.model === PRIMARY_LOCAL_MODEL_ID);
  if (selected.length === 0) {
    throw new NativeModelError('model_missing', `Set up ${PRIMARY_LOCAL_MODEL_ID}, then Retry.`);
  }
  if (selected.length !== 1 || selected[0].digest !== acceptedDigest()) {
    throw new NativeModelError('model_identity_changed', 'The fixed classifier digest changed. Repair model setup, then Retry.');
  }
  assertLocalMetadata(selected[0]);
  assertDetails(selected[0].details);
}

export function assertModelShow(value: unknown): void {
  const body = record(value);
  assertLocalMetadata(body);
  assertDetails(body.details);
  if (!Array.isArray(body.capabilities)
      || body.capabilities.length !== 3
      || (body.capabilities as unknown[]).slice().sort().join(',') !== 'completion,thinking,tools') {
    metadataError('The fixed classifier capabilities changed. Text-only model setup is required.');
  }
  const info = record(body.model_info);
  if (info['general.architecture'] !== 'gemma4'
      || info['general.parameter_count'] !== 4628569635
      || info['gemma4.block_count'] !== 35
      || info['gemma4.embedding_length'] !== 1536
      || info['gemma4.context_length'] !== 131072) {
    metadataError('The classifier weight metadata changed. Repair model setup, then Retry.');
  }
  if (typeof body.modelfile !== 'string') metadataError('Ollama did not return the classifier weight identity.');
  const lines = body.modelfile.split(/\r?\n/);
  const from = lines.filter(line => /^FROM\s/i.test(line));
  if (from.length !== 1 || !from[0].trim().endsWith(`sha256-${ACCEPTED_NATIVE_WEIGHT_DIGEST}`)
      || lines.filter(line => /^RENDERER\s/i.test(line)).join('\n') !== 'RENDERER gemma4-small'
      || lines.filter(line => /^PARSER\s/i.test(line)).join('\n') !== 'PARSER gemma4'
      || lines.some(line => /^(?:ADAPTER|DRAFT|PROJECTOR)\s/i.test(line))
      || body.template !== '{{ .Prompt }}') {
    metadataError('The classifier rendering or text weights changed. Repair model setup, then Retry.');
  }
  const parameters = typeof body.parameters === 'string'
    ? body.parameters.split(/\r?\n/).map(line => line.trim()).filter(Boolean).sort() : [];
  if (parameters.length !== 3
      || !parameters.some(line => /^temperature\s+1$/.test(line))
      || !parameters.some(line => /^top_k\s+64$/.test(line))
      || !parameters.some(line => /^top_p\s+0\.95$/.test(line))) {
    metadataError('The classifier parameters changed. Repair model setup, then Retry.');
  }
}

export function nativeResidency(value: unknown): { resident: boolean; otherModelResident: boolean } {
  const body = record(value);
  if (!Array.isArray(body.models)) metadataError('Ollama returned invalid residency metadata.');
  const models = body.models.map(record);
  const digest = acceptedDigest();
  for (const model of models) assertLocalMetadata(model);
  return {
    resident: models.some(model => model.digest === digest),
    otherModelResident: models.some(model => model.digest !== digest),
  };
}

export function validateNativeMessages(messages: ChatMessage[], maxTokens: number): void {
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 256
      || messages.length !== 2 || messages[0].role !== 'system' || messages[1].role !== 'user'
      || messages.some(message => typeof message.content !== 'string' || !message.content.trim())) {
    throw new NativeModelError('input_budget', 'Native filtering requires one bounded system/user request.');
  }
  if (Math.ceil(messages.map(message => message.content).join('\n').length / 3) + maxTokens > NATIVE_CONTEXT_TOKENS) {
    throw new NativeModelError('input_budget', 'The filter phrases and post exceed the native input budget.');
  }
}

/** A terminal local response is settlement evidence; it need not be a valid verdict. */
export function isQualifiedTerminalResponse(value: unknown): boolean {
  const body = record(value);
  try { assertLocalMetadata(body); } catch { return false; }
  return body.done === true
    && [acceptedModelReference(), `sha256-${acceptedDigest()}`].includes(typeof body.model === 'string' ? body.model : '');
}

export function parseNativeCompletion(value: unknown, maxTokens: number): string {
  const body = record(value);
  const message = record(body.message);
  const terminal = isQualifiedTerminalResponse(body);
  const invalid = (): never => { throw new NativeModelError('response_invalid', 'Ollama returned an incomplete or invalid classification. Retry from the popup.', terminal ? 'terminal' : 'uncertain'); };
  if (!terminal || body.done_reason !== 'stop'
      || body.error !== undefined || message.role !== 'assistant'
      || typeof message.content !== 'string' || !message.content.trim()
      || [body.thinking, message.thinking].some(value => value !== undefined && value !== null && value !== '')
      || (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))) invalid();
  const promptTokens = body.prompt_eval_count;
  const generatedTokens = body.eval_count;
  if (typeof promptTokens !== 'number' || !Number.isInteger(promptTokens) || promptTokens < 1
      || typeof generatedTokens !== 'number' || !Number.isInteger(generatedTokens) || generatedTokens < 1
      || promptTokens + maxTokens > NATIVE_CONTEXT_TOKENS || generatedTokens >= maxTokens) invalid();
  return (message.content as string).trim();
}
