// Shared toolbar/embedded settings: a preview is never a persisted engine choice.
import type { EngineSelection, InferenceEngineId, LocalModelStatus } from '../types';
import { getStorage, setStorage } from '../shared/storage';
import { engineName, engineStatusView, nativeStatusView, statusMatchesSelection } from '../shared/engine-status-view';
import type { EngineStatusView } from '../shared/engine-status-view';
export { nativeStatusView };

export const OLLAMA_PERMISSION = 'http://127.0.0.1:11434/*';
type ModelAction = 'downloadBrowserModel' | 'cancelBrowserDownload' | 'deleteBrowserModel' | 'retryLocalModel'
  | 'connectNativeModel' | 'retryNativeModel' | 'recoverNativeModel';
interface StatusResponse { selection?: EngineSelection; status?: LocalModelStatus; success?: boolean; error?: string }

/** An event received during an async read always wins over that read. */
export class SnapshotRevision {
  private revision = 0;
  beginSnapshot(): number { return this.revision; }
  markEvent(): void { this.revision += 1; }
  isCurrent(snapshotRevision: number): boolean { return snapshotRevision === this.revision; }
}

const statusRevision = new SnapshotRevision();
const permissionRevision = new SnapshotRevision();
const resourceRevision = new SnapshotRevision();
const filterRepliesRevision = new SnapshotRevision();
let selection: EngineSelection = { engine: null, revision: 0 };
let selectionKnown = false;
let selectedStatus: LocalModelStatus = { state: 'not_configured', engine: null, selectionRevision: 0, message: '', revision: 0 };
let browserStatus: LocalModelStatus | undefined;
let nativeStatus: LocalModelStatus | undefined;
let nativeFence = false;
let nativePermission = false;
let preview: InferenceEngineId = 'litertlm';
let previewTouched = false;
let checking = true;
let choosing = false;
const pendingActions = new Map<ModelAction, EngineSelection>();
const actionRevisions = { browser: 0, native: 0 };
let actionError: string | null = null;
let initialized = false;

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { void init().catch(() => showInitializationError()); });
}

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  setupModalMode();
  setupStorageListener();
  setupPermissionListener();
  setupControlListeners();
  render();
  await Promise.all([loadFilterReplies(), refreshStatus()]);
}

function setupModalMode(): void {
  if (window.self === window.top) return;
  document.body.classList.add('modal-mode');
  const close = () => window.parent.postMessage({ type: 'closeSettingsModal' }, '*');
  byId<HTMLButtonElement>('modalCloseBtn').addEventListener('click', close);
  window.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const data = event.data as { type?: string; theme?: string } | null;
    if (data?.type !== 'setTheme' || !['light', 'dim', 'dark'].includes(data.theme || '')) return;
    document.body.classList.remove('light-mode', 'dim-mode', 'dark-mode');
    document.body.classList.add(`${data.theme}-mode`);
  });
  const sendSize = () => window.parent.postMessage({ type: 'settingsResize', height: document.body.scrollHeight + 2 }, '*');
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sendSize).observe(document.body);
  sendSize();
}

function isSelection(value: unknown): value is EngineSelection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EngineSelection>;
  return (candidate.engine === null || candidate.engine === 'litertlm' || candidate.engine === 'ollama')
    && typeof candidate.revision === 'number' && Number.isSafeInteger(candidate.revision) && candidate.revision >= 0;
}

function sameSelection(left: EngineSelection, right: EngineSelection): boolean {
  return left.engine === right.engine && left.revision === right.revision;
}

function acceptSelection(next: EngineSelection): boolean {
  if (selectionKnown && (next.revision < selection.revision || (next.revision === selection.revision && next.engine !== selection.engine))) return false;
  selectionKnown = true;
  const changed = !sameSelection(next, selection);
  selection = { ...next };
  if (changed) {
    selectedStatus = { state: next.engine ? 'switching' : 'not_configured', engine: next.engine, selectionRevision: next.revision, message: '', revision: 0 };
    actionError = null;
    if (!previewTouched && next.engine) preview = next.engine;
  }
  return true;
}

function acceptStatus(status: LocalModelStatus): boolean {
  if (!statusMatchesSelection(status, selection) || status.revision < selectedStatus.revision) return false;
  selectedStatus = status;
  return true;
}

function acceptResponse(response: StatusResponse | undefined): boolean {
  if (!response || !isSelection(response.selection) || !response.status) return false;
  if (!acceptSelection(response.selection)) return false;
  if (!acceptStatus(response.status)) return false;
  checking = false;
  return true;
}

function setupStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const changedSelection = changes.engineSelection?.newValue;
    if (changes.engineSelection || changes.localModelStatus || changes.nativeOperationFence) statusRevision.markEvent();
    if (changes.browserModelStatus || changes.nativeModelStatus || changes.nativeOperationFence) resourceRevision.markEvent();
    if (isSelection(changedSelection)) acceptSelection(changedSelection);
    if (changes.browserModelStatus) browserStatus = changes.browserModelStatus.newValue as LocalModelStatus | undefined;
    if (changes.nativeModelStatus) nativeStatus = changes.nativeModelStatus.newValue as LocalModelStatus | undefined;
    if (changes.nativeOperationFence) nativeFence = changes.nativeOperationFence.newValue !== undefined;
    const nextStatus = changes.localModelStatus?.newValue as LocalModelStatus | undefined;
    if (nextStatus && acceptStatus(nextStatus)) checking = false;
    else if (nextStatus && (nextStatus.selectionRevision ?? -1) > selection.revision) void refreshStatus();
    if (changes.engineSelection && !nextStatus) void refreshStatus();
    if (changes.nativeOperationFence) void refreshStatus();
    if (changes.filterReplies) {
      filterRepliesRevision.markEvent();
      byId<HTMLInputElement>('enableFilterReplies').checked = changes.filterReplies.newValue !== false;
    }
    render();
  });
}

function setupPermissionListener(): void {
  const update = () => { permissionRevision.markEvent(); statusRevision.markEvent(); void refreshStatus(); };
  chrome.permissions.onRemoved.addListener(update);
  chrome.permissions.onAdded.addListener(update);
}

async function loadFilterReplies(): Promise<void> {
  const snapshot = filterRepliesRevision.beginSnapshot();
  const data = await getStorage(['filterReplies']);
  if (filterRepliesRevision.isCurrent(snapshot)) byId<HTMLInputElement>('enableFilterReplies').checked = data.filterReplies !== false;
}

async function refreshStatus(): Promise<void> {
  const snapshot = statusRevision.beginSnapshot();
  const permissionSnapshot = permissionRevision.beginSnapshot();
  const resourceSnapshot = resourceRevision.beginSnapshot();
  try {
    // The status route reads the chosen engine; it never downloads, initializes a GPU or probes an inactive engine.
    const [response, data] = await Promise.all([
      chrome.runtime.sendMessage<{ type: 'getLocalModelStatus' }, StatusResponse | undefined>({ type: 'getLocalModelStatus' }),
      getStorage(['browserModelStatus', 'nativeModelStatus', 'nativeOperationFence']),
      chrome.permissions.contains({ origins: [OLLAMA_PERMISSION] }).then(granted => {
        if (permissionRevision.isCurrent(permissionSnapshot)) { nativePermission = granted; render(); }
      }),
    ]);
    if (!statusRevision.isCurrent(snapshot)) return;
    if (resourceRevision.isCurrent(resourceSnapshot)) {
      browserStatus = data.browserModelStatus;
      nativeStatus = data.nativeModelStatus;
      nativeFence = data.nativeOperationFence !== undefined;
    }
    if (response?.error || !acceptResponse(response)) throw new Error('Status unavailable');
    actionError = null;
  } catch {
    if (!statusRevision.isCurrent(snapshot)) return;
    checking = false;
    actionError = 'Couldn’t read the saved AI status. Reopen settings to try again. Your filters and manual controls are still available.';
  }
  render();
}

function setupControlListeners(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="inferenceEngine"]')) {
    input.addEventListener('change', () => {
      preview = input.value as InferenceEngineId;
      previewTouched = true;
      render();
    });
  }
  byId<HTMLButtonElement>('useEngineButton').addEventListener('click', () => { void chooseEngine(); });
  byId<HTMLInputElement>('enableFilterReplies').addEventListener('change', event => {
    const checkbox = event.currentTarget as HTMLInputElement;
    const requested = checkbox.checked;
    filterRepliesRevision.markEvent();
    const snapshot = filterRepliesRevision.beginSnapshot();
    const error = byId<HTMLElement>('filterRepliesError');
    error.hidden = true;
    checkbox.disabled = true;
    void setStorage({ filterReplies: requested }).catch(() => {
      if (filterRepliesRevision.isCurrent(snapshot)) checkbox.checked = !requested;
      error.textContent = 'Couldn’t save this setting. Try again.';
      error.hidden = false;
    }).finally(() => { checkbox.disabled = false; });
  });
  for (const type of ['downloadBrowserModel', 'cancelBrowserDownload', 'retryLocalModel', 'connectNativeModel', 'retryNativeModel'] as const) {
    byId<HTMLButtonElement>(type).addEventListener('click', () => { void runAction(type); });
  }
  byId<HTMLButtonElement>('deleteBrowserModel').addEventListener('click', () => {
    if (window.confirm('Delete the downloaded browser model (about 2 GB)? You’ll need to download it again to use Browser AI. Your saved choice, filter phrases and manual decisions will be kept.')) void runAction('deleteBrowserModel');
  });
  byId<HTMLButtonElement>('recoverNativeModel').addEventListener('click', () => {
    if (!nativePermission || !recoveryQualified()) return;
    if (window.confirm('Quit Ollama and confirm the app, server and listener stopped, then reopen it using Setup help. Have you completed this full restart and left other local clients idle? This confirms the previous Ollama request stopped and resumes your selected AI option.')) void runAction('recoverNativeModel');
  });
}

async function chooseEngine(): Promise<void> {
  if (choosing || selection.engine === preview) return;
  const requested = preview;
  const previous = { ...selection };
  const downloadExplicitlyRequested = requested === 'litertlm' && browserStatus?.state === 'needs_download';
  actionRevisions.browser += 1;
  actionRevisions.native += 1;
  choosing = true;
  actionError = null;
  render();
  try {
    const response: StatusResponse | undefined = await chrome.runtime.sendMessage({ type: 'selectInferenceEngine', engine: requested });
    const accepted = acceptResponse(response);
    if (response?.success === false || !response?.selection || response.selection.engine !== requested) throw new Error('Choice could not be saved');
    if (!accepted || !sameSelection(response.selection, selection)) return;
    previewTouched = false;
    preview = requested;
    // Only a button that explicitly advertised a download is allowed to start one.
    if (downloadExplicitlyRequested && selectedStatus.state === 'needs_download') await runAction('downloadBrowserModel');
    render();
    const nextButton = requested === 'ollama' ? 'connectNativeModel' : 'downloadBrowserModel';
    if (!byId<HTMLButtonElement>(nextButton).hidden) byId<HTMLButtonElement>(nextButton).focus();
  } catch {
    // A lost response may follow a successful save; read the preference before describing failure.
    if (sameSelection(previous, selection)) await refreshStatus();
    if (sameSelection(previous, selection)) actionError = 'Couldn’t save that choice. Your previous saved choice is still shown. Try again.';
  } finally {
    choosing = false;
    render();
  }
}

async function runAction(type: ModelAction): Promise<void> {
  if (pendingActions.has(type)) return;
  const context = { ...selection };
  const resource = type.endsWith('NativeModel') ? 'native' : 'browser';
  const actionRevision = ++actionRevisions[resource];
  const stillOwned = () => sameSelection(context, selection) && actionRevision === actionRevisions[resource];
  pendingActions.set(type, context);
  actionError = null;
  render();
  let denied = false;
  try {
    if (type === 'connectNativeModel') {
      // Request immediately from this click, preserving Chrome's user gesture.
      const granted = await chrome.permissions.request({ origins: [OLLAMA_PERMISSION] });
      denied = !granted;
      if (!granted) throw new Error('Permission denied');
      nativePermission = true;
    }
    if (!stillOwned()) return;
    const response: StatusResponse | undefined = await chrome.runtime.sendMessage(type === 'recoverNativeModel' ? { type, operatorRestartConfirmed: true } : { type });
    if (!stillOwned()) return;
    if (response?.selection) acceptResponse(response);
    else if (response?.status) acceptStatus(response.status);
    if (!response || response.success === false || response.error) throw new Error('Action failed');
    await refreshStatus();
  } catch {
    if (!stillOwned()) return;
    // Read authoritative state after a partial setup failure; never undo the saved choice.
    if (!denied) await refreshStatus();
    if (stillOwned()) actionError = denied
      ? 'Local connection permission was not granted. Your saved choice is unchanged. Connect again when you’re ready.'
      : 'Couldn’t complete this action. Your saved choice is unchanged. Follow the status above or try again.';
  } finally {
    pendingActions.delete(type);
    render();
  }
}

function recoveryNeeded(): boolean { return nativeFence || selectedStatus.state === 'recovery_required'; }
function recoveryQualified(): boolean { return selectedStatus.recoveryQualified === true || nativeStatus?.recoveryQualified === true; }
function actionPending(type: ModelAction): boolean {
  const context = pendingActions.get(type);
  return !!context && sameSelection(context, selection);
}

function render(): void {
  byId<HTMLInputElement>('previewBrowserEngine').checked = preview === 'litertlm';
  byId<HTMLInputElement>('previewNativeEngine').checked = preview === 'ollama';
  const use = byId<HTMLButtonElement>('useEngineButton');
  use.hidden = selection.engine === preview;
  use.disabled = choosing || checking;
  use.textContent = choosing ? 'Saving choice…' : preview === 'ollama' ? 'Use Ollama'
    : browserStatus?.state === 'needs_download' ? 'Download & use browser AI' : 'Use browser AI';
  setText('engineSelectionText', selection.engine ? `${engineName(selection.engine)} selected.` : 'No option selected yet.');
  byId<HTMLElement>('engineChoiceHint').textContent = preview === selection.engine
    ? 'This is your saved choice. You can preview the other option at any time.'
    : 'Previewing an option does not change your saved choice. Use the button to save it.';
  byId<HTMLElement>('activeEngineTitle').textContent = selection.engine ? `${engineName(selection.engine)} · automatic filtering` : 'Automatic filtering';
  let view: EngineStatusView = checking ? { badge: 'Checking…', text: 'Reading your saved choice…' } : engineStatusView(selectedStatus, selection);
  if (!checking && selection.engine === 'ollama' && !nativePermission && !recoveryNeeded()) {
    view = nativeStatusView({ state: 'not_connected', message: '', revision: 0 });
  }
  const badge = byId<HTMLElement>('localModelStatusBadge');
  if (badge.textContent !== view.badge) badge.textContent = view.badge;
  badge.classList.remove('busy', 'ready', 'error');
  if (view.tone) badge.classList.add(view.tone);
  setText('nativeStatusText', view.text);
  const globalRecovery = !checking && selection.engine !== null && recoveryNeeded();
  const browser = selection.engine === 'litertlm';
  setAction('downloadBrowserModel', browser && view.action === 'download');
  setAction('cancelBrowserDownload', browser && view.action === 'cancel');
  setAction('retryLocalModel', browser && view.action === 'retry' && !globalRecovery);
  setAction('connectNativeModel', (!browser && !!view.connect) || (globalRecovery && !nativePermission));
  setAction('retryNativeModel', !globalRecovery && !browser && !!view.retry);
  setAction('recoverNativeModel', globalRecovery && nativePermission && recoveryQualified());
  byId<HTMLElement>('nativeRecoveryNotice').hidden = !globalRecovery;
  byId<HTMLElement>('nativeRecoveryText').textContent = !nativePermission
    ? 'Connect to Ollama to complete recovery. Connection permission does not change your chosen engine or confirm a restart.'
    : 'Complete the full Ollama restart in Setup help, then confirm recovery. Retry alone does not clear this pause.';
  const help = view.details || view.help || '';
  byId<HTMLElement>('nativeSetupHelp').hidden = !help;
  byId<HTMLElement>('nativeSetupHelpText').textContent = help;
  byId<HTMLElement>('browserDownloadProgress').hidden = !browser || selectedStatus.state !== 'downloading';
  const meter = byId<HTMLProgressElement>('browserDownloadMeter');
  if (view.progress === undefined) meter.removeAttribute('value');
  else meter.value = view.progress;
  byId<HTMLElement>('browserDownloadProgressText').textContent = view.progressText || '';
  const knownBrowserFiles = (browser && ['ready', 'loading', 'filtering', 'downloading', 'canceling', 'paused', 'error', 'blocked'].includes(selectedStatus.state))
    || !!browserStatus && ['ready', 'loading', 'filtering', 'downloading', 'canceling', 'paused', 'error', 'blocked'].includes(browserStatus.state);
  byId<HTMLElement>('browserStorageControls').hidden = !knownBrowserFiles;
  const deleting = actionPending('deleteBrowserModel');
  byId<HTMLButtonElement>('deleteBrowserModel').disabled = deleting || (browser && selectedStatus.state === 'canceling');
  byId<HTMLButtonElement>('deleteBrowserModel').textContent = deleting ? 'Deleting browser model…' : 'Delete downloaded browser model';
  const error = byId<HTMLElement>('localModelActionError');
  error.hidden = !actionError;
  error.textContent = actionError || '';
}

function setAction(type: ModelAction, visible: boolean): void {
  const button = byId<HTMLButtonElement>(type);
  button.hidden = !visible;
  const pending = actionPending(type);
  button.disabled = pending;
  const labels: Record<ModelAction, [string, string]> = {
    downloadBrowserModel: ['Download browser model', 'Starting download…'],
    cancelBrowserDownload: ['Cancel', 'Canceling…'],
    deleteBrowserModel: ['Delete downloaded browser model', 'Deleting browser model…'],
    retryLocalModel: ['Retry browser AI', 'Retrying…'],
    connectNativeModel: ['Connect to Ollama', 'Connecting…'],
    retryNativeModel: ['Retry', 'Checking…'],
    recoverNativeModel: ['Resume after restarting Ollama', 'Checking restarted Ollama…'],
  };
  button.textContent = labels[type][pending ? 1 : 0];
}
function setText(id: string, text: string): void {
  const element = byId<HTMLElement>(id);
  if (element.textContent !== text) element.textContent = text;
}
function showInitializationError(): void {
  checking = false;
  actionError = 'Couldn’t open settings completely. Reopen settings to try again.';
  render();
}
function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element #${id}`);
  return element as T;
}
