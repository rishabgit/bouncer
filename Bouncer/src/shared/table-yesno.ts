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
// Accept them only as a response wrapper. A marker embedded in verdict content
// is malformed rather than a license to manufacture a token or row boundary.
function stripGemmaMarkers(raw: string): string | null {
  let cleaned = raw.trim();

  // Boundary-only special tokens may wrap the turn markers.
  cleaned = cleaned.replace(/^(?:<(?:bos|pad)>[ \t\r\n]*)+/i, '');
  cleaned = cleaned.replace(/(?:[ \t\r\n]*<(?:eos|pad)>)+$/i, '');

  // Some exports include an exact role token immediately after the known
  // start marker. It must be a complete line-level role, not a text prefix.
  cleaned = cleaned.replace(
    /^<\|?(?:turn|start_of_turn)\|?>(?:[ \t]*(?:model|assistant)(?=[ \t]*(?:\r?\n|$)))?/i,
    '',
  );
  cleaned = cleaned.replace(
    /(?:[ \t\r\n]*<\|?(?:turn|end_of_turn)\|?>)+$/i,
    '',
  );

  const embeddedKnownMarker = /<\|?(?:turn|start_of_turn|end_of_turn)\|?>|<(?:eos|bos|pad)>/i;
  return embeddedKnownMarker.test(cleaned) ? null : cleaned.trim();
}

function malformed(reasoning: string): TableYesnoResult {
  return { shouldHide: false, reasoning, matches: [], malformed: true };
}

function exactVerdict(value: string): 'yes' | 'no' | null {
  const match = value.trim().match(/^(yes|no)[.!,:;]?$/i);
  return match ? (match[1].toLowerCase() as 'yes' | 'no') : null;
}

function exactCategory(value: string, category: string): boolean {
  return value.trim().toLocaleLowerCase() === category.trim().toLocaleLowerCase();
}

function pipeCells(line: string): string[] {
  const cells = line.split('|').map(cell => cell.trim());
  // One leading/trailing delimiter is canonical. Preserve additional empty
  // cells so repeated delimiters remain invalid instead of being normalized.
  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();
  return cells;
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
  if (cleaned === null) {
    return malformed(`Malformed verdict row (marker outside response wrapper): ${rawResponse}`);
  }
  const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
  let verdicts: Array<'yes' | 'no'> | null = null;

  const parseSinglePipeRow = (line: string): Array<'yes' | 'no'> | null => {
    const parseCells = (cells: string[]): Array<'yes' | 'no'> | null => {
      if (cells.length === categories.length * 2) {
        const labeledVerdicts: Array<'yes' | 'no'> = [];
        let exactLabeledRow = true;
        for (let index = 0; index < categories.length; index++) {
          const verdict = exactVerdict(cells[index * 2 + 1]);
          if (!exactCategory(cells[index * 2], categories[index]) || verdict === null) {
            exactLabeledRow = false;
            break;
          }
          labeledVerdicts.push(verdict);
        }
        if (exactLabeledRow) return labeledVerdicts;
      }

      const parsed = cells.map(exactVerdict);
      return parsed.every((value): value is 'yes' | 'no' => value !== null)
        ? parsed
        : null;
    };

    return parseCells(pipeCells(line));
  };

  // E2B sometimes repeats labels even when asked for verdicts only. Accept
  // that drift only when every label exactly matches the requested category
  // in order; partial, reordered, or invented labels remain malformed.
  const pipeLines = lines.filter(line => line.includes('|'));
  const nonPipeLines = lines.filter(line => !line.includes('|'));

  // A response may use either a pipe shape or newline-per-verdict shape, never
  // both. After known template markers are stripped, any remaining prose or
  // additional line makes the complete response malformed.
  if (pipeLines.length > 0 && nonPipeLines.length > 0) {
    return malformed(`Malformed verdict row (extra content found): ${rawResponse}`);
  }

  if (pipeLines.length > 1) {
    if (pipeLines.length !== categories.length) {
      return malformed(`Malformed verdict row (extra pipe rows found): ${rawResponse}`);
    }
    const rows = pipeLines.map(pipeCells);
    if (rows.every((cells, index) =>
      cells.length === 2
      && exactCategory(cells[0], categories[index])
      && exactVerdict(cells[1]) !== null
    )) {
      verdicts = rows.map(cells => exactVerdict(cells[1])!);
    } else {
      return malformed(`Malformed verdict row (invalid labeled rows): ${rawResponse}`);
    }
  } else if (pipeLines.length === 1) {
    // One explicit row may be bare verdicts or exact alternating labels.
    verdicts = parseSinglePipeRow(pipeLines[0]);
  } else {
    // Some Gemma builds emit one verdict per line. Every non-empty line must be
    // an exact verdict; detached preambles and explanations are malformed.
    const parsed = nonPipeLines.map(exactVerdict);
    if (parsed.length > 0
        && parsed.every((value): value is 'yes' | 'no' => value !== null)) {
      verdicts = parsed;
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
