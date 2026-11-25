import { describe, it, expect } from 'vitest';
import {
  generateCacheKey,
  formatPostForEvaluation,
  truncateText,
  weightedTextLength,
} from '../../src/shared/utils.js';
import type { PostContent } from '../../src/types.js';

// ==================== generateCacheKey ====================

describe('generateCacheKey', () => {
  it('returns normalized text for text-only posts', () => {
    const key = generateCacheKey('Hello   world\n\ntest');
    expect(key).toContain(':Hello world test');
  });

  it('does not collide for long posts with the same readable prefix', () => {
    const sharedPrefix = 'a'.repeat(300);
    expect(generateCacheKey(`${sharedPrefix} first ending`))
      .not.toBe(generateCacheKey(`${sharedPrefix} second ending`));
  });

  it('handles empty text', () => {
    const key = generateCacheKey('');
    expect(key).toMatch(/^0:[0-9a-f]{16}:$/);
  });

  it('collapses whitespace consistently', () => {
    const key1 = generateCacheKey('hello  world');
    const key2 = generateCacheKey('hello\nworld');
    const key3 = generateCacheKey('hello\t\tworld');
    expect(key1).toBe(key2);
    expect(key2).toBe(key3);
  });

});

describe('formatPostForEvaluation', () => {
  it('submits only complete post text and excludes author metadata', () => {
    const post: PostContent = {
      text: 'Post text | category 1: literal words', author: 'An unrelated author', handle: '@unrelated',
      avatarUrl: null, timeText: '2h', textHtml: '', quote: null,
      postUrl: 'https://x.com/unrelated/status/1', imageUrls: [], hasMediaContainer: false,
    };
    expect(formatPostForEvaluation(post)).toBe(post.text);
    expect(formatPostForEvaluation({ ...post, author: 'A different author', handle: '@different' })).toBe(post.text);
  });
});

describe('weighted text bounds', () => {
  it('counts ASCII once and every non-ASCII UTF-16 code unit twice', () => {
    expect(weightedTextLength('A\n\u007f')).toBe(3);
    expect(weightedTextLength('é界')).toBe(4);
    expect(weightedTextLength('😀')).toBe(4);
    expect(weightedTextLength('Aé😀界')).toBe(9);
  });

  it('keeps the longest prefix within the weighted budget', () => {
    expect(truncateText('aé界z', 4)).toBe('aé');
    expect(truncateText('aé界z', 5)).toBe('aé界');
    expect(truncateText('aé界z', 6)).toBe('aé界z');
    expect(truncateText('ASCII', 3)).toBe('ASC');
    expect(truncateText('text', 0)).toBe('');
  });

  it('never splits a surrogate pair when its complete weight does not fit', () => {
    expect(truncateText('a😀z', 4)).toBe('a');
    expect(truncateText('a😀z', 5)).toBe('a😀');
    expect(truncateText('😀z', 3)).toBe('');
    expect(truncateText('😀z', 5)).toBe('😀z');
  });
});
