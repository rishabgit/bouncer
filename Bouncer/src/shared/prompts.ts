// System prompts and message builders for local model calls

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

// Build user message for local models — single post with filter categories
export function buildLocalUserMessage(postText: string, bannedCategories: string[], hasImages: boolean): string {
  const forbiddenList = bannedCategories.join(', ');
  const mediaDesc = hasImages ? ' (includes images)' : '';

  let prompt = `You should make your judgment based ONLY on the following list of filter categories, not the ones in the above examples!\n<filter_categories>${forbiddenList}</filter_categories>`;

  prompt += `\n<post${mediaDesc}>${postText}</post>`;
  return prompt;
}
