import { describe, it, expect } from 'vitest';
import { buildLocalUserMessage } from '../../src/shared/prompts.js';

// ==================== buildLocalUserMessage ====================

describe('buildLocalUserMessage', () => {
  it('includes categories in filter_categories XML tag', () => {
    const msg = buildLocalUserMessage('Hello world', ['sports', 'politics'], false);
    expect(msg).toContain('<filter_categories>sports, politics</filter_categories>');
  });

  it('includes post text in post XML tag', () => {
    const msg = buildLocalUserMessage('The Lakers won!', ['sports'], false);
    expect(msg).toContain('<post>The Lakers won!</post>');
  });

  it('mentions images when hasImages is true', () => {
    const msg = buildLocalUserMessage('Look at this', ['sports'], true);
    expect(msg).toContain('images');
  });

  it('does not mention images when hasImages is false', () => {
    const msg = buildLocalUserMessage('Look at this', ['sports'], false);
    expect(msg).not.toContain('images');
  });
});
