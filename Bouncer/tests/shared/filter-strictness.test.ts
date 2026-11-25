import { describe, expect, it } from 'vitest';
import { DECISION_MODEL, decideMatches, decisionModelFingerprint } from '../../src/shared/decision-model';

const longText = 'these are four words';

describe('per-filter score decisions', () => {
  it.each([
    { text: longText, strict: false, cutoff: 0.290813258948728, shortPost: false },
    { text: longText, strict: true, cutoff: 0.72, shortPost: false },
    { text: '@alice one two three https://example.test', strict: false, cutoff: 0.70, shortPost: true },
    { text: '@alice one two three https://example.test', strict: true, cutoff: 0.72, shortPost: false },
  ])('uses an inclusive $cutoff cutoff (strict=$strict, text=$text)', ({ text, strict, cutoff, shortPost }) => {
    const scores = [
      { label: 'below', score: cutoff - Number.EPSILON },
      { label: 'at', score: cutoff },
      { label: 'above', score: cutoff + Number.EPSILON },
    ];
    const result = decideMatches(scores, text, strict ? scores.map(({ label }) => label) : []);
    expect(result.matches).toEqual(['at', 'above']);
    expect(result.shouldHide).toBe(true);
    expect(result.scores).toEqual(scores.map((entry, index) => ({ ...entry, cutoff, strict, shortPost, matched: index > 0 })));
    expect(decideMatches([scores[0]], text, strict ? ['below'] : []).shouldHide).toBe(false);
  });

  it('judges mixed levels by exact phrase and preserves input order without mutating scores', () => {
    const scores = Object.freeze([
      Object.freeze({ label: 'birds', score: 0.5 }),
      Object.freeze({ label: 'Birds', score: 0.5 }),
      Object.freeze({ label: 'cats', score: 0.72 }),
    ]);
    expect(decideMatches(scores, longText, ['birds', 'cats', 'missing']).matches).toEqual(['Birds', 'cats']);
    expect(scores[0]).toEqual({ label: 'birds', score: 0.5 });
  });

  it('defaults fresh filters to Standard and retains the old-snapshot general fallback', () => {
    const scores = [{ label: 'birds', score: DECISION_MODEL.cutoff }];
    expect(decideMatches(scores, longText).matches).toEqual(['birds']);
    expect(decideMatches(scores, undefined).scores[0]).toMatchObject({ cutoff: DECISION_MODEL.cutoff, strict: false, matched: true });
    expect(decideMatches(scores, undefined, ['birds']).scores[0]).toMatchObject({ cutoff: 0.72, strict: true, matched: false });
    expect(decideMatches([], longText).shouldHide).toBe(false);
  });

  it('includes Strict cutoff in the classifier fingerprint', () => {
    expect(DECISION_MODEL.strictCutoff).toBe(0.72);
    expect(decisionModelFingerprint({ ...DECISION_MODEL, strictCutoff: 0.73 })).not.toBe(decisionModelFingerprint());
  });
});
