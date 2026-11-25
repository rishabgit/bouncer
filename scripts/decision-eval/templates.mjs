import { createHash } from 'node:crypto';

// The same two question forms are used for every model variant. A rage
// question always carries the production intent boundary, independently of form.
export const RAGE_DEFINITION = 'For categories like "rage bait" or "outrage farming", answer yes only when the post is engineered to provoke anger or amplify a pile-on: repost/share/quote/tag requests, ratio calls, "make this loud" framing, "wake up" outrage escalation, or language that pushes readers to attack or shame a target. Answer no for sincere frustration, fair criticism, personal hardship, civic participation, ordinary sarcasm, or calm pessimism unless the post is also trying to farm outrage.';

export const TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'matches-category',
    label: 'Category match',
    instructions: 'Does this social media post match the category {category}? Answer yes if it matches, otherwise no.',
  }),
  Object.freeze({
    id: 'category-applies',
    label: 'Category applies',
    instructions: 'Decide whether the category {category} applies to this social media post. The decision concerns this category alone. Answer yes if it applies, otherwise no.',
  }),
]);

function templateById(id) {
  const template = TEMPLATES.find(item => item.id === id);
  if (!template) throw new Error(`Unknown question template: ${String(id)}`);
  return template;
}

export function templateHash(templateId) {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    template: templateById(templateId),
    questionType: 'noul',
    questionKeys: 'f0,f1,... in input filter order',
    categoryEncoding: 'JSON.stringify',
    rageDefinition: RAGE_DEFINITION,
    rageDetection: 'rage bait|outrage farming (case insensitive)',
  })).digest('hex');
}

export function questions(filters, templateId) {
  const template = templateById(templateId);
  if (!Array.isArray(filters) || !filters.length
      || filters.some(filter => typeof filter !== 'string' || !filter.trim())) {
    throw new Error('Questions require a nonempty list of nonempty filter phrases');
  }
  return Object.fromEntries(filters.map((filter, index) => {
    const base = template.instructions.replace('{category}', () => JSON.stringify(filter));
    const instructions = /rage bait|outrage farming/i.test(filter)
      ? `${base}\n\n${RAGE_DEFINITION}` : base;
    return [`f${index}`, { type: 'noul', instructions }];
  }));
}
