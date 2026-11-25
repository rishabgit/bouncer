import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, rename, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { questions, templateHash } from './templates.mjs';
import { variantById, ENDPOINTS } from './registry.mjs';
import { json, publicValue, parseProbabilities, assertNoTruncation, assertPreset, LOCAL } from './runtime.mjs';
import { inventory, probeSettings, unloadProbe } from './wording-probe.mjs';
import { decisionMetrics, optimalCutoff } from './wording-metrics.mjs';
import { environment } from './observations.mjs';

const OUT = new URL('../../docs/benchmarks/data/', import.meta.url), ROOT = new URL('../../', import.meta.url);
export const CORPUS_FILE = 'scripts/decision-eval/corpora/guidance-fresh-2026-11-25.json';
export const CORPUS_SHA256 = 'fe82fe7dcdf8cd96fb828d20624b4ba160dede297c36ddcfa4e57c09f6373cb3';
export const RESULT_FILE = 'decision-guidance-fresh-result.json';
export const SUMMARY_FILE = 'decision-guidance-fresh-summary.json';
export const ATTEMPT_FILE = 'decision-guidance-fresh-attempt.json';
export const STYLES = Object.freeze(['short', 'guided', 'guidedExclusion']);
export const CUTOFF = 0.290813258948728;
const VARIANT = variantById('llama-d1-2b-q8');
export const REGISTRATION_RULE = Object.freeze({
  version: 1,
  primaryMode: 'single',
  population: 'All post/filter pairs, excluding pairs named in post.ambiguousFor',
  nearMissPopulation: 'Negative-gold eligible pairs on posts tagged near-miss, including cross-filter pairs',
  ownNearMissDiagnostic: 'Negative-gold eligible near-miss pairs whose filter equals post.authoredFor',
  subtlePositivePopulation: 'Positive-gold eligible pairs on posts tagged subtle-positive',
  bouncedPopulation: 'Each own-intent positive post, using its own single-filter label',
  guidance: { errors: 'guided.errors < short.errors', nearMissFalseHides: 'guided.nearMissFalseHides <= short.nearMissFalseHides' },
  exclusion: { nearMissFalseHides: 'guidedExclusion.nearMissFalseHides <= guided.nearMissFalseHides', missedHides: 'guidedExclusion.missedHides <= guided.missedHides + 1' },
  nearMissComparison: 'Aggregate false-hide counts; newly introduced and repaired false hides are reported separately, not gated',
  diagnostics: 'AUC, best cutoffs, six-filter interference, request cost and bounced-post checks are not gated',
  noRetuning: true,
  noRelabelling: true,
  noReruns: true,
});
const insist = (condition, message) => { if (!condition) throw new Error(message); };
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const active = entry => !['unloaded', 'incomplete'].includes(entry.status.value);
const median = values => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length ? s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 : null; };

export async function loadFreshCorpus() {
  const bytes = await readFile(new URL(CORPUS_FILE, ROOT));
  insist(hash(bytes) === CORPUS_SHA256, 'Fresh guidance corpus SHA-256 differs');
  const corpus = JSON.parse(bytes), ids = corpus.intents?.map(i => i.id);
  insist(corpus.schemaVersion === 1 && corpus.corpusId === 'guidance-fresh-2026-11-25' && ids?.length === 6
    && new Set(ids).size === 6 && corpus.posts?.length === 84, 'Fresh guidance corpus structure differs');
  for (const intent of corpus.intents) insist(STYLES.every(s => typeof intent.labels?.[s] === 'string' && intent.labels[s].trim()), 'Missing fresh filter labels');
  insist(new Set(corpus.posts.map(p => p.id)).size === 84, 'Duplicate fresh post id');
  for (const p of corpus.posts) insist(typeof p.text === 'string' && p.text.trim() && ids.includes(p.authoredFor)
    && ['clear-positive', 'subtle-positive', 'near-miss', 'unrelated'].includes(p.kind)
    && same(Object.keys(p.gold).sort(), [...ids].sort()) && ids.every(id => typeof p.gold[id] === 'boolean')
    && Array.isArray(p.ambiguousFor) && new Set(p.ambiguousFor).size === p.ambiguousFor.length
    && p.ambiguousFor.every(id => ids.includes(id)), 'Invalid fresh post labels or ambiguity flags');
  return corpus;
}

export function buildGuidancePlan(corpus, seed = 0x6b0b2026) {
  const requests = [];
  for (const post of corpus.posts) for (const style of STYLES) {
    for (const intent of corpus.intents) {
      const labels = [intent.labels[style]];
      requests.push({ mode: 'single', style, postId: post.id, intentIds: [intent.id], labels, questions: questions(labels, 'matches-category') });
    }
    const labels = corpus.intents.map(i => i.labels[style]);
    requests.push({ mode: 'six-filter', style, postId: post.id, intentIds: corpus.intents.map(i => i.id), labels, questions: questions(labels, 'matches-category') });
  }
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
  for (let n = requests.length - 1; n > 0; n--) { const k = Math.floor(random() * (n + 1)); [requests[n], requests[k]] = [requests[k], requests[n]]; }
  return requests.map((request, index) => ({ index, ...request }));
}

export function freshCounts(corpus) {
  const ambiguous = corpus.posts.reduce((n, p) => n + p.ambiguousFor.length, 0), decisions = corpus.posts.length * corpus.intents.length;
  return { posts: corpus.posts.length, intents: corpus.intents.length, decisionsPerStyle: decisions,
    ambiguousPerStyle: ambiguous, headlinePerStyle: decisions - ambiguous, requests: corpus.posts.length * STYLES.length * (corpus.intents.length + 1) };
}

export function makeGuidanceRegistration(corpus, frozen) {
  const counts = freshCounts(corpus);
  return { corpus: { file: CORPUS_FILE, sha256: CORPUS_SHA256 }, model: { variantId: VARIANT.id, model: VARIANT.model,
    identityHash: frozen.selection.identityHash, selectionSha256: hash(frozen.selectionBytes) }, runtimeSettings: frozen.selection.runtimeSettings,
    templateId: 'matches-category', templateHash: templateHash('matches-category'), cutoff: CUTOFF, rule: REGISTRATION_RULE,
    schedule: { seed: '0x6b0b2026', singleRequests: counts.decisionsPerStyle * STYLES.length, multiRequests: counts.posts * STYLES.length, totalRequests: counts.requests } };
}

export function checkGuidanceRegistration(result, corpus, frozen) {
  insist(result.status === 'registered' && result.requestsIssued === 0 && result.requests?.length === 0, 'Fresh guidance was already attempted; no retry is permitted');
  insist(result.schemaVersion === 1 && result.phase === 'fresh-guidance' && Number.isFinite(Date.parse(result.registeredAt))
    && result.registrationSha256 === hash(result.registration) && same(result.registration, makeGuidanceRegistration(corpus, frozen))
    && same(result.corpusSnapshot, corpus), 'Registered guidance binding differs');
  return result.registration;
}

/** A permanent exclusive claim also prevents two processes racing a registered result. */
export async function claimGuidanceAttempt(result, directory = OUT) {
  let handle;
  try { handle = await open(new URL(ATTEMPT_FILE, directory), 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Fresh guidance attempt already claimed; no rerun is permitted'); throw error; }
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, phase: 'fresh-guidance-attempt', registrationSha256: result.registrationSha256,
      registeredAt: result.registeredAt, claimedAt: new Date().toISOString() }, null, 2) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
}

function metricGroup(rows, cutoff) {
  const eligible = rows.filter(r => !r.ambiguous), near = eligible.filter(r => r.kind === 'near-miss' && !r.gold);
  const own = near.filter(r => r.intentId === r.authoredFor), subtle = eligible.filter(r => r.kind === 'subtle-positive' && r.gold);
  return { ...decisionMetrics(eligible, cutoff), optimal: optimalCutoff(eligible), ambiguousExcluded: rows.length - eligible.length,
    nearMissFalseHides: near.filter(r => r.probability >= cutoff).length, nearMissDecisions: near.length,
    ownNearMissFalseHides: own.filter(r => r.probability >= cutoff).length, ownNearMissDecisions: own.length,
    missedSubtlePositives: subtle.filter(r => r.probability < cutoff).length, subtlePositiveDecisions: subtle.length };
}

export function guidanceGates(pooled) {
  const short = pooled.find(r => r.style === 'short'), guided = pooled.find(r => r.style === 'guided'), exclusion = pooled.find(r => r.style === 'guidedExclusion');
  insist(short && guided && exclusion, 'All three primary styles are required');
  const check = (actual, reference, comparison) => ({ actual, reference, comparison, pass: comparison === '<' ? actual < reference : actual <= reference });
  const guidance = { checks: { errors: check(guided.errors, short.errors, '<'), nearMissFalseHides: check(guided.nearMissFalseHides, short.nearMissFalseHides, '<=') } };
  const not = { checks: { nearMissFalseHides: check(exclusion.nearMissFalseHides, guided.nearMissFalseHides, '<='), missedHides: check(exclusion.missedHides, guided.missedHides + 1, '<=') } };
  for (const part of [guidance, not]) part.supported = Object.values(part.checks).every(c => c.pass);
  return { guidance, exclusion: not };
}

/** All headline scores exclude ambiguity. This function sends no inference. */
export function analyzeGuidance(result) {
  insist(result.status === 'complete' && same(result.registration.rule, REGISTRATION_RULE) && result.registration.cutoff === CUTOFF, 'Complete registered guidance evidence is required');
  const corpus = result.corpusSnapshot, counts = freshCounts(corpus), posts = new Map(corpus.posts.map(p => [p.id, p]));
  const plan = buildGuidancePlan(corpus);
  insist(result.requests.length === plan.length && result.requestsIssued === plan.length, 'Incomplete or repeated guidance requests');
  const rows = [];
  for (const [index, request] of result.requests.entries()) {
    for (const [key, value] of Object.entries(plan[index])) insist(same(request[key], value), 'Recorded guidance request differs from registered plan');
    assertNoTruncation(request, result.registration.runtimeSettings.effectiveContext);
    insist(request.probabilities.length === request.intentIds.length && request.probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1), 'Invalid guidance probabilities');
    const post = posts.get(request.postId);
    for (const [n, intentId] of request.intentIds.entries()) rows.push({ mode: request.mode, style: request.style, postId: post.id, intentId,
      gold: post.gold[intentId], ambiguous: post.ambiguousFor.includes(intentId), authoredFor: post.authoredFor, kind: post.kind,
      probability: request.probabilities[n], label: request.labels[n] });
  }
  const metrics = [], requestStats = [], interference = [], interferenceFlips = [], bounced = [], nearMissPaired = [];
  const bySingle = new Map(rows.filter(r => r.mode === 'single').map(r => [JSON.stringify([r.style, r.postId, r.intentId]), r]));
  for (const style of STYLES) for (const intentId of ['all', ...corpus.intents.map(i => i.id)]) {
    const filter = r => r.style === style && (intentId === 'all' || r.intentId === intentId);
    for (const mode of ['single', 'six-filter']) metrics.push({ mode, style, intentId, ...metricGroup(rows.filter(r => r.mode === mode && filter(r)), CUTOFF) });
    const ownPositives = rows.filter(r => r.mode === 'single' && filter(r) && r.authoredFor === r.intentId && r.gold);
    const failures = ownPositives.filter(r => r.probability < CUTOFF).map(r => ({ postId: r.postId, text: posts.get(r.postId).text, kind: r.kind, probability: r.probability, cutoff: CUTOFF, label: r.label }));
    bounced.push({ style, intentId, n: ownPositives.length, caught: ownPositives.length - failures.length, missed: failures.length,
      subtleMissed: failures.filter(r => r.kind === 'subtle-positive').length, failures });
    const comparisons = rows.filter(r => r.mode === 'six-filter' && filter(r)).map(r => {
      const single = bySingle.get(JSON.stringify([r.style, r.postId, r.intentId])); insist(single, 'Missing guidance single/multi pair');
      return { ...r, singleProbability: single.probability, delta: Math.abs(r.probability - single.probability),
        flip: (r.probability >= CUTOFF) !== (single.probability >= CUTOFF) };
    });
    for (const population of ['headline', 'allIncludingAmbiguous']) {
      const compared = comparisons.filter(r => population !== 'headline' || !r.ambiguous);
      interference.push({ style, intentId, population, n: compared.length, medianAbsDelta: median(compared.map(r => r.delta)),
        worstAbsDelta: Math.max(0, ...compared.map(r => r.delta)), flips: compared.filter(r => r.flip).length });
    }
    if (intentId === 'all') for (const r of comparisons.filter(r => r.flip)) interferenceFlips.push({ style, postId: r.postId, intentId: r.intentId,
      text: posts.get(r.postId).text, gold: r.gold, ambiguous: r.ambiguous, singleProbability: r.singleProbability, multiProbability: r.probability,
      singleCorrect: (r.singleProbability >= CUTOFF) === r.gold, multiCorrect: (r.probability >= CUTOFF) === r.gold });
  }
  for (const style of STYLES) for (const mode of ['single', 'six-filter']) for (const intentId of mode === 'single' ? ['all', ...corpus.intents.map(i => i.id)] : ['all']) {
    const requests = result.requests.filter(r => r.style === style && r.mode === mode && (intentId === 'all' || r.intentIds[0] === intentId));
    const tokens = requests.map(r => r.usage.input_tokens);
    requestStats.push({ mode, style, intentId, n: requests.length, medianMs: median(requests.map(r => r.wallMs)),
      medianInputTokens: median(tokens), meanInputTokens: tokens.reduce((a, b) => a + b, 0) / tokens.length,
      minInputTokens: Math.min(...tokens), maxInputTokens: Math.max(...tokens) });
  }
  for (const [style, reference, comparison] of [['guided', 'short', 'guided-vs-short'], ['guidedExclusion', 'guided', 'exclusion-vs-guided']]) {
    const near = rows.filter(r => r.mode === 'single' && r.style === style && !r.ambiguous && r.kind === 'near-miss' && !r.gold);
    const deltas = near.map(r => ({ ...r, before: bySingle.get(JSON.stringify([reference, r.postId, r.intentId])).probability >= CUTOFF, after: r.probability >= CUTOFF }));
    nearMissPaired.push({ comparison, n: near.length, newFalseHides: deltas.filter(r => !r.before && r.after).length,
      repairedFalseHides: deltas.filter(r => r.before && !r.after).length,
      ownNewFalseHides: deltas.filter(r => r.authoredFor === r.intentId && !r.before && r.after).length,
      ownRepairedFalseHides: deltas.filter(r => r.authoredFor === r.intentId && r.before && !r.after).length });
  }
  const gates = guidanceGates(metrics.filter(r => r.mode === 'single' && r.intentId === 'all'));
  return { counts, intents: corpus.intents, metrics, gates, requestStats, interference, interferenceFlips, bounced, nearMissPaired };
}

async function save(file, value) {
  await mkdir(LOCAL, { recursive: true }); const temporary = new URL(`guidance-${file}.tmp`, LOCAL);
  await writeFile(temporary, JSON.stringify(publicValue(value), null, 2) + '\n'); await rename(temporary, new URL(file, OUT));
}
async function protectedHashes() {
  const names = (await readdir(OUT)).filter(n => n.startsWith('decision-') && n.endsWith('.json') && !n.startsWith('decision-guidance-fresh-'));
  return Object.fromEntries(await Promise.all(names.map(async n => [`docs/benchmarks/data/${n}`, hash(await readFile(new URL(n, OUT)))])));
}
async function checkProtected(before) {
  for (const [name, digest] of Object.entries(before)) insist(hash(await readFile(new URL(name, ROOT))) === digest, `Protected receipt changed: ${name}`);
}
async function frozenFiles() {
  const selectionBytes = await readFile(new URL('decision-1b-selection-llama-d1-2b-q8.json', OUT));
  const identity = JSON.parse(await readFile(new URL('decision-1b-identity-llama-d1-2b-q8.json', OUT))), selection = JSON.parse(selectionBytes);
  insist(same(identity.variant, VARIANT) && selection.identityHash === hash(identity.identity) && selection.cutoff === CUTOFF
    && selection.templateId === 'matches-category' && selection.templateHash === templateHash('matches-category'), 'Frozen guidance model binding differs');
  return { selection, selectionBytes, identity };
}

export async function registerGuidance() {
  const corpus = await loadFreshCorpus(), frozen = await frozenFiles(), registration = makeGuidanceRegistration(corpus, frozen);
  const value = { schemaVersion: 1, phase: 'fresh-guidance', status: 'registered', registeredAt: new Date().toISOString(),
    registration, registrationSha256: hash(registration), corpusSnapshot: corpus, protectedHashes: await protectedHashes(), requestsIssued: 0, activeRequest: null, requests: [] };
  const handle = await open(new URL(RESULT_FILE, OUT), 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  console.log(`Registered fresh guidance rule before inference: ${value.registrationSha256}`);
}

export async function scoreGuidance() {
  const bytes = await readFile(new URL(RESULT_FILE, OUT)), result = JSON.parse(bytes), analyzed = analyzeGuidance(result);
  await checkProtected(result.protectedHashes); insist(same(await loadFreshCorpus(), result.corpusSnapshot), 'Fresh corpus snapshot differs');
  await save(SUMMARY_FILE, { schemaVersion: 1, phase: 'fresh-guidance', status: 'complete', resultFile: RESULT_FILE, resultSha256: hash(bytes),
    registrationSha256: result.registrationSha256, cutoff: CUTOFF, ...analyzed, immutableEvidenceUnchanged: true });
}

export async function runGuidance() {
  const result = JSON.parse(await readFile(new URL(RESULT_FILE, OUT))), corpus = await loadFreshCorpus(), frozen = await frozenFiles();
  checkGuidanceRegistration(result, corpus, frozen);
  await checkProtected(result.protectedHashes);
  await claimGuidanceAttempt(result);
  // The permanent running state is written before even loading the model.
  result.status = 'running'; result.startedAt = new Date().toISOString(); await save(RESULT_FILE, result);
  let failure;
  try {
    const entries = await inventory(); assertPreset(VARIANT, entries.find(e => e.id === VARIANT.model));
    if (!entries.some(e => e.id === VARIANT.model && active(e))) await json(`${ENDPOINTS.llama}/models/load`, { model: VARIANT.model });
    const { settings, props } = await probeSettings(frozen.selection, frozen.identity);
    const digest = createHash('sha256'); for await (const chunk of createReadStream(props.model_path)) digest.update(chunk);
    insist(digest.digest('hex') === frozen.identity.identity.sha256, 'Fresh guidance GGUF identity differs');
    result.runtimeSettings = settings; result.environment = publicValue(await environment());
    const plan = buildGuidancePlan(corpus), posts = new Map(corpus.posts.map(p => [p.id, p]));
    insist(plan.length === result.registration.schedule.totalRequests, 'Registered guidance request count differs');
    for (const request of plan) {
      if (request.index % 100 === 0) { await probeSettings(frozen.selection, frozen.identity); console.log(`${new Date().toISOString()} fresh guidance ${request.index}/${plan.length}`); }
      result.activeRequest = { index: request.index, style: request.style, mode: request.mode, postId: request.postId }; result.requestsIssued++;
      // Before-send journaling prevents an uncertain request from being replayed.
      if (request.index === 0 || request.index % 25 === 0) await save(RESULT_FILE, result);
      const start = performance.now(), response = await json(`${ENDPOINTS.llama}/v1/systemone`, { model: VARIANT.model, state: posts.get(request.postId).text, questions: request.questions });
      const wallMs = performance.now() - start; assertNoTruncation(response, settings.effectiveContext);
      result.requests.push({ ...request, probabilities: parseProbabilities(response, request.intentIds.length), usage: response.usage, wallMs });
      result.activeRequest = null;
      if (result.requests.length % 25 === 0) await save(RESULT_FILE, result);
    }
    await probeSettings(frozen.selection, frozen.identity); await checkProtected(result.protectedHashes);
    result.status = 'complete'; result.finishedAt = new Date().toISOString();
  } catch (error) { failure = error; result.status = 'failed'; result.error = publicValue(error.message); }
  finally {
    try { await unloadProbe(); } catch (error) { failure ??= error; result.status = 'failed'; result.error = publicValue(error.message); }
    await save(RESULT_FILE, result);
  }
  if (failure) throw new Error(`Fresh guidance failed; no rerun permitted: ${publicValue(failure.message)}`, { cause: failure });
  await scoreGuidance(); console.log(`Completed one fresh guidance run: ${result.requests.length} requests; Llama unloaded.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !['register', 'run', 'score'].includes(command)) throw new Error('Usage: node scripts/decision-eval/guidance-fresh.mjs register|run|score');
  ({ register: registerGuidance, run: runGuidance, score: scoreGuidance }[command])().catch(error => { console.error(publicValue(error.message)); process.exitCode = 1; });
}
