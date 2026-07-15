/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import {
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
    expect(suggestionResponseError({ reasons: [], error: 'GPU device lost' }))
      .toBe('GPU device lost');
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
