import type { EngineSelection, InferenceEngineId, LocalModelStatus } from '../types';

const EXTENSION_ORIGIN = 'chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm';

export interface EngineStatusView {
  badge: string;
  tone?: 'busy' | 'ready' | 'error';
  text: string;
  action?: 'choose' | 'download' | 'cancel' | 'connect' | 'retry' | 'recover';
  details?: string;
  progress?: number;
  progressText?: string;
  /** Kept for the existing native settings consumers. */
  connect?: boolean;
  retry?: boolean;
  recover?: boolean;
  help?: string;
}

/** Status revisions are only ordered inside this exact selection identity. */
export function statusMatchesSelection(status: LocalModelStatus, selection: EngineSelection): boolean {
  return status.engine === selection.engine && status.selectionRevision === selection.revision;
}

export function engineName(engine: InferenceEngineId | null | undefined): string {
  return engine === 'litertlm' ? 'Browser AI' : engine === 'ollama' ? 'Ollama' : 'Local AI';
}

export function formatModelBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB';
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(2)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

export function engineStatusView(status: LocalModelStatus, selection?: EngineSelection): EngineStatusView {
  if (selection && !statusMatchesSelection(status, selection)) {
    return { badge: 'Checking…', text: 'Checking your chosen local AI option…' };
  }
  const engine = selection?.engine ?? status.engine;
  if (status.state === 'not_configured' || engine === null) {
    return { badge: 'Choose an option', text: 'Choose where automatic filtering runs. Manual Bounce and Restore stay available.', action: 'choose' };
  }
  if (status.state === 'switching') {
    return { badge: 'Switching…', tone: 'busy', text: `Your choice is saved. Finishing the previous request before ${engineName(engine)} can run.` };
  }
  if (status.state === 'recovery_required' && engine === 'litertlm') {
    return { badge: 'Recovery needed', tone: 'error', text: 'Browser AI selected · previous Ollama request needs recovery. Manual Bounce and Restore still work.', action: status.recoveryQualified === true ? 'recover' : undefined, recover: status.recoveryQualified === true, retry: false, details: 'Finish the full Ollama restart in Setup help, then confirm recovery. Choosing Browser AI does not stop a previous Ollama request.' };
  }
  if ((status.state === 'blocked' || status.state === 'error') && status.reason === 'browser_cleanup_failed') {
    return { badge: 'Cleanup needed', tone: 'error', text: 'Browser AI could not finish releasing its resources. Retry cleanup before automatic filtering resumes. Your choice is saved; manual Bounce and Restore still work.', action: 'retry', retry: true };
  }
  if (engine !== 'litertlm') return nativeStatusView(status);
  switch (status.state) {
    case 'needs_download':
    case 'missing_model':
      return { badge: 'Download needed', text: 'Download the fixed Gemma model to this Chrome profile. About 2 GB is fetched from Hugging Face; post text stays on your device.', action: 'download' };
    case 'downloading': {
      const received = status.receivedBytes;
      const total = status.totalBytes;
      const bytesKnown = typeof received === 'number' && Number.isFinite(received) && received >= 0;
      const totalKnown = typeof total === 'number' && Number.isFinite(total) && total > 0;
      const progress = bytesKnown && totalKnown ? Math.min(100, Math.max(0, received / total * 100)) : undefined;
      const verifying = progress === 100;
      return { badge: verifying ? 'Verifying…' : 'Downloading…', tone: 'busy', text: verifying ? 'Checking the downloaded model files before they can be used.' : 'Downloading model files. You can cancel and keep your Browser AI choice.', action: 'cancel', progress, progressText: bytesKnown ? `${formatModelBytes(received)}${totalKnown ? ` of ${formatModelBytes(total)} · ${Math.floor(progress!)}%` : ' downloaded'}` : 'Waiting for download progress…' };
    }
    case 'canceling':
      return { badge: 'Finishing cancellation…', tone: 'busy', text: 'Waiting for the browser operation to stop. Your choice and filter phrases are saved.' };
    case 'ready':
      return { badge: 'Ready', tone: 'ready', text: 'Model downloaded. Loads when needed in this Chrome profile, then releases GPU memory after idle use.' };
    case 'loading':
      return { badge: 'Preparing…', tone: 'busy', text: 'Preparing the downloaded model on your GPU for this request. Post text stays on your device.', action: 'cancel' };
    case 'filtering':
      return { badge: 'Filtering', tone: 'ready', text: 'Filtering text with Gemma in your browser.' };
    case 'paused':
      return { badge: 'Paused', text: status.reason === 'browser_cancelled'
        ? 'Preparation canceled. Your model files are saved. Retry browser AI when you’re ready; manual Bounce and Restore still work.'
        : 'Browser AI is paused. Manual Bounce and Restore still work.', action: 'retry' };
    case 'blocked':
    case 'error':
      return browserErrorView(status.reason);
    case 'not_connected':
      return { badge: 'Download needed', text: 'Browser AI is selected. Download its model files before automatic filtering can run.', action: 'download' };
    case 'recovery_required':
      return nativeStatusView(status);
  }
}

function browserErrorView(reason?: string): EngineStatusView {
  if (['webgpu_unavailable', 'gpu_unavailable', 'unsupported_gpu', 'webgpu', 'gpu_unsupported'].includes(reason || '')) {
    return { badge: 'GPU unavailable', tone: 'error', text: 'This Chrome session cannot use WebGPU. Try again after checking Chrome’s hardware acceleration, or choose Ollama.', action: 'retry', details: 'Your Browser AI choice is saved. Bouncer will not switch engines automatically.' };
  }
  if (['quota', 'storage_full', 'quota_exceeded'].includes(reason || '')) {
    return { badge: 'Storage needed', tone: 'error', text: 'Chrome could not save the model. Free about 2 GB of storage, then try the download again.', action: 'download' };
  }
  if (['download', 'download_failed', 'integrity', 'integrity_failed', 'model_integrity', 'artifact_integrity'].includes(reason || '')) {
    return { badge: 'Download failed', tone: 'error', text: 'The model download could not be completed and verified. Your choice is saved; try downloading again.', action: 'download' };
  }
  return { badge: 'Unavailable', tone: 'error', text: 'Browser AI could not complete this request. Your choice is saved. Retry, or choose Ollama.', action: 'retry' };
}

export function nativeStatusView(status: LocalModelStatus): EngineStatusView {
  switch (status.state) {
    case 'not_connected':
      return { badge: 'Not connected', text: 'Connect Bouncer to the local Ollama service. Posts stay visible while disconnected.', action: 'connect', connect: true };
    case 'ready':
      return { badge: 'Ready', tone: 'ready', text: 'Loads when needed. Ollama may release it after idle use; other local clients can keep it loaded.' };
    case 'loading':
      return { badge: 'Loading…', tone: 'busy', text: 'Loading Gemma in Ollama for this request…' };
    case 'filtering':
      return { badge: 'Filtering', tone: 'ready', text: 'Filtering with Gemma on this Mac.' };
    case 'paused':
      return { badge: 'Paused', text: 'Another local model is loaded. Automatic filtering waits; manual Bounce and Restore still work.', action: 'retry', retry: true };
    case 'missing_model': {
      const help = 'From the Bouncer repository, run node scripts/prepare-native-model.mjs after acquiring the exact source model. Follow Setup help for the fixed model and qualified runtime, then Retry. The extension does not install Ollama models.';
      return { badge: 'Setup needed', tone: 'error', text: 'The fixed Bouncer model is missing. Complete the one-time Ollama setup, then Retry.', action: 'retry', retry: true, help, details: help };
    }
    case 'blocked': {
      const help = blockedStatusHelp(status.reason);
      return { badge: 'Blocked', tone: 'error', text: nativeBlockedText(status), action: status.reason === 'permission_denied' ? 'connect' : 'retry', connect: status.reason === 'permission_denied', retry: status.reason !== 'permission_denied', help, details: help };
    }
    case 'recovery_required': {
      const help = 'Bouncer cannot confirm that the previous Ollama request has stopped. Retry only checks service metadata; it does not clear this recovery pause. Follow the full-process restart procedure in Setup help, then confirm recovery.';
      return { badge: 'Recovery needed', tone: 'error', text: 'Filtering paused after an interrupted Ollama request. Manual Bounce and Restore still work.', action: status.recoveryQualified === true ? 'recover' : undefined, retry: false, recover: status.recoveryQualified === true, help, details: help };
    }
    case 'error': {
      if (['origin_rejected', 'model_identity_changed', 'model_unqualified', 'runtime_incompatible', 'metadata_invalid', 'permission_denied', 'permission_required'].includes(status.reason || '')) {
        return nativeStatusView({ ...status, state: 'blocked', reason: status.reason === 'permission_required' ? 'permission_denied' : status.reason });
      }
      if (status.reason === 'model_missing') return nativeStatusView({ ...status, state: 'missing_model' });
      const help = 'Open the qualified Ollama app on this Mac and check its fixed Bouncer model using Setup help. Retry checks metadata without loading the model.';
      return { badge: 'Unavailable', tone: 'error', text: 'Can’t reach Ollama. Open the Ollama app on this Mac, then Retry.', action: 'retry', retry: true, help, details: help };
    }
    case 'not_configured':
      return { badge: 'Choose an option', text: 'Choose where Bouncer runs in Settings.', action: 'choose' };
    case 'switching':
      return { badge: 'Switching…', tone: 'busy', text: 'Your Ollama choice is saved. Finishing the previous request…' };
    case 'canceling':
      return { badge: 'Finishing cancellation…', tone: 'busy', text: 'Waiting for the previous browser operation to stop.' };
    case 'needs_download':
    case 'downloading':
      return { badge: 'Setup needed', text: 'Open Setup help to prepare the fixed Ollama model.', action: 'retry', retry: true };
  }
}

function nativeBlockedText(status: LocalModelStatus): string {
  switch (status.reason) {
    case 'origin_rejected': return 'Ollama rejected Bouncer’s local connection. Follow Setup help for its exact allowed origin, then Retry.';
    case 'permission_denied': return 'Local connection permission is missing. Connect when you are ready.';
    case 'runtime_incompatible': return 'The installed Ollama version does not match this Bouncer build. Follow Setup help, then Retry.';
    case 'model_identity_changed':
    case 'model_unqualified': return 'Bouncer could not verify its fixed Ollama model. Follow Setup help to restore the accepted artifact.';
    case 'metadata_invalid': return 'Ollama’s model details could not be verified. Follow Setup help, then Retry.';
    default: return 'Bouncer could not verify the local Ollama setup. Follow Setup help, then Retry.';
  }
}

function blockedStatusHelp(reason: string | undefined): string {
  switch (reason) {
    case 'origin_rejected':
      return `Add ${EXTENSION_ORIGIN} to the existing OLLAMA_ORIGINS allowed set, preserving its other entries, then restart Ollama and Retry. Keep its loopback binding and cloud-disabled settings. Use the documented operator procedure in Setup help.`;
    case 'model_unqualified': return 'Use a qualified Bouncer build with its accepted Gemma 4 E2B model. Follow Setup help. Retry only checks the current setup.';
    case 'model_identity_changed': return 'Restore the pinned Bouncer model using the documented setup recipe, then Retry. Its accepted local model identity must match before filtering.';
    case 'runtime_incompatible': return 'Follow Setup help to match this Bouncer build with its qualified Ollama version, then Retry.';
    case 'metadata_invalid': return 'Repair the fixed local model setup using Setup help, then Retry. Bouncer must verify its weights, text-only configuration and metadata before filtering.';
    case 'permission_denied': return 'Connect to allow only http://127.0.0.1:11434/*. This permission does not change your engine choice or install anything.';
    default: return 'Resolve the reported setup problem using Setup help, then Retry.';
  }
}
