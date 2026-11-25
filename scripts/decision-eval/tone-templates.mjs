import { createHash } from 'node:crypto';
import { RAGE_DEFINITION, TEMPLATES } from './templates.mjs';

export const WORDINGS = Object.freeze({
  W0: 'performative rudeness that are execessive like unnecessary usage of slurs',
  W1: 'performative rudeness that are excessive like unnecessary usage of slurs',
  W2: 'excessive rudeness',
  W3: 'rude posts',
  W4: 'posts being deliberately rude or edgy to get attention',
  W5: 'posts insulting people or using slurs',
  W6: 'posts that insult someone or use slurs',
  W7: 'insults, slurs and name-calling aimed at people',
  W8: 'posts where the author insults people or uses slurs',
  W9: 'slurs or insults',
  W10: 'posts with slurs',
  W11: 'posts mocking or insulting people to look edgy',
  W12: 'posts insulting or attacking a person',
});

export const TONE_TEMPLATES = Object.freeze({
  T0: TEMPLATES.find(template => template.id === 'matches-category').instructions,
  T1: TEMPLATES.find(template => template.id === 'category-applies').instructions,
  T2: 'Is this social media post itself an example of {category}? Answer yes only if the post itself is {category}, otherwise no.',
  T3: 'Someone hides social media posts described as {category}. Should this post be hidden? Answer yes if it fits that description, otherwise no.',
  T4: 'Does this social media post match the category {category}? Answer yes if it clearly matches. Answer no if it does not match or if the post has too little content to tell.',
});

const RAGE_DETECTION = /rage[\s-]?bait|outrage farming/i;

export function toneQuestion(label, templateId = 'T0') {
  if (typeof label !== 'string' || !label.trim()) {
    throw new TypeError('Tone questions require a nonempty label');
  }
  if (typeof templateId !== 'string' || !Object.hasOwn(TONE_TEMPLATES, templateId)) {
    throw new TypeError(`Unknown tone template: ${String(templateId)}`);
  }
  const base = TONE_TEMPLATES[templateId].replaceAll('{category}', () => JSON.stringify(label));
  const instructions = RAGE_DETECTION.test(label) ? `${base}\n\n${RAGE_DEFINITION}` : base;
  return { f0: { type: 'noul', instructions } };
}

/** Fingerprint every study wording, question form and rage-category rule. */
export function toneTemplateHash() {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    templates: TONE_TEMPLATES,
    wordings: WORDINGS,
    questionType: 'noul',
    categoryEncoding: 'JSON.stringify (all occurrences)',
    rageDefinition: RAGE_DEFINITION,
    rageDetection: RAGE_DETECTION.source,
    rageDetectionFlags: RAGE_DETECTION.flags,
  })).digest('hex');
}
