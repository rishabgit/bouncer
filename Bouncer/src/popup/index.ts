// Shared toolbar and embedded settings for the fixed local classifier.
import type { LocalModelStatus } from '../types';
import { getStorage, setStorage } from '../shared/storage';
import { DECISION_MODEL } from '../shared/decision-model';
import { localModelStatusView, normalizeLocalModelStatus } from '../shared/engine-status-view';
import type { LocalModelStatusView } from '../shared/engine-status-view';
export { localModelStatusView };

interface StatusResponse { status?: unknown; success?: boolean; error?: string }
type StatusReadFailure = 'outdated' | 'startup' | 'unavailable';

/** An event received during an async read always wins over that read. */
export class SnapshotRevision {
  private revision = 0;
  beginSnapshot(): number { return this.revision; }
  markEvent(): void { this.revision += 1; }
  isCurrent(snapshotRevision: number): boolean { return snapshotRevision === this.revision; }
}

const statusRevision = new SnapshotRevision();
const filterRepliesRevision = new SnapshotRevision();
let currentStatus: LocalModelStatus = { state: 'checking', message: '', revision: 0 };
let checking = true;
let initializationError: string | null = null;
let statusReadFailure: StatusReadFailure | null = null;
let initialized = false;

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { void init().catch(() => showInitializationError()); });
}

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  setupModalMode();
  setupStorageListener();
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

function acceptStatus(value: unknown): boolean {
  const status = normalizeLocalModelStatus(value);
  if (status.revision < currentStatus.revision) return false;
  currentStatus = status;
  statusReadFailure = null;
  return true;
}

function setupStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.nativeModelStatus && acceptStatus(changes.nativeModelStatus.newValue)) {
      statusRevision.markEvent();
      checking = false;
    }
    if (changes.filterReplies) {
      filterRepliesRevision.markEvent();
      byId<HTMLInputElement>('enableFilterReplies').checked = changes.filterReplies.newValue !== false;
    }
    render();
  });
}

async function loadFilterReplies(): Promise<void> {
  const snapshot = filterRepliesRevision.beginSnapshot();
  const data = await getStorage(['filterReplies']);
  if (filterRepliesRevision.isCurrent(snapshot)) byId<HTMLInputElement>('enableFilterReplies').checked = data.filterReplies !== false;
}

async function refreshStatus(): Promise<void> {
  statusRevision.markEvent();
  const snapshot = statusRevision.beginSnapshot();
  checking = true;
  render();
  try {
    // Status reads check model availability without loading it.
    const response = await chrome.runtime.sendMessage<{ type: 'getLocalModelStatus' }, StatusResponse | undefined>({ type: 'getLocalModelStatus' });
    if (!statusRevision.isCurrent(snapshot)) return;
    if (response?.error || !response?.status || !acceptStatus(response.status)) {
      statusReadFailure = classifyStatusReadFailure(response);
    }
  } catch {
    if (!statusRevision.isCurrent(snapshot)) return;
    statusReadFailure = 'unavailable';
  }
  checking = false;
  render();
}

function classifyStatusReadFailure(response?: StatusResponse): StatusReadFailure {
  if (response?.error === 'Unknown message type: getLocalModelStatus') return 'outdated';
  if (response?.success === false && typeof response.error === 'string' && response.error) return 'startup';
  return 'unavailable';
}

function statusReadFailureText(failure: StatusReadFailure): string {
  switch (failure) {
    case 'outdated': return 'Bouncer’s background is out of date. Reload Bouncer in your browser’s extensions page, then reopen settings. Your filters will be kept.';
    case 'startup': return 'Bouncer’s background could not finish starting. Check status again. If this continues, reload Bouncer in your browser’s extensions page and reopen settings. Your filters will be kept.';
    case 'unavailable': return 'Bouncer’s AI status is unavailable. Check status again. Your filters and manual controls are unchanged.';
  }
}

function setupControlListeners(): void {
  byId<HTMLButtonElement>('checkLocalModelStatus').addEventListener('click', () => { if (!checking) void refreshStatus(); });
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
}

function render(): void {
  setText('localModelResourceHint', `Uses Llama.app and the ${DECISION_MODEL.display} model. Posts and filter phrases are processed on your device.`);
  const view: LocalModelStatusView = checking ? localModelStatusView({ state: 'checking', message: '', revision: 0 })
    : statusReadFailure ? { badge: 'Unavailable', tone: 'error', text: 'Your current AI status could not be checked.' }
      : localModelStatusView(currentStatus);
  const badge = byId<HTMLElement>('localModelStatusBadge');
  if (badge.textContent !== view.badge) badge.textContent = view.badge;
  badge.classList.remove('busy', 'ready', 'error');
  if (view.tone) badge.classList.add(view.tone);
  setText('localModelStatusText', view.text);
  const checkStatus = byId<HTMLButtonElement>('checkLocalModelStatus');
  checkStatus.disabled = checking;
  checkStatus.textContent = checking ? 'Checking…' : 'Check status';
  byId<HTMLElement>('localModelSetupHelp').hidden = !view.help && !view.settings;
  setText('localModelSetupHelpText', view.help || '');
  const settings = byId<HTMLElement>('localModelSettings');
  settings.hidden = !view.settings;
  setText('localModelSettingsText', view.settings || '');
  const error = byId<HTMLElement>('localModelActionError');
  const errorText = statusReadFailure ? statusReadFailureText(statusReadFailure) : initializationError;
  error.hidden = !errorText;
  setText('localModelActionError', errorText || '');
}

function setText(id: string, text: string): void {
  const element = byId<HTMLElement>(id);
  if (element.textContent !== text) element.textContent = text;
}
function showInitializationError(): void {
  checking = false;
  initializationError = 'Couldn’t open settings completely. Reopen settings to try again.';
  render();
}
function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing settings element: ${id}`);
  return element as T;
}
