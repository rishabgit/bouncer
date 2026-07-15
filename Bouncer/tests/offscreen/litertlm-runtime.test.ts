import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@litert-lm/core', () => ({
  Engine: { create: vi.fn() },
  loadLiteRtLm: vi.fn().mockResolvedValue(undefined),
  unloadLiteRtLm: vi.fn().mockResolvedValue(undefined),
  Backend: { GPU_ARTISAN: 'GPU_ARTISAN' },
  SamplerType: { GREEDY: 'GREEDY', TOP_K: 'TOP_K' },
}));

import { Engine, SamplerType } from '@litert-lm/core';
import { LitertlmRuntime, prefetchLitertlmModel } from '../../src/offscreen/litertlm-runtime.js';
import type { LocalModelDef } from '../../src/types.js';

describe('LitertlmRuntime', () => {
  const modelDef: LocalModelDef = {
    name: 'gemma-test',
    backend: 'litertlm',
    inferenceParams: { temperature: 0.7 },
    litertlmConfig: {
      modelUrl: 'https://example.test/gemma.litertlm',
      maxTokens: 1024,
      topK: 40,
    },
  };

  let createConversation: Mock;
  let runtime: LitertlmRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.chrome = {
      runtime: { getURL: vi.fn(path => `chrome-extension://test/${path}`) },
    } as unknown as typeof chrome;

    const conversation = {
      sendMessage: vi.fn().mockResolvedValue({ role: 'assistant', content: 'yes' }),
      cancel: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    createConversation = vi.fn().mockResolvedValue(conversation);
    (Engine.create as Mock).mockResolvedValue({
      createConversation,
      delete: vi.fn().mockResolvedValue(undefined),
    });

    globalThis.caches = {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))),
        put: vi.fn(),
      }),
    } as unknown as CacheStorage;

    runtime = new LitertlmRuntime();
  });

  it('does not report a cached model as a completed network download', async () => {
    const onProgress = vi.fn();

    await runtime.initialize(modelDef, onProgress, new AbortController().signal);

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('prefetches into Cache Storage without creating a LiteRT GPU engine', async () => {
    const entries = new Map<string, Response>();
    globalThis.caches = {
      open: vi.fn().mockResolvedValue({
        match: vi.fn(async (url: string) => entries.get(url)?.clone()),
        put: vi.fn(async (url: string, response: Response) => { entries.set(url, response.clone()); }),
      }),
    } as unknown as CacheStorage;
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-length': '3' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const progress = vi.fn();

    await prefetchLitertlmModel(modelDef, progress, new AbortController().signal);

    expect(Engine.create).not.toHaveBeenCalled();
    expect(entries.has(modelDef.litertlmConfig!.modelUrl)).toBe(true);
    expect(progress).toHaveBeenLastCalledWith({ progress: 1, text: '' });
    vi.unstubAllGlobals();
  });

  it('enforces maxOutputTokens and clamps sampled requests to greedy top-1', async () => {
    await runtime.initialize(modelDef, vi.fn(), new AbortController().signal);

    const result = await runtime.generate(
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'post' }],
      37,
      { temperature: 0.7 },
    );

    expect(result).toBe('yes');
    expect(createConversation).toHaveBeenCalledWith({
      preface: { messages: [{ role: 'system', content: 'system' }] },
      sessionConfig: {
        maxOutputTokens: 37,
        samplerParams: {
          type: SamplerType.GREEDY,
          k: 1,
          temperature: 0,
          seed: 0,
        },
      },
    });
  });
});
