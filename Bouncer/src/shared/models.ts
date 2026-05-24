// Shared model definitions for Bouncer
// Used by both background and popup (via esbuild bundling)

import type { PredefinedModelsMap } from '../types';

export const PREDEFINED_MODELS: PredefinedModelsMap = {
  local: [
    {
      name: "Qwen3-4B-q4f16_1-MLC",
      display: "Qwen 3 4B",
      isLocal: true,
      supportsImages: false,
      sizeGB: 2.1,
      extraBody: { enable_thinking: false },
      inferenceParams: { temperature: 0.7, top_p: 0.8 },
      webllmConfig: {
        overrides: {
          context_window_size: 1024,
          prefill_chunk_size: 1024,
        },
        model_lib: "https://raw.githubusercontent.com/imbue-ai/binary-mlc-llm-libs/main/Qwen3-4B-q4f16_1-ctx1k_cs1k-webgpu-2.wasm",
      }
    },
    {
      name: "Qwen3_5-4B-q4f16_1-MLC",
      display: "Qwen 3.5 4B",
      isLocal: true,
      supportsImages: false,
      sizeGB: 2.2,
      inferenceParams: { temperature: 0.7, top_p: 0.8, presence_penalty: 0 },
      webllmConfig: {
        overrides: {
          context_window_size: 1024,
          prefill_chunk_size: 1024,
        },
        model_lib: "https://raw.githubusercontent.com/imbue-ai/binary-mlc-llm-libs/main/Qwen3.5-4B-q4f16_1-ctx1k_cs1k-webgpu-2.wasm",
        model: "https://huggingface.co/imbue/Qwen3.5-4B-q4f16_1-MLC-2"
      }
    },
    {
      name: "Qwen3_5-4B-vision-q4f16_1-MLC",
      display: "Qwen 3.5 4B Vision",
      isLocal: true,
      supportsImages: true,
      sizeGB: 2.8,
      inferenceParams: { temperature: 0.7, top_p: 0.8, presence_penalty: 0 },
      webllmConfig: {
        model_type: 2, // ModelType.VLM
        overrides: {
          context_window_size: 1024,
          prefill_chunk_size: 1024,
        },
        model_lib: "https://raw.githubusercontent.com/imbue-ai/binary-mlc-llm-libs/main/Qwen3.5-4B-vision-q4f16_1-ctx1k_cs1k-webgpu-2.wasm",
        model: "https://huggingface.co/imbue/Qwen3.5-4B-vision-q4f16_1-MLC-2"
      }
    }
  ]
};

// Default model: empty string, representing "no model configured" — the popup
// then prompts the user to download a local model. Imported by background,
// popup, and content scripts.
export const DEFAULT_MODEL = '';

export const API_DISPLAY_NAMES: Record<string, string> = {
  local: 'Local'
};
