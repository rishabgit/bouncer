/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';

beforeEach(() => {
  const style = document.createElement('style');
  style.textContent = readFileSync('content.css', 'utf8');
  document.head.appendChild(style);
  document.body.innerHTML = `
    <div style="text-align:left;line-height:24px"><button class="filter-phrase-inline">A long filter phrase<span class="filter-strict-pill">Strict</span></button></div>
    <div class="filter-strictness-popover"><strong>Long phrase</strong>
      <div class="filter-strictness-options"><button aria-pressed="true">Standard</button><button aria-pressed="false">Strict</button></div>
      <div class="filter-strictness-actions"><button>Remove filter</button><button>Done</button></div>
    </div>`;
});
afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.className = '';
});

it.each([
  { theme: 'light', fill: 'rgb(15, 20, 25)', text: 'rgb(239, 243, 244)', track: 'rgba(247, 249, 249, 0.85)' },
  { theme: 'dim', fill: 'rgb(247, 249, 249)', text: 'rgb(21, 32, 43)', track: 'rgba(30, 42, 54, 0.85)' },
  { theme: 'dark', fill: 'rgb(239, 243, 244)', text: 'rgb(15, 20, 25)', track: 'rgb(32, 35, 39)' },
])('uses approved filled controls and a subtle track in $theme', ({ theme, fill, text, track }) => {
  document.documentElement.className = `twitter-${theme}`;
  for (const selector of ['.filter-strictness-options [aria-pressed="true"]', '.filter-strictness-actions button:last-child']) {
    const style = getComputedStyle(document.querySelector(selector)!);
    expect(style.backgroundColor).toBe(fill);
    expect(style.color).toBe(text);
  }
  expect(getComputedStyle(document.querySelector('.filter-strictness-options')!).backgroundColor).toBe(track);
  const pill = getComputedStyle(document.querySelector('.filter-strict-pill')!);
  expect(pill.fontSize).toBe('11px');
  expect(pill.borderTopStyle).toBe('solid');
  expect(pill.borderTopWidth).toBe('1px');
  if (theme === 'dark') {
    expect(pill.borderTopColor).toBe('rgb(83, 100, 113)');
    expect(pill.color).toBe('rgb(139, 152, 165)');
  }
});

it('inherits phrase text alignment and line height and bounds a long popover with internal scrolling', () => {
  document.querySelector('strong')!.textContent = 'Very long phrase '.repeat(200);
  const phrase = getComputedStyle(document.querySelector('.filter-phrase-inline')!);
  expect(phrase.textAlign).toBe('left');
  expect(phrase.lineHeight).toBe('24px');
  const popover = getComputedStyle(document.querySelector('.filter-strictness-popover')!);
  expect(popover.maxHeight).toBe(`${window.innerHeight - 16}px`);
  expect(popover.overflow).toBe('auto');
  expect(getComputedStyle(document.querySelector('strong')!).overflowWrap).toBe('anywhere');
});
