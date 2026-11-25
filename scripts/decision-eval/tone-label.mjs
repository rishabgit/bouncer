/**
 * Tone label study. No command sends inference except discovery and holdout.
 *
 * register spec (all fields required):
 * {schemaVersion:1, wordings:["W5"], policies:[{id:"chosen", template:"T0",
 *   stateTransform:"none", calibration:"none", shortRule:null, cutoff:0.4}],
 *  regressionCorpora:["original-validation","fresh-behaviour"],
 *  gates:[{name:"fewer owner errors",metric:"errors",policy:"chosen",comparator:"<=",
 *    reference:"P0",scope:"group:excessive-rudeness",factor:0.8,slack:0}]}
 * W0 and P0 are always included. Wording scores cover only the new corpus's
 * excessive-rudeness decisions; policies cover all new and selected regression
 * decisions. Gate policy/reference IDs may name a wording or a named policy;
 * reference may instead be a numeric count. Every gate requires scope and a
 * positive finite factor; limit = factor * referenceValue + slack, with both
 * policy and reference measured in the same scope. Scopes: all,
 * corpus:tone-holdout, corpus:original-validation, corpus:fresh-behaviour,
 * group:excessive-rudeness, group:fresh-*, group:orig-*. Group scopes contain only
 * tone-holdout decisions; regression corpora must be included to gate on them.
 * A policy's excessive-rudeness group uses W0; wording IDs use their own label.
 * Supported metrics are count fields
 * documented by evaluateGates in tone-label-metrics.mjs. No holdout fitting is
 * performed: every policy cutoff (including shortRule) must be in the spec.
 *
 * build prints corpus SHA-256s. Its deterministic audit binds the frozen bytes;
 * PINNED_CORPUS_HASHES can additionally pin those printed hashes in source once
 * the real authored corpus exists. Registration binds both hashes, snapshots,
 * exact plan/spec, study source files, frozen model selection, and receipts.
 * Discovery loads ONLY the new discovery file (not the new holdout file).
 * Low-content means the low-content subtype or zero own words; short-positive
 * means <= 5 own words. Subtype diagnostics retain ambiguous pairs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { CORPUS_HASHES, loadCorpora, validateSelection } from './corpora.mjs';
import { INTENTS, inventory, probeSettings, unloadProbe } from './wording-probe.mjs';
import { loadFreshCorpus, CORPUS_SHA256 as FRESH_SHA256 } from './guidance-fresh.mjs';
import { templateHash } from './templates.mjs';
import { variantById, ENDPOINTS } from './registry.mjs';
import { json, publicValue, parseProbabilities, assertNoTruncation, assertPreset } from './runtime.mjs';
import { environment } from './observations.mjs';
import { CORPUS_FILES, AUDIT_FILE, writeToneCorpora, loadToneCorpus, toneRows } from './tone-label-corpus.mjs';
import { WORDINGS, toneTemplateHash } from './tone-templates.mjs';
import { CUTOFF, validatePolicy, evaluateGates } from './tone-label-metrics.mjs';
import { buildTonePlan, analyzeTone, discoveryPolicies } from './tone-label-study.mjs';
import { reportTone } from './tone-label-report.mjs';
import { packToneEvidence, expandToneEvidence } from './tone-label-evidence.mjs';

export const ROOT = new URL('../../', import.meta.url);
export const FILES = Object.freeze({ discoveryRaw: 'decision-tone-discovery-raw.json', discoverySummary: 'decision-tone-discovery-summary.json',
  result: 'decision-tone-holdout-result.json', summary: 'decision-tone-holdout-summary.json', attempt: 'decision-tone-holdout-attempt.json' });
export const PINNED_CORPUS_HASHES = Object.freeze({
  discovery: 'a9b46487c5d4107134f73645413955bf8e07a664393bf28cd47097f2c8a19d2f',
  holdout: '3ad112fd60c7666599a83e79f04d77b9df50de93b482d2ff2d10ed8e77271031',
});
const VARIANT = variantById('llama-d1-2b-q8');
const SOURCES = ['tone-label.mjs', 'tone-label-corpus.mjs', 'tone-label-metrics.mjs', 'tone-label-study.mjs', 'tone-label-evidence.mjs', 'tone-templates.mjs',
  'wording-metrics.mjs', 'corpora.mjs', 'wording-probe.mjs', 'guidance-fresh.mjs', 'runtime.mjs', 'templates.mjs', 'registry.mjs'];
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const insist = (ok, message) => { if (!ok) throw new Error(message); };
const directory = root => new URL('docs/benchmarks/data/', root);
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const baseline = () => ({ id: 'P0', template: 'T0', stateTransform: 'none', calibration: 'none', shortRule: null, cutoff: CUTOFF });

export function serializeTone(value) {
  const evidence = value.evidenceFormat !== undefined || Array.isArray(value.rows) && value.plan && Array.isArray(value.requests);
  return JSON.stringify(publicValue(evidence ? packToneEvidence(value) : value), null, evidence ? undefined : 2) + '\n';
}

/** Durable, redacted, atomic evidence replacement. Claims use exclusive open. */
export async function saveTone(file, value, out) {
  await mkdir(out, { recursive: true });
  const temporary = new URL(`.tone-${randomUUID()}.tmp`, out);
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(serializeTone(value));
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, new URL(file, out));
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}
async function exclusiveJSON(file, value, out) {
  await mkdir(out, { recursive: true });
  let handle;
  try { handle = await open(new URL(file, out), 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`${file} already exists; no second registration or attempt is permitted`); throw error; }
  try { await handle.writeFile(serializeTone(value)); await handle.sync(); }
  finally { await handle.close(); }
}
async function absent(file, out) {
  try { await stat(new URL(file, out)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`${file} already exists; no second registration or attempt is permitted`);
}
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(SOURCES.map(async name => [name, hash(await readFile(new URL(name, import.meta.url)))])));
}
export async function protectedHashes(root = ROOT, phase = 'holdout') {
  const out = directory(root), names = (await readdir(out)).filter(name => /^decision-.*\.json$/.test(name)
    && !name.startsWith(`decision-tone-${phase}-`)
    // Holdout receipts can embed the complete corpus and diagnostic post texts.
    // Discovery must not read even their bytes while protecting other evidence.
    && !(phase === 'discovery' && name.startsWith('decision-tone-holdout-')));
  return Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await readFile(new URL(name, out)))])));
}
export async function checkProtected(hashes, root = ROOT) {
  insist(hashes && typeof hashes === 'object' && !Array.isArray(hashes), 'Missing protected receipt hashes');
  for (const [name, digest] of Object.entries(hashes)) {
    insist(/^decision-[^/]+\.json$/.test(name) && isHash(digest) && !name.includes('..'), 'Invalid protected receipt binding');
    insist(hash(await readFile(new URL(name, directory(root)))) === digest, `Protected receipt changed: ${name}`);
  }
}
export async function frozenFiles(root = ROOT) {
  const out = directory(root), selectionBytes = await readFile(new URL('decision-1b-selection-llama-d1-2b-q8.json', out));
  const selection = JSON.parse(selectionBytes), identity = JSON.parse(await readFile(new URL('decision-1b-identity-llama-d1-2b-q8.json', out)));
  insist(same(identity.variant, VARIANT) && selection.identityHash === hash(identity.identity)
    && selection.cutoff === CUTOFF && selection.templateId === 'matches-category', 'Frozen tone model binding differs');
  validateSelection(selection, { id: VARIANT.id, templateId: 'matches-category' }, CORPUS_HASHES, templateHash('matches-category'), selection.runtimeSettings);
  return { selection, selectionBytes, identity };
}
function modelBinding(frozen) {
  return { variantId: VARIANT.id, model: VARIANT.model, identityHash: frozen.selection.identityHash,
    selectionSha256: hash(frozen.selectionBytes), ggufSha256: frozen.identity.identity.sha256 };
}

export async function loadFrozenTone(split, { root = ROOT, read = readFile, pinned = String(root) === String(ROOT) ? PINNED_CORPUS_HASHES : {} } = {}) {
  insist(['discovery', 'holdout'].includes(split), 'Tone split must be discovery or holdout');
  const audit = JSON.parse(await read(new URL(AUDIT_FILE, directory(root))));
  const binding = audit.corpora?.[split];
  insist(binding?.file === CORPUS_FILES[split] && isHash(binding.sha256), 'Missing frozen tone corpus SHA-256; run build first');
  // The real corpora are pinned in source; test fixtures under another root are bound only by the audit file.
  if (pinned[split]) insist(binding.sha256 === pinned[split], 'Pinned tone corpus SHA-256 differs');
  const corpus = await loadToneCorpus(split, { root, read, expectedHash: binding.sha256 });
  return { corpus, binding };
}

/** Same single-filter D-label population as wording-probe, preserving each gold bit. */
export function originalRows(cases, corpus) {
  const byPhrase = new Map(INTENTS.map(intent => [intent.D, intent]));
  return cases.flatMap(c => c.filters.map((phrase, index) => {
    const intent = byPhrase.get(phrase); insist(intent, `Unmapped descriptive intent: ${phrase}`);
    insist(typeof c.expected[index] === 'boolean', 'Original per-decision gold differs');
    const postId = `${corpus}:${c.corpus}:${c.id}`, intentId = `orig-${intent.id}`;
    return { key: `${postId}:${intentId}`, postId, text: c.text, intentId, labelKey: intentId, label: intent.D,
      gold: c.expected[index], ambiguous: false, authoredFor: null, kind: 'original', part: 'original', subtype: 'original', corpus, group: 'orig-*' };
  }));
}
async function regressionRows(names, frozen) {
  const rows = [], hashes = {};
  for (const name of names) {
    if (name === 'original-validation') {
      const corpus = await loadCorpora({ split: 'validation', selection: frozen.selection,
        variant: { id: VARIANT.id, templateId: frozen.selection.templateId }, templateHash: frozen.selection.templateHash,
        runtimeSettings: frozen.selection.runtimeSettings });
      rows.push(...originalRows(corpus.cases, name)); hashes[name] = corpus.hashes;
    } else {
      const corpus = await loadFreshCorpus(); hashes[name] = FRESH_SHA256;
      for (const post of corpus.posts) for (const intent of corpus.intents) {
        const postId = `fresh-behaviour:${post.id}`, intentId = `fresh-${intent.id}`;
        rows.push({ key: `${postId}:${intentId}`, postId, text: post.text, intentId, labelKey: intentId,
          label: intent.labels.guided, gold: post.gold[intent.id], ambiguous: post.ambiguousFor.includes(intent.id),
          authoredFor: `fresh-${post.authoredFor}`, kind: post.kind, part: 'fresh-behaviour', subtype: post.kind, corpus: name, group: 'fresh-*' });
      }
    }
  }
  return { rows, hashes };
}

export function validateSpec(spec) {
  insist(spec && same(Object.keys(spec).sort(), ['schemaVersion', 'wordings', 'policies', 'regressionCorpora', 'gates'].sort())
    && spec.schemaVersion === 1, 'Tone spec requires schemaVersion, wordings, policies, regressionCorpora and gates');
  insist(Array.isArray(spec.wordings) && new Set(spec.wordings).size === spec.wordings.length
    && spec.wordings.every(id => Object.hasOwn(WORDINGS, id)), 'Unknown or duplicate wording ID');
  insist(Array.isArray(spec.policies), 'policies must be an array');
  const ids = new Set(['P0', ...Object.keys(WORDINGS)]);
  for (const entry of spec.policies) {
    const { id, ...policy } = entry;
    insist(typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) && !ids.has(id), 'Invalid, reserved or duplicate policy ID');
    ids.add(id); validatePolicy(policy);
  }
  insist(Array.isArray(spec.regressionCorpora) && new Set(spec.regressionCorpora).size === spec.regressionCorpora.length
    && spec.regressionCorpora.every(name => ['original-validation', 'fresh-behaviour'].includes(name)), 'Invalid regression corpora');
  const zero = () => Object.fromEntries(['errors', 'FP', 'FN', 'falseHides', 'missedHides', 'lowContentFP', 'shortPositiveFN', 'missedShortRude'].map(key => [key, 0]));
  const policyScopes = ['all', 'corpus:tone-holdout', 'group:excessive-rudeness', 'group:fresh-*', 'group:orig-*',
    ...spec.regressionCorpora.map(name => `corpus:${name}`)];
  const wordingScopes = ['all', 'corpus:tone-holdout', 'group:excessive-rudeness'];
  const metrics = Object.fromEntries(['P0', 'W0', ...spec.wordings, ...spec.policies.map(p => p.id)].map(id => [id,
    { ...zero(), scopes: Object.fromEntries((Object.hasOwn(WORDINGS, id) ? wordingScopes : policyScopes).map(scope => [scope, zero()])) }]));
  evaluateGates(spec.gates, metrics);
  return structuredClone(spec);
}

async function holdoutInputs(spec, root) {
  const discovery = await loadFrozenTone('discovery', { root }), holdout = await loadFrozenTone('holdout', { root });
  const frozen = await frozenFiles(root), regression = await regressionRows(spec.regressionCorpora, frozen);
  const rows = [...toneRows(holdout.corpus), ...regression.rows];
  const policies = [baseline(), ...spec.policies], wordings = [...new Set(['W0', ...spec.wordings])];
  const plan = buildTonePlan({ phase: 'holdout', corpus: holdout.corpus, rows, policies, wordings });
  return { frozen, corpus: holdout.corpus, rows, policies, wordings, plan,
    corpusHashes: { discovery: discovery.binding, holdout: holdout.binding, regression: regression.hashes } };
}
function registrationFor(spec, inputs, sources) {
  return publicValue({ spec, corpusHashes: inputs.corpusHashes, model: modelBinding(inputs.frozen),
    runtimeSettings: inputs.frozen.selection.runtimeSettings, templateHash: toneTemplateHash(), sourceHashes: sources,
    planSha256: hash(inputs.plan), rowsSha256: hash(inputs.rows), requests: inputs.plan.requests.length,
    rule: { singleMode: true, ambiguousExcluded: true, noRetries: true, noReruns: true, noRetuning: true, cutoff: CUTOFF } });
}
export async function registerTone(spec, { root = ROOT } = {}) {
  const out = directory(root); await absent(FILES.result, out); await absent(FILES.attempt, out);
  spec = validateSpec(spec);
  const inputs = await holdoutInputs(spec, root), registration = registrationFor(spec, inputs, await sourceHashes());
  const result = publicValue({ schemaVersion: 1, phase: 'tone-label-holdout', status: 'registered', registeredAt: new Date().toISOString(),
    spec, registration, registrationSha256: hash(registration), corpusSnapshot: inputs.corpus, rows: inputs.rows,
    plan: inputs.plan, protectedHashes: await protectedHashes(root), requestsIssued: 0, activeRequest: null, requests: [] });
  insist(same(result.rows, inputs.rows) && same(result.corpusSnapshot, inputs.corpus) && same(result.plan, inputs.plan), 'Public redaction would change study inputs');
  await exclusiveJSON(FILES.result, result, out);
  return result;
}
export async function checkToneRegistration(result, { root = ROOT, pristine = true } = {}) {
  if (pristine) insist(result.status === 'registered' && result.requestsIssued === 0 && result.requests?.length === 0
    && result.activeRequest === null && result.startedAt === undefined, 'Tone holdout already attempted; no retry is permitted');
  insist(result.schemaVersion === 1 && result.phase === 'tone-label-holdout' && Number.isFinite(Date.parse(result.registeredAt))
    && result.registrationSha256 === hash(result.registration), 'Tone registration binding differs');
  const spec = validateSpec(result.spec), inputs = await holdoutInputs(spec, root);
  insist(same(result.registration, registrationFor(spec, inputs, await sourceHashes())) && same(result.corpusSnapshot, inputs.corpus)
    && same(result.rows, inputs.rows) && same(result.plan, inputs.plan), 'Registered tone corpus, plan, spec or model binding differs');
  await checkProtected(result.protectedHashes, root);
  return inputs;
}
export async function claimToneAttempt(result, out) {
  await exclusiveJSON(FILES.attempt, { schemaVersion: 1, registrationSha256: result.registrationSha256,
    registeredAt: result.registeredAt, claimedAt: new Date().toISOString() }, out);
}

async function prepareModel(frozen) {
  const entries = await inventory(); assertPreset(VARIANT, entries.find(e => e.id === VARIANT.model));
  if (!entries.some(e => e.id === VARIANT.model && !['unloaded', 'incomplete'].includes(e.status.value)))
    await json(`${ENDPOINTS.llama}/models/load`, { model: VARIANT.model });
  const { settings, props } = await probeSettings(frozen.selection, frozen.identity);
  const digest = createHash('sha256'); for await (const chunk of createReadStream(props.model_path)) digest.update(chunk);
  insist(digest.digest('hex') === frozen.identity.identity.sha256, 'Tone study GGUF identity differs');
  return { settings, environment: publicValue(await environment()) };
}

/** Injection is for synthetic transport tests; CLI always uses the fixed runtime. */
export async function executeTone(result, { out, frozen, rawFile, prepare = prepareModel, send = json,
  verify = () => probeSettings(frozen.selection, frozen.identity), unload = unloadProbe, check = async () => {} }) {
  let failure, journal;
  const journalFile = rawFile.replace(/\.json$/, '-journal.jsonl');
  const journalOut = result.phase === 'tone-label-discovery'
    ? new URL('../../../scripts/decision-eval/.tmp/tone-label/', out) : out;
  try {
    await mkdir(out, { recursive: true });
    await mkdir(journalOut, { recursive: true });
    journal = await open(new URL(journalFile, journalOut), result.phase === 'tone-label-holdout' ? 'wx' : 'w');
    await journal.writeFile(JSON.stringify(publicValue({ schemaVersion: 1, phase: result.phase, startedAt: result.startedAt,
      registrationSha256: result.registrationSha256 ?? null })) + '\n');
    await journal.sync();
    const prepared = await prepare(frozen);
    result.runtimeSettings = prepared.settings; result.environment = publicValue(prepared.environment);
    insist(same(result.runtimeSettings, frozen.selection.runtimeSettings), 'Observed tone runtime settings differ');
    for (const request of result.plan.requests) {
      if (request.index % 100 === 0) await verify();
      result.activeRequest = { index: request.index, questionKey: request.questionKey, postId: request.postId, labelKey: request.labelKey };
      result.requestsIssued++;
      // Every send has its own durable before-send journal, even the first.
      // Compact appends avoid rewriting the entire frozen plan for every send.
      await journal.writeFile(JSON.stringify(publicValue({ requestsIssued: result.requestsIssued, ...result.activeRequest })) + '\n');
      await journal.sync();
      const start = performance.now();
      const response = await send(`${ENDPOINTS.llama}/v1/systemone`, { model: VARIANT.model, state: request.state,
        questions: result.plan.questions[request.questionKey] });
      const wallMs = performance.now() - start;
      assertNoTruncation(response, prepared.settings.effectiveContext);
      result.requests.push({ index: request.index, questionKey: request.questionKey, postId: request.postId, labelKey: request.labelKey,
        probability: parseProbabilities(response, 1)[0], wallMs, inputTokens: response.usage.input_tokens });
      result.activeRequest = null;
      if (result.requests.length % 25 === 0) await saveTone(rawFile, result, out);
    }
    await verify(); await check(); result.status = 'complete'; result.finishedAt = new Date().toISOString();
  } catch (error) { failure = error; result.status = 'failed'; result.error = publicValue(error.message); }
  finally {
    try { await unload(); } catch (error) { failure ??= error; result.status = 'failed'; result.error = publicValue(error.message); }
    if (journal) {
      await journal.close();
      result.journal = { file: result.phase === 'tone-label-discovery' ? `scripts/decision-eval/.tmp/tone-label/${journalFile}` : journalFile,
        sha256: hash(await readFile(new URL(journalFile, journalOut))) };
    }
    await saveTone(rawFile, result, out);
  }
  if (failure) throw new Error(`Tone study failed; holdout attempts cannot be retried: ${publicValue(failure.message)}`, { cause: failure });
  return result;
}
export async function runHoldout({ root = ROOT, runtime = {} } = {}) {
  const out = directory(root), result = expandToneEvidence(JSON.parse(await readFile(new URL(FILES.result, out))));
  const inputs = await checkToneRegistration(result, { root });
  await claimToneAttempt(result, out);
  result.status = 'running'; result.startedAt = new Date().toISOString(); await saveTone(FILES.result, result, out);
  await executeTone(result, { ...runtime, out, frozen: inputs.frozen, rawFile: FILES.result,
    check: () => checkProtected(result.protectedHashes, root) });
  return scoreTone({ root });
}
export async function scoreTone({ root = ROOT } = {}) {
  const out = directory(root), bytes = await readFile(new URL(FILES.result, out)), result = expandToneEvidence(JSON.parse(bytes));
  const inputs = await checkToneRegistration(result, { root, pristine: false });
  const claim = JSON.parse(await readFile(new URL(FILES.attempt, out)));
  insist(claim.registrationSha256 === result.registrationSha256 && claim.registeredAt === result.registeredAt, 'Tone attempt claim differs');
  insist(result.status === 'complete' && result.activeRequest === null && result.requestsIssued === result.plan.requests.length
    && same(result.runtimeSettings, result.registration.runtimeSettings)
    && Number.isFinite(Date.parse(result.startedAt)) && Date.parse(result.startedAt) >= Date.parse(result.registeredAt)
    && Number.isFinite(Date.parse(result.finishedAt)) && Date.parse(result.finishedAt) >= Date.parse(result.startedAt), 'Complete one-attempt tone evidence is required');
  const journalFile = FILES.result.replace(/\.json$/, '-journal.jsonl');
  insist(result.journal?.file === journalFile, 'Missing tone request journal');
  const journalBytes = await readFile(new URL(journalFile, out));
  insist(hash(journalBytes) === result.journal.sha256, 'Tone request journal SHA-256 differs');
  const journal = journalBytes.toString().trimEnd().split('\n').map(line => JSON.parse(line));
  insist(journal.length === result.plan.requests.length + 1 && journal[0].registrationSha256 === result.registrationSha256
    && journal[0].startedAt === result.startedAt, 'Tone request journal binding differs');
  for (const [index, entry] of journal.slice(1).entries()) {
    const request = result.plan.requests[index];
    insist(same(entry, { requestsIssued: index + 1, index, questionKey: request.questionKey, postId: request.postId, labelKey: request.labelKey }),
      'Tone before-send journal differs from registered plan');
  }
  for (const request of result.requests)
    assertNoTruncation({ usage: { input_tokens: request.inputTokens } }, result.registration.runtimeSettings.effectiveContext);
  const analyzed = analyzeTone({ phase: 'holdout', corpus: result.corpusSnapshot, rows: result.rows, plan: result.plan,
    requests: result.requests, policies: inputs.policies, wordings: inputs.wordings, gates: result.spec.gates });
  const summary = { ...analyzed, schemaVersion: 1, phase: result.phase, status: 'complete', rawFile: FILES.result, rawSha256: hash(bytes),
    registrationSha256: result.registrationSha256, model: result.registration.model, corpusHashes: result.registration.corpusHashes,
    cutoff: CUTOFF, immutableEvidenceUnchanged: true };
  await saveTone(FILES.summary, summary, out); return summary;
}
export async function runDiscovery({ root = ROOT, read = readFile, runtime = {} } = {}) {
  // No code in this path calls holdoutInputs or loadToneCorpus('holdout').
  const { corpus, binding } = await loadFrozenTone('discovery', { root, read });
  const frozen = await frozenFiles(root), original = await loadCorpora('discovery');
  const rows = [...toneRows(corpus), ...originalRows(original.cases, 'original-discovery')];
  const policies = discoveryPolicies(), wordings = Object.keys(WORDINGS);
  const plan = buildTonePlan({ phase: 'discovery', corpus, rows, policies, wordings });
  const result = publicValue({ schemaVersion: 1, phase: 'tone-label-discovery', status: 'running', startedAt: new Date().toISOString(),
    model: modelBinding(frozen), corpusHashes: { discovery: binding, original: original.hashes }, sourceHashes: await sourceHashes(),
    corpusSnapshot: corpus, rows, policies, wordings, plan, protectedHashes: await protectedHashes(root, 'discovery'), requestsIssued: 0, activeRequest: null, requests: [] });
  insist(same(result.rows, rows) && same(result.corpusSnapshot, corpus) && same(result.plan, plan), 'Public redaction would change study inputs');
  const out = directory(root); await saveTone(FILES.discoveryRaw, result, out);
  await executeTone(result, { ...runtime, out, frozen, rawFile: FILES.discoveryRaw, check: () => checkProtected(result.protectedHashes, root) });
  const analyzed = analyzeTone({ phase: 'discovery', corpus, rows, plan, requests: result.requests, policies, wordings });
  const summary = { ...analyzed, schemaVersion: 1, phase: result.phase, status: 'complete', startedAt: result.startedAt, finishedAt: result.finishedAt,
    rawFile: FILES.discoveryRaw, rawSha256: hash(await readFile(new URL(FILES.discoveryRaw, out))), model: result.model,
    corpusHashes: result.corpusHashes, cutoff: CUTOFF, immutableEvidenceUnchanged: true };
  await saveTone(FILES.discoverySummary, summary, out); return summary;
}

export async function main(argv = process.argv.slice(2), { root = ROOT, log = console.log } = {}) {
  const [command, ...args] = argv;
  if (command === 'build' && args.length === 5) {
    await absent(FILES.result, directory(root));
    const [discovery, holdout, labeler1, labeler2, rubrics] = args;
    const result = await writeToneCorpora({ discovery, holdout, labeler1, labeler2, rubrics }, { root });
    log(JSON.stringify(publicValue(result), null, 2)); return;
  }
  if (command === 'register' && args.length === 1) {
    const result = await registerTone(JSON.parse(await readFile(args[0])), { root });
    log(`Registered tone holdout before inference: ${result.registrationSha256}`); return;
  }
  if (!args.length && ['discovery', 'holdout', 'score', 'report'].includes(command)) {
    await ({ discovery: runDiscovery, holdout: runHoldout, score: scoreTone, report: reportTone }[command])({ root }); return;
  }
  throw new Error('Usage: node scripts/decision-eval/tone-label.mjs build <authored-d> <authored-h> <labeler-1> <labeler-2> <rubrics> | discovery | register <spec.json> | holdout | score | report');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(resolve(process.argv[1]))))
  main().catch(error => { console.error(publicValue(error.message)); process.exitCode = 1; });
