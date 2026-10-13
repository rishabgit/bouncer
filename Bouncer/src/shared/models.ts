import type { LocalModelDef } from '../types';

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

export const PRIMARY_LOCAL_MODEL: LocalModelDef = Object.freeze({
  name: PRIMARY_LOCAL_MODEL_ID,
  display: 'Gemma 4 E2B',
  backend: 'ollama',
  manifestDigest: ACCEPTED_NATIVE_MANIFEST_DIGEST,
  weightDigest: ACCEPTED_NATIVE_WEIGHT_DIGEST,
  contextTokens: NATIVE_CONTEXT_TOKENS,
});

/** Cache identity includes the frozen native prompt, parser and input budget. */
export const NATIVE_CLASSIFIER_FINGERPRINT = [
  'native-v1',
  ACCEPTED_NATIVE_MANIFEST_DIGEST ?? 'unqualified',
  'table_yesno-numbered-v1',
  'strict-table-parser-v1',
  'think:false,stream:false,truncate:false,shift:false,temperature:0,seed:0,num_ctx:1024',
  'output:min(256,max(64,12*n)),input:ceil(chars/3)',
].join('|');
