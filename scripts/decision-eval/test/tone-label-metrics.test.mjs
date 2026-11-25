import assert from 'node:assert/strict';
import test from 'node:test';
import { RAGE_DEFINITION, TEMPLATES } from '../templates.mjs';
import { optimalCutoff } from '../wording-metrics.mjs';
import { TONE_TEMPLATES, WORDINGS, toneQuestion, toneTemplateHash } from '../tone-templates.mjs';
import {
  CUTOFF, CONTENT_FREE, GATE_SCOPES, applyPolicy, calibrateProbability, evaluateGates,
  ownWords, stripLeadingMentions, summarizeRows, transformState, validatePolicy,
} from '../tone-label-metrics.mjs';

const policy = changes => ({
  template: 'T0', stateTransform: 'none', calibration: 'none', shortRule: null,
  cutoff: CUTOFF, ...changes,
});

function close(actual, expected, tolerance = 1e-12) {
  assert(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('tone wordings preserve the original typo and every preregistered alternative', () => {
  assert.deepEqual(WORDINGS, {
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
  assert(Object.isFrozen(WORDINGS));
});

test('tone question forms keep T0 and T1 frozen and encode all category placeholders', () => {
  assert.equal(TONE_TEMPLATES.T0, TEMPLATES.find(item => item.id === 'matches-category').instructions);
  assert.equal(TONE_TEMPLATES.T1, TEMPLATES.find(item => item.id === 'category-applies').instructions);
  assert.deepEqual(Object.keys(TONE_TEMPLATES), ['T0', 'T1', 'T2', 'T3', 'T4']);
  assert(Object.isFrozen(TONE_TEMPLATES));
  const label = 'posts saying "no" \\ $& {category}\nnext';
  assert.deepEqual(toneQuestion(label, 'T2'), {
    f0: {
      type: 'noul',
      instructions: `Is this social media post itself an example of ${JSON.stringify(label)}? Answer yes only if the post itself is ${JSON.stringify(label)}, otherwise no.`,
    },
  });
  assert.deepEqual(toneQuestion('rude posts'), toneQuestion('rude posts', 'T0'));
  for (const templateId of Object.keys(TONE_TEMPLATES)) {
    for (const label of ['rage bait', 'RAGE-BAIT', 'ragebait', 'rage\tbait', 'outrage farming']) {
      assert(toneQuestion(label, templateId).f0.instructions.endsWith(`\n\n${RAGE_DEFINITION}`));
    }
    assert(!toneQuestion('ordinary criticism', templateId).f0.instructions.includes(RAGE_DEFINITION));
  }
  assert.match(toneTemplateHash(), /^[a-f0-9]{64}$/);
  assert.equal(toneTemplateHash(), toneTemplateHash());
  for (const label of [null, undefined, 3, '', ' \n']) assert.throws(() => toneQuestion(label), TypeError);
  for (const id of [null, 'T5', 'toString', '__proto__', { toString: () => 'T0' }]) {
    assert.throws(() => toneQuestion('rude', id), TypeError);
  }
});

test('own word counts omit handles, URLs and punctuation but retain Unicode and masked words', () => {
  for (const text of ['', '   ', '@one @two', 'https://example.test/a?x=3', 'HTTPS://example.test',
    '@one https://example.test 😡 😠 … --- ***']) {
    assert.equal(ownWords(text), 0, text);
  }
  assert.equal(ownWords('@one hey @two stop https://example.test/x 😂'), 2);
  assert.equal(ownWords('you f***ing a**hole'), 3);
  assert.equal(ownWords('你好 café १२३ 42 😀'), 4);
  assert.equal(ownWords('word-word next\nthird\tfourth'), 4);
  assert.throws(() => ownWords(null), TypeError);
});

test('leading mention stripping removes a repeated whitespace-delimited prefix only', () => {
  assert.equal(stripLeadingMentions(' \n@alice\t@bob_2\nStop this @carol'), 'Stop this @carol');
  assert.equal(stripLeadingMentions('@alice @bob'), '');
  assert.equal(stripLeadingMentions(' @alice\n @bob \t '), '');
  assert.equal(stripLeadingMentions('@alice'), '');
  assert.equal(stripLeadingMentions('hello @alice'), 'hello @alice');
  assert.equal(stripLeadingMentions('@alice,@bob hi'), '@alice,@bob hi');
  assert.equal(stripLeadingMentions('  ordinary text'), 'ordinary text');
  assert.deepEqual(transformState('@a @b 😠 …', 'strip-leading-mentions'), { text: '😠 …', unclassified: true });
  assert.deepEqual(transformState('@a @b rude', 'strip-leading-mentions'), { text: 'rude', unclassified: false });
  assert.deepEqual(transformState('@a 3', 'strip-leading-mentions'), { text: '3', unclassified: false });
  assert.deepEqual(transformState('@a 你好', 'strip-leading-mentions'), { text: '你好', unclassified: false });
  assert.deepEqual(transformState('.', 'none'), { text: '.', unclassified: false });
  assert.throws(() => transformState('text', 'identity'), TypeError);
  assert.throws(() => stripLeadingMentions(4), TypeError);
});

test('content-free calibration subtracts the mean log odds and clamps only logit inputs', () => {
  assert.deepEqual(CONTENT_FREE, ['.', '…', '-', 'N/A', '?']);
  close(calibrateProbability(0.8, [0.5, 0.5, 0.5, 0.5, 0.5]), 0.8);
  close(calibrateProbability(0.5, [0.8, 0.8, 0.8, 0.8, 0.8]), 0.2);
  close(calibrateProbability(0.8, [0.8, 0.8, 0.8, 0.8, 0.8]), 0.5);
  close(calibrateProbability(0.7, [0.2, 0.4, 0.5, 0.6, 0.8]), 0.7);
  close(calibrateProbability(0, [0, 0, 0, 0, 0]), 0.5);
  close(calibrateProbability(1, [1, 1, 1, 1, 1]), 0.5);
  close(calibrateProbability(0, [0.5, 0.5, 0.5, 0.5, 0.5]), 1e-6);
  close(calibrateProbability(1, [0.5, 0.5, 0.5, 0.5, 0.5]), 1 - 1e-6);
  assert(calibrateProbability(0, [1, 1, 1, 1, 1]) > 0);
  assert(calibrateProbability(1, [0, 0, 0, 0, 0]) < 1);
  for (const p of [undefined, null, NaN, Infinity, -0.1, 1.1, '0.5']) {
    assert.throws(() => calibrateProbability(p, [0.5, 0.5, 0.5, 0.5, 0.5]), TypeError);
  }
  for (const priors of [undefined, {}, [], [0.5], [0.5, 0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5, NaN], new Array(5)]) {
    assert.throws(() => calibrateProbability(0.5, priors), TypeError);
  }
});

test('policy validation accepts only the complete preregistered policy schema', () => {
  const valid = policy();
  assert.equal(validatePolicy(valid), valid);
  validatePolicy(policy({ template: 'T4', stateTransform: 'strip-leading-mentions',
    calibration: 'content-free', shortRule: { maxOwnWords: 0, cutoff: 1 }, cutoff: 0 }));
  for (const field of Object.keys(valid)) {
    const missing = { ...valid };
    delete missing[field];
    assert.throws(() => validatePolicy(missing), TypeError);
  }
  for (const invalid of [null, [], { ...valid, id: 'extra' },
    policy({ template: 'matches-category' }), policy({ template: '__proto__' }),
    policy({ template: { toString: () => 'T0' } }),
    policy({ stateTransform: 'identity' }), policy({ calibration: 'contextual' }),
    policy({ shortRule: {} }), policy({ shortRule: { maxOwnWords: -1, cutoff: 1 } }),
    policy({ shortRule: { maxOwnWords: 1.5, cutoff: 1 } }),
    policy({ shortRule: { maxOwnWords: 2, cutoff: NaN } }),
    policy({ shortRule: { maxOwnWords: 2, cutoff: 1, extra: true } }),
    policy({ cutoff: NaN }), policy({ cutoff: -0.1 }), policy({ cutoff: 1.1 })]) {
    assert.throws(() => validatePolicy(invalid), TypeError);
  }
});

test('policy decisions use inclusive cutoffs and retain raw probability and original text', () => {
  const row = Object.freeze({ text: '@alice @bob rude', probability: CUTOFF, gold: true });
  const result = applyPolicy(row, policy({ stateTransform: 'strip-leading-mentions' }));
  assert.deepEqual(result, { ...row, rawProbability: CUTOFF, cutoff: CUTOFF, hidden: true, unclassified: false });
  assert.equal(row.probability, CUTOFF);
  const calibrated = applyPolicy({ text: 'rude', probability: 0.5 },
    policy({ calibration: 'content-free' }), [0.8, 0.8, 0.8, 0.8, 0.8]);
  close(calibrated.probability, 0.2);
  assert.equal(calibrated.rawProbability, 0.5);
  assert.equal(calibrated.hidden, false);
  assert.throws(() => applyPolicy({ text: 'rude', probability: 0.5 },
    policy({ calibration: 'content-free' })), TypeError);
  assert.throws(() => applyPolicy({ text: 'rude', probability: NaN }, policy()), TypeError);
  assert.throws(() => applyPolicy({ text: 'rude', probability: 0.5, unclassified: 1 }, policy()), TypeError);
});

test('short rules use the original own-word count with an inclusive word boundary', () => {
  const short = policy({ cutoff: 0.2, shortRule: { maxOwnWords: 5, cutoff: 0.8 } });
  assert.equal(applyPolicy({ text: '@alice you are an awful fool https://example.test', probability: 0.7 }, short).hidden, false);
  assert.equal(applyPolicy({ text: 'you are an awful fool today', state: 'rude', probability: 0.7 }, short).hidden, true);
  assert.equal(applyPolicy({ text: 'you are an awful fool', probability: 0.8 }, short).hidden, true);
  assert.equal(applyPolicy({ text: 'six own words fit in here', probability: 0.2 }, short).hidden, true);
  assert.equal(applyPolicy({ text: '😠 @a https://example.test', probability: 0.7 },
    policy({ shortRule: { maxOwnWords: 0, cutoff: 0.8 } })).hidden, false);
});

test('policy results report the applied cutoff for short, ordinary and unclassified rows', () => {
  const short = policy({ cutoff: 0.2, shortRule: { maxOwnWords: 2, cutoff: 0.8 } });
  assert.equal(applyPolicy({ text: 'two words', probability: 0.7, cutoff: 0.9 }, short).cutoff, 0.8);
  assert.equal(applyPolicy({ text: 'three own words', probability: 0.7 }, short).cutoff, 0.2);
  assert.equal(applyPolicy({ text: '@a', probability: 1 },
    { ...short, stateTransform: 'strip-leading-mentions' }).cutoff, 0.8);
});

test('stripped or explicitly unclassified posts stay visible even at cutoff zero', () => {
  const strip = policy({ stateTransform: 'strip-leading-mentions', cutoff: 0 });
  for (const text of ['@a @b', '@a … 😠', '.', '   ']) {
    const row = applyPolicy({ text, probability: 1 }, strip);
    assert.equal(row.unclassified, true);
    assert.equal(row.hidden, false);
    assert.equal(row.probability, 0);
  }
  assert.equal(applyPolicy({ text: '.', probability: 0 }, policy({ cutoff: 0 })).hidden, true);
  assert.equal(applyPolicy({ text: 'rude', probability: 1, unclassified: true }, policy({ cutoff: 0 })).hidden, false);
  const calibrated = applyPolicy({ text: '@a', probability: 0 }, { ...strip, calibration: 'content-free' });
  assert.equal(calibrated.probability, 0, 'skipped states do not acquire a calibrated probability');
  const scored = summarizeRows([{ ...calibrated, gold: true }]);
  assert.equal(scored.optimal.errors, 1, 'skipped positives cannot be recovered by tuning the cutoff');
});

test('summaries score actual hidden decisions and exclude ambiguous gold', () => {
  const rows = [
    { text: '@a https://example.test 😠', gold: false, probability: 0.9, hidden: true, subtype: 'content-free' },
    { text: 'a civil reply', gold: false, probability: 0.8, hidden: true, subtype: 'civil' },
    { text: 'go away fool', gold: true, probability: 0.7, hidden: false, subtype: 'short-rude' },
    { text: 'one two three four five six', gold: true, probability: 0.6, hidden: false, subtype: 'long-rude' },
    { text: 'insult', gold: true, probability: 0.5, hidden: true, subtype: 'short-rude' },
    { text: 'hi', gold: false, probability: 0.4, hidden: false },
    { text: '@a …', gold: false, probability: 1, hidden: false, unclassified: true },
    { text: 'ambiguous', gold: null, probability: 1, hidden: true, ambiguous: true },
  ];
  const summary = summarizeRows(rows);
  assert.deepEqual(summary.confusion, { tp: 1, fp: 2, fn: 2, tn: 2 });
  assert.equal(summary.n, 7);
  assert.equal(summary.positives, 3);
  assert.equal(summary.negatives, 4);
  assert.equal(summary.errors, 4);
  assert.equal(summary.correct, 3);
  assert.equal(summary.FP, 2);
  assert.equal(summary.falseHides, 2);
  assert.equal(summary.FN, 2);
  assert.equal(summary.missedHides, 2);
  assert.equal(summary.ambiguousExcluded, 1);
  assert.equal(summary.unclassified, 1);
  assert.equal(summary.lowContentFP, 1);
  assert.equal(summary.shortPositiveFN, 1);
  assert.equal(summary.missedShortRude, 1);
  assert.deepEqual(summary.fpBySubtype, { 'content-free': 1, civil: 1 });
  assert.deepEqual(summary.fnBySubtype, { 'short-rude': 1, 'long-rude': 1 });
  close(summary.auc, 0.25);
  assert.deepEqual(summary.optimal, optimalCutoff(rows.filter(row => !row.ambiguous && !row.unclassified)));
});

test('false-negative subtype counts use eligible rows and safe own keys', () => {
  const summary = summarizeRows([
    { text: 'one', gold: true, probability: 0.1, hidden: false, subtype: '__proto__' },
    { text: 'two', gold: true, probability: 0.1, hidden: false, subtype: '__proto__' },
    { text: 'three', gold: true, probability: 0.1, hidden: false },
    { text: 'four', gold: true, probability: 0.1, hidden: false, subtype: '' },
    { text: 'five', gold: true, probability: 0.1, hidden: false, subtype: 'constructor' },
    { text: 'ambiguous positive', gold: true, probability: 0.1, hidden: false,
      ambiguous: true, subtype: '__proto__' },
    { text: 'true positive', gold: true, probability: 0.9, hidden: true, subtype: 'correct' },
    { text: 'true negative', gold: false, probability: 0.1, hidden: false, subtype: 'correct' },
    { text: 'false positive', gold: false, probability: 0.9, hidden: true, subtype: 'fp-only' },
  ]);
  assert.deepEqual(summary.fnBySubtype, JSON.parse('{"__proto__":2,"unspecified":2,"constructor":1}'));
  assert.equal(Object.getPrototypeOf(summary.fnBySubtype), Object.prototype);
  assert.deepEqual(summary.fpBySubtype, { 'fp-only': 1 });
  assert.equal(summary.FN, 5);
  assert.equal(summary.ambiguousExcluded, 1);
  assert.deepEqual(summarizeRows([], { includeOptimal: false }).fnBySubtype, {});
});

test('summary reuses the widest optimal interval midpoint from frozen wording math', () => {
  const rows = [
    { gold: false, probability: 0.125 }, { gold: true, probability: 0.25 },
    { gold: false, probability: 0.5 }, { gold: true, probability: 0.875 },
  ].map(row => ({ ...row, text: 'some words', hidden: row.probability >= CUTOFF }));
  const result = summarizeRows(rows);
  assert.deepEqual(result.optimal, optimalCutoff(rows));
  assert.equal(result.optimal.cutoff, 0.6875);
  assert.deepEqual(result.optimal.interval, {
    lower: 0.5, upper: 0.875, width: 0.375, lowerInclusive: false, upperInclusive: true,
  });
  assert.equal(summarizeRows([]).auc, null);
  assert.equal(summarizeRows([]).optimal.cutoff, 0.5);
  assert.deepEqual(summarizeRows([
    { text: 'x', gold: false, probability: 0.8, hidden: true, subtype: '__proto__' },
  ]).fpBySubtype, JSON.parse('{"__proto__":1}'));
});

test('summary diagnostics honor corpus subtypes alongside text-derived populations', () => {
  const summary = summarizeRows([
    { text: 'just a placeholder', gold: false, probability: 0.9, hidden: true, subtype: 'low-content' },
    { text: 'you fool', gold: true, probability: 0.1, hidden: false, intentId: 'excessive-rudeness' },
    { text: 'a short civil topic', gold: true, probability: 0.1, hidden: false, intentId: 'topic' },
    { text: 'a long rude post with more than five words', gold: true, probability: 0.1,
      hidden: false, intentId: 'excessive-rudeness', subtype: 'short-rude' },
  ]);
  assert.equal(summary.lowContentFP, 1);
  assert.equal(summary.shortPositiveFN, 2);
  assert.equal(summary.missedShortRude, 2);
});

test('summary rejects malformed scored decisions rather than silently dropping them', () => {
  const valid = { text: 'text', gold: true, probability: 0.5, hidden: false };
  for (const rows of [null, {}, [null], new Array(1), [{ ...valid, gold: null }],
    [{ ...valid, hidden: 1 }], [{ ...valid, probability: NaN }], [{ ...valid, text: null }],
    [{ ...valid, ambiguous: 1 }], [{ ...valid, unclassified: 1 }]]) {
    assert.throws(() => summarizeRows(rows), TypeError);
  }
});

const gate = changes => ({
  name: 'candidate errors improve', metric: 'errors', policy: 'candidate',
  comparator: '<', reference: 'baseline', slack: 0, scope: 'all', factor: 1, ...changes,
});

test('gates resolve policy and numeric references with strict and inclusive comparisons', () => {
  const metrics = { candidate: { errors: 2, FP: 1 }, baseline: { errors: 3, FP: 0 } };
  const gates = [gate(), gate({ name: 'FP allowance', metric: 'FP', comparator: '<=', slack: 1 }),
    gate({ name: 'numeric bound', comparator: '<=', reference: 2 })];
  assert.deepEqual(evaluateGates(gates, metrics), {
    pass: true,
    checks: [
      { ...gates[0], actual: 2, referenceValue: 3, limit: 3, pass: true },
      { ...gates[1], actual: 1, referenceValue: 0, limit: 1, pass: true },
      { ...gates[2], actual: 2, referenceValue: 2, limit: 2, pass: true },
    ],
  });
  const failed = evaluateGates([gate({ reference: 2 })], metrics);
  assert.equal(failed.pass, false);
  assert.equal(failed.checks[0].pass, false);
  assert.deepEqual(evaluateGates([], metrics), { pass: true, checks: [] });
});

test('relative gates multiply policy and numeric references before adding slack', () => {
  const metrics = { candidate: { errors: 2 }, baseline: { errors: 3 } };
  const gates = [
    gate({ factor: 0.5, slack: 0.6 }),
    gate({ factor: 0.5, slack: 0.5 }),
    gate({ factor: 0.5, slack: 0.5, comparator: '<=' }),
    gate({ factor: 0.5, reference: 4 }),
    gate({ factor: 0.5, reference: 4, comparator: '<=' }),
    gate({ factor: 2, reference: 0, slack: 2, comparator: '<=' }),
  ];
  const result = evaluateGates(gates, metrics);
  assert.equal(result.pass, false);
  assert.deepEqual(result.checks.map(check => check.limit), [2.1, 2, 2, 2, 2, 2]);
  assert.deepEqual(result.checks.map(check => check.pass), [true, false, true, false, true, true]);
});

test('scoped gates use matching subject and reference populations and prefer scopes.all', () => {
  assert.deepEqual(GATE_SCOPES, [
    'all', 'corpus:tone-holdout', 'corpus:original-validation', 'corpus:fresh-behaviour',
    'group:excessive-rudeness', 'group:fresh-*', 'group:orig-*',
  ]);
  assert(Object.isFrozen(GATE_SCOPES));
  const metrics = {
    candidate: { errors: 100, scopes: {
      all: { errors: 4 },
      'corpus:tone-holdout': { errors: 2 },
      'corpus:original-validation': { errors: 2 },
      'corpus:fresh-behaviour': { errors: 1 },
      'group:excessive-rudeness': { errors: 1 },
      'group:fresh-*': { errors: 0 },
      'group:orig-*': { errors: 1 },
    } },
    baseline: { errors: 0, scopes: {
      all: { errors: 5 },
      'corpus:tone-holdout': { errors: 4 },
      'corpus:original-validation': { errors: 2 },
      'corpus:fresh-behaviour': { errors: 0 },
      'group:excessive-rudeness': { errors: 4 },
      'group:fresh-*': { errors: 2 },
      'group:orig-*': { errors: 1 },
    } },
  };
  const result = evaluateGates(GATE_SCOPES.map(scope => gate({ scope, factor: 0.75 })), metrics);
  assert.equal(result.pass, false);
  assert.deepEqual(result.checks.map(check => check.actual), [4, 2, 2, 1, 1, 0, 1]);
  assert.deepEqual(result.checks.map(check => check.referenceValue), [5, 4, 2, 0, 4, 2, 1]);
  assert.deepEqual(result.checks.map(check => check.pass), [false, true, false, false, true, true, false]);
  const numeric = evaluateGates([
    gate({ scope: 'corpus:fresh-behaviour', reference: 2, factor: 0.5, comparator: '<=' }),
  ], metrics);
  assert.equal(numeric.pass, true);
  assert.equal(numeric.checks[0].actual, 1);
  assert.equal(numeric.checks[0].limit, 1);
});

test('scoped gates reject absent subject or reference populations without falling back', () => {
  const scope = 'corpus:tone-holdout';
  const valid = { errors: 1, scopes: { [scope]: { errors: 1 } } };
  const missing = { errors: 0, scopes: { all: { errors: 0 } } };
  assert.throws(() => evaluateGates([gate({ scope })], { candidate: missing, baseline: valid }),
    /Missing scope corpus:tone-holdout for policy candidate/u);
  assert.throws(() => evaluateGates([gate({ scope })], { candidate: valid, baseline: missing }),
    /Missing scope corpus:tone-holdout for policy baseline/u);
  for (const candidate of [
    { errors: 0 },
    { errors: 0, scopes: null },
    { errors: 0, scopes: [] },
    { errors: 0, scopes: Object.create({ [scope]: { errors: 0 } }) },
    { errors: 0, scopes: { [scope]: null } },
    { errors: 0, scopes: { [scope]: { FP: 0 } } },
  ]) {
    assert.throws(() => evaluateGates([gate({ scope })], { candidate, baseline: valid }), TypeError);
  }
  assert.throws(() => evaluateGates([gate({ reference: 1 })], { candidate: valid }),
    TypeError, 'scopes.all is required once explicit scopes exist');
  assert.throws(() => evaluateGates([gate()], {
    candidate: { errors: 0, scopes: { all: { errors: 0 } } }, baseline: valid,
  }), /Missing scope all for policy baseline/u);
});

test('gate validation fails closed for unknown schema and missing or nonfinite counts', () => {
  const validMetrics = { candidate: { errors: 2 }, baseline: { errors: 3 } };
  const valid = gate();
  for (const field of Object.keys(valid)) {
    const missing = { ...valid };
    delete missing[field];
    assert.throws(() => evaluateGates([missing], validMetrics), TypeError);
  }
  for (const invalid of [null, [], { ...valid, extra: true },
    gate({ metric: 'auc' }), gate({ comparator: '>' }), gate({ name: '' }), gate({ policy: '' }),
    gate({ slack: -1 }), gate({ slack: Infinity }), gate({ slack: '0' }),
    gate({ factor: 0 }), gate({ factor: -1 }), gate({ factor: NaN }), gate({ factor: Infinity }),
    gate({ factor: '1' }), gate({ factor: null }), gate({ factor: undefined }),
    gate({ scope: '' }), gate({ scope: 'tone-holdout' }), gate({ scope: 'group:fresh-topic' }),
    gate({ scope: '__proto__' }), gate({ scope: null }), gate({ scope: undefined }),
    gate({ reference: NaN }), gate({ reference: -1 }), gate({ reference: '' }),
    gate({ reference: {} }), gate({ policy: 'missing' }), gate({ reference: 'missing' })]) {
    assert.throws(() => evaluateGates([invalid], validMetrics), TypeError);
  }
  for (const value of [undefined, null, NaN, Infinity, -1, '2']) {
    assert.throws(() => evaluateGates([valid], { ...validMetrics, candidate: { errors: value } }), TypeError);
    assert.throws(() => evaluateGates([valid], { ...validMetrics, baseline: { errors: value } }), TypeError);
  }
  assert.throws(() => evaluateGates([valid], { candidate: {}, baseline: { errors: 3 } }), TypeError);
  assert.throws(() => evaluateGates([gate({ reference: Number.MAX_VALUE, slack: Number.MAX_VALUE })], validMetrics), TypeError);
  assert.throws(() => evaluateGates([gate({ reference: Number.MAX_VALUE, factor: 2 })], validMetrics), /Gate limit must be finite/u);
  assert.throws(() => evaluateGates([gate({ factor: Number.MAX_VALUE })], validMetrics), /Gate limit must be finite/u);
  assert.throws(() => evaluateGates(null, validMetrics), TypeError);
  assert.throws(() => evaluateGates([], null), TypeError);
});
