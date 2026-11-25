import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ownWords as harnessOwnWords } from '../../../scripts/decision-eval/tone-label-metrics.mjs';
import { EVAL_POSTS } from '../../../scripts/decision-eval/corpora/eval-corpus';
import { MULTI_FILTER_CASES, NATIVE_LATENCY_POSTS, SUGGESTION_FIXTURES } from '../../../scripts/decision-eval/corpora/native-benchmark-corpus';
import { decisionCutoff, ownWords } from '../../src/shared/decision-model';

describe('own words match the tone-label harness', () => {
  it.each([
    ['', 0],
    ['@alice @bob_42', 0],
    ['@alice @bob_42 these are words', 3],
    ['https://example.test/@url HTTP://example.test/path', 0],
    ['@alice look https://example.test/@url over HTTPS://example.test/path here', 3],
    ['😀 😤 🔥', 0],
    ['😀 hello 😤 world 🔥', 2],
    ['r*tard', 1],
    ['+1', 1],
    ['@someone r*tard +1 😤 https://example.test', 2],
    ['!!! … * -', 0],
    ['café ١٢٣', 2],
    ['one\ttwo\nthree\u00a0four', 4],
    ['@café', 1],
  ] as const)('counts %j as %i, exactly as the harness does', (text, expected) => {
    expect(harnessOwnWords(text)).toBe(expected);
    expect(ownWords(text)).toBe(expected);
    expect(ownWords(text)).toBe(harnessOwnWords(text));
  });
});

/** Includes nested diagnostic twins and suggestion fixtures, not just scored posts. */
function postTexts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(postTexts);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    key === 'text' && typeof entry === 'string' ? [entry] : postTexts(entry));
}

it('preserves harness counts for every corpus post text and twin, including TS corpora', () => {
  const corpora = new URL('../../../scripts/decision-eval/corpora/', import.meta.url);
  const jsonFiles = readdirSync(corpora).filter(file => file.endsWith('.json')).sort();
  const texts = jsonFiles.flatMap(file => postTexts(JSON.parse(readFileSync(new URL(file, corpora), 'utf8'))));
  // Suggestion fixtures are plain strings, not objects with a text field.
  texts.push(...postTexts(EVAL_POSTS), ...postTexts(MULTI_FILTER_CASES), ...SUGGESTION_FIXTURES,
    ...Object.values(NATIVE_LATENCY_POSTS).flat());
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    expect(ownWords(text), text).toBe(harnessOwnWords(text));
  }
  console.info(`Corpus parity: ${texts.length} post texts and twins; ${jsonFiles.length} JSON files and 2 TS corpora.`);
});

describe('post-specific cutoff', () => {
  it.each(['@alice', '😀', 'one', 'one two', '@alice one two three https://example.test'])('uses 0.70 for %j', text => {
    expect(decisionCutoff(text)).toBe(0.7);
  });
  it('keeps the exact global cutoff for four own words', () => {
    expect(decisionCutoff('one two three four')).toBe(0.290813258948728);
  });
});
