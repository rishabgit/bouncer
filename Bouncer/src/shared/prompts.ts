// System prompts and message builders for local model calls

export type LocalPromptMode = 'baseline' | 'intent';

// System prompt for local models processing one post at a time
export const LOCAL_SYSTEM_PROMPT = `You filter posts. Write 10-15 words identifying what the post is about, then state if it matches a filter category.

Example outputs (the categories here are illustrative placeholders — only judge against the categories you are actually given):

<example>
<filter_categories>sprockets</filter_categories>
<post>Just installed a new sprocket on my bike — rides so smooth now.</post>
Post about installing a bike sprocket, which is sprockets content. Matches sprockets.
</example>

<example>
<filter_categories>sprockets</filter_categories>
<post>Had a wonderful morning walk in the park today.</post>
Post about a morning walk, unrelated to sprockets. No match.
</example>

You will be provided with a post (<post>) and a list of filter categories (<filter_categories>).
Assess whether the topic of the post relates to any of the topics in the filter categories list.
Your reasoning must be AT MOST 15 words, and MUST end with a statement of "Matches <topic>" or "No match".

Be precise in your judgment; only match posts that clearly and directly relate to the filter categories.`;

// Dev-only eval variant prompt. Production callers use LOCAL_SYSTEM_PROMPT; the
// benchmark page can opt into this to compare whether intent/register framing
// helps distinguish outrage farming from ordinary frustration.
export const LOCAL_INTENT_SYSTEM_PROMPT = `You filter posts. Write 10-15 words identifying what the post is doing, then state if it matches a filter category.

For filters like "rage bait" or "outrage farming", match only posts engineered to provoke anger or amplify a pile-on: repost/share/quote/tag requests, ratio calls, "make this loud" framing, "wake up" outrage escalation, or language that pushes readers to attack or shame a target.

Do NOT match sincere frustration, fair criticism, personal hardship, civic participation, ordinary sarcasm, or calm pessimism unless the post is also trying to farm outrage.

You will be provided with a post (<post>) and a list of filter categories (<filter_categories>).
Your reasoning must be AT MOST 15 words, and MUST end with a statement of "Matches <topic>" or "No match".`;

export function localSystemPrompt(mode: LocalPromptMode = 'baseline'): string {
  return mode === 'intent' ? LOCAL_INTENT_SYSTEM_PROMPT : LOCAL_SYSTEM_PROMPT;
}

// Build user message for local models — single post with filter categories
export function buildLocalUserMessage(postText: string, bannedCategories: string[], hasImages: boolean): string {
  const forbiddenList = bannedCategories.join(', ');
  const mediaDesc = hasImages ? ' (includes images)' : '';

  let prompt = `You should make your judgment based ONLY on the following list of filter categories, not the ones in the above examples!\n<filter_categories>${forbiddenList}</filter_categories>`;

  prompt += `\n<post${mediaDesc}>${postText}</post>`;
  return prompt;
}

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
  hasImages: boolean,
  mode: LocalPromptMode = 'baseline',
): string {
  const mediaDesc = hasImages ? ' (includes images)' : '';
  const intentNote = mode === 'intent'
    ? '\n\nFor rage bait or outrage farming, distinguish outrage amplification from sincere frustration or criticism.'
    : '';
  return `Post${mediaDesc}: ${postText}\n\nCategory: ${category}${intentNote}\n\nDoes the post match the category? Answer with one word, yes or no:`;
}

// Build the user message for the table_yesno path — the post plus the ordered
// category list the model emits one verdict per.
export function buildTableYesnoUserMessage(
  postText: string,
  categories: string[],
  hasImages: boolean,
  mode: LocalPromptMode = 'baseline',
): string {
  const mediaDesc = hasImages ? ' (includes images)' : '';
  const categoryList = categories.join(', ');
  const intentNote = mode === 'intent'
    ? '\n\nIf the category is rage bait or outrage farming, distinguish outrage amplification from sincere frustration or criticism.'
    : '';
  const count = categories.length;
  return `Post${mediaDesc}: ${postText}\n\nCategories (in order): ${categoryList}${intentNote}\n\nOutput the verdict row (exactly ${count} verdict${count === 1 ? '' : 's'}, one per category):`;
}
