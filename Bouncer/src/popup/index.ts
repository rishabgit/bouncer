// Bouncer popup: one on-device Gemma model and its lifecycle.

import type { LocalModelStatus } from '../types';
import { PRIMARY_LOCAL_MODEL, PRIMARY_LOCAL_MODEL_ID } from '../shared/models';
import { getStorage, setStorage } from '../shared/storage';

type ModelStatuses = Record<string, LocalModelStatus>;
type BusyAction = 'start' | 'cancel' | 'delete' | null;

interface ModelActionResponse {
  success?: boolean;
  error?: string;
}

/**
 * Rejects an async snapshot if a newer event arrived while it was in flight.
 * The popup installs the event listener before starting its initial reads, so a
 * storage event can never be replaced by an older get-status response.
 */
export class SnapshotRevision {
  private revision = 0;

  beginSnapshot(): number {
    return this.revision;
  }

  markEvent(): void {
    this.revision += 1;
  }

  isCurrent(snapshotRevision: number): boolean {
    return snapshotRevision === this.revision;
  }
}

const statusRevision = new SnapshotRevision();
const filterRepliesRevision = new SnapshotRevision();

let localModelStatuses: ModelStatuses = {};
let webgpuSupported = true;
let statusChecking = true;
let busyAction: BusyAction = null;
let actionError: string | null = null;
let initialized = false;

// The native WebView bridge supplies its own GPU capability path.
const isInAppMode = typeof chrome !== 'undefined'
  && Boolean((chrome as unknown as { _polyfilled?: boolean })._polyfilled);

const LOCAL_MODEL_ERROR_MESSAGES: Array<[string, { display: string; hint: string }]> = [
  ['device lost', {
    display: 'GPU device was lost.',
    hint: 'Close other GPU-intensive tabs or restart the browser, then retry.',
  }],
  ['device destroyed', {
    display: 'The GPU became unavailable.',
    hint: 'Close other GPU-intensive tabs or restart the browser, then retry.',
  }],
  ['out of memory', {
    display: 'There is not enough GPU memory.',
    hint: 'Close other GPU-intensive tabs or applications, then retry.',
  }],
  ['oom', {
    display: 'GPU memory was exhausted.',
    hint: 'Close other GPU-intensive tabs or applications, then retry.',
  }],
  ['webgpu not', {
    display: 'WebGPU is unavailable.',
    hint: 'Enable WebGPU in a supported browser and try again.',
  }],
  ['failed to cache model', {
    display: 'The model could not be saved.',
    hint: 'Free about 2 GB of disk space and retry.',
  }],
  ['network', {
    display: 'The model download failed.',
    hint: 'Check the internet connection and retry.',
  }],
  ['download failed', {
    display: 'The model download failed.',
    hint: 'Check the internet connection and retry.',
  }],
  ['fetch', {
    display: 'The model download failed.',
    hint: 'Check the internet connection and retry.',
  }],
  ['timeout', {
    display: 'The model took too long to respond.',
    hint: 'Close other GPU-intensive tabs and retry.',
  }],
];

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    init().catch(err => console.error('[Popup] Initialization failed:', err));
  });
}

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  setupModalMode();

  // These listeners must be active before either asynchronous snapshot starts.
  setupStorageListener();
  setupControlListeners();

  await Promise.all([
    loadFilterReplies(),
    refreshLocalModelStatus(),
  ]);
}

function setupModalMode(): void {
  if (window.self === window.top) return;

  document.body.classList.add('modal-mode');
  for (const button of document.querySelectorAll<HTMLButtonElement>('.modal-close-btn')) {
    button.addEventListener('click', () => {
      window.parent.postMessage({ type: 'closeSettingsModal' }, '*');
    });
  }

  window.addEventListener('message', event => {
    const data = event.data as { type?: string; theme?: string } | null;
    if (data?.type !== 'setTheme' || !['light', 'dim', 'dark'].includes(data.theme || '')) return;
    document.body.classList.remove('light-mode', 'dim-mode', 'dark-mode');
    document.body.classList.add(`${data.theme}-mode`);
  });

  const sendSize = () => {
    window.parent.postMessage({ type: 'settingsResize', height: document.body.scrollHeight + 2 }, '*');
  };
  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(sendSize);
    resizeObserver.observe(document.body);
  }
  sendSize();
}

function setupStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.localModelStatuses) {
      statusRevision.markEvent();
      localModelStatuses = (changes.localModelStatuses.newValue as ModelStatuses | undefined) || {};
      statusChecking = false;
      renderLocalModel();
    }

    if (changes.filterReplies) {
      filterRepliesRevision.markEvent();
      const checkbox = byId<HTMLInputElement>('enableFilterReplies');
      checkbox.checked = changes.filterReplies.newValue !== false;
    }
  });
}

async function loadFilterReplies(): Promise<void> {
  const snapshot = filterRepliesRevision.beginSnapshot();
  const data = await getStorage(['filterReplies']);
  if (!filterRepliesRevision.isCurrent(snapshot)) return;
  byId<HTMLInputElement>('enableFilterReplies').checked = data.filterReplies !== false;
}

async function refreshLocalModelStatus(): Promise<void> {
  const snapshot = statusRevision.beginSnapshot();
  try {
    const response: {
      statuses?: ModelStatuses;
      webgpuSupported?: boolean;
      error?: string;
    } = await chrome.runtime.sendMessage({ type: 'getAllLocalModelStatuses' });
    if (!statusRevision.isCurrent(snapshot)) return;
    if (response?.error) throw new Error(response.error);

    localModelStatuses = response?.statuses || {};
    webgpuSupported = response?.webgpuSupported !== false;
    statusChecking = false;
  } catch (err) {
    if (!statusRevision.isCurrent(snapshot)) return;
    statusChecking = false;
    const message = `Could not check the local model: ${errorText(err)}`;
    localModelStatuses = {
      ...localModelStatuses,
      [PRIMARY_LOCAL_MODEL_ID]: { state: 'error', error: message },
    };
  }
  renderLocalModel();
}

function setupControlListeners(): void {
  byId<HTMLInputElement>('enableFilterReplies').addEventListener('change', event => {
    const checkbox = event.currentTarget as HTMLInputElement;
    const requested = checkbox.checked;
    setStorage({ filterReplies: requested }).catch(err => {
      checkbox.checked = !requested;
      console.error('[Popup] Failed to save filter-replies setting:', err);
    });
  });

  byId<HTMLButtonElement>('downloadLocalModel').addEventListener('click', () => {
    startModel('download').catch(err => console.error('[Popup] Download action failed:', err));
  });
  byId<HTMLButtonElement>('retryLocalModel').addEventListener('click', () => {
    startModel('retry').catch(err => console.error('[Popup] Retry action failed:', err));
  });
  byId<HTMLButtonElement>('cancelLocalModelDownload').addEventListener('click', () => {
    cancelModelDownload().catch(err => console.error('[Popup] Cancel action failed:', err));
  });
  for (const id of ['deleteLocalModel', 'deleteLocalModelAfterError']) {
    byId<HTMLButtonElement>(id).addEventListener('click', () => {
      deleteModel().catch(err => console.error('[Popup] Delete action failed:', err));
    });
  }
}

async function startModel(action: 'download' | 'retry'): Promise<void> {
  if (busyAction) return;
  actionError = null;
  busyAction = 'start';
  renderLocalModel();
  const snapshot = statusRevision.beginSnapshot();

  try {
    const response = await sendModelAction('initializeLocalModel');
    assertSuccessful(response, `Could not ${action} Gemma`);

    // The background acknowledges before its first storage write. Show a
    // short honest starting state, but never replace a newer storage event.
    if (statusRevision.isCurrent(snapshot)) {
      localModelStatuses = {
        ...localModelStatuses,
        [PRIMARY_LOCAL_MODEL_ID]: { state: 'initializing', text: 'Starting Gemma…' },
      };
    }
  } catch (err) {
    actionError = `${action === 'download' ? 'Download' : 'Retry'} failed: ${errorText(err)}`;
    await refreshLocalModelStatus();
  } finally {
    busyAction = null;
    renderLocalModel();
  }
}

async function cancelModelDownload(): Promise<void> {
  if (busyAction) return;
  actionError = null;
  busyAction = 'cancel';
  renderLocalModel();

  try {
    const response = await sendModelAction('cancelLocalModelDownload');
    assertSuccessful(response, 'Could not cancel the model download');
  } catch (err) {
    actionError = `Cancel failed: ${errorText(err)}`;
  } finally {
    await refreshLocalModelStatus();
    busyAction = null;
    renderLocalModel();
  }
}

async function deleteModel(): Promise<void> {
  if (busyAction) return;

  const sizeGB = Math.round(PRIMARY_LOCAL_MODEL.sizeGB || 2);
  const confirmed = window.confirm(
    `Delete Gemma 4 E2B from this browser? Downloading it again will use about ${sizeGB} GB of data and disk space.`
  );
  if (!confirmed) return;

  actionError = null;
  busyAction = 'delete';
  renderLocalModel();

  try {
    const response = await sendModelAction('deleteLocalModel');
    assertSuccessful(response, 'Could not delete the model');
  } catch (err) {
    // Keep this message across the authoritative status refresh below.
    actionError = `Delete failed: ${errorText(err)}`;
  } finally {
    // Do not re-enable controls until the background has authoritatively
    // reported what remains in Cache Storage.
    await refreshLocalModelStatus();
    busyAction = null;
    renderLocalModel();
  }
}

async function sendModelAction(type: 'initializeLocalModel' | 'cancelLocalModelDownload' | 'deleteLocalModel'):
Promise<ModelActionResponse> {
  return chrome.runtime.sendMessage({ type });
}

function assertSuccessful(response: ModelActionResponse | undefined, fallback: string): void {
  if (response?.success === true) return;
  throw new Error(response?.error || fallback);
}

function renderLocalModel(): void {
  const panels = document.querySelectorAll<HTMLElement>('.model-state');
  for (const panel of panels) panel.hidden = true;

  const progressFill = byId<HTMLElement>('localProgressFill');
  progressFill.classList.remove('indeterminate');
  progressFill.style.width = '0%';
  setControlsDisabled(Boolean(busyAction));
  renderActionError();

  if (busyAction === 'delete') {
    setBadge('Deleting…', 'downloading');
    showPanel('localModelReady');
    byId<HTMLElement>('localModelReadyHint').textContent = 'Removing the downloaded model and checking browser storage…';
    return;
  }

  if (statusChecking) {
    setBadge('Checking…');
    showPanel('localModelChecking');
    return;
  }

  const status = localModelStatuses[PRIMARY_LOCAL_MODEL_ID] || { state: 'not_downloaded' };
  if ((!webgpuSupported && !isInAppMode) || status.state === 'unsupported') {
    setBadge('Unsupported', 'error');
    showPanel('localModelUnsupported');
    return;
  }

  switch (status.state) {
    case 'not_downloaded':
      setBadge('Not downloaded');
      showPanel('localModelNotDownloaded');
      break;

    case 'downloading': {
      setBadge('Downloading…', 'downloading');
      showPanel('localModelDownloading');
      const progress = typeof status.progress === 'number'
        ? Math.min(1, Math.max(0, status.progress))
        : null;
      if (progress === null) {
        progressFill.classList.add('indeterminate');
      } else {
        progressFill.style.width = `${(progress * 100).toFixed(1)}%`;
      }
      byId<HTMLElement>('localProgressText').textContent = status.text
        || (progress === null ? 'Downloading Gemma…' : `${(progress * 100).toFixed(1)}%`);
      break;
    }

    case 'initializing':
      setBadge('Loading…', 'downloading');
      showPanel('localModelDownloading');
      progressFill.classList.add('indeterminate');
      byId<HTMLElement>('localProgressText').textContent = status.text
        || 'Preparing Gemma for local inference…';
      break;

    case 'cached':
      setBadge('Downloaded', 'ready');
      showPanel('localModelReady');
      byId<HTMLElement>('localModelReadyHint').textContent = 'Downloaded; loads automatically when first needed.';
      break;

    case 'ready':
      setBadge('Ready', 'ready');
      showPanel('localModelReady');
      byId<HTMLElement>('localModelReadyHint').textContent = 'Loaded and ready to filter posts locally.';
      break;

    case 'error': {
      setBadge('Error', 'error');
      showPanel('localModelError');
      const friendly = friendlyModelError(status.error || status.reason);
      byId<HTMLElement>('localModelErrorText').textContent = [friendly.display, friendly.hint]
        .filter(Boolean)
        .join(' ');
      break;
    }

    default:
      setBadge('Error', 'error');
      showPanel('localModelError');
      byId<HTMLElement>('localModelErrorText').textContent = 'The local model reported an unknown state. Retry or delete its data.';
  }
}

function setControlsDisabled(disabled: boolean): void {
  for (const id of [
    'downloadLocalModel',
    'cancelLocalModelDownload',
    'retryLocalModel',
    'deleteLocalModel',
    'deleteLocalModelAfterError',
  ]) {
    byId<HTMLButtonElement>(id).disabled = disabled;
  }

  const deleting = busyAction === 'delete';
  byId<HTMLButtonElement>('deleteLocalModel').textContent = deleting ? 'Deleting…' : 'Delete model';
  byId<HTMLButtonElement>('deleteLocalModelAfterError').textContent = deleting ? 'Deleting…' : 'Delete model data';
}

function setBadge(text: string, className?: 'downloading' | 'ready' | 'error'): void {
  const badge = byId<HTMLElement>('localModelStatusBadge');
  badge.textContent = text;
  badge.classList.remove('downloading', 'ready', 'error');
  if (className) badge.classList.add(className);
}

function showPanel(id: string): void {
  byId<HTMLElement>(id).hidden = false;
}

function renderActionError(): void {
  const error = byId<HTMLElement>('localModelActionError');
  error.hidden = !actionError;
  error.textContent = actionError || '';
}

function friendlyModelError(message: string | undefined): { display: string; hint: string } {
  if (!message) return { display: 'The local model failed.', hint: 'Retry, or delete its data and download it again.' };
  const lowerMessage = message.toLowerCase();
  for (const [pattern, friendly] of LOCAL_MODEL_ERROR_MESSAGES) {
    if (lowerMessage.includes(pattern)) return friendly;
  }
  return { display: message, hint: 'Retry, or delete the model data and download it again.' };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element #${id}`);
  return element as T;
}
