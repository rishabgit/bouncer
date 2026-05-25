import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @mlc-ai/web-llm before importing the backend.
vi.mock('@mlc-ai/web-llm', () => ({
  CreateMLCEngine: vi.fn(),
  hasModelInCache: vi.fn(),
  deleteModelAllInfoInCache: vi.fn(),
  prebuiltAppConfig: {
    model_list: [
      {
        model_id: 'Qwen3-4B-q4f16_1-MLC',
        model: 'https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC',
        model_lib: 'https://raw.githubusercontent.com/user/Qwen3-4B-q4f16_1-ctx4k_cs1k-webgpu.wasm',
      },
    ],
  },
}));

// Mutable holder so individual tests can control PREDEFINED_MODELS.
const modelsState: { PREDEFINED_MODELS: { local: Record<string, unknown>[] } } = {
  PREDEFINED_MODELS: { local: [] },
};
vi.mock('../../src/shared/models.js', () => ({
  get PREDEFINED_MODELS() { return modelsState.PREDEFINED_MODELS; },
}));

import { WebllmBackend, isWebllmCached, deleteWebllmCache } from '../../src/background/backends/webllm-backend.js';
import { CreateMLCEngine, hasModelInCache, deleteModelAllInfoInCache } from '@mlc-ai/web-llm';
import type { Mock } from 'vitest';
import type { LocalModelDef } from '../../src/types.js';

// Fields injected into a WebllmBackend so generate() runs without a real init.
type BackendInternals = { engine: unknown; modelDef: LocalModelDef | null };

function makeMockEngine(createResponse = 'No match.') {
  return {
    resetChat: vi.fn().mockResolvedValue(undefined),
    interruptGenerate: vi.fn().mockResolvedValue(undefined),
    interruptSignal: false,
    unload: vi.fn().mockResolvedValue(undefined),
    countTokens: vi.fn().mockResolvedValue(7),
    truncateText: vi.fn(async (t: string) => t),
    getImageEmbedSize: vi.fn().mockResolvedValue(0),
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content: createResponse } }] }),
      },
    },
  };
}

function loadedBackend(
  mockEngine: unknown,
  modelDef: LocalModelDef = { name: 'TestModel-MLC', display: 'Test' } as LocalModelDef,
): WebllmBackend {
  const b = new WebllmBackend();
  (b as unknown as BackendInternals).engine = mockEngine;
  (b as unknown as BackendInternals).modelDef = modelDef;
  return b;
}

// ==================== WebllmBackend.initialize ====================

describe('WebllmBackend.initialize', () => {
  beforeEach(() => {
    (CreateMLCEngine as Mock).mockReset();
    modelsState.PREDEFINED_MODELS = { local: [{ name: 'TestModel-MLC', display: 'Test' }] };
  });

  it('creates the engine via CreateMLCEngine and relays cleaned progress text', async () => {
    const mockEngine = makeMockEngine();
    (CreateMLCEngine as Mock).mockImplementation(
      async (_id: string, cfg: { initProgressCallback: (p: { progress: number; text: string }) => void }) => {
        cfg.initProgressCallback({ progress: 0.5, text: 'Fetching param cache[1/2]. It can take a while...' });
        return mockEngine;
      },
    );

    const progresses: { progress: number; text: string }[] = [];
    const backend = new WebllmBackend();
    await backend.initialize(
      { name: 'TestModel-MLC', display: 'Test' } as LocalModelDef,
      (p) => progresses.push(p),
      new AbortController().signal,
    );

    expect(CreateMLCEngine).toHaveBeenCalledWith('TestModel-MLC', expect.anything(), expect.anything());
    // "Fetching param cache" → "Downloading param cache"; trailing "It can take a while" trimmed.
    expect(progresses[0].text).toBe('Downloading param cache [1 / 2]');
    // Engine is usable afterwards.
    expect(await backend.generate([{ role: 'user', content: 'x' }], 40, {})).toBe('No match.');
  });

  it('does not relay progress after the abort signal fires', async () => {
    const controller = new AbortController();
    (CreateMLCEngine as Mock).mockImplementation(
      async (_id: string, cfg: { initProgressCallback: (p: { progress: number; text: string }) => void }) => {
        controller.abort();
        cfg.initProgressCallback({ progress: 0.9, text: 'Fetching param cache[2/2]' });
        return makeMockEngine();
      },
    );

    const progresses: { progress: number; text: string }[] = [];
    const backend = new WebllmBackend();
    await backend.initialize(
      { name: 'TestModel-MLC', display: 'Test' } as LocalModelDef,
      (p) => progresses.push(p),
      controller.signal,
    );

    expect(progresses).toEqual([]);
  });
});

// ==================== WebllmBackend.generate ====================

describe('WebllmBackend.generate', () => {
  beforeEach(() => {
    modelsState.PREDEFINED_MODELS = { local: [{ name: 'TestModel-MLC', display: 'Test' }] };
  });

  it('calls resetChat then returns the response content', async () => {
    const mockEngine = makeMockEngine();
    const backend = loadedBackend(mockEngine);
    const result = await backend.generate([{ role: 'user', content: 'hello' }], 40, {});
    expect(mockEngine.resetChat).toHaveBeenCalled();
    expect(mockEngine.chat.completions.create).toHaveBeenCalled();
    expect(result).toBe('No match.');
  });

  it('strips <think> blocks from the response', async () => {
    const mockEngine = makeMockEngine();
    mockEngine.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '<think>reasoning here</think>No match.' } }],
    });
    const backend = loadedBackend(mockEngine);
    expect(await backend.generate([{ role: 'user', content: 'x' }], 40, {})).toBe('No match.');
  });

  it('merges max_tokens and per-call params into the request', async () => {
    const mockEngine = makeMockEngine();
    const backend = loadedBackend(mockEngine);
    await backend.generate([{ role: 'user', content: 'x' }], 40, { temperature: 0.7 });
    const request = mockEngine.chat.completions.create.mock.calls[0][0];
    expect(request.max_tokens).toBe(40);
    expect(request.temperature).toBe(0.7);
  });

  it('merges modelDef inferenceParams and extraBody into the request', async () => {
    const mockEngine = makeMockEngine();
    const backend = loadedBackend(mockEngine, {
      name: 'TestModel-MLC',
      display: 'Test',
      inferenceParams: { top_p: 0.8, presence_penalty: 0 },
      extraBody: { enable_thinking: false },
    } as LocalModelDef);
    await backend.generate([{ role: 'user', content: 'x' }], 40, {});
    const request = mockEngine.chat.completions.create.mock.calls[0][0];
    expect(request.top_p).toBe(0.8);
    expect(request.presence_penalty).toBe(0);
    expect(request.extra_body).toEqual({ enable_thinking: false });
  });

  it('clears a stale interruptSignal before generating', async () => {
    const mockEngine = makeMockEngine();
    mockEngine.interruptSignal = true;
    const backend = loadedBackend(mockEngine);
    await backend.generate([{ role: 'user', content: 'x' }], 40, {});
    expect(mockEngine.interruptSignal).toBe(false);
  });

  it('throws when the engine is not loaded', async () => {
    const backend = new WebllmBackend();
    await expect(backend.generate([{ role: 'user', content: 'x' }], 40, {})).rejects.toThrow('Engine not loaded');
  });
});

// ==================== WebllmBackend interrupt / unload / tokens ====================

describe('WebllmBackend lifecycle + tokenizer helpers', () => {
  it('interrupt delegates to engine.interruptGenerate', async () => {
    const mockEngine = makeMockEngine();
    const backend = loadedBackend(mockEngine);
    await backend.interrupt();
    expect(mockEngine.interruptGenerate).toHaveBeenCalled();
  });

  it('interrupt is a no-op when no engine is loaded', async () => {
    const backend = new WebllmBackend();
    await expect(backend.interrupt()).resolves.toBeUndefined();
  });

  it('unload frees the engine so generate then throws', async () => {
    const mockEngine = makeMockEngine();
    const backend = loadedBackend(mockEngine);
    await backend.unload();
    expect(mockEngine.unload).toHaveBeenCalled();
    await expect(backend.generate([{ role: 'user', content: 'x' }], 40, {})).rejects.toThrow('Engine not loaded');
  });

  it('countTokens / truncateText / getImageEmbedSize delegate to the engine', async () => {
    const mockEngine = makeMockEngine();
    const backend = loadedBackend(mockEngine);
    expect(await backend.countTokens('abc')).toBe(7);
    expect(await backend.truncateText('hello world', 3)).toBe('hello world');
    expect(await backend.getImageEmbedSize()).toBe(0);
  });

  it('tokenizer helpers throw when no engine is loaded', async () => {
    const backend = new WebllmBackend();
    await expect(backend.countTokens('x')).rejects.toThrow('Engine not loaded');
    await expect(backend.truncateText('x', 1)).rejects.toThrow('Engine not loaded');
    await expect(backend.getImageEmbedSize()).rejects.toThrow('Engine not loaded');
  });
});

// ==================== isWebllmCached ====================

describe('isWebllmCached', () => {
  beforeEach(() => {
    (hasModelInCache as Mock).mockReset();
    modelsState.PREDEFINED_MODELS = { local: [{ name: 'TestModel-MLC', display: 'Test' }] };
  });

  it('returns the hasModelInCache result for the model', async () => {
    (hasModelInCache as Mock).mockResolvedValue(true);
    expect(await isWebllmCached({ name: 'TestModel-MLC', display: 'Test' } as LocalModelDef)).toBe(true);
    expect(hasModelInCache).toHaveBeenCalledWith('TestModel-MLC', undefined);
  });

  it('returns false when the cache check throws', async () => {
    (hasModelInCache as Mock).mockRejectedValue(new Error('cache boom'));
    expect(await isWebllmCached({ name: 'TestModel-MLC', display: 'Test' } as LocalModelDef)).toBe(false);
  });
});

// ==================== deleteWebllmCache ====================

describe('deleteWebllmCache', () => {
  beforeEach(() => {
    (deleteModelAllInfoInCache as Mock).mockReset();
    modelsState.PREDEFINED_MODELS = { local: [{ name: 'TestModel-MLC', display: 'Test' }] };
  });

  it('deletes all info for the model from the WebLLM cache', async () => {
    (deleteModelAllInfoInCache as Mock).mockResolvedValue(undefined);
    await deleteWebllmCache({ name: 'TestModel-MLC', display: 'Test' } as LocalModelDef);
    expect(deleteModelAllInfoInCache).toHaveBeenCalledWith('TestModel-MLC', undefined);
  });

  it("purges only this model's orphaned tensor-cache.json manifest", async () => {
    // WebLLM's deleteModelInCache deletes the shards but leaves
    // tensor-cache.json behind; deleteWebllmCache must scrub it.
    modelsState.PREDEFINED_MODELS = { local: [{
      name: 'TestModel-MLC', display: 'Test',
      webllmConfig: { model: 'https://huggingface.co/test/TestModel-MLC', model_lib: 'https://x/test.wasm' },
    }] };
    (deleteModelAllInfoInCache as Mock).mockResolvedValue(undefined);

    const orphan = 'https://huggingface.co/test/TestModel-MLC/resolve/main/tensor-cache.json';
    const otherModel = 'https://huggingface.co/test/OtherModel/resolve/main/tensor-cache.json';
    const deleted: string[] = [];
    const modelCache = {
      keys: vi.fn(async () => [{ url: orphan }, { url: otherModel }]),
      delete: vi.fn(async (req: { url: string }) => { deleted.push(req.url); return true; }),
    };
    const prevCaches = (globalThis as unknown as { caches?: unknown }).caches;
    (globalThis as unknown as { caches: unknown }).caches = {
      open: vi.fn(async (n: string) => (n === 'webllm/model' ? modelCache : { keys: async () => [], delete: async () => false })),
    };

    try {
      await deleteWebllmCache({
        name: 'TestModel-MLC', display: 'Test',
        webllmConfig: { model: 'https://huggingface.co/test/TestModel-MLC', model_lib: 'https://x/test.wasm' },
      } as LocalModelDef);
      expect(deleted).toEqual([orphan]);
    } finally {
      (globalThis as unknown as { caches?: unknown }).caches = prevCaches;
    }
  });
});
