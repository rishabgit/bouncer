import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@litert-lm/core', () => ({
  Engine: { create: vi.fn() },
  loadLiteRtLm: vi.fn().mockResolvedValue(undefined),
  unloadLiteRtLm: vi.fn().mockResolvedValue(undefined),
  Backend: { GPU_ARTISAN: 'GPU_ARTISAN' },
  SamplerType: { GREEDY: 'GREEDY', TOP_K: 'TOP_K' },
}));

import { Engine, loadLiteRtLm, SamplerType } from '@litert-lm/core';
import {
  LitertlmRuntime,
  prefetchLitertlmModel,
  unloadLitertlmWasm,
} from '../../src/offscreen/litertlm-runtime.js';
import type { ChatMessage, LocalModelDef } from '../../src/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type FakeConversation = {
  name: string;
  history: string[];
  clone: Mock;
  sendMessage: Mock;
  cancel: Mock;
  delete: Mock;
};

const messages = (post = 'post', system = 'system'): ChatMessage[] => [
  { role: 'system', content: system },
  { role: 'user', content: post },
];

describe('LitertlmRuntime', () => {
  const modelDef: LocalModelDef = {
    name: 'gemma-test',
    display: 'Gemma test',
    isLocal: true,
    backend: 'litertlm',
    litertlmConfig: {
      modelUrl: 'https://example.test/gemma.litertlm',
      maxTokens: 1024,
    },
  };

  let createConversation: Mock;
  let runtime: LitertlmRuntime;
  let engineDelete: Mock;
  let bases: FakeConversation[];
  let clones: FakeConversation[];
  let resident: Set<FakeConversation>;
  let peakResident: number;
  let events: string[];

  function makeConversation(name: string): FakeConversation {
    const conversation: FakeConversation = {
      name,
      history: [],
      clone: vi.fn(),
      sendMessage: vi.fn(async (text: string) => {
        events.push(`${name}:send:${text}`);
        conversation.history.push(text);
        return { role: 'assistant', content: 'yes' };
      }),
      cancel: vi.fn(() => { events.push(`${name}:cancel`); }),
      delete: vi.fn(async () => { events.push(`${name}:delete`); resident.delete(conversation); }),
    };
    resident.add(conversation);
    peakResident = Math.max(peakResident, resident.size);
    return conversation;
  }

  function makeBase(): FakeConversation {
    const base = makeConversation(`base-${bases.length}`);
    bases.push(base);
    base.clone.mockImplementation(async () => {
      events.push(`${base.name}:clone`);
      const clone = makeConversation(`clone-${clones.length}`);
      clones.push(clone);
      return clone;
    });
    return base;
  }

  async function initialize(): Promise<void> {
    await runtime.initialize(modelDef, vi.fn(), new AbortController().signal);
  }

  beforeEach(() => {
    unloadLitertlmWasm();
    vi.clearAllMocks();
    (loadLiteRtLm as Mock).mockReset().mockResolvedValue(undefined);
    // Runtime tests exercise loader invocation, with JSPI available regardless
    // of the host Node version; keep its real relaxed-SIMD capability probe.
    const wasmWithJspi = Object.create(WebAssembly);
    wasmWithJspi.Suspending = vi.fn();
    vi.stubGlobal('WebAssembly', wasmWithJspi);
    globalThis.chrome = {
      runtime: { getURL: vi.fn(path => `chrome-extension://test/${path}`) },
    } as unknown as typeof chrome;

    bases = [];
    clones = [];
    resident = new Set();
    peakResident = 0;
    events = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createConversation = vi.fn().mockImplementation(async () => makeBase());
    engineDelete = vi.fn().mockImplementation(async () => {
      events.push('engine:delete');
      resident.clear();
    });
    (Engine.create as Mock).mockResolvedValue({ createConversation, delete: engineDelete });

    globalThis.caches = {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))),
        put: vi.fn(),
        delete: vi.fn().mockResolvedValue(true),
      }),
    } as unknown as CacheStorage;

    runtime = new LitertlmRuntime();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads an explicit same-origin wasm script', async () => {
    await initialize();

    expect(loadLiteRtLm).toHaveBeenCalledWith(expect.stringMatching(
      /^chrome-extension:\/\/test\/dist\/litertlm-wasm\/litertlm_wasm(?:_compat)?_internal\.js$/,
    ));
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

  it('enforces maxOutputTokens and uses deterministic greedy top-1', async () => {
    await runtime.initialize(modelDef, vi.fn(), new AbortController().signal);

    const result = await runtime.generate(
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'post' }],
      37,
    );

    expect(result).toBe('yes');
    expect(createConversation).toHaveBeenCalledWith({
      preface: { messages: [{ role: 'system', content: 'system' }] },
      prefillPrefaceOnInit: true,
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

  it('prefills an exact prefix and output ceiling once and clones independently per post', async () => {
    await initialize();

    await runtime.generate(messages('first'), 37);
    await runtime.generate(messages('second'), 37);

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(bases[0].clone).toHaveBeenCalledTimes(2);
    expect(bases[0].sendMessage).not.toHaveBeenCalled();
    expect(clones.map(clone => clone.history)).toEqual([['first'], ['second']]);
    expect(clones[0].clone).not.toHaveBeenCalled();
    expect(clones[1].clone).not.toHaveBeenCalled();
    expect(resident.size).toBe(2);
  });

  it.each(['preface', 'ceiling'])('rebuilds the base on a changed %s', async (change) => {
    await initialize();
    await runtime.generate(messages('first'), 37);

    await runtime.generate(messages('second', change === 'preface' ? 'new system' : 'system'), change === 'ceiling' ? 38 : 37);

    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(clones[0].delete).toHaveBeenCalledOnce();
    expect(bases[0].delete).toHaveBeenCalledOnce();
    expect(events.indexOf('clone-0:delete')).toBeLessThan(events.indexOf('base-0:delete'));
    expect(clones[1].history).toEqual(['second']);
    expect(resident.size).toBe(2);
  });

  it('keys the complete ordered preface instead of only its system text', async () => {
    await initialize();
    const withHistory: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'example' },
      { role: 'assistant', content: 'no' },
      { role: 'user', content: 'post' },
    ];
    await runtime.generate(withHistory, 37);
    await runtime.generate([{ ...withHistory[0] }, { ...withHistory[1] }, { role: 'assistant', content: 'yes' }, { ...withHistory[3] }], 37);

    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(createConversation.mock.calls[0][0].preface.messages).toEqual(withHistory.slice(0, -1));
    expect(clones.map(clone => clone.history)).toEqual([['post'], ['post']]);
  });

  it('preserves uncapped maxTokens semantics while caching the exact ceiling', async () => {
    await initialize();
    await runtime.generate(messages(), 0);
    await runtime.generate(messages(), -1);

    expect(createConversation).toHaveBeenCalledTimes(2);
    for (const [config] of createConversation.mock.calls) {
      expect(config.sessionConfig).not.toHaveProperty('maxOutputTokens');
    }
  });

  it('retains a clone until its successor clone completes, then deletes it before decode', async () => {
    await initialize();
    await runtime.generate(messages('first'), 37);
    const cloneReady = deferred<FakeConversation>();
    bases[0].clone.mockImplementationOnce(() => {
      events.push('successor:scheduled');
      return cloneReady.promise;
    });

    const next = runtime.generate(messages('second'), 37);
    await vi.waitFor(() => expect(bases[0].clone).toHaveBeenCalledTimes(2));
    expect(clones[0].delete).not.toHaveBeenCalled();
    const successor = makeConversation('successor');
    cloneReady.resolve(successor);
    await expect(next).resolves.toBe('yes');

    expect(events.indexOf('successor:scheduled')).toBeLessThan(events.indexOf('clone-0:delete'));
    expect(events.indexOf('clone-0:delete')).toBeLessThan(events.indexOf('successor:send:second'));
    expect(successor.delete).not.toHaveBeenCalled();
    expect(resident.size).toBe(2);
  });

  it('bounds retained sessions over many posts and releases all of them on unload', async () => {
    await initialize();
    for (let i = 0; i < 20; i++) await runtime.generate(messages(`post-${i}`), 37);

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(peakResident).toBe(3);
    expect(resident.size).toBe(2);
    await runtime.unload();
    expect(resident.size).toBe(0);
    expect(clones.every(clone => clone.delete.mock.calls.length === 1)).toBe(true);
    expect(bases[0].delete).toHaveBeenCalledOnce();
    expect(engineDelete).toHaveBeenCalledOnce();
  });

  it('cleans up a failed clone or send and permits the next request to rebuild', async () => {
    await initialize();
    await runtime.generate(messages('first'), 37);
    bases[0].clone.mockRejectedValueOnce(new Error('clone failed'));
    await expect(runtime.generate(messages('second'), 37)).rejects.toThrow('clone failed');
    expect(resident.size).toBe(0);

    createConversation.mockImplementationOnce(async () => {
      const base = makeBase();
      base.clone.mockImplementationOnce(async () => {
        const clone = makeConversation('failed-send');
        clones.push(clone);
        clone.sendMessage.mockRejectedValueOnce(new Error('decode failed'));
        return clone;
      });
      return base;
    });
    await expect(runtime.generate(messages('third'), 37)).rejects.toThrow('decode failed');
    expect(resident.size).toBe(0);
    await expect(runtime.generate(messages('fresh'), 37)).resolves.toBe('yes');
    expect(createConversation).toHaveBeenCalledTimes(3);
  });

  it('cleanup failures preserve the generation error and unload can still reclaim the engine', async () => {
    await initialize();
    createConversation.mockImplementationOnce(async () => {
      const base = makeBase();
      base.delete.mockRejectedValueOnce(new Error('base cleanup failed'));
      base.clone.mockImplementationOnce(async () => {
        const clone = makeConversation('failed-send');
        clone.delete.mockRejectedValueOnce(new Error('clone cleanup failed'));
        clone.sendMessage.mockRejectedValueOnce(new Error('primary decode failure'));
        return clone;
      });
      return base;
    });

    await expect(runtime.generate(messages(), 37)).rejects.toThrow('primary decode failure');
    await expect(runtime.unload()).resolves.toBeUndefined();
    expect(engineDelete).toHaveBeenCalledOnce();
    expect(resident.size).toBe(0);
    await initialize();
    await expect(runtime.generate(messages('after reload'), 37)).resolves.toBe('yes');
  });

  it('continues safely when retirement deletion fails and deletes the engine on unload', async () => {
    await initialize();
    await runtime.generate(messages('first'), 37);
    clones[0].delete.mockRejectedValueOnce(new Error('retirement failed'));

    await expect(runtime.generate(messages('second'), 37)).resolves.toBe('yes');
    await runtime.unload();
    expect(engineDelete).toHaveBeenCalledOnce();
    expect(resident.size).toBe(0);
  });

  it('invalidates a same-turn queued generation synchronously before any prefill', async () => {
    await initialize();
    const generation = runtime.generate(messages(), 37);
    const rejected = expect(generation).rejects.toThrow('Generation interrupted');
    const interruption = runtime.interrupt();

    await rejected;
    await interruption;
    expect(createConversation).not.toHaveBeenCalled();
    await expect(runtime.generate(messages('fresh'), 37)).resolves.toBe('yes');
  });

  it('invalidates all queued requests and suppresses a cancelled decode result', async () => {
    await initialize();
    const response = deferred<{ role: string; content: string }>();
    createConversation.mockImplementationOnce(async () => {
      const base = makeBase();
      base.clone.mockImplementationOnce(async () => {
        const clone = makeConversation('in-flight');
        clones.push(clone);
        clone.sendMessage.mockReturnValueOnce(response.promise);
        return clone;
      });
      return base;
    });
    const first = runtime.generate(messages('first'), 37);
    const firstRejected = expect(first).rejects.toThrow('Generation interrupted');
    await vi.waitFor(() => expect(clones[0]?.sendMessage).toHaveBeenCalledOnce());
    const second = runtime.generate(messages('queued'), 37);
    const secondRejected = expect(second).rejects.toThrow('Generation interrupted');
    const interruption = runtime.interrupt();
    expect(clones[0].cancel).toHaveBeenCalledOnce();
    response.resolve({ role: 'assistant', content: 'stale result' });

    await Promise.all([firstRejected, secondRejected, interruption]);
    expect(bases[0].clone).toHaveBeenCalledOnce();
    expect(resident.size).toBe(0);
    await expect(runtime.generate(messages('fresh'), 37)).resolves.toBe('yes');
  });

  it('does not clone or decode after cancellation during base prefill', async () => {
    await initialize();
    const baseReady = deferred<FakeConversation>();
    createConversation.mockReturnValueOnce(baseReady.promise);
    const generation = runtime.generate(messages(), 37);
    const rejected = expect(generation).rejects.toThrow('Generation interrupted');
    await vi.waitFor(() => expect(createConversation).toHaveBeenCalledOnce());
    const interruption = runtime.interrupt();
    const base = makeBase();
    baseReady.resolve(base);

    await Promise.all([rejected, interruption]);
    expect(base.clone).not.toHaveBeenCalled();
    expect(base.sendMessage).not.toHaveBeenCalled();
    expect(base.delete).toHaveBeenCalledOnce();
    await expect(runtime.generate(messages('fresh'), 37)).resolves.toBe('yes');
  });

  it('does not decode after cancellation during clone setup', async () => {
    await initialize();
    const cloneReady = deferred<FakeConversation>();
    createConversation.mockImplementationOnce(async () => {
      const base = makeBase();
      base.clone.mockReturnValueOnce(cloneReady.promise);
      return base;
    });
    const generation = runtime.generate(messages(), 37);
    const rejected = expect(generation).rejects.toThrow('Generation interrupted');
    await vi.waitFor(() => expect(bases[0]?.clone).toHaveBeenCalledOnce());
    const interruption = runtime.interrupt();
    const clone = makeConversation('late-clone');
    cloneReady.resolve(clone);

    await Promise.all([rejected, interruption]);
    expect(clone.sendMessage).not.toHaveBeenCalled();
    expect(clone.delete).toHaveBeenCalledOnce();
    expect(bases[0].delete).toHaveBeenCalledOnce();
    await expect(runtime.generate(messages('fresh'), 37)).resolves.toBe('yes');
  });

  it('does not decode after cancellation while deleting the retired clone', async () => {
    await initialize();
    await runtime.generate(messages('first'), 37);
    const deleted = deferred<void>();
    clones[0].delete.mockImplementationOnce(async () => {
      await deleted.promise;
      resident.delete(clones[0]);
    });
    const generation = runtime.generate(messages('second'), 37);
    const rejected = expect(generation).rejects.toThrow('Generation interrupted');
    await vi.waitFor(() => expect(clones[0].delete).toHaveBeenCalledOnce());
    const interruption = runtime.interrupt();
    deleted.resolve(undefined);

    await Promise.all([rejected, interruption]);
    expect(clones[1].sendMessage).not.toHaveBeenCalled();
    expect(clones[1].delete).toHaveBeenCalledOnce();
    expect(resident.size).toBe(0);
    await expect(runtime.generate(messages('fresh'), 37)).resolves.toBe('yes');
  });

  it('does not prefill a new prefix after cancellation while deleting the old base', async () => {
    await initialize();
    await runtime.generate(messages('first'), 37);
    const deleted = deferred<void>();
    bases[0].delete.mockImplementationOnce(async () => {
      await deleted.promise;
      resident.delete(bases[0]);
    });
    const generation = runtime.generate(messages('second', 'new prefix'), 37);
    const rejected = expect(generation).rejects.toThrow('Generation interrupted');
    await vi.waitFor(() => expect(bases[0].delete).toHaveBeenCalledOnce());
    const interruption = runtime.interrupt();
    deleted.resolve(undefined);

    await Promise.all([rejected, interruption]);
    expect(createConversation).toHaveBeenCalledOnce();
    expect(resident.size).toBe(0);
  });

  it('allows a new epoch to queue behind interruption cleanup', async () => {
    await initialize();
    const stale = runtime.generate(messages('stale'), 37);
    const rejected = expect(stale).rejects.toThrow('Generation interrupted');
    const interruption = runtime.interrupt();
    const fresh = runtime.generate(messages('fresh'), 37);

    await Promise.all([rejected, interruption]);
    await expect(fresh).resolves.toBe('yes');
    expect(clones[0].history).toEqual(['fresh']);
    expect(createConversation).toHaveBeenCalledOnce();
  });

  it('unload during prefill prevents decode, guards new work, drains and permits reload', async () => {
    await initialize();
    const baseReady = deferred<FakeConversation>();
    createConversation.mockReturnValueOnce(baseReady.promise);
    const generation = runtime.generate(messages(), 37);
    const rejected = expect(generation).rejects.toThrow('Generation interrupted');
    await vi.waitFor(() => expect(createConversation).toHaveBeenCalledOnce());
    const unload = runtime.unload();
    expect(() => runtime.generate(messages('during unload'), 37)).toThrow('Runtime unloading');
    await expect(runtime.initialize(modelDef, vi.fn(), new AbortController().signal)).rejects.toThrow('Runtime unloading');
    expect(engineDelete).not.toHaveBeenCalled();
    const base = makeBase();
    baseReady.resolve(base);

    await Promise.all([rejected, unload]);
    expect(base.clone).not.toHaveBeenCalled();
    expect(base.delete).toHaveBeenCalledOnce();
    expect(engineDelete).toHaveBeenCalledOnce();
    expect(() => runtime.generate(messages(), 37)).toThrow('Engine not loaded');
    await initialize();
    await expect(runtime.generate(messages('after reload'), 37)).resolves.toBe('yes');
  });

  it('drains an in-flight model initialization before unload and discards its engine', async () => {
    const engineReady = deferred<{ createConversation: Mock; delete: Mock }>();
    (Engine.create as Mock).mockReturnValueOnce(engineReady.promise);
    const initialization = runtime.initialize(modelDef, vi.fn(), new AbortController().signal);
    const rejected = expect(initialization).rejects.toThrow('Runtime unloading');
    await vi.waitFor(() => expect(Engine.create).toHaveBeenCalledOnce());
    const unload = runtime.unload();
    let unloaded = false;
    void unload.then(() => { unloaded = true; });
    await Promise.resolve();
    expect(unloaded).toBe(false);
    engineReady.resolve({ createConversation, delete: engineDelete });

    await Promise.all([rejected, unload]);
    expect(engineDelete).toHaveBeenCalledOnce();
    expect(createConversation).not.toHaveBeenCalled();
    expect(() => runtime.generate(messages(), 37)).toThrow('Engine not loaded');
    await initialize();
    await expect(runtime.generate(messages(), 37)).resolves.toBe('yes');
  });

  it('preserves abort errors when deleting an engine created after initialization was aborted', async () => {
    const engineReady = deferred<{ createConversation: Mock; delete: Mock }>();
    const controller = new AbortController();
    (Engine.create as Mock).mockReturnValueOnce(engineReady.promise);
    const initialization = runtime.initialize(modelDef, vi.fn(), controller.signal);
    const rejected = expect(initialization).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(Engine.create).toHaveBeenCalledOnce());
    controller.abort();
    engineDelete.mockRejectedValueOnce(new Error('engine cleanup failed'));
    engineReady.resolve({ createConversation, delete: engineDelete });

    await rejected;
    expect(engineDelete).toHaveBeenCalledOnce();
    expect(() => runtime.generate(messages(), 37)).toThrow('Engine not loaded');
  });

  it('cleans conversations before deleting the engine and recovers despite engine deletion failure', async () => {
    await initialize();
    await runtime.generate(messages(), 37);
    engineDelete.mockImplementationOnce(async () => {
      events.push('engine:delete');
      throw new Error('engine cleanup failed');
    });

    await expect(runtime.unload()).resolves.toBeUndefined();
    expect(events.indexOf('clone-0:delete')).toBeLessThan(events.indexOf('base-0:delete'));
    expect(events.indexOf('base-0:delete')).toBeLessThan(events.indexOf('engine:delete'));
    await initialize();
    await expect(runtime.generate(messages('after reload'), 37)).resolves.toBe('yes');
    expect(createConversation).toHaveBeenCalledTimes(2);
  });

  it('allows a wasm load retry after the first load attempt fails', async () => {
    (loadLiteRtLm as Mock)
      .mockRejectedValueOnce(new Error('wasm load failed'))
      .mockResolvedValueOnce(undefined);

    await expect(runtime.initialize(modelDef, vi.fn(), new AbortController().signal))
      .rejects.toThrow('wasm load failed');
    await expect(runtime.initialize(modelDef, vi.fn(), new AbortController().signal))
      .resolves.toBeUndefined();
    expect(loadLiteRtLm).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'fails cache deletion whenever the model survives (delete returned %s)',
    async (deleteResult) => {
      const survivor = new Response(new Uint8Array([1, 2, 3]));
      globalThis.caches = {
        open: vi.fn().mockResolvedValue({
          delete: vi.fn().mockResolvedValue(deleteResult),
          match: vi.fn().mockResolvedValue(survivor),
        }),
      } as unknown as CacheStorage;

      await expect(LitertlmRuntime.deleteCache(modelDef))
        .rejects.toThrow('cache entry survived deletion');
      const cache = await caches.open('litertlm-cache');
      expect(cache.delete).toHaveBeenCalledWith(modelDef.litertlmConfig!.modelUrl);
      expect(cache.match).toHaveBeenCalledWith(modelDef.litertlmConfig!.modelUrl);
    },
  );
});
