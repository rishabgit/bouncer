// One build per runtime is the default; these precision pairs answer phase1b's
// explicit quantization question. d1-2B and d1-Omni-2B are different checkpoints.
export const VARIANTS = [
  { id: 'llama-kev-q8', runtime: 'llama', model: 'ggml-org/Kev-0.8B-GGUF:Q8_0', file: 'Kev-0.8B-Q8_0.gguf', family: 'kev-0.8b', format: 'GGUF Q8_0', parityGroup: 'kev-q8' },
  { id: 'ollama-kev-q8', runtime: 'ollama', model: 'bouncer-eval-kev-q8-ctx4096:v1', sourceModel: 'kev:0.8b-q8_0', family: 'kev-0.8b', format: 'GGUF Q8_0', parityGroup: 'kev-q8' },
  { id: 'ollama-kev-mxfp8', runtime: 'ollama', model: 'bouncer-eval-kev-mxfp8-ctx4096:v1', sourceModel: 'kev:0.8b-mxfp8', family: 'kev-0.8b', format: 'MLX MXFP8' },
  { id: 'llama-d1omni2b-q8', runtime: 'llama', model: 'ggml-org/d1-Omni-2B-GGUF:Q8_0', file: 'd1-Omni-2B-Q8_0.gguf', family: 'd1-omni-2b', format: 'GGUF Q8_0', batch: 4096 },
  { id: 'llama-d1-2b-q8', runtime: 'llama', model: 'LiquidAI/d1-2B-GGUF:Q8_0', file: 'd1-2B-Q8_0.gguf', family: 'd1-2b', format: 'GGUF Q8_0', batch: 4096, parityGroup: 'd1-2b' },
  { id: 'llama-d1-2b-q4km', runtime: 'llama', model: 'LiquidAI/d1-2B-GGUF:Q4_K_M', file: 'd1-2B-Q4_K_M.gguf', family: 'd1-2b', format: 'GGUF Q4_K_M', batch: 4096, parityGroup: 'd1-2b' },
  { id: 'ollama-d1-2b-mxfp8', runtime: 'ollama', model: 'bouncer-eval-d1-2b-mxfp8-ctx4096:v1', sourceModel: 'd1:2b-mxfp8', family: 'd1-2b', format: 'MLX MXFP8', parityGroup: 'd1-2b' },
  { id: 'ollama-d1-2b-nvfp4', runtime: 'ollama', model: 'bouncer-eval-d1-2b-nvfp4-ctx4096:v1', sourceModel: 'd1:2b-nvfp4', family: 'd1-2b', format: 'MLX NVFP4', parityGroup: 'd1-2b' },
  { id: 'llama-d1omni600m-q8', runtime: 'llama', model: 'LiquidAI/d1-omni-600M-GGUF:Q8_0', file: 'd1-omni-600M-Q8_0.gguf', family: 'd1-omni-600m', format: 'GGUF Q8_0', batch: 4096 },
].map(Object.freeze);

export function variantById(id) {
  const variant = VARIANTS.find(item => item.id === id);
  if (!variant) throw new Error(`Unknown variant ${id}`);
  return variant;
}
export const ENDPOINTS = Object.freeze({ llama: 'http://127.0.0.1:9931', ollama: 'http://127.0.0.1:11434' });
