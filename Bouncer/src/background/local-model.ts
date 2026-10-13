// One serial native inference lease. Ollama owns loading and idle residency;
// Bouncer owns eligibility, cancellation epochs and a durable content-free fence.
import type {
  ChatMessage,
  EvaluationPostData,
  LocalModelDef,
  LocalModelStatus,
  NativeOperationFence,
} from '../types';
import {
  CONCURRENT_NATIVE_MODELS_QUALIFIED,
  NATIVE_CLASSIFIER_FINGERPRINT,
  NATIVE_CONTEXT_TOKENS,
  OPERATOR_RESTART_RECOVERY_QUALIFIED,
  PRIMARY_LOCAL_MODEL,
  PRIMARY_LOCAL_MODEL_ID,
} from '../shared/models';
import {
  NativeModelError,
  NATIVE_METADATA_RETRY_MS,
  OLLAMA_HOST_PERMISSION,
  acceptedDigest,
  nativeFailureStatus,
  record,
} from '../shared/ollama-contract';
import type { LocalPromptMode } from '../shared/prompts';
import { parseTableYesnoResponse } from '../shared/table-yesno';
import { buildNativeTableYesnoRequest } from '../shared/table-yesno-request';
import { getStorage, removeStorage, setStorage } from '../shared/storage';
import { inferenceQueue } from './inference-queue';
import type { LocalBackend, NativeReadiness } from './backends/types';
import { OllamaBackend } from './backends/ollama-backend';

export { parseTableYesnoResponse } from '../shared/table-yesno';
export const MODEL_MAINTENANCE_ERROR = 'Local model maintenance in progress';

type StatusUpdate = Omit<LocalModelStatus, 'revision'>;
interface InferenceBackendLease {
  countTokens(text: string): Promise<number>;
  truncateText(text: string, maxTokens: number): Promise<string>;
  generate(messages: ChatMessage[], maxTokens: number): Promise<string>;
}

function assertFixedModel(modelId: string): void {
  if (modelId !== PRIMARY_LOCAL_MODEL_ID) {
    throw new NativeModelError('model_identity_changed', 'Bouncer supports only its fixed native classifier.');
  }
}

function sameFence(value: unknown, operationId: string): boolean {
  return record(value).operationId === operationId;
}

export class LocalEngine {
  private readonly _backend: LocalBackend;
  private _epoch = 0;
  private _maintenance = false;
  private _maintenanceGeneration = 0;
  private _statusWriteChain: Promise<void> = Promise.resolve();
  private _fenceWriteChain: Promise<void> = Promise.resolve();
  private _readinessPromise: Promise<NativeReadiness> | null = null;
  private _activeOperationId: string | null = null;
  private _retryRequired = false;
  private _lastMetadataFailure: { at: number; error: unknown } | null = null;
  private _readiness: NativeReadiness | null = null;

  constructor(backend: LocalBackend = new OllamaBackend()) { this._backend = backend; }

  get operationEpoch(): number { return this._epoch; }
  isMaintaining(): boolean { return this._maintenance; }

  assertOperationEpoch(expected: number): void {
    if (this._epoch !== expected) {
      throw new NativeModelError('inference_preempted', 'Inference preempted');
    }
  }

  private _assertMaintenanceGeneration(expected: number): void {
    if (this._maintenance || this._maintenanceGeneration !== expected) throw new Error(MODEL_MAINTENANCE_ERROR);
  }

  private _recoveryStatus(): StatusUpdate {
    return {
      state: 'recovery_required',
      message: 'A native request may still be running. Restart Ollama before resuming filtering.',
      reason: 'recovery_required',
      recoveryQualified: OPERATOR_RESTART_RECOVERY_QUALIFIED,
    };
  }

  /** Snapshot only. Popup opens and healthy idle never poll or preload weights. */
  getStatus(): Promise<LocalModelStatus> {
    const snapshot = this._statusWriteChain.catch(() => undefined).then(async () => {
      let permitted = false;
      try { permitted = await chrome.permissions.contains({ origins: [OLLAMA_HOST_PERMISSION] }); } catch { /* fail closed */ }
      const data = await getStorage(['nativeModelStatus', 'nativeOperationFence']);
      if (!permitted) {
        return this._writeStatus({ state: 'not_connected', message: 'Connect to Ollama to allow local filtering.', reason: 'permission_required' }, data.nativeModelStatus);
      }
      if (data.nativeOperationFence !== undefined
          && !sameFence(data.nativeOperationFence, this._activeOperationId ?? '')) {
        this._retryRequired = true;
        return this._writeStatus(this._recoveryStatus(), data.nativeModelStatus);
      }
      const status = data.nativeModelStatus;
      if (status && typeof status.revision === 'number') {
        if ((status.state === 'error' && status.reason !== 'service_unreachable')
            || ['recovery_required', 'blocked', 'missing_model'].includes(status.state)) this._retryRequired = true;
        // A restarted worker has no active lease. Stale busy UI is healthy
        // idle; an unresolved durable fence above takes precedence.
        if ((status.state === 'loading' || status.state === 'filtering') && !this._activeOperationId) {
          return this._writeStatus({ state: 'ready', message: 'Ready — loads when needed' }, status);
        }
        return status;
      }
      return { state: 'not_connected' as const, message: 'Connect to Ollama', revision: 0 };
    });
    this._statusWriteChain = snapshot.then(() => undefined, () => undefined);
    return snapshot;
  }

  async syncAllStatuses(): Promise<void> { await this.getStatus(); }

  /** Metadata Retry cannot clear a durable native-work fence. */
  async retry(): Promise<LocalModelStatus> {
    if (this._activeOperationId) return this.getStatus();
    const epoch = this._epoch;
    const maintenance = this._maintenanceGeneration;
    this._assertMaintenanceGeneration(maintenance);
    try {
      await this._checkReadiness(true);
      this._assertMaintenanceGeneration(maintenance);
      this.assertOperationEpoch(epoch);
      const data = await getStorage(['nativeOperationFence']);
      this.assertOperationEpoch(epoch);
      if (data.nativeOperationFence !== undefined) {
        this._retryRequired = true;
        return this.updateStatus(this._recoveryStatus());
      }
      this._retryRequired = false;
      return this._publishReadiness();
    } catch (error) {
      if (error instanceof NativeModelError && error.reason === 'inference_preempted') throw error;
      await this.reportFailure(error);
      return this.getStatus();
    }
  }

  async ensureLoaded(modelId = PRIMARY_LOCAL_MODEL_ID): Promise<void> {
    assertFixedModel(modelId);
    const epoch = this._epoch;
    const maintenance = this._maintenanceGeneration;
    this._assertMaintenanceGeneration(maintenance);
    const status = await this.getStatus();
    this._assertMaintenanceGeneration(maintenance);
    this.assertOperationEpoch(epoch);
    if (status.state === 'not_connected' && status.reason === 'permission_required') {
      throw new NativeModelError('permission_required', status.message);
    }
    if (status.state === 'recovery_required') {
      throw new NativeModelError('recovery_required', status.message, 'uncertain');
    }
    if (this._retryRequired) {
      throw new NativeModelError('response_invalid', 'Retry from the Bouncer popup before filtering resumes.');
    }
    if (!this._readiness) {
      try {
        await this._checkReadiness(false);
        this._assertMaintenanceGeneration(maintenance);
        this.assertOperationEpoch(epoch);
        await this._publishReadiness();
      } catch (error) {
        if (!(error instanceof NativeModelError && error.reason === 'inference_preempted')
            && !(error instanceof Error && error.message === MODEL_MAINTENANCE_ERROR)) await this.reportFailure(error);
        throw error;
      }
    }
  }

  private async _checkReadiness(explicit: boolean): Promise<NativeReadiness> {
    if (!explicit && this._lastMetadataFailure
        && Date.now() - this._lastMetadataFailure.at < NATIVE_METADATA_RETRY_MS) {
      throw this._lastMetadataFailure.error;
    }
    if (this._readinessPromise) return this._readinessPromise;
    const check = this._backend.check();
    this._readinessPromise = check;
    try {
      const readiness = await check;
      this._readiness = readiness;
      this._lastMetadataFailure = null;
      return readiness;
    } catch (error) {
      this._lastMetadataFailure = { at: Date.now(), error };
      throw error;
    } finally {
      if (this._readinessPromise === check) this._readinessPromise = null;
    }
  }

  private async _publishReadiness(): Promise<LocalModelStatus> {
    if (this._readiness?.otherModelResident && !CONCURRENT_NATIVE_MODELS_QUALIFIED) {
      return this.updateStatus({ state: 'paused', message: 'Filtering paused while another local model is loaded.', reason: 'other_model_resident' });
    }
    return this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' });
  }

  /** Explicit, qualified operator procedure; user confirmation is the trust boundary. */
  async recoverAfterOperatorRestart(operatorRestartConfirmed: boolean): Promise<LocalModelStatus> {
    if (!OPERATOR_RESTART_RECOVERY_QUALIFIED || operatorRestartConfirmed !== true) {
      throw new NativeModelError('recovery_required', 'Restart recovery has not been qualified. Metadata Retry cannot settle native work.', 'uncertain');
    }
    return this.runMaintenance(async () => {
      const before = await getStorage(['nativeOperationFence']);
      if (before.nativeOperationFence === undefined) {
        this._retryRequired = false;
        await this._checkReadiness(true);
        return this._publishReadiness();
      }
      const identity = JSON.stringify(before.nativeOperationFence);
      await this._checkReadiness(true);
      await this._serializeFenceWrite(async () => {
        const current = await getStorage(['nativeOperationFence']);
        if (JSON.stringify(current.nativeOperationFence) !== identity) {
          throw new NativeModelError('recovery_required', 'The native operation changed during recovery. Retry the recovery procedure.', 'uncertain');
        }
        await removeStorage('nativeOperationFence');
        const verified = await getStorage(['nativeOperationFence']);
        if (verified.nativeOperationFence !== undefined) {
          throw new NativeModelError('storage_failed', 'Could not persist native recovery. Filtering remains paused.', 'uncertain');
        }
      });
      this._retryRequired = false;
      return this._publishReadiness();
    });
  }

  async generate(
    messages: ChatMessage[], maxTokens: number,
    { priority = 0, onStart }: { priority?: number; onStart?: () => void } = {},
  ): Promise<string> {
    return this.runInferenceOperation(async lease => {
      onStart?.();
      return lease.generate(messages, maxTokens);
    }, { priority });
  }

  async runInferenceOperation<T>(
    operation: (lease: InferenceBackendLease) => Promise<T>,
    { priority = 0, assertCurrent }: { priority?: number; assertCurrent?: () => void } = {},
  ): Promise<T> {
    // Captured at call time, before queue and prompt-preparation awaits.
    const epoch = this._epoch;
    const maintenance = this._maintenanceGeneration;
    this._assertMaintenanceGeneration(maintenance);
    assertCurrent?.();
    return inferenceQueue.enqueue(async () => {
      let leaseOpen = true;
      let callerRetired = false;
      let callerFailure: unknown;
      const assertActive = (): void => {
        if (!leaseOpen) throw new NativeModelError('inference_preempted', 'Inference lease ended');
        this._assertMaintenanceGeneration(maintenance);
        this.assertOperationEpoch(epoch);
        if (callerRetired) throw callerFailure;
        try { assertCurrent?.(); } catch (error) {
          callerRetired = true;
          callerFailure = error;
          throw error;
        }
      };
      assertActive();
      await this.ensureLoaded();
      assertActive();
      const lease: InferenceBackendLease = {
        countTokens: (text: string) => {
          assertActive();
          return Promise.resolve(Math.ceil(text.length / 3)).then(count => { assertActive(); return count; });
        },
        truncateText: (text: string, maxTokens: number) => {
          assertActive();
          if (!Number.isInteger(maxTokens) || maxTokens < 0) throw new NativeModelError('input_budget', 'Invalid native input budget.');
          let bounded = text.slice(0, maxTokens * 3);
          // Avoid cutting one UTF-16 surrogate pair in half.
          if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
          return Promise.resolve(bounded).then(result => { assertActive(); return result; });
        },
        generate: async (messages: ChatMessage[], maxTokens: number) => {
          assertActive();
          const pending = await getStorage(['nativeOperationFence']);
          assertActive();
          if (pending.nativeOperationFence !== undefined) {
            throw new NativeModelError('recovery_required', this._recoveryStatus().message, 'uncertain');
          }
          const operationId = crypto.randomUUID();
          let fenceWritten = false;
          let submitted = false;
          try {
            const result = await this._backend.generate(messages, maxTokens, {
              beforeSubmit: async readiness => {
                assertActive();
                this._readiness = readiness;
                await this.updateStatus({ state: readiness.resident ? 'filtering' : 'loading', message: readiness.resident ? 'Filtering' : 'Loading model…' });
                assertActive();
                const fence: NativeOperationFence = {
                  schemaVersion: 1,
                  operationId,
                  epoch,
                  startedAt: Date.now(),
                  modelDigest: acceptedDigest(),
                };
                await this._serializeFenceWrite(async () => {
                  assertActive();
                  const current = await getStorage(['nativeOperationFence']);
                  assertActive();
                  if (current.nativeOperationFence !== undefined) {
                    throw new NativeModelError('recovery_required', this._recoveryStatus().message, 'uncertain');
                  }
                  // Once set starts, a partial persistence failure is treated
                  // conservatively; only proved pre-submission cleanup is safe.
                  fenceWritten = true;
                  // Snapshot readers must recognize this worker's active
                  // lease even between persistence and readback awaits.
                  this._activeOperationId = operationId;
                  await setStorage({ nativeOperationFence: fence });
                  const verified = await getStorage(['nativeOperationFence']);
                  if (!sameFence(verified.nativeOperationFence, operationId)) {
                    throw new NativeModelError('storage_failed', 'Could not persist the native operation fence.');
                  }
                });
                assertActive();
              },
              assertCanSubmit: () => { assertActive(); submitted = true; },
              onTerminal: async () => {
                await this._clearOwnedFence(operationId);
                fenceWritten = false;
                if (this._activeOperationId === operationId) this._activeOperationId = null;
              },
            });
            assertActive();
            this._readiness = this._readiness ? { ...this._readiness, resident: true } : this._readiness;
            await this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' });
            assertActive();
            return result;
          } catch (error) {
            if (!submitted && fenceWritten) {
              // The backend did not pass its final beforeSubmit hook, so no
              // fetch can exist for this id. This is not uncertain cancellation.
              try { await this._clearOwnedFence(operationId); } catch { /* retain the durable fence */ }
            }
            if (this._activeOperationId === operationId) this._activeOperationId = null;
            const nativeError = error instanceof NativeModelError ? error : null;
            // Caller ownership expiry is cancellation, not a native model
            // fault. The finite response above still settles its own fence.
            if (callerRetired) throw error;
            if (nativeError?.reason === 'inference_preempted' || (error instanceof Error && error.message === MODEL_MAINTENANCE_ERROR)) throw error;
            if (nativeError?.submission === 'uncertain' || (submitted && fenceWritten)) {
              this._retryRequired = true;
              // The caller's transport deadline must not wait for cleanup or a
              // delayed storage/status write. The durable fence already exists.
              void this.updateStatus(this._recoveryStatus()).catch(() => undefined);
            } else {
              await this.reportFailure(error);
            }
            throw error;
          }
        },
      };
      try { return await operation(lease); } finally { leaseOpen = false; }
    }, { priority });
  }

  private _serializeFenceWrite<T>(fn: () => Promise<T>): Promise<T> {
    const write = this._fenceWriteChain.catch(() => undefined).then(fn);
    this._fenceWriteChain = write.then(() => undefined, () => undefined);
    return write;
  }

  private async _clearOwnedFence(operationId: string): Promise<void> {
    await this._serializeFenceWrite(async () => {
      const current = await getStorage(['nativeOperationFence']);
      if (!sameFence(current.nativeOperationFence, operationId)) {
        throw new NativeModelError('recovery_required', 'The native operation fence changed. Filtering remains paused.', 'uncertain');
      }
      await removeStorage('nativeOperationFence');
      const verified = await getStorage(['nativeOperationFence']);
      if (verified.nativeOperationFence !== undefined) {
        throw new NativeModelError('storage_failed', 'Could not settle the native operation fence.', 'uncertain');
      }
    });
  }

  preempt(): void {
    this._epoch++;
    inferenceQueue.clear();
    // Active HTTP work drains until its terminal response/deadline. Aborting
    // would not prove native compute stopped and could create overlapping work.
  }
  clearQueue(): void { inferenceQueue.clear(); }
  drainQueue<T>(fn: () => Promise<T>): Promise<T> { return inferenceQueue.drain(fn); }

  async runMaintenance<T>(fn: () => Promise<T>, prepare?: () => void): Promise<T> {
    if (this._maintenance) throw new Error(MODEL_MAINTENANCE_ERROR);
    this._maintenance = true;
    this._maintenanceGeneration++;
    this.preempt();
    try { prepare?.(); return await this.drainQueue(fn); } finally { this._maintenance = false; }
  }

  teardown(): void {
    this.preempt();
    this._readiness = null;
    // Never delete a fence, unload a runner, or alter shared retention here.
  }

  async updateStatus(status: StatusUpdate): Promise<LocalModelStatus> {
    const write = this._statusWriteChain.catch(() => undefined).then(async () => {
      const data = await getStorage(['nativeModelStatus']);
      return this._writeStatus(status, data.nativeModelStatus);
    });
    this._statusWriteChain = write.then(() => undefined, () => undefined);
    return write;
  }

  private async _writeStatus(status: StatusUpdate, previous?: LocalModelStatus): Promise<LocalModelStatus> {
    if (previous && previous.state === status.state && previous.message === status.message
        && previous.reason === status.reason && previous.recoveryQualified === status.recoveryQualified) return previous;
    const revision = previous && Number.isSafeInteger(previous.revision) && previous.revision >= 0 ? previous.revision + 1 : 1;
    const next = { ...status, revision };
    await setStorage({ nativeModelStatus: next });
    return next;
  }

  async reportFailure(error: unknown): Promise<void> {
    const status = nativeFailureStatus(error);
    if ((status.state === 'error' && status.reason !== 'service_unreachable')
        || ['recovery_required', 'blocked', 'missing_model'].includes(status.state)) this._retryRequired = true;
    await this.updateStatus(status.state === 'recovery_required' ? this._recoveryStatus() : status);
  }

  async markTerminalError(modelId: string, error: string): Promise<void> {
    assertFixedModel(modelId);
    this._retryRequired = true;
    const status = await this.getStatus();
    if (['blocked', 'paused', 'recovery_required', 'not_connected', 'missing_model'].includes(status.state)) return;
    await this.updateStatus({ state: 'error', message: error, reason: 'response_invalid' });
  }
}

export const localEngine = new LocalEngine();

export async function callLocalInference(
  postData: EvaluationPostData,
  bannedCategories: string[],
  modelConfig: LocalModelDef | null = PRIMARY_LOCAL_MODEL,
  modelId = PRIMARY_LOCAL_MODEL_ID,
  { priority = 0, onInferenceStart, promptMode = 'baseline', assertCurrent }: {
    priority?: number; onInferenceStart?: () => void; promptMode?: LocalPromptMode; assertCurrent?: () => void;
  } = {},
): Promise<{
  shouldHide: boolean; reasoning: string; category: string | null; matches: string[];
  rawResponse: string; inferenceTime: number; malformed: boolean; classifierFingerprint: string;
}> {
  assertCurrent?.();
  assertFixedModel(modelId);
  if (modelConfig && modelConfig.name !== PRIMARY_LOCAL_MODEL_ID) {
    throw new NativeModelError('model_identity_changed', 'The native classifier configuration changed.');
  }
  if (!postData.text.trim() || bannedCategories.length === 0
      || bannedCategories.some(category => typeof category !== 'string' || !category.trim())) {
    throw new NativeModelError('input_budget', 'A real post and nonempty filter phrases are required.');
  }
  const epoch = localEngine.operationEpoch;
  await localEngine.ensureLoaded(modelId);
  assertCurrent?.();
  localEngine.assertOperationEpoch(epoch);
  const empty = buildNativeTableYesnoRequest('', bannedCategories, promptMode);
  const overhead = Math.ceil(empty.messages.map(message => message.content).join('\n').length / 3);
  const budget = NATIVE_CONTEXT_TOKENS - overhead - empty.maxOutputTokens;
  if (budget <= 0) throw new NativeModelError('input_budget', 'The filter phrases exceed the native input budget.');
  let inferenceStart = Date.now();
  const rawResponse = await localEngine.runInferenceOperation(async lease => {
    const postText = await lease.truncateText(postData.text, budget);
    onInferenceStart?.();
    inferenceStart = Date.now();
    const request = buildNativeTableYesnoRequest(postText, bannedCategories, promptMode);
    return lease.generate(request.messages, request.maxOutputTokens);
  }, { priority, assertCurrent });
  assertCurrent?.();
  const parsed = parseTableYesnoResponse(rawResponse, bannedCategories);
  if (parsed.malformed && priority === 0) {
    await localEngine.reportFailure(new NativeModelError('response_invalid', 'The classifier returned malformed verdicts. Retry from the popup.', 'terminal'));
  }
  assertCurrent?.();
  return {
    ...parsed,
    // Persistent diagnostics never contain malformed model output.
    reasoning: parsed.malformed ? 'Malformed classifier response' : parsed.reasoning,
    category: parsed.matches.length > 0 ? parsed.matches.join(', ') : null,
    rawResponse,
    inferenceTime: (Date.now() - inferenceStart) / 1000,
    classifierFingerprint: NATIVE_CLASSIFIER_FINGERPRINT,
  };
}
