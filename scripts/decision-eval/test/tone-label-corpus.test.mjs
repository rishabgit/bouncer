import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildToneCorpora, writeToneCorpora, loadToneCorpus, validateToneCorpus, toneRows, toneCounts,
  toneHash, CORPUS_FILES, AUDIT_FILE } from '../tone-label-corpus.mjs';
import { WORDINGS } from '../tone-templates.mjs';

const names = ['discovery', 'holdout', 'labeler1', 'labeler2', 'rubrics'];
const inputPaths = Object.fromEntries(names.map(name => [name, new URL(`./fixtures/tone-label/${name}.json`, import.meta.url)]));
const fixtures = await Promise.all(names.map(async name => JSON.parse(await readFile(inputPaths[name], 'utf8'))));
const fresh = () => structuredClone(fixtures);
const build = inputs => buildToneCorpora(...inputs);
const setAnswer = (labeler, postId, intentId, response) => {
  const post = labeler.posts.find(post => post.id === postId);
  post.yes = post.yes.filter(id => id !== intentId);
  post.borderline = post.borderline.filter(id => id !== intentId);
  if (response !== 'no') post[response === 'yes' ? 'yes' : 'borderline'].push(intentId);
};
async function temporary(run) {
  const path = await mkdtemp(join(tmpdir(), 'tone-label-corpus-'));
  try { await run(pathToFileURL(`${path}/`)); }
  finally { await rm(path, { recursive: true, force: true }); }
}

test('pure build retains author gold, fixed wordings, diagnostic twins, raw answers and derivable counts', () => {
  const inputs = fresh(), before = structuredClone(inputs), result = build(inputs);
  assert.deepEqual(inputs, before);
  assert.deepEqual(result, build(inputs));
  for (const split of ['discovery', 'holdout']) {
    const corpus = result[split];
    assert.equal(validateToneCorpus(corpus, split), corpus);
    assert.equal(corpus.posts.length, 18);
    assert.equal(corpus.intents.length, 18);
    assert.deepEqual(corpus.counts, toneCounts(corpus));
    assert.equal(corpus.counts.pairs, 324);
    assert.equal(corpus.counts.ambiguousPairs, 0);
    assert.equal(corpus.counts.positivePairs, 9);
    assert.equal(corpus.counts.twins, 1);
    assert.deepEqual(corpus.intents.find(intent => intent.id === 'excessive-rudeness').labels, WORDINGS);
    assert.deepEqual(corpus.twins, inputs[split === 'discovery' ? 0 : 1].twins);
    const rows = toneRows(corpus);
    assert.equal(rows.length, 324);
    assert.equal(new Set(rows.map(row => row.key)).size, 324);
    for (const row of rows) {
      assert.equal(row.gold, row.intentId === row.authoredFor && corpus.posts.find(post => post.id === row.postId).ownIntentGold);
      assert.equal(row.corpus, `tone-${split}`);
      assert.equal(row.labelKey, row.intentId);
      assert.ok(row.part && row.subtype && row.kind);
      if (row.intentId === 'excessive-rudeness') { assert.equal(row.label, WORDINGS.W0); assert.equal(row.group, 'excessive-rudeness'); }
      else { assert.equal(row.label, corpus.intents.find(intent => intent.id === row.intentId).label); assert.equal(row.group, row.intentId.startsWith('fresh-') ? 'fresh-*' : 'orig-*'); }
    }
  }
  assert.deepEqual(result.audit.labelers, inputs.slice(2, 4));
  assert.equal(result.audit.agreement.allPairs.total, 648);
  assert.equal(result.audit.agreement.allPairs.agreed, 648);
  assert.deepEqual(result.audit.ambiguous, []);
  for (const agreement of result.audit.agreement.ownIntent) assert.deepEqual(
    [agreement.total, agreement.agreed, agreement.disagreed, agreement.borderline], [36, 36, 0, 0]);
  assert.deepEqual(build([inputs[0], inputs[1], inputs[2], inputs[3], inputs[4].intents]), result);
});

test('every own-gold yes/no/borderline combination follows authored gold and both-labeler agreement', () => {
  for (const gold of [false, true]) for (const left of ['yes', 'no', 'borderline']) for (const right of ['yes', 'no', 'borderline']) {
    const inputs = fresh(), post = inputs[0].posts[0];
    post.ownIntentGold = gold;
    setAnswer(inputs[2], post.id, post.authoredFor, left);
    setAnswer(inputs[3], post.id, post.authoredFor, right);
    const result = build(inputs), actual = result.discovery.posts[0];
    const ambiguous = [left, right].some(answer => answer === 'borderline' || (answer === 'yes') !== gold);
    assert.equal(actual.gold[post.authoredFor], gold, `${gold}/${left}/${right}`);
    assert.equal(actual.ambiguousFor.includes(post.authoredFor), ambiguous, `${gold}/${left}/${right}`);
    assert.equal(result.audit.ambiguous.some(pair => pair.postId === post.id && pair.intentId === post.authoredFor), ambiguous);
    const matrix = result.audit.agreement.allPairs.splits.find(count => count.split === 'discovery').matrix;
    assert.ok(matrix[left][right] >= 1);
    for (const [index, response] of [left, right].entries()) {
      const count = result.audit.agreement.ownIntent[index];
      assert.equal(count.agreed, 35 + Number(response !== 'borderline' && (response === 'yes') === gold));
      assert.equal(count.borderline, Number(response === 'borderline'));
      assert.equal(count.disagreed, Number(response !== 'borderline' && (response === 'yes') !== gold));
    }
  }
});

test('every cross-intent combination keeps negative gold and excludes either yes or borderline', () => {
  for (const left of ['yes', 'no', 'borderline']) for (const right of ['yes', 'no', 'borderline']) {
    const inputs = fresh(), post = inputs[0].posts[0], other = inputs[0].posts[1].authoredFor;
    setAnswer(inputs[2], post.id, other, left);
    setAnswer(inputs[3], post.id, other, right);
    const result = build(inputs), actual = result.discovery.posts[0];
    assert.equal(actual.gold[other], false);
    assert.equal(actual.ambiguousFor.includes(other), left !== 'no' || right !== 'no');
    const entry = result.audit.ambiguous.find(pair => pair.postId === post.id && pair.intentId === other);
    if (entry) assert.deepEqual(entry, { split: 'discovery', postId: post.id, intentId: other, ownIntent: false, gold: false, answers: [left, right] });
  }
});

test('build rejects malformed authored files, rubrics, labeler coverage and answers', () => {
  const invalid = [
    inputs => { inputs[0].split = 'holdout'; },
    inputs => { inputs[0].posts = []; },
    inputs => { inputs[1].author = ''; },
    inputs => { inputs[0].posts[0].text = ' '; },
    inputs => { delete inputs[0].posts[0].part; },
    inputs => { delete inputs[0].posts[0].subtype; },
    inputs => { inputs[0].posts[0].ownIntentGold = 1; },
    inputs => { inputs[0].posts[0].authoredFor = 'unknown'; },
    inputs => { inputs[0].posts[0].kind = ''; },
    inputs => { inputs[0].posts[1].id = inputs[0].posts[0].id; },
    inputs => { inputs[0].posts.pop(); },
    inputs => { inputs[1].posts[0].id = inputs[0].posts[0].id; },
    inputs => { inputs[0].twins[0].sourceId = 'unknown'; },
    inputs => { inputs[0].twins[0].sourceId = inputs[1].posts[0].id; },
    inputs => { inputs[0].twins[0].id = inputs[0].posts[0].id; },
    inputs => { inputs[0].twins.push(structuredClone(inputs[0].twins[0])); },
    inputs => { inputs[1].twins[0].id = inputs[0].twins[0].id; },
    inputs => { inputs[0].twins[0].text = ''; },
    inputs => { inputs[4].intents.pop(); },
    inputs => { inputs[4].intents[1].id = inputs[4].intents[0].id; },
    inputs => { inputs[4].intents[1].id = 'other'; },
    inputs => { inputs[4].intents[0].id = 'fresh-extra'; },
    inputs => { delete inputs[4].intents[1].label; },
    inputs => { delete inputs[4].intents[1].source; },
    inputs => { delete inputs[4].intents[1].rubric; },
    inputs => { inputs[2].labeler = inputs[3].labeler; },
    inputs => { inputs[2].posts.pop(); },
    inputs => { inputs[2].posts[0].id = 'unknown'; },
    inputs => { inputs[2].posts[1].id = inputs[2].posts[0].id; },
    inputs => { inputs[2].posts[0].yes.push('unknown'); },
    inputs => { inputs[2].posts[0].yes.push(inputs[2].posts[0].yes[0]); },
    inputs => { inputs[2].posts[0].borderline.push(inputs[2].posts[0].yes[0]); },
    inputs => { inputs[2].posts[0].borderline = ['unknown']; },
    inputs => { inputs[2].posts[0].borderline = [inputs[0].posts[1].authoredFor, inputs[0].posts[1].authoredFor]; },
    inputs => { delete inputs[2].posts[0].borderline; },
  ];
  for (const mutate of invalid) { const inputs = fresh(); mutate(inputs); assert.throws(() => build(inputs)); }
});

test('validation rejects changed counts, own/cross gold, ambiguity and wordings', () => {
  const mutations = [
    corpus => { corpus.counts.posts++; },
    corpus => { corpus.counts.byPart.tone++; },
    corpus => { corpus.posts[0].gold[corpus.posts[0].authoredFor] = false; },
    corpus => { corpus.posts[0].gold[corpus.posts[1].authoredFor] = true; },
    corpus => { corpus.posts[0].gold.unknown = false; },
    corpus => { corpus.posts[0].ambiguousFor = ['unknown']; },
    corpus => { corpus.posts[0].ambiguousFor = [corpus.posts[0].authoredFor, corpus.posts[0].authoredFor]; },
    corpus => { corpus.intents.find(intent => intent.id === 'excessive-rudeness').labels.W0 = 'changed'; },
    corpus => { corpus.corpusId = 'changed'; },
  ];
  for (const mutate of mutations) { const corpus = build(fresh()).discovery; mutate(corpus); assert.throws(() => validateToneCorpus(corpus, 'discovery')); }
  assert.throws(() => validateToneCorpus(build(fresh()).holdout, 'discovery'));
});

test('redaction-sensitive authored text, rubrics and labeler metadata cannot silently change bindings', () => {
  for (const mutate of [
    inputs => { inputs[0].posts[0].text = `Synthetic path ${homedir()}/private`; },
    inputs => { inputs[0].twins[0].text = 'Synthetic /Users/somebody/private path'; },
    inputs => { inputs[4].intents[1].rubric = 'Synthetic /Users/somebody/private path'; },
    inputs => { inputs[2].labeler = `${homedir()}/labeler`; },
  ]) { const inputs = fresh(); mutate(inputs); assert.throws(() => build(inputs), /requires redaction/); }
});

test('writing and selected-split loading produce deterministic public hashes and bound audit', async () => {
  await temporary(async root => {
    const written = await writeToneCorpora(inputPaths, { root });
    assert.deepEqual(Object.keys(written), ['corpora', 'counts']);
    const audit = JSON.parse(await readFile(new URL(`docs/benchmarks/data/${AUDIT_FILE}`, root)));
    assert.deepEqual(audit.corpora, written.corpora);
    for (const split of ['discovery', 'holdout']) {
      const bytes = await readFile(new URL(CORPUS_FILES[split], root));
      assert.equal(toneHash(bytes), written.corpora[split].sha256);
      assert.equal(written.corpora[split].file, CORPUS_FILES[split]);
      assert.deepEqual(await loadToneCorpus(split, { root, expectedHash: written.corpora[split].sha256 }), build(fresh())[split]);
    }
    await temporary(async otherRoot => {
      const repeated = await writeToneCorpora(inputPaths, { root: otherRoot });
      assert.deepEqual(repeated, written);
      assert.deepEqual(await readFile(new URL(`docs/benchmarks/data/${AUDIT_FILE}`, otherRoot)), await readFile(new URL(`docs/benchmarks/data/${AUDIT_FILE}`, root)));
    });
    await assert.rejects(writeToneCorpora(inputPaths, { root }), /EEXIST/);
    assert.deepEqual(JSON.parse(await readFile(new URL(`docs/benchmarks/data/${AUDIT_FILE}`, root))), audit);
    await assert.rejects(loadToneCorpus('discovery', { root, expectedHash: '0'.repeat(64) }), /SHA-256 differs/);
  });
});

test('discovery loading reads only discovery, invalid splits read nothing, and hashes precede JSON parsing', async () => {
  const result = build(fresh()), bytes = Buffer.from(JSON.stringify(result.discovery)), reads = [];
  const read = async file => {
    reads.push(file.href);
    assert.ok(file.href.endsWith(CORPUS_FILES.discovery));
    assert.ok(!file.href.includes('holdout'));
    return bytes;
  };
  assert.deepEqual(await loadToneCorpus('discovery', { read, expectedHash: toneHash(bytes) }), result.discovery);
  assert.equal(reads.length, 1);
  for (const split of ['other', '', undefined, '../holdout']) await assert.rejects(loadToneCorpus(split, { read }), /split/);
  assert.equal(reads.length, 1);
  await assert.rejects(loadToneCorpus('discovery', { read, expectedHash: 'invalid' }), /expected tone corpus SHA/);
  assert.equal(reads.length, 1);
  await assert.rejects(loadToneCorpus('discovery', { read: async () => Buffer.from('{invalid'), expectedHash: '0'.repeat(64) }), /SHA-256 differs/);
  await assert.rejects(loadToneCorpus('discovery', { read: async () => Buffer.from(JSON.stringify(result.holdout)) }), /identity/);
});

test('failed exclusive creation removes only the newly created files', async () => {
  await temporary(async root => {
    const audit = new URL(`docs/benchmarks/data/${AUDIT_FILE}`, root);
    await mkdir(new URL('docs/benchmarks/data/', root), { recursive: true });
    await writeFile(audit, 'pre-existing audit\n');
    await assert.rejects(writeToneCorpora(inputPaths, { root }), /EEXIST/);
    assert.equal(await readFile(audit, 'utf8'), 'pre-existing audit\n');
    for (const file of Object.values(CORPUS_FILES)) await assert.rejects(readFile(new URL(file, root)), /ENOENT/);
  });
});
