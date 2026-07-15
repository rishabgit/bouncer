// Background script entry point: message handler, storage listener, startup, tab tracking

import { DEFAULT_MODEL, PREDEFINED_MODELS, PRIMARY_LOCAL_MODEL_ID } from '../shared/models';
import { generateCacheKey } from '../shared/utils';
import { getStorage, setStorage } from '../shared/storage';
import type { ContentToBackgroundMessage, LocalModelStatus } from '../types';
import { localEngine, MODEL_MAINTENANCE_ERROR } from './local-model';
import { forceCloseLitertlmOffscreen } from './backends/litertlm-backend';
import { migrateToGemmaOnlyModel } from './model-migration';
import {
  initPipeline, loadCache, saveCache,
  setActiveTab, enqueuePost, isKeyPending, clearTabQueue,
  scheduleBatch, getSettings,
  errorState,
  evaluationCache, clearEvaluationCache,
  handleSettingsChange, handleFilterPackChange, handlePageLoad, suggestAnnoyingReasons,
  replayDetectorStates,
  runModelMaintenance,
  triggerErrorRetry,
  requiresLocalInference,
} from './pipeline';
import { handleBenchmark } from './benchmark';
import {
  scheduleNavigationUnload,
  TAB_NAVIGATION_UNLOAD_GRACE_MS,
} from './tab-unload-grace';

// ==================== Tab tracking ====================

// Set of tab IDs with active content scripts (for broadcasting)
const activeContentTabs = new Set<number>();
let tabLifecycleGeneration = 0;
const LAST_TAB_UNLOAD_RETRY_MS = 250;

function registerContentTab(tabId: number): void {
  if (activeContentTabs.has(tabId)) return;
  activeContentTabs.add(tabId);
  tabLifecycleGeneration++;
}

function unregisterContentTab(tabId: number): boolean {
  if (!activeContentTabs.delete(tabId)) return false;
  tabLifecycleGeneration++;
  return true;
}

// Closing the last X tab requests a serialized engine unload. The lifecycle
// generation makes that request conditional: if another content script
// registers before the maintenance callback owns the inference queue, the
// callback leaves the engine available for that tab. A concurrent popup/idle
// maintenance is allowed to finish first and then this condition is retried.
function unloadModelIfStillNoContentTabs(expectedGeneration: number): void {
  if (expectedGeneration !== tabLifecycleGeneration
      || activeContentTabs.size > 0
      || !localEngine.engine) return;

  if (localEngine.isMaintaining()) {
    setTimeout(
      () => unloadModelIfStillNoContentTabs(expectedGeneration),
      LAST_TAB_UNLOAD_RETRY_MS,
    );
    return;
  }

  void localEngine.runMaintenance(async () => {
    if (expectedGeneration !== tabLifecycleGeneration
        || activeContentTabs.size > 0
        || !localEngine.engine) return;

    const modelId = localEngine.loadedModel;
    console.log('[LocalEngine] No active tabs remaining, unloading engine for', modelId);
    await localEngine.reset();
    if (modelId) {
      await localEngine.updateStatus(modelId, { state: 'cached' });
    }
  }).catch(err => {
    if ((err as Error).message === MODEL_MAINTENANCE_ERROR) {
      setTimeout(
        () => unloadModelIfStillNoContentTabs(expectedGeneration),
        LAST_TAB_UNLOAD_RETRY_MS,
      );
      return;
    }
    console.error('[LocalEngine] Error unloading engine on last tab close:', err);
  });
}

// Active tab tracking for per-tab queue processing
let activeTabId: number | null = null;

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
  updateActiveTab(tabId);
});

// On tab update (page load/navigation), access the tab to trigger Safari's permission prompt.
// Safari only shows the permission prompt when the extension actively accesses a tab's info.
// Without this, the prompt is deferred until the user switches away and back.

// Listen for window focus changes (user switches windows)
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // keep current
  chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
    if (tab) updateActiveTab(tab.id);
  }).catch(() => { /* ignore */ });
});

function detachContentTab(tabId: number, navigationGraceMs = 0): void {
  const wasContentTab = unregisterContentTab(tabId);
  clearTabQueue(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
    setActiveTab(null);
  }

  // When no tabs remain, immediately unload the local model to free GPU memory.
  // Model weights stay in Cache Storage for fast reload when a tab opens again.
  if (wasContentTab && activeContentTabs.size === 0 && localEngine.engine) {
    const expectedGeneration = tabLifecycleGeneration;
    if (navigationGraceMs > 0) {
      scheduleNavigationUnload(
        expectedGeneration,
        generation => generation === tabLifecycleGeneration && activeContentTabs.size === 0,
        unloadModelIfStillNoContentTabs,
        navigationGraceMs,
      );
    } else {
      unloadModelIfStillNoContentTabs(expectedGeneration);
    }
  }
}

// Clean up tab tracking when tabs are closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  detachContentTab(tabId);
});

// Chrome reuses a tab id when an X tab navigates away or reloads. Detach at
// loading so stale posts cannot keep the queue/model alive. Give only this
// navigation path a short grace period: an X reload's document_idle pageLoad
// advances the lifecycle generation and keeps the loaded model, while a real
// navigation away still unloads after the grace. Closed tabs unload immediately.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && activeContentTabs.has(tabId)) {
    detachContentTab(tabId, TAB_NAVIGATION_UNLOAD_GRACE_MS);
  }
});

// ==================== Startup ====================

async function initializeBackground(): Promise<void> {
  try {
    // An MV3 offscreen document can outlive its service worker. Close it on
    // every worker start so the new LocalEngine never allocates a second GPU
    // engine beside an orphan it cannot reattach to.
    await forceCloseLitertlmOffscreen();
    // Normalize model storage and purge retired caches before reading settings
    // or evaluation results. The cache cleanup phase is retryable/non-fatal.
    await migrateToGemmaOnlyModel();
    await loadCache();
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
const startupReady = initializeBackground();
startupReady.catch(err => console.error('[Background] Startup error:', err));

// ==================== Message handler ====================

// Async message handler — each case returns the response object.
// Centralized .catch() in the listener ensures sendResponse is always called.
async function handleMessage(
  message: ContentToBackgroundMessage,
  sender: chrome.runtime.MessageSender,
  _sendResponse: (response?: unknown) => void
): Promise<unknown> {
  await startupReady;
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'evaluatePost': {
      // Register before the maintenance check: opening a fresh X tab must
      // invalidate a last-tab-close unload that is waiting for the queue.
      if (tabId !== undefined) registerContentTab(tabId);
      if (localEngine.isMaintaining()) {
        return {
          retry: true as const,
          reasoning: 'Local model maintenance in progress.',
          retryAfterMs: 250,
        };
      }
      // Posts flow through processBatch so the popup gets a consistent filter-tab
      // dispatch even when no phrases are configured (the detector marks itself
      // skipped with a reason).
      const settings = await getSettings(message.siteId);
      const needsInference = requiresLocalInference(settings);

      // No usable local model — none selected, or this browser has no WebGPU.
      // Return retry (not an error) so the content script leaves the post alone,
      // drops it from processedPosts, and re-evaluates once a model is ready. The
      // in-feed model-status indicator tells the user how to set one up.
      if (needsInference) {
        const isLocalModel = settings.selectedModel?.startsWith('local:');
        if (!isLocalModel || !navigator.gpu) {
          return { retry: true as const, reasoning: !navigator.gpu ? 'WebGPU not supported' : 'No model selected' };
        }

        // A model is selected. If it isn't downloaded yet (not loaded, not
        // initializing, not cached), ask the content script to retry later.
        const modelId = settings.selectedModel.split(':')[1];
        const notDownloaded = !localEngine.isModelLoaded(modelId) && !localEngine.isInitializing();
        if (notDownloaded) {
          const cached = await localEngine.checkCached(modelId);
          if (!cached) {
            return { retry: true as const, reasoning: 'Local model not downloaded yet.' };
          }
        }
      }

      await loadCache();
      const cacheKey = generateCacheKey(message.post);

      // Check main cache
      if (evaluationCache.has(cacheKey)) {
        const cached = evaluationCache.get(cacheKey)!;
        if (tabId !== undefined) replayDetectorStates(tabId, message.evaluationId, cached);
        return { ...cached, cached: true };
      }

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
        const reasons = await suggestAnnoyingReasons(message.post, message.siteId || 'twitter', sender.tab?.id);
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
      await loadCache();
      const cacheKey = generateCacheKey(message.post);
      if (evaluationCache.has(cacheKey)) {
        evaluationCache.delete(cacheKey);
        await saveCache();
      }
      return { success: true };
    }

    case 'overrideCacheEntry': {
      await loadCache();
      const cacheKey = generateCacheKey(message.post);
      evaluationCache.set(cacheKey, {
        shouldHide: message.shouldHide,
        reasoning: message.reasoning || 'User override',
      });
      await saveCache();
      return { success: true };
    }

    case 'getStats': {
      const data = await getStorage(['stats']);
      return data.stats || { filtered: 0, evaluated: 0, totalCost: 0 };
    }

    case 'getReasoning': {
      await loadCache();
      const cacheKey = generateCacheKey(message.post);
      if (evaluationCache.has(cacheKey)) {
        const cached = evaluationCache.get(cacheKey)!;
        return {
          found: true,
          shouldHide: cached.shouldHide,
          reasoning: cached.reasoning || 'No reasoning available',
          category: cached.category || null,
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

    case 'getAllLocalModelStatuses': {
      const data = await getStorage(['localModelStatuses']);
      const statuses: Record<string, LocalModelStatus> = { ...(data.localModelStatuses || {}) };

      // Check WebGPU support
      const webgpuSupported = !!navigator.gpu;

      // Always check cache status for models not currently in a loading state
      for (const model of PREDEFINED_MODELS.local) {
        const currentStatus = statuses[model.name];
        // Preserve live loading/error state. Startup reconciliation turns a
        // stale state into cached/not_downloaded once per worker lifetime.
        const isLoading = currentStatus?.state === 'downloading'
          || currentStatus?.state === 'initializing';

        if (!isLoading && currentStatus?.state !== 'error') {
          if (!webgpuSupported) {
            statuses[model.name] = { state: 'unsupported', reason: 'WebGPU not supported' };
          } else if (localEngine.isModelLoaded(model.name)) {
            // Model is currently loaded in GPU memory
            statuses[model.name] = { state: 'ready' };
          } else {
            // Check if model is in cache
            const cached = await localEngine.checkCached(model.name);
            statuses[model.name] = { state: cached ? 'cached' : 'not_downloaded' };
          }
        }
      }

      return { statuses, webgpuSupported };
    }

    case 'cancelLocalModelDownload': {
      const cancelled = await runModelMaintenance(
        () => localEngine.cancelDownload(PRIMARY_LOCAL_MODEL_ID),
      );
      return { success: true, cancelled, modelId: PRIMARY_LOCAL_MODEL_ID };
    }

    case 'deleteLocalModel': {
      const result = await runModelMaintenance(
        () => localEngine.deleteModelCache(PRIMARY_LOCAL_MODEL_ID),
      );
      return { ...result, modelId: PRIMARY_LOCAL_MODEL_ID };
    }

    case 'initializeLocalModel': {
      if (localEngine.isMaintaining()) {
        return { success: false, error: 'Local model maintenance in progress.' };
      }
      localEngine.initialize(PRIMARY_LOCAL_MODEL_ID)
        .then(async backend => {
          if (!backend) return;
          // A terminal model error is persisted across MV3 worker restarts, but
          // the per-worker error counter is not. Always release content-side
          // error markers after an explicit successful Retry, even when this
          // fresh worker has no errors in its in-memory counter.
          await triggerErrorRetry(true, true);
        })
        .catch(err => {
          console.error('[LocalEngine] Initialization error:', err);
        });
      return { success: true, started: true, modelId: PRIMARY_LOCAL_MODEL_ID };
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

// Handle messages from content script
chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  console.log('[Background] onMessage:', message?.type, 'from:', sender?.url?.substring(0, 60), 'tab:', tabId);

  // --- Sync-only: pageLoad does not need async, just side effects ---
  if (message.type === 'pageLoad') {
    if (!tabId) return;
    startupReady.then(() => {
      registerContentTab(tabId);
      handlePageLoad(tabId);
      return chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }).then(([tab]) => {
      if (tab && tab.id === tabId) updateActiveTab(tabId);
    }).catch(err => console.error('[Background] pageLoad startup failed:', err));
    return;
  }

  // --- Sync-only: preemptInference fires and forgets ---
  if (message.type === 'preemptInference') {
    localEngine.preempt();
    return;
  }

  // --- All other message types: async with centralized error handling ---
  handleMessage(message, sender, sendResponse)
    .then(response => sendResponse(response))
    .catch(err => {
      console.error(`[Background] Error handling message type '${message.type}':`, err);
      const error = (err as Error).message;
      if (message.type === 'evaluatePost') {
        sendResponse({
          retry: true,
          reasoning: error || 'The local model is temporarily unavailable.',
          retryAfterMs: 1000,
        });
      } else if (message.type === 'suggestAnnoyingReasons') {
        sendResponse({ reasons: [], error });
      } else if (message.type === 'getAllLocalModelStatuses') {
        sendResponse({ error, statuses: null, webgpuSupported: !!navigator.gpu });
      } else if (message.type === 'initializeLocalModel'
          || message.type === 'cancelLocalModelDownload'
          || message.type === 'deleteLocalModel') {
        sendResponse({ success: false, error });
      } else {
        sendResponse({ error });
      }
    });

  return true; // Keep channel open for async response
});


// ==================== Storage change listener ====================

chrome.storage.onChanged.addListener((changes, areaName) => {
  (async () => {
    if (areaName !== 'local') return;
    await startupReady;

    // The schema-normalization write already clears the cross-model cache and
    // retired state atomically. Ignore its synthetic storage event.
    if (changes.gemmaOnlySchemaVersion) return;

    let normalizedRetiredModel = false;
    if (changes.selectedModel) {
      const newModel = changes.selectedModel.newValue as string | undefined;
      if (newModel !== DEFAULT_MODEL) {
        await setStorage({ selectedModel: DEFAULT_MODEL });
        normalizedRetiredModel = true;
      }
    }

    // Disabling Bouncer is also a verdict boundary: a batch that captured
    // enabled=true must not hide a post after the switch has been turned off.
    if (changes.selectedModel || changes.enabled) {
      await handleSettingsChange(changes);
    }
    if (normalizedRetiredModel) return;

    if (changes.localModelStatuses && errorState.count > 0) {
      const before = (changes.localModelStatuses.oldValue || {}) as Record<string, LocalModelStatus>;
      const after = (changes.localModelStatuses.newValue || {}) as Record<string, LocalModelStatus>;
      if (before[PRIMARY_LOCAL_MODEL_ID]?.state !== 'ready'
          && after[PRIMARY_LOCAL_MODEL_ID]?.state === 'ready') {
        await triggerErrorRetry();
      }
    }

    const filtersChanged = Object.keys(changes).some(
      key => key.startsWith('descriptions_')
    );
    if (filtersChanged) {
      await handleFilterPackChange();
    }
  })().catch(err => console.error('[Background] Storage change handler error:', err));
});

// ==================== Extension lifecycle ====================

// Check local model statuses on extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    (async () => {
      await startupReady;
      const statuses: Record<string, LocalModelStatus> = {};
      const webgpuSupported = !!navigator.gpu;
      const stored = await getStorage(['localModelStatuses']);
      const existingStatuses = stored.localModelStatuses ?? {};

      for (const model of PREDEFINED_MODELS.local) {
        const existingStatus = existingStatuses[model.name];
        // A terminal runtime error is a durable explicit-Retry fence. Extension
        // updates must not relabel it as merely cached and allow a later MV3
        // worker restart to silently reload the same failing model.
        if (existingStatus?.state === 'error') {
          statuses[model.name] = existingStatus;
        } else if (!webgpuSupported) {
          statuses[model.name] = { state: 'unsupported', reason: 'WebGPU not supported' };
        } else {
          const cached = await localEngine.checkCached(model.name);
          // Use 'cached' for models in cache but not loaded (they will auto-load when selected)
          statuses[model.name] = { state: cached ? 'cached' : 'not_downloaded' };
        }
      }

      await setStorage({ localModelStatuses: statuses });
    })().catch(err => console.error('[Background] onInstalled error:', err));
  }
});

// Clean up synchronous worker-owned bookkeeping before service worker
// termination. LiteRT-LM runs in an offscreen document, so this cannot promise
// an async engine unload; the next worker startup explicitly closes any orphan
// offscreen document before constructing a new engine.
// Note: onSuspend is not available in Safari service workers
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    localEngine.teardown();
  });
}
