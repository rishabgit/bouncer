import type { ChatMessage } from '../../types';
import {
  CONCURRENT_NATIVE_MODELS_QUALIFIED,
  NATIVE_CONTEXT_TOKENS,
} from '../../shared/models';
import {
  NativeModelError,
  NATIVE_GENERATION_BODY_BYTES,
  NATIVE_METADATA_BODY_BYTES,
  NATIVE_REQUEST_DEADLINE_MS,
  OLLAMA_HOST_PERMISSION,
  OLLAMA_ORIGIN,
  acceptedModelReference,
  assertModelShow,
  assertModelTag,
  assertVersion,
  isQualifiedTerminalResponse,
  nativeResidency,
  parseNativeCompletion,
  validateNativeMessages,
} from '../../shared/ollama-contract';
import type { LocalBackend, NativeGenerationHooks, NativeReadiness } from './types';

type MetadataPath = '/api/version' | '/api/tags' | '/api/show' | '/api/ps';

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    throw new NativeModelError('response_invalid', 'Ollama returned an oversized response.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new NativeModelError('response_invalid', 'Ollama returned an empty response.');
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new NativeModelError('response_invalid', 'Ollama returned an oversized response.');
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof NativeModelError) throw error;
    throw new NativeModelError('response_invalid', 'Ollama returned an unreadable response.');
  } finally {
    reader.releaseLock();
  }
}

/** Fixed loopback API. Runtime callers cannot supply a URL, command or model. */
export class OllamaBackend implements LocalBackend {
  private _checkPromise: Promise<NativeReadiness> | null = null;
  lastUsage: { promptTokens: number; completionTokens: number } | null = null;

  constructor(private readonly _fetch: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async check(): Promise<NativeReadiness> {
    if (this._checkPromise) return this._checkPromise;
    const check = this._check();
    this._checkPromise = check;
    try { return await check; } finally {
      if (this._checkPromise === check) this._checkPromise = null;
    }
  }

  private async _check(): Promise<NativeReadiness> {
    await this._assertPermission();
    const model = acceptedModelReference();
    const version = assertVersion(await this._metadata('/api/version'));
    assertModelTag(await this._metadata('/api/tags'));
    // A successful GET does not prove the extension origin is allowed to POST.
    assertModelShow(await this._metadata('/api/show', { model }));
    const residency = nativeResidency(await this._metadata('/api/ps'));
    return { version, modelDigest: model.slice('sha256:'.length), ...residency };
  }

  async generate(messages: ChatMessage[], maxTokens: number, hooks: NativeGenerationHooks): Promise<string> {
    validateNativeMessages(messages, maxTokens);
    const ready = await this.check();
    if (ready.otherModelResident && !CONCURRENT_NATIVE_MODELS_QUALIFIED) {
      throw new NativeModelError('other_model_resident', 'Filtering paused while another local model is loaded.');
    }
    await this._assertPermission();
    const payload = JSON.stringify({
      model: acceptedModelReference(),
      messages: messages.map(message => ({ role: message.role, content: message.content })),
      think: false,
      stream: false,
      // The estimator is deliberately conservative, but native tokenization
      // can still overflow. Refuse instead of silently changing the input.
      truncate: false,
      shift: false,
      keep_alive: '1m',
      options: {
        temperature: 0,
        seed: 0,
        num_ctx: NATIVE_CONTEXT_TOKENS,
        num_predict: maxTokens,
      },
    });
    // Nothing asynchronous may intervene between this hook's final epoch check
    // and fetch invocation. A failed hook is a proved pre-submission failure.
    await hooks.beforeSubmit(ready);
    hooks.assertCanSubmit();
    return this._request('/api/chat', payload, NATIVE_GENERATION_BODY_BYTES, async body => {
      if (isQualifiedTerminalResponse(body)) await hooks.onTerminal();
      const result = parseNativeCompletion(body, maxTokens);
      const usage = body as { prompt_eval_count: number; eval_count: number };
      this.lastUsage = { promptTokens: usage.prompt_eval_count, completionTokens: usage.eval_count };
      return result;
    });
  }

  private async _assertPermission(): Promise<void> {
    const permitted = await chrome.permissions.contains({ origins: [OLLAMA_HOST_PERMISSION] });
    if (!permitted) {
      throw new NativeModelError('permission_required', 'Connect to Ollama to allow local filtering.');
    }
  }

  private async _metadata(path: MetadataPath, payload?: { model: string }): Promise<unknown> {
    await this._assertPermission();
    return this._request(path, payload ? JSON.stringify(payload) : undefined, NATIVE_METADATA_BODY_BYTES, value => Promise.resolve(value));
  }

  private _request<T>(
    path: MetadataPath | '/api/chat',
    body: string | undefined,
    maximumBytes: number,
    consume: (value: unknown) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const submitted = path === '/api/chat';
    let deadlineReached = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        deadlineReached = true;
        controller.abort();
        reject(new NativeModelError(
          'native_timeout',
          submitted ? 'The native request timed out. Restart recovery is required before filtering resumes.'
            : 'Ollama did not respond in time. Open Ollama, then Retry.',
          submitted ? 'uncertain' : 'not_submitted',
        ));
      }, NATIVE_REQUEST_DEADLINE_MS);
    });
    // The continuation remains attached after the deadline. A genuinely late
    // terminal response may settle its own fence; it can never publish a result.
    const work = (async (): Promise<T> => {
      try {
        const response = await this._fetch(`${OLLAMA_ORIGIN}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (!response.ok) {
          const reason = response.status === 403 ? 'origin_rejected'
            : response.status === 404 && path === '/api/show' ? 'model_missing' : 'service_unreachable';
          const message = reason === 'origin_rejected' ? 'Ollama blocked this connection. Check the exact extension-origin setup.'
            : reason === 'model_missing' ? 'The fixed classifier is missing. Complete model setup, then Retry.'
              : 'Cannot reach Ollama. Open Ollama, then Retry.';
          throw new NativeModelError(reason, message, submitted ? 'uncertain' : 'not_submitted');
        }
        const value = await readBoundedJson(response, maximumBytes);
        return await consume(value);
      } catch (error) {
        if (error instanceof NativeModelError) {
          if (submitted && error.submission === 'not_submitted') {
            throw new NativeModelError(error.reason, error.message, 'uncertain');
          }
          throw error;
        }
        throw new NativeModelError(
          deadlineReached ? 'native_timeout' : 'service_unreachable',
          deadlineReached ? 'The native request timed out. Restart recovery is required before filtering resumes.'
            : 'Cannot reach Ollama. Open Ollama, then Retry.',
          submitted ? 'uncertain' : 'not_submitted',
        );
      }
    })();
    return Promise.race([work, timeout]).finally(() => clearTimeout(timeoutId));
  }
}
