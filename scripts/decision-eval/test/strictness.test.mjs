import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as runtime from '../../../Bouncer/src/shared/decision-model.ts';
import { expandToneEvidence } from '../tone-label-evidence.mjs';
import { ownWords } from '../tone-label-metrics.mjs';
import { WORDINGS } from '../tone-templates.mjs';

// Re-score saved single-filter probabilities; this test performs no inference.
// Node 24 imports the runtime TypeScript directly, as in corpora.mjs, so the
// result depends on the shipped Strict rule rather than a standalone cutoff.
test('runtime Strict reproduces 3 harmless hides and 12 rude misses for the typed owner label', async t => {
  const ownerLabel = 'performative rudeness that are execessive like unnecessary usage of slurs';
  assert.equal(WORDINGS.W0, ownerLabel);
  const model = runtime.DECISION_MODEL;
  assert.equal(model.strictCutoff, 0.72);
  assert.ok(Number.isFinite(model.strictCutoff) && model.strictCutoff > model.cutoff
    && model.strictCutoff <= 1, 'the runtime must define its higher Strict cutoff');

  const evidence = expandToneEvidence(JSON.parse(await readFile(
    new URL('../../../docs/benchmarks/data/decision-tone-holdout-result.json', import.meta.url), 'utf8',
  )));
  assert.equal(evidence.phase, 'tone-label-holdout');
  assert.equal(evidence.status, 'complete');
  const rows = evidence.rows.filter(row => row.corpus === 'tone-holdout'
    && row.intentId === 'excessive-rudeness');
  assert.equal(rows.length, 112);
  const requests = new Map(evidence.requests.map(request => [request.index, request]));
  const counts = { eligible: 0, ambiguousExcluded: 0, TP: 0, FP: 0, FN: 0, TN: 0 };
  for (const row of rows) {
    assert.equal(row.label, ownerLabel);
    const index = evidence.plan.refs.baseline[row.key];
    const planned = evidence.plan.requests[index];
    const request = requests.get(index);
    assert.deepEqual(evidence.plan.questions[planned.questionKey], runtime.decisionQuestions([ownerLabel]),
      'use the exact typed label as the only filter, with the frozen runtime question');
    assert.equal(planned.state, row.text);
    assert.equal(request.postId, row.postId);
    assert.ok(Number.isFinite(request.probability) && request.probability >= 0 && request.probability <= 1);
    assert.equal(runtime.ownWords(planned.state), ownWords(planned.state));

    const decision = runtime.decideMatches([{ label: ownerLabel, score: request.probability }],
      planned.state, [ownerLabel]);
    const cutoff = Math.max(model.strictCutoff,
      ownWords(planned.state) <= model.shortRule.maxOwnWords ? model.shortRule.cutoff : model.cutoff);
    assert.equal(decision.scores[0].cutoff, cutoff);
    assert.equal(decision.scores[0].strict, true);
    assert.equal(decision.shouldHide, request.probability >= cutoff);
    assert.deepEqual(decision.matches, decision.shouldHide ? [ownerLabel] : []);
    if (row.ambiguous) { counts.ambiguousExcluded++; continue; }
    counts.eligible++;
    counts[row.gold ? decision.shouldHide ? 'TP' : 'FN' : decision.shouldHide ? 'FP' : 'TN']++;
  }
  assert.deepEqual(counts, { eligible: 109, ambiguousExcluded: 3, TP: 17, FP: 3, FN: 12, TN: 77 });
  t.diagnostic(`Strict cutoff ${model.strictCutoff}; 109 eligible owner-label decisions: 3 harmless posts hidden, 12 rude posts missed; 3 ambiguous excluded.`);
});
