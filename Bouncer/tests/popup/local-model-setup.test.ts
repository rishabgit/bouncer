/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { localModelStatusView, normalizeLocalModelStatus } from '../../src/shared/engine-status-view.js';
import { DECISION_MODEL, LLAMA_MODEL_INI, LLAMA_ENDPOINT } from '../../src/shared/decision-model.js';
import type { LocalModelStatus } from '../../src/types.js';

const status = (state: LocalModelStatus['state']): LocalModelStatus => ({ state, message: 'Internal diagnostic /test-data/model', revision: 1 });

describe('local model status copy', () => {
  it.each(['checking', 'ready', 'unavailable', 'missing_model', 'settings_required'] as const)('keeps diagnostics out of %s copy', state => {
    const view = localModelStatusView(status(state));
    expect(view.text).not.toContain('Internal diagnostic');
    expect(view.help || '').not.toContain('/test-data/model');
  });

  it('explains a per-post failure without pausing later filtering', () => {
    const view = localModelStatusView({ ...status('error'), message: 'The model could not classify this post.' });
    expect(view.text).toBe('The model could not classify this post. This post stays visible. Filtering continues with the next post.');
  });

  it('shows progress without a percentage or estimated duration', () => {
    const view = localModelStatusView(status('checking'));
    expect(view.tone).toBe('busy');
    expect(view.text).toBe('Checking Llama.app…');
  });

  it('names the installed model and its settings', () => {
    expect(localModelStatusView(status('missing_model')).help).toContain(DECISION_MODEL.fileName);
    expect(localModelStatusView(status('settings_required')).settings).toBe(LLAMA_MODEL_INI);
    expect(localModelStatusView(status('settings_required')).help).toContain('hf-repo');
    expect(localModelStatusView(status('settings_required')).help).toContain('/tmp');
  });

  it.each(['Llama.app returned an error', 'Could not classify this post'])('shows the visible-post outcome exactly once for %s', message => {
    const view = localModelStatusView({ ...status('error'), message });
    expect(view.text.match(/This post stays visible\./g)).toHaveLength(1);
  });
});

describe('persisted local model status', () => {
  it.each(['checking', 'ready', 'unavailable', 'missing_model', 'settings_required', 'error'] as const)('preserves a valid %s status', state => {
    const saved = { state, message: 'Known message', revision: 17 };
    expect(normalizeLocalModelStatus(saved)).toEqual(saved);
  });

  it('renders an unknown stored state as checking while preserving its revision', () => {
    const saved = { state: 'retired-state', message: 'Stale status', revision: 17 };
    expect(normalizeLocalModelStatus(saved)).toEqual({ state: 'checking', message: 'Checking Llama.app…', revision: 17 });
    expect(localModelStatusView(saved as LocalModelStatus)).toMatchObject({ badge: 'Checking…', text: 'Checking Llama.app…' });
  });

  it.each([null, undefined, {}, { state: 'ready', revision: 2 }, { state: 'ready', message: '', revision: NaN },
    { state: 'ready', message: '', revision: -1 }, { state: 'ready', message: '', revision: Infinity }])('normalizes malformed status safely: %j', value => {
    const normalized = normalizeLocalModelStatus(value);
    expect(normalized.state).toBe('checking');
    expect(normalized.message).toBe('Checking Llama.app…');
    expect(Number.isSafeInteger(normalized.revision)).toBe(true);
    expect(normalized.revision).toBeGreaterThanOrEqual(0);
  });
});

describe('packaged setup help', () => {
  const help = readFileSync(new NodeURL('../../setup.html', import.meta.url), 'utf8');

  it('gives a complete default-cache download and model-settings recipe', () => {
    expect(help).toContain('hf download LiquidAI/d1-2B-GGUF d1-2B-Q8_0.gguf');
    expect(help).toContain('~/.cache/huggingface/hub/models--LiquidAI--d1-2B-GGUF/snapshots/');
    expect(help).toContain('~/.config/llama/models.user.ini');
    expect(help).toContain(LLAMA_MODEL_INI);
    expect(help).toContain('Launch at login');
    expect(help).toContain(LLAMA_ENDPOINT);
    expect(help).toContain('Brave or Chrome');
    expect(help).toContain('your browser’s extensions page');
    expect(help).toContain('brew install --cask llama-app');
    expect(help).toContain('answers requests from any web origin by default');
    expect(help).toContain('Brave asks before websites can access localhost');
  });

  it('is self-contained static help', () => {
    expect(help).not.toMatch(/<script|fetch\(|chrome\.|<a(?:\s|>)/);
    expect(help).toContain('hf-repo');
    expect(help).toContain('/tmp');
    expect(help).toContain('Checking status does not load it');
  });
});
