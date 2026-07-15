import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  PREDEFINED_MODELS,
  PRIMARY_LOCAL_MODEL,
  PRIMARY_LOCAL_MODEL_ID,
  PRIMARY_LOCAL_MODEL_URL,
} from '../../src/shared/models.js';
import {
  BENCHMARK_E4B_MODEL,
  GEMMA_BENCHMARK_MODELS,
} from '../../src/shared/benchmark-models.js';

describe('production local model catalog', () => {
  it('ships exactly the canonical Gemma E2B model', () => {
    expect(PREDEFINED_MODELS.local).toEqual([PRIMARY_LOCAL_MODEL]);
    expect(PRIMARY_LOCAL_MODEL).toMatchObject({
      name: PRIMARY_LOCAL_MODEL_ID,
      backend: 'litertlm',
      litertlmConfig: { modelUrl: PRIMARY_LOCAL_MODEL_URL },
    });
    expect(DEFAULT_MODEL).toBe(`local:${PRIMARY_LOCAL_MODEL_ID}`);
  });

  it('keeps E4B confined to the benchmark catalog', () => {
    expect(PREDEFINED_MODELS.local).not.toContainEqual(BENCHMARK_E4B_MODEL);
    expect(PREDEFINED_MODELS.local.map(model => model.name)).not.toContain(
      BENCHMARK_E4B_MODEL.name,
    );
    expect(GEMMA_BENCHMARK_MODELS.map(model => model.name)).toEqual([
      PRIMARY_LOCAL_MODEL_ID,
      'gemma-4-E4B-it-web',
    ]);
  });
});
