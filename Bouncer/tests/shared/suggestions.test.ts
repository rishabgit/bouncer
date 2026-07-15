import { describe, expect, it } from 'vitest';
import { buildSuggestionSystemPrompt, parseCandidatePhrases } from '../../src/shared/suggestions.js';

describe('suggestion helpers', () => {
  it('keeps the production prompt requirements and rejected phrases together', () => {
    const prompt = buildSuggestionSystemPrompt(9, ['rage bait', 'spam']);
    expect(prompt).toContain('exactly 9 filter phrases');
    expect(prompt).toContain('1-3 words each');
    expect(prompt).toContain('Do NOT suggest any of these: rage bait, spam.');
  });

  it('normalizes numbered, bulleted, and wrapped candidates', () => {
    expect(parseCandidatePhrases('1. **Rage Bait**\n- `spammy hype`\n• “smug dunking”', 9))
      .toEqual(['rage bait', 'spammy hype', 'smug dunking']);
  });
});
