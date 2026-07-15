import { describe, it, expect } from 'vitest';
import {
  LOCAL_INTENT_SYSTEM_PROMPT,
  LOCAL_SYSTEM_PROMPT,
  TABLE_YESNO_INTENT_SYSTEM_PROMPT,
  TABLE_YESNO_SINGLE_INTENT_SYSTEM_PROMPT,
  TABLE_YESNO_SINGLE_SYSTEM_PROMPT,
  TABLE_YESNO_SYSTEM_PROMPT,
  buildLocalUserMessage,
  buildSingleYesnoUserMessage,
  buildTableYesnoUserMessage,
  localSystemPrompt,
  tableYesnoSingleSystemPrompt,
  tableYesnoSystemPrompt,
} from '../../src/shared/prompts.js';

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

describe('prompt variants', () => {
  it('keeps baseline prompt helpers on the shipped prompts', () => {
    expect(localSystemPrompt()).toBe(LOCAL_SYSTEM_PROMPT);
    expect(localSystemPrompt('baseline')).toBe(LOCAL_SYSTEM_PROMPT);
    expect(tableYesnoSystemPrompt()).toBe(TABLE_YESNO_SYSTEM_PROMPT);
    expect(tableYesnoSystemPrompt('baseline')).toBe(TABLE_YESNO_SYSTEM_PROMPT);
  });

  it('selects intent-aware prompts when requested', () => {
    expect(localSystemPrompt('intent')).toBe(LOCAL_INTENT_SYSTEM_PROMPT);
    expect(tableYesnoSystemPrompt('intent')).toBe(TABLE_YESNO_INTENT_SYSTEM_PROMPT);
    expect(LOCAL_INTENT_SYSTEM_PROMPT).toContain('sincere frustration');
    expect(TABLE_YESNO_INTENT_SYSTEM_PROMPT).toContain('outrage farming');
  });

  it('adds an intent note to the table_yesno user prompt only for intent mode', () => {
    const baseline = buildTableYesnoUserMessage('post text', ['rage bait'], false);
    const intent = buildTableYesnoUserMessage('post text', ['rage bait'], false, 'intent');

    expect(baseline).not.toContain('distinguish outrage amplification');
    expect(intent).toContain('distinguish outrage amplification');
  });

  it('states the exact multi-category verdict count', () => {
    const prompt = buildTableYesnoUserMessage('post text', ['a', 'b', 'c'], false);
    expect(prompt).toContain('exactly 3 verdicts');
  });

  it('uses a plain yes/no prompt for one category', () => {
    expect(tableYesnoSingleSystemPrompt()).toBe(TABLE_YESNO_SINGLE_SYSTEM_PROMPT);
    expect(tableYesnoSingleSystemPrompt('intent')).toBe(TABLE_YESNO_SINGLE_INTENT_SYSTEM_PROMPT);
    expect(buildSingleYesnoUserMessage('post text', 'rage bait', false))
      .toContain('Answer with one word, yes or no');
    expect(TABLE_YESNO_SINGLE_SYSTEM_PROMPT).not.toContain('|');
  });
});
