import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_NATIVE_MANIFEST_DIGEST,
  ACCEPTED_NATIVE_WEIGHT_DIGEST,
  BROWSER_CLASSIFIER_FINGERPRINT,
  BROWSER_MODEL,
  BROWSER_MODEL_BYTES,
  BROWSER_MODEL_ID,
  BROWSER_MODEL_SHA256,
  BROWSER_MODEL_URL,
  BROWSER_RUNTIME_VERSION,
  CANDIDATE_NATIVE_MANIFEST_DIGEST,
  classifierFingerprintForEngine,
  INFERENCE_ENGINE_IDS,
  isInferenceEngine,
  modelForEngine,
  NATIVE_CLASSIFIER_FINGERPRINT,
  OPERATOR_RESTART_RECOVERY_QUALIFIED,
  PRIMARY_LOCAL_MODEL,
  PRIMARY_LOCAL_MODEL_ID,
} from '../../src/shared/models.js';
import { acceptedModelReference } from '../../src/shared/ollama-contract.js';

describe('fixed native model contract', () => {
  it('has one fixed native classifier and exact measured text weights', () => {
    expect(PRIMARY_LOCAL_MODEL).toMatchObject({
      name: PRIMARY_LOCAL_MODEL_ID, backend: 'ollama',
      weightDigest: ACCEPTED_NATIVE_WEIGHT_DIGEST, contextTokens: 1024,
    });
    expect(Object.keys(PRIMARY_LOCAL_MODEL)).not.toContain('litertlmConfig');
    expect(CANDIDATE_NATIVE_MANIFEST_DIGEST).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps runtime and operator recovery qualification fail-closed until the root gates pass', () => {
    if (ACCEPTED_NATIVE_MANIFEST_DIGEST === null) {
      expect(() => acceptedModelReference()).toThrow('has not been qualified');
    } else {
      expect(ACCEPTED_NATIVE_MANIFEST_DIGEST).toMatch(/^[a-f0-9]{64}$/);
      expect(acceptedModelReference()).toBe(`sha256:${ACCEPTED_NATIVE_MANIFEST_DIGEST}`);
    }
    expect(typeof OPERATOR_RESTART_RECOVERY_QUALIFIED).toBe('boolean');
  });

  it('fingerprints the artifact, numbered prompt, strict parser and effective budgets', () => {
    expect(NATIVE_CLASSIFIER_FINGERPRINT).toContain(ACCEPTED_NATIVE_MANIFEST_DIGEST ?? 'unqualified');
    expect(NATIVE_CLASSIFIER_FINGERPRINT).toContain('table_yesno-numbered-v1');
    expect(NATIVE_CLASSIFIER_FINGERPRINT).toContain('strict-table-parser-v1');
    expect(NATIVE_CLASSIFIER_FINGERPRINT).toContain('num_ctx:1024');
    expect(NATIVE_CLASSIFIER_FINGERPRINT).toContain('truncate:false,shift:false');
    expect(NATIVE_CLASSIFIER_FINGERPRINT).toContain('input:ceil(chars/3)');
  });
});

describe('explicit fixed engine contracts', () => {
  it('accepts only the two engines and maps each to its own immutable artifact', () => {
    expect(INFERENCE_ENGINE_IDS).toEqual(['litertlm', 'ollama']);
    expect(modelForEngine('litertlm')).toBe(BROWSER_MODEL);
    expect(modelForEngine('ollama')).toBe(PRIMARY_LOCAL_MODEL);
    expect(Object.isFrozen(BROWSER_MODEL)).toBe(true);
    expect(Object.isFrozen(BROWSER_MODEL.litertlmConfig)).toBe(true);
    expect(Object.isFrozen(PRIMARY_LOCAL_MODEL)).toBe(true);
    for (const value of [null, undefined, '', 'auto', 'webllm', 'custom', 'Ollama']) {
      expect(isInferenceEngine(value)).toBe(false);
    }
    expect(isInferenceEngine('litertlm')).toBe(true);
    expect(isInferenceEngine('ollama')).toBe(true);
  });

  it('pins the browser artifact size, digest, revision and locally bundled runtime', () => {
    expect(BROWSER_MODEL).toMatchObject({
      name: BROWSER_MODEL_ID, backend: 'litertlm', contextTokens: 1024,
      sizeBytes: BROWSER_MODEL_BYTES, weightDigest: BROWSER_MODEL_SHA256,
      litertlmConfig: { modelUrl: BROWSER_MODEL_URL, maxTokens: 1024 },
    });
    expect(BROWSER_MODEL_BYTES).toBe(2_008_432_640);
    expect(BROWSER_MODEL_SHA256).toBe('3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5');
    expect(BROWSER_MODEL_URL).toBe('https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/9262660a1676eed6d0c477ab1a86344430854664/gemma-4-E2B-it-web.litertlm');
    expect(BROWSER_RUNTIME_VERSION).toBe('0.17.0');
  });

  it('keeps browser and native verdict identities separate through artifact, prompt and runtime', () => {
    expect(classifierFingerprintForEngine('litertlm')).toBe(BROWSER_CLASSIFIER_FINGERPRINT);
    expect(classifierFingerprintForEngine('ollama')).toBe(NATIVE_CLASSIFIER_FINGERPRINT);
    expect(BROWSER_CLASSIFIER_FINGERPRINT).not.toBe(NATIVE_CLASSIFIER_FINGERPRINT);
    expect(BROWSER_CLASSIFIER_FINGERPRINT).toContain(BROWSER_MODEL_SHA256);
    expect(BROWSER_CLASSIFIER_FINGERPRINT).toContain(BROWSER_MODEL_URL);
    expect(BROWSER_CLASSIFIER_FINGERPRINT).toContain('litert-lm:0.17.0');
    expect(BROWSER_CLASSIFIER_FINGERPRINT).toContain('table_yesno-comma-v1');
    expect(BROWSER_CLASSIFIER_FINGERPRINT).toContain('strict-table-parser-v1');
    expect(BROWSER_CLASSIFIER_FINGERPRINT).toContain('context:1024');
    expect(BROWSER_CLASSIFIER_FINGERPRINT).toContain('input:ceil(chars/3)');
  });
});
