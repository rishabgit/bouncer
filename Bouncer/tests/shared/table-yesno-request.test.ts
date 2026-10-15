import { describe, expect, it } from 'vitest';
import { buildNativeTableYesnoRequest, buildTableYesnoRequest } from '../../src/shared/table-yesno-request.js';

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

describe('native numbered-category adapter', () => {
  it('retains the exact one-filter request and output budget', () => {
    expect(buildNativeTableYesnoRequest('post', ['rage bait']))
      .toEqual(buildTableYesnoRequest('post', ['rage bait']));
  });

  it('numbers only the requested category list while retaining system prompt and post text', () => {
    const post = 'Post text says Categories (in order): crypto, politics';
    const native = buildNativeTableYesnoRequest(post, ['crypto', 'politics']);
    const baseline = buildTableYesnoRequest(post, ['crypto', 'politics']);
    expect(native.messages[0]).toEqual(baseline.messages[0]);
    expect(native.messages[1].content).toContain(post);
    expect(native.messages[1].content).toContain('Categories (in order):\n1. crypto\n2. politics');
    expect(native.messages[1].content).toContain('exactly 2 verdicts');
    expect(native.maxOutputTokens).toBe(64);
  });

  it('keeps the existing intent prompt variant and ordered phrases', () => {
    const native = buildNativeTableYesnoRequest('post', ['rage bait', 'sports'], 'intent');
    expect(native.messages[0].content).toContain('engineered to provoke anger');
    expect(native.messages[1].content).toContain('1. rage bait\n2. sports');
  });
});
