// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkClassifierIdentity, BenchmarkStatusResult } from '../../src/shared/benchmark-types';
import { BROWSER_MODEL, PRIMARY_LOCAL_MODEL, classifierFingerprintForEngine } from '../../src/shared/models';

const browserIdentity: BenchmarkClassifierIdentity = {
  engine: 'litertlm', modelId: BROWSER_MODEL.name, display: BROWSER_MODEL.display,
  selectionRevision: 7, classifierFingerprint: classifierFingerprintForEngine('litertlm'),
  weightDigest: BROWSER_MODEL.weightDigest, manifestDigest: null, runtimeVersion: '0.17.0',
};
const nativeIdentity: BenchmarkClassifierIdentity = {
  engine: 'ollama', modelId: PRIMARY_LOCAL_MODEL.name, display: PRIMARY_LOCAL_MODEL.display,
  selectionRevision: 8, classifierFingerprint: classifierFingerprintForEngine('ollama'),
  weightDigest: PRIMARY_LOCAL_MODEL.weightDigest, manifestDigest: PRIMARY_LOCAL_MODEL.manifestDigest, runtimeVersion: '0.40.3',
};

let selected: BenchmarkStatusResult;
let downloads: Blob[];
let send: ReturnType<typeof vi.fn>;

function need<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function reply(message: Record<string, unknown>) {
  if (message.type !== 'benchmark') throw new Error('The benchmark must use its selected-engine contract.');
  const identity = selected.identity;
  switch (message.op) {
    case 'status': return selected;
    case 'load': return { ...identity, loadMs: 12, loadKind: identity?.engine === 'litertlm' ? 'browser_initialization' : 'native_metadata' };
    case 'infer': return { ...identity, inferenceTime: 0.012, wallMs: 14, shouldHide: false, reasoning: 'Allowed', rawResponse: 'no', completionChars: 2, usage: null };
    case 'unload': return { ok: true };
    default: throw new Error('Unexpected operation');
  }
}

async function init(): Promise<void> {
  await import('../../src/benchmark/index');
  await vi.waitFor(() => expect(need('models').textContent).not.toContain('reading saved choice'));
}

async function run(id = 'run'): Promise<void> {
  need<HTMLButtonElement>(id).click();
  await vi.waitFor(() => expect(need<HTMLButtonElement>('run').disabled).toBe(false));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  selected = { identity: browserIdentity, status: { state: 'ready', message: 'Ready — loads when needed', revision: 3, engine: 'litertlm', selectionRevision: 7 } };
  downloads = [];
  const html = readFileSync(new NodeURL('../../benchmark.html', import.meta.url), 'utf8');
  document.body.innerHTML = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/g, '');
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  need<HTMLInputElement>('warmup').value = '0';
  need<HTMLInputElement>('timed').value = '1';
  send = vi.fn((message: Record<string, unknown>) => Promise.resolve(reply(message)));
  chrome.runtime.sendMessage = send;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob): string { downloads.push(blob); return 'blob:synthetic-benchmark'; }
    static revokeObjectURL(): void { /* no real object URL exists */ }
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('selected-engine benchmark page', () => {
  it('shows the committed Browser choice without model or engine controls or setup requests', async () => {
    await init();
    expect(need('models').textContent).toContain('Browser (LiteRT-LM)');
    expect(need('models').textContent).toContain(BROWSER_MODEL.name);
    expect(need('models').querySelector('input, select, button')).toBeNull();
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'benchmark', op: 'status' });
  });

  it('directs a fresh profile to popup choice without any generation or load', async () => {
    selected = { identity: null, status: { state: 'not_configured', message: 'Choose where Bouncer should run.', revision: 1 } };
    await init();
    await run();
    expect(need('status').textContent).toContain('Bouncer popup');
    expect(send.mock.calls.every(([message]) => message.op === 'status')).toBe(true);
    expect(need<HTMLButtonElement>('exportJson').disabled).toBe(true);
  });

  it('directs missing Browser bytes to explicit popup setup without downloading', async () => {
    selected.status = { ...selected.status, state: 'needs_download', message: 'Download the browser model to start filtering.' };
    await init();
    await run();
    expect(need('status').textContent).toContain('Download the browser model');
    expect(send.mock.calls.every(([message]) => message.op === 'status')).toBe(true);
  });

  it('exports the actual Browser artifact identity and preparation meaning', async () => {
    await init();
    await run();
    expect(need('status').textContent).toBe('Done.');
    expect(need('env').textContent).toContain('Browser (LiteRT-LM)');
    expect(need('results').textContent).toContain('cached Browser initialization 12 ms');
    const operationCalls = send.mock.calls.map(([message]) => message).filter(message => message.op !== 'status');
    expect(operationCalls.filter(message => message.op === 'infer')).toHaveLength(7);
    expect(operationCalls.every(message => message.selectionRevision === 7 && !('modelId' in message) && !('engine' in message))).toBe(true);
    expect(operationCalls.at(-1)).toEqual({ type: 'benchmark', op: 'unload', selectionRevision: 7 });

    need<HTMLButtonElement>('exportJson').click();
    const report = JSON.parse(await downloads[0].text());
    expect(report.env.classifier).toEqual(browserIdentity);
    expect(report.models[0]).toMatchObject({ ...browserIdentity, loadKind: 'browser_initialization' });
    need<HTMLButtonElement>('exportCsv').click();
    const csv = await downloads[1].text();
    expect(csv).toContain('model_id,engine,selection_revision,classifier_fingerprint');
    expect(csv).toContain(`${BROWSER_MODEL.name},litertlm,7`);
    expect(csv).toContain('browser_initialization,12,');
  });

  it('labels Ollama metadata correctly when it is the selected engine', async () => {
    selected = { identity: nativeIdentity, status: { ...selected.status, engine: 'ollama', selectionRevision: 8 } };
    await init();
    await run();
    expect(need('models').textContent).toContain('Ollama on this Mac');
    expect(need('results').textContent).toContain('native metadata readiness 12 ms');
    expect(need('env').textContent).toContain(PRIMARY_LOCAL_MODEL.name);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ op: 'infer', selectionRevision: 8 }));
  });

  it('rejects a changed selection during preparation before first inference', async () => {
    send.mockImplementation((message: Record<string, unknown>) => Promise.resolve(message.op === 'load'
      ? { ...nativeIdentity, loadMs: 1, loadKind: 'native_metadata' } : reply(message)));
    await init();
    await run();
    expect(need('status').textContent).toContain('selected engine changed');
    expect(send.mock.calls.some(([message]) => message.op === 'infer')).toBe(false);
    expect(need<HTMLButtonElement>('exportJson').disabled).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ type: 'benchmark', op: 'unload', selectionRevision: 7 });
  });

  it('honors Stop while preparation is pending before starting real inference', async () => {
    let finishLoad!: (value: unknown) => void;
    const loading = new Promise(resolve => { finishLoad = resolve; });
    send.mockImplementation((message: Record<string, unknown>) => message.op === 'load' ? loading : Promise.resolve(reply(message)));
    await init();
    need<HTMLButtonElement>('run').click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ op: 'load' })));
    need<HTMLButtonElement>('stop').click();
    finishLoad({ ...browserIdentity, loadMs: 12, loadKind: 'browser_initialization' });
    await vi.waitFor(() => expect(need<HTMLButtonElement>('run').disabled).toBe(false));
    expect(need('status').textContent).toBe('Stopped.');
    expect(send.mock.calls.some(([message]) => message.op === 'infer')).toBe(false);
  });

  it('does not combine inference samples from different selections into one report', async () => {
    let inferences = 0;
    send.mockImplementation((message: Record<string, unknown>) => {
      const response = reply(message);
      if (message.op === 'infer' && ++inferences === 2) return Promise.resolve({ ...response, ...nativeIdentity });
      return Promise.resolve(response);
    });
    await init();
    await run();
    expect(inferences).toBe(2);
    expect(need('status').textContent).toContain('selected engine changed');
    expect(need('results').children).toHaveLength(0);
    expect(need<HTMLButtonElement>('exportJson').disabled).toBe(true);
  });

  it('keeps accuracy evaluation and its exported results tied to the selected classifier', async () => {
    await init();
    await run('runEval');
    expect(need('status').textContent).toBe('Eval done.');
    expect(need('evalResults').textContent).toContain('Browser (LiteRT-LM)');
    const inferenceCalls = send.mock.calls.map(([message]) => message).filter(message => message.op === 'infer');
    expect(inferenceCalls.length).toBeGreaterThan(0);
    expect(inferenceCalls.every(message => message.selectionRevision === 7 && !('modelId' in message))).toBe(true);
    need<HTMLButtonElement>('exportEvalJson').click();
    const report = JSON.parse(await downloads[0].text());
    expect(report.models[0]).toMatchObject(browserIdentity);
    expect(report.env.classifier).toEqual(browserIdentity);
  });
});
