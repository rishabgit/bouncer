import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CORPUS_HASHES, loadCorpora, validateSelection } from '../corpora.mjs';
import { candidateThresholds, chooseSelection, leaveOneOut, optimizeThreshold, score, scoreRows } from '../metrics.mjs';
import { questions, RAGE_DEFINITION, TEMPLATES, templateHash } from '../templates.mjs';

test('discovery imports the self-contained pinned TypeScript and exposes ordered gold', async () => {
  const result = await loadCorpora();
  assert.deepEqual(result.hashes, CORPUS_HASHES);
  assert.equal(result.cases.length, 88);
  assert.equal(result.cases.filter(row => row.corpus === 'rage').length, 40);
  assert.equal(result.cases.filter(row => row.corpus === 'broad').length, 48);
  assert(result.cases.every(row => row.expected.length === row.filters.length));
  assert(!result.cases.some(row => /holdout|migration/.test(row.id)));
  assert.equal(result.latency.posts.length, 20);
  assert.equal(new Set(result.latency.posts).size, 20);
  assert.deepEqual(result.latency.filters3, ['crypto', 'politics', 'engagement bait']);
  assert.equal(result.latency.filters10.length, 10);
  for (const [name, hash] of Object.entries(CORPUS_HASHES)) {
    const bytes = await readFile(new URL(`../corpora/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  }
});

const variant = { id: 'synthetic-variant', templateId: 'matches-category' };
const runtimeSettings = {
  runtime: 'llama', version: '0.49.0', build: 'b12652-test', effectiveContext: 4096,
  parallel: 1, batch: 512, ubatch: 128, projector: false, runner: 'llamacpp',
  quantization: 'Q8_0', aliasDefinition: null,
};
function selection() {
  return {
    schemaVersion: 2,
    frozen: true,
    variantId: variant.id,
    templateId: variant.templateId,
    templateHash: templateHash(variant.templateId),
    cutoff: 0.5,
    corpusHashes: { ...CORPUS_HASHES },
    runtimeSettings: { ...runtimeSettings },
  };
}

test('validation requires a complete frozen identity, prompt, cutoff and corpus binding', async () => {
  const hash = templateHash(variant.templateId);
  assert.equal(validateSelection(selection(), variant, CORPUS_HASHES, hash, runtimeSettings).cutoff, 0.5);
  assert.throws(() => validateSelection(undefined, variant, CORPUS_HASHES, hash), /frozen selection/);
  assert.throws(() => validateSelection({ ...selection(), frozen: false }, variant, CORPUS_HASHES, hash), /frozen selection/);
  assert.throws(() => validateSelection({ ...selection(), variantId: 'other' }, variant, CORPUS_HASHES, hash), /identity/);
  assert.throws(() => validateSelection(selection(), { ...variant, templateId: 'category-applies' }, CORPUS_HASHES, hash), /identity/);
  assert.throws(() => validateSelection({ ...selection(), templateHash: '0'.repeat(64) }, variant, CORPUS_HASHES, hash), /template hash/);
  assert.throws(() => validateSelection(selection(), variant, CORPUS_HASHES, '0'.repeat(64)), /template hash/);
  for (const cutoff of [undefined, null, '0.5', NaN, Infinity, -Infinity]) {
    assert.throws(() => validateSelection({ ...selection(), cutoff }, variant, CORPUS_HASHES, hash), /finite/);
  }
  const wrongHashes = { ...CORPUS_HASHES, 'eval-corpus.ts': '0'.repeat(64) };
  assert.throws(() => validateSelection({ ...selection(), corpusHashes: wrongHashes }, variant, CORPUS_HASHES, hash), /corpus hashes/);
  assert.throws(() => validateSelection(selection(), variant, wrongHashes, hash), /corpus hashes/);
  assert.throws(() => validateSelection({ ...selection(), corpusHashes: {} }, variant, CORPUS_HASHES, hash), /corpus hashes/);
  await assert.rejects(loadCorpora('validation'), /frozen selection/);
  await assert.rejects(loadCorpora({ split: 'validation', selection: selection(), variant, templateHash: 'wrong' }), /template hash/);
  await assert.rejects(loadCorpora('typo'), /split/);
});

test('validation binds v2 receipts to all current runtime settings before exposing cases', async () => {
  const hash = templateHash(variant.templateId);
  for (const schemaVersion of [undefined, 1, '2']) {
    assert.throws(() => validateSelection({ ...selection(), schemaVersion }, variant, CORPUS_HASHES, hash, runtimeSettings), /schemaVersion/);
  }
  assert.throws(() => validateSelection(selection(), variant, CORPUS_HASHES, hash), /runtime settings/);
  for (const field of Object.keys(runtimeSettings)) {
    const changed = { ...runtimeSettings, [field]: field === 'effectiveContext' ? 8192 : 'changed' };
    assert.throws(() => validateSelection(selection(), variant, CORPUS_HASHES, hash, changed), /runtime settings/, field);
    const missing = { ...runtimeSettings };
    delete missing[field];
    assert.throws(() => validateSelection({ ...selection(), runtimeSettings: missing }, variant, CORPUS_HASHES, hash, runtimeSettings), /runtime settings/, field);
  }
  const native = { ...runtimeSettings, runtime: 'ollama', version: '0.40.18', build: 'official-v0.40.18',
    batch: null, ubatch: null, projector: 'package-no-image-requests', runner: 'mlx',
    aliasDefinition: { definition: 'exact HTTP definition', sourceDigest: 'pinned-source' } };
  assert.doesNotThrow(() => validateSelection({ ...selection(), runtimeSettings: native }, variant, CORPUS_HASHES, hash, structuredClone(native)));
  const changedAlias = structuredClone(native);
  changedAlias.aliasDefinition.sourceDigest = 'other';
  assert.throws(() => validateSelection({ ...selection(), runtimeSettings: native }, variant, CORPUS_HASHES, hash, changedAlias), /runtime settings/);
  await assert.rejects(loadCorpora({ split: 'validation', selection: selection(), variant, templateHash: hash }), /runtime settings/);
  await assert.rejects(loadCorpora({ split: 'validation', selection: selection(), variant, templateHash: hash,
    runtimeSettings: { ...runtimeSettings, parallel: 2 } }), /runtime settings/);
});

test('the remaining two templates preserve their hashes, rage boundary and ordered question keys', () => {
  assert.deepEqual(TEMPLATES.map(item => item.id), ['matches-category', 'category-applies']);
  assert.equal(templateHash('matches-category'), '9a1e023c41c8c19c37317953ae8d7b486ec088070ce00abadd4809242eb67f54');
  assert.equal(templateHash('category-applies'), '63c1d9bc4c93b016b38f047d74585d73b08f54651031b80433da8b1f915aee3a');
  for (const template of TEMPLATES) {
    const result = questions(['rage bait', 'sports', 'outrage farming'], template.id);
    assert.deepEqual(Object.keys(result), ['f0', 'f1', 'f2']);
    assert.equal(result.f0.type, 'noul');
    assert(result.f0.instructions.includes(RAGE_DEFINITION));
    assert(result.f2.instructions.includes(RAGE_DEFINITION));
    assert(!result.f1.instructions.includes(RAGE_DEFINITION));
    assert.match(result.f1.instructions, /"sports"/);
    assert.match(templateHash(template.id), /^[a-f0-9]{64}$/);
  }
  assert.throws(() => questions(['rage bait'], 'unknown'), /Unknown/);
  assert.throws(() => questions(['rage bait'], 'filter-decision'), /Unknown/);
  assert.throws(() => questions([], TEMPLATES[0].id), /nonempty/);
});

test('score preserves production NaN ratio semantics and defined zero F1', () => {
  const empty = score([]);
  assert.equal(empty.n, 0);
  for (const ratio of ['accuracy', 'precision', 'recall', 'f1', 'specificity', 'falsePositiveRate']) {
    assert(Number.isNaN(empty[ratio]));
  }
  const nothingHidden = score([{ expected: false, predicted: false }]);
  assert.equal(nothingHidden.accuracy, 1);
  assert(Number.isNaN(nothingHidden.precision));
  assert(Number.isNaN(nothingHidden.recall));
  assert(Number.isNaN(nothingHidden.f1));
  assert.equal(score([{ expected: true, predicted: false }, { expected: false, predicted: true }]).f1, 0);
});

test('scores count hide decisions, exact ordered vectors and baseline-correct show regressions separately', () => {
  const rows = [
    { id: 'safe', corpus: 'rage', expected: [false], probabilities: [0.5] },
    { id: 'miss', corpus: 'rage', expected: [true], probabilities: [0.2] },
    { id: 'wrong-category', corpus: 'broad', expected: [true, false], probabilities: [0.1, 0.9] },
    { id: 'already-wrong', corpus: 'broad', expected: [false, false], probabilities: [0.8, 0.7] },
    { id: 'missing-baseline', corpus: 'broad', expected: [false], probabilities: [0.9] },
  ];
  const baseline = { 'rage:safe': false, 'rage:miss': true, 'broad:wrong-category': true,
    'broad:already-wrong': true, 'broad:missing-baseline': false };
  const result = scoreRows(rows, 0.5, baseline);
  assert.deepEqual([result.all.hide.tp, result.all.hide.fp, result.all.hide.fn, result.all.hide.tn], [1, 3, 1, 0]);
  assert.equal(result.all.exactVectors, 0);
  assert.equal(result.all.totalVectors, 5);
  assert.equal(result.all.individualDecisions, 7);
  assert.equal(result.all.falseHides, 3);
  assert.equal(result.all.missedHides, 1);
  assert.equal(result.all.pairedAvailable, true);
  assert.equal(result.all.newFalseHides, 2);
  assert.deepEqual(result.all.newFalseHideIds, ['rage:safe', 'broad:missing-baseline']);
  assert.equal(result.all.newMissedHides, 1);
  assert.deepEqual(result.all.newMissedHideIds, ['rage:miss']);
  assert.deepEqual(result.all.missedHideIds, ['rage:miss']);
  assert.equal(result.broad.hide.tp, 1); // wrong category, but the right post hide
  assert.equal(result.rage.totalVectors, 2);
  assert.deepEqual(scoreRows(rows, 0.5, new Map(Object.entries(baseline))), result);
});

test('missing baseline values fail on correct cases too; explicit null marks paired metrics unavailable', () => {
  const rows = [
    { id: 'known', corpus: 'rage', expected: [true], probabilities: [0.1] },
    { id: 'unavailable', corpus: 'broad', expected: [false], probabilities: [0.9] },
  ];
  assert.throws(() => scoreRows(rows, 0.5), /Baseline map is required/);
  assert.throws(() => scoreRows(rows, 0.5, { 'rage:known': true }), /Missing baseline key/);
  assert.throws(() => scoreRows(rows, 0.5, { 'rage:known': undefined, 'broad:unavailable': false }), /baseline value/);
  assert.throws(() => scoreRows([{ ...rows[0], probabilities: [0.9] }], 0.5, {}), /Missing baseline key/);
  const result = scoreRows(rows, 0.5, { 'rage:known': true, 'broad:unavailable': null });
  assert.equal(result.rage.pairedAvailable, true);
  assert.equal(result.rage.newMissedHides, 1);
  for (const group of [result.broad, result.all]) {
    assert.equal(group.pairedAvailable, false);
    assert.equal(group.newFalseHides, null);
    assert.equal(group.newMissedHides, null);
    assert.equal(group.newFalseHideIds, null);
    assert.equal(group.newMissedHideIds, null);
  }
  assert.equal(scoreRows(rows, 0.5, null).all.pairedAvailable, false);
});

test('p>=cutoff respects endpoint zero and cannot make p=1 negative within [0,1]', () => {
  const rows = [{ id: 'safe', corpus: 'rage', expected: [false], probabilities: [1] }];
  assert.equal(scoreRows(rows, 1, null).all.falseHides, 1);
  const result = optimizeThreshold(rows);
  assert.equal(result.cutoff, 0.5);
  assert.equal(result.scores.all.exactVectors, 0);
  assert.equal(result.scores.all.falseHides, 1);
  assert(candidateThresholds(rows).every(cutoff => cutoff <= 1));
  const allNo = optimizeThreshold([{ ...rows[0], probabilities: [0.8] }]);
  assert.equal(allNo.cutoff, 0.9);
  assert.equal(allNo.scores.all.falseHides, 0);
  const zero = optimizeThreshold([{ id: 'hide', corpus: 'rage', expected: [true], probabilities: [0] }]);
  assert.equal(zero.cutoff, 0);
  assert.deepEqual(zero.interval, { lower: 0, upper: 0, width: 0, lowerInclusive: true, upperInclusive: true });
});

test('global optimization prioritizes exact vectors then false hides across both corpora', () => {
  const rows = [
    { id: 'one', corpus: 'rage', expected: [true, false], probabilities: [0.9, 0.7] },
    { id: 'two', corpus: 'broad', expected: [true, false], probabilities: [0.9, 0.7] },
    { id: 'safe', corpus: 'broad', expected: [false, false], probabilities: [0.95, 0.2] },
  ];
  const result = optimizeThreshold(rows);
  assert.equal(result.scores.all.exactVectors, 2);
  assert.equal(result.scores.all.falseHides, 1);
  assert(result.cutoff > 0.7 && result.cutoff <= 0.9);
  const tied = optimizeThreshold([
    { id: 'hide', corpus: 'rage', expected: [true], probabilities: [0.8] },
    { id: 'show', corpus: 'broad', expected: [false], probabilities: [0.9] },
  ]);
  assert.equal(tied.scores.all.exactVectors, 1);
  assert.equal(tied.scores.all.falseHides, 0);
  assert(tied.cutoff > 0.9);
  assert.equal(optimizeThreshold([]).cutoff, 0.5);
  assert.equal(optimizeThreshold([{ id: 'easy', corpus: 'rage', expected: [true], probabilities: [0.9] }]).cutoff, 0.45);
});

test('midpoints prefer wide contiguous optima and merge adjacent equally optimal intervals', () => {
  const rows = [
    { id: 'wide', corpus: 'rage', expected: [true, false], probabilities: [0.45, 0.05] },
    { id: 'near-half', corpus: 'broad', expected: [true, false], probabilities: [0.6, 0.5] },
  ];
  const result = optimizeThreshold(rows);
  assert.equal(result.cutoff, 0.25);
  assert.deepEqual(result.interval, { lower: 0.05, upper: 0.45, width: 0.4, lowerInclusive: false, upperInclusive: true });
  const merged = optimizeThreshold([
    { ...rows[0], probabilities: [0.5, 0.1] },
    { ...rows[1], probabilities: [0.9, 0.5] },
  ]);
  assert.equal(merged.cutoff, 0.5);
  assert.deepEqual(merged.interval, { lower: 0.1, upper: 0.9, width: 0.8, lowerInclusive: false, upperInclusive: true });
});

test('threshold candidates cover representable vectors and make adjacent-double optima explicit points', () => {
  const probabilities = [0, Number.MIN_VALUE, 0.3, 0.5, 1];
  const rows = [{ id: 'all', corpus: 'broad', expected: probabilities.map(() => false), probabilities }];
  const vectors = new Set(candidateThresholds(rows).map(cutoff => probabilities.map(p => Number(p >= cutoff)).join('')));
  assert.equal(vectors.size, probabilities.length);
  assert(vectors.has('11111'));
  assert(!vectors.has('00000')); // p=1 remains YES at the largest allowed cutoff.
  const adjacent = optimizeThreshold([{ id: 'tiny', corpus: 'rage', expected: [false, true], probabilities: [0, Number.MIN_VALUE] }]);
  assert.equal(adjacent.cutoff, Number.MIN_VALUE);
  assert.deepEqual(adjacent.interval, { lower: Number.MIN_VALUE, upper: Number.MIN_VALUE, width: 0,
    lowerInclusive: true, upperInclusive: true });
});

test('selection refits template and cutoff; leave-one-out removes the entire held-out case', () => {
  const templates = [
    { id: 'first', rows: [
      { id: 'held', corpus: 'rage', expected: [true, false], probabilities: [0.99, 0.1] },
      { id: 'show', corpus: 'broad', expected: [false], probabilities: [0.2] },
      { id: 'hide', corpus: 'broad', expected: [true], probabilities: [0.8] },
    ] },
    { id: 'second', rows: [
      { id: 'held', corpus: 'rage', expected: [true, false], probabilities: [0.01, 0.02] },
      { id: 'show', corpus: 'broad', expected: [false], probabilities: [0.1] },
      { id: 'hide', corpus: 'broad', expected: [true], probabilities: [0.9] },
    ] },
  ];
  const baseline = { 'rage:held': true, 'broad:show': false, 'broad:hide': true };
  assert.equal(chooseSelection(templates, baseline).templateId, 'first');
  const loo = leaveOneOut(templates, baseline);
  assert.equal(loo.totalVectors, 3);
  assert.equal(loo.rows[0].templateId, 'second');
  assert.equal(loo.rows[0].cutoff, 0.5);
  assert.deepEqual(loo.rows[0].predicted, [false, false]);
  assert.equal(loo.rows[0].trainingExactVectors, 2);
  assert.equal(loo.newMissedHides, loo.scores.all.newMissedHides);
  assert(loo.newMissedHideIds.includes('rage:held'));
  const changed = structuredClone(templates);
  changed[0].rows[0].probabilities = [0, 1];
  changed[1].rows[0].probabilities = [1, 0];
  const changedFold = leaveOneOut(changed, baseline).rows[0];
  assert.equal(changedFold.templateId, loo.rows[0].templateId);
  assert.equal(changedFold.cutoff, loo.rows[0].cutoff);
  assert.deepEqual(changedFold.interval, loo.rows[0].interval);
  const exactTie = [{ id: 'declared-first', rows: templates[0].rows }, { id: 'declared-second', rows: templates[0].rows }];
  assert.equal(chooseSelection(exactTie, baseline).templateId, 'declared-first');
  assert.throws(() => chooseSelection(templates), /Baseline map/);
  assert.throws(() => leaveOneOut(templates, { 'rage:held': true }), /Missing baseline key/);
  assert.throws(() => chooseSelection([{ ...templates[0] }, { id: 'other', rows: [...templates[1].rows].reverse() }], baseline), /ordered case identities/);
});

test('invalid incomplete probability vectors fail instead of silently scoring', () => {
  const valid = { id: 'one', corpus: 'rage', expected: [true], probabilities: [0.5] };
  for (const probabilities of [[], [NaN], [Infinity], [-0.1], [1.1], ['0.5']]) {
    assert.throws(() => scoreRows([{ ...valid, probabilities }], 0.5, null), /Invalid/);
  }
  assert.throws(() => scoreRows([valid, valid], 0.5, null), /Invalid/);
  assert.throws(() => scoreRows([valid], NaN, null), /finite/);
});
