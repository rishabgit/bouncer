import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { INTENTS, probeQuestionSpec, loadProbeCases, buildProbeRequests, analyzeProbe } from '../wording-probe.mjs';
import { questions, RAGE_DEFINITION } from '../templates.mjs';

test('rage probe variants explicitly separate label wording from the production definition', () => {
  for (const variant of ['D', 'Rdef']) {
    const spec = probeQuestionSpec(['rage bait'], variant);
    assert.equal(spec.labels[0], 'rage bait'); assert.equal(spec.appendDefinition[0], true);
    assert.equal(spec.questions.f0.instructions, questions(['rage bait'], 'matches-category').f0.instructions);
  }
  for (const [variant, label] of [['K1', 'ragebait'], ['K2', 'rage bait']]) {
    const spec = probeQuestionSpec(['rage bait'], variant);
    assert.equal(spec.labels[0], label); assert.equal(spec.appendDefinition[0], false);
    assert.ok(!spec.questions.f0.instructions.includes(RAGE_DEFINITION));
  }
  assert.throws(() => probeQuestionSpec(['unknown'], 'K1'), /Unknown intent/);
  assert.throws(() => probeQuestionSpec(['food and cooking'], 'Rdef'), /rage-only/);
});

test('wording plan covers all 940 gold decisions in singles and every multi-filter case twice', async () => {
  const selection = JSON.parse(await readFile(new URL('../../../docs/benchmarks/data/decision-1b-selection-llama-d1-2b-q8.json', import.meta.url)));
  const cases = await loadProbeCases(selection), plan = buildProbeRequests(cases);
  assert.equal(cases.length, 280); assert.equal(cases.reduce((n, c) => n + c.filters.length, 0), 940);
  assert.equal(plan.length, 3525); assert.deepEqual(plan, buildProbeRequests(cases));
  for (const variant of ['D', 'K1', 'K2']) assert.equal(plan.filter(r => r.mode === 'single' && r.variant === variant).length, 940);
  assert.equal(plan.filter(r => r.variant === 'Rdef').length, 104); assert.equal(plan.filter(r => r.variant === 'X').length, 337);
  for (const variant of ['D', 'K1']) assert.equal(plan.filter(r => r.mode === 'multi' && r.variant === variant).length, 132);
  assert.equal(new Set(plan.map(r => JSON.stringify([r.mode, r.variant, r.caseKey, r.intents]))).size, plan.length);
  for (const r of plan) assert.equal(Object.keys(r.questions).length, r.intents.length);
  for (const c of cases) assert.ok(c.filters.every(f => INTENTS.some(i => i.D === f)));
});

test('probe analysis pairs the matching D subset and compares alone/multi without duplicating request timings', () => {
  const intents = [INTENTS[0].D, INTENTS[1].D];
  const cases = [{ key: 'case', corpus: 'discovery', text: 'Synthetic post', filters: intents, expected: [true, false] }];
  const request = (mode, variant, targets, probabilities) => ({ mode, variant, intents: targets, probabilities,
    labels: probeQuestionSpec(targets, variant).labels, caseKey: 'case', wallMs: 10, usage: { input_tokens: 50 } });
  const raw = { status: 'complete', phase: 'exploratory-label-wording', cutoff: .3, counts: { decisions: 2 }, cases, requests: [
    request('single', 'D', [intents[0]], [.9]), request('single', 'D', [intents[1]], [.1]),
    request('single', 'K1', [intents[0]], [.2]), request('single', 'K1', [intents[1]], [.8]),
    request('single', 'K2', [intents[0]], [.7]), request('single', 'K2', [intents[1]], [.2]),
    request('single', 'X', [intents[0]], [.8]),
    request('multi', 'D', intents, [.8, .4]), request('multi', 'K1', intents, [.4, .7]),
  ] };
  const summary = analyzeProbe(raw);
  const pooled = summary.paired.find(r => r.variant === 'K1' && r.intent === 'all' && r.corpus === 'all');
  assert.equal(pooled.errorDifference, 2); assert.equal(pooled.aucDifference, -1); assert.equal(pooled.mcnemar.dCorrectKWrong, 2);
  assert.equal(summary.flips.rows.length, 2); assert.ok(summary.flips.rows.every(r => r.text === 'Synthetic post'));
  const x = summary.paired.find(r => r.variant === 'X' && r.intent === 'all' && r.corpus === 'all');
  assert.equal(x.n, 1); assert.equal(x.aucDifference, null); assert.equal(x.errorDifference, 0);
  const d = summary.interference.find(r => r.style === 'D' && r.intent === 'all' && r.corpus === 'all');
  assert.equal(d.n, 2); assert.equal(d.flips, 1); assert.ok(Math.abs(d.worstAbsDelta - .3) < 1e-12);
  assert.equal(summary.requestStats.find(r => r.variant === 'D' && r.mode === 'multi' && r.intent === 'all' && r.corpus === 'all').n, 1);
});
