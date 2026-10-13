/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalModelStatus } from '../../src/types.js';

const popupHTML = readFileSync(new NodeURL('../../popup.html', import.meta.url), 'utf8');
const ready: LocalModelStatus = { state: 'ready', message: '', revision: 2 };
let granted = false;
let removed: () => void;
let added: () => void;

async function flush(): Promise<void> { for (let i = 0; i < 25; i++) await Promise.resolve(); }

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = popupHTML.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  granted = false;
  chrome.permissions = {
    contains: vi.fn(async () => granted),
    request: vi.fn(async () => { granted = true; return true; }),
    onRemoved: { addListener: vi.fn(listener => { removed = listener; }) },
    onAdded: { addListener: vi.fn(listener => { added = listener; }) },
  } as unknown as typeof chrome.permissions;
  vi.mocked(chrome.storage.local.get).mockResolvedValue({ filterReplies: true });
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async () => ({ success: true, status: ready }));
});

describe('native popup permission', () => {
  it('does not request permission or call the service when opening disconnected settings', async () => {
    const popup = await import('../../src/popup/index.js');
    await popup.init();
    expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: ['http://127.0.0.1:11434/*'] });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById('connectNativeModel')?.hidden).toBe(false);
  });

  it('requests only the exact endpoint from a Connect click and metadata-checks afterward', async () => {
    const popup = await import('../../src/popup/index.js');
    await popup.init();
    document.getElementById('connectNativeModel')!.click();
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['http://127.0.0.1:11434/*'] });
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'connectNativeModel' });
    expect(document.getElementById('localModelStatusBadge')?.textContent).toBe('Ready');
    expect(document.getElementById('nativeStatusText')?.textContent).toContain('Loads when needed');
  });

  it('keeps manual settings available after denial and sends no connection action', async () => {
    vi.mocked(chrome.permissions.request).mockResolvedValue(false);
    const popup = await import('../../src/popup/index.js');
    await popup.init();
    document.getElementById('connectNativeModel')!.click();
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById('localModelActionError')?.textContent).toContain('not granted');
    expect(document.querySelector<HTMLInputElement>('#enableFilterReplies')?.disabled).toBe(false);
  });

  it('handles permission removal and subsequent addition through actual contains checks', async () => {
    granted = true;
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

  it('checks authorized readiness without requesting permission or inference', async () => {
    granted = true;
    const popup = await import('../../src/popup/index.js');
    await popup.init();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'getNativeModelStatus' });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('rejects a late status snapshot after a newer storage event', async () => {
    granted = true;
    let resolve!: (value: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => new Promise(done => { resolve = done; }));
    const popup = await import('../../src/popup/index.js');
    const loading = popup.init();
    await flush();
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)![0];
    listener({ nativeModelStatus: { newValue: { state: 'blocked', reason: 'origin_rejected', message: 'Origin rejected', revision: 3 } } }, 'local');
    resolve({ status: ready });
    await loading;
    expect(document.getElementById('localModelStatusBadge')?.textContent).toBe('Blocked');
    expect(document.getElementById('nativeSetupHelpText')?.textContent).toContain('chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm');
  });
});

describe('native setup and recovery copy', () => {
  it.each([
    ['model_unqualified', 'The fixed native classifier has not been qualified.', 'qualified Bouncer build'],
    ['model_identity_changed', 'The fixed classifier digest changed.', 'Restore the pinned Bouncer model'],
    ['runtime_incompatible', 'Bouncer requires its qualified Ollama runtime.', 'qualified Ollama version'],
    ['metadata_invalid', 'The fixed classifier metadata changed.', 'Repair the fixed local model setup'],
    [undefined, 'The local setup could not be verified.', 'Resolve the reported setup problem'],
  ])('keeps %s diagnostics specific without recommending origin edits or a restart', async (reason, message, expectedHelp) => {
    const { nativeStatusView } = await import('../../src/popup/index.js');
    const view = nativeStatusView({ state: 'blocked', reason, message: message!, revision: 1 });
    expect(view.text).toBe(message);
    expect(view.help).toContain(expectedHelp);
    expect(view.retry).toBe(true);
    expect(`${view.text} ${view.help}`).not.toMatch(/OLLAMA_ORIGINS|chrome-extension:\/\/|restart/i);
  });

  it('shows exact-origin repair only for the explicit origin_rejected reason', async () => {
    const { nativeStatusView } = await import('../../src/popup/index.js');
    const view = nativeStatusView({ state: 'blocked', reason: 'origin_rejected', message: 'Ollama rejected the metadata POST with HTTP 403.', revision: 1 });
    expect(view.text).toBe('Ollama rejected the metadata POST with HTTP 403.');
    expect(view.help).toContain('chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm');
    expect(view.help).toContain('OLLAMA_ORIGINS');
    expect(view.help).toContain('preserving its other entries');
    expect(view.help).toContain('restart Ollama');
  });

  it('does not treat an absent reason or a diagnostic mentioning HTTP 403 as an origin rejection', async () => {
    const { nativeStatusView } = await import('../../src/popup/index.js');
    for (const reason of [undefined, null, 'unknown']) {
      const status = { state: 'blocked', reason, message: 'Unverified setup diagnostic: HTTP 403.', revision: 1 } as LocalModelStatus;
      const view = nativeStatusView(status);
      expect(view.text).toBe(status.message);
      expect(view.help).not.toMatch(/OLLAMA_ORIGINS|chrome-extension:\/\/|restart/i);
    }
  });

  it('keeps the operator restart action hidden until its recovery path qualifies', async () => {
    const { nativeStatusView } = await import('../../src/popup/index.js');
    const unqualified = nativeStatusView({ state: 'recovery_required', message: '', revision: 1 });
    expect(unqualified.recover).toBe(false);
    expect(unqualified.help).toContain('does not clear');
    expect(nativeStatusView({ state: 'recovery_required', message: '', revision: 2, recoveryQualified: true }).recover).toBe(true);
  });
  it('names service-open and one-time pinned model setup actions without browser downloads', async () => {
    const { nativeStatusView } = await import('../../src/popup/index.js');
    expect(nativeStatusView({ state: 'error', message: '', revision: 1, reason: 'connection' }).text).toContain('Open the Ollama app');
    expect(nativeStatusView({ state: 'missing_model', message: '', revision: 2 }).help).toContain('node scripts/prepare-native-model.mjs');
  });
});
