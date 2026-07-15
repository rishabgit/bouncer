// System prompts and message builders for local model calls

export type LocalPromptMode = 'baseline' | 'intent';

// Table-yesno prompt ported from imbue-ai/bouncer-evals-and-results
// (src/prompts/table_yesno.py). The model emits one pipe-delimited row of
// `yes`/`no` verdicts — one per category, in the order given. Far fewer output
// tokens than a reasoning sentence, which dominates wall-clock for a 4B model
// decoding on consumer WebGPU. Used by the LiteRT-LM/Gemma path; callers parse
// known formatting shapes with strict arity and fall back to SHOW on malformed output.
export const TABLE_YESNO_SYSTEM_PROMPT = `You will see a social media post and a list of candidate categories. For each category, decide whether the post matches that category.

Output exactly one row of pipe-delimited verdicts, one per category, in the order they were given. Each verdict is \`yes\` or \`no\`. Output nothing else.

Format example for 3 categories: | no | yes | no
`;

export const TABLE_YESNO_INTENT_SYSTEM_PROMPT = `You will see a social media post and a list of candidate categories. For each category, decide whether the post matches that category.

For categories like "rage bait" or "outrage farming", answer yes only when the post is engineered to provoke anger or amplify a pile-on: repost/share/quote/tag requests, ratio calls, "make this loud" framing, "wake up" outrage escalation, or language that pushes readers to attack or shame a target.

Answer no for sincere frustration, fair criticism, personal hardship, civic participation, ordinary sarcasm, or calm pessimism unless the post is also trying to farm outrage.

Output exactly one row of pipe-delimited verdicts, one per category, in the order they were given. Each verdict is \`yes\` or \`no\`. Output nothing else.

Format example for 3 categories: | no | yes | no
`;

export function tableYesnoSystemPrompt(mode: LocalPromptMode = 'baseline'): string {
  return mode === 'intent' ? TABLE_YESNO_INTENT_SYSTEM_PROMPT : TABLE_YESNO_SYSTEM_PROMPT;
}

export const TABLE_YESNO_SINGLE_SYSTEM_PROMPT = `You will see a social media post and one candidate category. Decide whether the post matches the category.

Answer with a single word: yes or no. Output nothing else — no pipes, no table, no second verdict, and no explanation.`;

export const TABLE_YESNO_SINGLE_INTENT_SYSTEM_PROMPT = `You will see a social media post and one candidate category. Decide whether the post matches the category.

For a category like "rage bait" or "outrage farming", answer yes only when the post is engineered to provoke anger or amplify a pile-on. Answer no for sincere frustration, fair criticism, personal hardship, civic participation, ordinary sarcasm, or calm pessimism unless the post is also trying to farm outrage.

Answer with a single word: yes or no. Output nothing else — no pipes, no table, no second verdict, and no explanation.`;

export function tableYesnoSingleSystemPrompt(mode: LocalPromptMode = 'baseline'): string {
  return mode === 'intent' ? TABLE_YESNO_SINGLE_INTENT_SYSTEM_PROMPT : TABLE_YESNO_SINGLE_SYSTEM_PROMPT;
}

export function buildSingleYesnoUserMessage(
  postText: string,
  category: string,
  mode: LocalPromptMode = 'baseline',
): string {
  const intentNote = mode === 'intent'
    ? '\n\nFor rage bait or outrage farming, distinguish outrage amplification from sincere frustration or criticism.'
    : '';
  return `Post: ${postText}\n\nCategory: ${category}${intentNote}\n\nDoes the post match the category? Answer with one word, yes or no:`;
}

// Build the user message for the table_yesno path — the post plus the ordered
// category list the model emits one verdict per.
export function buildTableYesnoUserMessage(
  postText: string,
  categories: string[],
  mode: LocalPromptMode = 'baseline',
): string {
  const categoryList = categories.join(', ');
  const intentNote = mode === 'intent'
    ? '\n\nIf the category is rage bait or outrage farming, distinguish outrage amplification from sincere frustration or criticism.'
    : '';
  const count = categories.length;
  return `Post: ${postText}\n\nCategories (in order): ${categoryList}${intentNote}\n\nOutput the verdict row (exactly ${count} verdict${count === 1 ? '' : 's'}, one per category):`;
}
