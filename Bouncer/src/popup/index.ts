// Bouncer - Popup Script (local-only)

import type { ModelDef, LocalModelStatus } from '../types';
import { PREDEFINED_MODELS, DEFAULT_MODEL } from '../shared/models';
import { escapeHtml, parseHTML } from '../shared/utils';
import { getStorage, setStorage } from '../shared/storage';
import { asyncHandler } from '../shared/async';

// Track local model statuses (per-model)
let localModelStatuses: Record<string, LocalModelStatus> = {};
let webgpuSupported = true;

// In-app mode detection (native WebView bridge sets chrome._polyfilled)
const isInAppMode = typeof chrome !== 'undefined' && chrome._polyfilled;

// User-friendly error message mapping for WebLLM errors
const WEBLLM_ERROR_MESSAGES: Record<string, { display: string; hint: string }> = {
  'device lost': {
    display: 'GPU device was lost',
    hint: 'Try closing other tabs or restarting your browser.'
  },
  'device destroyed': {
    display: 'GPU device error',
    hint: 'Try closing other GPU-intensive tabs or restart browser.'
  },
  'out of memory': {
    display: 'Not enough GPU memory',
    hint: 'Close other GPU-intensive applications or use a smaller model.'
  },
  'oom': {
    display: 'GPU memory exhausted',
    hint: 'Close other tabs or use a smaller model.'
  },
  'gpu memory': {
    display: 'GPU memory issue',
    hint: 'Try a smaller model or close other GPU-intensive tabs.'
  },
  'webgpu not': {
    display: 'WebGPU not supported',
    hint: 'Your browser or device does not support local AI models.'
  },
  'network': {
    display: 'Network error',
    hint: 'Check your internet connection and try again.'
  },
  'download failed': {
    display: 'Download failed',
    hint: 'Check your internet connection and try again.'
  },
  'fetch': {
    display: 'Download failed',
    hint: 'Check your internet connection and try again.'
  },
  'timeout': {
    display: 'Model response timeout',
    hint: 'The model took too long to respond. Try again or use a smaller model.'
  },
  'inference timeout': {
    display: 'Inference timeout',
    hint: 'The model was too slow. Try again or switch to a smaller model.'
  }
};

// Get user-friendly error message for WebLLM errors
function getUserFriendlyError(errorMessage: string | undefined): { display: string; hint: string } {
  if (!errorMessage) return { display: 'Unknown error', hint: 'Try again or switch models.' };

  const lowerError = errorMessage.toLowerCase();
  for (const [pattern, info] of Object.entries(WEBLLM_ERROR_MESSAGES)) {
    if (lowerError.includes(pattern)) {
      return info;
    }
  }
  // If already user-friendly (from background), use as-is
  if (errorMessage.includes('Try ') || errorMessage.includes('Close ') || errorMessage.includes('Check ')) {
    return { display: errorMessage, hint: '' };
  }
  return { display: errorMessage, hint: 'Try again or switch to a different model.' };
}

document.addEventListener('DOMContentLoaded', () => { init().catch(err => console.error('[Popup] Init failed:', err)); });

export async function init() {
  console.log('[Popup] init() called');
  try {
    const isModal = window.self !== window.top;

    // Detect if we're in an iframe (modal mode)
    if (isModal) {
      document.body.classList.add('modal-mode');

      // Set up close buttons to message parent
      for (const btn of document.querySelectorAll('.modal-close-btn')) {
        btn.addEventListener('click', () => {
          window.parent.postMessage({ type: 'closeSettingsModal' }, '*');
        });
      }

      // Listen for theme message from parent
      window.addEventListener('message', (event) => {
        const data = event.data as { type?: string; theme?: string } | null;
        if (data && data.type === 'setTheme') {
          const theme = data.theme;
          document.body.classList.remove('light-mode', 'dim-mode', 'dark-mode');
          document.body.classList.add(`${theme}-mode`);
        }
      });

      // Report content height changes to parent so iframe can resize dynamically
      const sendSize = () => {
        const height = document.body.scrollHeight + 2;
        window.parent.postMessage({ type: 'settingsResize', height }, '*');
      };
      const resizeObserver = new ResizeObserver(sendSize);
      resizeObserver.observe(document.body);
      sendSize();
    }

    await loadSettings();
    setupEventListeners();

    // Initialize local model UI
    await updateLocalModelStatus();
    setupLocalModelListeners();
    setupStorageListener();
    console.log('[Popup] init() completed successfully');
  } catch (e) {
    console.error('[Popup] init() ERROR:', e, (e as Error).stack);
  }
}

function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.localModelStatuses) {
      localModelStatuses = (changes.localModelStatuses.newValue as Record<string, LocalModelStatus>) || {};
      updateLocalModelSectionUI();
      refreshModelDropdownWithLocal().catch(err => console.error('[Popup] refreshModelDropdownWithLocal failed:', err));
    }
    if (changes.filterReplies) {
      const checked = changes.filterReplies.newValue !== false;
      const el = document.getElementById('enableFilterReplies') as HTMLInputElement | null;
      if (el && el.checked !== checked) el.checked = checked;
    }
  });
}

async function loadSettings() {
  const data = await getStorage(['selectedModel', 'customModels', 'filterReplies']);

  // "Filter replies in conversations" toggle (defaults to true so existing
  // installs keep filtering replies). The content script reads the same
  // key and skips reply evaluation on permalink pages when this is off.
  const filterRepliesEl = document.getElementById('enableFilterReplies') as HTMLInputElement | null;
  if (filterRepliesEl) filterRepliesEl.checked = data.filterReplies !== false;

  // Model selection
  renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);

  // Update local model section visibility
  updateLocalModelSectionVisibility();
}

function setupEventListeners() {
  // Model dropdown
  setupModelDropdown();

  document.getElementById('enableFilterReplies')?.addEventListener('change', (e) => { (async () => {
    const checked = (e.target as HTMLInputElement).checked;
    await setStorage({ filterReplies: checked });
  })().catch(err => console.error('[Popup] enableFilterReplies change failed:', err)); });
}

// ==================== Model Dropdown ====================

interface DropdownState {
  isOpen: boolean;
  customModels: ModelDef[];
  selectedModel: string;
}

const dropdownState: DropdownState = {
  isOpen: false,
  customModels: [],
  selectedModel: DEFAULT_MODEL,
};

function setupModelDropdown() {
  const dropdown = document.getElementById('modelDropdown')!;
  const selected = document.getElementById('modelDropdownSelected')!;

  // Toggle dropdown on click
  selected.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target as Node)) {
      closeDropdown();
    }
  });
}

function toggleDropdown() {
  if (dropdownState.isOpen) {
    closeDropdown();
  } else {
    openDropdown();
  }
}

function openDropdown() {
  dropdownState.isOpen = true;
  document.getElementById('modelDropdown')!.classList.add('open');
}

function closeDropdown() {
  dropdownState.isOpen = false;
  document.getElementById('modelDropdown')!.classList.remove('open');
}

async function selectModel(modelKey: string) {
  dropdownState.selectedModel = modelKey;
  await setStorage({ selectedModel: modelKey });
  renderModelDropdown(dropdownState.customModels, modelKey);
  closeDropdown();
  // Clear cache since model changed
  await chrome.runtime.sendMessage({ type: 'clearCache' });

  // Clear auto-init tracking when switching models to allow re-initialization
  autoInitTriggered.clear();

  // Update local model section visibility and UI when selection changes
  updateLocalModelSectionVisibility();
  updateLocalModelSectionUI();
}

// Show/hide the local model section based on whether a local model is selected
function updateLocalModelSectionVisibility() {
  const localModelSection = document.getElementById('localModelSection')!;
  const isLocalModelSelected = dropdownState.selectedModel?.startsWith('local:');
  localModelSection.style.display = isLocalModelSelected ? 'block' : 'none';
}

async function removeModel(modelKey: string, e: Event) {
  e.stopPropagation();

  // Parse the model key to find the model to remove
  const [api, ...nameParts] = modelKey.split(':');
  const name = nameParts.join(':');

  const newModels = dropdownState.customModels.filter(
    m => !(m.api === api && m.name === name)
  );
  dropdownState.customModels = newModels;

  // If we're removing the currently selected model, switch to default
  if (dropdownState.selectedModel === modelKey) {
    dropdownState.selectedModel = DEFAULT_MODEL;
    await setStorage({ customModels: newModels, selectedModel: DEFAULT_MODEL });
    // Clear cache since model changed
    await chrome.runtime.sendMessage({ type: 'clearCache' });
  } else {
    await setStorage({ customModels: newModels });
  }

  renderModelDropdown(newModels, dropdownState.selectedModel);
}

// Local (WebLLM) model weights live in browser Cache Storage, not in
// customModels, so removeModel() can't delete them. This sends the background
// a one-shot delete (no confirm — matches the custom-model "×" button). The
// in-flight Set + disabled button just debounce double-clicks.
const deletingModels = new Set<string>();

async function deleteLocalModelWeights(modelName: string, btn: HTMLButtonElement, e: Event) {
  e.stopPropagation();
  if (deletingModels.has(modelName)) return;
  deletingModels.add(modelName);
  btn.disabled = true;
  try {
    const res: { success?: boolean; error?: string } =
      await chrome.runtime.sendMessage({ type: 'deleteLocalModel', modelId: modelName });
    if (!res?.success) console.error('[Popup] deleteLocalModel failed:', res?.error);
  } catch (err) {
    console.error('[Popup] deleteLocalModel error:', err);
  } finally {
    deletingModels.delete(modelName);
    // Authoritatively re-fetch cache status; updateLocalModelStatus() also
    // re-renders the dropdown, so the deleted model's bin disappears and its
    // ⬇ indicator returns without waiting on the storage-change listener.
    await updateLocalModelStatus();
  }
}

function renderModelDropdown(customModels: ModelDef[], selectedModel: string) {
  // Update state
  dropdownState.customModels = customModels;
  dropdownState.selectedModel = selectedModel;

  // Update selected display text
  const selectedText = document.querySelector('.model-dropdown-text')!;
  if (!selectedModel) {
    selectedText.textContent = 'Select a model';
  } else {
    // Parse model key (format: local:modelName)
    const [api, ...nameParts] = selectedModel.split(':');
    const modelName = nameParts.join(':');
    const predefinedModel = (PREDEFINED_MODELS[api] || []).find(m => m.name === modelName);
    selectedText.textContent = predefinedModel ? predefinedModel.display : modelName;
  }

  // Build menu items
  const menu = document.getElementById('modelDropdownMenu')!;
  menu.replaceChildren();

  // Local models (only show if WebGPU is supported)
  if ((webgpuSupported || isInAppMode) && PREDEFINED_MODELS.local) {
    // Add predefined local models
    PREDEFINED_MODELS.local.forEach(model => {
      const modelKey = `local:${model.name}`;
      const status = localModelStatuses[model.name] || { state: 'not_downloaded' };
      const isReady = status.state === 'ready' || status.state === 'cached'; // cached models are available for auto-load
      const isDownloading = status.state === 'downloading' || status.state === 'initializing';

      const localItem = document.createElement('div');
      localItem.className = 'model-dropdown-item' + (selectedModel === modelKey ? ' selected' : '');

      // Show different indicators based on status
      let statusIndicator = '';
      if (isDownloading) {
        statusIndicator = '<span class="download-indicator">⏳</span>';
      } else if (!isReady) {
        statusIndicator = '<span class="download-indicator">⬇</span>';
      }

      // Only downloaded models get a delete control, and it lives here in the
      // dropdown (not the Local Model section, which only renders for the
      // *selected* model) so any downloaded model — selected or not — can be
      // removed.
      const deleteBtn = isReady
        ? '<button class="model-dropdown-item-delete" title="Delete downloaded model">🗑</button>'
        : '';
      localItem.replaceChildren(parseHTML(`<span class="model-dropdown-item-text">${escapeHtml(model.display)} <span class="local-badge">local</span>${statusIndicator}</span>${deleteBtn}`));
      localItem.querySelector('.model-dropdown-item-text')!.addEventListener('click', asyncHandler(() => selectModel(modelKey)));
      const delEl = localItem.querySelector<HTMLButtonElement>('.model-dropdown-item-delete');
      if (delEl) delEl.addEventListener('click', (e) => {
        deleteLocalModelWeights(model.name, delEl, e).catch(err => console.error('[Popup] deleteLocalModelWeights failed:', err));
      });
      menu.appendChild(localItem);
    });

    // Add custom local models (user-added WebLLM models)
    const customLocalModels = customModels.filter(m => m.api === 'local');
    customLocalModels.forEach(model => {
      const modelKey = `local:${model.name}`;
      const status = localModelStatuses[model.name] || { state: 'not_downloaded' };
      const isReady = status.state === 'ready' || status.state === 'cached'; // cached models are available for auto-load
      const isDownloading = status.state === 'downloading' || status.state === 'initializing';

      const localItem = document.createElement('div');
      localItem.className = 'model-dropdown-item' + (selectedModel === modelKey ? ' selected' : '');

      // Show different indicators based on status
      let statusIndicator = '';
      if (isDownloading) {
        statusIndicator = '<span class="download-indicator">⏳</span>';
      } else if (!isReady) {
        statusIndicator = '<span class="download-indicator">⬇</span>';
      }

      localItem.replaceChildren(parseHTML(`
        <span class="model-dropdown-item-text">${escapeHtml(model.name)} <span class="local-badge">local</span>${statusIndicator}</span>
        <button class="model-dropdown-item-remove" title="Remove model">&times;</button>
      `));
      localItem.querySelector('.model-dropdown-item-text')!.addEventListener('click', asyncHandler(() => selectModel(modelKey)));
      localItem.querySelector('.model-dropdown-item-remove')!.addEventListener('click', (e) => { removeModel(modelKey, e).catch(err => console.error('[Popup] removeModel failed:', err)); });
      menu.appendChild(localItem);
    });
  }

  // Empty-state placeholder.
  if (menu.childElementCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'model-dropdown-empty';
    empty.textContent = webgpuSupported
      ? 'No local models available'
      : 'WebGPU not supported — local models unavailable';
    menu.appendChild(empty);
  }
}

// ==================== Local Model (WebLLM) ====================

// Get current statuses for all local models from background
async function updateLocalModelStatus() {
  try {
    const response: { statuses?: Record<string, LocalModelStatus>; webgpuSupported?: boolean } = await chrome.runtime.sendMessage({ type: 'getAllLocalModelStatuses' });
    localModelStatuses = response?.statuses || {};
    webgpuSupported = response?.webgpuSupported !== false;
  } catch (err) {
    console.debug('Failed to get local model statuses:', err);
    localModelStatuses = {};
    webgpuSupported = true; // Assume supported, will be corrected if not
  }

  // Always update UI, even on error
  updateLocalModelSectionUI();
  // The first dropdown render (loadSettings → renderModelDropdown) runs before
  // these real cache statuses arrive, so it shows every local model as
  // not_downloaded (no delete control / wrong download indicator). Re-render
  // now that localModelStatuses is populated.
  await refreshModelDropdownWithLocal();
}

// Get the currently selected local model (if any)
function getSelectedLocalModel(): ModelDef | null {
  if (!dropdownState.selectedModel || !dropdownState.selectedModel.startsWith('local:')) {
    return null;
  }
  const modelName = dropdownState.selectedModel.split(':')[1];
  // First check predefined models
  const predefinedModel = PREDEFINED_MODELS.local.find(m => m.name === modelName);
  if (predefinedModel) {
    return predefinedModel;
  }
  // Then check custom local models
  const customModel = dropdownState.customModels.find(m => m.api === 'local' && m.name === modelName);
  return customModel || null;
}

// Track which models we've already triggered auto-initialization for to prevent duplicate calls
const autoInitTriggered = new Set<string>();

// Auto-initialize a cached model (called when 'cached' state is detected)
async function autoInitializeCachedModel(modelId: string) {
  // Prevent duplicate initialization triggers
  if (autoInitTriggered.has(modelId)) {
    return;
  }
  autoInitTriggered.add(modelId);

  console.log('[LocalModel] Auto-initializing cached model:', modelId);
  try {
    await chrome.runtime.sendMessage({ type: 'initializeWebLLM', modelId });
  } catch (err) {
    console.error('[LocalModel] Failed to auto-initialize cached model:', err);
    autoInitTriggered.delete(modelId);
  }
}

// Update the local model section UI based on selected model and its status
function updateLocalModelSectionUI() {
  const badge = document.getElementById('localModelStatusBadge')!;
  const unsupported = document.getElementById('localModelUnsupported')!;
  const notDownloaded = document.getElementById('localModelNotDownloaded')!;
  const downloading = document.getElementById('localModelDownloading')!;
  const ready = document.getElementById('localModelReady')!;
  const errorDiv = document.getElementById('localModelError')!;
  const progressFill = document.getElementById('localProgressFill')!;
  const progressText = document.getElementById('localProgressText')!;
  const errorText = document.getElementById('localModelErrorText')!;
  const downloadHint = document.getElementById('localModelDownloadHint');
  const readyHint = document.getElementById('localModelReadyHint');
  const noImageWarning = document.getElementById('localModelNoImageWarning');

  // Hide all states first
  unsupported.style.display = 'none';
  notDownloaded.style.display = 'none';
  downloading.style.display = 'none';
  ready.style.display = 'none';
  errorDiv.style.display = 'none';
  if (noImageWarning) noImageWarning.style.display = 'none';

  // Reset badge classes
  badge.classList.remove('connected', 'downloading', 'ready', 'error', 'auth-error');

  // Check if a local model is selected
  const selectedLocalModel = getSelectedLocalModel();

  if (!webgpuSupported && !isInAppMode) {
    // WebGPU not supported (and not in native bridge mode) - show unsupported message
    badge.textContent = 'Unsupported';
    badge.classList.add('error');
    unsupported.style.display = 'block';
    return;
  }

  if (!selectedLocalModel) {
    // No local model selected - show hint to select one
    badge.textContent = 'Select a model';
    notDownloaded.style.display = 'block';
    if (downloadHint) {
      downloadHint.textContent = 'Select a local model from the dropdown above to use local inference.';
    }
    document.getElementById('downloadLocalModel')!.style.display = 'none';
    return;
  }

  // Check if the model supports images and show warning if not
  if (noImageWarning && !selectedLocalModel.supportsImages) {
    noImageWarning.style.display = 'block';
  }

  // Get status for the selected model
  const status = localModelStatuses[selectedLocalModel.name] || { state: 'not_downloaded' };
  const state = status.state || 'not_downloaded';

  switch (state) {
    case 'unsupported':
      badge.textContent = 'Unsupported';
      badge.classList.add('error');
      unsupported.style.display = 'block';
      break;

    case 'cached':
      // Model is cached but not loaded - auto-initialize it
      badge.textContent = 'Loading...';
      badge.classList.add('downloading');
      downloading.style.display = 'block';
      progressFill.style.width = '0%';
      progressText.textContent = 'Loading cached model...';
      // Trigger auto-initialization (async, don't await)
      autoInitializeCachedModel(selectedLocalModel.name).catch(err => console.error('[WebLLM] autoInitializeCachedModel failed:', err));
      break;

    case 'not_downloaded': {
      badge.textContent = 'Not downloaded';
      notDownloaded.style.display = 'block';
      if (downloadHint) {
        const sizeText = selectedLocalModel.sizeGB ? `(~${selectedLocalModel.sizeGB}GB)` : '';
        downloadHint.textContent = `Download ${selectedLocalModel.display} ${sizeText} to run inference locally without API calls.`;
      }
      const downloadBtn = document.getElementById('downloadLocalModel') as HTMLButtonElement;
      downloadBtn.style.display = 'inline-flex';
      downloadBtn.disabled = false;
      downloadBtn.replaceChildren(parseHTML('<span class="download-icon">&#8595;</span> Download Model'));
      break;
    }

    case 'initializing':
    case 'downloading': {
      badge.textContent = 'Downloading...';
      badge.classList.add('downloading');
      downloading.style.display = 'block';
      const progress = status.progress || 0;
      progressFill.style.width = `${(progress * 100).toFixed(1)}%`;
      progressText.textContent = status.text || `${(progress * 100).toFixed(1)}%`;
      break;
    }

    case 'ready':
      badge.textContent = 'Ready';
      badge.classList.add('ready');
      ready.style.display = 'block';
      if (readyHint) {
        readyHint.textContent = `${selectedLocalModel.display} is ready for local inference.`;
      }
      break;

    case 'error': {
      badge.textContent = 'Error';
      badge.classList.add('error');
      errorDiv.style.display = 'block';
      const friendlyError = getUserFriendlyError(status.error);
      const hintText = friendlyError.hint ? ` ${friendlyError.hint}` : '';
      errorText.textContent = (friendlyError.display || 'An error occurred') + hintText;
      break;
    }

    default:
      badge.textContent = 'Unknown';
      notDownloaded.style.display = 'block';
  }
}

// Set up event listeners for local model UI
function setupLocalModelListeners() {
  const downloadBtn = document.getElementById('downloadLocalModel') as HTMLButtonElement | null;
  const retryBtn = document.getElementById('retryLocalModel') as HTMLButtonElement | null;

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => { (async () => {
      const selectedLocalModel = getSelectedLocalModel();
      if (!selectedLocalModel) {
        console.error('No local model selected');
        return;
      }

      downloadBtn.disabled = true;
      downloadBtn.replaceChildren(parseHTML('<span class="download-icon">&#8987;</span> Starting...'));

      try {
        const result: unknown = await chrome.runtime.sendMessage({ type: 'initializeWebLLM', modelId: selectedLocalModel.name });
        console.log('[Popup] initializeWebLLM response:', result);
      } catch (err) {
        console.error('[Popup] Failed to start model download:', err);
        downloadBtn.disabled = false;
        downloadBtn.replaceChildren(parseHTML('<span class="download-icon">&#8595;</span> Download Model'));
      }
    })().catch(err => console.error('[Popup] download click failed:', err)); });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', () => { (async () => {
      const selectedLocalModel = getSelectedLocalModel();
      if (!selectedLocalModel) {
        console.error('No local model selected');
        return;
      }

      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying...';

      try {
        await chrome.runtime.sendMessage({ type: 'initializeWebLLM', modelId: selectedLocalModel.name });
      } catch (err) {
        console.error('Failed to retry model download:', err);
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry';
      }
    })().catch(err => console.error('[Popup] retry click failed:', err)); });
  }

  const cancelBtn = document.getElementById('cancelLocalModelDownload') as HTMLButtonElement | null;
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => { (async () => {
      const selectedLocalModel = getSelectedLocalModel();
      if (!selectedLocalModel) return;

      cancelBtn.disabled = true;
      try {
        await chrome.runtime.sendMessage({ type: 'cancelLocalModelDownload', modelId: selectedLocalModel.name });
      } catch (err) {
        console.error('Failed to cancel download:', err);
      }
      cancelBtn.disabled = false;
    })().catch(err => console.error('[Popup] cancel download failed:', err)); });
  }
}

// Refresh model dropdown with current local model statuses
async function refreshModelDropdownWithLocal() {
  const data = await getStorage(['customModels', 'selectedModel']);
  renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);
}
