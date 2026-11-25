import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECISION_MODEL, decisionModelFingerprint, decisionQuestions, LLAMA_MODEL_INI, MAX_ACTIVE_FILTERS, MAX_FILTERS_WARNING } from '../../src/shared/decision-model';
import { LocalEngine, buildDecisionRequest, parseDecisionAnswers, readinessFromModels, REQUEST_TIMEOUT_MS } from '../../src/background/local-model';
import { weightedTextLength } from '../../src/shared/utils';

const RAGE = 'For categories like "rage bait" or "outrage farming", answer yes only when the post is engineered to provoke anger or amplify a pile-on: repost/share/quote/tag requests, ratio calls, "make this loud" framing, "wake up" outrage escalation, or language that pushes readers to attack or shame a target. Answer no for sincere frustration, fair criticism, personal hardship, civic participation, ordinary sarcasm, or calm pessimism unless the post is also trying to farm outrage.';
// Recorded unbound preset: its correct numerical options alone cannot prove a file is installed.
const UNBOUND_PRESET_ARGS = ['--ctx-size', '4096', '--parallel', '1', '--batch-size', '4096', '--ubatch-size', '4096', '--no-mmproj-auto'];
const FILE = '/test-data/huggingface/hub/models--LiquidAI--d1-2B-GGUF/snapshots/revision/d1-2B-Q8_0.gguf';
const ARGS = ['--model', FILE, ...UNBOUND_PRESET_ARGS];
const inventory = (args = ARGS, status = {}) => ({ data: [{ id: DECISION_MODEL.id, tags: ['decision'], status: { value: 'unloaded', args, ...status } }] });
const answers = (...values: number[]) => ({ answers: Object.fromEntries(values.map((noul, index) => [`f${index}`, { type: 'noul', noul }])) });
const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
let storage: Record<string, unknown>;
let engine: LocalEngine;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  storage = {};
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => structuredClone(storage));
  vi.mocked(chrome.storage.local.set).mockImplementation(async value => { Object.assign(storage, structuredClone(value)); });
  fetchMock = vi.fn(async (url: string) => ok(url.endsWith('/v1/models') ? inventory() : answers(0.5)));
  vi.stubGlobal('fetch', fetchMock);
  engine = new LocalEngine();
});
afterEach(() => { engine.teardown(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('fixed decision request', () => {
  it('pins exact serialized question order and asymmetric answer mapping with bare state', async () => {
    fetchMock.mockImplementation(async (url: string) => ok(url.endsWith('/v1/models') ? inventory() : { answers: {
      f2: { type: 'noul', noul: 0.63 }, f0: { type: 'noul', noul: 0.91 }, f1: { type: 'noul', noul: 0.12 },
    } }));
    const result = await engine.classify({ text: 'A post about birds.' }, ['bird watching', 'Rage Bait', 'say "yes" $&']);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:9931/v1/models', 'http://127.0.0.1:9931/v1/systemone']);
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' } });
    expect(init.body).toBe(JSON.stringify({
      model: 'LiquidAI/d1-2B-GGUF:Q8_0', state: 'A post about birds.', questions: {
        f0: { type: 'noul', instructions: 'Does this social media post match the category "bird watching"? Answer yes if it matches, otherwise no.' },
        f1: { type: 'noul', instructions: 'Does this social media post match the category "Rage Bait"? Answer yes if it matches, otherwise no.\n\n' + RAGE },
        f2: { type: 'noul', instructions: 'Does this social media post match the category "say \\"yes\\" $&"? Answer yes if it matches, otherwise no.' },
      },
    }));
    expect(result).toMatchObject({ textSent: 'A post about birds.', scores: [
        { label: 'bird watching', score: 0.91 }, { label: 'Rage Bait', score: 0.12 }, { label: 'say "yes" $&', score: 0.63 },
      ],
    });
    for (const verdict of ['shouldHide', 'matches', 'category', 'reasoning']) expect(result).not.toHaveProperty(verdict);
  });
  it('maps answers using the request filter snapshot after caller mutation', async () => {
    const filters = ['birds'];
    const pending = engine.classify({ text: 'A post about birds' }, filters);
    filters[0] = 'changed while waiting';
    await expect(pending).resolves.toMatchObject({ scores: [{ label: 'birds', score: 0.5 }] });
  });
  it.each(['ragebait', 'rage-bait', 'Rage Bait', 'outrage farming'])('includes the curated definition for %s', label => {
    expect(decisionQuestions([label]).f0.instructions).toBe(`Does this social media post match the category ${JSON.stringify(label)}? Answer yes if it matches, otherwise no.\n\n${RAGE}`);
  });
  it('separates rage guidance with two newline bytes', () => {
    expect([...DECISION_MODEL.rageSeparator].map(character => character.charCodeAt(0))).toEqual([10, 10]);
    expect(decisionQuestions(['rage bait']).f0.instructions).not.toContain('\\n');
  });
  it('accepts ten ordered questions and rejects the eleventh before fetching', async () => {
    const labels = Array.from({ length: MAX_ACTIVE_FILTERS }, (_, index) => `topic ${index}`);
    expect(Object.keys(buildDecisionRequest({ text: 'Post' }, labels).questions)).toEqual(labels.map((_, index) => `f${index}`));
    await expect(engine.classify({ text: 'Post' }, [...labels, 'extra'])).rejects.toThrow(MAX_FILTERS_WARNING);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['a', '漢', '😀'])('caps %s text by weight with a context margin for ten filters', character => {
    const filters = ['rage bait', ...Array.from({ length: 9 }, (_, index) => `topic ${index}`)];
    const body = buildDecisionRequest({ text: character.repeat(6000) }, filters);
    expect(weightedTextLength(body.state)).toBeLessThanOrEqual(DECISION_MODEL.postWeightCap);
    const bytes = [body.state, ...Object.values(body.questions).map(question => question.instructions)]
      .reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0);
    expect(bytes).toBeLessThanOrEqual(3072);
    expect(DECISION_MODEL.settings['ctx-size'] - bytes).toBeGreaterThanOrEqual(1024);
    expect(body.state).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it('reduces state further for lengthy questions and rejects oversized question text locally', async () => {
    const filters = Array.from({ length: 10 }, (_, index) => `${index}${'漢'.repeat(40)}`);
    const body = buildDecisionRequest({ text: 'a'.repeat(6000) }, filters);
    expect(body.state.length).toBeLessThan(DECISION_MODEL.postWeightCap);
    await expect(engine.classify({ text: 'Visible' }, Array.from({ length: 10 }, (_, index) => `rage bait ${index}`))).rejects.toThrow('input budget');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('retains ordered raw probabilities on either side of the Standard cutoff', async () => {
    fetchMock.mockImplementation(async (url: string) => ok(url.endsWith('/v1/models') ? inventory()
      : answers(0.290813258948728, 0.2908132589487279, 0.2908132589487281)));
    await expect(engine.classify({ text: 'A post about birds' }, ['at', 'below', 'above'])).resolves.toMatchObject({
      scores: [
        { label: 'at', score: 0.290813258948728 },
        { label: 'below', score: 0.2908132589487279 },
        { label: 'above', score: 0.2908132589487281 },
      ],
    });
  });
  it.each([
    ['@alice these are words https://example.test', 0.69],
    ['@alice these are words https://example.test', 0.7],
    ['these are four words', 0.2908],
    ['these are four words', 0.290813258948728],
  ])('retains raw scores and exact state for %j at %s', async (text, score) => {
    fetchMock.mockImplementation(async (url: string) => ok(url.endsWith('/v1/models') ? inventory() : answers(score, score)));
    const labels = ['rage bait', 'bird watching'];
    await expect(engine.classify({ text }, labels)).resolves.toMatchObject({
      scores: labels.map(label => ({ label, score })), textSent: text,
    });
  });
  it('retains truncated request state so publication can choose its own-word cutoff', async () => {
    const text = `${'a'.repeat(1196)} b c fourth`;
    fetchMock.mockImplementation(async (url: string) => ok(url.endsWith('/v1/models') ? inventory() : answers(0.69)));
    const result = await engine.classify({ text }, ['birds']);
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.state).toBe(`${'a'.repeat(1196)} b c`);
    expect(result).toMatchObject({ scores: [{ label: 'birds', score: 0.69 }], textSent: body.state });
  });
  it.each([{}, { answers: { f0: { type: 'noul', noul: '0.9' } } }, answers(-1), answers(1.1),
    { answers: { f0: { type: 'choice', noul: 1 } } }, answers(NaN), { answers: { f1: { type: 'noul', noul: 1 } } },
    { ...answers(1), error: 'failed' }, answers(0, 1)])('rejects invalid probabilities without a partial hide (%j)', value => {
    expect(() => parseDecisionAnswers(value, ['birds'])).toThrow();
  });
  it.each([{ truncated: true }, { usage: { truncated: true } }])('rejects a truncated response even with complete positive answers (%j)', flags => {
    expect(() => parseDecisionAnswers({ ...answers(0.9), ...flags }, ['birds'])).toThrow('truncated');
  });
  it('binds model, question rules, state format, cutoff and budgets into cache identity', () => {
    const original = decisionModelFingerprint();
    expect(engine.getClassifierFingerprint()).toBe(original);
    for (const change of [{ id: 'new-model' }, { templateId: 'new-template' }, { template: 'new words' }, { cutoff: 0.3 },
      { shortRule: { ...DECISION_MODEL.shortRule, maxOwnWords: 2 } },
      { shortRule: { ...DECISION_MODEL.shortRule, cutoff: 0.8 } },
      { shortRule: { ...DECISION_MODEL.shortRule, ownWords: 'new-counter-version' } },
      { postWeightCap: 100 }, { requestTextByteCap: 1024 }, { rageSeparator: '\\n\\n' }, { ragePattern: 'rage bait' }, { stateFormat: 'author-prefixed' }]) {
      expect(decisionModelFingerprint({ ...DECISION_MODEL, ...change })).not.toBe(original);
    }
  });
});

describe('readiness without loading', () => {
  it('checks only the bound inventory even when weights are unloaded', async () => {
    expect(await engine.checkReadiness()).toMatchObject({ state: 'ready', message: 'Ready — loads when needed' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:9931/v1/models', expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error' }));
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it('does not fetch for snapshots or empty input', async () => {
    await engine.getStatus();
    await expect(engine.classify({ text: '' }, ['birds'])).rejects.toThrow();
    await expect(engine.classify({ text: 'post' }, [])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('maps a refused connection to the launch-at-login message', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));
    expect(await engine.checkReadiness()).toMatchObject({ state: 'unavailable', message: 'Start Llama.app (turn on Launch at login so it is always there)' });
  });
  it.each([new Response('failed', { status: 500 }), new Response('invalid json'), ok({ invalid: true }), ok({ ...inventory(), error: 'failed' })])('distinguishes an answering server error from a stopped app', async response => {
    fetchMock.mockResolvedValue(response.clone());
    expect(await engine.checkReadiness()).toMatchObject({ state: 'error', message: 'Llama.app returned an error' });
  });
  it('maps a missing model to installation', () => {
    expect(readinessFromModels({ data: [{ id: 'unrelated-model' }] })).toEqual({ state: 'missing_model', message: 'Install the d1 model' });
  });
  it('rejects the recorded unbound preset despite all four correct settings', () => {
    expect(readinessFromModels(inventory(UNBOUND_PRESET_ARGS))).toEqual({ state: 'missing_model', message: 'Install the d1 model' });
  });
  it.each(['downloading', 'incomplete'])('maps %s to installation even with a binding', value => {
    expect(readinessFromModels(inventory(ARGS, { value }))).toEqual({ state: 'missing_model', message: 'Install the d1 model' });
  });
  it.each(['--model', '-m'])('accepts exactly one %s file binding', flag => {
    expect(readinessFromModels(inventory([flag, FILE, ...UNBOUND_PRESET_ARGS])).state).toBe('ready');
    expect(readinessFromModels(inventory([`${flag}=${FILE}`, ...UNBOUND_PRESET_ARGS])).state).toBe('ready');
  });
  it('rejects absent, wrong and duplicate file bindings', () => {
    for (const args of [UNBOUND_PRESET_ARGS, ['--model', '/cache/other.gguf', ...UNBOUND_PRESET_ARGS], ['--model', ...UNBOUND_PRESET_ARGS]]) {
      expect(readinessFromModels(inventory(args)).state).toBe('missing_model');
    }
    expect(readinessFromModels(inventory([...ARGS, '-m', FILE])).state).toBe('settings_required');
  });
  it.each(['--hf-repo', '-hf', '--hf-repo=LiquidAI/d1-2B-GGUF', '-hf=LiquidAI/d1-2B-GGUF'])('rejects download binding %s', flag => {
    expect(readinessFromModels(inventory([...ARGS, flag, DECISION_MODEL.repository]))).toEqual({ state: 'settings_required', message: 'Llama.app needs these settings' });
  });
  it.each([{ failed: true, message: 'runner failed' }, { exit_code: 1, message: 'runner failed' },
    { failed: { exit_code: 2, message: 'runner failed' } }, { value: 'failed', error: 'runner failed' }])('shows a failed runner message (%j)', status => {
    expect(readinessFromModels(inventory(ARGS, status))).toEqual({ state: 'error', message: 'runner failed' });
  });
  it.each(['--ctx-size', '--parallel', '--batch-size', '--ubatch-size', '--no-mmproj-auto'])('requires the %s setting', flag => {
    const args = ARGS.filter((arg, index) => arg !== flag && ARGS[index - 1] !== flag);
    expect(readinessFromModels(inventory(args))).toEqual({ state: 'settings_required', message: 'Llama.app needs these settings' });
  });
  it('rejects wrong or duplicate settings and an enabled projector', () => {
    for (const args of [ARGS.map(arg => arg === '4096' ? '2048' : arg), [...ARGS, '--parallel', '2'], [...ARGS, '--mmproj', 'vision.gguf']]) {
      expect(readinessFromModels(inventory(args)).state).toBe('settings_required');
    }
  });
  it('maps an unknown stored state to checking', async () => {
    storage.nativeModelStatus = { state: 'retired-state', message: 'old', revision: 10 };
    expect(await engine.getStatus()).toEqual({ state: 'checking', message: 'Checking Llama.app…', revision: 10 });
  });
  it('provides the exact cache-scan preset', () => {
    expect(LLAMA_MODEL_INI).toBe('[LiquidAI/d1-2B-GGUF:Q8_0]\nctx-size = 4096\nparallel = 1\nbatch-size = 4096\nubatch-size = 4096\nno-mmproj = true');
  });
});

describe('per-post failure isolation', () => {
  it('writes no per-post progress statuses or repeated ready events', async () => {
    await engine.checkReadiness();
    vi.mocked(chrome.storage.local.set).mockClear();
    await engine.classify({ text: 'one' }, ['birds']);
    await engine.classify({ text: 'two' }, ['birds']);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
  it('rechecks readiness after a failed request before another classification', async () => {
    let posts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/models')) return ok(posts ? inventory(UNBOUND_PRESET_ARGS) : inventory());
      if (++posts === 1) return new Response('failed', { status: 500 });
      return ok(answers(0.9));
    });
    await expect(engine.classify({ text: 'first' }, ['birds'])).rejects.toThrow('HTTP 500');
    await expect(engine.classify({ text: 'second' }, ['birds'])).rejects.toThrow('Install the d1 model');
    expect(posts).toBe(1);
    expect(fetchMock.mock.calls.filter(([url]) => (url as string).endsWith('/v1/models'))).toHaveLength(2);
  });
  it.each(['500', 'timeout', 'refused', 'truncated'])('releases the queue after %s and accepts the next post', async failure => {
    vi.useFakeTimers();
    let postCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/v1/models')) return Promise.resolve(ok(inventory()));
      if (++postCalls > 1) return Promise.resolve(ok(answers(0.9)));
      if (failure === '500') return Promise.resolve(new Response('failed', { status: 500 }));
      if (failure === 'refused') return Promise.reject(new TypeError('ECONNREFUSED'));
      if (failure === 'truncated') return Promise.resolve(ok({ ...answers(0.9), truncated: true }));
      return new Promise(() => undefined);
    });
    const first = engine.classify({ text: 'first post stays visible' }, ['birds']);
    const settled = first.then(() => 'unexpected hide', error => (error as Error).message);
    const second = engine.classify({ text: 'second post' }, ['birds']);
    await vi.advanceTimersByTimeAsync(failure === 'timeout' ? REQUEST_TIMEOUT_MS : 0);
    expect(await settled).toMatch(failure === '500' ? /HTTP 500/ : failure === 'timeout' ? /timed out/ : failure === 'truncated' ? /truncated/ : /Start Llama.app/);
    expect(await second).toMatchObject({ scores: [{ label: 'birds', score: 0.9 }] });
    expect(postCalls).toBe(2);
    expect(await engine.getStatus()).toMatchObject({ state: 'ready' });
  });
});
