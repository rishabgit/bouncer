import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { capacityLabels, capacityFreshPlan, analyzeCapacityFresh, sentenceRecommendation, capacityProductRule } from '../capacity-analysis.mjs';
import { loadFreshCorpus } from '../guidance-fresh.mjs';
import { questions } from '../templates.mjs';
import { checkCapacityRegistration, makeCapacityRegistration, CAPACITY_RULE } from '../capacity.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('capacity descriptions retain the full rubric and append exactly the first Keep sentence mechanically', async () => {
  const corpus = await loadFreshCorpus(), before = clone(corpus), labels = capacityLabels(corpus);
  for (const [index, intent] of corpus.intents.entries()) {
    assert.equal(labels[index].rubric, intent.rubric);
    assert.equal(labels[index].sentence, `${intent.labels.guided}. ${intent.rubric.match(/\bKeep\b[^.!?]*(?:[.!?]|$)/)[0]}`);
  }
  assert.deepEqual(corpus, before);
  const synthetic = { intents: [{ id: 'x', rubric: 'Hide X. Keep A. Keep B.', labels: { guided: 'guided X.' } }] };
  assert.equal(capacityLabels(synthetic)[0].sentence, 'guided X. Keep A.');
  assert.throws(() => capacityLabels({ intents: [{ id: 'x', rubric: 'Hide X.', labels: {} }] }), /No Keep sentence/);
});

test('new capacity styles cover the requested single/six-filter matrix using each frozen template', async () => {
  const corpus = await loadFreshCorpus();
  for (const template of ['matches-category', 'category-applies']) {
    const partA = capacityFreshPlan(corpus, ['sentence', 'rubric'], template), larger = capacityFreshPlan(corpus, ['short', 'guided', 'rubric'], template);
    assert.equal(partA.length, 1176); assert.equal(larger.length, 1764); assert.deepEqual(partA, capacityFreshPlan(corpus, ['sentence', 'rubric'], template));
    for (const r of [...partA, ...larger]) assert.deepEqual(r.questions, questions(r.labels, template));
    assert.equal(new Set(larger.map(r => JSON.stringify([r.mode, r.style, r.postId, r.intentIds]))).size, 1764);
  }
});

test('generic matrix preserves guidance scoring populations and accepts historical guided requests without rerunning', async () => {
  const corpus = await loadFreshCorpus();
  const historical = JSON.parse(await readFile(new URL('../../../docs/benchmarks/data/decision-guidance-fresh-result.json', import.meta.url)));
  const source = JSON.parse(await readFile(new URL('../../../docs/benchmarks/data/decision-guidance-fresh-summary.json', import.meta.url)));
  const matrix = analyzeCapacityFresh(corpus, historical.requests, ['short', 'guided', 'guidedExclusion'], 'matches-category', historical.registration.cutoff);
  for (const name of ['metrics', 'requestStats', 'interference', 'interferenceFlips', 'bounced']) assert.deepEqual(matrix[name], source[name]);
  const incomplete = historical.requests.slice(1); assert.throws(() => analyzeCapacityFresh(corpus, incomplete, matrix.styles, 'matches-category', matrix.cutoff), /Incomplete/);
  const duplicate = [...historical.requests]; duplicate[0] = duplicate[1]; assert.throws(() => analyzeCapacityFresh(corpus, duplicate, matrix.styles, 'matches-category', matrix.cutoff), /duplicate/);
});

test('capacity product gate requires all three predeclared thresholds, including equality and both original corpora', () => {
  const validation = [{ corpus: 'isolation', pass: true }, { corpus: 'migration', pass: true }];
  assert.equal(capacityProductRule(33, validation, 250).worthSwitching, true);
  assert.equal(capacityProductRule(34, validation, 250).checks.freshGuidedErrors.pass, false);
  assert.equal(capacityProductRule(33, validation, 250.01).checks.warm10MedianMs.pass, false);
  assert.equal(capacityProductRule(0, [{ ...validation[0], pass: false }, validation[1]], 10).worthSwitching, false);
  assert.throws(() => capacityProductRule(0, [], 10), /Both original/);
  assert.throws(() => capacityProductRule(0, [validation[0], validation[0]], 10), /Both original/);
});

test('sentence recommendation requires fewer errors and no near-miss false-hide increase', () => {
  const matrix = { metrics: [{ mode: 'single', intentId: 'all', style: 'guided', errors: 66, nearMissFalseHides: 18 },
    { mode: 'single', intentId: 'all', style: 'sentence', errors: 65, nearMissFalseHides: 18 }] };
  assert.equal(sentenceRecommendation(matrix).supported, true);
  const tie = clone(matrix); tie.metrics[1].errors = 66; assert.equal(sentenceRecommendation(tie).supported, false);
  const unsafe = clone(matrix); unsafe.metrics[1].nearMissFalseHides = 19; assert.equal(sentenceRecommendation(unsafe).supported, false);
});

test('capacity preregistration fixes models, labels, corpus, baseline and all policy before any inference', async () => {
  const expected = await makeCapacityRegistration();
  const result = { schemaVersion: 1, phase: 'decision-capacity', status: 'registered', registeredAt: new Date().toISOString(), registration: expected, registrationSha256: hash(expected) };
  assert.doesNotThrow(() => checkCapacityRegistration(result, expected));
  assert.equal(expected.rule.switch.freshGuidedErrorsMax, 33); assert.equal(expected.rule.switch.warm10MedianMsMax, 250);
  assert.deepEqual(expected.partA.styles, ['sentence', 'rubric']); assert.deepEqual(expected.partB.styles, ['short', 'guided', 'rubric']);
  assert.deepEqual(expected.rule, CAPACITY_RULE);
  for (const status of ['running', 'complete', 'failed']) assert.throws(() => checkCapacityRegistration({ ...result, status }, expected), /already attempted/);
  for (const change of [r => { r.rule.switch.freshGuidedErrorsMax = 34; }, r => { r.partA.cutoff = .5; }, r => { r.models.pop(); },
    r => { r.corpora.fresh.sha256 = '0'.repeat(64); }, r => { r.d1Baseline.guidedErrors = 67; }]) {
    const changed = clone(result); change(changed.registration); changed.registrationSha256 = hash(changed.registration);
    assert.throws(() => checkCapacityRegistration(changed, expected), /binding differs/);
  }
});
