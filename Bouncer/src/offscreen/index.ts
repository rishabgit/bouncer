import { LitertlmRuntime } from './litertlm-runtime';
import type { ChatMessage } from '../types';
import { BrowserModelError, type BrowserProgress, type BrowserFailureReason } from '../background/backends/types';
import { isCacheGeneration } from '../background/backends/model-cache';

const hostId = crypto.randomUUID();
const runtime = new LitertlmRuntime();
const controllers = new Map<string, AbortController>();
const downloads = new Map<string, string>();
const initializations = new Set<string>();
let lastProgress: BrowserProgress | undefined;
let lastProgressRequestId: string | null = null;
interface Request {
  target: 'litertlm-offscreen'; id: string; method: string; hostId?: string;
  generation?: string; messages?: ChatMessage[]; maxTokens?: number; text?: string; requestId?: string;
}
const BASE_KEYS = ['target', 'id', 'method', 'hostId'];
const REQUEST_ID = /^[a-zA-Z0-9:-]{1,128}$/;
export function isTrustedBackground(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined &&
    (sender.url === undefined || sender.url === chrome.runtime.getURL('dist/background.js'));
}
export function parseOffscreenRequest(message: unknown): Request | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const value = message as Record<string, unknown>;
  if (value.target !== 'litertlm-offscreen' || typeof value.id !== 'string' || !REQUEST_ID.test(value.id)) return null;
  if (typeof value.method !== 'string') return null;
  const extras: Record<string, string[]> = {
    state: [], init: ['generation'], prefetch: ['generation'], cancel: ['requestId'],
    generate: ['messages', 'maxTokens'], interrupt: [], unload: [],
  };
  if (!Object.prototype.hasOwnProperty.call(extras, value.method)) return null;
  const allowed = extras[value.method];
  if (!allowed || Object.keys(value).some(key => !BASE_KEYS.includes(key) && !allowed.includes(key))) return null;
  if (value.method !== 'state' && value.hostId !== hostId) return null;
  if (value.hostId !== undefined && value.hostId !== hostId) return null;
  if (['init', 'prefetch'].includes(value.method) && !isCacheGeneration(value.generation)) return null;
  if (value.method === 'prefetch' && value.generation === 'legacy') return null;
  if (value.method === 'cancel' && (typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId))) return null;
  if (value.method === 'generate') {
    if (!Number.isInteger(value.maxTokens) || Number(value.maxTokens) < 1 || Number(value.maxTokens) > 256) return null;
    if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 16) return null;
    let characters = 0;
    for (const item of value.messages as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const message = item as Record<string, unknown>;
      if (Object.keys(message).some(key => key !== 'role' && key !== 'content')) return null;
      if (typeof message.role !== 'string' || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return null;
      characters += message.content.length;
    }
    if (characters > 32768 || (value.messages[value.messages.length - 1] as { role?: unknown }).role !== 'user') return null;
  }
  return value as unknown as Request;
}
function safeError(error: unknown): { error: string; reason: BrowserFailureReason } {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof BrowserModelError) return { error: message, reason: error.reason };
  if (error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError') return { error: 'Browser storage is full. Free space and download again.', reason: 'storage_full' };
  if (message.includes('integrity verification failed')) return { error: 'Browser model integrity verification failed', reason: 'artifact_integrity' };
  if (message.includes('not downloaded') || message.includes('cache was removed')) return { error: 'Browser model is not downloaded. Download it in setup.', reason: 'needs_download' };
  if (message === 'Browser model download failed') return { error: message, reason: 'download_failed' };
  if (message === 'Browser operation cancelled' || message === 'aborted') return { error: 'Browser operation cancelled', reason: 'browser_cancelled' };
  if (/WebAssembly|webgpu|gpu adapter|gpu device|requestAdapter/i.test(message)) return { error: 'Browser GPU support is unavailable. Use a supported Chrome device.', reason: 'webgpu_unavailable' };
  return { error: 'Browser runtime request failed', reason: 'browser_failed' };
}
const PROGRESS_INTERVAL_MS = 250;
/** One latest metadata snapshot, one timer, and one ordinary message in flight. */
function requestProgress(id: string, controller: AbortController): {
  update: (value: BrowserProgress) => void;
  complete: () => void;
  stop: (clearProgress?: boolean) => void;
} {
  let latest: BrowserProgress | undefined;
  let active = true;
  let dirty = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sentAt = Date.now();
  const ownsRequest = (): boolean => active && !controller.signal.aborted && controllers.get(id) === controller;
  const stop = (clearProgress = false): void => {
    active = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    latest = undefined;
    controller.signal.removeEventListener('abort', onAbort);
    if (clearProgress && lastProgressRequestId === id) { lastProgress = undefined; lastProgressRequestId = null; }
  };
  const onAbort = (): void => stop(true);
  const schedule = (): void => {
    if (!ownsRequest() || inFlight || timer !== null || !dirty || !latest || latest.progress >= 1) return;
    timer = setTimeout(flush, Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - sentAt)));
  };
  const flush = (): void => {
    timer = null;
    if (!ownsRequest() || inFlight || !dirty || !latest || latest.progress >= 1) return;
    const value = latest;
    dirty = false;
    inFlight = true;
    sentAt = Date.now();
    const settled = (): void => { inFlight = false; schedule(); };
    try {
      void chrome.runtime.sendMessage({ channel: 'litertlm-progress', hostId, id, ...value }).then(settled, settled);
    } catch { settled(); }
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  return {
    update: value => {
      if (!ownsRequest()) return;
      // Progress contains numbers/text only, never the streamed model bytes.
      latest = { ...value };
      lastProgress = latest;
      lastProgressRequestId = id;
      dirty = true;
      schedule();
    },
    complete: () => {
      if (!ownsRequest()) return;
      const value = latest ? { ...latest, progress: 1,
        ...(latest.totalBytes !== undefined ? { receivedBytes: latest.totalBytes } : {}),
      } : undefined;
      stop();
      if (!value) return;
      lastProgress = value;
      lastProgressRequestId = id;
      // Completion must not wait for a sleeping worker's ordinary message.
      // This is the sole allowed second send; no further timer/message follows.
      try { void chrome.runtime.sendMessage({ channel: 'litertlm-progress', hostId, id, ...value }).catch(() => undefined); }
      catch { /* worker/extension may have gone away */ }
    },
    stop,
  };
}
async function handle(request: Request): Promise<unknown> {
  switch (request.method) {
    case 'state': return { hostId, loaded: runtime.loaded, initializing: initializations.size > 0, downloading: downloads.size > 0, downloadGeneration: Array.from(downloads.values())[downloads.size - 1], ...(lastProgress ?? {}) };
    case 'init':
    case 'prefetch': {
      if (controllers.has(request.id)) throw new Error('Duplicate browser request');
      const controller = new AbortController();
      controllers.set(request.id, controller);
      const progress = requestProgress(request.id, controller);
      let succeeded = false;
      if (request.method === 'init') initializations.add(request.id);
      if (request.method === 'prefetch') { downloads.set(request.id, request.generation!); lastProgress = undefined; lastProgressRequestId = null; }
      try {
        if (request.method === 'init') await runtime.initialize(request.generation!, progress.update, controller.signal);
        else await runtime.prefetch(request.generation!, progress.update, controller.signal);
        succeeded = true;
        progress.complete();
      } finally {
        progress.stop(!succeeded);
        controllers.delete(request.id);
        initializations.delete(request.id);
        if (request.method === 'prefetch') downloads.delete(request.id);
      }
      return undefined;
    }
    case 'cancel': controllers.get(request.requestId!)?.abort(); return undefined;
    case 'generate': return runtime.generate(request.messages!, request.maxTokens!);
    case 'interrupt': await runtime.interrupt(); return undefined;
    case 'unload':
      for (const controller of controllers.values()) controller.abort();
      await runtime.unload();
      return undefined;
    default: throw new Error('Invalid browser runtime request');
  }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || (message as { target?: unknown }).target !== 'litertlm-offscreen') return false;
  if (!isTrustedBackground(sender)) return false;
  const request = parseOffscreenRequest(message);
  if (!request) { sendResponse({ ok: false, error: 'Invalid browser runtime request' }); return false; }
  void handle(request).then(value => sendResponse({ ok: true, value })).catch(error => sendResponse({ ok: false, ...safeError(error) }));
  return true;
});
