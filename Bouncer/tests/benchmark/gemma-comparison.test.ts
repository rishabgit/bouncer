// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, LocalModelDef } from '../../src/types';
import { EVAL_POSTS, EVAL_VARIANTS } from '../../src/shared/eval-corpus';
import { PRIMARY_LOCAL_MODEL } from '../../src/shared/models';
import { BENCHMARK_E4B_MODEL } from '../../src/shared/benchmark-models';

const runtime = vi.hoisted(() => ({
  initialize: vi.fn(),
  unload: vi.fn(),
  generate: vi.fn(),
  interrupt: vi.fn(),
  isCached: vi.fn(),
  prefetch: vi.fn(),
  warm: vi.fn(),
}));

vi.mock('../../src/offscreen/litertlm-runtime', () => ({
  LitertlmRuntime: class {
    static isCached = runtime.isCached;
    initialize = runtime.initialize;
    unload = runtime.unload;
    generate = runtime.generate;
    interrupt = runtime.interrupt;
    countTokens(text: string): Promise<number> { return Promise.resolve(Math.ceil(text.length / 3)); }
    truncateText(text: string, tokens: number): Promise<string> { return Promise.resolve(text.slice(0, tokens * 3)); }
  },
  prefetchLitertlmModel: runtime.prefetch,
  warmLitertlmWasm: runtime.warm,
}));

interface Report {
  runtimeVersion: string;
  startedAt: string;
  finishedAt: string;
  config: { scope: string; modelOrder: string[]; selectedModels: Array<{ modelRevision: string }> };
  models: Array<{
    modelId: string;
    modelUrl: string;
    modelRevision: string;
    latency: Array<{ samples: unknown[] }>;
    accuracy: Array<{ variantId: string; rows: Array<{ runs: unknown[] }> }>;
    suggestions: Array<{ fallbackRuns: unknown[]; passesAutomatedChecks: boolean }>;
    smoke: {
      classifications: Array<{ stage: string }>;
      interrupts: Array<{ requestPendingAtInterrupt: boolean; activeDecodeTargeted: string }>;
    };
  }>;
}

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function loadPage(query: string): Promise<HTMLButtonElement> {
  location.href = `http://localhost:8123/gemma-comparison.html${query}`;
  await import('../../src/benchmark/gemma-comparison');
  return element<HTMLButtonElement>('run');
}

async function finishRun(button: HTMLButtonElement): Promise<Report> {
  button.click();
  await vi.waitFor(() => expect(element('status').dataset.kind).toBe('ok'));
  expect(element('summary').dataset.complete).toBe('true');
  expect(element<HTMLButtonElement>('download-report').disabled).toBe(false);
  const report = JSON.parse(element('summary').textContent ?? '') as Report;
  // Undefined metrics are NaN in memory and serialize as null in JSON.
  expect(JSON.stringify(globalThis.__BOUNCER_GEMMA_REPORT__)).toBe(JSON.stringify(report));
  return report;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<button id="run"></button><button id="download-report" disabled></button><div id="status"></div><progress id="progress" max="1"></progress><pre id="summary"></pre>';
  vi.stubGlobal('__LITERTLM_VERSION__', '0.12.1');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: vi.fn().mockResolvedValue(null) } });
  runtime.initialize.mockReset().mockResolvedValue(undefined);
  runtime.unload.mockReset().mockResolvedValue(undefined);
  runtime.interrupt.mockReset().mockResolvedValue(undefined);
  runtime.isCached.mockReset().mockResolvedValue(false);
  runtime.prefetch.mockReset().mockResolvedValue(undefined);
  runtime.warm.mockReset().mockResolvedValue(undefined);
  runtime.generate.mockReset().mockImplementation((messages: ChatMessage[]) => {
    if (messages[0].content.includes('suggest exactly 9')) {
      return Promise.resolve('rage bait\ncrypto hype\ncelebrity drama\nai hype\nhumble brag\npile on\nspam\nclickbait\noutrage');
    }
    const count = Number(messages[1].content.match(/exactly (\d+) verdict/)?.[1] ?? 1);
    return Promise.resolve(Array.from({ length: count }, () => 'yes').join('\n'));
  });
  globalThis.__BOUNCER_GEMMA_REPORT__ = undefined;
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Gemma development verification', () => {
  it('selects E2B before cache preparation and preserves the full fixed workload', async () => {
    const button = await loadPage('?model=e2b');
    const report = await finishRun(button);

    expect(runtime.isCached).toHaveBeenCalledExactlyOnceWith(PRIMARY_LOCAL_MODEL);
    expect(runtime.prefetch).toHaveBeenCalledExactlyOnceWith(PRIMARY_LOCAL_MODEL, expect.any(Function), expect.any(AbortSignal));
    expect(runtime.initialize.mock.calls.map(([model]: [LocalModelDef]) => model.name)).toEqual([PRIMARY_LOCAL_MODEL.name]);
    expect(report.runtimeVersion).toBe('0.12.1');
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
    expect(report.config.modelOrder).toEqual([PRIMARY_LOCAL_MODEL.name]);
    expect(report.config.selectedModels[0].modelRevision).toBe('9262660a1676eed6d0c477ab1a86344430854664');
    const model = report.models[0];
    expect(model.modelUrl).toBe(PRIMARY_LOCAL_MODEL.litertlmConfig.modelUrl);
    expect(model.latency).toHaveLength(6);
    expect(model.latency.every(cell => cell.samples.length === 20)).toBe(true);
    expect(model.accuracy.map(variant => variant.variantId)).toEqual(EVAL_VARIANTS.map(variant => variant.id));
    expect(model.accuracy.every(variant => variant.rows.length === EVAL_POSTS.length && variant.rows.every(row => row.runs.length === 3))).toBe(true);
    expect(model.suggestions).toHaveLength(5);
    // One first call, six cells of three warmups + twenty timed calls, four
    // forty-row variants repeated three times, and two calls per suggestion.
    expect(runtime.generate).toHaveBeenCalledTimes(1 + 6 * 23 + 4 * 40 * 3 + 5 * 2);
  });

  it.each([
    ['?scope=suggestions', [BENCHMARK_E4B_MODEL.name, PRIMARY_LOCAL_MODEL.name]],
    ['?scope=suggestions&order=e2b-first', [PRIMARY_LOCAL_MODEL.name, BENCHMARK_E4B_MODEL.name]],
  ])('retains the default two-model comparison and requested order for %s', async (query, order) => {
    const report = await finishRun(await loadPage(query));
    expect(report.config.modelOrder).toEqual(order);
    expect(runtime.prefetch).toHaveBeenCalledTimes(2);
    expect(report.models.map(model => model.modelId)).toEqual(order);
    expect(report.models.every(model => model.latency.length === 0 && model.accuracy.length === 0 && model.suggestions.length === 5)).toBe(true);
  });

  it('keeps strict suggestion fallback and accounts for a whole fixture as one progress unit', async () => {
    const original = runtime.generate.getMockImplementation();
    runtime.generate.mockImplementation((messages: ChatMessage[]) => {
      if (messages[1].content.includes('exactly 9 verdict')) return Promise.resolve('yes');
      return original?.(messages);
    });
    const report = await finishRun(await loadPage('?model=e2b&scope=suggestions'));
    expect(report.models[0].suggestions.every(result => result.fallbackRuns.length === 3 && result.passesAutomatedChecks)).toBe(true);
    expect(runtime.generate).toHaveBeenCalledTimes(25);
    expect(element<HTMLProgressElement>('progress').value).toBe(1);
  });

  it('clears a prior export immediately and only completes after unloading', async () => {
    let finishUnload: () => void = () => undefined;
    runtime.unload.mockImplementationOnce(() => new Promise<void>(resolve => { finishUnload = resolve; }));
    const button = await loadPage('?model=e2b&scope=suggestions');
    globalThis.__BOUNCER_GEMMA_REPORT__ = { stale: true };
    element('summary').dataset.complete = 'true';
    button.click();
    expect(globalThis.__BOUNCER_GEMMA_REPORT__).toBeUndefined();
    expect(element('summary').dataset.complete).toBe('false');
    expect(element<HTMLButtonElement>('download-report').disabled).toBe(true);
    await vi.waitFor(() => expect(runtime.unload).toHaveBeenCalledTimes(1));
    expect(globalThis.__BOUNCER_GEMMA_REPORT__).toBeUndefined();
    expect(element('summary').dataset.complete).toBe('false');
    finishUnload();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(globalThis.__BOUNCER_GEMMA_REPORT__).toBeDefined();

    runtime.initialize.mockRejectedValueOnce(new Error('synthetic load failure'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    button.click();
    expect(globalThis.__BOUNCER_GEMMA_REPORT__).toBeUndefined();
    await vi.waitFor(() => expect(element('status').dataset.kind).toBe('error'));
    expect(element('summary').dataset.complete).toBe('false');
    expect(element<HTMLButtonElement>('download-report').disabled).toBe(true);
    expect(globalThis.__BOUNCER_GEMMA_REPORT__).toBeUndefined();
    consoleError.mockRestore();
  });

  it('uses only E2B for smoke and records unverified interruption targeting plus reload recovery', async () => {
    const report = await finishRun(await loadPage('?scope=smoke'));
    expect(runtime.prefetch).toHaveBeenCalledTimes(1);
    expect(runtime.initialize.mock.calls.map(([model]: [LocalModelDef]) => model.name)).toEqual([PRIMARY_LOCAL_MODEL.name, PRIMARY_LOCAL_MODEL.name]);
    expect(runtime.unload).toHaveBeenCalledTimes(2);
    expect(runtime.interrupt).toHaveBeenCalledTimes(2);
    expect(report.config.scope).toBe('smoke');
    const smoke = report.models[0].smoke;
    expect(smoke.classifications.map(row => row.stage)).toEqual([
      'independent-first', 'independent-second', 'single-filter', 'multiple-filters', 'prompt-mode-change',
      'after-suggestion', 'after-setup-interrupt', 'after-pending-interrupt', 'after-reload',
    ]);
    expect(smoke.interrupts.every(probe => probe.activeDecodeTargeted.startsWith('unverified'))).toBe(true);
    expect(smoke.interrupts[1].requestPendingAtInterrupt).toBe(false);
  });

  it('downloads the fresh completed report and revokes its temporary blob URL', async () => {
    const report = await finishRun(await loadPage('?model=e2b&scope=suggestions'));
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-report');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.useFakeTimers();
    element<HTMLButtonElement>('download-report').click();
    expect(createUrl).toHaveBeenCalledTimes(1);
    const blob = createUrl.mock.calls[0][0] as Blob;
    expect(JSON.parse(await blob.text())).toEqual(report);
    const link = click.mock.instances[0];
    expect(link.download).toMatch(/^bouncer-gemma-suggestions-0\.12\.1-.*\.json$/);
    expect(link.href).toBe('blob:synthetic-report');
    vi.advanceTimersByTime(1000);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:synthetic-report');
  });

  it('rejects an unknown model query before any model is downloaded', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const button = await loadPage('?model=unknown');
    button.click();
    await vi.waitFor(() => expect(element('status').dataset.kind).toBe('error'));
    expect(runtime.isCached).not.toHaveBeenCalled();
    expect(runtime.prefetch).not.toHaveBeenCalled();
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(globalThis.__BOUNCER_GEMMA_REPORT__).toBeUndefined();
    consoleError.mockRestore();
  });
});
