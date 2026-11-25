// Fixed operating point from the recorded decision-model evaluation.
// Keep the evaluated question wording and construction fixed with the cutoff.
// Keep all model-specific choices together so changing the model is one bundle swap.
export interface DecisionModel {
  id: string;
  label: string;
  repository: string;
  display: string;
  fileName: string;
  templateId: string;
  template: string;
  cutoff: number;
  settings: Readonly<Record<'ctx-size' | 'parallel' | 'batch-size' | 'ubatch-size', number>>;
  noProjector: boolean;
  rageDefinition: string;
  rageSeparator: string;
  postWeightCap: number;
  requestTextByteCap: number;
  stateFormat: string;
  ragePattern: string;
}

export const DECISION_MODEL: Readonly<DecisionModel> = Object.freeze({
  id: 'LiquidAI/d1-2B-GGUF:Q8_0',
  label: 'd1',
  repository: 'LiquidAI/d1-2B-GGUF',
  display: 'd1 2B Q8',
  fileName: 'd1-2B-Q8_0.gguf',
  templateId: 'matches-category',
  template: 'Does this social media post match the category {category}? Answer yes if it matches, otherwise no.',
  cutoff: 0.290813258948728,
  settings: Object.freeze({ 'ctx-size': 4096, parallel: 1, 'batch-size': 4096, 'ubatch-size': 4096 }),
  noProjector: true,
  rageDefinition: 'For categories like "rage bait" or "outrage farming", answer yes only when the post is engineered to provoke anger or amplify a pile-on: repost/share/quote/tag requests, ratio calls, "make this loud" framing, "wake up" outrage escalation, or language that pushes readers to attack or shame a target. Answer no for sincere frustration, fair criticism, personal hardship, civic participation, ordinary sarcasm, or calm pessimism unless the post is also trying to farm outrage.',
  rageSeparator: '\n\n',
  // At most 3072 byte-fallback tokens from text; reserve 1024 context tokens for framing.
  postWeightCap: 1200,
  requestTextByteCap: 3072,
  stateFormat: 'bare-post-text-v1',
  // Deliberately wider than the eval's literal "rage bait" rule: the wording probe
  // missed 14 subtle cases for "ragebait" without the definition.
  ragePattern: String.raw`rage[\s-]?bait|outrage farming`,
});

// Quality was evaluated up to 10 filters; the server reads 16 questions per pass.
export const MAX_ACTIVE_FILTERS = 10;
export const MAX_FILTERS_CHARACTERS = 1000;
export const MAX_FILTERS_WARNING = 'You can use up to 10 filters. Remove a filter before adding another.';

export const LLAMA_ENDPOINT = 'http://127.0.0.1:9931';

export const LLAMA_MODEL_INI = [
  `[${DECISION_MODEL.id}]`,
  ...Object.entries(DECISION_MODEL.settings).map(([key, value]) => `${key} = ${value}`),
  `no-mmproj = ${DECISION_MODEL.noProjector}`,
].join('\n');

export function decisionModelFingerprint(model: Readonly<DecisionModel> = DECISION_MODEL): string {
  return `decision-v1|${JSON.stringify(model)}`;
}

export const DECISION_CLASSIFIER_FINGERPRINT = decisionModelFingerprint();

export function decisionQuestions(filters: string[]): Record<string, { type: 'noul'; instructions: string }> {
  if (!filters.length || filters.some(filter => typeof filter !== 'string' || !filter.trim())) {
    throw new Error('Questions require a nonempty list of nonempty filter phrases');
  }
  if (filters.length > MAX_ACTIVE_FILTERS) throw new Error(MAX_FILTERS_WARNING);
  if (filters.reduce((sum, label) => sum + label.length, 0) > MAX_FILTERS_CHARACTERS) {
    throw new Error('Filter phrases exceed the 1000-character limit.');
  }
  return Object.fromEntries(filters.map((filter, index) => {
    const base = DECISION_MODEL.template.replace('{category}', () => JSON.stringify(filter));
    const instructions = new RegExp(DECISION_MODEL.ragePattern, 'i').test(filter)
      ? `${base}${DECISION_MODEL.rageSeparator}${DECISION_MODEL.rageDefinition}` : base;
    return [`f${index}`, { type: 'noul' as const, instructions }];
  }));
}
