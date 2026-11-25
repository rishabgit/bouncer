// Fixed System One client. Metadata never loads weights; failures affect one post.
import type { EvaluationPostData, FilterScore, LocalModelStatus } from '../types';
import { DECISION_MODEL, DECISION_CLASSIFIER_FINGERPRINT, LLAMA_ENDPOINT, decisionCutoff, decisionQuestions } from '../shared/decision-model';
import { truncateText } from '../shared/utils';
import { getStorage, setStorage } from '../shared/storage';
import { InferenceQueue, STALE_WORK_ERROR } from './inference-queue';
export { STALE_WORK_ERROR } from './inference-queue';
import { normalizeLocalModelStatus } from '../shared/engine-status-view';

export const REQUEST_TIMEOUT_MS = 25_000;
export const START_LLAMA_MESSAGE = 'Start Llama.app (turn on Launch at login so it is always there)';
export const INSTALL_MODEL_MESSAGE = `Install the ${DECISION_MODEL.label} model`;
export const LLAMA_ERROR_MESSAGE = 'Llama.app returned an error';
export const MODEL_SETTINGS_MESSAGE = 'Llama.app needs these settings';
const READY = { state: 'ready' as const, message: 'Ready — loads when needed' };
type StatusUpdate = Omit<LocalModelStatus, 'revision'>;

type FailureKind = 'unavailable' | 'timeout' | 'http' | 'response';
class RequestError extends Error {
  constructor(readonly kind: FailureKind, message: string) { super(message); }
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function request(path: '/v1/models' | '/v1/systemone', body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestError('timeout', 'Llama.app timed out.'));
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, (async () => {
      let response: Response;
      try {
        response = await fetch(`${LLAMA_ENDPOINT}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
          credentials: 'omit', redirect: 'error', signal: controller.signal,
        });
      } catch {
        throw new RequestError('unavailable', START_LLAMA_MESSAGE);
      }
      if (!response.ok) throw new RequestError('http', `Llama.app returned HTTP ${response.status}.`);
      try { return await response.json() as unknown; } catch {
        throw new RequestError('response', 'Llama.app returned an invalid response.');
      }
    })()]);
  } finally { clearTimeout(timer); }
}

/** Inventory is exposed even for unloaded models. Inspect arguments without loading. */
export function readinessFromModels(value: unknown): StatusUpdate {
  const response = record(value);
  const data = response.data;
  if (response.error || !Array.isArray(data)) throw new RequestError('response', LLAMA_ERROR_MESSAGE);
  const model = (data as unknown[]).find(item => record(item).id === DECISION_MODEL.id);
  if (!model) return { state: 'missing_model', message: INSTALL_MODEL_MESSAGE };
  const status = record(record(model).status);
  const failure = record(status.failed);
  const exitCode = status.exit_code ?? status.exitCode ?? failure.exit_code ?? failure.exitCode;
  if (status.failed || status.value === 'failed' || status.value === 'error'
      || (exitCode !== undefined && exitCode !== null && Number(exitCode) !== 0)) {
    const message = [status.message, status.error, failure.message, failure.error, status.failed]
      .find((item): item is string => typeof item === 'string' && item.trim().length > 0);
    const code = typeof exitCode === 'number' || typeof exitCode === 'string' ? String(exitCode) : undefined;
    return { state: 'error', message: message ?? `${LLAMA_ERROR_MESSAGE}${code !== undefined ? ` (exit ${code})` : ''}` };
  }
  const rawArgs = status.args;
  const args = Array.isArray(rawArgs) && (rawArgs as unknown[]).every(arg => typeof arg === 'string')
    ? rawArgs as string[] : [];
  const valuesFor = (flags: string[]): string[] => args.flatMap((arg, index) => {
    if (flags.includes(arg)) return [args[index + 1] ?? ''];
    const flag = flags.find(flag => arg.startsWith(`${flag}=`));
    return flag ? [arg.slice(flag.length + 1)] : [];
  });
  if (args.some(arg => ['--hf-repo', '-hf'].some(flag => arg === flag || arg.startsWith(`${flag}=`)))) {
    return { state: 'settings_required', message: MODEL_SETTINGS_MESSAGE };
  }
  const bindings = valuesFor(['--model', '-m']);
  if (['downloading', 'incomplete'].includes(String(status.value)) || !bindings.length
      || bindings.length === 1 && !bindings[0].endsWith(`/${DECISION_MODEL.fileName}`)) {
    return { state: 'missing_model', message: INSTALL_MODEL_MESSAGE };
  }
  const settingMatches = (key: string, expected: number): boolean => {
    const values = valuesFor([`--${key}`]);
    return values.length === 1 && values[0].trim() !== '' && Number(values[0]) === expected;
  };
  const hasProjector = args.some(arg => arg === '--mmproj' || arg === '-mm' || arg.startsWith('--mmproj='));
  const projectorDisabled = args.includes('--no-mmproj-auto') || args.includes('--no-mmproj');
  if (bindings.length !== 1 || Object.entries(DECISION_MODEL.settings).some(([key, value]) => !settingMatches(key, value))
      || (DECISION_MODEL.noProjector && (!projectorDisabled || hasProjector))) {
    return { state: 'settings_required', message: MODEL_SETTINGS_MESSAGE };
  }
  return READY;
}

/** Count text bytes as a conservative byte-fallback token bound, leaving room for framing. */
export function buildDecisionRequest(post: EvaluationPostData, filters: string[]) {
  if (!post.text.trim()) throw new Error('A real post is required.');
  const questions = decisionQuestions(filters);
  const questionBytes = Object.values(questions).reduce((sum, question) => sum + new TextEncoder().encode(question.instructions).length, 0);
  // A non-ASCII UTF-16 unit weighs 2 and encodes to at most 3 UTF-8 bytes.
  const availableWeight = Math.floor((DECISION_MODEL.requestTextByteCap - questionBytes) / 1.5);
  if (availableWeight < 1) throw new Error('Filter descriptions exceed the input budget. Shorten the descriptions.');
  const state = truncateText(post.text, Math.min(DECISION_MODEL.postWeightCap, availableWeight));
  if (!state.trim()) throw new Error('Post text exceeds the input budget.');
  return { model: DECISION_MODEL.id, state, questions };
}

export function parseDecisionAnswers(value: unknown, filters: string[]): FilterScore[] {
  const response = record(value);
  if (response.truncated === true || record(response.usage).truncated === true) {
    throw new RequestError('response', 'Llama.app truncated the input.');
  }
  const answers = record(response.answers);
  if (response.error || Object.keys(answers).length !== filters.length) {
    throw new RequestError('response', 'Llama.app returned incomplete decisions.');
  }
  return filters.map((label, index) => {
    const answer = record(answers[`f${index}`]);
    const probability = answer.noul;
    if (answer.type !== 'noul' || typeof probability !== 'number' || !Number.isFinite(probability)
        || probability < 0 || probability > 1) {
      throw new RequestError('response', `Llama.app returned an invalid decision for f${index}.`);
    }
    return { label, score: probability };
  });
}

export class LocalEngine {
  private readonly _queue = new InferenceQueue();
  private _epoch = 0;
  private _ready = false;
  private _readinessPromise: Promise<LocalModelStatus> | null = null;
  private _statusWrites: Promise<unknown> = Promise.resolve();

  getClassifierFingerprint(): string { return DECISION_CLASSIFIER_FINGERPRINT; }
  get operationEpoch(): number { return this._epoch; }
  assertOperationEpoch(epoch: number): void {
    if (epoch !== this._epoch) throw new Error(STALE_WORK_ERROR);
  }
  async getStatus(): Promise<LocalModelStatus> {
    await this._statusWrites;
    const data = await getStorage(['nativeModelStatus']);
    return normalizeLocalModelStatus(data.nativeModelStatus);
  }
  private updateStatus(status: StatusUpdate): Promise<LocalModelStatus> {
    const write = this._statusWrites.catch(() => undefined).then(async () => {
      const data = await getStorage(['nativeModelStatus']);
      const previous = normalizeLocalModelStatus(data.nativeModelStatus);
      if (previous?.state === status.state && previous.message === status.message) return previous;
      const result = { ...status, revision: (previous?.revision ?? 0) + 1 };
      await setStorage({ nativeModelStatus: result });
      return result;
    });
    this._statusWrites = write.then(() => undefined, () => undefined);
    return write;
  }
  checkReadiness(): Promise<LocalModelStatus> {
    if (this._readinessPromise) return this._readinessPromise;
    const check = (async () => {
      let status: StatusUpdate;
      try { status = readinessFromModels(await request('/v1/models')); } catch (error) {
        status = error instanceof RequestError && error.kind === 'unavailable'
          ? { state: 'unavailable', message: START_LLAMA_MESSAGE }
          : { state: 'error', message: LLAMA_ERROR_MESSAGE };
      }
      this._ready = status.state === 'ready';
      return this.updateStatus(status);
    })();
    this._readinessPromise = check;
    const release = () => { if (this._readinessPromise === check) this._readinessPromise = null; };
    void check.then(release, release);
    return check;
  }
  async classify(post: EvaluationPostData, filters: string[], options: {
    onInferenceStart?: () => void; assertCurrent?: () => void;
  } = {}) {
    // Build/validate before queuing; capture ownership before any awaits.
    const requestFilters = [...filters];
    const body = buildDecisionRequest(post, requestFilters);
    const epoch = this._epoch;
    const assertCurrent = () => {
      this.assertOperationEpoch(epoch);
      options.assertCurrent?.();
    };
    assertCurrent();
    return this._queue.enqueue(async () => {
      assertCurrent();
      if (!this._ready) {
        const readiness = await this.checkReadiness();
        assertCurrent();
        if (readiness.state !== 'ready') throw new Error(readiness.message);
      }
      assertCurrent();
      options.onInferenceStart?.();
      const started = performance.now();
      try {
        const response = await request('/v1/systemone', body);
        assertCurrent();
        const scores = parseDecisionAnswers(response, requestFilters);
        const cutoff = decisionCutoff(body.state);
        const matches = scores.filter(({ score }) => score >= cutoff).map(({ label }) => label);
        assertCurrent();
        return {
          shouldHide: matches.length > 0,
          reasoning: matches.length ? `Matched: ${matches.join(', ')}` : 'No matching filters',
          category: matches.length ? matches.join(', ') : null,
          matches, scores, textSent: body.state,
          rawResponse: JSON.stringify(response), inferenceTime: (performance.now() - started) / 1000,
          classifierFingerprint: this.getClassifierFingerprint(), modelId: DECISION_MODEL.id,
          engine: 'llama.app' as const,
        };
      } catch (error) {
        this._ready = false;
        assertCurrent();
        await this.updateStatus(error instanceof RequestError && error.kind === 'unavailable'
          ? { state: 'unavailable', message: START_LLAMA_MESSAGE }
          : { state: 'error', message: error instanceof Error ? error.message : LLAMA_ERROR_MESSAGE });
        throw error;
      }
    });
  }
  invalidate(): void { this._epoch++; this.clearQueue(); }
  clearQueue(): void { this._queue.clear(); }
  teardown(): void { this.invalidate(); this._ready = false; }
}

export const localEngine = new LocalEngine();
export const callLocalInference = (post: EvaluationPostData, filters: string[], options?: {
  onInferenceStart?: () => void; assertCurrent?: () => void;
}) => localEngine.classify(post, filters, options);
