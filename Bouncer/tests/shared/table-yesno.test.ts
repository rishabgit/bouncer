import { describe, expect, it } from 'vitest';
import { parseTableYesnoResponse } from '../../src/shared/table-yesno.js';

function expectFailOpen(
  raw: string | null,
  categories: string[],
  reason?: RegExp,
): void {
  const result = parseTableYesnoResponse(raw, categories);
  expect(result).toMatchObject({
    shouldHide: false,
    matches: [],
    malformed: true,
  });
  if (reason) expect(result.reasoning).toMatch(reason);
}

describe('strict Gemma table yes/no parsing', () => {
  const categories = ['crypto', 'sports', 'politics'];

  it.each([null, '', '   '])('fails open for an empty response: %j', raw => {
    expectFailOpen(raw, ['crypto']);
  });

  it('fails open when no categories were supplied', () => {
    expectFailOpen('| yes |', [], /no categories supplied/);
  });

  it('parses a canonical prompt-shaped row in category order', () => {
    expect(parseTableYesnoResponse('| yes | no | yes', categories)).toMatchObject({
      shouldHide: true,
      matches: ['crypto', 'politics'],
      malformed: false,
    });
  });

  it('accepts bare rows, outer pipes, whitespace, and case differences', () => {
    expect(parseTableYesnoResponse('  no | YES | No  ', categories)).toMatchObject({
      shouldHide: true,
      matches: ['sports'],
      malformed: false,
    });
    expect(parseTableYesnoResponse('| no | yes | yes |', categories).matches)
      .toEqual(['sports', 'politics']);
  });

  it('returns a valid SHOW result when every verdict is no', () => {
    expect(parseTableYesnoResponse('| no | no', ['crypto', 'sports'])).toMatchObject({
      shouldHide: false,
      matches: [],
      malformed: false,
    });
  });

  it.each([
    'Here you go: | yes | no',
    'Here you go:\n| yes | no',
    '| yes | no |\nExplanation follows.',
    'yes\nno\nExplanation follows.',
  ])('fails open for arbitrary preambles or detached prose: %s', raw => {
    expectFailOpen(raw, ['crypto', 'sports']);
  });

  it('fails open for too few verdicts', () => {
    expectFailOpen('| yes', ['crypto', 'sports'], /expected 2 verdicts, got 1/);
  });

  it('fails open for an extra verdict instead of truncating it', () => {
    expectFailOpen('| yes | no', ['crypto'], /expected 1 verdicts, got 2/);
  });

  it.each([
    ['| maybe | no', ['crypto', 'sports']],
    ['yes no', ['crypto', 'sports']],
    ['yes | unknown', ['crypto', 'sports']],
  ] as const)('fails open for invalid verdict syntax: %s', (raw, requested) => {
    expectFailOpen(raw, [...requested], /Malformed verdict row/);
  });

  it('does not discard an invalid leading cell from a pipe-delimited row', () => {
    expectFailOpen('| maybe | yes | no |', ['crypto', 'sports']);
  });

  it('rejects repeated outer pipe delimiters instead of collapsing empty cells', () => {
    expectFailOpen('|| yes | no ||', ['crypto', 'sports']);
  });

  it.each([
    '| yes | no |\nyes',
    '| yes | no |\n| no | yes |',
  ])('fails open when a valid pipe row is followed by extra verdicts: %s', raw => {
    expectFailOpen(raw, ['crypto', 'sports']);
  });

  it('strips Gemma turn and special-token markers before parsing', () => {
    expect(parseTableYesnoResponse(
      '<bos><start_of_turn>model\n| yes | no <end_of_turn><eos>',
      ['crypto', 'sports'],
    )).toMatchObject({
      shouldHide: true,
      matches: ['crypto'],
      malformed: false,
    });
  });

  it.each([
    '<start_of_turn>modelyes',
    '<start_of_turn>assistantyes',
  ])('does not treat an arbitrary role-token prefix as template syntax: %s', raw => {
    expectFailOpen(raw, ['crypto']);
  });

  it.each([
    ['yes<end_of_turn>no', ['crypto', 'sports']],
    ['yes<turn|>\nno', ['crypto', 'sports']],
    ['y<eos>es', ['crypto']],
  ] as const)('rejects a known marker embedded inside verdict content: %s', (raw, requested) => {
    expectFailOpen(raw, [...requested], /marker outside response wrapper/);
  });

  it('parses one exact verdict per line, including pipe-style turn markers', () => {
    expect(parseTableYesnoResponse(
      '<|turn>model\nno\nyes\nno<turn|>',
      categories,
    )).toMatchObject({
      matches: ['sports'],
      malformed: false,
    });
  });

  it('accepts repeated known end markers only at the response boundary', () => {
    expect(parseTableYesnoResponse(
      '| yes | no<turn|><turn|>',
      ['crypto', 'sports'],
    )).toMatchObject({
      matches: ['crypto'],
      malformed: false,
    });
  });

  it('accepts trailing verdict punctuation without accepting explanations', () => {
    expect(parseTableYesnoResponse('Yes,\nno.', ['crypto', 'sports'])).toMatchObject({
      matches: ['crypto'],
      malformed: false,
    });
    expectFailOpen('Yes, but actually no after reconsidering', ['crypto']);
    expectFailOpen('no because this does match', ['crypto']);
  });

  it('rejects contradictory newline verdicts for one category', () => {
    expectFailOpen('yes\nno', ['crypto'], /expected 1 verdicts, got 2/);
  });
});

describe('category-labeled Gemma verdict drift', () => {
  const categories = ['hype cycle', 'overhyped', 'founder ego'];

  it('accepts exact category-labeled rows in request order', () => {
    const raw = '| hype cycle | yes |\n| overhyped | no |\n| founder ego | yes |';
    expect(parseTableYesnoResponse(raw, categories)).toMatchObject({
      malformed: false,
      matches: ['hype cycle', 'founder ego'],
    });
  });

  it('accepts one exact alternating category/verdict row', () => {
    const raw = '| hype cycle | yes | overhyped | no | founder ego | yes |';
    expect(parseTableYesnoResponse(raw, categories)).toMatchObject({
      malformed: false,
      matches: ['hype cycle', 'founder ego'],
    });
  });

  it('does not let standalone verdicts overwrite an exact labeled response', () => {
    const raw = '| hype cycle | yes |\n| overhyped | no |\n| founder ego | yes |\nno\nyes\nno';
    expectFailOpen(raw, categories);
  });

  it.each([
    '| hype cycle | yes |\n| overhyped | no |',
    '| overhyped | no |\n| hype cycle | yes |\n| founder ego | yes |',
    '| hype cycle | yes |\n| invented label | no |\n| founder ego | yes |',
  ])('rejects incomplete, reordered, or invented labels: %s', raw => {
    expectFailOpen(raw, categories);
  });
});
