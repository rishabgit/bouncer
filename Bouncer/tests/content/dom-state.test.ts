/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isRendered,
  restoreFilteredContainer,
  scheduleFilteredHide,
} from '../../src/content/dom-state.js';

describe('restoreFilteredContainer', () => {
  it('restores a container carrying Bouncer hidden state', () => {
    const container = document.createElement('div');
    const article = document.createElement('article');
    container.dataset.filteredByExtension = 'true';
    container.style.display = 'none';
    container.style.opacity = '0';
    container.style.transition = 'opacity 0.3s ease';
    article.style.opacity = '0';
    article.style.transition = 'opacity 0.3s ease';

    expect(restoreFilteredContainer(container, article)).toBe(true);
    expect(container.style.display).toBe('');
    expect(container.style.opacity).toBe('');
    expect(container.style.transition).toBe('');
    expect(container.dataset.filteredByExtension).toBeUndefined();
    expect(article.style.opacity).toBe('');
    expect(article.style.transition).toBe('');
  });

  it('cancels a pending fade hide before it can re-hide a restored reply', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const article = document.createElement('article');
    const hide = vi.fn();
    article.style.opacity = '0';
    article.style.transition = 'opacity 0.3s ease';
    scheduleFilteredHide(article, hide);

    expect(restoreFilteredContainer(container, article)).toBe(true);
    vi.advanceTimersByTime(300);

    expect(hide).not.toHaveBeenCalled();
    expect(article.style.opacity).toBe('');
    expect(article.style.transition).toBe('');
    vi.useRealTimers();
  });

  it('does not alter an unrelated hidden container', () => {
    const container = document.createElement('div');
    container.style.display = 'none';
    expect(restoreFilteredContainer(container)).toBe(false);
    expect(container.style.display).toBe('none');
  });
});

describe('isRendered', () => {
  it('prefers checkVisibility so fixed-position layouts can be visible', () => {
    const element = document.createElement('div');
    element.checkVisibility = vi.fn(() => true);
    Object.defineProperty(element, 'offsetParent', { value: null });
    expect(isRendered(element)).toBe(true);
  });

  it('falls back to offsetParent when checkVisibility is unavailable', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'checkVisibility', { value: undefined });
    Object.defineProperty(element, 'offsetParent', { value: document.body });
    expect(isRendered(element)).toBe(true);
  });
});
