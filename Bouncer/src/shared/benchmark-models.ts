import type { LocalModelDef } from '../types';
import { PRIMARY_LOCAL_MODEL } from './models';

/**
 * Retired Gemma E4B comparator for the development benchmark harness only.
 * It must not be added to PREDEFINED_MODELS or exposed as a product choice.
 */
export const BENCHMARK_E4B_MODEL: LocalModelDef = {
  name: 'gemma-4-E4B-it-web',
  display: 'Gemma 4 E4B (Benchmark comparator)',
  isLocal: true,
  backend: 'litertlm',
  sizeGB: 3.0,
  litertlmConfig: {
    modelUrl:
      'https://huggingface.co/rishabhf/bouncer-gemma-4-e4b-litert/resolve/41a40dee03ce6185fb76bd96294f74561bf87f89/gemma-4-E4B-it-web.litertlm',
    maxTokens: 1024,
  },
};

export const GEMMA_BENCHMARK_MODELS: readonly LocalModelDef[] = [
  PRIMARY_LOCAL_MODEL,
  BENCHMARK_E4B_MODEL,
];
