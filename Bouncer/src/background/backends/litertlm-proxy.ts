import type { ChatMessage } from '../../types';
import { BrowserModelError, isBrowserFailureReason, type BrowserProgress, type BrowserState } from './types';
import {
  beginCacheGeneration, cachedModelExists, currentCacheGeneration,
  pruneStaleModelCaches, removeModelCaches, retireCacheGeneration, isCacheGeneration,
} from './model-cache';

const OFFSCREEN_URL = 'offscreen.html';
const session = crypto.randomUUID();
let requestNumber = 0;
let lifecycleTail: Promise<unknown> = Promise.resolve();
let creation: Promise<string> | null = null;
const closings = new Map<string, Promise<void>>();
const hostDocuments = new Map<string, string>();
const pending = new Map<string, { hostId: string | null; reject(error: Error): void; progress?: (p: BrowserProgress) => void }>();
interface ResponseEnvelope<T> { ok: boolean; value?: T; error?: string; reason?: string }
interface HostState { hostId: string; loaded: boolean; initializing: boolean; downloading: boolean; progress?: number; receivedBytes?: number; totalBytes?: number; downloadGeneration?: string }
function lifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleTail.catch(() => undefined).then(operation);
  lifecycleTail = result.catch(() => undefined);
  return result;
}
function trustedOffscreen(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined && sender.url === chrome.runtime.getURL(OFFSCREEN_URL);
}
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!trustedOffscreen(sender) || !message || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  if (value.channel !== 'litertlm-progress' || typeof value.id !== 'string') return false;
  const request = pending.get(value.id);
  if (!request || request.hostId !== value.hostId || !request.progress) return false;
  if (typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1) return false;
  if (typeof value.text !== 'string' || value.text.length > 200) return false;
  if (value.receivedBytes !== undefined && (!Number.isSafeInteger(value.receivedBytes) || Number(value.receivedBytes) < 0)) return false;
  if (value.totalBytes !== undefined && (!Number.isSafeInteger(value.totalBytes) || Number(value.totalBytes) < 1)) return false;
  request.progress({ progress: value.progress, text: value.text,
    ...(typeof value.receivedBytes === 'number' ? { receivedBytes: value.receivedBytes } : {}),
    ...(typeof value.totalBytes === 'number' ? { totalBytes: value.totalBytes } : {}),
  });
  return false;
});
async function hasHost(): Promise<boolean> {
  return !!chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument();
}
function rpc<T>(hostId: string | null, payload: Record<string, unknown>, progress?: (p: BrowserProgress) => void, onId?: (id: string) => void): Promise<T> {
  const id = `${session}:${++requestNumber}`;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    // Downloads have explicit cancellation and can legitimately take longer.
    if (payload.method !== 'prefetch') timeout = setTimeout(() => reject(new Error('Browser runtime request timed out')), payload.method === 'state' ? 3000 : 180000);
    pending.set(id, { hostId, reject, progress });
    onId?.(id);
    void chrome.runtime.sendMessage<unknown, ResponseEnvelope<T>>({ target: 'litertlm-offscreen', id, ...(hostId ? { hostId } : {}), ...payload })
      .then(response => {
        if (!response?.ok) reject(new BrowserModelError(isBrowserFailureReason(response?.reason) ? response.reason : 'browser_failed', response?.error ?? 'Browser runtime request failed'));
        else resolve(response.value as T);
      }, () => reject(new Error('Browser runtime host disconnected')));
  }).finally(() => { if (timeout !== null) clearTimeout(timeout); pending.delete(id); });
}
async function documentIdentity(): Promise<string | null> {
  if (!chrome.runtime.getContexts) return null;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)] });
  return contexts[0]?.contextId ?? null;
}
async function hostState(): Promise<HostState> {
  const before = await documentIdentity();
  const value = await rpc<HostState>(null, { method: 'state' });
  if (!value || !isCacheGeneration(value.hostId) || value.hostId === 'legacy' || typeof value.loaded !== 'boolean' || typeof value.initializing !== 'boolean' || typeof value.downloading !== 'boolean') throw new Error('Invalid browser runtime state');
  const identity = await documentIdentity();
  if (before && identity && before !== identity) throw new Error('Browser runtime host changed');
  if (identity) hostDocuments.set(value.hostId, identity);
  return value;
}
function ensureHost(): Promise<string> {
  if (creation) return creation;
  const operation = lifecycle(async () => {
    if (!await hasHost()) {
      await chrome.offscreen.createDocument({ url: OFFSCREEN_URL, reasons: [chrome.offscreen.Reason.WORKERS], justification: 'Run the chosen local browser model in the packaged LiteRT-LM WebAssembly host.' });
    }
    return (await hostState()).hostId;
  });
  creation = operation;
  void operation.then(() => { if (creation === operation) creation = null; }, () => { if (creation === operation) creation = null; });
  return operation;
}
function closeOwnedHost(hostId: string): Promise<void> {
  const active = closings.get(hostId);
  if (active) return active;
  // Reject in-flight owned RPCs immediately, even if Chrome cleanup is delayed.
  for (const request of pending.values()) if (request.hostId === hostId) request.reject(new Error('Browser runtime host closed'));
  const operation = lifecycle(async () => {
    if (!await hasHost()) return;
    const ownedDocument = hostDocuments.get(hostId);
    const currentDocument = await documentIdentity();
    if (ownedDocument && currentDocument) {
      if (ownedDocument !== currentDocument) return;
    } else {
      // Legacy mocks/fallbacks use the authenticated host nonce. Chrome 137's
      // context identity can close even a host whose wasm message loop is stuck.
      let state: HostState;
      try { state = await hostState(); } catch { return; }
      if (state.hostId !== hostId) return;
    }
    await chrome.offscreen.closeDocument();
    hostDocuments.delete(hostId);
  });
  closings.set(hostId, operation);
  void operation.then(() => closings.delete(hostId), () => closings.delete(hostId));
  return operation;
}

export class LitertlmProxy {
  private hostId: string | null = null;
  private discoveredDocument: string | null = null;
  private downloadGeneration: string | null = null;
  private downloadPromise: Promise<void> | null = null;
  private progress: BrowserProgress | undefined;
  async getState(): Promise<BrowserState> {
    let state: HostState | null = null;
    if (await hasHost()) {
      this.discoveredDocument = await documentIdentity();
      try {
        state = await hostState();
        if (this.hostId === null) this.hostId = state.hostId;
        if (state.downloading && isCacheGeneration(state.downloadGeneration) && state.downloadGeneration !== 'legacy') this.downloadGeneration = state.downloadGeneration;
        else if (!this.downloadPromise) this.downloadGeneration = null;
      } catch { throw new BrowserModelError('browser_failed', 'Browser runtime host unavailable. Retry from setup.'); }
    }
    // Record physical host ownership before cache inspection can fail.
    if (!this.downloadGeneration) await pruneStaleModelCaches();
    // A cache-only transfer can finish during the state RPC. Inspect saved bytes
    // afterward so its first idle snapshot also reports the completed download.
    const generation = await currentCacheGeneration();
    const present = await cachedModelExists(generation);
    const cached = present && await currentCacheGeneration() === generation;
    const progress = this.progress ?? (state?.progress === undefined ? undefined : { progress: state.progress, receivedBytes: state.receivedBytes, totalBytes: state.totalBytes });
    return { cached, loaded: state?.loaded ?? false, initializing: state?.initializing ?? false, downloading: !!this.downloadPromise || (state?.downloading ?? false), ...(progress ?? {}) };
  }
  download(onProgress: (p: BrowserProgress) => void, signal: AbortSignal): Promise<void> {
    if (this.downloadPromise) return this.downloadPromise;
    const operation = this.performDownload(onProgress, signal);
    this.downloadPromise = operation;
    void operation.finally(() => { if (this.downloadPromise === operation) this.downloadPromise = null; }).catch(() => undefined);
    return operation;
  }
  private async performDownload(onProgress: (p: BrowserProgress) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Browser operation cancelled');
    const current = await currentCacheGeneration();
    if (await cachedModelExists(current)) return;
    const generation = await beginCacheGeneration();
    this.downloadGeneration = generation;
    this.progress = undefined;
    try {
      this.hostId = await ensureHost();
      await this.cancellable('prefetch', generation, p => { this.progress = p; onProgress(p); }, signal);
      if (await currentCacheGeneration() !== generation) throw new Error('Browser operation cancelled');
      await pruneStaleModelCaches();
    } catch (error) {
      await retireCacheGeneration(generation);
      throw error;
    } finally {
      if (this.downloadGeneration === generation) this.downloadGeneration = null;
    }
  }
  async initialize(onProgress: (p: BrowserProgress) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Browser operation cancelled');
    const generation = await currentCacheGeneration();
    if (!await cachedModelExists(generation)) throw new BrowserModelError('needs_download', 'Browser model is not downloaded. Download it in setup.');
    const hostId = await ensureHost();
    this.hostId = hostId;
    try {
      await this.cancellable('init', generation, onProgress, signal, hostId);
      if (signal.aborted || await currentCacheGeneration() !== generation) throw new Error('Browser operation cancelled');
    } catch (error) {
      // Engine.create cannot be aborted. Releasing caller setup ownership before
      // the captured document closes would let its late GPU load survive Retry.
      // This uses the original host/document even if another proxy has replaced it.
      await closeOwnedHost(hostId);
      if (this.hostId === hostId) { this.hostId = null; this.discoveredDocument = null; }
      throw error;
    }
  }
  private async cancellable(method: 'init' | 'prefetch', generation: string, progress: (p: BrowserProgress) => void, signal: AbortSignal, hostId = this.hostId!): Promise<void> {
    let requestId: string | null = null;
    const cancel = (): void => {
      if (method === 'prefetch') void retireCacheGeneration(generation).catch(() => undefined);
      if (requestId) void rpc<void>(hostId, { method: 'cancel', requestId }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) { cancel(); throw new Error('Browser operation cancelled'); }
      await rpc<void>(hostId, { method, generation }, progress, id => { requestId = id; if (signal.aborted) cancel(); });
      if (signal.aborted) throw new Error('Browser operation cancelled');
    } finally { signal.removeEventListener('abort', cancel); }
  }
  generate(messages: ChatMessage[], maxTokens: number): Promise<string> {
    if (!this.hostId) return Promise.reject(new Error('Engine not loaded'));
    return rpc<string>(this.hostId, { method: 'generate', messages, maxTokens });
  }
  async interrupt(): Promise<void> {
    if (!this.hostId || !await hasHost()) return;
    await rpc<void>(this.hostId, { method: 'interrupt' });
  }
  async unload(): Promise<void> {
    const hostId = this.hostId;
    if (!hostId || !await hasHost()) return;
    try { await rpc<void>(hostId, { method: 'unload' }); }
    finally { await closeOwnedHost(hostId); if (this.hostId === hostId) this.hostId = null; }
  }
  async forceClose(): Promise<void> {
    // Capture all ownership before storage retirement yields. A replacement
    // initialization may have assigned a newer host while that write settles.
    const generation = this.downloadGeneration;
    let hostId = this.hostId;
    const discoveredDocument = this.discoveredDocument;
    if (generation) await retireCacheGeneration(generation);
    if (!hostId && discoveredDocument) {
      // A worker restart may discover an old GPU host whose script cannot
      // answer. Explicit cleanup owns only that observed Chrome document.
      hostId = `document:${discoveredDocument}`;
      hostDocuments.set(hostId, discoveredDocument);
    }
    if (hostId) await closeOwnedHost(hostId);
    if (this.discoveredDocument === discoveredDocument) this.discoveredDocument = null;
    if (this.hostId === hostId) this.hostId = null;
    if (this.downloadGeneration === generation) this.downloadGeneration = null;
  }
  async deleteCache(): Promise<void> {
    await this.forceClose();
    await removeModelCaches();
  }
}
