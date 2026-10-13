import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_NATIVE_MANIFEST_DIGEST,
  ACCEPTED_NATIVE_WEIGHT_DIGEST,
  CANDIDATE_NATIVE_MANIFEST_DIGEST,
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
