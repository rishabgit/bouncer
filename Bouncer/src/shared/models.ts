// Shared model definitions for Bouncer
// Used by both background and popup (via esbuild bundling)

import type { PredefinedModelsMap } from '../types';

export const PREDEFINED_MODELS: PredefinedModelsMap = {
  local: [
    {
      name: "Qwen3_5-4B-q4f16_1-MLC",
      display: "Qwen 3.5 4B",
      isLocal: true,
      backend: 'webllm',
      recommended: true,
      supportsImages: false,
      sizeGB: 2.2,
      inferenceParams: { temperature: 0.7, top_p: 0.8, presence_penalty: 0 },
      webllmConfig: {
        overrides: {
          context_window_size: 1024,
          prefill_chunk_size: 1024,
        },
        // Revision-pinned, self-hosted Apache-2.0 mirror of imbue's weights + MLC WebGPU lib (provenance + licenses: docs/models.md).
        model_lib: "https://huggingface.co/rishabhf/bouncer-qwen3.5-4b-mlc/resolve/3a23198afc863d3caf482ac24b9bd376df24f97f/Qwen3.5-4B-q4f16_1-ctx1k_cs1k-webgpu-2.wasm",
        model: "https://huggingface.co/rishabhf/bouncer-qwen3.5-4b-mlc/resolve/3a23198afc863d3caf482ac24b9bd376df24f97f/"
      }
    },
    {
      name: "Qwen3-4B-q4f16_1-MLC",
      display: "Qwen 3 4B",
      isLocal: true,
      backend: 'webllm',
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
      name: "Qwen3_5-4B-vision-q4f16_1-MLC",
      display: "Qwen 3.5 4B Vision",
      isLocal: true,
      backend: 'webllm',
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
    },
    {
      name: "gemma-4-E4B-it-web",
      display: "Gemma 4 E4B (Instruct)",
      isLocal: true,
      backend: 'litertlm',
      supportsImages: false,
      sizeGB: 3.0,
      inferenceParams: { temperature: 0.0 },
      litertlmConfig: {
        // Revision-pinned, self-hosted Apache-2.0 mirror of the litert-community .litertlm (provenance + licenses: docs/models.md).
        modelUrl: "https://huggingface.co/rishabhf/bouncer-gemma-4-e4b-litert/resolve/41a40dee03ce6185fb76bd96294f74561bf87f89/gemma-4-E4B-it-web.litertlm",
        maxTokens: 1024,
        topK: 40,
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
