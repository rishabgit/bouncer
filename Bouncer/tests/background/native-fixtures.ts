import { ACCEPTED_NATIVE_QUANTIZATION, ACCEPTED_NATIVE_WEIGHT_DIGEST, PRIMARY_LOCAL_MODEL_ID } from '../../src/shared/models.js';

export const TEST_DIGEST = 'a'.repeat(64);
export const TEST_READINESS = { version: '0.40.3', modelDigest: TEST_DIGEST, resident: false, otherModelResident: false };
export const TEST_DETAILS = {
  parent_model: `sha256-${ACCEPTED_NATIVE_WEIGHT_DIGEST}`,
  format: 'gguf', family: 'gemma4', families: ['gemma4'],
  parameter_size: '4.6B', quantization_level: ACCEPTED_NATIVE_QUANTIZATION, runner: 'llamacpp',
};
export const TEST_SHOW = {
  details: TEST_DETAILS,
  capabilities: ['completion', 'tools', 'thinking'],
  template: '{{ .Prompt }}',
  modelfile: `FROM /synthetic/blobs/sha256-${ACCEPTED_NATIVE_WEIGHT_DIGEST}\nRENDERER gemma4-small\nPARSER gemma4`,
  parameters: 'temperature 1\ntop_k 64\ntop_p 0.95',
  model_info: {
    'general.architecture': 'gemma4',
    'general.parameter_count': 4628569635,
    'gemma4.block_count': 35,
    'gemma4.embedding_length': 1536,
    'gemma4.context_length': 131072,
  },
};
export const TEST_TAGS = { models: [{ name: PRIMARY_LOCAL_MODEL_ID, model: PRIMARY_LOCAL_MODEL_ID, digest: TEST_DIGEST, details: TEST_DETAILS }] };
export function completion(content = 'no', extra: Record<string, unknown> = {}) {
  return {
    model: `sha256:${TEST_DIGEST}`,
    done: true, done_reason: 'stop',
    message: { role: 'assistant', content },
    prompt_eval_count: 100, eval_count: 1,
    ...extra,
  };
}
export const TEST_MESSAGES = [
  { role: 'system' as const, content: 'Classify synthetic post.' },
  { role: 'user' as const, content: 'A synthetic post about bicycles.' },
];
