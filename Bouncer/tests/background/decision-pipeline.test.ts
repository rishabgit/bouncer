import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineResponse } from '../../src/types';
import { DECISION_MODEL } from '../../src/shared/decision-model';
import { generateCacheKey } from '../../src/shared/utils';

let pipeline: typeof import('../../src/background/pipeline');
let localEngine: typeof import('../../src/background/local-model')['localEngine'];
let storage: Record<string, unknown>;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  storage = { enabled: true, descriptions_twitter: ['birds'] };
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => structuredClone(storage));
  vi.mocked(chrome.storage.local.set).mockImplementation(async value => { Object.assign(storage, structuredClone(value)); });
  vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ positions: {} });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  pipeline = await import('../../src/background/pipeline');
  ({ localEngine } = await import('../../src/background/local-model'));
  pipeline.initPipeline(new Set([11]));
});
afterEach(async () => {
  pipeline.setActiveTab(null);
  pipeline.clearTabQueue(11);
  pipeline.clearTabQueue(12);
  localEngine.teardown();
  await pipeline.clearEvaluationCache();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function queue(post: string, tabId = 11): Promise<PipelineResponse> {
  return new Promise(resolve => {
    pipeline.enqueuePost(tabId, { post, cacheKey: generateCacheKey(post), tabId, postUrl: null,
      evaluationId: post, siteId: 'twitter', resolve });
  });
}

describe('real decision client through the serial post pipeline (mocked fetch only)', () => {
  it('uses each saved phrase level for real classification and reuses the same scores when levels change', async () => {
    storage.descriptions_twitter = ['birds', 'sports'];
    storage.strictFilters_twitter = ['sports'];
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/v1/models')
      ? { data: [{ id: DECISION_MODEL.id, status: { value: 'unloaded', args: [
        '--model', `/cache/${DECISION_MODEL.fileName}`, '--ctx-size', '4096', '--parallel', '1',
        '--batch-size', '4096', '--ubatch-size', '4096', '--no-mmproj-auto',
      ] } }] }
      : { answers: { f0: { type: 'noul', noul: 0.5 }, f1: { type: 'noul', noul: 0.5 } } })));
    vi.stubGlobal('fetch', fetchMock);
    const post = 'A full post about birds and sports';
    const result = queue(post);
    pipeline.setActiveTab(11);
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toMatchObject({ shouldHide: true, matches: ['birds'], scores: [
      { label: 'birds', score: 0.5 }, { label: 'sports', score: 0.5 },
    ] });
    storage.strictFilters_twitter = ['birds', 'sports'];
    await expect(pipeline.readCachedEvaluation(generateCacheKey(post))).resolves.toMatchObject({ shouldHide: false, matches: [] });
    storage.strictFilters_twitter = [];
    await expect(pipeline.readCachedEvaluation(generateCacheKey(post))).resolves.toMatchObject({ shouldHide: true, matches: ['birds', 'sports'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('persists ordered scores and exact truncated request text across worker restart and cache hits', async () => {
    storage.descriptions_twitter = ['birds', 'excessive rudeness', 'spam, scams'];
    const sentBodies: Array<{ state: string }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: DECISION_MODEL.id,
        status: { value: 'unloaded', args: ['--model', `/cache/${DECISION_MODEL.fileName}`, '--ctx-size', '4096', '--parallel', '1', '--batch-size', '4096', '--ubatch-size', '4096', '--no-mmproj-auto'] },
      }] }));
      sentBodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ answers: {
        f2: { type: 'noul', noul: 0.34 }, f0: { type: 'noul', noul: 0.09 }, f1: { type: 'noul', noul: 0.8 },
      } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const post = 'Criticism of rudeness.\n' + 'more text '.repeat(600);
    const first = queue(post);
    pipeline.setActiveTab(11);
    await vi.advanceTimersByTimeAsync(0);
    const result = await first;
    expect(result).toMatchObject({ matches: ['excessive rudeness', 'spam, scams'], model: DECISION_MODEL.id,
      timestamp: expect.any(Number), textSent: sentBodies[0].state, scores: [
        { label: 'birds', score: 0.09 }, { label: 'excessive rudeness', score: 0.8 }, { label: 'spam, scams', score: 0.34 },
      ],
    });
    expect(sentBodies[0].state.length).toBeLessThan(post.length);
    await vi.advanceTimersByTimeAsync(3000);
    const key = generateCacheKey(post);
    expect((storage.evaluationCache as Record<string, unknown>)[key]).toEqual(result);

    pipeline.setActiveTab(null);
    localEngine.teardown();
    vi.resetModules();
    pipeline = await import('../../src/background/pipeline');
    ({ localEngine } = await import('../../src/background/local-model'));
    pipeline.initPipeline(new Set([11]));
    await pipeline.loadCache();
    const cached = queue(post);
    pipeline.setActiveTab(11);
    await vi.advanceTimersByTimeAsync(0);
    expect(await cached).toEqual({ ...result, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('finishes a finite request through a tab switch and starts the new tab without a delay', async () => {
    let finishFirst!: (response: Response) => void;
    let classifications = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/v1/models')) return Promise.resolve(new Response(JSON.stringify({ data: [{ id: DECISION_MODEL.id,
        status: { value: 'unloaded', args: ['--model', `/cache/${DECISION_MODEL.fileName}`, '--ctx-size', '4096', '--parallel', '1', '--batch-size', '4096', '--ubatch-size', '4096', '--no-mmproj-auto'] },
      }] })));
      classifications++;
      if (classifications === 1) return new Promise<Response>(resolve => { finishFirst = resolve; });
      return Promise.resolve(new Response(JSON.stringify({ answers: { f0: { type: 'noul', noul: 0.1 } } })));
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = queue('current tab post about birds');
    pipeline.setActiveTab(11);
    await vi.advanceTimersByTimeAsync(0);
    expect(classifications).toBe(1);
    const epoch = localEngine.operationEpoch;
    const second = queue('new active tab post', 12);
    pipeline.setActiveTab(12);
    expect(localEngine.operationEpoch).toBe(epoch);
    expect(classifications).toBe(1);
    finishFirst(new Response(JSON.stringify({ answers: { f0: { type: 'noul', noul: 0.9 } } })));
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toMatchObject({ shouldHide: true, matches: ['birds'] });
    await expect(second).resolves.toMatchObject({ shouldHide: false, matches: [] });
    expect(classifications).toBe(2);
    expect(localEngine.operationEpoch).toBe(epoch);
  });

  it.each(['HTTP 500', 'timeout', 'connection refused'])('fails open for %s and classifies the next post', async failure => {
    let posts = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/v1/models')) return Promise.resolve(new Response(JSON.stringify({ data: [{ id: DECISION_MODEL.id,
        status: { value: 'unloaded', args: ['--model', `/cache/${DECISION_MODEL.fileName}`, '--ctx-size', '4096', '--parallel', '1', '--batch-size', '4096', '--ubatch-size', '4096', '--no-mmproj-auto'] },
      }] })));
      if (++posts === 1) {
        if (failure === 'HTTP 500') return Promise.resolve(new Response('failed', { status: 500 }));
        if (failure === 'connection refused') return Promise.reject(new TypeError('ECONNREFUSED'));
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(new Response(JSON.stringify({ answers: { f0: { type: 'noul', noul: 0.9 } } })));
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = queue('first post remains visible');
    const second = queue('second post about birds');
    pipeline.setActiveTab(11);
    pipeline.scheduleBatch();
    await vi.advanceTimersByTimeAsync(failure === 'timeout' ? 25_000 : 0);
    const failed = await first;
    expect(failed).toMatchObject({ error: 'local_model', reasoning: expect.any(String) });
    expect(failed).not.toHaveProperty('shouldHide', true);
    expect(await second).toMatchObject({ shouldHide: true, matches: ['birds'] });
    expect(posts).toBe(2);
    expect(storage.enabled).toBe(true);
    expect(await pipeline.readCachedEvaluation(generateCacheKey('first post remains visible'))).toBeUndefined();
    expect(fetchMock.mock.calls.every(([url]) => url === 'http://127.0.0.1:9931/v1/models'
      || url === 'http://127.0.0.1:9931/v1/systemone')).toBe(true);
  });
});
