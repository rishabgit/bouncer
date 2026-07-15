import type { ChatMessage } from '../types';
import {
  buildSingleYesnoUserMessage,
  buildTableYesnoUserMessage,
  tableYesnoSingleSystemPrompt,
  tableYesnoSystemPrompt,
  type LocalPromptMode,
} from './prompts';

export interface TableYesnoRequest {
  messages: ChatMessage[];
  maxOutputTokens: number;
}

/** Build the exact Gemma request shared by production and live-model evals. */
export function buildTableYesnoRequest(
  postText: string,
  categories: string[],
  promptMode: LocalPromptMode = 'baseline',
): TableYesnoRequest {
  const single = categories.length === 1;
  const systemPrompt = single
    ? tableYesnoSingleSystemPrompt(promptMode)
    : tableYesnoSystemPrompt(promptMode);
  const userText = single
    ? buildSingleYesnoUserMessage(postText, categories[0], promptMode)
    : buildTableYesnoUserMessage(postText, categories, promptMode);

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    // Compact models normally emit one token per verdict, but E2B can repeat
    // each category label despite the terse contract. Give that still-
    // unambiguous shape enough room instead of truncating a labeled row. Cap
    // the drift budget so a malformed response cannot decode indefinitely.
    maxOutputTokens: Math.min(256, Math.max(64, 12 * categories.length)),
  };
}
