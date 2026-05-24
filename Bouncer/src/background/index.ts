// Background script entry point: message handler, storage listener, startup, tab tracking

import { PREDEFINED_MODELS } from '../shared/models';
import { generateCacheKey } from '../shared/utils';
import { getStorage, setStorage } from '../shared/storage';
import type { ContentToBackgroundMessage, LocalModelStatus } from '../types';
import { localEngine } from './local-model';
import {
  initPipeline, loadCache, saveCache,
  setActiveTab, enqueuePost, isKeyPending, clearTabQueue,
  scheduleBatch, broadcastQueueStatus, getSettings,
  errorState,
  evaluationCache, clearEvaluationCache,
  handleSettingsChange, handleFilterPackChange, handlePageLoad, suggestAnnoyingReasons,
  replayDetectorStates,
} from './pipeline';

// ==================== Tab tracking ====================

// Set of tab IDs with active content scripts (for broadcasting)
const activeContentTabs = new Set<number>();

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

// Clean up tab tracking when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  activeContentTabs.delete(tabId);
  clearTabQueue(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
    setActiveTab(null);
  }

  // When no tabs remain, immediately unload the local model to free GPU memory.
  // Model weights stay in Cache Storage for fast reload when a tab opens again.
  if (activeContentTabs.size === 0 && localEngine.engine) {
    const modelId = localEngine.loadedModel;
    console.log('[WebLLM] No active tabs remaining, unloading engine for', modelId);
    localEngine.drainQueue(async () => {
      await localEngine.reset();
      if (modelId) {
        await localEngine.updateStatus(modelId, { state: 'cached' });
      }
    }).catch(err => {
      console.error('[WebLLM] Error unloading engine on last tab close:', err);
    });
  }
});

// ==================== Startup ====================

// Open uninstall survey when the extension is removed (not supported in Safari)
if (chrome.runtime.setUninstallURL) {
  chrome.runtime.setUninstallURL("https://forms.gle/41CSXsBcRMnjofVw8")
    .catch(err => console.error('[Startup] setUninstallURL failed:', err));
}

// Initialize cache, sync model statuses, and auto-init local model on startup
// Wrapped in try/catch to prevent unhandled rejections from destabilizing the service worker
(async () => {
  try {
    await loadCache();
    // Wire up pipeline with shared state
    initPipeline(activeContentTabs);
    await localEngine.syncAllStatuses();
    await localEngine.autoInitSelected();

    // Proactively detect active Bouncer tabs after service worker restart.
    // Without this, activeTabId stays null until a content script sends a message,
    // leaving the per-tab queue idle even if posts are already queued.
    try {
      const tabs = await chrome.tabs.query({ url: ['*://x.com/*'] });
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id!, { type: 'ping' });
          activeContentTabs.add(tab.id!);
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
    console.error('[Background] Startup initialization error (non-fatal):', e);
  }
})().catch(err => console.error('[Background] Startup error:', err));

// ==================== Message handler ====================

// Async message handler — each case returns the response object.
// Centralized .catch() in the listener ensures sendResponse is always called.
async function handleMessage(
  message: ContentToBackgroundMessage,
  sender: chrome.runtime.MessageSender,
  _sendResponse: (response?: unknown) => void
): Promise<unknown> {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'evaluatePost': {
      console.log('[Bouncer][diag] evaluatePost received: tabId=', tabId, 'activeTabId=', activeTabId, 'sender.tab=', !!sender.tab);
      // Ensure tab is registered (re-registers after service worker restart)
      if (tabId) activeContentTabs.add(tabId);

      // Posts flow through processBatch so the popup gets a consistent filter-tab
      // dispatch even when no phrases are configured (the detector marks itself
      // skipped with a reason).
      const settings = await getSettings(message.siteId);

      // No usable local model — none selected, or this browser has no WebGPU.
      // Return retry (not an error) so the content script leaves the post alone,
      // drops it from processedPosts, and re-evaluates once a model is ready. The
      // in-feed model-status indicator tells the user how to set one up.
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

      await loadCache();
      const imageUrls = message.imageUrls || [];
      const cacheKey = generateCacheKey(message.post, imageUrls);

      // Check main cache
      if (evaluationCache.has(cacheKey)) {
        const cached = evaluationCache.get(cacheKey)!;
        if (tabId !== undefined) replayDetectorStates(tabId, message.evaluationId, cached);
        return { ...cached, cached: true };
      }

      // Check if already in queue - add another resolver for this item
      if (tabId !== undefined && isKeyPending(tabId, cacheKey)) {
        return new Promise(resolve => {
          const item = { evaluationId: message.evaluationId, post: message.post, rawText: message.rawText, imageUrls, resolve, cacheKey, tabId, postUrl: message.postUrl, siteId: message.siteId };
          enqueuePost(tabId, item);
        });
      }

      // Queue for batch processing
      // processBatch will prioritize posts closest to viewport center for local models
      const resultPromise = new Promise(resolve => {
        const item = { evaluationId: message.evaluationId, post: message.post, rawText: message.rawText, imageUrls, resolve, cacheKey, tabId, postUrl: message.postUrl, siteId: message.siteId };
        enqueuePost(tabId!, item);
      });
      console.log('[Bouncer][diag] evaluatePost enqueued for tab', tabId);

      // On first evaluatePost when activeTabId is unknown, detect if this tab is active
      if (activeTabId === null) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
          console.log('[Bouncer][diag] tabs.query(active,lastFocused) returned', tabs.length, 'tab(s); first.id=', tabs[0]?.id, 'msg.tabId=', tabId);
          const tab = tabs[0];
          if (tab && tab.id === tabId) updateActiveTab(tabId);
        }).catch((err) => { console.log('[Bouncer][diag] tabs.query failed:', err); });
      }

      console.log('[Bouncer][diag] calling scheduleBatch; activeTabId=', activeTabId);
      scheduleBatch();
      broadcastQueueStatus().catch(err => console.error('[Background] broadcastQueueStatus error:', err));
      return resultPromise;
    }

    case 'suggestAnnoyingReasons': {
      try {
        const imageUrls = message.imageUrls || [];
        const reasons = await suggestAnnoyingReasons(message.post, imageUrls, message.siteId || 'twitter', sender.tab?.id);
        return { reasons, hadImages: imageUrls.length > 0 };
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
      const cacheKey = generateCacheKey(message.post, message.imageUrls || []);
      if (evaluationCache.has(cacheKey)) {
        evaluationCache.delete(cacheKey);
        await saveCache();
      }
      return { success: true };
    }

    case 'overrideCacheEntry': {
      await loadCache();
      const cacheKey = generateCacheKey(message.post, message.imageUrls || []);
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
      const cacheKey = generateCacheKey(message.post, message.imageUrls || []);
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
      const settings = await getSettings();
      return {
        errorType: errorState.type,
        subType: errorState.subType,
        count: errorState.count,
        apiDisplayName: errorState.apiDisplayName,
        selectedModel: settings.selectedModel,
        hasAlternativeApis: false
      };
    }

    case 'getAllLocalModelStatuses': {
      const data = await getStorage(['localModelStatuses']);
      const statuses: Record<string, { state: string; reason?: string }> = (data.localModelStatuses || {});

      // Check WebGPU support
      const webgpuSupported = !!navigator.gpu;

      // Always check cache status for models not currently in a loading state
      for (const model of PREDEFINED_MODELS.local) {
        const currentStatus = statuses[model.name];
        // Skip cache check only if actively downloading/initializing
        const isLoading = currentStatus?.state === 'downloading' || currentStatus?.state === 'initializing';

        if (!isLoading) {
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
      const modelId = message.modelId;
      if (!modelId) {
        return { success: false, error: 'No model ID provided' };
      }
      const cancelled = await localEngine.cancelDownload(modelId);
      return { success: true, cancelled, modelId };
    }

    case 'deleteLocalModel': {
      const modelId = message.modelId;
      if (!modelId) {
        return { success: false, error: 'No model ID provided' };
      }
      const result = await localEngine.deleteModelCache(modelId);
      return { ...result, modelId };
    }

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

    // Track this tab as having an active content script
    activeContentTabs.add(tabId);
    handlePageLoad(tabId);

    // Detect active tab (handles service worker restart where onActivated doesn't re-fire)
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      if (tab && tab.id === tabId) updateActiveTab(tabId);
    }).catch(() => {});
    return;
  }

  // --- Sync-only: preemptInference fires and forgets ---
  if (message.type === 'preemptInference') {
    localEngine.preempt();
    return;
  }

  // --- Fire-and-forget: initializeWebLLM responds synchronously, starts async work ---
  if (message.type === 'initializeWebLLM') {
    console.log('[Background] initializeWebLLM received, modelId:', message.modelId, 'hasNativeBridge:', typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>)?.webkit);
    const modelId = message.modelId;
    if (!modelId) {
      sendResponse({ success: false, error: 'No model ID provided' });
      return false;
    }
    // Start initialization but respond immediately - progress is tracked via storage
    localEngine.initialize(modelId).catch(err => {
      console.error('[WebLLM] Initialization error for', modelId, ':', err);
    });
    sendResponse({ success: true, started: true, modelId });
    return false; // Synchronous response
  }

  // --- All other message types: async with centralized error handling ---
  handleMessage(message, sender, sendResponse)
    .then(response => sendResponse(response))
    .catch(err => {
      console.error(`[Background] Error handling message type '${message.type}':`, err);
      sendResponse({ error: (err as Error).message });
    });

  return true; // Keep channel open for async response
});


// ==================== Storage change listener ====================

chrome.storage.onChanged.addListener((changes, areaName) => {
  (async () => {
    if (areaName !== 'local') return;

    if (changes.selectedModel) {
      // If switching away from local model, unload the engine to free GPU memory
      const oldModel = changes.selectedModel.oldValue as string | undefined;
      const newModel = changes.selectedModel.newValue as string | undefined;
      const wasLocal = oldModel?.startsWith('local:');
      const isLocal = newModel?.startsWith('local:');

      if (wasLocal && !isLocal && localEngine.engine) {
        const unloadedModelId = oldModel!.split(':')[1];
        // Drain inference queue so any in-flight task finishes before disposal
        await localEngine.drainQueue(async () => {
          await localEngine.reset();
        });
        // Update status so popup shows 'cached' instead of stale 'ready'
        await localEngine.updateStatus(unloadedModelId, { state: 'cached' });
      }

      // If switching to a local model, auto-initialize if cached
      if (isLocal) {
        const modelId = newModel!.split(':')[1];
        const cached = await localEngine.checkCached(modelId);
        if (cached) {
          localEngine.initialize(modelId).catch(err => {
            console.error('[WebLLM] Auto-init on model switch failed:', err);
          });
        }
      }

      // Model change: flush pipeline state and wipe cache — classifications from a different model are no longer valid.
      await handleSettingsChange(changes);
    }

    const filtersChanged = Object.keys(changes).some(
      key => key.startsWith('descriptions_')
    );
    if (filtersChanged) {
      handleFilterPackChange();
    }
  })().catch(err => console.error('[Background] Storage change handler error:', err));
});

// ==================== Extension lifecycle ====================

// Check local model statuses on extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'https://x.com' }).catch(err => console.error('[Background] Failed to open x.com on install:', err));
  }

  if (details.reason === 'install' || details.reason === 'update') {
    (async () => {

      const statuses: Record<string, LocalModelStatus> = {};
      const webgpuSupported = !!navigator.gpu;

      for (const model of PREDEFINED_MODELS.local) {
        if (!webgpuSupported) {
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

// Clean up references before service worker terminates.
// Don't call engine.unload() — it's async and can't complete before Chrome kills
// the worker. GPU memory is freed automatically when Chrome's GPU process tears
// down the Dawn Wire IPC channel for the terminated worker.
// Note: onSuspend is not available in Safari service workers
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    localEngine.teardown();
  });
}
