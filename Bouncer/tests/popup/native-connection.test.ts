/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineSelection, LocalModelStatus } from '../../src/types.js';

const popupHTML = readFileSync(new NodeURL('../../popup.html', import.meta.url), 'utf8');
const selection: EngineSelection = { engine: 'ollama', revision: 1 };
const ready: LocalModelStatus = { state: 'ready', engine: 'ollama', selectionRevision: 1, message: '', revision: 2 };
let granted = false;
let removed: () => void;
let added: () => void;
let status: LocalModelStatus;
async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = popupHTML.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  granted = false;
  status = { state: 'not_connected', engine: 'ollama', selectionRevision: 1, message: '', revision: 1 };
  chrome.permissions = {
    contains: vi.fn(async () => granted),
    request: vi.fn(async () => { granted = true; return true; }),
    onRemoved: { addListener: vi.fn(listener => { removed = listener; }) },
    onAdded: { addListener: vi.fn(listener => { added = listener; }) },
  } as unknown as typeof chrome.permissions;
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ filterReplies: true });
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
    if (message.type === 'connectNativeModel') status = ready;
    return { success: true, selection, status };
  });
});

describe('native popup permission', () => {
  it('reads status without requesting permission or starting native setup on open', async () => {
    const popup = await import('../../src/popup/index.js');
    await popup.init();
    expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: ['http://127.0.0.1:11434/*'] });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'getLocalModelStatus' });
    expect(document.getElementById('connectNativeModel')?.hidden).toBe(false);
  });

  it('requests the exact endpoint directly from Connect and checks metadata afterward', async () => {
    const popup = await import('../../src/popup/index.js');
    await popup.init();
    document.getElementById('connectNativeModel')!.click();
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['http://127.0.0.1:11434/*'] });
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'connectNativeModel' });
    expect(document.getElementById('localModelStatusBadge')?.textContent).toBe('Ready');
    expect(document.getElementById('nativeStatusText')?.textContent).toContain('Loads when needed');
    expect(document.getElementById('nativeStatusText')?.textContent).toContain('may release');
  });

  it('preserves choice and manual settings after denial', async () => {
    vi.mocked(chrome.permissions.request).mockResolvedValue(false);
    const popup = await import('../../src/popup/index.js');
    await popup.init();
    document.getElementById('connectNativeModel')!.click();
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'connectNativeModel' });
    expect(document.getElementById('localModelActionError')?.textContent).toContain('not granted');
    expect(document.getElementById('engineSelectionText')?.textContent).toBe('Ollama selected.');
    expect(document.querySelector<HTMLInputElement>('#enableFilterReplies')?.disabled).toBe(false);
  });

  it('handles permission removal and addition through actual contains checks', async () => {
    granted = true;
    status = ready;
    const popup = await import('../../src/popup/index.js');
    await popup.init();
    granted = false;
    removed();
    await flush();
    expect(document.getElementById('localModelStatusBadge')?.textContent).toBe('Not connected');
    granted = true;
    added();
    await flush();
    expect(document.getElementById('localModelStatusBadge')?.textContent).toBe('Ready');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('rejects a late read after a newer selected-engine storage event', async () => {
    granted = true;
    let resolve!: (value: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(done => { resolve = done; }));
    const popup = await import('../../src/popup/index.js');
    const loading = popup.init();
    await flush();
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)![0];
    listener({ engineSelection: { newValue: selection }, localModelStatus: { newValue: { state: 'blocked', engine: 'ollama', selectionRevision: 1, reason: 'origin_rejected', message: 'HTTP 403 diagnostic', revision: 3 } } }, 'local');
    resolve({ selection, status: ready });
    await loading;
    expect(document.getElementById('localModelStatusBadge')?.textContent).toBe('Blocked');
    expect(document.getElementById('nativeSetupHelpText')?.textContent).toContain('chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm');
    expect(document.getElementById('nativeStatusText')?.textContent).not.toContain('HTTP 403');
  });
});

describe('native setup and recovery copy', () => {
  it.each([
    ['model_unqualified', 'qualified Bouncer build'],
    ['model_identity_changed', 'Restore the pinned Bouncer model'],
    ['runtime_incompatible', 'qualified Ollama version'],
    ['metadata_invalid', 'Repair the fixed local model setup'],
    [undefined, 'Resolve the reported setup problem'],
  ])('keeps %s help specific without recommending origin edits', async (reason, expectedHelp) => {
    const { nativeStatusView } = await import('../../src/popup/index.js');
    const view = nativeStatusView({ state: 'blocked', reason, message: 'Internal diagnostic', revision: 1 });
    expect(view.text).not.toContain('Internal diagnostic');
    expect(view.help).toContain(expectedHelp);
    expect(view.retry).toBe(true);
    expect(`${view.text} ${view.help}`).not.toMatch(/OLLAMA_ORIGINS|chrome-extension:\/\/|restart/i);
  });

  it('shows exact-origin repair only for explicit origin rejection', async () => {
    const { nativeStatusView } = await import('../../src/popup/index.js');
    const view = nativeStatusView({ state: 'blocked', reason: 'origin_rejected', message: '', revision: 1 });
    expect(view.help).toContain('OLLAMA_ORIGINS');
    expect(view.help).toContain('preserving its other entries');
    expect(view.help).toContain('restart Ollama');
    for (const reason of [undefined, null, 'unknown']) {
      const other = nativeStatusView({ state: 'blocked', reason, message: 'HTTP 403', revision: 1 } as LocalModelStatus);
      expect(other.help).not.toMatch(/OLLAMA_ORIGINS|chrome-extension:\/\/|restart/i);
    }
  });

  it('requires qualified recovery and keeps Retry distinct', async () => {
    const { nativeStatusView } = await import('../../src/popup/index.js');
    const unqualified = nativeStatusView({ state: 'recovery_required', message: '', revision: 1 });
    expect(unqualified.recover).toBe(false);
    expect(unqualified.help).toContain('does not clear');
    expect(nativeStatusView({ state: 'recovery_required', message: '', revision: 2, recoveryQualified: true }).recover).toBe(true);
  });

  it('names native setup actions and provides script-free packaged guidance', async () => {
    const { nativeStatusView } = await import('../../src/popup/index.js');
    expect(nativeStatusView({ state: 'error', message: '', revision: 1, reason: 'connection' }).text).toContain('Open the Ollama app');
    expect(nativeStatusView({ state: 'missing_model', message: '', revision: 2 }).help).toContain('node scripts/prepare-native-model.mjs');
    const help = readFileSync(new NodeURL('../../setup.html', import.meta.url), 'utf8');
    expect(help).toContain('bouncer-gemma4-e2b-qat-text:v1');
    expect(help).toContain('Ollama 0.40.3');
    expect(help).toContain('Resume after restarting Ollama');
    expect(help).not.toMatch(/<script|fetch\(|chrome\./);
  });
});
