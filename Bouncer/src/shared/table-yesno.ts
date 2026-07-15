// Parser for LiteRT-LM/Gemma's compact table_yesno response format.
// Parse failures always fall back to SHOW; callers can use `malformed` to
// retry through a safer path without confusing invalid output with "all no".

export interface TableYesnoResult {
  shouldHide: boolean;
  reasoning: string;
  matches: string[];
  malformed: boolean;
}

// Gemma exports have used several turn-marker spellings across model builds.
// Normalize them before looking for verdicts so leaked template tokens cannot
// become extra table cells.
function stripGemmaMarkers(raw: string): string {
  return raw
    .replace(/<\|?turn\|?>/gi, '\n')
    .replace(/<\|?(?:start|end)_of_turn\|?>/gi, '\n')
    .replace(/<(?:eos|bos|pad)>/gi, '')
    .trim();
}

function malformed(reasoning: string): TableYesnoResult {
  return { shouldHide: false, reasoning, matches: [], malformed: true };
}

function exactVerdict(value: string): 'yes' | 'no' | null {
  const match = value.trim().match(/^(yes|no)[.!,:;]?$/i);
  return match ? (match[1].toLowerCase() as 'yes' | 'no') : null;
}

export function parseTableYesnoResponse(
  rawResponse: string | null,
  categories: string[],
): TableYesnoResult {
  if (!rawResponse) {
    return malformed('Empty model response — model returned no output');
  }
  if (categories.length === 0) {
    return malformed(`Malformed verdict row (no categories supplied): ${rawResponse}`);
  }

  const cleaned = stripGemmaMarkers(rawResponse);
  const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
  let verdicts: Array<'yes' | 'no'> | null = null;

  // Prefer an explicit pipe-delimited row. Ignore a non-verdict preamble
  // before the first pipe, but never discard extra verdicts: wrong arity is a
  // parse failure so a drifted model response cannot hide the wrong category.
  const rowLine = lines.find(line => line.includes('|'));
  if (rowLine) {
    let cells = rowLine.split('|').map(cell => cell.trim());
    while (cells[0] === '') cells.shift();
    while (cells[cells.length - 1] === '') cells.pop();

    if (cells.length > categories.length && exactVerdict(cells[0]) === null) {
      const overflow = cells.length - categories.length;
      if (cells.slice(0, overflow).every(cell => exactVerdict(cell) === null)) {
        cells = cells.slice(overflow);
      }
    }

    const parsed = cells.map(exactVerdict);
    if (parsed.every((value): value is 'yes' | 'no' => value !== null)) {
      verdicts = parsed;
    }
  } else {
    // Some Gemma builds emit one verdict per line. Permit non-verdict preamble
    // or trailing text, but require exactly N verdict-bearing lines.
    const lineVerdicts = lines
      .map(line => exactVerdict(line))
      .filter((value): value is 'yes' | 'no' => value !== null);
    if (lineVerdicts.length > 0) {
      verdicts = lineVerdicts;
    }
  }

  if (!verdicts) {
    return malformed(`Malformed verdict row (no verdicts found): ${rawResponse}`);
  }
  if (verdicts.length !== categories.length) {
    return malformed(
      `Malformed verdict row (expected ${categories.length} verdicts, got ${verdicts.length}): ${rawResponse}`,
    );
  }

  const matches = categories.filter((_, index) => verdicts[index] === 'yes');
  const shouldHide = matches.length > 0;
  return {
    shouldHide,
    reasoning: shouldHide
      ? `${rawResponse} (Matched: ${matches.join(', ')})`
      : rawResponse,
    matches,
    malformed: false,
  };
}
