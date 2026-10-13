/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineSelection, LocalModelStatus } from '../../src/types.js';
import { engineStatusView, statusMatchesSelection } from '../../src/shared/engine-status-view.js';

const html = readFileSync(new NodeURL('../../popup.html', import.meta.url), 'utf8');
let selection: EngineSelection;
let status: LocalModelStatus;
let data: Record<string, unknown>;
let granted: boolean;
function current(state: LocalModelStatus['state'], fields: Partial<LocalModelStatus> = {}): LocalModelStatus {
  return { state, engine: selection.engine, selectionRevision: selection.revision, message: '', revision: (status?.revision ?? 0) + 1, ...fields };
}
async function flush(): Promise<void> { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function event(changes: Record<string, chrome.storage.StorageChange>): void {
  for (const [key, change] of Object.entries(changes)) data[key] = change.newValue;
  vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)![0](changes, 'local');
}
function preview(engine: 'litertlm' | 'ollama'): void {
  const input = byId<HTMLInputElement>(engine === 'litertlm' ? 'previewBrowserEngine' : 'previewNativeEngine');
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
async function open(): Promise<void> { await (await import('../../src/popup/index.js')).init(); }

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  selection = { engine: null, revision: 0 };
  status = { state: 'not_configured', engine: null, selectionRevision: 0, revision: 0, message: '' };
  data = { filterReplies: true };
  granted = false;
  chrome.permissions = {
    contains: vi.fn(async () => granted), request: vi.fn(async () => { granted = true; return true; }),
    onRemoved: { addListener: vi.fn() }, onAdded: { addListener: vi.fn() },
  } as unknown as typeof chrome.permissions;
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ ...data }));
  vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined);
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
    if (message.type === 'selectInferenceEngine') {
      selection = { engine: message.engine, revision: selection.revision + 1 };
      status = current(message.engine === 'litertlm' ? 'needs_download' : 'not_connected');
    }
    if (message.type === 'downloadBrowserModel') status = current('downloading', { receivedBytes: 0, totalBytes: 2_008_432_640 });
    if (message.type === 'cancelBrowserDownload' || message.type === 'deleteBrowserModel') status = current('needs_download');
    if (message.type === 'recoverNativeModel') { delete data.nativeOperationFence; status = current(selection.engine === 'litertlm' ? 'ready' : 'not_connected'); }
    return { success: true, selection, status };
  });
  window.confirm = vi.fn(() => true);
});

describe('explicit local engine choice', () => {
  it('recommends Browser as a preview without committing, downloading, granting or initializing on open', async () => {
    await open();
    expect(byId<HTMLInputElement>('previewBrowserEngine').checked).toBe(true);
    expect(byId('engineSelectionText').textContent).toBe('No option selected yet.');
    expect(byId('useEngineButton').textContent).toBe('Use browser AI');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'getLocalModelStatus' });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('radio and keyboard preview changes do not save choice; Use Ollama saves before a separate Connect', async () => {
    await open();
    preview('ollama');
    byId('previewNativeEngine').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(byId('engineSelectionText').textContent).toBe('No option selected yet.');
    byId('useEngineButton').click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'selectInferenceEngine', engine: 'ollama' });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(byId('connectNativeModel').hidden).toBe(false);
    expect(document.activeElement?.id).toBe('connectNativeModel');
    expect(byId('engineSelectionText').textContent).toBe('Ollama selected.');
  });

  it('uses a separate explicit download when inactive cache knowledge is absent', async () => {
    await open();
    byId('useEngineButton').click();
    await flush();
    expect(selection.engine).toBe('litertlm');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'downloadBrowserModel' });
    expect(byId('downloadBrowserModel').hidden).toBe(false);
    expect(byId('localModelStatusBadge').textContent).toBe('Download needed');
  });

  it('Download & use first saves choice and starts only the advertised explicit download', async () => {
    data.browserModelStatus = { state: 'needs_download', message: '', revision: 1, engine: 'litertlm', selectionRevision: 0 };
    await open();
    expect(byId('useEngineButton').textContent).toBe('Download & use browser AI');
    byId('useEngineButton').click();
    await flush();
    const messages = vi.mocked(chrome.runtime.sendMessage).mock.calls.map(call => call[0].type);
    expect(messages.indexOf('selectInferenceEngine')).toBeLessThan(messages.indexOf('downloadBrowserModel'));
    expect(byId('engineSelectionText').textContent).toBe('Browser AI selected.');
    expect(byId('cancelBrowserDownload').hidden).toBe(false);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('cached Use browser AI commits without a download or GPU load', async () => {
    data.browserModelStatus = { state: 'ready', message: '', revision: 3, engine: 'litertlm', selectionRevision: 0 };
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if (message.type === 'selectInferenceEngine') { selection = { engine: 'litertlm', revision: 1 }; status = current('ready'); }
      return { success: true, selection, status };
    });
    await open();
    byId('useEngineButton').click();
    await flush();
    expect(byId('nativeStatusText').textContent).toContain('Loads when needed');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'downloadBrowserModel' });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'retryLocalModel' });
  });

  it('keeps saved choice on failed setup and never falls back', async () => {
    selection = { engine: 'litertlm', revision: 1 };
    status = current('needs_download');
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if (message.type === 'downloadBrowserModel') { status = current('error', { reason: 'download_failed' }); return { success: false, selection, status, error: 'Network interrupted' }; }
      return { success: true, selection, status };
    });
    await open();
    byId('downloadBrowserModel').click();
    await flush();
    expect(byId('engineSelectionText').textContent).toBe('Browser AI selected.');
    expect(byId('localModelStatusBadge').textContent).toBe('Download failed');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'selectInferenceEngine', engine: 'ollama' });
    expect(byId<HTMLInputElement>('enableFilterReplies').disabled).toBe(false);
  });
});

describe('selected engine status ownership', () => {
  it.each(['litertlm', 'ollama'] as const)('keeps an authoritative no-choice revision zero ahead of a conflicting %s event', async engine => {
    await open();
    event({
      engineSelection: { newValue: { engine, revision: 0 } },
      localModelStatus: { newValue: { state: 'ready', engine, selectionRevision: 0, revision: 100, message: '' } },
    });
    expect(byId('engineSelectionText').textContent).toBe('No option selected yet.');
    expect(byId('localModelStatusBadge').textContent).toBe('Choose an option');
  });

  it.each(['litertlm', 'ollama'] as const)('accepts the first authoritative %s selection at revision zero and rejects a later conflict', async engine => {
    selection = { engine, revision: 0 };
    status = current('ready');
    granted = true;
    await open();
    expect(byId('engineSelectionText').textContent).toBe(engine === 'litertlm' ? 'Browser AI selected.' : 'Ollama selected.');
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
    const conflictingEngine = engine === 'litertlm' ? 'ollama' : 'litertlm';
    event({
      engineSelection: { newValue: { engine: conflictingEngine, revision: 0 } },
      localModelStatus: { newValue: { state: 'error', engine: conflictingEngine, selectionRevision: 0, revision: 100, message: '' } },
    });
    expect(byId('engineSelectionText').textContent).toBe(engine === 'litertlm' ? 'Browser AI selected.' : 'Ollama selected.');
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
  });

  it.each(['litertlm', 'ollama'] as const)('accepts a %s revision-zero listener event before the first snapshot finishes', async engine => {
    granted = true;
    let resolve!: (response: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(done => { resolve = done; }));
    const opening = open();
    await flush();
    event({
      engineSelection: { newValue: { engine, revision: 0 } },
      localModelStatus: { newValue: { state: 'ready', engine, selectionRevision: 0, revision: 2, message: '' } },
    });
    resolve({ success: true, selection: { engine: null, revision: 0 }, status: { state: 'not_configured', engine: null, selectionRevision: 0, revision: 0, message: '' } });
    await opening;
    expect(byId('engineSelectionText').textContent).toBe(engine === 'litertlm' ? 'Browser AI selected.' : 'Ollama selected.');
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
  });

  it('compares status revisions only within an exact engine and selection identity', () => {
    const browserSelection = { engine: 'litertlm', revision: 4 } as const;
    expect(statusMatchesSelection({ state: 'ready', message: '', revision: 999, engine: 'ollama', selectionRevision: 4 }, browserSelection)).toBe(false);
    expect(statusMatchesSelection({ state: 'ready', message: '', revision: 999, engine: 'litertlm', selectionRevision: 3 }, browserSelection)).toBe(false);
    expect(statusMatchesSelection({ state: 'ready', message: '', revision: 999 }, browserSelection)).toBe(false);
    expect(statusMatchesSelection({ state: 'ready', message: '', revision: 1, engine: 'litertlm', selectionRevision: 4 }, browserSelection)).toBe(true);
  });

  it('ignores inactive progress/native Ready and accepts a lower revision after a genuine switch', async () => {
    selection = { engine: 'litertlm', revision: 2 };
    status = current('downloading', { revision: 90, receivedBytes: 1_004_216_320, totalBytes: 2_008_432_640 });
    granted = true;
    await open();
    expect(byId('browserDownloadProgressText').textContent).toContain('50%');
    event({ nativeModelStatus: { newValue: { state: 'ready', revision: 999, engine: 'ollama', selectionRevision: 1, message: '' } } });
    event({ localModelStatus: { newValue: { state: 'ready', revision: 999, engine: 'litertlm', selectionRevision: 1, message: '' } } });
    expect(byId('localModelStatusBadge').textContent).toBe('Downloading…');
    selection = { engine: 'ollama', revision: 3 };
    status = current('ready', { revision: 1 });
    event({ engineSelection: { newValue: selection }, localModelStatus: { newValue: status } });
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
    expect(byId('engineSelectionText').textContent).toBe('Ollama selected.');
    expect(byId('browserDownloadProgress').hidden).toBe(true);
  });

  it('shows physical cancellation, preserves preference and rejects late progress', async () => {
    selection = { engine: 'litertlm', revision: 1 };
    status = current('downloading', { revision: 4, receivedBytes: 1_000_000, totalBytes: 2_008_432_640 });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if (message.type === 'cancelBrowserDownload') status = current('canceling');
      return { success: true, selection, status };
    });
    await open();
    byId('cancelBrowserDownload').click();
    await flush();
    expect(byId('localModelStatusBadge').textContent).toBe('Finishing cancellation…');
    expect(byId('browserDownloadProgress').hidden).toBe(true);
    status = current('needs_download', { revision: 6 });
    event({ localModelStatus: { newValue: status } });
    event({ localModelStatus: { newValue: current('downloading', { revision: 4, receivedBytes: 2_000_000 }) } });
    expect(byId('localModelStatusBadge').textContent).toBe('Download needed');
    expect(byId('engineSelectionText').textContent).toBe('Browser AI selected.');
  });

  it('offers Cancel during GPU preparation without displaying download progress', async () => {
    selection = { engine: 'litertlm', revision: 2 };
    status = current('loading', { progress: 100 });
    await open();
    expect(byId('localModelStatusBadge').textContent).toBe('Preparing…');
    expect(byId('browserDownloadProgress').hidden).toBe(true);
    expect(byId('cancelBrowserDownload').hidden).toBe(false);
    byId('cancelBrowserDownload').click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'cancelBrowserDownload' });
    expect(byId('engineSelectionText').textContent).toBe('Browser AI selected.');
  });

  it('discards late action failure from the old choice', async () => {
    selection = { engine: 'litertlm', revision: 1 };
    status = current('needs_download');
    let resolve!: (value: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      if (message.type === 'downloadBrowserModel') return new Promise(done => { resolve = done; });
      return { success: true, selection, status };
    });
    await open();
    byId('downloadBrowserModel').click();
    const oldSelection = selection;
    selection = { engine: 'ollama', revision: 2 };
    status = current('not_connected', { revision: 1 });
    event({ engineSelection: { newValue: selection }, localModelStatus: { newValue: status } });
    resolve({ success: false, selection: oldSelection, status: { state: 'error', engine: 'litertlm', selectionRevision: 1, revision: 99, message: '' }, error: 'Old failure' });
    await flush();
    expect(byId('engineSelectionText').textContent).toBe('Ollama selected.');
    expect(byId('localModelActionError').hidden).toBe(true);
    expect(byId('localModelStatusBadge').textContent).toBe('Not connected');
  });
});

describe('storage and native recovery', () => {
  it.each(['litertlm', 'ollama'] as const)('keeps retained browser files deletable after cancellation while %s is selected', async engine => {
    selection = { engine, revision: 2 };
    const retainedStatus: LocalModelStatus = { state: 'paused', engine: 'litertlm', selectionRevision: 2, reason: 'browser_cancelled', revision: 3, message: '' };
    status = engine === 'litertlm' ? retainedStatus : current('ready');
    data.browserModelStatus = retainedStatus;
    granted = true;
    await open();
    expect(byId('browserStorageControls').hidden).toBe(false);
    expect(byId<HTMLButtonElement>('deleteBrowserModel').disabled).toBe(false);
    byId('deleteBrowserModel').click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'deleteBrowserModel' });
    expect(byId('engineSelectionText').textContent).toBe(engine === 'litertlm' ? 'Browser AI selected.' : 'Ollama selected.');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'downloadBrowserModel' });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('confirms browser file deletion and keeps choice/manual settings', async () => {
    selection = { engine: 'litertlm', revision: 2 };
    status = current('ready');
    await open();
    byId('deleteBrowserModel').click();
    await flush();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('about 2 GB'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'deleteBrowserModel' });
    expect(byId('engineSelectionText').textContent).toBe('Browser AI selected.');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(byId('downloadBrowserModel').hidden).toBe(false);
  });

  it('recovers previous Ollama work while Browser stays selected, requesting permission separately', async () => {
    selection = { engine: 'litertlm', revision: 5 };
    status = current('recovery_required', { recoveryQualified: true });
    data.nativeOperationFence = { operationId: 'synthetic' };
    await open();
    expect(byId('nativeStatusText').textContent).toContain('Browser AI selected');
    expect(byId('connectNativeModel').hidden).toBe(false);
    expect(byId('recoverNativeModel').hidden).toBe(true);
    expect(byId('retryNativeModel').hidden).toBe(true);
    byId('connectNativeModel').click();
    await flush();
    expect(byId('recoverNativeModel').hidden).toBe(false);
    expect(byId('retryNativeModel').hidden).toBe(true);
    expect(window.confirm).not.toHaveBeenCalled();
    byId('recoverNativeModel').click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'recoverNativeModel', operatorRestartConfirmed: true });
    expect(byId('engineSelectionText').textContent).toBe('Browser AI selected.');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'selectInferenceEngine', engine: 'ollama' });
  });

  it.each(['litertlm', 'ollama'] as const)('offers setup guidance without ineffective Retry for unqualified %s recovery', async engine => {
    selection = { engine, revision: 3 };
    status = current('recovery_required', { recoveryQualified: false });
    granted = true;
    await open();
    expect(byId('retryNativeModel').hidden).toBe(true);
    expect(byId('retryLocalModel').hidden).toBe(true);
    expect(byId('recoverNativeModel').hidden).toBe(true);
    expect(byId('nativeSetupHelp').hidden).toBe(false);
    expect(byId('localSetupLink').getAttribute('href')).toBe('setup.html');
  });

  it('offers qualified Ollama recovery without ordinary Retry', async () => {
    selection = { engine: 'ollama', revision: 4 };
    status = current('recovery_required', { recoveryQualified: true });
    granted = true;
    await open();
    expect(byId('retryNativeModel').hidden).toBe(true);
    expect(byId('recoverNativeModel').hidden).toBe(false);
  });

  it('does not overwrite a newer filter setting when an older write fails', async () => {
    await open();
    let reject!: (error: Error) => void;
    vi.mocked(chrome.storage.local.set).mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const checkbox = byId<HTMLInputElement>('enableFilterReplies');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    event({ filterReplies: { newValue: true } });
    reject(new Error('Write failed'));
    await flush();
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
    expect(byId('filterRepliesError').hidden).toBe(false);
  });
});

describe('shared browser copy', () => {
  it('uses real byte progress and separates verification from GPU preparation', () => {
    const browser = { engine: 'litertlm' as const, selectionRevision: 1, revision: 1, message: '' };
    expect(engineStatusView({ ...browser, state: 'downloading', progress: 80 }).progress).toBeUndefined();
    const complete = engineStatusView({ ...browser, state: 'downloading', receivedBytes: 2_008_432_640, totalBytes: 2_008_432_640 });
    expect(complete.badge).toBe('Verifying…');
    expect(complete.progressText).toContain('100%');
    expect(engineStatusView({ ...browser, state: 'loading', progress: 100 }).badge).toBe('Preparing…');
  });
  it('offers manual engine choice without switching after WebGPU failure', () => {
    const view = engineStatusView({ state: 'error', engine: 'litertlm', selectionRevision: 1, revision: 1, message: 'Internal GPU diagnostic', reason: 'webgpu_unavailable' });
    expect(view.badge).toBe('GPU unavailable');
    expect(view.details).toContain('will not switch');
    expect(view.text).not.toContain('Internal GPU diagnostic');
    expect(view.text).not.toContain('reach Ollama');
  });
});
