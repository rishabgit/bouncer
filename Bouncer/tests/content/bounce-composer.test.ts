/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createBounceComposer } from '../../src/content/ui.js';
import { FILTER_LABEL_GUIDANCE } from '../../src/shared/filter-guidance.js';

async function flush(): Promise<void> { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function container(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}
function enterLabel(element: HTMLElement, value: string): HTMLInputElement {
  const input = element.querySelector<HTMLInputElement>('.ff-bounce-input')!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  return input;
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

afterEach(() => {
  document.documentElement.classList.remove('twitter-dim');
  document.querySelectorAll('[data-bounce-theme-test]').forEach(element => element.remove());
});

describe('manual Bounce label entry', () => {
  it('renders the exact shared guidance once and associates it with the required input', () => {
    const element = container();
    const composer = createBounceComposer(element, vi.fn(), vi.fn());
    const input = element.querySelector<HTMLInputElement>('input')!;
    expect(element.querySelectorAll('.filter-label-guidance')).toHaveLength(1);
    const guidance = element.querySelector('.filter-label-guidance')!;
    expect(guidance.textContent).toBe(FILTER_LABEL_GUIDANCE);
    expect(input.required).toBe(true);
    expect(input.getAttribute('aria-describedby')).toBe(guidance.id);
    expect(element.querySelector('label')?.htmlFor).toBe(input.id);
    composer.focus();
    expect(document.activeElement).toBe(input);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['', '  \t '])('blocks blank label %j even when submit bypasses the disabled button', value => {
    const element = container();
    const bounce = vi.fn();
    createBounceComposer(element, bounce, vi.fn());
    enterLabel(element, value);
    expect(element.querySelector<HTMLButtonElement>('.ff-bounce-confirm')?.disabled).toBe(true);
    element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(bounce).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('submits a trimmed custom label only after explicit confirmation without model messages', async () => {
    const element = container();
    const bounce = vi.fn();
    const cancel = vi.fn();
    createBounceComposer(element, bounce, cancel);
    enterLabel(element, '  crypto price hype  ');
    expect(bounce).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    expect(bounce).toHaveBeenCalledExactlyOnceWith('crypto price hype');
    await flush();
    element.querySelector<HTMLButtonElement>('.ff-bounce-cancel')!.click();
    expect(cancel).toHaveBeenCalledOnce();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('retains a rejected draft and allows retry without duplicate pending submissions', async () => {
    const element = container();
    let rejectSave!: (saved: boolean) => void;
    const bounce = vi.fn(() => new Promise<boolean>(resolve => { rejectSave = resolve; }));
    createBounceComposer(element, bounce, vi.fn());
    const input = enterLabel(element, 'crypto price hype');
    const button = element.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!;
    button.click();
    element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(bounce).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    rejectSave(false);
    await flush();
    expect(input.value).toBe('crypto price hype');
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
    expect(element.querySelector<HTMLElement>('.ff-bounce-error')?.hidden).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('styles a body-mounted Bounce tooltip under the actual dim theme', () => {
    const style = document.createElement('style');
    style.dataset.bounceThemeTest = '';
    style.textContent = readFileSync(new NodeURL('../../adapters/twitter/twitter.css', import.meta.url), 'utf8');
    document.head.appendChild(style);
    document.documentElement.classList.add('twitter-dim');
    const tooltip = document.createElement('div');
    tooltip.className = 'ff-bounce-tooltip ff-bounce-tooltip--flipped';
    document.body.appendChild(tooltip);
    expect(getComputedStyle(tooltip).backgroundColor).toBe('#15202b');
    expect(getComputedStyle(tooltip).borderTopColor).toBe('#38444d');
  });

  it('uses only saved filters in the missed-filter chooser and confirms through the same manual action', async () => {
    const element = container();
    const bounce = vi.fn();
    const load = vi.fn(async () => ['political outrage', 'crypto price hype', 'political outrage']);
    createBounceComposer(element, bounce, vi.fn(), load);
    expect(load).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>('.ff-missed-link')!.click();
    await flush();
    expect(load).toHaveBeenCalledOnce();
    expect(Array.from(element.querySelectorAll('.ff-existing-filter'), item => item.textContent))
      .toEqual(['political outrage', 'crypto price hype']);
    element.querySelector<HTMLButtonElement>('.ff-existing-filter')!.click();
    expect(bounce).not.toHaveBeenCalled();
    expect(element.querySelector<HTMLInputElement>('input')?.value).toBe('political outrage');
    element.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    expect(bounce).toHaveBeenCalledExactlyOnceWith('political outrage');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps typed labels available if the saved-filter read fails', async () => {
    const element = container();
    const bounce = vi.fn();
    createBounceComposer(element, bounce, vi.fn(), async () => { throw new Error('Synthetic storage failure'); });
    enterLabel(element, 'political outrage');
    element.querySelector<HTMLButtonElement>('.ff-missed-link')!.click();
    await flush();
    expect(element.querySelector('.ff-existing-filters')?.textContent).toContain('Couldn’t read your filters');
    element.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    expect(bounce).toHaveBeenCalledExactlyOnceWith('political outrage');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
