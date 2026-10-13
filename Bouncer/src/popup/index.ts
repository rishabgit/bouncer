// Bouncer popup: the fixed local Ollama connection and ordinary feed settings.

import type { LocalModelStatus } from '../types';
import { getStorage, setStorage } from '../shared/storage';

export const OLLAMA_PERMISSION = 'http://127.0.0.1:11434/*';
const EXTENSION_ORIGIN = 'chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm';

type NativeAction = 'connectNativeModel' | 'retryNativeModel' | 'recoverNativeModel';
interface NativeStatusResponse {
  status?: LocalModelStatus;
  success?: boolean;
  error?: string;
}

/** An event received during an async read always wins over that read. */
export class SnapshotRevision {
  private revision = 0;
  beginSnapshot(): number { return this.revision; }
  markEvent(): void { this.revision += 1; }
  isCurrent(snapshotRevision: number): boolean { return snapshotRevision === this.revision; }
}

interface NativeStatusView {
  badge: string;
  tone?: 'busy' | 'ready' | 'error';
  text: string;
  connect?: boolean;
  retry?: boolean;
  recover?: boolean;
  help?: string;
}

export function nativeStatusView(status: LocalModelStatus): NativeStatusView {
  switch (status.state) {
    case 'not_connected':
      return { badge: 'Not connected', text: 'Connect Bouncer to the local Ollama service. Posts stay visible while disconnected.', connect: true };
    case 'ready':
      return { badge: 'Ready', tone: 'ready', text: 'Loads when needed. Ollama releases the model after idle use.' };
    case 'loading':
      return { badge: 'Loading…', tone: 'busy', text: 'Loading Gemma for this request…' };
    case 'filtering':
      return { badge: 'Filtering', tone: 'ready', text: 'Filtering with Gemma on this Mac.' };
    case 'paused':
      return { badge: 'Paused', text: status.message || 'Filtering paused while another local model is loaded.', retry: true };
    case 'missing_model':
      return {
        badge: 'Setup needed', tone: 'error', text: 'The pinned Bouncer model is missing. Complete the one-time model setup, then Retry.', retry: true,
        help: 'During setup, run node scripts/prepare-native-model.mjs from the Bouncer repository, then Retry. Follow the Bouncer setup guide (docs/models.md). The extension does not download or install models.',
      };
    case 'blocked':
      return {
        badge: 'Blocked', tone: 'error', text: status.message || 'Bouncer could not verify the local setup.', retry: true,
        help: blockedStatusHelp(status.reason),
      };
    case 'recovery_required':
      return {
        badge: 'Recovery needed', tone: 'error', text: 'Filtering paused after an interrupted local request. Manual Bounce and Restore still work.', retry: true, recover: status.recoveryQualified === true,
        help: 'Bouncer cannot confirm that the previous native request has stopped. Retry only checks service metadata; it does not clear this recovery pause. Follow the controlled recovery procedure in the Bouncer setup guide.',
      };
    case 'error':
      return {
        badge: 'Unavailable', tone: 'error',
        text: status.reason === 'connection' || status.reason === 'unreachable'
          ? 'Can’t reach Ollama. Open the Ollama app on this Mac, then Retry.'
          : status.message || 'Can’t reach Ollama. Open the Ollama app on this Mac, then Retry.',
        retry: true,
      };
  }
}

function blockedStatusHelp(reason: string | undefined): string {
  switch (reason) {
    case 'origin_rejected':
      return `Add ${EXTENSION_ORIGIN} to the existing OLLAMA_ORIGINS allowed set, preserving its other entries, then restart Ollama and Retry. Keep its loopback binding and cloud-disabled settings.`;
    case 'model_unqualified':
      return 'Use a qualified Bouncer build with its accepted Gemma 4 E2B model. Follow the model qualification steps in the Bouncer setup guide (docs/models.md). Retry only checks the current setup.';
    case 'model_identity_changed':
      return 'Restore the pinned Bouncer model using the documented setup recipe in docs/models.md, then Retry. Bouncer must verify the accepted local model identity before filtering.';
    case 'runtime_incompatible':
      return 'Follow docs/models.md to match this Bouncer build with its qualified Ollama version, then Retry.';
    case 'metadata_invalid':
      return 'Repair the fixed local model setup using docs/models.md, then Retry. Bouncer must verify its weights, text-only configuration and metadata before filtering.';
    default:
      return 'Resolve the reported setup problem using the Bouncer setup guide (docs/models.md), then Retry.';
  }
}

const statusRevision = new SnapshotRevision();
const filterRepliesRevision = new SnapshotRevision();
let nativeStatus: LocalModelStatus = { state: 'not_connected', message: '', revision: 0 };
let statusChecking = true;
let busyAction = false;
let actionError: string | null = null;
let initialized = false;

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    init().catch(err => console.error('[Popup] Initialization failed:', err));
  });
}

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  setupModalMode();
  // Install listeners before starting snapshots.
  setupStorageListener();
  setupPermissionListener();
  setupControlListeners();
  await Promise.all([loadFilterReplies(), refreshNativeStatus()]);
}

function setupModalMode(): void {
  if (window.self === window.top) return;
  document.body.classList.add('modal-mode');
  for (const button of document.querySelectorAll<HTMLButtonElement>('.modal-close-btn')) {
    button.addEventListener('click', () => window.parent.postMessage({ type: 'closeSettingsModal' }, '*'));
  }
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

function acceptStatus(status: LocalModelStatus): void {
  if (status.revision < nativeStatus.revision) return;
  nativeStatus = status;
}

function setupStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.nativeModelStatus) {
      statusRevision.markEvent();
      const status = changes.nativeModelStatus.newValue as LocalModelStatus | undefined;
      if (status) acceptStatus(status);
      statusChecking = false;
      renderNativeStatus();
    }
    if (changes.filterReplies) {
      filterRepliesRevision.markEvent();
      byId<HTMLInputElement>('enableFilterReplies').checked = changes.filterReplies.newValue !== false;
    }
  });
}

function setupPermissionListener(): void {
  // Recheck actual permission rather than assuming a permission event's shape.
  chrome.permissions.onRemoved.addListener(() => {
    statusRevision.markEvent();
    void refreshNativeStatus();
  });
  chrome.permissions.onAdded.addListener(() => {
    statusRevision.markEvent();
    void refreshNativeStatus();
  });
}

async function loadFilterReplies(): Promise<void> {
  const snapshot = filterRepliesRevision.beginSnapshot();
  const data = await getStorage(['filterReplies']);
  if (filterRepliesRevision.isCurrent(snapshot)) {
    byId<HTMLInputElement>('enableFilterReplies').checked = data.filterReplies !== false;
  }
}

async function refreshNativeStatus(): Promise<void> {
  const snapshot = statusRevision.beginSnapshot();
  try {
    const granted = await chrome.permissions.contains({ origins: [OLLAMA_PERMISSION] });
    if (!statusRevision.isCurrent(snapshot)) return;
    if (!granted) {
      nativeStatus = { state: 'not_connected', message: '', revision: nativeStatus.revision };
    } else {
      const response: NativeStatusResponse | undefined = await chrome.runtime.sendMessage({ type: 'getNativeModelStatus' });
      if (!statusRevision.isCurrent(snapshot)) return;
      if (response?.error) throw new Error(response.error);
      if (!response?.status) throw new Error('The local service status was not returned.');
      acceptStatus(response.status);
    }
  } catch (err) {
    if (!statusRevision.isCurrent(snapshot)) return;
    nativeStatus = { state: 'error', message: `Could not check Ollama: ${errorText(err)}`, revision: nativeStatus.revision };
  }
  statusChecking = false;
  renderNativeStatus();
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
  byId<HTMLButtonElement>('connectNativeModel').addEventListener('click', () => {
    // Calling request directly from the user click preserves Chrome's gesture.
    void runNativeAction('connectNativeModel');
  });
  byId<HTMLButtonElement>('retryNativeModel').addEventListener('click', () => {
    void runNativeAction('retryNativeModel');
  });
  byId<HTMLButtonElement>('recoverNativeModel').addEventListener('click', () => {
    if (nativeStatus.recoveryQualified !== true) return;
    const confirmed = window.confirm('Quit and reopen Ollama first, and leave other local clients idle. Have you restarted Ollama and confirmed that other clients are idle? This resumes filtering after the interrupted request.');
    if (confirmed) void runNativeAction('recoverNativeModel');
  });
}

async function runNativeAction(type: NativeAction): Promise<void> {
  if (busyAction) return;
  busyAction = true;
  actionError = null;
  renderNativeStatus();
  try {
    if (type === 'connectNativeModel') {
      const granted = await chrome.permissions.request({ origins: [OLLAMA_PERMISSION] });
      if (!granted) throw new Error('Connection permission was not granted. You can connect again when ready.');
    }
    // Connect/Retry checks metadata only. Neither action warms native weights.
    const response: NativeStatusResponse | undefined = await chrome.runtime.sendMessage(
      type === 'recoverNativeModel' ? { type, operatorRestartConfirmed: true } : { type },
    );
    if (response?.error || response?.success === false) throw new Error(response.error || 'Could not check Ollama.');
    await refreshNativeStatus();
  } catch (err) {
    actionError = errorText(err);
    await refreshNativeStatus();
  } finally {
    busyAction = false;
    renderNativeStatus();
  }
}

function renderNativeStatus(): void {
  const view = statusChecking
    ? { badge: 'Checking…', text: 'Checking the local service…' } as NativeStatusView
    : nativeStatusView(nativeStatus);
  const badge = byId<HTMLElement>('localModelStatusBadge');
  badge.textContent = busyAction ? 'Checking…' : view.badge;
  badge.classList.remove('busy', 'ready', 'error');
  if (busyAction) badge.classList.add('busy');
  else if (view.tone) badge.classList.add(view.tone);
  byId<HTMLElement>('nativeStatusText').textContent = view.text;
  const connect = byId<HTMLButtonElement>('connectNativeModel');
  const retry = byId<HTMLButtonElement>('retryNativeModel');
  const recover = byId<HTMLButtonElement>('recoverNativeModel');
  recover.hidden = !view.recover;
  recover.disabled = busyAction;
  connect.hidden = !view.connect;
  retry.hidden = !view.retry;
  connect.disabled = retry.disabled = busyAction;
  byId<HTMLElement>('nativeSetupHelp').hidden = !view.help;
  byId<HTMLElement>('nativeSetupHelpText').textContent = view.help || '';
  const error = byId<HTMLElement>('localModelActionError');
  error.hidden = !actionError;
  error.textContent = actionError || '';
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element #${id}`);
  return element as T;
}
