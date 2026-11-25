import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { WORDINGS } from '../tone-templates.mjs';
import { CUTOFF, CONTENT_FREE } from '../tone-label-metrics.mjs';
import { buildTonePlan, analyzeTone, discoveryPolicies, HANDLE_VARIANTS } from '../tone-label-study.mjs';

function fixture(phase = 'discovery') {
  const posts = [
    { id: 'empty', text: '@mira_k @other', subtype: 'low-content', positive: false },
    { id: 'rude', text: '@mira_k You are an idiot', subtype: 'short-rude', positive: true },
    { id: 'uncertain', text: 'What a brilliant idea', subtype: 'ambiguous', positive: false },
  ];
  const corpus = { split: phase, twins: [{ id: 'twin', sourceId: 'rude', text: '@mira_k You are a friend' }] };
  const rows = posts.flatMap(post => ['excessive-rudeness', 'food'].map(intentId => ({
    key: `${post.id}:${intentId}`, postId: post.id, text: post.text, intentId, labelKey: intentId,
    label: intentId === 'excessive-rudeness' ? WORDINGS.W0 : 'food and cooking',
    gold: intentId === 'excessive-rudeness' && post.positive, ambiguous: post.id === 'uncertain',
    subtype: post.subtype, corpus: `tone-${phase}`, group: intentId === 'excessive-rudeness' ? intentId : 'fresh-food',
  })));
  return { phase, corpus, rows };
}

function complete(plan) {
  return plan.requests.map(({ state, ...request }) => ({ ...request,
    probability: state.includes('idiot') ? .9 : state.includes('friend') ? .1 : state.includes('brilliant') ? .99 : .4,
    wallMs: 8, inputTokens: 23 }));
}

function holdoutPolicies() {
  return [discoveryPolicies()[0], { ...discoveryPolicies()[6], id: 'stripped' }];
}

test('tone request plans cover every decision and wording with only single-question sends', () => {
  const args = fixture(), plan = buildTonePlan(args);
  assert.deepEqual(plan, buildTonePlan(args));
  const { questions, requests, refs } = plan;
  assert.equal(createHash('sha256').update(JSON.stringify({ questions, requests, refs })).digest('hex'),
    '6431c1bd261852314d8ada40c97a35071b46d9df204276dafe27eda4c4b714e1',
    'discovery questions, request scheduling and refs remain compatible with recorded evidence');
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, 'plan is plain serializable data');
  assert.equal(Object.keys(plan.refs.baseline).length, args.rows.length);
  assert.equal(plan.wordingIds.length, 13);
  for (const wording of Object.keys(WORDINGS)) {
    assert.equal(Object.keys(plan.refs.wordings[wording]).length, 3);
    const prior = plan.refs.priors[JSON.stringify(['T0', WORDINGS[wording]])];
    assert.equal(prior.length, CONTENT_FREE.length);
    assert.deepEqual(prior.map(index => plan.requests[index].state), [...CONTENT_FREE]);
  }
  for (const request of plan.requests) {
    assert.equal(request.index, plan.requests.indexOf(request));
    assert.deepEqual(Object.keys(plan.questions[request.questionKey]), ['f0']);
    assert.equal(plan.questions[request.questionKey].f0.type, 'noul');
    assert.ok(!Object.hasOwn(request, 'questions'));
  }
  assert.equal(new Set(plan.requests.map(request => JSON.stringify([request.questionKey, request.state]))).size, plan.requests.length);
  assert.equal(new Set(Object.values(plan.questions).map(question => JSON.stringify(question))).size, Object.keys(plan.questions).length);
  assert.equal(plan.refs.policies.P6['empty:food'].index, null);
  assert.equal(plan.refs.policies.P6['empty:excessive-rudeness'].unclassified, true);
  assert.equal(plan.refs.wordings.W0['rude:excessive-rudeness'], plan.refs.baseline['rude:excessive-rudeness']);
  assert.equal(plan.refs.handles.length, 2);
  assert.ok(plan.refs.handles.every(post => post.handles.length === HANDLE_VARIANTS.length));
});

test('tone analysis excludes ambiguous gold, scores all policies and resolves preregistered gates', () => {
  const args = fixture(), plan = buildTonePlan(args);
  const gates = [{ name: 'stripping lowers false hides', metric: 'FP', policy: 'P6', comparator: '<', reference: 'P0', slack: 0, scope: 'all', factor: 1 }];
  const summary = analyzeTone({ ...args, plan, requests: complete(plan), gates });
  assert.equal(summary.counts.decisions, 6);
  assert.equal(summary.counts.scoredDecisions, 4);
  assert.equal(summary.counts.ambiguous, 2);
  assert.equal(summary.wordings.length, 13);
  assert.ok(summary.wordings.every(wording => wording.n === 2 && wording.ambiguousExcluded === 1 && wording.medianMs === 8));
  const baseline = summary.policies.find(policy => policy.id === 'P0');
  const stripped = summary.policies.find(policy => policy.id === 'P6');
  assert.equal(baseline.errors, 3);
  assert.equal(stripped.errors, 1);
  assert.equal(stripped.unclassified, 2);
  assert.equal(Object.values(baseline.byCorpus)[0].n, 4);
  assert.equal(baseline.byGroup['excessive-rudeness'].n, 2);
  assert.equal(summary.gates.pass, true);
  assert.equal(summary.gates.checks[0].actual, 1);
  assert.equal(summary.shortRuleGrid.table.length, 6);
  assert.equal(summary.shortRuleGrid.cutoffs.length, 66);
  assert.ok(summary.shortRuleGrid.table.every(row => row.errors.length === 66));
  assert.equal(summary.shortRuleGrid.best.policy.cutoff, CUTOFF);
  assert.equal(summary.diagnostics.templateSensitivity.length, 5);
  assert.equal(summary.diagnostics.templateSensitivity[0].spearmanVsT0, 1);
  assert.equal(summary.diagnostics.twins[0].medianSourceMinusTwin, .8);
  assert.equal(summary.diagnostics.handleSensitivity.length, 2);
  assert.equal(summary.diagnostics.subtypeDistributions[0].subtypes.find(row => row.subtype === 'ambiguous').n, 1);
  assert.deepEqual(stripped.ownerFlips, [{
    postId: 'empty', text: '@mira_k @other', subtype: 'low-content', gold: false, ambiguous: false,
    baseline: { probability: .4, cutoff: CUTOFF, hidden: true, unclassified: false },
    candidate: { probability: 0, cutoff: CUTOFF, hidden: false, unclassified: true }, effect: 'fixed',
  }]);
});

test('holdout uses only frozen policies and requested wordings while retaining W0/W5 diagnostics', () => {
  const args = { ...fixture('holdout'), policies: holdoutPolicies(), wordings: ['W2', 'W8'] };
  const plan = buildTonePlan(args), summary = analyzeTone({ ...args, plan, requests: complete(plan) });
  assert.deepEqual(summary.wordings.map(wording => wording.id), ['W2', 'W8']);
  assert.deepEqual(Object.keys(plan.refs.wordings), ['W2', 'W8', 'W0', 'W5']);
  assert.equal(summary.shortRuleGrid, null);
  assert.equal(summary.diagnostics.templateSensitivity, undefined);
  assert.ok(summary.policies.every(policy => policy.optimizedOnDiscovery === false));
  assert.ok(summary.policies.every(policy => !Object.hasOwn(policy, 'optimal')));
  assert.ok(summary.wordings.every(wording => !Object.hasOwn(wording, 'optimal')));
  assert.deepEqual(summary.wordingPolicies.map(row => [row.policyId, row.wordingId]), [
    ['P0', 'W2'], ['P0', 'W8'], ['P0', 'W0'], ['stripped', 'W2'], ['stripped', 'W8'], ['stripped', 'W0'],
  ]);
  for (const policy of summary.policies) {
    const w0 = summary.wordingPolicies.find(row => row.policyId === policy.id && row.wordingId === 'W0');
    assert.deepEqual(w0.scopes.all, policy.scopes['group:excessive-rudeness']);
  }
  assert.throws(() => buildTonePlan({ ...args, policies: discoveryPolicies() }), /frozen/);
});

test('tone evidence analysis rejects incomplete, duplicate, invalid or tampered records and plans', () => {
  const args = fixture(), plan = buildTonePlan(args), requests = complete(plan);
  const analyze = (changes = {}) => analyzeTone({ ...args, plan, requests, ...changes });
  assert.throws(() => analyze({ requests: requests.slice(1) }), /Incomplete/);
  assert.throws(() => analyze({ requests: [requests[0], ...requests.slice(0, -1)] }), /duplicate/);
  for (const [field, value] of [['probability', NaN], ['probability', 1.1], ['wallMs', -1], ['inputTokens', 3.5], ['questionKey', 'other'], ['postId', 'other'], ['labelKey', 'other'], ['state', 'altered']]) {
    assert.throws(() => analyze({ requests: [{ ...requests[0], [field]: value }, ...requests.slice(1)] }), /Invalid|differs/);
  }
  const altered = structuredClone(plan);
  altered.questions.q0.f0.instructions += ' Changed';
  assert.throws(() => analyze({ plan: altered }), /deterministic/);
  const alteredRows = structuredClone(args.rows);
  alteredRows[0].text = 'Changed state';
  assert.throws(() => analyze({ rows: alteredRows }), /deterministic/);
  const badGate = [{ name: 'bad', metric: 'errors', policy: 'missing', comparator: '<=', reference: 1, slack: 0, scope: 'all', factor: 1 }];
  assert.throws(() => analyze({ gates: badGate }), /Missing metrics/);
});

test('wording gates resolve W IDs and content-free priors retain all deduplicated label identities', () => {
  const args = fixture();
  for (const row of args.rows.filter(row => row.intentId === 'food')) row.label = WORDINGS.W0;
  const plan = buildTonePlan(args);
  const gates = [{ name: 'wording errors do not increase', metric: 'errors', policy: 'W5', comparator: '<=', reference: 'W0', slack: 0, scope: 'all', factor: 1 }];
  const summary = analyzeTone({ ...args, plan, requests: complete(plan), gates });
  assert.equal(summary.gates.pass, true);
  assert.equal(summary.gates.checks[0].actual, summary.wordings.find(wording => wording.id === 'W5').errors);
  const prior = summary.diagnostics.contentFreePriors.find(prior => prior.template === 'T0' && prior.label === WORDINGS.W0);
  assert.deepEqual(prior.intentIds, ['excessive-rudeness', 'food']);
  assert.deepEqual(prior.wordingIds, ['W0']);
  assert.deepEqual(prior.labelKeys, ['excessive-rudeness', 'food', 'W0']);
  assert.equal(summary.diagnostics.contentFreePriors.filter(prior => prior.template === 'T0' && prior.label === WORDINGS.W0).length, 1);
  assert.equal(prior.probabilities.length, CONTENT_FREE.length);
});

test('template ranks include ambiguous decisions while AUC uses only eligible gold', () => {
  const args = fixture(), plan = buildTonePlan(args), requests = complete(plan);
  for (const row of args.rows.filter(row => row.ambiguous)) {
    requests[plan.refs.policies.P1[row.key].index].probability = .05;
  }
  const summary = analyzeTone({ ...args, plan, requests });
  const baseline = summary.diagnostics.templateSensitivity.find(row => row.template === 'T0');
  const changed = summary.diagnostics.templateSensitivity.find(row => row.template === 'T1');
  assert.equal(changed.n, 6);
  assert.equal(changed.aucN, 4);
  assert.equal(changed.spearmanVsT0, -.5);
  assert.equal(changed.auc, baseline.auc);
  const candidate = summary.policies.find(row => row.id === 'P1');
  assert.deepEqual(candidate.ownerFlips.find(row => row.postId === 'uncertain'), {
    postId: 'uncertain', text: 'What a brilliant idea', subtype: 'ambiguous', gold: false, ambiguous: true,
    baseline: { probability: .99, cutoff: CUTOFF, hidden: true, unclassified: false },
    candidate: { probability: .05, cutoff: candidate.policy.cutoff, hidden: false, unclassified: false }, effect: 'fixed',
  });
});

test('holdout scopes separate new tone groups from pooled regression rows and resolve relative gates', () => {
  const row = (postId, { intentId = 'excessive-rudeness', corpus = 'tone-holdout', group = intentId,
    subtype = 'ordinary', gold = false, ambiguous = false } = {}) => ({
    key: `${postId}:${intentId}`, postId, text: `Synthetic text for ${postId}`, intentId, corpus, group, subtype, gold, ambiguous,
    labelKey: intentId, label: intentId === 'excessive-rudeness' ? WORDINGS.W0 : intentId,
  });
  const rows = [
    row('tone-low', { subtype: 'low-content' }),
    row('tone-rude', { subtype: 'short-rude', gold: true }),
    row('tone-sarcasm', { subtype: 'sarcastic-rude', gold: true }),
    row('tone-ambiguous', { ambiguous: true }),
    row('tone-fresh', { intentId: 'food', group: 'fresh-food' }),
    row('tone-original', { intentId: 'work', group: 'orig-work' }),
    row('regression-original', { corpus: 'original-validation' }),
    row('regression-fresh', { intentId: 'food', corpus: 'fresh-behaviour', group: 'fresh-food' }),
  ];
  const policies = [discoveryPolicies()[0], { ...discoveryPolicies()[0], id: 'changed', template: 'T1' }];
  const args = { phase: 'holdout', corpus: { split: 'holdout' }, rows, policies, wordings: ['W0', 'W2'] };
  const plan = buildTonePlan(args), requests = complete(plan);
  for (const candidate of rows) {
    const positive = candidate.gold || candidate.ambiguous || candidate.postId === 'tone-low';
    requests[plan.refs.policies.P0[candidate.key].index].probability = positive ? .8 : .1;
    const hidden = candidate.postId === 'tone-rude' || candidate.postId.startsWith('regression-');
    requests[plan.refs.policies.changed[candidate.key].index].probability = hidden ? .8 : .1;
  }
  const gate = (name, metric, scope, reference = 'P0', factor = 1) => ({
    name, metric, scope, reference, factor, policy: 'changed', comparator: '<=', slack: 0,
  });
  const gates = [
    gate('new tone does not regress', 'errors', 'corpus:tone-holdout'),
    gate('pooled result regresses', 'errors', 'all'),
    gate('rudeness false positives halve', 'FP', 'group:excessive-rudeness', 'P0', .5),
    gate('rudeness misses increase', 'FN', 'group:excessive-rudeness'),
    gate('original regression changes', 'FP', 'corpus:original-validation'),
    gate('relative numeric pass', 'errors', 'group:excessive-rudeness', 4, .5),
    gate('relative numeric fail', 'errors', 'group:excessive-rudeness', 1, .5),
  ];
  const summary = analyzeTone({ ...args, plan, requests, gates });
  const changed = summary.policies.find(row => row.id === 'changed');
  assert.deepEqual(Object.keys(changed.scopes).sort(), [
    'all', 'corpus:fresh-behaviour', 'corpus:original-validation', 'corpus:tone-holdout',
    'group:excessive-rudeness', 'group:fresh-food', 'group:orig-work',
  ]);
  assert.equal(changed.scopes.all.errors, 3);
  assert.equal(changed.scopes['corpus:tone-holdout'].errors, 1);
  assert.equal(changed.scopes['corpus:original-validation'].FP, 1);
  assert.equal(changed.scopes['corpus:fresh-behaviour'].FP, 1);
  assert.equal(changed.scopes['group:excessive-rudeness'].n, 3);
  assert.equal(changed.scopes['group:excessive-rudeness'].FP, 0);
  assert.equal(changed.byGroup['excessive-rudeness'].FP, 1, 'compatibility buckets retain pooled rows');
  assert.equal(changed.scopes['group:fresh-food'].n, 1);
  assert.equal(changed.byGroup['fresh-food'].n, 2);
  assert.deepEqual(changed.scopes['group:excessive-rudeness'].fnBySubtype, { 'sarcastic-rude': 1 });
  assert.deepEqual(summary.gates.checks.map(row => row.pass), [true, false, true, false, false, true, false]);
  assert.deepEqual(summary.gates.checks.map(row => row.limit), [1, 1, .5, 0, 0, 2, .5]);
  const w0 = summary.wordings.find(row => row.id === 'W0');
  assert.equal(w0.scopes.all.n, 4);
  assert.equal(w0.scopes['corpus:tone-holdout'].n, 3);
  assert.equal(w0.scopes['group:excessive-rudeness'].n, 3);
  assert.deepEqual(changed.ownerFlips.map(row => [row.postId, row.effect, row.ambiguous]), [
    ['tone-low', 'fixed', false], ['tone-sarcasm', 'broke', false], ['tone-ambiguous', 'fixed', true],
  ], 'all new-tone flips retain ambiguity and exclude regression posts');
  assert.ok(changed.ownerFlips.every(row => row.baseline.cutoff === CUTOFF && row.candidate.cutoff === CUTOFF));
  const onlyTone = { ...args, rows: rows.filter(row => row.corpus === 'tone-holdout') };
  const tonePlan = buildTonePlan(onlyTone);
  const toneSummary = analyzeTone({ ...onlyTone, plan: tonePlan, requests: complete(tonePlan) });
  for (const metric of [...toneSummary.policies, ...toneSummary.wordings, ...toneSummary.wordingPolicies]) {
    assert.equal(Object.hasOwn(metric.scopes, 'corpus:original-validation'), false);
    assert.equal(Object.hasOwn(metric.scopes, 'corpus:fresh-behaviour'), false);
  }
  assert.throws(() => analyzeTone({ ...onlyTone, plan: tonePlan, requests: complete(tonePlan),
    gates: [gate('absent scope', 'errors', 'corpus:original-validation')] }), /Missing.*scope|scope.*missing/i);
});

test('holdout wording-policy cells reuse raw scores, send transformed questions and use matching calibration priors', () => {
  const base = discoveryPolicies()[0];
  const args = { ...fixture('holdout'), wordings: ['W2'], policies: [
    base,
    { ...base, id: 'raised', cutoff: .8 },
    { ...base, id: 'short', shortRule: { maxOwnWords: 0, cutoff: .8 } },
    { ...base, id: 'templated', template: 'T2', cutoff: .6 },
    { ...base, id: 'stripped', stateTransform: 'strip-leading-mentions' },
    { ...base, id: 'calibrated', template: 'T2', calibration: 'content-free', cutoff: .6 },
  ] };
  const plan = buildTonePlan(args), refs = plan.refs.wordingPolicies;
  const empty = 'empty:excessive-rudeness', rude = 'rude:excessive-rudeness';
  for (const wordingId of ['W2', 'W0']) {
    assert.deepEqual(refs.raised[wordingId], refs.P0[wordingId]);
    assert.deepEqual(refs.short[wordingId], refs.P0[wordingId]);
    assert.deepEqual(refs.calibrated[wordingId], refs.templated[wordingId]);
    assert.notEqual(refs.templated[wordingId][rude].index, refs.P0[wordingId][rude].index);
    assert.notEqual(refs.stripped[wordingId][rude].index, refs.P0[wordingId][rude].index);
    assert.equal(plan.requests[refs.stripped[wordingId][rude].index].state, 'You are an idiot');
    assert.deepEqual(refs.stripped[wordingId][empty], { index: null, unclassified: true });
  }
  const requests = complete(plan);
  requests[refs.P0.W2[empty].index].probability = .7;
  requests[refs.P0.W2[rude].index].probability = .8;
  requests[refs.templated.W2[rude].index].probability = .2;
  requests[refs.templated.W0[rude].index].probability = .95;
  requests[refs.templated.W0[empty].index].probability = .55;
  requests[refs.stripped.W2[rude].index].probability = .35;
  for (const [wordingId, probability] of [['W2', .1], ['W0', .9]]) {
    const indices = plan.refs.priors[JSON.stringify(['T2', WORDINGS[wordingId]])];
    assert.equal(indices.length, CONTENT_FREE.length);
    assert.deepEqual(indices.map(index => plan.requests[index].state), [...CONTENT_FREE]);
    for (const index of indices) requests[index].probability = probability;
  }
  const summary = analyzeTone({ ...args, plan, requests });
  assert.equal(summary.wordingPolicies.length, args.policies.length * 2);
  assert.ok(summary.wordingPolicies.every(row => ['W2', 'W0'].includes(row.wordingId)));
  assert.ok(summary.wordingPolicies.every(row => row.n === 2 && row.ambiguousExcluded === 1 && !Object.hasOwn(row, 'optimal')));
  const cell = (policyId, wordingId = 'W2') => summary.wordingPolicies.find(row => row.policyId === policyId && row.wordingId === wordingId);
  assert.equal(cell('P0').FP, 1);
  assert.equal(cell('raised').FP, 0);
  assert.equal(cell('raised').FN, 0, 'p equal to its selected cutoff remains hidden');
  assert.equal(cell('short').FP, 0);
  assert.equal(cell('stripped').unclassified, 1);
  assert.equal(cell('stripped').FP, 0);
  assert.equal(cell('stripped').FN, 0);
  assert.equal(cell('templated').FN, 1);
  assert.deepEqual(cell('templated').fnBySubtype, { 'short-rude': 1 });
  assert.equal(cell('calibrated').FN, 0, 'W2 uses its own T2 prior rather than the W0 or T0 prior');
  for (const policy of summary.policies) {
    assert.deepEqual(cell(policy.id, 'W0').scopes.all, policy.scopes['group:excessive-rudeness']);
  }
  const calibrated = summary.policies.find(row => row.id === 'calibrated');
  assert.ok(Math.abs(calibrated.ownerFlips.find(row => row.postId === 'empty').candidate.probability - 11 / 92) < 1e-12);
});

test('short-rule grid retains compact per-candidate corpus, group and short-text error counts', () => {
  const args = fixture();
  for (const row of args.rows.filter(row => row.intentId === 'food')) row.corpus = 'original';
  const plan = buildTonePlan(args), summary = analyzeTone({ ...args, plan, requests: complete(plan) });
  const grid = summary.shortRuleGrid, zero = grid.table[0], five = grid.table[5];
  const low = grid.cutoffs.indexOf(.3), middle = grid.cutoffs.indexOf(.41), high = grid.cutoffs.indexOf(.95);
  assert.equal(zero.n, 4);
  assert.equal(zero.errors[low], 3);
  assert.equal(zero.errors[middle], 1);
  assert.equal(zero.lowContentFP[low], 2);
  assert.equal(zero.lowContentFP[middle], 0);
  assert.equal(zero.byCorpus['tone-discovery'].errors[low], 1);
  assert.equal(zero.byCorpus.original.errors[low], 2);
  assert.equal(zero.byGroup['excessive-rudeness'].errors[middle], 0);
  assert.equal(zero.byGroup['fresh-food'].errors[middle], 1);
  assert.equal(five.shortPositiveFN[high], 1);
  assert.equal(five.byGroup['excessive-rudeness'].shortPositiveFN[high], 1);
  assert.equal(five.byCorpus['tone-discovery'].missedShortRude[high], 1);
  for (const row of grid.table) {
    for (let index = 0; index < grid.cutoffs.length; index++) {
      assert.equal(row.errors[index], Object.values(row.byCorpus).reduce((sum, bucket) => sum + bucket.errors[index], 0));
      assert.equal(row.lowContentFP[index], Object.values(row.byGroup).reduce((sum, bucket) => sum + bucket.lowContentFP[index], 0));
    }
  }
  for (const best of [grid.best, ...grid.bestByMaxOwnWords]) {
    assert.equal(best.errors, Object.values(best.byCorpus).reduce((sum, bucket) => sum + bucket.errors, 0));
    assert.equal(best.errors, Object.values(best.byGroup).reduce((sum, bucket) => sum + bucket.errors, 0));
  }
});

test('short-rule grid shares owner post details and retains every cell and selected-policy flip', () => {
  const args = fixture();
  args.rows.push({ ...args.rows[0], key: 'regression:excessive-rudeness', postId: 'regression',
    text: 'Synthetic regression post', corpus: 'original-validation' });
  const plan = buildTonePlan(args), requests = complete(plan);
  requests[plan.refs.baseline['uncertain:excessive-rudeness']].probability = .4;
  const grid = analyzeTone({ ...args, plan, requests }).shortRuleGrid;
  assert.deepEqual(grid.ownerDecisions.map(row => [row.postId, row.ambiguous]), [
    ['empty', false], ['rude', false], ['uncertain', true],
  ], 'only new-tone W0 decisions enter the shared owner dictionary');
  assert.ok(grid.table.every(row => row.ownerFlips.length === grid.cutoffs.length));
  assert.ok(grid.table.every(row => row.ownerFlips.every(cell => cell.every(flip => !Object.hasOwn(flip, 'text')))));
  const resolve = flip => ({ ...grid.ownerDecisions[flip.decision], candidate: flip.candidate, effect: flip.effect });
  const zero = grid.table.find(row => row.maxOwnWords === 0);
  assert.deepEqual(zero.ownerFlips[grid.cutoffs.indexOf(.4)], []);
  assert.deepEqual(zero.ownerFlips[grid.cutoffs.indexOf(.41)].map(resolve), [{
    postId: 'empty', text: '@mira_k @other', subtype: 'low-content', gold: false, ambiguous: false,
    baseline: { probability: .4, cutoff: CUTOFF, hidden: true, unclassified: false },
    candidate: { probability: .4, cutoff: .41, hidden: false, unclassified: false }, effect: 'fixed',
  }]);
  const five = grid.table.find(row => row.maxOwnWords === 5);
  assert.deepEqual(five.ownerFlips[grid.cutoffs.indexOf(.95)].map(resolve).map(row => [row.postId, row.effect, row.ambiguous]), [
    ['empty', 'fixed', false], ['rude', 'broke', false], ['uncertain', 'fixed', true],
  ]);
  const selectedZero = grid.bestByMaxOwnWords.find(row => row.maxOwnWords === 0);
  assert.deepEqual(selectedZero.ownerFlips, [{
    ...grid.ownerDecisions[0],
    candidate: { probability: .4, cutoff: selectedZero.cutoff, hidden: false, unclassified: false }, effect: 'fixed',
  }]);
  for (const best of [grid.best, ...grid.bestByMaxOwnWords]) {
    assert.ok(Array.isArray(best.ownerFlips));
    assert.ok(best.ownerFlips.every(row => row.candidate.cutoff === best.cutoff));
    assert.ok(best.ownerFlips.every(row => row.postId !== 'regression'));
  }
  assert.ok(grid.bestByMaxOwnWords.find(row => row.maxOwnWords === 5).ownerFlips
    .some(row => row.postId === 'uncertain' && row.ambiguous));
});

function oneWordGrid(values) {
  const rows = values.map(([probability, gold], index) => ({
    key: `short-${index}`, postId: `short-${index}`, text: `word${index}`, intentId: 'excessive-rudeness',
    labelKey: 'excessive-rudeness', label: WORDINGS.W0, gold, ambiguous: false,
    subtype: 'short-rude', corpus: 'tone-discovery', group: 'excessive-rudeness', probability,
  }));
  const args = { phase: 'discovery', corpus: { split: 'discovery', twins: [] }, rows };
  const plan = buildTonePlan(args), probabilities = new Map(rows.map(row => [row.text, row.probability]));
  const requests = complete(plan).map(request => ({ ...request, probability: probabilities.get(plan.requests[request.index].state) ?? .5 }));
  return analyzeTone({ ...args, plan, requests }).shortRuleGrid;
}

test('short-rule selection splits tied grid points at intervening error changes', () => {
  const values = [[.295, false], [.301, true], [.306, false], [.315, true]];
  const grid = oneWordGrid(values), one = grid.table.find(row => row.maxOwnWords === 1);
  assert.equal(one.errors[grid.cutoffs.indexOf(.30)], 1);
  assert.equal(one.errors[grid.cutoffs.indexOf(.31)], 1);
  assert.equal(values.filter(([probability, gold]) => (probability >= .305) !== gold).length, 2);
  for (const best of grid.bestByMaxOwnWords) {
    assert.equal(best.errors, Math.min(...grid.table.find(row => row.maxOwnWords === best.maxOwnWords).errors));
  }
  assert.equal(grid.best.errors, 1);
  assert.equal(grid.best.maxOwnWords, 1);
  assert.deepEqual(grid.best.plateau, {
    lower: .306, upper: .315, lowerInclusive: false, upperInclusive: true, width: .315 - .306, points: 1,
  });
  assert.ok(Math.abs(grid.best.cutoff - .3105) < 1e-12);
  assert.equal(values.filter(([probability, gold]) => (probability >= grid.best.cutoff) !== gold).length, 1);
});

test('short-rule plateaus respect range endpoints and merge neutral tied-score changes', () => {
  const endpoint = oneWordGrid([[.3, true], [.2, false]]).bestByMaxOwnWords.find(row => row.maxOwnWords === 1);
  assert.equal(endpoint.errors, 0);
  assert.equal(endpoint.cutoff, .3);
  assert.deepEqual(endpoint.plateau, {
    lower: .3, upper: .3, lowerInclusive: true, upperInclusive: true, width: 0, points: 1,
  });
  const neutral = oneWordGrid([[.4, false], [.4, true], [.95, true]]).bestByMaxOwnWords.find(row => row.maxOwnWords === 1);
  assert.equal(neutral.errors, 1);
  assert.deepEqual(neutral.plateau, {
    lower: .3, upper: .95, lowerInclusive: true, upperInclusive: true, width: .95 - .3, points: 66,
  });
  assert.equal(neutral.cutoff, .625);
});
