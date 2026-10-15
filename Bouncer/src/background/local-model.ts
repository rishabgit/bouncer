// Two fixed local engines share one serial operation lease and cancellation epoch.
// The native content-free unresolved-work fence applies to either engine.
import type {
  ChatMessage,
  EvaluationPostData,
  EngineSelection,
  InferenceEngineId,
  LocalModelDef,
  LocalModelStatus,
  NativeOperationFence,
} from '../types';
import {
  CONCURRENT_NATIVE_MODELS_QUALIFIED,
  classifierFingerprintForEngine,
  isInferenceEngine,
  modelForEngine,
  OPERATOR_RESTART_RECOVERY_QUALIFIED,
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
import { buildNativeTableYesnoRequest, buildTableYesnoRequest } from '../shared/table-yesno-request';
import { getStorage, removeStorage, setStorage } from '../shared/storage';
import { inferenceQueue } from './inference-queue';
import { BrowserModelError, type BrowserBackend, type LocalBackend, type NativeReadiness } from './backends/types';
import { OllamaBackend } from './backends/ollama-backend';
import { LitertlmBackend } from './backends/litertlm-backend';

export { parseTableYesnoResponse } from '../shared/table-yesno';
export const MODEL_MAINTENANCE_ERROR = 'Local model maintenance in progress';

type StatusUpdate = Omit<LocalModelStatus, 'revision'>;
export interface InferenceBackendLease {
  countTokens(text: string): Promise<number>;
  truncateText(text: string, maxTokens: number): Promise<string>;
  generate(messages: ChatMessage[], maxTokens: number): Promise<string>;
}

/** Setup availability is expected and must not consume the inference retry budget. */
export class LocalAvailabilityError extends Error {
  constructor(public readonly reason: 'not_configured' | 'needs_download' | 'downloading' | 'switching' | 'browser_cancelled', message: string) {
    super(message);
    this.name = 'LocalAvailabilityError';
  }
}

const BROWSER_IDLE_MS = 60_000;
const BROWSER_KEEPALIVE_MS = 5_000;
const BROWSER_CLEANUP_MS = 3_000;
const BROWSER_INFERENCE_MS = 90_000;

function validSelection(value: unknown): value is EngineSelection {
  const selection = record(value);
  return (selection.engine === null || isInferenceEngine(selection.engine))
    && Number.isSafeInteger(selection.revision) && (selection.revision as number) >= 0;
}

function sameSelection(one: EngineSelection, two: EngineSelection): boolean {
  return one.engine === two.engine && one.revision === two.revision;
}

function sameFence(value: unknown, operationId: string): boolean {
  const fence = record(value);
  return operationId.length > 0 && fence.operationId === operationId
    && fence.schemaVersion === 1
    && Number.isSafeInteger(fence.epoch) && (fence.epoch as number) >= 0
    && Number.isSafeInteger(fence.startedAt) && (fence.startedAt as number) >= 0
    && typeof fence.modelDigest === 'string' && /^[a-f0-9]{64}$/.test(fence.modelDigest)
    && Object.keys(fence).sort().join(',') === 'epoch,modelDigest,operationId,schemaVersion,startedAt';
}

export class LocalEngine {
  private readonly _backend: LocalBackend;
  private readonly _browser: BrowserBackend;
  private _selection: EngineSelection;
  private readonly _injectedNativeDefault: boolean;
  private _selectionChain: Promise<void> = Promise.resolve();
  private _pendingSelections = 0;
  private _selectionBlocked = false;
  private _browserRetryRequired = false;
  private _browserLoaded = false;
  private _browserResidentOwned = false;
  private _browserDiscoveredDownloading = false;
  private _browserDiscoveredInitializing = false;
  private _browserLifecycleGeneration = 0;
  private _browserCleanupFailureGeneration: number | null = null;
  private _browserReconcilePromise: Promise<void> | null = null;
  private _browserPins = 0;
  private _browserSetup: {
    kind: 'download' | 'initialize'; controller: AbortController;
    promise: Promise<void>; selection: EngineSelection;
  } | null = null;
  private _browserActive: Promise<unknown> | null = null;
  private _browserMaintenance = 0;
  private _browserStopPromise: Promise<void> | null = null;
  private _browserIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private _browserKeepalive: ReturnType<typeof setInterval> | null = null;
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

  constructor(backend?: LocalBackend, browser: BrowserBackend = new LitertlmBackend()) {
    this._backend = backend ?? new OllamaBackend();
    this._browser = browser;
    // Existing driver tests explicitly inject native. Production has no default
    // preference; startup loads the migration's verified explicit selection.
    this._injectedNativeDefault = backend !== undefined;
    this._selection = { engine: backend ? 'ollama' : null, revision: 0 };
  }

  getSelection(): EngineSelection { return { ...this._selection }; }
  isSelectingEngine(): boolean { return this._pendingSelections > 0; }
  getSelectedModel(): LocalModelDef | null {
    return this._selection.engine ? modelForEngine(this._selection.engine) : null;
  }
  getClassifierFingerprint(): string | null {
    return this._selection.engine ? classifierFingerprintForEngine(this._selection.engine) : null;
  }

  private _assertSelection(snapshot: EngineSelection): void {
    if (!sameSelection(snapshot, this._selection) || this._pendingSelections || this._selectionBlocked) {
      throw new NativeModelError('inference_preempted', 'Inference preempted');
    }
  }

  private async _assertPersistedSelection(selection: EngineSelection): Promise<void> {
    const data = await getStorage(['engineSelection']);
    if (validSelection(data.engineSelection)) {
      if (!sameSelection(selection, data.engineSelection)) throw new NativeModelError('inference_preempted', 'The saved engine choice changed. Reopen Bouncer before filtering.');
    } else if (!this._injectedNativeDefault || selection.revision > 0) {
      throw new NativeModelError('inference_preempted', 'The saved engine choice is unavailable. Reopen Bouncer before filtering.');
    }
  }

  private _assertModel(modelId: string | undefined, selection = this._selection): void {
    if (modelId !== undefined && (!selection.engine || modelId !== modelForEngine(selection.engine).name)) {
      throw new NativeModelError('model_identity_changed', 'Bouncer supports only the selected fixed local classifier.');
    }
  }

  /** Retire ownership at receipt; choice persistence precedes physical setup. */
  selectEngine(engine: InferenceEngineId): Promise<LocalModelStatus> {
    if (!isInferenceEngine(engine)) return Promise.reject(new NativeModelError('model_identity_changed', 'Choose one of Bouncer’s two local engines.'));
    this._pendingSelections++;
    // Engine choice owns download retirement; ordinary inference preemption
    // cannot cancel the separate cache-only transfer requested by the user.
    if (this._browserSetup?.kind === 'download') this._browserSetup.controller.abort();
    this.preempt();
    const requestEpoch = this._epoch;
    const transition = this._selectionChain.catch(() => undefined).then(async () => {
      const previous = await getStorage(['engineSelection']);
      const revision = Math.max(this._selection.revision, validSelection(previous.engineSelection) ? previous.engineSelection.revision : 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new NativeModelError('storage_failed', 'Could not save the engine choice.');
      const selection: EngineSelection = { engine, revision };
      try {
        await setStorage({ engineSelection: selection });
        const verified = await getStorage(['engineSelection']);
        if (!validSelection(verified.engineSelection) || !sameSelection(selection, verified.engineSelection)) {
          throw new NativeModelError('storage_failed', 'Could not verify the saved engine choice.');
        }
        this._selection = selection;
        this._selectionBlocked = false;
      } catch (error) {
        this._selectionBlocked = true;
        throw error;
      }
      await this.updateStatus({ state: 'switching', message: 'Switching local engine…' }, selection);
      // Closing browser resources never changes shared Ollama residency or its
      // fence. Native HTTP is allowed to settle naturally through the queue.
      await this._stopBrowserOwned();
      await this.drainQueue(() => Promise.resolve());
      if (requestEpoch === this._epoch) {
        this._readiness = null;
      }
      return selection;
    });
    this._selectionChain = transition.then(() => undefined, () => undefined);
    return transition.then(async selection => {
      this._pendingSelections--;
      return this._snapshotStatus(selection);
    }, error => {
      this._pendingSelections--;
      throw error;
    });
  }

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

  private _browserCleanupStatus(): StatusUpdate {
    return { state: 'error', reason: 'browser_cleanup_failed', message: 'Browser AI cleanup failed. Retry to finish releasing it.' };
  }

  /** Popup/status reads never acquire a host, GPU, weights or native metadata. */
  getStatus(): Promise<LocalModelStatus> { return this._snapshotStatus(this.getSelection()); }

  private _snapshotStatus(selection: EngineSelection): Promise<LocalModelStatus> {
    const snapshot = this._statusWriteChain.catch(() => undefined).then(async () => {
      const data = await getStorage(['nativeModelStatus', 'browserModelStatus', 'localModelStatus', 'nativeOperationFence']);
      // Unresolved native work is a global block, even without permission or a
      // selected engine. Malformed persisted values are equally unresolved.
      if (data.nativeOperationFence !== undefined
          && !sameFence(data.nativeOperationFence, this._activeOperationId ?? '')) {
        this._retryRequired = true;
        return this._writeStatus(this._recoveryStatus(), selection, data);
      }
      if (this._selectionBlocked) {
        return this._writeStatus({ state: 'error', reason: 'storage_failed', message: 'Save the engine choice again before filtering.' }, selection, data);
      }
      if (this._browserCleanupFailureGeneration !== null) {
        return this._writeStatus(selection.engine === 'ollama'
          ? data.nativeModelStatus ?? { state: 'not_connected', message: 'Connect to Ollama' }
          : this._browserCleanupStatus(), selection, data);
      }
      if (!selection.engine) {
        return this._writeStatus({ state: 'not_configured', reason: 'not_configured', message: 'Choose where Bouncer should run.' }, selection, data);
      }
      if (this._pendingSelections && sameSelection(selection, this._selection)) {
        return this._writeStatus({ state: 'switching', message: 'Switching local engine…' }, selection, data);
      }
      if (selection.engine === 'litertlm') {
        let state: Awaited<ReturnType<BrowserBackend['getState']>>;
        const lifecycle = this._browserLifecycleGeneration;
        const setup = this._browserSetup;
        try {
          state = await this._browser.getState();
          if (this._browserDiscoveredDownloading && !this._browserSetup && !state.downloading
              && sameSelection(selection, this._selection) && !this._pendingSelections) {
            await this._stopBrowserOwned();
            state = await this._browser.getState();
          }
        } catch (error) {
          if (lifecycle !== this._browserLifecycleGeneration || !sameSelection(selection, this._selection)
              || this._pendingSelections || this._browserStopPromise || this._browserSetup?.controller.signal.aborted
              || (setup?.kind === 'initialize' && this._browserSetup === setup && sameSelection(setup.selection, selection))) {
            return this._statusAfterRetiredBrowserRead();
          }
          const failure = this._browserFailureStatus(error);
          this._browserRetryRequired = failure.state === 'error' || failure.state === 'blocked';
          return this._writeStatus(failure, selection, data);
        }
        if (sameSelection(selection, this._selection) && !this._pendingSelections
            && !this._browserStopPromise && lifecycle === this._browserLifecycleGeneration) this._recordBrowserState(state);
        const previous = data.browserModelStatus;
        if (previous?.state === 'error' || previous?.state === 'blocked'
            || (previous?.state === 'paused' && previous.reason === 'browser_cancelled')) {
          this._browserRetryRequired = true;
          return this._writeStatus(previous, selection, data);
        }
        if (state.initializing || (this._browserSetup?.kind === 'initialize' && sameSelection(this._browserSetup.selection, selection))) {
          return this._writeStatus({ state: 'loading', message: 'Loading browser AI…', ...this._progressFields(state) }, selection, data);
        }
        const status: StatusUpdate = state.downloading
          ? { state: 'downloading', message: 'Downloading browser AI…', ...this._progressFields(state) }
          : state.cached ? { state: this._browserPins && state.loaded ? 'filtering' : 'ready', message: this._browserPins && state.loaded ? 'Filtering' : 'Ready — loads when needed' }
            : { state: 'needs_download', reason: 'needs_download', message: 'Download the browser model to start filtering.' };
        this._updateBrowserTimers(false);
        return this._writeStatus(status, selection, data);
      }
      let permitted = false;
      try { permitted = await chrome.permissions.contains({ origins: [OLLAMA_HOST_PERMISSION] }); } catch { /* fail closed */ }
      if (!permitted) {
        return this._writeStatus({ state: 'not_connected', message: 'Connect to Ollama to allow local filtering.', reason: 'permission_required' }, selection, data);
      }
      const status = data.nativeModelStatus;
      if (status && typeof status.revision === 'number') {
        if ((status.state === 'error' && status.reason !== 'service_unreachable')
            || ['recovery_required', 'blocked', 'missing_model'].includes(status.state)) this._retryRequired = true;
        if ((status.state === 'loading' || status.state === 'filtering') && !this._activeOperationId) {
          return this._writeStatus({ state: 'ready', message: 'Ready — loads when needed' }, selection, data);
        }
        return this._writeStatus(status, selection, data);
      }
      return this._writeStatus({ state: 'not_connected', message: 'Connect to Ollama' }, selection, data);
    });
    this._statusWriteChain = snapshot.then(() => undefined, () => undefined);
    return snapshot;
  }

  /** Read current facts directly; re-entering getStatus would wait on this read. */
  private async _statusAfterRetiredBrowserRead(): Promise<LocalModelStatus> {
    const data = await getStorage(['nativeModelStatus', 'browserModelStatus', 'localModelStatus', 'nativeOperationFence']);
    const selection = this.getSelection();
    let status: StatusUpdate;
    if (this._selectionBlocked) {
      status = { state: 'error', reason: 'storage_failed', message: 'Save the engine choice again before filtering.' };
    } else if (!selection.engine) {
      status = { state: 'not_configured', reason: 'not_configured', message: 'Choose where Bouncer should run.' };
    } else if (this._pendingSelections) {
      status = { state: 'switching', message: 'Switching local engine…' };
    } else if (selection.engine === 'ollama') {
      status = data.nativeModelStatus ?? { state: 'not_connected', message: 'Connect to Ollama' };
    } else if (this._browserMaintenance || this._browserSetup?.controller.signal.aborted) {
      status = { state: 'canceling', message: 'Finishing browser cleanup…' };
    } else if (data.browserModelStatus?.state === 'error' || data.browserModelStatus?.state === 'blocked'
        || (data.browserModelStatus?.state === 'paused' && data.browserModelStatus.reason === 'browser_cancelled')) {
      status = data.browserModelStatus;
    } else if (this._browserRetryRequired) {
      status = this._browserFailureStatus(new BrowserModelError('browser_failed', 'Browser AI requires Retry.'));
    } else if (this._browserLoaded) {
      status = { state: this._browserPins ? 'filtering' : 'ready', message: this._browserPins ? 'Filtering' : 'Ready — loads when needed' };
    } else if (this._browserDiscoveredDownloading) {
      status = { state: 'downloading', message: 'Downloading browser AI…' };
    } else if (this._browserDiscoveredInitializing || this._browserSetup?.kind === 'initialize') {
      status = { state: 'loading', message: 'Loading browser AI…' };
    } else {
      status = data.browserModelStatus ?? { state: 'needs_download', reason: 'needs_download', message: 'Download the browser model to start filtering.' };
    }
    // The normal writer preserves a global native recovery block. No fault or
    // physical ownership is inferred from the retired metadata failure.
    return this._writeStatus(status, selection, data);
  }

  async syncAllStatuses(): Promise<void> {
    const data = await getStorage(['engineSelection', 'engineChoiceSchemaVersion', 'browserModelStatus']);
    if (validSelection(data.engineSelection)) this._selection = { ...data.engineSelection };
    else if (!this._injectedNativeDefault || data.engineChoiceSchemaVersion !== undefined) this._selection = { engine: null, revision: 0 };
    if (data.browserModelStatus?.state === 'error' && data.browserModelStatus.reason === 'browser_cleanup_failed') {
      // Worker recreation is not permission to resume or retry the host whose
      // physical cleanup failed. The persisted resource record owns this block.
      this._browserCleanupFailureGeneration = this._browserLifecycleGeneration;
      this._browserRetryRequired = true;
      this._updateBrowserTimers(false);
    }
    if (this._selection.engine && this._browserCleanupFailureGeneration === null) {
      try {
        const state = await this._browser.getState();
        this._recordBrowserState(state);
        // Recreated workers cannot own the old GPU request or initializer.
        // Prove it stopped before replacement use; cache-only downloads may
        // continue when Browser remains selected and are reconciled below.
        if (this._selection.engine === 'ollama' || state.loaded || state.initializing) await this._stopBrowserOwned();
        else this._updateBrowserTimers(false);
      } catch {
        const selection = this.getSelection();
        const lifecycle = this._browserLifecycleGeneration;
        try {
          await this._browser.forceClose();
          this._clearBrowserPhysicalState();
          this._updateBrowserTimers();
        } catch {
          // Startup remains usable for manual controls and explicit Retry even
          // when a recreated worker cannot prove the inherited host stopped.
          this._markBrowserCleanupFailure(lifecycle, selection);
        }
      }
    }
    await this.getStatus();
  }

  /** Retry never clears a native fence and never downloads browser weights. */
  async retry(): Promise<LocalModelStatus> {
    const selection = this.getSelection();
    const status = await this.getStatus();
    if (!selection.engine || this._pendingSelections) return status;
    if (status.state === 'recovery_required') {
      const pending = await getStorage(['nativeOperationFence']);
      if (pending.nativeOperationFence !== undefined) return status;
    }
    const epoch = this._epoch;
    const maintenance = this._maintenanceGeneration;
    this._assertMaintenanceGeneration(maintenance);
    let cleanupCompleted = false;
    if (this._browserCleanupFailureGeneration !== null) {
      try { await this._stopBrowserOwned(); } catch { return this.getStatus(); }
      this._assertMaintenanceGeneration(maintenance);
      this.assertOperationEpoch(epoch);
      this._assertSelection(selection);
      await this._assertPersistedSelection(selection);
      cleanupCompleted = true;
    }
    if (selection.engine === 'litertlm') {
      if (this._browserPins || this._browserSetup || this._browserDiscoveredDownloading) return status;
      if (this._browserStopPromise || this._browserDiscoveredInitializing || (this._browserLoaded && !this._browserResidentOwned)) {
        await this._stopBrowserOwned();
        this.assertOperationEpoch(epoch);
        this._assertSelection(selection);
        await this._assertPersistedSelection(selection);
      }
      if (!cleanupCompleted && (status.state === 'error' || status.state === 'blocked')) {
        await this._browser.forceClose();
        this._clearBrowserPhysicalState();
      }
      this._browserRetryRequired = false;
      await this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' }, selection);
      try {
        const state = await this._browser.getState();
        this.assertOperationEpoch(epoch);
        this._assertSelection(selection);
        if (!state.cached) return this.updateStatus({ state: 'needs_download', reason: 'needs_download', message: 'Download the browser model to start filtering.' }, selection);
        // Browser Retry checks capability on the next real operation, preserving
        // the no-prewarm contract and the current downloaded artifact.
        return this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' }, selection);
      } catch (error) {
        if (this._isRetired(error)) throw error;
        await this.reportFailure(error, selection);
        return this.getStatus();
      }
    }
    if (this._activeOperationId) return status;
    try {
      await this._checkReadiness(true);
      this._assertMaintenanceGeneration(maintenance);
      this.assertOperationEpoch(epoch);
      this._assertSelection(selection);
      const data = await getStorage(['nativeOperationFence']);
      this.assertOperationEpoch(epoch);
      if (data.nativeOperationFence !== undefined) {
        this._retryRequired = true;
        return this.updateStatus(this._recoveryStatus(), selection);
      }
      this._retryRequired = false;
      return this._publishReadiness(selection);
    } catch (error) {
      if (this._isRetired(error)) throw error;
      await this.reportFailure(error, selection);
      return this.getStatus();
    }
  }

  async ensureLoaded(modelId?: string, snapshot = this.getSelection()): Promise<void> {
    this._assertModel(modelId, snapshot);
    const epoch = this._epoch;
    const maintenance = this._maintenanceGeneration;
    this._assertMaintenanceGeneration(maintenance);
    if (!snapshot.engine) throw new LocalAvailabilityError('not_configured', 'Choose where Bouncer should run.');
    if (this._pendingSelections || (snapshot.engine === 'litertlm' && this._browserMaintenance)) throw new LocalAvailabilityError('switching', 'Switching local engine…');
    this._assertSelection(snapshot);
    if (snapshot.engine === 'litertlm' && this._browserStopPromise) {
      await this._browserStopPromise;
      this._assertMaintenanceGeneration(maintenance);
      this.assertOperationEpoch(epoch);
      this._assertSelection(snapshot);
    }
    await this._assertPersistedSelection(snapshot);
    this.assertOperationEpoch(epoch);
    let status = await this.getStatus();
    this._assertMaintenanceGeneration(maintenance);
    this.assertOperationEpoch(epoch);
    this._assertSelection(snapshot);
    if (status.state === 'recovery_required') throw new NativeModelError('recovery_required', status.message, 'uncertain');
    if (this._browserCleanupFailureGeneration !== null) throw new BrowserModelError('browser_failed', this._browserCleanupStatus().message);
    if (snapshot.engine === 'litertlm') {
      if ((this._browserDiscoveredInitializing || (this._browserLoaded && !this._browserResidentOwned)) && !this._browserSetup) {
        await this._stopBrowserOwned();
        this._assertMaintenanceGeneration(maintenance);
        this.assertOperationEpoch(epoch);
        this._assertSelection(snapshot);
        await this._assertPersistedSelection(snapshot);
        status = await this.getStatus();
        this.assertOperationEpoch(epoch);
        this._assertSelection(snapshot);
      }
      if (status.state === 'paused' && status.reason === 'browser_cancelled') throw new LocalAvailabilityError('browser_cancelled', status.message);
      if (status.state === 'needs_download') throw new LocalAvailabilityError('needs_download', status.message);
      if (status.state === 'downloading' || status.state === 'canceling') throw new LocalAvailabilityError('downloading', status.message);
      if (this._browserRetryRequired) throw new NativeModelError('response_invalid', 'Retry from the Bouncer popup before browser filtering resumes.');
      await this._initializeBrowser(snapshot, epoch);
      this.assertOperationEpoch(epoch);
      this._assertSelection(snapshot);
      return;
    }
    if (status.state === 'not_connected' && status.reason === 'permission_required') throw new NativeModelError('permission_required', status.message);
    if (this._retryRequired) throw new NativeModelError('response_invalid', 'Retry from the Bouncer popup before filtering resumes.');
    if (!this._readiness) {
      try {
        await this._checkReadiness(false);
        this._assertMaintenanceGeneration(maintenance);
        this.assertOperationEpoch(epoch);
        this._assertSelection(snapshot);
        await this._publishReadiness(snapshot);
      } catch (error) {
        if (!this._isRetired(error)) await this.reportFailure(error, snapshot);
        throw error;
      }
    }
  }

  private _isRetired(error: unknown): boolean {
    return error instanceof LocalAvailabilityError
      || (error instanceof BrowserModelError && error.reason === 'browser_cancelled')
      || (error instanceof NativeModelError && error.reason === 'inference_preempted')
      || (error instanceof Error && error.message === MODEL_MAINTENANCE_ERROR);
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

  private async _publishReadiness(selection = this.getSelection()): Promise<LocalModelStatus> {
    if (this._readiness?.otherModelResident && !CONCURRENT_NATIVE_MODELS_QUALIFIED) {
      return this.updateStatus({ state: 'paused', message: 'Filtering paused while another local model is loaded.', reason: 'other_model_resident' }, selection);
    }
    return this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' }, selection);
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
        return this._publishAfterRecovery();
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
      return this._publishAfterRecovery();
    });
  }

  private async _publishAfterRecovery(): Promise<LocalModelStatus> {
    const selection = this.getSelection();
    if (selection.engine === 'ollama') return this._publishReadiness(selection);
    // Recovery metadata belongs to native; selected browser status is derived
    // from browser state without GPU initialization or preference changes.
    await this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' }, { engine: 'ollama', revision: selection.revision });
    return this.getStatus();
  }

  private _progressFields(progress: Pick<LocalModelStatus, 'progress' | 'receivedBytes' | 'totalBytes'>): Pick<LocalModelStatus, 'progress' | 'receivedBytes' | 'totalBytes'> {
    return {
      ...(Number.isFinite(progress.progress) ? { progress: progress.progress } : {}),
      ...(Number.isFinite(progress.receivedBytes) ? { receivedBytes: progress.receivedBytes } : {}),
      ...(Number.isFinite(progress.totalBytes) ? { totalBytes: progress.totalBytes } : {}),
    };
  }

  private _recordBrowserState(state: Awaited<ReturnType<BrowserBackend['getState']>>): void {
    this._browserLoaded = state.loaded;
    if (!state.loaded) this._browserResidentOwned = false;
    this._browserDiscoveredDownloading = state.downloading;
    this._browserDiscoveredInitializing = state.initializing;
  }

  private _clearBrowserPhysicalState(): void {
    // Retire metadata reads captured before proved physical cleanup. A late
    // snapshot must not restore residency or an initializer that has stopped.
    const cleanupFailed = this._browserCleanupFailureGeneration !== null;
    this._browserLifecycleGeneration++;
    this._browserCleanupFailureGeneration = null;
    this._browserLoaded = false;
    this._browserResidentOwned = false;
    this._browserDiscoveredDownloading = false;
    this._browserDiscoveredInitializing = false;
    if (cleanupFailed || this._browserRetryRequired) this._retireBrowserCleanupFailure(this._browserLifecycleGeneration, this.getSelection());
  }

  private _retireBrowserCleanupFailure(lifecycle: number, selection: EngineSelection): void {
    const current = (): boolean => lifecycle === this._browserLifecycleGeneration
      && this._browserCleanupFailureGeneration === null && sameSelection(selection, this._selection);
    const retire = this._statusWriteChain.catch(() => undefined).then(async () => {
      if (!current()) return;
      const data = await getStorage(['nativeModelStatus', 'browserModelStatus', 'localModelStatus', 'nativeOperationFence']);
      // Proved physical cleanup does not retire classifier or capability faults.
      if (!current() || data.browserModelStatus?.reason !== 'browser_cleanup_failed') return;
      let status: StatusUpdate;
      try {
        const state = await this._browser.getState();
        status = state.cached ? { state: 'ready', message: 'Ready — loads when needed' }
          : { state: 'needs_download', reason: 'needs_download', message: 'Download the browser model to start filtering.' };
      } catch (error) { status = this._browserFailureStatus(error); }
      if (!current()) return;
      this._browserRetryRequired = status.state === 'error' || status.state === 'blocked';
      await this._writeStatus(status, { engine: 'litertlm', revision: selection.revision }, data);
    });
    // Cleanup can be awaited by a status snapshot, so resource retirement must
    // queue behind that snapshot rather than waiting recursively on its chain.
    this._statusWriteChain = retire.then(() => undefined, () => undefined);
  }

  /** Only a download inherited from a retired worker needs bounded state reads. */
  private _reconcileInheritedDownload(): Promise<void> {
    if (this._browserReconcilePromise) return this._browserReconcilePromise;
    const selection = this.getSelection();
    const lifecycle = this._browserLifecycleGeneration;
    const reconcile = (async () => {
      try {
        const state = await this._browser.getState();
        if (this._browserLifecycleGeneration !== lifecycle || this._pendingSelections
            || !sameSelection(selection, this._selection) || this._browserSetup || this._browserStopPromise) return;
        if (state.downloading) {
          this._recordBrowserState(state);
          await this.updateStatus({ state: 'downloading', message: 'Downloading browser AI…', ...this._progressFields(state) }, selection);
        } else {
          // Keep the observed-work flag through creation of the cleanup barrier.
          // Closing the inherited host also prevents an orphan initializer from
          // becoming resident after this worker has accepted new operations.
          await this._stopBrowserOwned();
          this._assertSelection(selection);
          await this.updateStatus(state.cached
            ? { state: 'ready', message: 'Ready — loads when needed' }
            : { state: 'needs_download', reason: 'needs_download', message: 'Download the browser model to start filtering.' }, selection);
        }
      } catch (error) {
        if (this._browserLifecycleGeneration === lifecycle && !this._pendingSelections
            && sameSelection(selection, this._selection) && !this._isRetired(error)) {
          try { await this._browser.forceClose(); } catch {
            if (!this._pendingSelections) this._markBrowserCleanupFailure(lifecycle, selection);
            return;
          }
          if (this._browserLifecycleGeneration !== lifecycle || this._pendingSelections || !sameSelection(selection, this._selection)) return;
          this._clearBrowserPhysicalState();
          await this.reportFailure(error, selection);
        }
      } finally { this._updateBrowserTimers(false); }
    })();
    this._browserReconcilePromise = reconcile;
    return reconcile.finally(() => { if (this._browserReconcilePromise === reconcile) this._browserReconcilePromise = null; });
  }

  private _updateBrowserTimers(resetIdle = true): void {
    const cleanupFailed = this._browserCleanupFailureGeneration !== null;
    const busy = (!cleanupFailed && (this._browserLoaded || this._browserDiscoveredDownloading || this._browserDiscoveredInitializing))
      || !!(this._browserSetup && !this._browserSetup.controller.signal.aborted) || !!this._browserActive || this._browserPins > 0;
    if (busy && !this._browserKeepalive) {
      this._browserKeepalive = setInterval(() => {
        // MV3 lifetime touch is read-only and only exists with browser work.
        void getStorage(['browserCacheGeneration']).catch(() => undefined);
        if (this._browserDiscoveredDownloading && !this._browserSetup && !this._browserStopPromise) {
          void this._reconcileInheritedDownload().catch(() => undefined);
        }
      }, BROWSER_KEEPALIVE_MS);
    } else if (!busy && this._browserKeepalive) {
      clearInterval(this._browserKeepalive);
      this._browserKeepalive = null;
    }
    if (this._browserIdleTimer && (resetIdle || cleanupFailed || !this._browserLoaded || this._browserSetup || this._browserDiscoveredDownloading || this._browserDiscoveredInitializing || this._browserPins > 0)) {
      clearTimeout(this._browserIdleTimer);
      this._browserIdleTimer = null;
    }
    if (!cleanupFailed && !this._browserIdleTimer && this._browserLoaded && !this._browserSetup && !this._browserDiscoveredDownloading && !this._browserDiscoveredInitializing && this._browserPins === 0) {
      const lifecycle = this._browserLifecycleGeneration;
      this._browserIdleTimer = setTimeout(() => {
        this._browserIdleTimer = null;
        if (lifecycle !== this._browserLifecycleGeneration || this._browserPins || this._browserSetup) return;
        void this._stopBrowserOwned().catch(() => undefined);
      }, BROWSER_IDLE_MS);
    }
  }

  private async _settleBrowser(pending: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = pending.then(() => true, () => true);
    const completed = await Promise.race([settled, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), BROWSER_CLEANUP_MS); })]);
    if (timer) clearTimeout(timer);
    if (!completed) await this._browser.forceClose();
    return completed;
  }

  private _stopBrowserOwned(): Promise<void> {
    const selection = this.getSelection();
    const stop = this._browserStopPromise ?? this._performBrowserStop();
    // _performBrowserStop retires the physical lifecycle before its first
    // await. Failure belongs to that operation, not the timer that armed it.
    const lifecycle = this._browserLifecycleGeneration;
    this._browserStopPromise = stop;
    return stop.catch(error => {
      this._markBrowserCleanupFailure(lifecycle, selection);
      throw error;
    }).finally(() => { if (this._browserStopPromise === stop) this._browserStopPromise = null; });
  }

  private _markBrowserCleanupFailure(lifecycle: number, selection: EngineSelection): void {
    const current = (): boolean => lifecycle === this._browserLifecycleGeneration && sameSelection(selection, this._selection);
    if (!current()) return;
    this._browserCleanupFailureGeneration = lifecycle;
    this._browserRetryRequired = true;
    // Keep the physical facts uncertain, but do not keep a failed idle cleanup
    // alive forever or schedule an automatic retry of a rejected owned close.
    this._updateBrowserTimers(false);
    const publish = this._statusWriteChain.catch(() => undefined).then(async () => {
      if (!current() || this._browserCleanupFailureGeneration !== lifecycle) return;
      const data = await getStorage(['nativeModelStatus', 'browserModelStatus', 'localModelStatus', 'nativeOperationFence']);
      if (!current() || this._browserCleanupFailureGeneration !== lifecycle) return;
      const resource = await this._writeStatus(this._browserCleanupStatus(), { engine: 'litertlm', revision: selection.revision }, data);
      if (selection.engine !== 'litertlm' && current() && this._browserCleanupFailureGeneration === lifecycle) {
        await this._writeStatus(data.nativeModelStatus ?? { state: 'not_connected', message: 'Connect to Ollama' }, selection, { ...data, browserModelStatus: resource });
      }
    });
    // Do not await this publication: a status snapshot may itself be awaiting
    // cleanup, and re-entering its write chain would wait on the same snapshot.
    this._statusWriteChain = publish.then(() => undefined, () => undefined);
  }

  private async _performBrowserStop(): Promise<void> {
    this._browserLifecycleGeneration++;
    const setup = this._browserSetup;
    setup?.controller.abort();
    const active = this._browserActive;
    const ownedResident = this._browserResidentOwned;
    let physical = this._browserLoaded || this._browserDiscoveredDownloading || this._browserDiscoveredInitializing;
    try {
      // A restarted worker has no promise/controller for the existing document.
      // This query adopts only an existing host; it cannot create or warm one.
      const state = await this._browser.getState();
      physical ||= state.loaded || state.downloading || state.initializing;
    } catch {
      // The driver captured any existing Chrome context even if its script or
      // cache cannot answer, so exact owned close remains possible.
      await this._browser.forceClose();
    }
    if (setup || active || ownedResident) {
      const settled = await this._settleBrowser(Promise.all([
        this._browser.interrupt(), ...(setup ? [setup.promise] : []), ...(active ? [active] : []),
      ]));
      if (settled) await this._settleBrowser(this._browser.unload());
      await this._browser.forceClose();
    } else if (physical || this._browserCleanupFailureGeneration !== null) {
      // No worker lease can prove an inherited operation settled. Owned host
      // closure retires its download generation and stops its GPU work.
      await this._browser.forceClose();
    }
    if (this._browserSetup === setup) this._browserSetup = null;
    this._clearBrowserPhysicalState();
    this._updateBrowserTimers();
  }

  private async _initializeBrowser(selection: EngineSelection, epoch: number): Promise<void> {
    if (this._browserStopPromise) {
      await this._browserStopPromise;
      this.assertOperationEpoch(epoch);
      this._assertSelection(selection);
      await this._assertPersistedSelection(selection);
    }
    if (this._browserLoaded) return;
    if (this._browserSetup) {
      if (this._browserSetup.kind === 'download') throw new LocalAvailabilityError('downloading', 'The browser model is downloading.');
      await this._browserSetup.promise;
      return;
    }
    const controller = new AbortController();
    const setup = { kind: 'initialize' as const, controller, promise: Promise.resolve(), selection };
    this._browserSetup = setup;
    this._updateBrowserTimers();
    setup.promise = (async () => {
      await this.updateStatus({ state: 'loading', message: 'Loading browser AI…' }, selection);
      this.assertOperationEpoch(epoch);
      this._assertSelection(selection);
      await this._browser.initialize(progress => {
        if (this._browserSetup !== setup || controller.signal.aborted || this._epoch !== epoch || !sameSelection(selection, this._selection)) return;
        void this.updateStatus({ state: 'loading', message: 'Loading browser AI…', ...this._progressFields(progress) }, selection).catch(() => undefined);
      }, controller.signal);
      this.assertOperationEpoch(epoch);
      this._assertSelection(selection);
      // Initialization may finish while a popup's host-state reply is pending.
      // The real transition owns residency and its idle timer, not that reply.
      this._browserLifecycleGeneration++;
      this._browserLoaded = true;
      this._browserResidentOwned = true;
      this._browserDiscoveredInitializing = false;
      await this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' }, selection);
    })().catch(async error => {
      // Close directly: the general stop routine waits for setup.promise and
      // calling it from this catch would wait on itself. No replacement setup
      // is permitted until this captured driver's cleanup has completed.
      const lifecycle = this._browserLifecycleGeneration;
      try { await this._browser.forceClose(); } catch (cleanupError) {
        this._markBrowserCleanupFailure(lifecycle, selection);
        throw cleanupError;
      }
      this._clearBrowserPhysicalState();
      if (controller.signal.aborted || this._epoch !== epoch || !sameSelection(selection, this._selection)) {
        throw new NativeModelError('inference_preempted', 'Inference preempted');
      }
      if (!this._isRetired(error)) await this.reportFailure(error, selection);
      throw error;
    }).finally(() => {
      if (this._browserSetup === setup) this._browserSetup = null;
      this._updateBrowserTimers();
    });
    await setup.promise;
  }

  async downloadBrowserModel(): Promise<LocalModelStatus> {
    const selection = this.getSelection();
    if (selection.engine !== 'litertlm') throw new LocalAvailabilityError('not_configured', 'Choose browser AI before downloading its model.');
    this._assertSelection(selection);
    if (this._browserCleanupFailureGeneration !== null) throw new BrowserModelError('browser_failed', this._browserCleanupStatus().message);
    if (this._browserMaintenance || this._browserStopPromise) throw new LocalAvailabilityError('switching', 'Browser AI maintenance is in progress.');
    if (this._browserSetup) return this.getStatus();
    const saved = await getStorage(['browserModelStatus']);
    this._assertSelection(selection);
    if (saved.browserModelStatus?.state === 'paused' && saved.browserModelStatus.reason === 'browser_cancelled') {
      throw new LocalAvailabilityError('browser_cancelled', saved.browserModelStatus.message);
    }
    if (this._browserMaintenance || this._browserStopPromise) throw new LocalAvailabilityError('switching', 'Browser AI maintenance is in progress.');
    if (this._browserSetup) return this.getStatus();
    const controller = new AbortController();
    const setup = { kind: 'download' as const, controller, promise: Promise.resolve(), selection };
    this._browserSetup = setup;
    const assertOwned = (): void => {
      if (this._browserSetup !== setup || controller.signal.aborted) throw new BrowserModelError('browser_cancelled', 'Browser download canceled.');
      this._assertSelection(selection);
    };
    this._updateBrowserTimers();
    setup.promise = (async () => {
      await this.updateStatus({ state: 'downloading', message: 'Downloading browser AI…', progress: 0 }, selection);
      assertOwned();
      await this._browser.download(progress => {
        if (this._browserSetup !== setup || controller.signal.aborted || this._pendingSelections || !sameSelection(selection, this._selection)) return;
        void this.updateStatus({ state: 'downloading', message: 'Downloading browser AI…', ...this._progressFields(progress) }, selection).catch(() => undefined);
      }, controller.signal);
      assertOwned();
      this._browserRetryRequired = false;
      this._browserLifecycleGeneration++;
      this._browserDiscoveredDownloading = false;
      await this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' }, selection);
    })().catch(async error => {
      const owned = this._browserSetup === setup && !controller.signal.aborted
        && !this._pendingSelections && sameSelection(selection, this._selection);
      if (owned && !this._isRetired(error)) await this.reportFailure(error, selection);
      if (owned) throw error;
    }).finally(() => {
      if (this._browserSetup === setup) this._browserSetup = null;
      this._updateBrowserTimers();
    });
    await setup.promise;
    return this.getStatus();
  }

  async cancelBrowserDownload(): Promise<LocalModelStatus> {
    const selection = this.getSelection();
    const initialKind = this._browserSetup?.kind;
    const knownInitialization = initialKind === 'initialize' || this._browserDiscoveredInitializing;
    const knownWork = !!initialKind || this._browserDiscoveredDownloading || knownInitialization;
    this._browserMaintenance++;
    if (knownWork) {
      this._browserSetup?.controller.abort();
      this.preempt();
    }
    try {
      let discovered: Awaited<ReturnType<BrowserBackend['getState']>>;
      try { discovered = await this._browser.getState(); } catch (error) {
        await this._stopBrowserOwned();
        if (knownInitialization) {
          this._browserRetryRequired = true;
          await this.updateStatus({ state: 'paused', reason: 'browser_cancelled', message: 'Browser setup canceled. Retry when you are ready to load browser AI.' }, selection);
        } else if (!knownWork) await this.reportFailure(error, selection);
        return await this.getStatus();
      }
      this._recordBrowserState(discovered);
      if (!knownWork && !this._browserSetup && !discovered.downloading && !discovered.initializing) return this.getStatus();
      if (!knownWork) this.preempt();
      const initializationCanceled = knownInitialization || this._browserSetup?.kind === 'initialize' || discovered.initializing;
      await this.updateStatus({ state: 'canceling', message: 'Canceling browser setup…' }, selection);
      await this._stopBrowserOwned();
      if (initializationCanceled) {
        this._browserRetryRequired = true;
        await this.updateStatus({ state: 'paused', reason: 'browser_cancelled', message: 'Browser setup canceled. Retry when you are ready to load browser AI.' }, selection);
      }
      return await this.getStatus();
    } finally { this._browserMaintenance--; }
  }

  async deleteBrowserModel(): Promise<LocalModelStatus> {
    const selection = this.getSelection();
    this._browserMaintenance++;
    const selectedBrowser = selection.engine === 'litertlm';
    if (selectedBrowser) this.preempt();
    try {
      await this._stopBrowserOwned();
      if (selectedBrowser) await this.drainQueue(async () => { await this._browser.deleteCache(); });
      else await this._browser.deleteCache();
      this._browserRetryRequired = false;
      await this.updateStatus({ state: 'needs_download', reason: 'needs_download', message: 'Download the browser model to start filtering.' }, { engine: 'litertlm', revision: selection.revision });
      return await this.getStatus();
    } finally { this._browserMaintenance--; }
  }

  /** Development diagnostics can release only the selected owned browser host. */
  async unloadBrowserModel(): Promise<LocalModelStatus> {
    const selection = this.getSelection();
    if (selection.engine !== 'litertlm') throw new LocalAvailabilityError('not_configured', 'Browser AI must be selected to release its model.');
    this._assertSelection(selection);
    this._browserMaintenance++;
    this.preempt();
    try {
      await this._stopBrowserOwned();
      await this.drainQueue(() => Promise.resolve());
      if (!sameSelection(selection, this._selection)) throw new NativeModelError('inference_preempted', 'Inference preempted');
      return await this.getStatus();
    } finally { this._browserMaintenance--; }
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
    const selection = this.getSelection();
    this._assertMaintenanceGeneration(maintenance);
    assertCurrent?.();
    this._assertSelection(selection);
    return inferenceQueue.enqueue(async () => {
      let leaseOpen = true;
      let callerRetired = false;
      let callerFailure: unknown;
      const assertActive = (): void => {
        if (!leaseOpen) throw new NativeModelError('inference_preempted', 'Inference lease ended');
        this._assertMaintenanceGeneration(maintenance);
        this.assertOperationEpoch(epoch);
        this._assertSelection(selection);
        if (callerRetired) throw callerFailure;
        try { assertCurrent?.(); } catch (error) {
          callerRetired = true;
          callerFailure = error;
          throw error;
        }
      };
      assertActive();
      const browserLease = selection.engine === 'litertlm';
      if (browserLease) { this._browserPins++; this._updateBrowserTimers(); }
      try {
        await this.ensureLoaded(undefined, selection);
        assertActive();
      } catch (error) {
        if (browserLease) { this._browserPins--; this._updateBrowserTimers(); }
        throw error;
      }
      const lease: InferenceBackendLease = {
        countTokens: (text: string) => {
          assertActive();
          return (browserLease ? this._browser.countTokens(text) : Promise.resolve(Math.ceil(text.length / 3))).then(count => { assertActive(); return count; });
        },
        truncateText: (text: string, maxTokens: number) => {
          assertActive();
          if (!Number.isInteger(maxTokens) || maxTokens < 0) throw new NativeModelError('input_budget', 'Invalid local input budget.');
          if (browserLease) return this._browser.truncateText(text, maxTokens).then(result => { assertActive(); return result; });
          let bounded = text.slice(0, maxTokens * 3);
          // Avoid cutting one UTF-16 surrogate pair in half.
          if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
          return Promise.resolve(bounded).then(result => { assertActive(); return result; });
        },
        generate: async (messages: ChatMessage[], maxTokens: number) => {
          assertActive();
          await this._assertPersistedSelection(selection);
          assertActive();
          const pending = await getStorage(['nativeOperationFence']);
          assertActive();
          if (pending.nativeOperationFence !== undefined) {
            throw new NativeModelError('recovery_required', this._recoveryStatus().message, 'uncertain');
          }
          if (browserLease) {
            await this.updateStatus({ state: 'filtering', message: 'Filtering' }, selection);
            assertActive();
            let deadline: ReturnType<typeof setTimeout> | undefined;
            const physical = this._browser.generate(messages, maxTokens);
            this._browserActive = physical;
            try {
              const result = await Promise.race([physical, new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(() => reject(new Error('Browser inference timed out. Retry from the popup.')), BROWSER_INFERENCE_MS);
              })]);
              assertActive();
              await this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' }, selection);
              assertActive();
              return result;
            } catch (error) {
              // A browser host is owned by this extension. Closing it proves
              // browser work stopped; native service work has no such shortcut.
              if (this._epoch === epoch && sameSelection(selection, this._selection) && !this._isRetired(error) && !callerRetired) await this.reportFailure(error, selection);
              void this._browser.interrupt().catch(() => undefined);
              await this._browser.forceClose();
              this._clearBrowserPhysicalState();
              if (this._epoch !== epoch || !sameSelection(selection, this._selection)) throw new NativeModelError('inference_preempted', 'Inference preempted');
              if (callerRetired) throw callerFailure;
              throw error;
            } finally {
              if (deadline) clearTimeout(deadline);
              if (this._browserActive === physical) this._browserActive = null;
            }
          }
          const operationId = crypto.randomUUID();
          let fenceWritten = false;
          let submitted = false;
          try {
            const result = await this._backend.generate(messages, maxTokens, {
              beforeSubmit: async readiness => {
                assertActive();
                this._readiness = readiness;
                await this.updateStatus({ state: readiness.resident ? 'filtering' : 'loading', message: readiness.resident ? 'Filtering' : 'Loading model…' }, selection);
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
            await this.updateStatus({ state: 'ready', message: 'Ready — loads when needed' }, selection);
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
              void this.updateStatus(this._recoveryStatus(), selection).catch(() => undefined);
            } else {
              await this.reportFailure(error, selection);
            }
            throw error;
          }
        },
      };
      try { return await operation(lease); } finally {
        leaseOpen = false;
        if (browserLease) { this._browserPins--; this._updateBrowserTimers(); }
      }
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
    if (this._browserSetup?.kind === 'initialize') this._browserSetup.controller.abort();
    if (this._browserSetup?.kind === 'initialize' || this._browserActive) void this._browser.interrupt().catch(() => undefined);
    // A user-requested cache-only download is owned by setup + selection, not
    // the inference epoch. Cancel, switch, delete and teardown retire it.
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
    if (this._browserIdleTimer) clearTimeout(this._browserIdleTimer);
    this._browserIdleTimer = null;
    if (this._browserKeepalive) clearInterval(this._browserKeepalive);
    this._browserKeepalive = null;
    if (this._browserSetup || this._browserActive || this._browserLoaded || this._browserDiscoveredDownloading || this._browserDiscoveredInitializing) {
      void this._stopBrowserOwned().catch(() => undefined);
    }
    // Never delete a native fence or alter shared native retention here.
  }

  async updateStatus(status: StatusUpdate, selection = this.getSelection()): Promise<LocalModelStatus> {
    const write = this._statusWriteChain.catch(() => undefined).then(async () => {
      const data = await getStorage(['nativeModelStatus', 'browserModelStatus', 'localModelStatus', 'nativeOperationFence']);
      return this._writeStatus(status, selection, data);
    });
    this._statusWriteChain = write.then(() => undefined, () => undefined);
    return write;
  }

  private async _writeStatus(
    status: StatusUpdate, selection: EngineSelection,
    data: { nativeModelStatus?: LocalModelStatus; browserModelStatus?: LocalModelStatus; localModelStatus?: LocalModelStatus; nativeOperationFence?: unknown },
  ): Promise<LocalModelStatus> {
    const selected = sameSelection(selection, this._selection);
    const enginePrevious = selection.engine === 'ollama' ? data.nativeModelStatus : data.browserModelStatus;
    const identity = { ...status, engine: selection.engine, selectionRevision: selection.revision };
    const fields: (keyof StatusUpdate)[] = ['state', 'message', 'reason', 'recoveryQualified', 'engine', 'selectionRevision', 'progress', 'receivedBytes', 'totalBytes'];
    const nextStatus = (value: typeof identity, previous?: LocalModelStatus): LocalModelStatus => {
      if (previous && fields.every(field => previous[field] === value[field])) return previous;
      const revision = previous && Number.isSafeInteger(previous.revision) && previous.revision >= 0 ? previous.revision + 1 : 1;
      return { ...value, revision };
    };
    const resource = nextStatus(identity, enginePrevious);
    const writes: { nativeModelStatus?: LocalModelStatus; browserModelStatus?: LocalModelStatus; localModelStatus?: LocalModelStatus } = {};
    // Resource records preserve download/cache/error state while a global native
    // recovery block is presented. Neither progress nor Ready may bypass it.
    if (selection.engine === 'ollama' && status.state !== 'switching' && this._browserCleanupFailureGeneration === null) {
      if (resource !== data.nativeModelStatus) writes.nativeModelStatus = resource;
    } else if (selection.engine === 'litertlm' && status.state !== 'recovery_required' && status.state !== 'switching') {
      if (resource !== data.browserModelStatus) writes.browserModelStatus = resource;
    }
    let result = resource;
    if (selected) {
      const unresolved = data.nativeOperationFence !== undefined && !sameFence(data.nativeOperationFence, this._activeOperationId ?? '');
      const publicStatus = unresolved ? { ...this._recoveryStatus(), engine: selection.engine, selectionRevision: selection.revision }
        : this._browserCleanupFailureGeneration !== null ? { ...this._browserCleanupStatus(), engine: selection.engine, selectionRevision: selection.revision } : identity;
      result = nextStatus(publicStatus, data.localModelStatus ?? enginePrevious);
      if (result !== data.localModelStatus) writes.localModelStatus = result;
    }
    if (Object.keys(writes).length) await setStorage(writes);
    return result;
  }

  private _browserFailureStatus(error: unknown): StatusUpdate {
    const reason = error instanceof BrowserModelError ? error.reason
      : error instanceof NativeModelError ? error.reason : 'browser_failed';
    if (reason === 'needs_download') return { state: 'needs_download', reason, message: 'Download the browser model to start filtering.' };
    const messages: Record<string, string> = {
      webgpu_unavailable: 'Browser AI needs WebGPU. Check browser support, then Retry.',
      storage_full: 'There is not enough browser storage. Free space, then Retry the download.',
      download_failed: 'The browser model download failed. Retry the download.',
      artifact_integrity: 'The browser model could not be verified. Delete its files, then download again.',
    };
    return { state: reason === 'webgpu_unavailable' ? 'blocked' : 'error', reason, message: messages[reason] ?? 'Browser AI failed. Retry from the Bouncer popup.' };
  }

  async reportFailure(error: unknown, selection = this.getSelection()): Promise<void> {
    if (this._isRetired(error)) return;
    if (selection.engine === 'litertlm') {
      // Fixed error codes survive the trusted runtime envelope. Arbitrary SDK
      // or provider text never becomes persistent background diagnostics.
      const status = this._browserFailureStatus(error);
      this._browserRetryRequired = status.state === 'error' || status.state === 'blocked';
      await this.updateStatus(status, selection);
      return;
    }
    const status = nativeFailureStatus(error);
    if ((status.state === 'error' && status.reason !== 'service_unreachable')
        || ['recovery_required', 'blocked', 'missing_model'].includes(status.state)) this._retryRequired = true;
    await this.updateStatus(status.state === 'recovery_required' ? this._recoveryStatus() : status, selection);
  }

  async markTerminalError(modelId: string, error: string): Promise<void> {
    const selection = this.getSelection();
    this._assertModel(modelId, selection);
    if (selection.engine === 'litertlm') this._browserRetryRequired = true;
    else this._retryRequired = true;
    const status = await this.getStatus();
    if (['blocked', 'paused', 'recovery_required', 'not_connected', 'missing_model', 'not_configured', 'needs_download', 'switching'].includes(status.state)) return;
    await this.updateStatus({ state: 'error', message: error, reason: 'response_invalid' }, selection);
  }

}

export const localEngine = new LocalEngine();

export async function callLocalInference(
  postData: EvaluationPostData,
  bannedCategories: string[],
  modelConfig: LocalModelDef | null = localEngine.getSelectedModel(),
  modelId?: string,
  { priority = 0, onInferenceStart, promptMode = 'baseline', assertCurrent }: {
    priority?: number; onInferenceStart?: () => void; promptMode?: LocalPromptMode; assertCurrent?: () => void;
  } = {},
): Promise<{
  shouldHide: boolean; reasoning: string; category: string | null; matches: string[];
  rawResponse: string; inferenceTime: number; malformed: boolean; classifierFingerprint: string;
  modelId: string; engine: InferenceEngineId; selectionRevision: number;
}> {
  assertCurrent?.();
  if (!postData.text.trim() || bannedCategories.length === 0
      || bannedCategories.some(category => typeof category !== 'string' || !category.trim())) {
    throw new NativeModelError('input_budget', 'A real post and nonempty filter phrases are required.');
  }
  const selection = localEngine.getSelection();
  if (!selection.engine) {
    if (modelId !== undefined) throw new NativeModelError('model_identity_changed', 'Choose a fixed local classifier.');
    throw new LocalAvailabilityError('not_configured', 'Choose where Bouncer should run.');
  }
  const model = modelForEngine(selection.engine);
  if ((modelId !== undefined && modelId !== model.name) || (modelConfig && (modelConfig.name !== model.name || modelConfig.backend !== model.backend))) {
    throw new NativeModelError('model_identity_changed', 'The selected classifier configuration changed.');
  }
  const fingerprint = classifierFingerprintForEngine(selection.engine);
  const epoch = localEngine.operationEpoch;
  // Native metadata remains outside the lease for qualified transport behavior;
  // browser setup is inside its pinned lease, including prompt preparation.
  if (selection.engine === 'ollama') await localEngine.ensureLoaded(model.name);
  assertCurrent?.();
  localEngine.assertOperationEpoch(epoch);
  const builder = selection.engine === 'ollama' ? buildNativeTableYesnoRequest : buildTableYesnoRequest;
  const empty = builder('', bannedCategories, promptMode);
  const overhead = Math.ceil(empty.messages.map(message => message.content).join('\n').length / 3);
  const budget = model.contextTokens - overhead - empty.maxOutputTokens;
  if (budget <= 0) throw new NativeModelError('input_budget', 'The filter phrases exceed the local input budget.');
  let inferenceStart = Date.now();
  const rawResponse = await localEngine.runInferenceOperation(async lease => {
    const postText = await lease.truncateText(postData.text, budget);
    onInferenceStart?.();
    inferenceStart = Date.now();
    const request = builder(postText, bannedCategories, promptMode);
    return lease.generate(request.messages, request.maxOutputTokens);
  }, { priority, assertCurrent });
  assertCurrent?.();
  localEngine.assertOperationEpoch(epoch);
  const parsed = parseTableYesnoResponse(rawResponse, bannedCategories);
  if (parsed.malformed && priority === 0) {
    await localEngine.reportFailure(new NativeModelError('response_invalid', 'The classifier returned malformed verdicts. Retry from the popup.', 'terminal'), selection);
  }
  assertCurrent?.();
  localEngine.assertOperationEpoch(epoch);
  return {
    ...parsed,
    reasoning: parsed.malformed ? 'Malformed classifier response' : parsed.reasoning,
    category: parsed.matches.length > 0 ? parsed.matches.join(', ') : null,
    rawResponse,
    inferenceTime: (Date.now() - inferenceStart) / 1000,
    classifierFingerprint: fingerprint,
    modelId: model.name,
    engine: selection.engine,
    selectionRevision: selection.revision,
  };
}
