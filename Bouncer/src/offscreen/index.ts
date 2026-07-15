// Entry point for the Chrome offscreen document. Bridges chrome.runtime
// messages from the service worker to a LitertlmRuntime instance that owns
// the LiteRT-LM Engine. The protocol is request/response with an `id`
// field; the SW side (litertlm-proxy.ts) generates ids and routes replies.
//
// One offscreen document hosts at most one runtime — Bouncer only loads a
// single local model at a time, so collapsing the lifecycle here mirrors the
// orchestrator's invariant.

import { LitertlmRuntime } from './litertlm-runtime';
import type { LocalModelDef, ChatMessage } from '../types';

interface InitProgressUpdate {
  channel: 'litertlm-progress';
  id: string;
  progress: number;
  text: string;
}

interface BaseRequest { id: string; target: 'litertlm-offscreen' }
interface InitRequest extends BaseRequest { method: 'init'; modelDef: LocalModelDef }
interface GenerateRequest extends BaseRequest { method: 'generate'; messages: ChatMessage[]; maxTokens: number; params: Record<string, unknown> }
interface InterruptRequest extends BaseRequest { method: 'interrupt' }
interface UnloadRequest extends BaseRequest { method: 'unload' }
interface CountRequest extends BaseRequest { method: 'countTokens'; text: string }
interface TruncateRequest extends BaseRequest { method: 'truncateText'; text: string; maxTokens: number }
interface CancelInitRequest extends BaseRequest { method: 'cancelInit'; initRequestId: string }

type Request =
  | InitRequest | GenerateRequest | InterruptRequest | UnloadRequest
  | CountRequest | TruncateRequest | CancelInitRequest;

const runtime = new LitertlmRuntime();
// LiteRT Engine.create is not abortable once cache-to-GPU loading begins. Keep
// init requests serialized so a canceled operation that finishes late cannot
// overwrite/delete a newer runtime engine. Controllers are keyed by request id
// so canceling a queued request never aborts the currently active one.
const initControllers = new Map<string, AbortController>();
let initTail: Promise<void> = Promise.resolve();

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'init': {
      const controller = new AbortController();
      initControllers.set(req.id, controller);
      const run = initTail.catch(() => undefined).then(async () => {
        try {
          if (controller.signal.aborted) throw new Error('aborted');
          await runtime.initialize(req.modelDef, (p) => {
            const msg: InitProgressUpdate = {
              channel: 'litertlm-progress',
              id: req.id,
              progress: p.progress,
              text: p.text,
            };
            chrome.runtime.sendMessage(msg).catch(() => { /* SW might be napping */ });
          }, controller.signal);
        } finally {
          if (initControllers.get(req.id) === controller) {
            initControllers.delete(req.id);
          }
        }
      });
      initTail = run.catch(() => undefined);
      await run;
      return { ok: true };
    }
    case 'cancelInit': {
      initControllers.get(req.initRequestId)?.abort();
      return { ok: true };
    }
    case 'generate':
      return { ok: true, value: await runtime.generate(req.messages, req.maxTokens, req.params) };
    case 'interrupt':
      await runtime.interrupt();
      return { ok: true };
    case 'unload':
      await runtime.unload();
      return { ok: true };
    case 'countTokens':
      return { ok: true, value: await runtime.countTokens(req.text) };
    case 'truncateText':
      return { ok: true, value: await runtime.truncateText(req.text, req.maxTokens) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const req = message as Partial<Request> | undefined;
  if (!req || req.target !== 'litertlm-offscreen') return false;
  handle(req as Request)
    .then(sendResponse)
    .catch((err: unknown) => sendResponse({ ok: false, error: (err as Error).message ?? String(err) }));
  // Keep the message channel open for the async response.
  return true;
});
