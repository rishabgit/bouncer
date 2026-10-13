/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBounceComposer,
  getSuggestionRequest,
  isSuggestionRequestCurrent,
  suggestionResponseError,
} from '../../src/content/ui.js';

describe('suggestionResponseError', () => {
  it('keeps a valid empty suggestion set distinct from a runtime failure', () => {
    expect(suggestionResponseError({ reasons: [] })).toBeNull();
  });

  it('surfaces maintenance responses as retryable errors', () => {
    expect(suggestionResponseError({
      reasons: [],
      retry: true,
      error: 'Local model maintenance in progress.',
    })).toBe('Local model maintenance in progress.');
  });

  it('surfaces operational model errors returned by the background', () => {
    expect(suggestionResponseError({ reasons: [], error: 'Ollama unavailable' }))
      .toBe('Ollama unavailable');
  });
});

describe('suggestion request identity', () => {
  it('does not reuse or render a recycled article node\'s previous request', async () => {
    const article = document.createElement('article');
    const firstFactory = () => Promise.resolve({ reasons: ['old tweet'] });
    const secondFactory = () => Promise.resolve({ reasons: ['new tweet'] });

    const first = getSuggestionRequest(article, 'status/1', firstFactory);
    expect(getSuggestionRequest(article, 'status/1', () => Promise.reject(new Error('unused'))))
      .toBe(first);

    const second = getSuggestionRequest(article, 'status/2', secondFactory);

    expect(second).not.toBe(first);
    expect(isSuggestionRequestCurrent(article, first, 'status/2')).toBe(false);
    expect(isSuggestionRequestCurrent(article, second, 'status/2')).toBe(true);
    await expect(second.promise).resolves.toEqual({ reasons: ['new tweet'] });
  });
});

describe('optional grounded Bounce suggestions', () => {
  it.each([{ reasons: [] }, { reasons: [' ', ''] }, { error: 'Ollama unavailable' }, { pending: true }])('keeps editable phrase and explicit actions available for %j', state => {
    const container = document.createElement('div');
    const bounce = vi.fn();
    const cancel = vi.fn();
    const composer = createBounceComposer(container, bounce, cancel);
    composer.setState(state);
    expect(container.querySelector<HTMLInputElement>('input')?.disabled).toBe(false);
    container.querySelector<HTMLButtonElement>('.ff-annoying-bounce')!.click();
    expect(bounce).toHaveBeenCalledWith(undefined);
    container.querySelector<HTMLButtonElement>('.ff-annoying-cancel')!.click();
    expect(cancel).toHaveBeenCalledOnce();
    if ('reasons' in state) expect(container.textContent).toContain('No useful suggestions');
  });

  it('retains edits when suggestions arrive and only bounces on explicit confirmation', () => {
    const container = document.createElement('div');
    const bounce = vi.fn();
    const composer = createBounceComposer(container, bounce, vi.fn());
    composer.setState({ pending: true });
    const input = container.querySelector<HTMLInputElement>('input')!;
    input.value = 'my edited phrase';
    composer.setState({ reasons: ['political outrage', 'political outrage', 'AI hype', 'promotion', 'extra'] });
    expect(input.value).toBe('my edited phrase');
    expect(container.querySelectorAll('.ff-annoying-chip')).toHaveLength(3);
    container.querySelector<HTMLButtonElement>('.ff-annoying-chip')!.click();
    expect(input.value).toBe('political outrage');
    expect(bounce).not.toHaveBeenCalled();
    input.value = 'edited suggestion';
    container.querySelector<HTMLButtonElement>('.ff-annoying-bounce')!.click();
    expect(bounce).toHaveBeenCalledWith('edited suggestion');
  });
});
