import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadFreshCorpus, buildGuidancePlan, freshCounts, guidanceGates, analyzeGuidance, makeGuidanceRegistration,
  checkGuidanceRegistration, claimGuidanceAttempt, CUTOFF, REGISTRATION_RULE, CORPUS_FILE, CORPUS_SHA256 } from '../guidance-fresh.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);

test('fresh corpus bytes and complete balanced plan are pinned without editing or inference', async () => {
  const bytes = await readFile(new URL('../../../' + CORPUS_FILE, import.meta.url));
  assert.equal(hash(bytes), CORPUS_SHA256);
  const corpus = await loadFreshCorpus(), counts = freshCounts(corpus), plan = buildGuidancePlan(corpus);
  assert.deepEqual(counts, { posts: 84, intents: 6, decisionsPerStyle: 504, ambiguousPerStyle: 22, headlinePerStyle: 482, requests: 1764 });
  assert.equal(plan.length, 1764); assert.deepEqual(plan, buildGuidancePlan(corpus));
  for (const style of ['short', 'guided', 'guidedExclusion']) {
    assert.equal(plan.filter(r => r.style === style && r.mode === 'single').length, 504);
    assert.equal(plan.filter(r => r.style === style && r.mode === 'six-filter').length, 84);
  }
  assert.equal(new Set(plan.map(r => JSON.stringify([r.mode, r.style, r.postId, r.intentIds]))).size, plan.length);
  assert.ok(plan.every(r => Object.keys(r.questions).length === r.intentIds.length));
});

function fixture() {
  const intents = ['a', 'b'].map(id => ({ id, labels: { short: `${id} short`, guided: `${id} guided`, guidedExclusion: `${id} guided not other` } }));
  const posts = [
    { id: 'positive', text: 'A clear positive', authoredFor: 'a', kind: 'clear-positive', gold: { a: true, b: true }, ambiguousFor: ['b'] },
    { id: 'near', text: 'A near-miss', authoredFor: 'a', kind: 'near-miss', gold: { a: false, b: false }, ambiguousFor: [] },
    { id: 'subtle', text: 'A subtle positive', authoredFor: 'b', kind: 'subtle-positive', gold: { a: false, b: true }, ambiguousFor: [] },
    { id: 'other', text: 'Unrelated', authoredFor: 'b', kind: 'unrelated', gold: { a: false, b: false }, ambiguousFor: ['a'] },
  ];
  const corpus = { intents, posts };
  const probabilities = (style, post, id, mode) => {
    if (post === 'positive') return id === 'a' ? .8 : mode === 'single' ? .9 : .1;
    if (post === 'other') return id === 'a' ? .9 : .1;
    if (post === 'subtle') return id === 'a' ? .1 : style === 'guided' ? .8 : .1;
    if (mode === 'six-filter' && id === 'a') return .1;
    if (style === 'short') return .8;
    return style === 'guided' && id === 'a' ? .8 : .1;
  };
  const requests = buildGuidancePlan(corpus).map(r => ({ ...r, probabilities: r.intentIds.map(id => probabilities(r.style, r.postId, id, r.mode)), wallMs: 10, usage: { input_tokens: 80 } }));
  const runtimeSettings = { effectiveContext: 4096 };
  return { schemaVersion: 1, phase: 'fresh-guidance', status: 'complete', registration: { rule: REGISTRATION_RULE, cutoff: CUTOFF, runtimeSettings },
    corpusSnapshot: corpus, requestsIssued: requests.length, requests };
}

test('ambiguity is excluded from headline scores and near-miss masks disclose all vs own-filter populations', () => {
  const result = fixture(), summary = analyzeGuidance(result);
  const single = style => summary.metrics.find(r => r.style === style && r.mode === 'single' && r.intentId === 'all');
  const short = single('short'), guided = single('guided'), exclusion = single('guidedExclusion');
  assert.equal(short.n, 6); assert.equal(short.ambiguousExcluded, 2); assert.equal(short.nearMissDecisions, 2); assert.equal(short.ownNearMissDecisions, 1);
  assert.equal(short.errors, 3); assert.equal(short.nearMissFalseHides, 2); assert.equal(short.missedSubtlePositives, 1);
  assert.equal(guided.errors, 1); assert.equal(guided.nearMissFalseHides, 1); assert.equal(guided.missedSubtlePositives, 0);
  assert.equal(exclusion.errors, 1); assert.equal(exclusion.nearMissFalseHides, 0); assert.equal(exclusion.missedSubtlePositives, 1);
  assert.equal(summary.gates.guidance.supported, true); assert.equal(summary.gates.exclusion.supported, true);
  const altered = clone(result);
  for (const r of altered.requests) for (const [n, id] of r.intentIds.entries()) {
    if (altered.corpusSnapshot.posts.find(p => p.id === r.postId).ambiguousFor.includes(id)) r.probabilities[n] = .02;
  }
  assert.deepEqual(analyzeGuidance(altered).metrics, summary.metrics);
});

test('registered directional gates require fewer errors and bound exclusion extra missed hides', () => {
  const base = [{ style: 'short', errors: 10, nearMissFalseHides: 2, missedHides: 3 },
    { style: 'guided', errors: 9, nearMissFalseHides: 2, missedHides: 3 },
    { style: 'guidedExclusion', errors: 20, nearMissFalseHides: 2, missedHides: 4 }];
  assert.equal(guidanceGates(base).guidance.supported, true); assert.equal(guidanceGates(base).exclusion.supported, true);
  for (const [index, key, value, section, gate] of [[1, 'errors', 10, 'guidance', 'errors'], [1, 'nearMissFalseHides', 3, 'guidance', 'nearMissFalseHides'],
    [2, 'nearMissFalseHides', 3, 'exclusion', 'nearMissFalseHides'], [2, 'missedHides', 5, 'exclusion', 'missedHides']]) {
    const changed = clone(base); changed[index][key] = value;
    const gates = guidanceGates(changed); assert.equal(gates[section].supported, false); assert.equal(gates[section].checks[gate].pass, false);
  }
});

test('bounced-post diagnostics, near-miss repairs, interference and timing count the intended pairs', () => {
  const summary = analyzeGuidance(fixture());
  const bounced = style => summary.bounced.find(r => r.style === style && r.intentId === 'all');
  assert.deepEqual([bounced('short').n, bounced('short').caught, bounced('short').missed, bounced('short').subtleMissed], [2, 1, 1, 1]);
  assert.equal(bounced('guided').caught, 2); assert.equal(bounced('guidedExclusion').failures[0].postId, 'subtle');
  const interference = population => summary.interference.find(r => r.style === 'short' && r.intentId === 'all' && r.population === population);
  assert.equal(interference('headline').n, 6); assert.equal(interference('headline').flips, 1);
  assert.equal(interference('allIncludingAmbiguous').flips, 2);
  assert.equal(summary.interferenceFlips.filter(r => r.style === 'short').length, 2);
  assert.equal(summary.requestStats.find(r => r.style === 'short' && r.mode === 'six-filter').n, 4);
  assert.equal(summary.nearMissPaired[0].newFalseHides, 0); assert.equal(summary.nearMissPaired[0].repairedFalseHides, 1);
});

test('once-only registration binds corpus, frozen model, exact rule, settings and schedule before inference', () => {
  const corpus = fixture().corpusSnapshot, frozen = { selection: { identityHash: 'a'.repeat(64), runtimeSettings: { effectiveContext: 4096 } }, selectionBytes: Buffer.from('selection') };
  const registration = makeGuidanceRegistration(corpus, frozen);
  const result = { schemaVersion: 1, phase: 'fresh-guidance', status: 'registered', registeredAt: new Date().toISOString(), registration,
    registrationSha256: hash(registration), corpusSnapshot: corpus, requestsIssued: 0, requests: [] };
  assert.equal(checkGuidanceRegistration(result, corpus, frozen), registration);
  for (const status of ['running', 'complete', 'failed']) assert.throws(() => checkGuidanceRegistration({ ...result, status }, corpus, frozen), /no retry/);
  assert.throws(() => checkGuidanceRegistration({ ...result, requestsIssued: 1 }, corpus, frozen), /no retry/);
  for (const change of [r => { r.rule.noRetuning = false; }, r => { r.cutoff = .5; }, r => { r.runtimeSettings.effectiveContext = 8192; },
    r => { r.model.selectionSha256 = 'b'.repeat(64); }, r => { r.corpus.sha256 = 'b'.repeat(64); }, r => { r.schedule.totalRequests++; }]) {
    const changed = clone(result); change(changed.registration); changed.registrationSha256 = hash(changed.registration);
    assert.throws(() => checkGuidanceRegistration(changed, corpus, frozen), /binding differs/);
  }
});

test('partial, duplicate or changed request plans cannot be scored as a complete run', () => {
  const original = fixture();
  const partial = clone(original); partial.requests.pop(); assert.throws(() => analyzeGuidance(partial), /Incomplete/);
  const duplicate = clone(original); duplicate.requests[1] = clone(duplicate.requests[0]); assert.throws(() => analyzeGuidance(duplicate), /differs from registered plan/);
  const changed = clone(original); changed.requests[0].labels[0] = 'another label'; assert.throws(() => analyzeGuidance(changed), /differs from registered plan/);
});

test('permanent exclusive claim rejects concurrent starts and remains consumed after a failed run', async () => {
  const root = new URL('../.tmp/', import.meta.url); await mkdir(root, { recursive: true });
  const path = await mkdtemp(new URL('fresh-claim-test-', root)), directory = pathToFileURL(path + '/');
  try {
    const result = { registrationSha256: 'a'.repeat(64), registeredAt: new Date().toISOString() };
    const concurrent = await Promise.allSettled([claimGuidanceAttempt(result, directory), claimGuidanceAttempt(result, directory)]);
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
    await assert.rejects(claimGuidanceAttempt({ ...result, status: 'failed' }, directory), /no rerun/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
