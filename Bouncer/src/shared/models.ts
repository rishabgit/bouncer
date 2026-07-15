// Shared production model definitions for Bouncer.
// Used by the background, popup, and content scripts via esbuild bundling.

import type { LocalModelDef, PredefinedModelsMap } from '../types';

export const PRIMARY_LOCAL_MODEL_ID = 'gemma-4-E2B-it-web';

// Revision-pinned upstream LiteRT-LM artifact. Keeping the URL in one exported
// constant also gives the retirement migration an exact cache key to preserve.
export const PRIMARY_LOCAL_MODEL_URL =
  'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/9262660a1676eed6d0c477ab1a86344430854664/gemma-4-E2B-it-web.litertlm';

export const PRIMARY_LOCAL_MODEL: LocalModelDef = {
  name: PRIMARY_LOCAL_MODEL_ID,
  display: 'Gemma 4 E2B (Instruct)',
  isLocal: true,
  backend: 'litertlm',
  sizeGB: 2.008,
  litertlmConfig: {
    modelUrl: PRIMARY_LOCAL_MODEL_URL,
    maxTokens: 1024,
  },
};

/** The production catalog intentionally contains one on-device model. */
export const PREDEFINED_MODELS: PredefinedModelsMap = {
  local: [PRIMARY_LOCAL_MODEL],
};

export const DEFAULT_MODEL = `local:${PRIMARY_LOCAL_MODEL_ID}`;
