import { describe, expect, it } from 'vitest';
import { buildSuggestionSystemPrompt, parseCandidatePhrases } from '../../src/shared/suggestions.js';

describe('suggestion helpers', () => {
  it('allows fewer grounded candidates and retains the output and rejection contract', () => {
    const prompt = buildSuggestionSystemPrompt(9, ['rage bait', 'spam']);
    expect(prompt).toContain('0 to 9 useful filter phrases');
    expect(prompt).toContain('1-3 words each');
    expect(prompt).toContain('Accurate neutral topics are allowed');
    expect(prompt).toContain('do not assume every post deserves criticism');
    expect(prompt).toContain('Do not pad the list');
    expect(prompt).toContain('Output ONLY phrases, one per line, with no explanation');
    expect(prompt).toContain('output exactly NONE');
    expect(prompt).toContain('Do NOT suggest any of these: rage bait, spam.');
    expect(prompt).not.toContain('exactly 9 filter phrases');
    expect(prompt).not.toContain('every other phrase must carry a clearly negative connotation');
  });

  it('requires textual grounding and separates the poster from a mentioned target', () => {
    const prompt = buildSuggestionSystemPrompt(9);
    expect(prompt).toContain("Ground each phrase in the post's actual topic, wording, or clearly shown behavior");
    expect(prompt).toContain("Distinguish the poster's behavior from people or conduct they merely mention, quote, report, or criticize");
    expect(prompt).toContain('Do not invent boasting, advice, vanity, wrongdoing, ideology, motives, or allegations');
    expect(prompt).toContain('does this post relate to [phrase]?');
    expect(prompt).not.toContain('Do NOT suggest any of these');
  });

  it('normalizes numbered, bulleted, and wrapped candidates', () => {
    expect(parseCandidatePhrases('1. **Rage Bait**\n- `spammy hype`\n• “smug dunking”', 9))
      .toEqual(['rage bait', 'spammy hype', 'smug dunking']);
  });

  it.each(['', ' \n\t ', 'NONE', ' \nNONE\n '])('accepts an entire empty response or exact NONE sentinel: %j', response => {
    expect(parseCandidatePhrases(response, 9)).toEqual([]);
  });

  it('does not erase phrases containing none or legitimate wrongdoing topics', () => {
    expect(parseCandidatePhrases('none of this\nnonetheless\nscam reporting\ncriminal justice', 9))
      .toEqual(['none of this', 'nonetheless', 'scam reporting', 'criminal justice']);
  });

  it('keeps NONE outside the whole-response sentinel boundary', () => {
    expect(parseCandidatePhrases('NONE\ncrypto', 9)).toEqual(['none', 'crypto']);
    expect(parseCandidatePhrases('**NONE**', 9)).toEqual(['none']);
    expect(parseCandidatePhrases('none', 9)).toEqual(['none']);
  });

  it('allows a partial set and still caps parsed candidates at the requested maximum', () => {
    expect(parseCandidatePhrases('Gardening', 9)).toEqual(['gardening']);
    expect(parseCandidatePhrases('gardening\nwoodworking\nshoe care', 2))
      .toEqual(['gardening', 'woodworking']);
  });

  it('retains one-, two-, and three-word phrases but rejects longer normalized candidates', () => {
    expect(parseCandidatePhrases('Topic\nTwo Words\nThree Word Phrase\n1. **Four Word Candidate Here**\n- `Five Word Candidate Goes Here`', 9))
      .toEqual(['topic', 'two words', 'three word phrase']);
  });

  it('discards invalid long phrases before applying the candidate cap', () => {
    expect(parseCandidatePhrases('one two three four\nGardening\nfive words fail here too\nShoe Care\nWoodworking', 2))
      .toEqual(['gardening', 'shoe care']);
  });

  it('counts Unicode words using whitespace without changing their text', () => {
    expect(parseCandidatePhrases('ÉCONOMIE\ncafé résumé\n東京\u2003世界\u00a0🌿\none\u00a0two\u2003three\u202ffour', 9))
      .toEqual(['économie', 'café résumé', '東京\u2003世界\u00a0🌿']);
  });
});
