import { describe, expect, it } from 'vitest';
import { buildTableYesnoRequest } from '../../src/shared/table-yesno-request.js';

describe('buildTableYesnoRequest', () => {
  it('uses the one-word contract for one category', () => {
    const request = buildTableYesnoRequest('post', ['rage bait']);
    expect(request.messages[0].content).toContain('single word');
    expect(request.messages[1].content).toContain('Category: rage bait');
    expect(request.maxOutputTokens).toBe(64);
  });

  it('preserves category order in the text-only table request', () => {
    const request = buildTableYesnoRequest('post', ['crypto', 'politics']);
    expect(request.messages[1].content).toContain('crypto, politics');
    expect(request.maxOutputTokens).toBe(64);
  });

  it('raises and caps the drift budget for larger category batches', () => {
    expect(buildTableYesnoRequest('post', Array.from({ length: 9 }, (_, index) => `c${index}`)).maxOutputTokens)
      .toBe(108);
    expect(buildTableYesnoRequest('post', Array.from({ length: 30 }, (_, index) => `c${index}`)).maxOutputTokens)
      .toBe(256);
  });
});
