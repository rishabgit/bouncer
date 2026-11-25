import type { LocalModelStatus } from '../types';
import { DECISION_MODEL, LLAMA_MODEL_INI } from './decision-model';

export interface LocalModelStatusView {
  badge: string;
  tone?: 'busy' | 'ready' | 'error';
  text: string;
  help?: string;
  settings?: string;
}

const localModelStates: ReadonlySet<string> = new Set([
  'checking', 'ready', 'unavailable', 'missing_model', 'settings_required', 'error',
]);

/** Persisted status is untrusted, including states from an older extension. */
export function normalizeLocalModelStatus(value: unknown): LocalModelStatus {
  const status = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const validRevision = typeof status.revision === 'number'
    && Number.isSafeInteger(status.revision) && status.revision >= 0;
  const revision = validRevision ? status.revision as number : 0;
  if (typeof status.state === 'string' && localModelStates.has(status.state)
      && typeof status.message === 'string' && validRevision) {
    return { state: status.state as LocalModelStatus['state'], message: status.message, revision };
  }
  return { state: 'checking', message: 'Checking Llama.app…', revision };
}

export function localModelStatusView(status: LocalModelStatus): LocalModelStatusView {
  status = normalizeLocalModelStatus(status);
  switch (status.state) {
    case 'checking':
      return { badge: 'Checking…', tone: 'busy', text: 'Checking Llama.app…' };
    case 'ready':
      return { badge: 'Ready', tone: 'ready', text: `Ready to filter with ${DECISION_MODEL.label} on this Mac.` };
    case 'unavailable':
      return {
        badge: 'Start Llama.app', tone: 'error',
        text: 'Start Llama.app (turn on Launch at login so it is always there)',
        help: 'Open Llama.app on this Mac, then check status. Posts stay visible while automatic filtering is unavailable. Manual Bounce and Restore still work.',
      };
    case 'missing_model':
      return {
        badge: `Install ${DECISION_MODEL.label}`, tone: 'error', text: `Install the ${DECISION_MODEL.label} model`,
        help: `Download ${DECISION_MODEL.fileName} from ${DECISION_MODEL.repository} into the Hugging Face cache. Llama.app discovers it when it scans the cache. Follow setup help for the download and model settings.`,
      };
    case 'settings_required':
      return {
        badge: 'Settings needed', tone: 'error', text: 'Llama.app needs these settings',
        help: 'Add this section to ~/.config/llama/models.user.ini, preserving your other model settings. Remove hf-repo from this model section: it makes Llama.app download model files into /tmp instead of using the Hugging Face cache. Then reopen Llama.app and check status.',
        settings: LLAMA_MODEL_INI,
      };
    case 'error':
      return {
        badge: 'Post kept visible', tone: 'error',
        text: `${status.message ? `${status.message} ` : ''}This post stays visible. Filtering continues with the next post.`,
      };
  }
}
