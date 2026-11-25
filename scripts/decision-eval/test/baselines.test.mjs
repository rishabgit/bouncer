import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BASELINE_FILE, CASE_IDENTITY_ENCODING, caseIdentityHash, loadBaselines } from '../baselines.mjs';
import { EVAL_POSTS, expectsHide } from '../corpora/eval-corpus.ts';
import { MULTI_FILTER_CASES } from '../corpora/native-benchmark-corpus.ts';

const document = JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
const normalized = item => ({
  id: item.id, corpus: item.filters.length === 1 && item.filters[0] === 'rage bait' ? 'rage' : 'broad',
  text: item.text, filters: [...item.filters], expected: item.filters.map(filter => item.expectedMatches.includes(filter)),
});
const discovery = [
  ...EVAL_POSTS.map(item => ({ id: item.id, corpus: 'rage', text: item.text, filters: ['rage bait'], expected: [expectsHide(item)] })),
  ...MULTI_FILTER_CASES.map(normalized),
];
// These immutable inputs are read only to verify imported historical Gemma
// baseline identities. This test submits nothing to an inference runtime.
const readCases = async name => JSON.parse(await readFile(new URL(`../corpora/${name}`, import.meta.url), 'utf8')).cases.map(normalized);
const isolation = await readCases('native-isolation-holdout.json');
const migration = await readCases('native-migration-validation.json');
const all = [...discovery, ...isolation, ...migration];

async function withDocument(value, callback) {
  const scratch = new URL('../.tmp/', import.meta.url);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(new URL('baseline-test-', scratch));
  const dataFile = join(directory, 'baselines.json');
  try { await writeFile(dataFile, JSON.stringify(value)); await callback(dataFile); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('one canonical encoding binds Unicode text, ordered filters and labels', () => {
  assert.equal(document.caseIdentityEncoding, CASE_IDENTITY_ENCODING);
  assert.equal(caseIdentityHash({ id: 'example', text: 'A café post.', filters: ['one', 'two'], expected: [true, false] }),
    'e8de839ae55ac2b7968ff6f2bcf8ebf87ceb7d8206586f11381abf397f6a3cd7');
});

test('all 280 Browser baselines match exact discovery/isolation/migration identities', async () => {
  assert.equal(discovery.length, 88);
  assert.equal(isolation.length, 72);
  assert.equal(migration.length, 120);
  const baseline = await loadBaselines(all);
  assert.equal(baseline.size, 280);
  assert.equal([...baseline.values()].filter(value => typeof value === 'boolean').length, 280);
  for (const row of discovery) {
    const key = `${row.corpus}:${row.id}`;
    assert.equal(baseline.get(key), document.browserBaseline.shouldHideByCaseId[key]);
  }
  assert.equal(isolation.filter(row => baseline.get(`${row.corpus}:${row.id}`) === row.expected.some(Boolean)).length, 69);
  assert.equal(migration.filter(row => baseline.get(`${row.corpus}:${row.id}`) === row.expected.some(Boolean)).length, 118);
});

test('optional corpus hash binds one exact source document', async () => {
  const corpusHash = document.corpusSources['native-isolation-holdout.json'].sha256;
  assert.equal((await loadBaselines(isolation, { corpusHash })).size, 72);
  await assert.rejects(loadBaselines(isolation, { corpusHash: '0'.repeat(64) }), /identity or corpus hash differs/);
  await assert.rejects(loadBaselines(isolation, { corpusHash: 'not-a-hash' }), /corpus hash/);
  await assert.rejects(loadBaselines([...isolation, migration[0]], { corpusHash }), /identity or corpus hash differs/);
});

test('edited text, filter order or expected labels cannot reuse an ID', async () => {
  const row = isolation.find(item => item.filters.length === 3);
  await assert.rejects(loadBaselines([{ ...row, text: row.text + ' ' }]), /identity or corpus hash differs/);
  await assert.rejects(loadBaselines([{ ...row, filters: [...row.filters].reverse(), expected: [...row.expected].reverse() }]), /identity or corpus hash differs/);
  await assert.rejects(loadBaselines([{ ...row, expected: row.expected.map((value, index) => index ? value : !value) }]), /identity or corpus hash differs/);
});

test('missing expected baseline and duplicate cases fail instead of guessing', async () => {
  const row = isolation[0];
  await assert.rejects(loadBaselines([{ ...row, id: 'missing-baseline' }]), /Missing expected browser baseline/);
  await assert.rejects(loadBaselines([row, row]), /Duplicate baseline case/);
  const changed = structuredClone(document);
  delete changed.baselineCollections.browser.caseEvidenceById[`${row.corpus}:${row.id}`];
  await withDocument(changed, async dataFile => {
    await assert.rejects(loadBaselines([row], { dataFile }), /Missing expected browser baseline/);
  });
});

test('explicitly unavailable evidence returns null and must still match identity', async () => {
  const row = isolation[0];
  const changed = structuredClone(document);
  const entry = changed.baselineCollections.browser.caseEvidenceById[`${row.corpus}:${row.id}`];
  entry.status = 'unavailable'; entry.shouldHide = null; entry.unavailableReason = 'Synthetic test: recorded output absent.';
  await withDocument(changed, async dataFile => {
    const baseline = await loadBaselines([row], { dataFile });
    assert.equal(baseline.get(`${row.corpus}:${row.id}`), null);
    await assert.rejects(loadBaselines([{ ...row, text: 'Changed case' }], { dataFile }), /identity or corpus hash differs/);
  });
  delete entry.unavailableReason;
  await withDocument(changed, async dataFile => {
    await assert.rejects(loadBaselines([row], { dataFile }), /Invalid unavailable baseline/);
  });
});

test('native text-only QAT evidence is explicitly separate from Browser', async () => {
  const native = await loadBaselines(migration, { baseline: 'textOnlyQat' });
  const browser = await loadBaselines(migration);
  assert.equal(native.size, 120);
  assert.equal(migration.filter(row => native.get(`${row.corpus}:${row.id}`) === row.expected.some(Boolean)).length, 119);
  assert.ok(migration.some(row => native.get(`${row.corpus}:${row.id}`) !== browser.get(`${row.corpus}:${row.id}`)));
  await assert.rejects(loadBaselines(isolation, { baseline: 'textOnlyQat' }), /Missing expected textOnlyQat baseline/);
});

test('corrupt source provenance and invalid evidence status are rejected', async () => {
  const row = isolation[0];
  const key = `${row.corpus}:${row.id}`;
  const changed = structuredClone(document);
  changed.baselineCollections.browser.caseEvidenceById[key].corpusSha256 = '0'.repeat(64);
  await withDocument(changed, async dataFile => {
    await assert.rejects(loadBaselines([row], { dataFile }), /identity or corpus hash differs/);
  });
  changed.baselineCollections.browser.caseEvidenceById[key] = { ...document.baselineCollections.browser.caseEvidenceById[key], shouldHide: null };
  await withDocument(changed, async dataFile => {
    await assert.rejects(loadBaselines([row], { dataFile }), /Invalid recorded baseline decision/);
  });
});

test('committed baseline data contains no private absolute home or probability traces', async () => {
  const text = await readFile(BASELINE_FILE, 'utf8');
  assert.ok(!text.includes('/'+'Users/'));
  assert.ok(!text.includes('cx.py'));
  assert.ok(!text.includes('"probabilities"'));
});
