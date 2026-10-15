import type { BrowserModelDef, InferenceEngineId, NativeModelDef } from '../types';

export const PRIMARY_LOCAL_MODEL_ID = 'bouncer-gemma4-e2b-qat-text:v1';
export const CANDIDATE_NATIVE_MANIFEST_DIGEST =
  'fbc40c82cb8acd3f63077d417d6040a42b5aeac406ed078fa8ba888fb38cfc19';

/** Fixed text-only QAT artifact accepted after the recorded Mac model checks. */
export const ACCEPTED_NATIVE_MANIFEST_DIGEST: string | null = CANDIDATE_NATIVE_MANIFEST_DIGEST;
export const ACCEPTED_NATIVE_WEIGHT_DIGEST =
  '3646b4c147cd235a44d91df1546d3b7d8e29b547dbe4e1f80856419aa455e6fd';
export const ACCEPTED_OLLAMA_VERSION = '0.40.3';
export const ACCEPTED_NATIVE_QUANTIZATION = 'Q4_0';
export const NATIVE_CONTEXT_TOKENS = 1024;
export const NATIVE_SUGGESTION_TOKENS = 150;
export const OPERATOR_RESTART_RECOVERY_QUALIFIED = true;
/** Default automatic work yields while another model is resident. */
export const CONCURRENT_NATIVE_MODELS_QUALIFIED = false;

export const PRIMARY_LOCAL_MODEL: NativeModelDef = Object.freeze({
  name: PRIMARY_LOCAL_MODEL_ID,
  display: 'Gemma 4 E2B',
  backend: 'ollama',
  manifestDigest: ACCEPTED_NATIVE_MANIFEST_DIGEST,
  weightDigest: ACCEPTED_NATIVE_WEIGHT_DIGEST,
  contextTokens: NATIVE_CONTEXT_TOKENS,
});

export const BROWSER_MODEL_ID = 'gemma-4-E2B-it-web';
export const BROWSER_MODEL_URL =
  'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/9262660a1676eed6d0c477ab1a86344430854664/gemma-4-E2B-it-web.litertlm';
export const BROWSER_MODEL_BYTES = 2_008_432_640;
export const BROWSER_MODEL_SHA256 = '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5';
export const BROWSER_RUNTIME_VERSION = '0.17.0';
export const BROWSER_MODEL: BrowserModelDef = Object.freeze({
  name: BROWSER_MODEL_ID,
  display: 'Gemma 4 E2B',
  backend: 'litertlm',
  weightDigest: BROWSER_MODEL_SHA256,
  contextTokens: 1024,
  sizeBytes: BROWSER_MODEL_BYTES,
  litertlmConfig: Object.freeze({ modelUrl: BROWSER_MODEL_URL, maxTokens: 1024 }),
});

export const INFERENCE_ENGINE_IDS: readonly InferenceEngineId[] = Object.freeze(['litertlm', 'ollama']);
export function isInferenceEngine(value: unknown): value is InferenceEngineId {
  return value === 'litertlm' || value === 'ollama';
}

export function modelForEngine(engine: InferenceEngineId): BrowserModelDef | NativeModelDef {
  return engine === 'litertlm' ? BROWSER_MODEL : PRIMARY_LOCAL_MODEL;
}

/** Cache identity includes the frozen native prompt, parser and input budget. */
export const NATIVE_CLASSIFIER_FINGERPRINT = [
  'native-v1',
  ACCEPTED_NATIVE_MANIFEST_DIGEST ?? 'unqualified',
  'table_yesno-numbered-v1',
  'strict-table-parser-v1',
  'think:false,stream:false,truncate:false,shift:false,temperature:0,seed:0,num_ctx:1024',
  'output:min(256,max(64,12*n)),input:ceil(chars/3)',
].join('|');

export const BROWSER_CLASSIFIER_FINGERPRINT = [
  'browser-v1', BROWSER_MODEL_SHA256, BROWSER_MODEL_URL, `litert-lm:${BROWSER_RUNTIME_VERSION}`,
  'table_yesno-comma-v1', 'strict-table-parser-v1', 'greedy,context:1024',
  'output:min(256,max(64,12*n)),input:ceil(chars/3)',
].join('|');

export function classifierFingerprintForEngine(engine: InferenceEngineId): string {
  return engine === 'litertlm' ? BROWSER_CLASSIFIER_FINGERPRINT : NATIVE_CLASSIFIER_FINGERPRINT;
}
