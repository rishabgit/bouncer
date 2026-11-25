import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual as same } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CORPUS_HASHES, loadCorpora, validateSelection } from './corpora.mjs';
import { TEMPLATES, templateHash } from './templates.mjs';
import { variantById } from './registry.mjs';
import { publicValue, LOCAL } from './runtime.mjs';
import { environment } from './observations.mjs';
import { loadFreshCorpus, CORPUS_FILE, CORPUS_SHA256, CUTOFF } from './guidance-fresh.mjs';
import { recordedBaseline, validationGates } from './validation.mjs';
import { caseIdentityHash } from './baselines.mjs';
import { scoreRows } from './metrics.mjs';
import { capacityLabels, capacityFreshPlan, analyzeCapacityFresh, sentenceRecommendation, capacityProductRule } from './capacity-analysis.mjs';

const OUT = new URL('../../docs/benchmarks/data/', import.meta.url), ROOT = new URL('../../', import.meta.url);
export const RESULT_FILE = 'decision-capacity-result.json', SUMMARY_FILE = 'decision-capacity-summary.json';
export const CAPACITY_RULE = Object.freeze({
  switch: { baselineGuidedErrors: 66, freshGuidedErrorsMax: 33,
    originalValidation: { newFalseHidesMax: 1, exactVectorsAtLeastBrowser: true, correctHideShowDeficitMax: 1, bothCorporaRequired: true },
    warm10MedianMsMax: 250, allRequired: true, otherwise: 'd1-2B stays' },
  sentence: { baselineGuidedErrors: 66, errorsStrictlyFewer: true, nearMissFalseHidesMax: 18, allRequired: true },
  nearMissPopulation: 'Negative-gold non-ambiguous pairs on near-miss posts, including cross-filter pairs; own-filter near misses reported separately',
  primaryFreshMode: 'single', ambiguousExcluded: true, rubricIsUpperBound: true, discoveryOnlySelection: true,
  originalValidationIsExploratory: true, noRetuning: true, noRelabelling: true, noQualityReruns: true, speedRepetitions: 3,
});
const IDS = ['llama-d1-3b-q8', 'llama-kev-4b-q8', 'llama-clef-flash-q4km'];
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const insist = (condition, message) => { if (!condition) throw new Error(message); };
const read = async name => JSON.parse(await readFile(new URL(name, OUT)));
const name = (kind, id) => `decision-capacity-${kind}-${id}.json`;
const median = values => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length ? s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 : null; };
const stats = values => { const s = [...values].sort((a, b) => a - b); return { n: s.length, median: median(s), p90: s[Math.ceil(s.length * .9) - 1] }; };
async function save(file, value) {
  await mkdir(LOCAL, { recursive: true }); const temp = new URL(`capacity-${file}.tmp`, LOCAL);
  await writeFile(temp, JSON.stringify(publicValue(value), null, 2) + '\n'); await rename(temp, new URL(file, OUT));
}
async function newFile(file, value) {
  const handle = await open(new URL(file, OUT), 'wx');
  try { await handle.writeFile(JSON.stringify(publicValue(value), null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
}
async function protectedHashes() {
  const names = (await readdir(OUT)).filter(n => n.startsWith('decision-') && n.endsWith('.json') && !n.startsWith('decision-capacity-'));
  return Object.fromEntries(await Promise.all(names.map(async n => [`docs/benchmarks/data/${n}`, hash(await readFile(new URL(n, OUT)))])));
}
async function checkProtected(before) {
  for (const [file, sha] of Object.entries(before)) insist(hash(await readFile(new URL(file, ROOT))) === sha, `Protected receipt changed: ${file}`);
}

async function baseline() {
  const selectionFile = 'decision-1b-selection-llama-d1-2b-q8.json', guidedResultFile = 'decision-guidance-fresh-result.json', guidedSummaryFile = 'decision-guidance-fresh-summary.json';
  const selectionBytes = await readFile(new URL(selectionFile, OUT)), selection = JSON.parse(selectionBytes);
  const identity = (await read('decision-1b-identity-llama-d1-2b-q8.json')).identity;
  const guidedBytes = await readFile(new URL(guidedResultFile, OUT)), guided = JSON.parse(guidedBytes);
  const summaryBytes = await readFile(new URL(guidedSummaryFile, OUT)), summary = JSON.parse(summaryBytes);
  const metric = summary.metrics.find(r => r.mode === 'single' && r.style === 'guided' && r.intentId === 'all');
  insist(selection.cutoff === CUTOFF && selection.templateId === 'matches-category' && selection.identityHash === hash(identity)
    && guided.status === 'complete' && summary.resultSha256 === hash(guidedBytes) && summary.registrationSha256 === guided.registrationSha256
    && metric.errors === 66 && metric.nearMissFalseHides === 18 && metric.n === 482, 'Recorded d1-2B guidance baseline differs');
  return { selection, identity, guided, registration: { selectionFile, selectionSha256: hash(selectionBytes), identityHash: selection.identityHash,
    guidedResultFile, guidedResultSha256: hash(guidedBytes), guidedSummaryFile, guidedSummarySha256: hash(summaryBytes), guidedErrors: 66, nearMissFalseHides: 18 } };
}

export async function makeCapacityRegistration() {
  const { CAPACITY_VARIANTS, CAPACITY_ARTIFACTS } = await import('./capacity-runtime.mjs'), b = await baseline();
  insist(same(CAPACITY_VARIANTS.map(v => v.id), IDS), 'Capacity model matrix differs');
  await loadCorpora('discovery'); await loadFreshCorpus();
  const questionEncoding = 'Use the frozen template unchanged; insert the style text verbatim into its JSON-quoted category slot. Rubric contains the full gold-defining rubric. Sentence is guided + ". " + the first complete Keep sentence verbatim.';
  return { corpora: { original: CORPUS_HASHES, fresh: { file: CORPUS_FILE, sha256: CORPUS_SHA256 } },
    models: CAPACITY_VARIANTS.map(v => ({ id: v.id, model: v.model, format: v.format, artifact: CAPACITY_ARTIFACTS[v.id] })),
    d1Baseline: b.registration, templates: TEMPLATES.map(t => ({ id: t.id, hash: templateHash(t.id) })),
    partA: { styles: ['sentence', 'rubric'], templateId: 'matches-category', cutoff: CUTOFF, questionEncoding },
    partB: { styles: ['short', 'guided', 'rubric'], freshPrimaryMode: 'single', cutoffsFrom: 'Original 88-case discovery only, existing exact-vector/FH/midpoint algorithm', questionEncoding },
    freshSchedule: { seed: '0x0cab2026', partARequests: 1176, perLargerModelRequests: 1764 }, rule: CAPACITY_RULE };
}

export async function registerCapacity() {
  const registration = await makeCapacityRegistration();
  const value = { schemaVersion: 1, phase: 'decision-capacity', status: 'registered', registeredAt: new Date().toISOString(),
    registration, registrationSha256: hash(registration), protectedHashes: await protectedHashes(), stage: 'registered; no inference' };
  await newFile(RESULT_FILE, value);
  console.log(`Registered capacity product rule before inference: ${value.registrationSha256}`);
}

export function checkCapacityRegistration(result, expected) {
  insist(result.status === 'registered' && result.startedAt === undefined, 'Capacity run already attempted; no quality rerun permitted');
  insist(result.schemaVersion === 1 && result.phase === 'decision-capacity' && Number.isFinite(Date.parse(result.registeredAt))
    && result.registrationSha256 === hash(result.registration) && same(result.registration, expected), 'Registered capacity rule or evidence binding differs');
}

async function observe(runtime, v, selection, identity) {
  await runtime.verifyIdentity(v, identity); const settings = await runtime.settings(v);
  validateSelection(selection, { id: v.id, templateId: selection.templateId }, CORPUS_HASHES, templateHash(selection.templateId), settings);
  return settings;
}

async function freshRun(v, styles, selectionFile, identity, registrationSha256, runtime, baselineGuided) {
  const selectionBytes = await readFile(new URL(selectionFile, OUT)), selection = JSON.parse(selectionBytes), file = name('fresh', v.id);
  const corpus = await loadFreshCorpus(), plan = capacityFreshPlan(corpus, styles, selection.templateId);
  const result = { schemaVersion: 1, phase: 'decision-capacity-fresh', status: 'running', variant: v, registrationSha256,
    selectionFile, selectionSha256: hash(selectionBytes), selection, identityHash: hash(identity), corpusSha256: CORPUS_SHA256,
    corpusSnapshot: corpus, styleLabels: capacityLabels(corpus), styles, startedAt: new Date().toISOString(), requestsIssued: 0, activeRequest: null, requests: [],
    ...(baselineGuided ? { baselineGuided } : {}) };
  await newFile(file, result);
  let failure;
  try {
    await runtime.state(v, { allowOwn: true }); await runtime.load(v); result.runtimeSettings = await observe(runtime, v, selection, identity);
    result.environment = publicValue(await environment()); const posts = new Map(corpus.posts.map(p => [p.id, p]));
    for (const request of plan) {
      if (request.index % 100 === 0) { await observe(runtime, v, selection, identity); console.log(`${new Date().toISOString()} capacity fresh ${v.id} ${request.index}/${plan.length}`); }
      result.activeRequest = { index: request.index, mode: request.mode, style: request.style, postId: request.postId }; result.requestsIssued++;
      const output = await runtime.requestQuestions(v, posts.get(request.postId).text, request.questions, selection.runtimeSettings.effectiveContext);
      result.requests.push({ ...request, ...output }); result.activeRequest = null;
      if (result.requests.length % 25 === 0) await save(file, result);
    }
    await observe(runtime, v, selection, identity); result.status = 'complete'; result.finishedAt = new Date().toISOString();
  } catch (error) { failure = error; result.status = 'failed'; result.error = publicValue(error.message); }
  finally { try { await runtime.unload(v); } catch (error) { failure ??= error; result.status = 'failed'; result.error = publicValue(error.message); } await save(file, result); }
  if (failure) throw failure;
  return result;
}

async function validationRun(v, selection, identity, registrationSha256, runtime) {
  const selectionFile = name('selection', v.id), selectionSha256 = hash(await readFile(new URL(selectionFile, OUT)));
  await runtime.state(v, { allowOwn: true }); let current, file, failure;
  try {
    await runtime.load(v); const runtimeSettings = await observe(runtime, v, selection, identity);
    const corpora = await loadCorpora({ split: 'validation', selection, variant: { id: v.id, templateId: selection.templateId }, templateHash: selection.templateHash, runtimeSettings });
    const baselineBytes = await readFile(new URL('decision-baselines.json', OUT)), doc = JSON.parse(baselineBytes);
    for (const [corpus, sourceCorpus] of [['isolation', 'native-isolation-holdout.json'], ['migration', 'native-migration-validation.json']]) {
      const cases = corpora.cases.filter(c => c.sourceCorpus === sourceCorpus), browser = recordedBaseline(cases, doc, 'browser', corpus), qat = recordedBaseline(cases, doc, 'textOnlyQat', corpus);
      file = name(`validation-${v.id}`, corpus);
      current = { schemaVersion: 1, phase: 'decision-capacity-validation', exploratory: true, preRegisteredClaim: false, status: 'running',
        variant: v, corpus, sourceCorpus, corpusSha256: CORPUS_HASHES[sourceCorpus], corpusHashes: CORPUS_HASHES, registrationSha256,
        selectionFile, selectionSha256, selection, identityHash: hash(identity), runtimeSettings, baselineSha256: hash(baselineBytes),
        baseline: { browser: { scores: browser.scores, sourceIds: browser.sourceIds }, textOnlyQat: qat ? { scores: qat.scores, sourceIds: qat.sourceIds,
          contextTokens: doc.sources.currentTextOnlyQatContract.contextTokens, runtime: doc.sources.currentTextOnlyQatContract.runtime } : null },
        environment: publicValue(await environment()), startedAt: new Date().toISOString(), requestsIssued: 0, activeCase: null, rows: [] };
      await newFile(file, current);
      for (const c of cases) {
        current.requestsIssued++; current.activeCase = `${c.corpus}:${c.id}`;
        current.rows.push({ id: c.id, corpus: c.corpus, sourceCorpus, filters: c.filters, expected: c.expected, caseIdentitySha256: caseIdentityHash(c),
          ...await runtime.request(v, c.text, c.filters, selection.templateId, runtimeSettings.effectiveContext) }); current.activeCase = null;
        if (current.rows.length % 20 === 0) await save(file, current);
      }
      await observe(runtime, v, selection, identity);
      current.atFrozen = scoreRows(current.rows, selection.cutoff, browser.map); current.at05 = scoreRows(current.rows, .5, browser.map);
      current.pairedVsTextOnlyQat = qat ? scoreRows(current.rows, selection.cutoff, qat.map) : null;
      Object.assign(current, validationGates(current.atFrozen, browser.scores)); current.status = 'complete'; current.finishedAt = new Date().toISOString(); await save(file, current);
      console.log(`${new Date().toISOString()} capacity original validation ${v.id} ${corpus}: ${current.pass ? 'PASS' : 'FAIL'}`);
    }
  } catch (error) { failure = error; if (current?.status === 'running') { current.status = 'failed'; current.error = publicValue(error.message); await save(file, current); } }
  finally { try { await runtime.unload(v); } catch (error) { failure ??= error; } }
  if (failure) throw failure;
}

async function archiveCapacity() {
  const raw = new URL('raw/capacity/', LOCAL), tar = new URL('decision-capacity-raw.tar', LOCAL); await mkdir(raw, { recursive: true });
  await promisify(execFile)('tar', ['-cf', fileURLToPath(tar), '-C', fileURLToPath(raw), '.']);
  await save('decision-capacity-archive.json', { schemaVersion: 1, path: 'scripts/decision-eval/.tmp/decision-capacity-raw.tar',
    sha256: hash(await readFile(tar)), bytes: (await stat(tar)).size });
}

export async function scoreCapacity() {
  const runtime = await import('./capacity-runtime.mjs'), root = await read(RESULT_FILE), b = await baseline(), corpus = await loadFreshCorpus();
  insist(root.status === 'complete' && root.registrationSha256 === hash(root.registration) && same(root.registration, await makeCapacityRegistration()), 'Complete registered capacity run required');
  await checkProtected(root.protectedHashes);
  const partAFile = name('fresh', 'llama-d1-2b-q8'), partA = await read(partAFile);
  insist(partA.status === 'complete' && partA.requestsIssued === 1176 && partA.requests.length === 1176, 'Part A coverage differs');
  const historicalGuided = b.guided.requests.filter(r => r.style === 'guided');
  const matrix = analyzeCapacityFresh(corpus, [...historicalGuided, ...partA.requests], ['guided', 'sentence', 'rubric'], b.selection.templateId, b.selection.cutoff);
  const summary = { schemaVersion: 1, phase: 'decision-capacity', status: 'complete', resultFile: RESULT_FILE,
    resultSha256: hash(await readFile(new URL(RESULT_FILE, OUT))), registrationSha256: root.registrationSha256,
    partA: { file: partAFile, sha256: hash(await readFile(new URL(partAFile, OUT))), selection: b.selection, matrix, sentenceRule: sentenceRecommendation(matrix) }, models: [] };
  for (const variant of runtime.CAPACITY_VARIANTS) {
    const identity = (await read(name('identity', variant.id))).identity, selection = await read(name('selection', variant.id)), discovery = await read(name('discovery', variant.id));
    const chosen = discovery.templates.find(t => t.id === selection.templateId), runs = await Promise.all([0, 1, 2].map(r => read(name(`speed-r${r}`, variant.id))));
    const sources = await Promise.all([0, 1, 2].map(async r => { const file = name(`speed-r${r}`, variant.id); return { file, sha256: hash(await readFile(new URL(file, OUT))) }; }));
    const performance = { warm3: stats(runs.flatMap(r => r.cells[3].rows.map(r => r.wallMs))), warm10: stats(runs.flatMap(r => r.cells[10].rows.map(r => r.wallMs))),
      coldMedianMs: median(runs.map(r => (r.coldLoadMs ?? 0) + r.cold.wallMs)), steadyRssBytes: median(runs.map(r => r.steadyMemory.medianRssBytes)),
      steadyFootprintBytes: median(runs.map(r => r.steadyMemory.medianFootprintBytes)), peakRssBytes: Math.max(...runs.map(r => r.runMemory.peakRssBytes)),
      peakFootprintBytes: Math.max(...runs.map(r => r.runMemory.peakFootprintBytes)), identicalProbabilities: runs.every(r => r.identicalProbabilities), disk: identity.disk, sources };
    const validation = [];
    for (const corpus of ['isolation', 'migration']) {
      const file = name(`validation-${variant.id}`, corpus), record = await read(file); insist(record.status === 'complete', 'Incomplete capacity original validation');
      validation.push({ corpus, file, sha256: hash(await readFile(new URL(file, OUT))), scores: record.atFrozen, at05: record.at05,
        browser: record.baseline.browser.scores, textOnlyQat: record.baseline.textOnlyQat, gates: record.gates, pass: record.pass });
    }
    const freshFile = name('fresh', variant.id), fresh = await read(freshFile); insist(fresh.status === 'complete' && fresh.requestsIssued === 1764 && fresh.requests.length === 1764, 'Larger fresh coverage differs');
    const freshMatrix = analyzeCapacityFresh(corpus, fresh.requests, ['short', 'guided', 'rubric'], selection.templateId, selection.cutoff);
    const metric = freshMatrix.metrics.find(r => r.mode === 'single' && r.style === 'guided' && r.intentId === 'all');
    summary.models.push({ variant, identity, selection, discovery: { chosen: chosen.optimized.scores, at05: chosen.at05, loo: selection.loo }, performance, validation,
      fresh: { file: freshFile, sha256: hash(await readFile(new URL(freshFile, OUT))), matrix: freshMatrix }, productRule: capacityProductRule(metric.errors, validation, performance.warm10.median) });
  }
  summary.immutableEvidenceUnchanged = true;
  summary.archive = { file: 'decision-capacity-archive.json', sha256: hash(await readFile(new URL('decision-capacity-archive.json', OUT))) };
  await save(SUMMARY_FILE, summary);
}

export async function runCapacity() {
  const result = await read(RESULT_FILE), expected = await makeCapacityRegistration(); checkCapacityRegistration(result, expected); await checkProtected(result.protectedHashes);
  await newFile('decision-capacity-attempt.json', { schemaVersion: 1, registrationSha256: result.registrationSha256, registeredAt: result.registeredAt, claimedAt: new Date().toISOString() });
  result.status = 'running'; result.startedAt = new Date().toISOString(); await save(RESULT_FILE, result);
  const runtime = await import('./capacity-runtime.mjs'), pipeline = await import('./capacity-pipeline.mjs'); let failure;
  const stage = async text => { result.stage = text; await save(RESULT_FILE, result); console.log(`${new Date().toISOString()} capacity ${text}`); };
  try {
    const b = await baseline(); await stage('Part A d1-2B sentence and rubric');
    await freshRun(variantById('llama-d1-2b-q8'), ['sentence', 'rubric'], b.registration.selectionFile, b.identity, result.registrationSha256, runtime,
      { file: b.registration.guidedResultFile, sha256: b.registration.guidedResultSha256, style: 'guided' });
    for (const v of runtime.CAPACITY_VARIANTS) { await stage(`discovery ${v.id}`); await pipeline.prepareCapacity(v); await pipeline.discoveryCapacity(v); }
    for (let r = 0; r < 3; r++) {
      const variants = runtime.CAPACITY_VARIANTS, order = [...variants.slice(r), ...variants.slice(0, r)];
      for (const v of order) { await stage(`speed ${v.id} rotation ${r}`); await pipeline.performanceCapacity(v, r, order.map(v => v.id)); }
    }
    for (const v of runtime.CAPACITY_VARIANTS) {
      const identity = (await read(name('identity', v.id))).identity, selection = await read(name('selection', v.id));
      await stage(`exploratory original validation ${v.id}`); await validationRun(v, selection, identity, result.registrationSha256, runtime);
      await stage(`fresh filters ${v.id}`); await freshRun(v, ['short', 'guided', 'rubric'], name('selection', v.id), identity, result.registrationSha256, runtime);
    }
    await checkProtected(result.protectedHashes); await archiveCapacity(); result.status = 'complete'; result.stage = 'complete'; result.finishedAt = new Date().toISOString();
  } catch (error) { failure = error; result.status = 'failed'; result.error = publicValue(error.message); }
  await save(RESULT_FILE, result);
  if (failure) throw failure;
  await scoreCapacity(); console.log('Capacity experiment complete; all inference was serial and every model unloaded.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !['register', 'run', 'score'].includes(command)) throw new Error('Usage: node scripts/decision-eval/capacity.mjs register|run|score');
  ({ register: registerCapacity, run: runCapacity, score: scoreCapacity }[command])().catch(error => { console.error(publicValue(error.message)); process.exitCode = 1; });
}
