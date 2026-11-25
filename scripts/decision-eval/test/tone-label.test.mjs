import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { FILES, ROOT, hash, registerTone, runHoldout, scoreTone, runDiscovery, validateSpec, checkToneRegistration,
  claimToneAttempt, executeTone, loadFrozenTone, originalRows, saveTone, main, checkProtected } from '../tone-label.mjs';
import { CORPUS_FILES, AUDIT_FILE, writeToneCorpora } from '../tone-label-corpus.mjs';
import { loadCorpora } from '../corpora.mjs';
import { CUTOFF } from '../tone-label-metrics.mjs';
import { renderToneSection, replaceToneSection, reportTone, TONE_MARKERS } from '../tone-label-report.mjs';
import { packToneEvidence, expandToneEvidence } from '../tone-label-evidence.mjs';
import { buildTonePlan, discoveryPolicies } from '../tone-label-study.mjs';
import { WORDINGS } from '../tone-templates.mjs';
import { convertDiscovery, verifyDiscovery, discoverySummary } from '../tone-label-convert.mjs';

const fixturePaths = Object.fromEntries(['discovery', 'holdout', 'labeler1', 'labeler2', 'rubrics'].map(name =>
  [name, new URL(`./fixtures/tone-label/${name}.json`, import.meta.url)]));
const spec = () => ({ schemaVersion: 1, wordings: ['W5'], policies: [{ id: 'chosen', template: 'T0',
  stateTransform: 'none', calibration: 'none', shortRule: { maxOwnWords: 2, cutoff: 0.6 }, cutoff: CUTOFF }],
regressionCorpora: [], gates: [{ name: 'wording errors', metric: 'errors', policy: 'W5', comparator: '<=', reference: 'W0', slack: 0, scope: 'all', factor: 1 },
  { name: 'policy false hides', metric: 'FP', policy: 'chosen', comparator: '<=', reference: 'P0', slack: 0, scope: 'all', factor: 1 }] });

async function temporary(run, populated = true) {
  const path = await mkdtemp(join(tmpdir(), 'tone-label-runner-')), root = pathToFileURL(`${path}/`), out = new URL('docs/benchmarks/data/', root);
  try {
    await mkdir(out, { recursive: true });
    if (populated) {
      await writeToneCorpora(fixturePaths, { root });
      for (const name of ['decision-1b-selection-llama-d1-2b-q8.json', 'decision-1b-identity-llama-d1-2b-q8.json'])
        await copyFile(new URL(`docs/benchmarks/data/${name}`, ROOT), new URL(name, out));
    }
    await run({ root, out });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('specs freeze exact policy fields, gate namespaces and regression corpora', () => {
  const valid = spec(); assert.deepEqual(validateSpec(valid), valid);
  assert.notEqual(validateSpec(valid), valid);
  const invalid = [s => { s.wordings.push('W404'); }, s => { s.wordings.push('W5'); }, s => { s.extra = true; },
    s => { s.policies[0].id = 'P0'; }, s => { s.policies[0].id = 'W0'; }, s => { s.policies[0].optimize = true; },
    s => { s.policies[0].cutoff = null; }, s => { s.regressionCorpora = ['discovery']; },
    s => { s.regressionCorpora = ['fresh-behaviour', 'fresh-behaviour']; }, s => { s.gates[0].policy = 'absent'; },
    s => { s.gates[0].metric = 'auc'; }, s => { delete s.gates[0].scope; }, s => { delete s.gates[0].factor; },
    s => { s.gates[0].factor = 0; }, s => { s.gates[0].scope = 'corpus:fresh-behaviour'; }];
  for (const mutate of invalid) { const changed = spec(); mutate(changed); assert.throws(() => validateSpec(changed)); }
});

test('spec gates require available same-scope policy and wording references', () => {
  const scoped = spec();
  scoped.gates[0].scope = 'group:excessive-rudeness'; scoped.gates[0].factor = .8;
  assert.deepEqual(validateSpec(scoped), scoped);
  scoped.gates[1].scope = 'corpus:fresh-behaviour';
  assert.throws(() => validateSpec(scoped), /scope/);
  scoped.regressionCorpora.push('fresh-behaviour');
  assert.deepEqual(validateSpec(scoped), scoped);
  scoped.gates[1].reference = 'W0';
  assert.throws(() => validateSpec(scoped), /scope/);
});

test('original discovery conversion preserves the wording-probe D-label per-decision population', async () => {
  const original = await loadCorpora('discovery'), rows = originalRows(original.cases, 'original-discovery');
  assert.equal(rows.length, original.cases.reduce((total, c) => total + c.filters.length, 0));
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  let index = 0;
  for (const c of original.cases) for (const [n, filter] of c.filters.entries()) {
    const row = rows[index++]; assert.equal(row.label, filter); assert.equal(row.gold, c.expected[n]);
    assert.equal(row.text, c.text); assert.equal(row.ambiguous, false); assert.equal(row.group, 'orig-*');
  }
  assert.throws(() => originalRows([{ id: 'x', corpus: 'x', filters: ['unknown'], expected: [false] }], 'original'), /Unmapped/);
});

test('register refuses an existing result before accessing corpus or model files', async () => {
  await temporary(async ({ root, out }) => {
    await writeFile(new URL(FILES.result, out), 'existing evidence\n');
    await assert.rejects(registerTone(spec(), { root }), /already exists/);
    assert.equal(await readFile(new URL(FILES.result, out), 'utf8'), 'existing evidence\n');
  }, false);
});

test('build command dry run writes valid frozen fixture files and prints both SHA-256s', async () => {
  await temporary(async ({ root }) => {
    const output = [];
    await main(['build', ...Object.values(fixturePaths).map(fileURLToPath)], { root, log: line => output.push(line) });
    const printed = JSON.parse(output.join('\n'));
    for (const split of ['discovery', 'holdout']) {
      const loaded = await loadFrozenTone(split, { root });
      assert.equal(loaded.binding.sha256, printed.corpora[split].sha256);
      assert.equal(loaded.corpus.counts.posts, 18); assert.equal(loaded.corpus.counts.pairs, 324);
    }
  }, false);
});

test('optional regression corpora preserve original-validation bits and fresh guided-label ambiguity', async () => {
  await temporary(async ({ root }) => {
    const plan = spec(); plan.regressionCorpora = ['original-validation', 'fresh-behaviour'];
    const result = await registerTone(plan, { root });
    const original = result.rows.filter(row => row.corpus === 'original-validation');
    const fresh = result.rows.filter(row => row.corpus === 'fresh-behaviour');
    assert.ok(original.length > 0); assert.ok(original.every(row => !row.ambiguous && row.group === 'orig-*'));
    assert.equal(fresh.length, 504); assert.equal(fresh.filter(row => row.ambiguous).length, 22);
    assert.ok(fresh.every(row => row.group === 'fresh-*' && row.label.startsWith('posts ')));
    assert.equal(Object.keys(result.registration.corpusHashes.regression).length, 2);
    await checkToneRegistration(result, { root });
  });
});

test('registration binds both corpus hashes, snapshots, policies, model, sources and schedule', async () => {
  await temporary(async ({ root, out }) => {
    const result = await registerTone(spec(), { root });
    assert.equal(result.status, 'registered'); assert.equal(result.requestsIssued, 0); assert.deepEqual(result.requests, []);
    assert.equal(result.registrationSha256, hash(result.registration));
    assert.equal(result.registration.corpusHashes.holdout.sha256, hash(await readFile(new URL(CORPUS_FILES.holdout, root))));
    assert.ok(result.registration.sourceHashes['tone-label-study.mjs']);
    assert.equal(result.registration.requests, result.plan.requests.length);
    await checkToneRegistration(result, { root });
    await assert.rejects(registerTone(spec(), { root }), /already exists/);
    for (const mutate of [r => { r.spec.policies[0].cutoff = .9; }, r => { r.rows[0].gold = !r.rows[0].gold; },
      r => { r.plan.requests[0].state = 'changed'; }, r => { r.registration.model.ggufSha256 = 'a'.repeat(64); }]) {
      const changed = structuredClone(result); mutate(changed); changed.registrationSha256 = hash(changed.registration);
      await assert.rejects(checkToneRegistration(changed, { root }), /binding differs/);
    }
    const identity = new URL('decision-1b-identity-llama-d1-2b-q8.json', out), bytes = await readFile(identity);
    await writeFile(identity, Buffer.concat([bytes, Buffer.from('\n')]));
    await assert.rejects(checkToneRegistration(result, { root }), /Protected receipt changed/);
  });
});

test('discovery runs without a holdout file and never asks its loader to read holdout', async () => {
  await temporary(async ({ root, out }) => {
    await rm(new URL(CORPUS_FILES.holdout, root));
    const reads = [];
    const read = async file => { reads.push(file.href); assert.ok(!file.href.includes('tone-label-holdout')); return readFile(file); };
    const loaded = await loadFrozenTone('discovery', { root, read }); assert.equal(loaded.corpus.split, 'discovery');
    let prepared = false, unloaded = false;
    await assert.rejects(runDiscovery({ root, read, runtime: {
      prepare: async () => { prepared = true; throw new Error('synthetic stop before inference'); },
      unload: async () => { unloaded = true; }, send: async () => assert.fail('No real inference is allowed'),
    } }), /synthetic stop/);
    assert.equal(prepared, true); assert.equal(unloaded, true);
    assert.ok(reads.every(name => name.endsWith(AUDIT_FILE) || name.endsWith(CORPUS_FILES.discovery)));
    const raw = JSON.parse(await readFile(new URL(FILES.discoveryRaw, out)));
    assert.equal(raw.status, 'failed'); assert.equal(raw.requestsIssued, 0);
    assert.equal(raw.schemaVersion, 2);
    assert.match(raw.journal.file, /^scripts\/decision-eval\/\.tmp\//);
    assert.equal(hash(await readFile(new URL(raw.journal.file, root))), raw.journal.sha256);
    await assert.rejects(readFile(new URL(FILES.discoveryRaw.replace(/\.json$/, '-journal.jsonl'), out)), /ENOENT/);
  });
});

test('discovery never reads holdout snapshots through receipt hashing or verification', async t => {
  await temporary(async ({ root, out }) => {
    const snapshot = JSON.parse(await readFile(new URL(CORPUS_FILES.holdout, root)));
    for (const name of [FILES.result, FILES.summary, FILES.attempt])
      await writeFile(new URL(name, out), JSON.stringify({ corpusSnapshot: snapshot }));
    const originalRead = fs.readFile, reads = [];
    // Instrument the filesystem binding itself, including reads outside the
    // corpus loader's injected read callback.
    t.mock.method(fs, 'readFile', async (file, ...args) => {
      const name = file instanceof URL ? file.pathname : String(file);
      reads.push(name);
      assert.doesNotMatch(name, /\/(?:tone-label|decision-tone)-holdout-/);
      return originalRead(file, ...args);
    });
    syncBuiltinESMExports();
    try {
      let prepared = false;
      await assert.rejects(runDiscovery({ root, runtime: {
        prepare: async () => { prepared = true; throw new Error('synthetic stop before inference'); },
        unload: async () => {}, send: async () => assert.fail('No inference allowed'),
      } }), /synthetic stop/);
      assert.equal(prepared, true);
      const raw = JSON.parse(await readFile(new URL(FILES.discoveryRaw, out)));
      assert.ok(Object.keys(raw.protectedHashes).length > 0);
      assert.ok(Object.keys(raw.protectedHashes).every(name => !name.startsWith('decision-tone-holdout-')));
      await checkProtected(raw.protectedHashes, root);
      assert.ok(reads.some(name => name.endsWith('decision-1b-selection-llama-d1-2b-q8.json')),
        'filesystem instrumentation must observe reads outside the corpus loader');
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test('failed holdout preparation permanently consumes the attempt and rejects a second run', async () => {
  await temporary(async ({ root, out }) => {
    const result = await registerTone(spec(), { root });
    let prepares = 0, unloads = 0;
    const runtime = { prepare: async () => { prepares++; throw new Error('synthetic preparation failure'); },
      unload: async () => { unloads++; }, send: async () => assert.fail('No inference allowed') };
    await assert.rejects(runHoldout({ root, runtime }), /synthetic preparation failure/);
    await assert.rejects(runHoldout({ root, runtime }), /already attempted/);
    assert.equal(prepares, 1); assert.equal(unloads, 1);
    const saved = JSON.parse(await readFile(new URL(FILES.result, out)));
    assert.equal(saved.status, 'failed'); assert.equal(saved.requestsIssued, 0);
    // Even restoring a pristine receipt cannot erase the permanent exclusive claim.
    await saveTone(FILES.result, result, out);
    await assert.rejects(runHoldout({ root, runtime }), /already exists/);
    await assert.rejects(claimToneAttempt(result, out), /already exists/);
  });
});

test('synthetic holdout journals before sends, scores without inference, and renders only bounded report text', async () => {
  await temporary(async ({ root, out }) => {
    const result = await registerTone(spec(), { root }), settings = result.registration.runtimeSettings;
    let sent = 0, unloaded = 0;
    const runtime = { prepare: async () => ({ settings, environment: { synthetic: true } }), verify: async () => {},
      unload: async () => { unloaded++; }, send: async (url, body) => {
        assert.equal(url, 'http://127.0.0.1:9931/v1/systemone');
        assert.equal(body.model, 'LiquidAI/d1-2B-GGUF:Q8_0'); assert.deepEqual(Object.keys(body.questions), ['f0']);
        const journal = (await readFile(new URL(FILES.result.replace(/\.json$/, '-journal.jsonl'), out), 'utf8')).trimEnd().split('\n').map(JSON.parse);
        assert.equal(journal.at(-1).requestsIssued, ++sent);
        assert.equal(journal.at(-1).index, sent - 1);
        return { answers: { f0: { type: 'noul', noul: .1 } }, usage: { input_tokens: 40 } };
      } };
    const summary = await runHoldout({ root, runtime });
    assert.equal(unloaded, 1); assert.equal(summary.phase, 'tone-label-holdout');
    assert.equal(summary.counts.requests, sent); assert.equal(summary.gates.pass, true);
    const rescored = await scoreTone({ root }); assert.deepEqual(rescored, summary);
    await assert.rejects(runHoldout({ root, runtime }), /already attempted/);
    const doc = new URL('docs/benchmarks/decision-models.md', root);
    await writeFile(doc, `Before\n\n${TONE_MARKERS[0]}\nOld\n${TONE_MARKERS[1]}\n\nAfter\n`);
    const markdown = await reportTone({ root });
    assert.ok(markdown.startsWith('Before\n\n')); assert.ok(markdown.endsWith('\n\nAfter\n'));
    assert.match(markdown, /Tone label study/); assert.match(markdown, /wording errors/);
    assert.doesNotMatch(markdown, /\bOld\b|recommend/i);
    const stored = JSON.parse(await readFile(new URL(FILES.result, out)));
    assert.equal(stored.schemaVersion, 2);
    assert.equal(stored.plan, undefined); assert.equal(stored.rows, undefined); assert.equal(stored.requests, undefined);
    const raw = expandToneEvidence(stored);
    raw.requests[0].inputTokens = settings.effectiveContext;
    await saveTone(FILES.result, raw, out);
    await assert.rejects(scoreTone({ root }), /token|Truncation/i);
    await assert.rejects(reportTone({ root }), /raw SHA-256 differs/);
  });
});

function syntheticDiscovery() {
  const corpusSnapshot = { split: 'discovery', twins: [{ id: 'twin', sourceId: 'rude', text: '@a kind words' }] };
  const rows = [{ id: 'rude', text: '@a you idiot', gold: true, subtype: 'short-rude' },
    { id: 'empty', text: '@a @b', gold: false, subtype: 'low-content' }].map(post => ({
    key: post.id, postId: post.id, text: post.text, intentId: 'excessive-rudeness', labelKey: 'excessive-rudeness',
    label: WORDINGS.W0, gold: post.gold, ambiguous: false, corpus: 'tone-discovery', group: 'excessive-rudeness', subtype: post.subtype,
  }));
  const policies = discoveryPolicies(), wordings = Object.keys(WORDINGS);
  const plan = buildTonePlan({ phase: 'discovery', corpus: corpusSnapshot, rows, policies, wordings });
  return { schemaVersion: 1, phase: 'tone-label-discovery', status: 'complete', startedAt: '2026-11-25T00:00:00.000Z',
    finishedAt: '2026-11-25T00:01:00.000Z', corpusSnapshot, rows, policies, wordings, plan,
    protectedHashes: {}, model: { synthetic: true }, corpusHashes: { synthetic: 'a'.repeat(64) }, activeRequest: null,
    requestsIssued: plan.requests.length, requests: plan.requests.map(({ state, ...request }) => ({ ...request,
      probability: state.includes('idiot') ? .7 : .1, wallMs: 1.2345678901234567, inputTokens: 40 })) };
}

test('compact raw format round-trips measurements, optional fields, inputs and deterministic plans', () => {
  const original = syntheticDiscovery();
  original.rows[0].extra = null;
  original.requests[0].extra = null;
  original.requests[1].extra = { nested: ['retained', 1e-12] };
  const compact = packToneEvidence(original), bytes = JSON.stringify(compact);
  assert.ok(bytes.length < JSON.stringify(original).length / 2);
  assert.equal(compact.plan, undefined); assert.equal(compact.rows, undefined); assert.equal(compact.requests, undefined);
  assert.deepEqual(expandToneEvidence(JSON.parse(bytes)), original);
  assert.deepEqual(discoverySummary(expandToneEvidence(JSON.parse(bytes))), discoverySummary(original));
  for (const mutate of [r => { r.planSha256 = 'a'.repeat(64); }, r => { r.questions.q0.f0.instructions = 'changed'; },
    r => { r.rowTable.values[0][0] = 99999; }, r => { r.requestTable.values[0][0] = -1; },
    r => { r.requestTable.missing[0] = [99999]; }]) {
    const changed = structuredClone(compact); mutate(changed);
    assert.throws(() => expandToneEvidence(changed), /tone|Tone/);
  }
});

test('offline discovery conversion preserves headlines and moves only its journal to local storage', async () => {
  await temporary(async ({ root, out }) => {
    const raw = syntheticDiscovery(), name = FILES.discoveryRaw.replace(/\.json$/, '-journal.jsonl');
    const journal = JSON.stringify({ phase: raw.phase, startedAt: raw.startedAt }) + '\n';
    raw.journal = { file: name, sha256: hash(journal) };
    const bytes = JSON.stringify(raw, null, 2) + '\n';
    await writeFile(new URL(FILES.discoveryRaw, out), bytes);
    await writeFile(new URL(name, out), journal);
    await saveTone(FILES.discoverySummary, { ...discoverySummary(raw), rawSha256: hash(bytes) }, out);
    const output = [], converted = await convertDiscovery({ root, log: line => output.push(line) });
    assert.deepEqual(converted.before, converted.after); assert.match(output.join('\n'), /MATCH true/);
    const expanded = expandToneEvidence(JSON.parse(await readFile(new URL(FILES.discoveryRaw, out))));
    assert.equal(expanded.journal.sha256, hash(await readFile(new URL(expanded.journal.file, root))));
    await assert.rejects(readFile(new URL(name, out)), /ENOENT/);
    assert.deepEqual((await verifyDiscovery({ root, log: () => {} })).after, converted.before);
    await assert.rejects(convertDiscovery({ root, log: () => {} }), /already converted/);
    const doc = new URL('docs/benchmarks/decision-models.md', root);
    await writeFile(doc, 'Outside\n');
    const markdown = await reportTone({ root });
    for (const text of ['Short-rule grid', 'W0 subtype probabilities', 'Source-to-twin', 'Handle-noise', 'Template sensitivity', 'Content-free prior'])
      assert.ok(markdown.includes(text), text);
    assert.doesNotMatch(markdown, /@a you idiot|@a kind words|recommend/i);
  }, false);
});

test('uncertain malformed sends fail with an active journal entry and unload once', async () => {
  await temporary(async ({ out }) => {
    const plan = { questions: { q0: { f0: { type: 'noul', instructions: 'synthetic' } } },
      requests: [{ index: 0, questionKey: 'q0', postId: 'p', labelKey: 'l', state: 'synthetic' }] };
    const result = { phase: 'tone-label-holdout', registrationSha256: 'a'.repeat(64), startedAt: new Date().toISOString(),
      plan, status: 'running', requests: [], requestsIssued: 0 };
    let unloads = 0;
    await assert.rejects(executeTone(result, { out, frozen: { selection: { runtimeSettings: { effectiveContext: 4096 } } },
      rawFile: FILES.result, prepare: async () => ({ settings: { effectiveContext: 4096 }, environment: {} }),
      verify: async () => {}, send: async () => ({ answers: {}, usage: { input_tokens: 10 } }), unload: async () => { unloads++; } }), /Incomplete noul/);
    assert.equal(unloads, 1); assert.equal(result.status, 'failed'); assert.equal(result.requestsIssued, 1);
    assert.equal(result.activeRequest.index, 0); assert.deepEqual(result.requests, []);
  }, false);
});

test('report marker replacement rejects broken markers and works with either summary', () => {
  const empty = renderToneSection(); assert.match(empty, /No tone label study results/);
  const bounded = replaceToneSection('Outside\n', empty);
  assert.equal(replaceToneSection(bounded, empty), bounded);
  for (const text of [TONE_MARKERS[0], TONE_MARKERS[1], `${TONE_MARKERS[1]}\n${TONE_MARKERS[0]}`,
    `${TONE_MARKERS[0]}${TONE_MARKERS[0]}${TONE_MARKERS[1]}${TONE_MARKERS[1]}`]) assert.throws(() => replaceToneSection(text, empty), /markers/);
  const summary = { status: 'complete', wordings: [], policies: [] };
  assert.match(renderToneSection({ discovery: summary }), /Discovery/);
  assert.match(renderToneSection({ holdout: { ...summary, gates: { checks: [] } } }), /Holdout/);
});
