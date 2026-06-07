import { describe, it, expect } from 'vitest';
import { EVAL_POSTS, EVAL_VARIANTS, expectsHide } from '../../src/shared/eval-corpus.js';

describe('eval corpus', () => {
  it('has the intended small hand-auditable size and class mix', () => {
    expect(EVAL_POSTS).toHaveLength(40);
    expect(EVAL_POSTS.filter(p => p.kind === 'pos')).toHaveLength(18);
    expect(EVAL_POSTS.filter(p => p.kind === 'neg-easy')).toHaveLength(4);
    expect(EVAL_POSTS.filter(p => p.kind === 'neg-amb')).toHaveLength(18);
  });

  it('uses unique ids and non-empty text', () => {
    const ids = new Set(EVAL_POSTS.map(p => p.id));
    expect(ids.size).toBe(EVAL_POSTS.length);
    for (const post of EVAL_POSTS) {
      expect(post.id).toMatch(/^(p|e|a)\d+$/);
      expect(post.text.trim().length).toBeGreaterThan(20);
    }
  });

  it('derives the gold label only from kind', () => {
    for (const post of EVAL_POSTS) {
      expect(expectsHide(post)).toBe(post.kind === 'pos');
    }
  });

  it('does not include obvious real handles or URLs', () => {
    for (const post of EVAL_POSTS) {
      expect(post.text).not.toMatch(/https?:\/\//i);
      expect(post.text).not.toMatch(/(^|\s)@[A-Za-z0-9_]{2,}/);
    }
  });
});

describe('eval variants', () => {
  it('covers baseline, filter-only, prompt-only, and combined tuning variants', () => {
    expect(EVAL_VARIANTS.map(v => v.id)).toEqual([
      'baseline',
      'filter-outrage-farming',
      'prompt-intent',
      'combined-intent-outrage-farming',
    ]);
  });

  it('keeps baseline on shipped behavior', () => {
    const baseline = EVAL_VARIANTS[0];
    expect(baseline.filters).toEqual(['rage bait']);
    expect(baseline.promptMode).toBe('baseline');
  });
});
