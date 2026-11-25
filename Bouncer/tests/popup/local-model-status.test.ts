/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalModelStatus } from '../../src/types.js';
import { LLAMA_MODEL_INI } from '../../src/shared/decision-model.js';

const html = readFileSync(new NodeURL('../../popup.html', import.meta.url), 'utf8');
let status: LocalModelStatus;
let data: Record<string, unknown>;
function current(state: LocalModelStatus['state'], revision = 1): LocalModelStatus {
  return { state, message: '', revision };
}
async function flush(): Promise<void> { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function event(changes: Record<string, chrome.storage.StorageChange>): void {
  for (const [key, change] of Object.entries(changes)) data[key] = change.newValue;
  vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)![0](changes, 'local');
}
async function open(): Promise<void> { await (await import('../../src/popup/index.js')).init(); }

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  status = current('unavailable');
  data = { filterReplies: true };
  chrome.permissions = {
    contains: vi.fn(), request: vi.fn(),
    onRemoved: { addListener: vi.fn() }, onAdded: { addListener: vi.fn() },
  } as unknown as typeof chrome.permissions;
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ ...data }));
  vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined);
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => ({ success: true, status }));
});

describe('local model settings', () => {
  it('checks availability on open without requesting permissions or writing preferences', async () => {
    await open();
    expect(byId('localModelStatusText').textContent).toBe('Start Llama.app (turn on Launch at login so it is always there)');
    expect([...document.querySelectorAll('#localModelSection button')].map(button => button.textContent)).toEqual(['Check status']);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'getLocalModelStatus' });
    expect(chrome.permissions.contains).not.toHaveBeenCalled();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.permissions.onAdded.addListener).not.toHaveBeenCalled();
    expect(chrome.permissions.onRemoved.addListener).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.get).toHaveBeenCalledExactlyOnceWith(['filterReplies']);
  });

  it('shows exact model installation steps', async () => {
    status = current('missing_model');
    await open();
    expect(byId('localModelStatusText').textContent).toBe('Install the d1 model');
    expect(byId('localModelSetupHelpText').textContent).toContain('d1-2B-Q8_0.gguf');
    expect(byId('localModelSetupHelpText').textContent).toContain('Hugging Face cache');
    expect(byId('localSetupLink').getAttribute('href')).toBe('setup.html');
  });

  it('shows the shared model settings verbatim', async () => {
    status = current('settings_required');
    await open();
    expect(byId('localModelStatusText').textContent).toBe('Llama.app needs these settings');
    expect(byId('localModelSettings').hidden).toBe(false);
    expect(byId('localModelSettingsText').textContent).toBe(LLAMA_MODEL_INI);
    expect(byId('localModelSetupHelpText').textContent).toContain('hf-repo');
    expect(byId('localModelSetupHelpText').textContent).toContain('/tmp');
  });

  it('checks status after setup without a model action', async () => {
    await open();
    status = current('ready', 2);
    byId('checkLocalModelStatus').click();
    await flush();
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
    expect(byId('localModelSetupHelp').hidden).toBe(true);
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.map(call => call[0])).toEqual([
      { type: 'getLocalModelStatus' }, { type: 'getLocalModelStatus' },
    ]);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

describe('background status errors', () => {
  it('shows an old-worker failure with browser-neutral reload guidance', async () => {
    data.nativeModelStatus = current('ready', 2);
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ error: 'Unknown message type: getLocalModelStatus' });
    await open();
    expect(byId('localModelStatusBadge').textContent).toBe('Unavailable');
    expect(byId('localModelActionError').textContent).toContain('background is out of date');
    expect(byId('localModelActionError').textContent).toContain('your browser’s extensions page');
    expect(document.body.textContent).not.toContain('Unknown message type');
    expect(byId<HTMLInputElement>('enableFilterReplies').disabled).toBe(false);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it.each(['no response', 'transport rejection'] as const)('shows safe guidance for %s', async failure => {
    if (failure === 'no response') vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
    else vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(new Error('Synthetic private path /test-data/model/private-model-details'));
    await open();
    expect(byId('localModelStatusBadge').textContent).toBe('Unavailable');
    expect(byId('localModelActionError').textContent).toContain('AI status is unavailable');
    expect(byId('localModelActionError').textContent).not.toContain('out of date');
    expect(document.body.textContent).not.toContain('/test-data/model');
  });

  it('maps worker startup errors to fixed guidance without exposing diagnostics', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: false, error: 'Initialization failed: synthetic /test-data/model/private-data' });
    await open();
    expect(byId('localModelActionError').textContent).toContain('background could not finish starting');
    expect(document.body.textContent).not.toContain('Initialization failed');
    expect(document.body.textContent).not.toContain('/test-data/model');
  });

  it('clears a failed read after a successful status check', async () => {
    status = current('ready');
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce(undefined);
    await open();
    byId('checkLocalModelStatus').click();
    await flush();
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
    expect(byId('localModelActionError').hidden).toBe(true);
  });

  it('disables only Check status while checking and ignores repeated clicks', async () => {
    await open();
    let resolve!: (response: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(done => { resolve = done; }));
    byId('checkLocalModelStatus').click();
    byId('checkLocalModelStatus').click();
    expect(byId<HTMLButtonElement>('checkLocalModelStatus').disabled).toBe(true);
    expect(byId<HTMLInputElement>('enableFilterReplies').disabled).toBe(false);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    resolve({ status: current('ready', 2) });
    await flush();
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
  });
});

describe('status and setting revision ownership', () => {
  it('shows checking for an unknown response state and accepts the next valid revision', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ status: { state: 'retired-state', message: 'Stale', revision: 7 } });
    await open();
    expect(byId('localModelStatusBadge').textContent).toBe('Checking…');
    expect(byId('localModelStatusText').textContent).toBe('Checking Llama.app…');
    event({ nativeModelStatus: { newValue: current('ready', 8) } });
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
  });

  it('lets an unknown-state storage event beat a late valid snapshot reply', async () => {
    let resolve!: (reply: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(done => { resolve = done; }));
    const popup = await import('../../src/popup/index.js');
    const opening = popup.init();
    event({ nativeModelStatus: { newValue: { state: 'retired-state', message: 'Stale', revision: 7 } } });
    resolve({ status: current('ready', 6) });
    await opening;
    expect(byId('localModelStatusBadge').textContent).toBe('Checking…');
    expect(byId('localModelStatusText').textContent).toBe('Checking Llama.app…');
  });

  it.each(['success', 'failure'] as const)('lets a status event beat a late %s reply', async response => {
    let resolve!: (reply: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(done => { resolve = done; }));
    const popup = await import('../../src/popup/index.js');
    const opening = popup.init();
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledOnce();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
    event({ nativeModelStatus: { newValue: current('ready', 3) } });
    resolve(response === 'success' ? { status } : { success: false, error: 'Synthetic stale startup failure' });
    await opening;
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
    expect(byId('localModelActionError').hidden).toBe(true);
  });

  it('rejects older storage status events', async () => {
    status = current('ready', 3);
    await open();
    event({ nativeModelStatus: { newValue: current('unavailable', 2) } });
    expect(byId('localModelStatusBadge').textContent).toBe('Ready');
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

  it('retains a filter setting event received before the initial storage read finishes', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(chrome.storage.local.get).mockImplementation(() => new Promise(done => { resolve = done; }));
    const popup = await import('../../src/popup/index.js');
    const opening = popup.init();
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledOnce();
    expect(chrome.storage.local.get).toHaveBeenCalledOnce();
    event({ filterReplies: { newValue: false } });
    resolve({ filterReplies: true });
    await opening;
    expect(byId<HTMLInputElement>('enableFilterReplies').checked).toBe(false);
  });
});
