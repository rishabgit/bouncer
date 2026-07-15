// Shared phrase-generation prompt and parser used by both the production
// "Bounce this tweet" pipeline and the dev-only live-model comparison.

export function buildSuggestionSystemPrompt(count: number, rejectPhrases: string[] = []): string {
  const rejected = rejectPhrases.length > 0
    ? ` Do NOT suggest any of these: ${rejectPhrases.join(', ')}.`
    : '';

  return `Given a social media post, suggest exactly ${count} filter phrases (1-3 words each) that someone might add to hide posts like this one because it is annoying, obnoxious, or unpleasant. Each phrase must still work as a category: if another model were asked "does this post relate to [phrase]?", it would say yes. Favor phrases that name what is irritating about the post — its negative tone, behavior, or tactic — and make them as specific as possible. At most one phrase may be a plain topic (like "crypto" or "politics"); every other phrase must carry a clearly negative connotation. Only use an example if it genuinely fits the post.${rejected} Output ONLY the ${count} phrases, one per line, nothing else.`;
}

export function parseCandidatePhrases(rawText: string, count: number): string[] {
  const unwrap = (input: string): string => {
    let value = input.trim();
    const wrappers: Array<[string, string]> = [
      ['**', '**'], ['__', '__'], ['`', '`'], ['“', '”'], ['"', '"'], ['*', '*'], ['_', '_'],
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (const [start, end] of wrappers) {
        if (value.length > start.length + end.length && value.startsWith(start) && value.endsWith(end)) {
          value = value.slice(start.length, -end.length).trim();
          changed = true;
          break;
        }
      }
    }
    return value;
  };

  return rawText.split('\n')
    .map(line => line.replace(/^\d+[.)-]\s*/, '').replace(/^[-*•]\s+/, ''))
    .map(unwrap)
    .filter(line => line.length > 0 && line.length <= 40 && !line.startsWith('<'))
    .slice(0, count)
    .map(line => line.toLowerCase());
}
