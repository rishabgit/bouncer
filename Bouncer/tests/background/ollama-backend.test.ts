import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeState = vi.hoisted(() => ({ digest: 'a'.repeat(64), concurrent: false }));
vi.mock('../../src/shared/models.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/shared/models.js')>(),
  get ACCEPTED_NATIVE_MANIFEST_DIGEST() { return nativeState.digest; },
  get CONCURRENT_NATIVE_MODELS_QUALIFIED() { return nativeState.concurrent; },
}));
import { OllamaBackend } from '../../src/background/backends/ollama-backend.js';
import {
  NativeModelError, NATIVE_REQUEST_DEADLINE_MS, OLLAMA_HOST_PERMISSION,
} from '../../src/shared/ollama-contract.js';
import {
  completion, TEST_DIGEST, TEST_MESSAGES, TEST_SHOW, TEST_TAGS,
} from './native-fixtures.js';

let contains: ReturnType<typeof vi.fn>;
let replies: Record<string, unknown>;
let request: ReturnType<typeof vi.fn>;
let beforeSubmit: ReturnType<typeof vi.fn>;
let assertCanSubmit: ReturnType<typeof vi.fn>;
let onTerminal: ReturnType<typeof vi.fn>;

function hooks() { return { beforeSubmit, assertCanSubmit, onTerminal }; }
function makeBackend() { return new OllamaBackend(request as typeof fetch); }

beforeEach(() => {
  nativeState.digest = TEST_DIGEST;
  nativeState.concurrent = false;
  contains = vi.fn().mockResolvedValue(true);
  chrome.permissions = { contains } as unknown as typeof chrome.permissions;
  replies = {
    '/api/version': { version: '0.40.3' },
    '/api/tags': structuredClone(TEST_TAGS),
    '/api/show': structuredClone(TEST_SHOW),
    '/api/ps': { models: [] },
    '/api/chat': completion(),
  };
  request = vi.fn(async (url: string) => new Response(JSON.stringify(replies[new URL(url).pathname])));
  beforeSubmit = vi.fn().mockResolvedValue(undefined);
  assertCanSubmit = vi.fn();
  onTerminal = vi.fn().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('fixed native transport', () => {
  it('checks the exact optional permission and POST metadata without loading weights', async () => {
    expect(await makeBackend().check()).toEqual({ version: '0.40.3', modelDigest: TEST_DIGEST, resident: false, otherModelResident: false });
    expect(contains).toHaveBeenCalledWith({ origins: [OLLAMA_HOST_PERMISSION] });
    expect(request.mock.calls.map(call => new URL(call[0] as string).pathname)).toEqual(['/api/version', '/api/tags', '/api/show', '/api/ps']);
    for (const [, options] of request.mock.calls) expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ model: `sha256:${TEST_DIGEST}` });
  });

  it.each([64, 150])('sends a complete %i-token plain request that refuses native input truncation and context shifting', async maxTokens => {
    expect(await makeBackend().generate(TEST_MESSAGES, maxTokens, hooks())).toBe('no');
    const body = JSON.parse(request.mock.calls.at(-1)![1].body);
    expect(body).toEqual({
      model: `sha256:${TEST_DIGEST}`, messages: TEST_MESSAGES,
      think: false, stream: false, truncate: false, shift: false, keep_alive: '1m',
      options: { temperature: 0, seed: 0, num_ctx: 1024, num_predict: maxTokens },
    });
    expect(beforeSubmit).toHaveBeenCalledTimes(1);
    expect(assertCanSubmit).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('retains complete estimator-fitting Unicode and never accepts native overflow refusal as a negative verdict', async () => {
    const messages = [TEST_MESSAGES[0], { role: 'user' as const, content: '🦆'.repeat(600) }];
    request.mockImplementation(async (url: string, options: RequestInit) => {
      if (!url.endsWith('/api/chat')) return new Response(JSON.stringify(replies[new URL(url).pathname]));
      const payload = JSON.parse(options.body as string);
      expect(payload.messages).toEqual(messages);
      // Model the native tokenizer finding overflow after the chars/3 check.
      // Without the refusal flags, the old API defaults return truncated input
      // and a superficially valid all-no result with ordinary observed counts.
      return payload.truncate === false && payload.shift === false
        ? new Response(JSON.stringify({ error: 'synthetic input exceeds context' }), { status: 400 })
        : new Response(JSON.stringify(completion('no')));
    });
    await expect(makeBackend().generate(messages, 64, hooks())).rejects.toMatchObject({ submission: 'uncertain' });
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('sends no requests when permission is denied', async () => {
    contains.mockResolvedValue(false);
    await expect(makeBackend().check()).rejects.toMatchObject({ reason: 'permission_required', submission: 'not_submitted' });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed until a full artifact digest is accepted', async () => {
    nativeState.digest = '';
    await expect(makeBackend().generate(TEST_MESSAGES, 64, hooks())).rejects.toMatchObject({ reason: 'model_unqualified' });
    expect(request).not.toHaveBeenCalled();
    expect(beforeSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['remote tag', '/api/tags', () => ({ models: [{ ...TEST_TAGS.models[0], remote_host: 'https://cloud.invalid' }] })],
    ['remote show', '/api/show', () => ({ ...TEST_SHOW, remote_model: 'cloud-model' })],
    ['changed digest', '/api/tags', () => ({ models: [{ ...TEST_TAGS.models[0], digest: 'b'.repeat(64) }] })],
    ['vision capability', '/api/show', () => ({ ...TEST_SHOW, capabilities: ['completion', 'vision'] })],
    ['changed weights', '/api/show', () => ({ ...TEST_SHOW, modelfile: TEST_SHOW.modelfile.replace('sha256-', 'sha256-bad') })],
    ['changed renderer', '/api/show', () => ({ ...TEST_SHOW, modelfile: TEST_SHOW.modelfile.replace('gemma4-small', 'unknown') })],
    ['changed parameters', '/api/show', () => ({ ...TEST_SHOW, parameters: `${TEST_SHOW.parameters}\nrepeat_penalty 1.2` })],
    ['changed runtime', '/api/version', () => ({ version: '9.9.9' })],
  ])('refuses %s before transmitting post content', async (_label, path, value) => {
    replies[path as string] = (value as () => unknown)();
    await expect(makeBackend().generate(TEST_MESSAGES, 64, hooks())).rejects.toBeInstanceOf(NativeModelError);
    expect(request.mock.calls.some(call => call[0].endsWith('/api/chat'))).toBe(false);
    expect(beforeSubmit).not.toHaveBeenCalled();
  });

  it('reports POST origin rejection even after successful GET health', async () => {
    request.mockImplementation(async (url: string) => new Response(JSON.stringify(replies[new URL(url).pathname]), { status: url.endsWith('/api/show') ? 403 : 200 }));
    await expect(makeBackend().check()).rejects.toMatchObject({ reason: 'origin_rejected', submission: 'not_submitted' });
  });

  it('defers generation while another model is resident', async () => {
    replies['/api/ps'] = { models: [{ digest: 'b'.repeat(64), name: 'synthetic-qwen' }] };
    await expect(makeBackend().generate(TEST_MESSAGES, 64, hooks())).rejects.toMatchObject({ reason: 'other_model_resident' });
    expect(beforeSubmit).not.toHaveBeenCalled();
  });

  it('shares simultaneous readiness checks', async () => {
    const backend = makeBackend();
    await Promise.all([backend.check(), backend.check(), backend.check()]);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('rejects history, empty messages, tools-like payloads and excessive budget before any request', async () => {
    await expect(makeBackend().generate([...TEST_MESSAGES, { role: 'assistant', content: 'history' }], 64, hooks())).rejects.toMatchObject({ reason: 'input_budget' });
    await expect(makeBackend().generate([{ role: 'system', content: '' }, TEST_MESSAGES[1]], 64, hooks())).rejects.toMatchObject({ reason: 'input_budget' });
    await expect(makeBackend().generate(TEST_MESSAGES, 257, hooks())).rejects.toMatchObject({ reason: 'input_budget' });
    await expect(makeBackend().generate([TEST_MESSAGES[0], { role: 'user', content: 'x'.repeat(4000) }], 64, hooks())).rejects.toMatchObject({ reason: 'input_budget' });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not submit after the persisted-fence epoch check is preempted', async () => {
    assertCanSubmit.mockImplementation(() => { throw new NativeModelError('inference_preempted', 'Inference preempted'); });
    await expect(makeBackend().generate(TEST_MESSAGES, 64, hooks())).rejects.toMatchObject({ reason: 'inference_preempted', submission: 'not_submitted' });
    expect(request).toHaveBeenCalledTimes(4);
  });
});

describe('strict finite native completion', () => {
  it.each([
    ['not done', { done: false }],
    ['missing terminal reason', { done_reason: undefined }],
    ['length termination', { done_reason: 'length' }],
    ['thinking output', { message: { role: 'assistant', content: 'no', thinking: 'hidden reasoning' } }],
    ['tool call', { message: { role: 'assistant', content: 'no', tool_calls: [{}] } }],
    ['missing prompt count', { prompt_eval_count: undefined }],
    ['context overflow', { prompt_eval_count: 1000 }],
    ['output ceiling', { eval_count: 64 }],
    ['embedded native error', { error: 'synthetic failure' }],
    ['empty output', { message: { role: 'assistant', content: '' } }],
    ['wrong model', { model: 'remote:cloud' }],
    ['remote metadata', { remote_host: 'cloud.invalid' }],
  ])('never accepts %s as a valid negative', async (_name, invalid) => {
    replies['/api/chat'] = completion('no', invalid);
    await expect(makeBackend().generate(TEST_MESSAGES, 64, hooks())).rejects.toMatchObject({ reason: 'response_invalid' });
  });

  it('settles a completed length-truncated request while retaining its classification failure', async () => {
    replies['/api/chat'] = completion('no', { done_reason: 'length' });
    await expect(makeBackend().generate(TEST_MESSAGES, 64, hooks())).rejects.toMatchObject({ reason: 'response_invalid', submission: 'terminal' });
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('keeps nonterminal and remote responses unresolved', async () => {
    replies['/api/chat'] = completion('no', { done: false });
    await expect(makeBackend().generate(TEST_MESSAGES, 64, hooks())).rejects.toBeInstanceOf(NativeModelError);
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('caps response bytes and never echoes native errors or malformed content into diagnostics', async () => {
    request.mockImplementation(async (url: string) => new Response(url.endsWith('/api/chat') ? 'private-output'.repeat(5000) : JSON.stringify(replies[new URL(url).pathname])));
    await expect(makeBackend().generate(TEST_MESSAGES, 64, hooks())).rejects.toMatchObject({ message: 'Ollama returned an oversized response.', submission: 'uncertain' });
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('rejects at the deadline even when fetch ignores abort, but observes a genuinely late terminal response', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    request.mockImplementation(async (url: string) => url.endsWith('/api/chat')
      ? new Promise<Response>(resolve => { finish = resolve; })
      : new Response(JSON.stringify(replies[new URL(url).pathname])));
    const pending = makeBackend().generate(TEST_MESSAGES, 64, hooks());
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'native_timeout', submission: 'uncertain' });
    await vi.advanceTimersByTimeAsync(NATIVE_REQUEST_DEADLINE_MS);
    await rejection;
    expect(onTerminal).not.toHaveBeenCalled();
    finish(new Response(JSON.stringify(completion())));
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});
