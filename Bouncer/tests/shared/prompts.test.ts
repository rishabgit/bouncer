import { describe, it, expect } from 'vitest';
import {
  TABLE_YESNO_INTENT_SYSTEM_PROMPT,
  TABLE_YESNO_SINGLE_INTENT_SYSTEM_PROMPT,
  TABLE_YESNO_SINGLE_SYSTEM_PROMPT,
  TABLE_YESNO_SYSTEM_PROMPT,
  buildSingleYesnoUserMessage,
  buildTableYesnoUserMessage,
  tableYesnoSingleSystemPrompt,
  tableYesnoSystemPrompt,
} from '../../src/shared/prompts.js';

describe('prompt variants', () => {
  it('keeps baseline prompt helpers on the shipped prompts', () => {
    expect(tableYesnoSystemPrompt()).toBe(TABLE_YESNO_SYSTEM_PROMPT);
    expect(tableYesnoSystemPrompt('baseline')).toBe(TABLE_YESNO_SYSTEM_PROMPT);
  });

  it('selects intent-aware prompts when requested', () => {
    expect(tableYesnoSystemPrompt('intent')).toBe(TABLE_YESNO_INTENT_SYSTEM_PROMPT);
    expect(TABLE_YESNO_INTENT_SYSTEM_PROMPT).toContain('outrage farming');
  });

  it('adds an intent note to the table_yesno user prompt only for intent mode', () => {
    const baseline = buildTableYesnoUserMessage('post text', ['rage bait']);
    const intent = buildTableYesnoUserMessage('post text', ['rage bait'], 'intent');

    expect(baseline).not.toContain('distinguish outrage amplification');
    expect(intent).toContain('distinguish outrage amplification');
  });

  it('states the exact multi-category verdict count', () => {
    const prompt = buildTableYesnoUserMessage('post text', ['a', 'b', 'c']);
    expect(prompt).toContain('exactly 3 verdicts');
  });

  it('uses a plain yes/no prompt for one category', () => {
    expect(tableYesnoSingleSystemPrompt()).toBe(TABLE_YESNO_SINGLE_SYSTEM_PROMPT);
    expect(tableYesnoSingleSystemPrompt('intent')).toBe(TABLE_YESNO_SINGLE_INTENT_SYSTEM_PROMPT);
    expect(buildSingleYesnoUserMessage('post text', 'rage bait'))
      .toContain('Answer with one word, yes or no');
    expect(TABLE_YESNO_SINGLE_SYSTEM_PROMPT).not.toContain('|');
  });
});
