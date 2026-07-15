import { describe, it, expect } from 'vitest';
import {
  generateCacheKey,
  cleanReasoning,
} from '../../src/shared/utils.js';

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

// ==================== cleanReasoning ====================

describe('cleanReasoning', () => {
  it('returns null/undefined as-is', () => {
    expect(cleanReasoning(null)).toBeNull();
    expect(cleanReasoning(undefined)).toBeUndefined();
  });

  it('removes category prefixes', () => {
    expect(cleanReasoning('category 1: Sports content')).toBe('Sports content');
  });

  it('splits on pipe separators', () => {
    expect(cleanReasoning('Part one | Part two')).toBe('Part one Part two');
  });

  it('handles combined category prefix and pipe', () => {
    expect(cleanReasoning('category 1: Sports | category 2: Politics')).toBe('Sports Politics');
  });

  it('returns original if result would be empty', () => {
    expect(cleanReasoning('|||')).toBe('|||');
  });
});
