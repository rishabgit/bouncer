// SW-side proxy to the LiteRT-LM offscreen document. Manages the offscreen
// lifecycle (createDocument / closeDocument) and routes per-call messages.
// All public methods mirror LitertlmRuntime so the backend can swap one in
// for the other without conditionals at the call sites.

import type { LocalModelDef, ChatMessage } from '../../types';
import type { InitProgress } from './types';

const OFFSCREEN_URL = 'offscreen.html';

// The offscreen page can outlive an MV3 service worker. Include a per-worker
// nonce so a restarted worker cannot reuse an id that an older offscreen init
// still owns.
const requestSession = globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let nextRequestNumber = 1;

function nextRequestId(): string {
  return `${requestSession}:${nextRequestNumber++}`;
}

// Listeners keyed by request id receive streaming progress events sent from
// the offscreen runtime during init().
const progressListeners = new Map<string, (p: InitProgress) => void>();

// Every proxy method can be the first caller after an MV3 worker restart.
// Share the complete existence-check/create operation so concurrent sends do
// not both observe "missing" and race createDocument(). The slot is cleared
// after either success or failure so a later request can re-check/retry.
let offscreenCreation: Promise<void> | null = null;
let offscreenClosing: Promise<boolean> | null = null;
let offscreenLifecycleTail: Promise<void> = Promise.resolve();

function enqueueOffscreenLifecycle<T>(operation: () => T | Promise<T>): Promise<T> {
  const run = offscreenLifecycleTail.catch(() => undefined).then(operation);
  offscreenLifecycleTail = run.then(() => undefined, () => undefined);
  return run;
}

function closeOffscreenDocument(): Promise<boolean> {
  if (offscreenClosing) return offscreenClosing;
  if (!chrome.offscreen?.closeDocument) return Promise.resolve(false);

  // Queue behind any existence check/creation that won the call-order race,
  // then assign the barrier before Chrome is invoked. Later sends wait for
  // this close and create a fresh document instead of reusing a doomed one.
  const closing = enqueueOffscreenLifecycle(async (): Promise<boolean> => {
    try {
      await chrome.offscreen.closeDocument();
      return true;
    } catch {
      // No offscreen document, or a direct Firefox/Safari event-page runtime.
      return false;
    }
  });
  offscreenClosing = closing;
  void closing.then(() => {
    if (offscreenClosing === closing) offscreenClosing = null;
  });
  return closing;
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  const m = message as { channel?: string; id?: string; progress?: number; text?: string };
  if (m?.channel !== 'litertlm-progress') return false;
  if (typeof m.id !== 'string') return false;
  const cb = progressListeners.get(m.id);
  if (cb && typeof m.progress === 'number') {
    cb({ progress: m.progress, text: m.text ?? '' });
  }
  return false;
});

async function ensureOffscreen(): Promise<void> {
  // A close that was requested first owns the lifecycle queue. Wait for it to
  // settle before joining or scheduling a creation on the other side.
  while (offscreenClosing) await offscreenClosing;

  if (offscreenCreation) {
    await offscreenCreation;
    return;
  }

  // Queue the complete existence-check/create operation. This makes the
  // inverse race deterministic too: a close requested while createDocument
  // is pending runs immediately after creation, never before it.
  const creation = enqueueOffscreenLifecycle(async (): Promise<void> => {
    // Newer Chromes have hasDocument(); fall back to scanning client URLs.
    const offscreenApi = chrome.offscreen as unknown as {
      hasDocument?: () => Promise<boolean>;
      createDocument: (opts: { url: string; reasons: string[]; justification: string }) => Promise<void>;
    };
    if (typeof offscreenApi.hasDocument === 'function') {
      if (await offscreenApi.hasDocument()) return;
    } else {
      const matched = await (self as unknown as { clients: { matchAll: (opts: { includeUncontrolled: boolean }) => Promise<{ url: string }[]> } })
        .clients.matchAll({ includeUncontrolled: true });
      const target = chrome.runtime.getURL(OFFSCREEN_URL);
      if (matched.some(c => c.url === target)) return;
    }
    await offscreenApi.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'Run LiteRT-LM Engine, whose wasm loader uses <script>-tag injection not available in MV3 service workers.',
    });
  });
  offscreenCreation = creation;
  try {
    await creation;
  } finally {
    if (offscreenCreation === creation) offscreenCreation = null;
  }
}

interface OffscreenResponse<T = unknown> { ok: boolean; value?: T; error?: string }

async function send<T>(payload: Record<string, unknown>): Promise<T> {
  await ensureOffscreen();
  const id = nextRequestId();
  const resp = await chrome.runtime.sendMessage<unknown, OffscreenResponse<T>>({
    target: 'litertlm-offscreen',
    id,
    ...payload,
  });
  if (!resp?.ok) throw new Error(resp?.error ?? 'Offscreen request failed');
  return resp.value as T;
}

async function sendWithProgress<T>(
  payload: Record<string, unknown>,
  onProgress: (p: InitProgress) => void,
  onRequestId?: (id: string) => void,
): Promise<T> {
  await ensureOffscreen();
  const id = nextRequestId();
  onRequestId?.(id);
  progressListeners.set(id, onProgress);
  try {
    const resp = await chrome.runtime.sendMessage<unknown, OffscreenResponse<T>>({
      target: 'litertlm-offscreen',
      id,
      ...payload,
    });
    if (!resp?.ok) throw new Error(resp?.error ?? 'Offscreen request failed');
    return resp.value as T;
  } finally {
    progressListeners.delete(id);
  }
}

export class LitertlmProxy {
  async initialize(
    modelDef: LocalModelDef,
    onProgress: (p: InitProgress) => void,
    abortSignal: AbortSignal,
  ): Promise<void> {
    if (abortSignal.aborted) throw new Error('aborted');
    let initRequestId: string | null = null;
    const onAbort = (): void => {
      // Best-effort cancellation; the offscreen runtime aborts its download.
      if (initRequestId !== null) {
        send({ method: 'cancelInit', initRequestId }).catch(() => { /* may already be done */ });
      }
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      await sendWithProgress<void>(
        { method: 'init', modelDef },
        onProgress,
        id => {
          initRequestId = id;
          if (abortSignal.aborted) onAbort();
        },
      );
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
    }
  }

  async unload(): Promise<void> {
    try {
      await send<void>({ method: 'unload' });
    } catch (e) {
      console.error('[LitertlmProxy] unload failed:', e);
    }
    // Tear the offscreen down so the next init starts fresh and we don't keep
    // the WebGPU device pinned. Share the close barrier with force-close so a
    // concurrent send cannot race this teardown and reuse a doomed document.
    await closeOffscreenDocument();
  }

  async generate(messages: ChatMessage[], maxTokens: number): Promise<string> {
    return send<string>({ method: 'generate', messages, maxTokens });
  }

  async interrupt(): Promise<void> {
    try {
      await send<void>({ method: 'interrupt' });
    } catch (e) {
      console.error('[LitertlmProxy] interrupt failed:', e);
    }
  }

  async countTokens(text: string): Promise<number> {
    return send<number>({ method: 'countTokens', text });
  }

  async truncateText(text: string, maxTokens: number): Promise<string> {
    return send<string>({ method: 'truncateText', text, maxTokens });
  }
}

// Engine.create cannot be interrupted once LiteRT begins cache-to-GPU setup.
// Closing the offscreen page is the only bounded way to release a stuck init
// so a user retry can create a fresh host instead of queueing behind it.
export function forceCloseLitertlmOffscreen(): Promise<boolean> {
  return closeOffscreenDocument();
}
