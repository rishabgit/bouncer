// Background script entry point: message handler, storage listener, startup, tab tracking

import { generateCacheKey } from '../shared/utils';
import { NativeModelError, OLLAMA_HOST_PERMISSION } from '../shared/ollama-contract';
import { getStorage, getDescriptions, setDescriptions } from '../shared/storage';
import type { BackgroundToContentMessage, ContentToBackgroundMessage, LocalModelStatus } from '../types';
import { localEngine } from './local-model';
import { migrateToNativeModel, stripNativeCutoverStorageChanges } from './model-migration';
import {
  initPipeline, loadCache, overridePost, clearPost, readCachedEvaluation,
  setActiveTab, enqueuePost, isKeyPending, clearTabQueue,
  scheduleBatch, getSettings,
  errorState,
  clearEvaluationCache,
  handleSettingsChange, handleFilterPackChange, handlePageLoad, suggestAnnoyingReasons,
  replayDetectorStates,
  triggerErrorRetry, captureInferenceRequest, runInferenceRequest, type InferenceRequestFence,
} from './pipeline';
import { handleBenchmark } from './benchmark';

// ==================== Tab tracking ====================

// Set of tab IDs with active content scripts (for broadcasting)
const activeContentTabs = new Set<number>();
function registerContentTab(tabId: number): void {
  activeContentTabs.add(tabId);
}

interface ContentDocument { documentId: string; generation: number; current: boolean }
const contentDocuments = new Map<number, ContentDocument>();
const documentLifecycleRevisions = new Map<number, number>();
let nextDocumentLifecycleRevision = 0;
function invalidateDocument(tabId: number): ContentDocument | undefined {
  // Receipt-time revisions also retire probes when another loading/removal
  // event keeps the same already-retired owner in the map.
  documentLifecycleRevisions.set(tabId, ++nextDocumentLifecycleRevision);
  const document = contentDocuments.get(tabId);
  if (document) document.current = false;
  return document;
}
function captureDocument(sender: chrome.runtime.MessageSender, pageLoad: boolean): () => void {
  const tabId = sender.tab!.id!;
  if (typeof sender.documentId !== 'string' || !sender.documentId) {
    throw new Error('A trusted Chrome document identity is required.');
  }
  let document = contentDocuments.get(tabId);
  if (document && (!document.current || document.documentId !== sender.documentId) && !pageLoad) {
    throw new NativeModelError('inference_preempted', 'The originating X document has changed.');
  }
  if (document && !document.current && document.documentId === sender.documentId) {
    throw new NativeModelError('inference_preempted', 'The originating X document has changed.');
  }
  if (!document || pageLoad) {
    if (document) document.current = false;
    document = { documentId: sender.documentId, generation: (document?.generation ?? 0) + 1, current: true };
    contentDocuments.set(tabId, document);
  }
  const owner = document;
  return () => {
    if (!owner.current || contentDocuments.get(tabId) !== owner) {
      throw new NativeModelError('inference_preempted', 'The originating X document has changed.');
    }
  };
}

// Active tab tracking for per-tab queue processing
let activeTabId: number | null = null;
let focusRevision = 0;

function updateActiveTab(tabId: number | undefined | null): void {
  const isBouncerTab = tabId && activeContentTabs.has(tabId);
  const newActiveId = isBouncerTab ? tabId : null;
  if (newActiveId !== activeTabId) {
    activeTabId = newActiveId;
    setActiveTab(newActiveId);
  }
}

// Listen for tab activation (user switches tabs)
chrome.tabs.onActivated.addListener(({ tabId }) => {
  ++focusRevision;
  withStartupBarrier(() => updateActiveTab(tabId));
});

// Listen for window focus changes (user switches windows)
chrome.windows.onFocusChanged.addListener((windowId) => {
  ++focusRevision;
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // keep current
  withStartupBarrier(() => {
    void chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
      if (tab) updateActiveTab(tab.id);
    }).catch(() => { /* ignore */ });
  });
});

function detachContentTab(tabId: number, retiredOwner: ContentDocument | undefined): void {
  // Startup may defer this cleanup until a replacement document has arrived.
  // Retire only the owner captured by the lifecycle event.
  if (contentDocuments.get(tabId) !== retiredOwner) return;
  activeContentTabs.delete(tabId);
  clearTabQueue(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
    setActiveTab(null);
  }
  // Ollama owns request-scoped idle residency. Closing an X tab only retires
  // that document's queue; it must not unload a shared native model.
}

chrome.tabs.onRemoved.addListener(tabId => {
  const retiredOwner = invalidateDocument(tabId);
  withStartupBarrier(() => {
    if (contentDocuments.get(tabId) !== retiredOwner) return;
    detachContentTab(tabId, retiredOwner);
    contentDocuments.delete(tabId);
    documentLifecycleRevisions.delete(tabId);
  });
});

async function recoverCompletedDocument(
  tabId: number, retiredOwner: ContentDocument | undefined, lifecycleRevision: number | undefined,
): Promise<void> {
  if (!retiredOwner || retiredOwner.current) return;
  const stillRetired = () => contentDocuments.get(tabId) === retiredOwner
    && !retiredOwner.current && documentLifecycleRevisions.get(tabId) === lifecycleRevision;
  await ensureStartupReady();
  if (!stillRetired()) return;
  const ping: BackgroundToContentMessage = { type: 'ping' };
  const response: unknown = await chrome.tabs.sendMessage(tabId, ping, { documentId: retiredOwner.documentId });
  if (!stillRetired() || !response || typeof response !== 'object'
      || (response as { alive?: unknown }).alive !== true) return;
  const tab = await chrome.tabs.get(tabId);
  if (!stillRetired() || tab.id !== tabId || tab.status !== 'complete') return;

  // SPA loading/complete can retain Chrome's document identity. A fresh owner
  // restores new work without reviving any closure held by the retired owner.
  const owner = { documentId: retiredOwner.documentId, generation: retiredOwner.generation + 1, current: true };
  contentDocuments.set(tabId, owner);
  registerContentTab(tabId);
  const capturedFocusRevision = focusRevision;
  const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!owner.current || contentDocuments.get(tabId) !== owner
      || documentLifecycleRevisions.get(tabId) !== lifecycleRevision
      || focusRevision !== capturedFocusRevision) return;
  if (focusedTab?.id === tabId) updateActiveTab(tabId);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    void recoverCompletedDocument(tabId, contentDocuments.get(tabId), documentLifecycleRevisions.get(tabId))
      .catch(() => { /* Document/focus detection is best effort; stale work stays retired. */ });
    return;
  }
  if (changeInfo.status !== 'loading') return;
  // Retire receipt-time owners even if their first request has not registered
  // a content tab yet. Queue cleanup still waits for the cutover barrier.
  const retiredOwner = invalidateDocument(tabId);
  withStartupBarrier(() => detachContentTab(tabId, retiredOwner));
});

// Serialize local filter actions with effective-filter invalidation. Storage
// notifications can arrive after set() resolves, so they reconcile the current
// list rather than clearing again for a previously completed change event.
let filterActionChain: Promise<void> = Promise.resolve();
let appliedDescriptions: string[] = [];
let filtersInitialized = false;
let startupFiltersChanged = false;
const MAX_CATEGORIES_LENGTH = 1000;

function runFilterAction<T>(operation: () => Promise<T>): Promise<T> {
  const result = filterActionChain.catch(() => undefined).then(operation);
  filterActionChain = result.then(() => undefined, () => undefined);
  return result;
}

async function synchronizeFilters(): Promise<void> {
  const descriptions = await getDescriptions('descriptions_twitter');
  if (descriptions.length === appliedDescriptions.length
      && descriptions.every((phrase, index) => phrase === appliedDescriptions[index])) return;
  await handleFilterPackChange();
  appliedDescriptions = descriptions;
}

// ==================== Startup ====================

async function initializeBackground(): Promise<void> {
  try {
    // The cutover is a barrier before cache reads and all handlers. The
    // migration optionally closes an old extension-owned offscreen document
    // using raw Chrome APIs even though new builds no longer request offscreen.
    await migrateToNativeModel();
    await loadCache();
    appliedDescriptions = await getDescriptions('descriptions_twitter');
    // A real phrase event during startup may already be reflected in the
    // initial read while the loaded cache still belongs to the old phrases.
    if (startupFiltersChanged) await handleFilterPackChange();
    filtersInitialized = true;
    initPipeline(activeContentTabs);
    await localEngine.syncAllStatuses();

    // Proactively detect active Bouncer tabs after service worker restart.
    // Without this, activeTabId stays null until a content script sends a message,
    // leaving the per-tab queue idle even if posts are already queued.
    try {
      const tabs = await chrome.tabs.query({ url: ['*://x.com/*'] });
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id!, { type: 'ping' });
          registerContentTab(tab.id!);
        } catch {
          // Content script not loaded or not responding — skip
        }
      }
      if (activeContentTabs.size > 0) {
        const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (focusedTab && activeContentTabs.has(focusedTab.id!)) {
          updateActiveTab(focusedTab.id);
        }
      }
    } catch {
      // Tab detection can fail non-fatally (e.g. no Twitter tabs open)
    }
  } catch (e) {
    console.error('[Background] Startup initialization error:', e);
    throw e;
  }
}

// Every async message and install/update task waits on this barrier so no work
// can observe a retired selected model or stale cross-model evaluation cache.
let startupReady: Promise<void> | null = null;
function ensureStartupReady(): Promise<void> {
  if (startupReady) return startupReady;
  const initialization = initializeBackground();
  startupReady = initialization;
  void initialization.catch(err => {
    if (startupReady === initialization) startupReady = null;
    console.error('[Background] Startup error:', err);
  });
  return initialization;
}
void ensureStartupReady().catch(() => undefined);

function withStartupBarrier(operation: () => void): void {
  // Keep document detach synchronous after cutover/cache initialization so a
  // navigation immediately retires its queue before another verdict can land.
  if (filtersInitialized) { operation(); return; }
  void ensureStartupReady().then(operation)
    .catch(err => console.error('[Background] Tab lifecycle startup failed:', err));
}

let nativePermissionRevision = 0;
let nativeConnectionCheck: { revision: number; promise: Promise<LocalModelStatus> } | null = null;
function checkNativeConnection(): Promise<LocalModelStatus> {
  if (nativeConnectionCheck?.revision === nativePermissionRevision) return nativeConnectionCheck.promise;
  const previous = nativeConnectionCheck?.promise;
  const revision = nativePermissionRevision;
  const check = (async () => {
    // Revocation retires ownership, but engine/backend metadata promises still
    // drain. A regrant must wait before starting its own fresh verification.
    await previous?.catch(() => undefined);
    await ensureStartupReady();
    if (revision !== nativePermissionRevision) return localEngine.getStatus();
    try {
      const status = await localEngine.retry();
      if (revision !== nativePermissionRevision) return localEngine.getStatus();
      if (status.state === 'ready') await triggerErrorRetry(true, true);
      return revision === nativePermissionRevision ? status : localEngine.getStatus();
    } catch (err) {
      if (revision !== nativePermissionRevision) return localEngine.getStatus();
      throw err;
    }
  })();
  nativeConnectionCheck = { revision, promise: check };
  const release = () => { if (nativeConnectionCheck?.promise === check) nativeConnectionCheck = null; };
  void check.then(release, release);
  return check;
}


// ==================== Message handler ====================

// Async message handler — each case returns the response object.
// Centralized .catch() in the listener ensures sendResponse is always called.
async function handleMessage(
  message: ContentToBackgroundMessage,
  sender: chrome.runtime.MessageSender,
  assertDocumentCurrent: () => void,
  inferenceRequest?: InferenceRequestFence,
): Promise<unknown> {
  await ensureStartupReady();
  assertDocumentCurrent();
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'evaluatePost': {
      // Phrase storage is visible before onChanged necessarily runs. Reconcile
      // it here too, so a delayed event cannot leave an old-rule cache hit valid.
      await runFilterAction(synchronizeFilters);
      assertDocumentCurrent();
      registerContentTab(tabId!);
      // Explicit decisions and compatible automatic hits work while the native
      // application is stopped. Read settled cache state before availability.
      await getSettings(message.siteId);
      assertDocumentCurrent();
      await loadCache();
      assertDocumentCurrent();
      const cacheKey = generateCacheKey(message.post);

      // Check main cache
      const cached = await runFilterAction(async () => {
        // Settings preparation awaits above can span a phrase write whose
        // notification is still delayed. Synchronize at cache acceptance too.
        await synchronizeFilters();
        assertDocumentCurrent();
        const result = await readCachedEvaluation(cacheKey);
        assertDocumentCurrent();
        return result;
      });
      assertDocumentCurrent();
      if (cached) {
        if (tabId !== undefined) replayDetectorStates(tabId, message.evaluationId, cached);
        return { ...cached, cached: true };
      }

      assertDocumentCurrent();
      // Check if already in queue - add another resolver for this item
      if (tabId !== undefined && isKeyPending(tabId, cacheKey)) {
        return new Promise(resolve => {
          const item = { evaluationId: message.evaluationId, post: message.post, resolve, cacheKey, tabId, postUrl: message.postUrl, siteId: message.siteId };
          enqueuePost(tabId, item);
        });
      }

      // Queue for batch processing
      // processBatch will prioritize posts closest to viewport center for local models
      const resultPromise = new Promise(resolve => {
        const item = { evaluationId: message.evaluationId, post: message.post, resolve, cacheKey, tabId, postUrl: message.postUrl, siteId: message.siteId };
        enqueuePost(tabId!, item);
      });

      // On first evaluatePost when activeTabId is unknown, detect if this tab is active
      if (activeTabId === null) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
          const tab = tabs[0];
          assertDocumentCurrent();
          if (tab && tab.id === tabId) updateActiveTab(tabId);
        }).catch(() => { /* active-tab confirmation is best effort */ });
      }

      scheduleBatch();
      return resultPromise;
    }

    case 'suggestAnnoyingReasons': {
      if (localEngine.isMaintaining()) {
        return { reasons: [], retry: true, error: 'Local model maintenance in progress.' };
      }
      try {
        const reasons = await suggestAnnoyingReasons(message.post, message.siteId || 'twitter', sender.tab?.id, inferenceRequest);
        return { reasons };
      } catch (err) {
        console.error('[Bouncer] suggestAnnoyingReasons error:', err);
        return { reasons: [], error: (err as Error).message };
      }
    }

    case 'clearCache': {
      await clearEvaluationCache();
      return { success: true };
    }

    case 'clearSinglePost': {
      await runFilterAction(() => clearPost(message.post));
      return { success: true };
    }

    case 'overrideCacheEntry': {
      await runFilterAction(async () => {
        await synchronizeFilters();
        await overridePost(message.post, message.shouldHide, message.reasoning || 'User override');
      });
      return { success: true };
    }

    case 'bouncePost': {
      if (message.siteId !== 'twitter') return { success: false, error: 'Unsupported site.' };
      await runFilterAction(async () => {
        const phrase = message.phrase?.trim();
        const descriptions = await getDescriptions('descriptions_twitter');
        if (phrase && !descriptions.includes(phrase)) {
          const updated = [...descriptions, phrase];
          if (updated.reduce((total, value) => total + value.length, 0) > MAX_CATEGORIES_LENGTH) {
            throw new Error('Filter phrases exceed the 1000-character limit.');
          }
          await setDescriptions('descriptions_twitter', updated);
        }
        // Finish the full filter invalidation before committing the override.
        // A delayed onChanged callback observes the same applied list and skips.
        await synchronizeFilters();
        await overridePost(
          message.post,
          true,
          message.reasoning || 'Bounced by you',
          phrase ? [phrase] : undefined,
        );
      });
      return { success: true };
    }

    case 'getStats': {
      const data = await getStorage(['stats']);
      return data.stats || { filtered: 0, evaluated: 0, totalCost: 0 };
    }

    case 'getReasoning': {
      await loadCache();
      const cacheKey = generateCacheKey(message.post);
      const cached = await readCachedEvaluation(cacheKey);
      if (cached) {
        return {
          found: true,
          shouldHide: cached.shouldHide,
          reasoning: cached.reasoning || 'No reasoning available',
          category: cached.category || null,
          ...(cached.matches !== undefined && { matches: cached.matches }),
          ...(cached.userOverride !== undefined && { userOverride: cached.userOverride }),
          rawResponse: cached.rawResponse || null
        };
      }
      return {
        found: false,
        reasoning: 'Post not yet evaluated'
      };
    }

    case 'getErrorStatus': {
      return {
        errorType: errorState.type,
        count: errorState.count,
      };
    }

    case 'getNativeModelStatus': {
      return { status: await localEngine.getStatus() };
    }

    case 'connectNativeModel':
    case 'retryNativeModel': {
      const status = await checkNativeConnection();
      return { success: status.state === 'ready', status };
    }

    case 'recoverNativeModel': {
      const status = await localEngine.recoverAfterOperatorRestart(message.operatorRestartConfirmed);
      if (status.state === 'ready') await triggerErrorRetry(true, true);
      return { success: status.state === 'ready', status };
    }

    case 'benchmark':
      // Dev-only. The page that drives this isn't built in prod, and
      // handleBenchmark itself returns an error unless __DEV__ (so a same-origin
      // caller can't trigger inference in a production build either).
      return handleBenchmark(message);

    default:
      return { error: `Unknown message type: ${(message as { type: string }).type}` };
  }
}

// Only extension pages and the trusted X content document can use these
// routes. Native connection/recovery actions belong to the real popup, while
// operation routes never accept an endpoint, model, or generic API command.
function trustedSender(sender: chrome.runtime.MessageSender): 'content' | 'popup' | 'benchmark' | null {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return null;
  let url: URL;
  try { url = new URL(sender.url); } catch { return null; }
  if (url.protocol === 'https:' && url.hostname === 'x.com'
      && url.port === '' && typeof sender.tab?.id === 'number'
      && (sender.frameId === undefined || sender.frameId === 0)) return 'content';
  if (url.protocol !== 'chrome-extension:' || url.hostname !== chrome.runtime.id) return null;
  if (url.pathname === '/popup.html') return 'popup';
  if (url.pathname === '/benchmark.html') return 'benchmark';
  return null;
}

function validateMessage(message: ContentToBackgroundMessage, sender: chrome.runtime.MessageSender): void {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    throw new Error('Invalid Bouncer request.');
  }
  const source = trustedSender(sender);
  if (!source) throw new Error('Untrusted Bouncer sender.');
  const popupActions = ['connectNativeModel', 'retryNativeModel', 'recoverNativeModel'];
  if (popupActions.includes(message.type) && source !== 'popup') {
    throw new Error('Open the Bouncer popup to manage the local connection.');
  }
  if (message.type === 'benchmark' && source !== 'benchmark') {
    throw new Error('Benchmark requests require the extension benchmark page.');
  }
  const contentActions = ['pageLoad', 'evaluatePost', 'suggestAnnoyingReasons',
    'preemptInference', 'bouncePost', 'overrideCacheEntry', 'clearSinglePost', 'getReasoning'];
  if (contentActions.includes(message.type) && source !== 'content') {
    throw new Error('This operation requires an X content document.');
  }
  const fields = message as unknown as Record<string, unknown>;
  if (['endpoint', 'url', 'model', 'modelId', 'headers', 'options'].some(key => key in fields)) {
    throw new Error('Bouncer uses one fixed local classifier.');
  }
  const needsPost = ['evaluatePost', 'suggestAnnoyingReasons', 'bouncePost', 'overrideCacheEntry', 'clearSinglePost', 'getReasoning'].includes(message.type);
  if (needsPost && (typeof fields.post !== 'string' || fields.post.length > 100_000)) {
    throw new Error('Invalid post text.');
  }
  if ('siteId' in fields && fields.siteId !== undefined && fields.siteId !== 'twitter') {
    throw new Error('Unsupported site.');
  }
  if (message.type === 'evaluatePost' && (typeof message.evaluationId !== 'string'
      || message.evaluationId.length > 200 || !message.evaluationId
      || !(message.postUrl === null || typeof message.postUrl === 'string'))) {
    throw new Error('Invalid post evaluation request.');
  }
  if (message.type === 'bouncePost' && message.phrase !== undefined
      && (typeof message.phrase !== 'string' || message.phrase.length > MAX_CATEGORIES_LENGTH)) {
    throw new Error('Invalid filter phrase.');
  }
  if (message.type === 'overrideCacheEntry' && typeof message.shouldHide !== 'boolean') {
    throw new Error('Invalid manual decision.');
  }
  if ('reasoning' in fields && fields.reasoning !== undefined && typeof fields.reasoning !== 'string') {
    throw new Error('Invalid decision text.');
  }
  if (message.type === 'recoverNativeModel'
      && (message.operatorRestartConfirmed !== true || Object.keys(fields).some(key =>
        key !== 'type' && key !== 'operatorRestartConfirmed'))) {
    throw new Error('Confirm the qualified operator restart procedure first.');
  }
}

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender, sendResponse) => {
  (async () => {
    // Capture ownership before the first async barrier; later setup cannot
    // make a request from a retired document or engine epoch current again.
    validateMessage(message, sender);
    const assertDocumentCurrent = trustedSender(sender) === 'content'
      ? captureDocument(sender, message.type === 'pageLoad') : () => undefined;
    const handleCurrentRequest = async (inferenceRequest?: InferenceRequestFence): Promise<unknown> => {
      await ensureStartupReady();
      assertDocumentCurrent();
      inferenceRequest?.assertCurrent();
      const tabId = sender.tab?.id;
      if (message.type === 'pageLoad') {
        registerContentTab(tabId!);
        handlePageLoad(tabId!);
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        assertDocumentCurrent();
        if (tab?.id === tabId) updateActiveTab(tabId);
        return { success: true };
      }
      if (message.type === 'preemptInference') {
        localEngine.preempt();
        return { success: true };
      }
      return handleMessage(message, sender, assertDocumentCurrent, inferenceRequest);
    };
    return message.type === 'suggestAnnoyingReasons'
      ? runInferenceRequest(captureInferenceRequest(assertDocumentCurrent), handleCurrentRequest)
      : handleCurrentRequest();
  })().then(response => sendResponse(response)).catch(err => {
    const error = (err as Error).message;
    console.error(`[Background] Error handling '${message?.type}':`, error);
    if (message?.type === 'evaluatePost') {
      sendResponse({ retry: true, reasoning: error || 'Local filtering is unavailable.', retryAfterMs: 1000 });
    } else if (message?.type === 'suggestAnnoyingReasons') {
      sendResponse({ reasons: [], error });
    } else {
      sendResponse({ success: false, error });
    }
  });
  return true;
});

// ==================== Storage change listener ====================

chrome.storage.onChanged.addListener((incomingChanges, areaName) => {
  const changes = stripNativeCutoverStorageChanges(incomingChanges);
  if (areaName === 'local' && !filtersInitialized && changes.descriptions_twitter) {
    startupFiltersChanged = true;
  }
  (async () => {
    if (areaName !== 'local') return;
    await ensureStartupReady();
    if (changes.enabled) await handleSettingsChange(changes);
    if (changes.nativeModelStatus && errorState.count > 0) {
      const before = changes.nativeModelStatus.oldValue as LocalModelStatus | undefined;
      const after = changes.nativeModelStatus.newValue as LocalModelStatus | undefined;
      if (before?.state !== 'ready' && after?.state === 'ready') await triggerErrorRetry();
    }
    if (Object.keys(changes).some(key => key.startsWith('descriptions_'))) {
      await runFilterAction(synchronizeFilters);
    }
  })().catch(err => console.error('[Background] Storage change handler error:', err));
});

// A grant completes the explicit Connect metadata check even when Chrome
// closes the popup that requested it. Revocation retires work without HTTP;
// the native lease still drains and its durable fence remains effective.
chrome.permissions?.onRemoved?.addListener(permissions => {
  if (!permissions.origins?.includes(OLLAMA_HOST_PERMISSION)) return;
  ++nativePermissionRevision;
  withStartupBarrier(() => {
    localEngine.preempt();
    void localEngine.syncAllStatuses().catch(err => console.error('[Background] Permission status error:', err));
  });
});
chrome.permissions?.onAdded?.addListener(permissions => {
  if (!permissions.origins?.includes(OLLAMA_HOST_PERMISSION)) return;
  const revision = nativePermissionRevision;
  withStartupBarrier(() => {
    if (revision !== nativePermissionRevision) return;
    void checkNativeConnection().catch(err => console.error('[Background] Permission connection error:', err));
  });
});

// ==================== Extension lifecycle ====================

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    ensureStartupReady().then(() => localEngine.syncAllStatuses())
      .catch(err => console.error('[Background] onInstalled error:', err));
  }
});

// Native work owns a durable content-free fence. Teardown only retires local
// bookkeeping; the next worker must recover any unresolved native operation.
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => localEngine.teardown());
}
