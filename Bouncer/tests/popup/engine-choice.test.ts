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

describe('unavailable saved status', () => {
  it('shows the reported old-worker failure as unknown choice and blocks preference writes', async () => {
    data.nativeModelStatus = { state: 'ready', revision: 2, message: '' };
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ error: 'Unknown message type: getLocalModelStatus' });
    await open();
    expect(byId('engineSelectionText').textContent).toBe('Saved choice unavailable.');
    expect(byId('localModelStatusBadge').textContent).toBe('Unavailable');
    expect(byId<HTMLButtonElement>('useEngineButton').disabled).toBe(true);
    expect(byId('localModelActionError').textContent).toContain('background is out of date');
    expect(byId('localModelActionError').textContent).toContain('Reload Bouncer normally');
    expect(document.body.textContent).not.toContain('Unknown message type');
    expect(byId('checkLocalModelStatus').hidden).toBe(false);
    expect(byId<HTMLInputElement>('enableFilterReplies').disabled).toBe(false);
    preview('ollama');
    byId('useEngineButton').click();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'getLocalModelStatus' });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it.each(['no response', 'transport rejection'] as const)('uses safe unavailable guidance for %s without assuming an outdated worker', async failure => {
    if (failure === 'no response') vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
    else vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(new Error('Synthetic private path /Users/owner/private-model-details'));
    await open();
    expect(byId('engineSelectionText').textContent).toBe('Saved choice unavailable.');
    expect(byId('localModelStatusBadge').textContent).toBe('Unavailable');
    expect(byId('localModelActionError').textContent).toContain('AI status is unavailable');
    expect(byId('localModelActionError').textContent).not.toContain('out of date');
    expect(document.body.textContent).not.toContain('/Users/owner');
    expect(byId<HTMLButtonElement>('useEngineButton').disabled).toBe(true);
  });

  it('maps a real worker error envelope to fixed startup guidance without exposing diagnostics', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: false, error: 'Engine choice migration verification failed: synthetic /Users/owner/private-data' });
    await open();
    expect(byId('localModelActionError').textContent).toContain('background could not finish starting');
    expect(document.body.textContent).not.toContain('migration verification');
    expect(document.body.textContent).not.toContain('/Users/owner');
    expect(byId('engineSelectionText').textContent).toBe('Saved choice unavailable.');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('Check status recovers the authoritative native choice without setup, permission requests or preference writes', async () => {
    selection = { engine: 'ollama', revision: 0 };
    status = current('ready');
    granted = true;
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ error: 'Unknown message type: getLocalModelStatus' });
    await open();
    byId('checkLocalModelStatus').click();
    await flush();
    expect(byId('engineSelectionText').textContent).toBe('Ollama selected.');
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
    expect(byId('localModelActionError').hidden).toBe(true);
    expect(byId('checkLocalModelStatus').hidden).toBe(true);
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.map(call => call[0])).toEqual([
      { type: 'getLocalModelStatus' }, { type: 'getLocalModelStatus' },
    ]);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('disables only Check status during its own pending read and ignores repeat clicks', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce(undefined);
    await open();
    let resolve!: (response: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(done => { resolve = done; }));
    byId('checkLocalModelStatus').click();
    byId('checkLocalModelStatus').click();
    expect(byId<HTMLButtonElement>('checkLocalModelStatus').disabled).toBe(true);
    expect(byId<HTMLInputElement>('enableFilterReplies').disabled).toBe(false);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    resolve({ selection, status });
    await flush();
    expect(byId('localModelStatusBadge').textContent).toBe('Choose an option');
    expect(byId('engineSelectionText').textContent).toBe('No option selected yet.');
    expect(byId<HTMLButtonElement>('useEngineButton').disabled).toBe(false);
  });

  it.each(['resource', 'permission', 'both'] as const)('retains valid native choice/status when the auxiliary %s read fails', async failure => {
    selection = { engine: 'ollama', revision: 0 };
    status = current('ready');
    granted = true;
    if (failure !== 'permission') {
      vi.mocked(chrome.storage.local.get).mockImplementation(async keys => {
        if (Array.isArray(keys) && keys.includes('browserModelStatus')) throw new Error('Synthetic private resource diagnostic');
        return { ...data };
      });
    }
    if (failure !== 'resource') vi.mocked(chrome.permissions.contains).mockRejectedValue(new Error('Synthetic private permission diagnostic'));
    await open();
    expect(byId('engineSelectionText').textContent).toBe('Ollama selected.');
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
    expect(byId('connectNativeModel').hidden).toBe(true);
    expect(byId('localModelActionError').hidden).toBe(true);
    expect(byId('localModelStatusWarning').hidden).toBe(false);
    expect(byId('checkLocalModelStatus').hidden).toBe(false);
    expect(document.body.textContent).not.toContain('Synthetic private');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'getLocalModelStatus' });
  });

  it('requires explicit Connect rather than assuming recovery permission after a failed permission check', async () => {
    selection = { engine: 'litertlm', revision: 3 };
    status = current('recovery_required', { recoveryQualified: true });
    vi.mocked(chrome.permissions.contains).mockRejectedValue(new Error('Synthetic check failure'));
    await open();
    expect(byId('connectNativeModel').hidden).toBe(false);
    expect(byId('recoverNativeModel').hidden).toBe(true);
    expect(byId('nativeRecoveryText').textContent).toContain('permission could not be checked');
    byId('recoverNativeModel').click();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'getLocalModelStatus' });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('preserves a known choice and manual settings when a later background read fails', async () => {
    selection = { engine: 'ollama', revision: 1 };
    status = current('ready');
    granted = true;
    await open();
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(new Error('Synthetic transport failure'));
    vi.mocked(chrome.permissions.onAdded.addListener).mock.calls.at(-1)![0]({ origins: ['http://127.0.0.1:11434/*'] });
    await flush();
    expect(byId('engineSelectionText').textContent).toBe('Ollama selected.');
    expect(byId('localModelStatusBadge').textContent).toBe('Unavailable');
    expect(byId('checkLocalModelStatus').hidden).toBe(false);
    expect(byId<HTMLInputElement>('enableFilterReplies').disabled).toBe(false);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('lets an authoritative event beat a late failed status reply', async () => {
    granted = true;
    let resolve!: (response: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(done => { resolve = done; }));
    const opening = open();
    await flush();
    event({
      engineSelection: { newValue: { engine: 'ollama', revision: 0 } },
      localModelStatus: { newValue: { state: 'ready', engine: 'ollama', selectionRevision: 0, revision: 2, message: '' } },
    });
    resolve({ success: false, error: 'Synthetic stale startup failure' });
    await opening;
    expect(byId('engineSelectionText').textContent).toBe('Ollama selected.');
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
    expect(byId('localModelActionError').hidden).toBe(true);
  });

  it('rejects old auxiliary failures after a newer successful Check status', async () => {
    selection = { engine: 'ollama', revision: 0 };
    status = current('ready');
    granted = true;
    let rejectResource!: (error: Error) => void;
    let rejectPermission!: (error: Error) => void;
    let resourceReads = 0;
    vi.mocked(chrome.storage.local.get).mockImplementation(async keys => {
      if (Array.isArray(keys) && keys.includes('browserModelStatus') && resourceReads++ === 0) {
        return new Promise((_, reject) => { rejectResource = reject; });
      }
      return { ...data };
    });
    vi.mocked(chrome.permissions.contains).mockImplementationOnce(() => new Promise((_, reject) => { rejectPermission = reject; }));
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ error: 'Unknown message type: getLocalModelStatus' });
    const opening = open();
    await flush();
    byId('checkLocalModelStatus').click();
    await flush();
    rejectResource(new Error('Synthetic old resource failure'));
    rejectPermission(new Error('Synthetic old permission failure'));
    await opening;
    expect(byId('engineSelectionText').textContent).toBe('Ollama selected.');
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
    expect(byId('localModelStatusWarning').hidden).toBe(true);
    expect(byId('checkLocalModelStatus').hidden).toBe(true);
    expect(byId('connectNativeModel').hidden).toBe(true);
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
  it.each([['litertlm', true], ['litertlm', false], ['ollama', true], ['ollama', false]] as const)('offers cleanup Retry for saved %s with native permission %s without changing choice or diagnosing an Ollama outage', async (engine, permissionGranted) => {
    selection = { engine, revision: 3 };
    status = current('blocked', { reason: 'browser_cleanup_failed', message: 'Internal host diagnostic' });
    granted = permissionGranted;
    await open();
    expect(byId('localModelStatusBadge').textContent).toBe('Cleanup needed');
    expect(byId('nativeStatusText').textContent).toContain('releasing its resources');
    expect(byId('nativeStatusText').textContent).not.toContain('reach Ollama');
    expect(byId('nativeStatusText').textContent).not.toContain('Internal host diagnostic');
    const action = engine === 'litertlm' ? 'retryLocalModel' : 'retryNativeModel';
    expect(byId(action).hidden).toBe(false);
    byId(action).click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: action });
    expect(selection).toEqual({ engine, revision: 3 });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'selectInferenceEngine' }));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'downloadBrowserModel' });
  });
  it.each(['litertlm', 'ollama'] as const)('keeps native restart recovery ahead of cleanup Retry for %s', engine => {
    const view = engineStatusView({ state: 'recovery_required', engine, selectionRevision: 3, revision: 1, message: '', reason: 'recovery_required', recoveryQualified: true }, { engine, revision: 3 });
    expect(view.action).toBe('recover');
    expect(view.retry).toBe(false);
    expect(view.badge).toBe('Recovery needed');
  });
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
