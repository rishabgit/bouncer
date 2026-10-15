// Shared phrase-generation prompt and parser used by both the production
// "Bounce this tweet" pipeline and the dev-only live-model comparison.

export function buildSuggestionSystemPrompt(count: number, rejectPhrases: string[] = []): string {
  const rejected = rejectPhrases.length > 0
    ? ` Do NOT suggest any of these: ${rejectPhrases.join(', ')}.`
    : '';

  return `Given a social media post, suggest 0 to ${count} useful filter phrases (1-3 words each) for hiding similar posts. Ground each phrase in the post's actual topic, wording, or clearly shown behavior. Accurate neutral topics are allowed; do not assume every post deserves criticism. Distinguish the poster's behavior from people or conduct they merely mention, quote, report, or criticize. Do not invent boasting, advice, vanity, wrongdoing, ideology, motives, or allegations. Each phrase must fit the question "does this post relate to [phrase]?". Do not pad the list.${rejected} Output ONLY phrases, one per line, with no explanation. If no useful phrase fits, output exactly NONE.`;
}

export function parseCandidatePhrases(rawText: string, count: number): string[] {
  // NONE is an empty result only when it is the entire response. Keep actual
  // phrases containing that word, including topics the classifier can validate.
  const response = rawText.trim();
  if (!response || response === 'NONE') return [];

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
    .filter(line => line.split(/\s+/u).length <= 3)
    .slice(0, count)
    .map(line => line.toLowerCase());
}
