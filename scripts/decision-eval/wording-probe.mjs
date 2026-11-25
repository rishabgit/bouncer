import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { CORPUS_HASHES, loadCorpora, validateSelection } from './corpora.mjs';
import { caseIdentityHash } from './baselines.mjs';
import { variantById, ENDPOINTS } from './registry.mjs';
import { TEMPLATES, RAGE_DEFINITION, templateHash } from './templates.mjs';
import { json, publicValue, parseProbabilities, assertNoTruncation, assertPreset, normalizedSettings, assertPinned, LOCAL } from './runtime.mjs';
import { environment } from './observations.mjs';
import { decisionMetrics, optimalCutoff, mcnemar } from './wording-metrics.mjs';

const OUT = new URL('../../docs/benchmarks/data/', import.meta.url);
const ROOT = new URL('../../', import.meta.url);
const FILES = { raw: 'decision-wording-probe-raw.json', summary: 'decision-wording-probe-summary.json', flips: 'decision-wording-probe-flips.json' };
const VARIANT = variantById('llama-d1-2b-q8');
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const insist = (condition, message) => { if (!condition) throw new Error(message); };
export const INTENTS = Object.freeze([
  { id: 'crypto', D: 'cryptocurrency investing or promotion', K1: 'crypto', K2: 'crypto shilling', exclusion: 'not news about crypto regulation or prices' },
  { id: 'food', D: 'food and cooking', K1: 'food', K2: 'cooking' },
  { id: 'rage', D: 'rage bait', K1: 'ragebait', K2: 'rage bait' },
  { id: 'fitness', D: 'exercise routines and fitness training', K1: 'fitness', K2: 'gym' },
  { id: 'sports', D: 'sports results or commentary', K1: 'sports', K2: 'sports talk' },
  { id: 'politics', D: 'government policy or election politics', K1: 'politics', K2: 'elections', exclusion: 'not personal stories that only mention a policy' },
  { id: 'celebrity', D: 'gossip about famous entertainers or celebrities', K1: 'celebrity gossip', K2: 'celebs' },
  { id: 'promotion', D: "promotion of the author's own product or paid service", K1: 'self promotion', K2: 'self promo', exclusion: "not recommending someone else's product" },
  { id: 'ai', D: 'exaggerated claims that artificial intelligence will solve everything', K1: 'AI hype', K2: 'AI', exclusion: 'not ordinary news or use of AI' },
  { id: 'engagement', D: 'requests for likes, reposts, or replies to boost engagement', K1: 'engagement bait', K2: 'engagement farming' },
  { id: 'drama', D: 'personal feuds or public insults between people', K1: 'drama', K2: 'beef' },
].map(intent => Object.freeze({ ...intent, ...(intent.exclusion ? { X: `${intent.D}, ${intent.exclusion}` } : {}) })));
const byPhrase = new Map(INTENTS.map(intent => [intent.D, intent]));

/** Explicit definition controls apply only to this probe, leaving production questions unchanged. */
export function probeQuestionSpec(intents, variant) {
  insist(['D', 'K1', 'K2', 'X', 'Rdef'].includes(variant), 'Unknown wording variant');
  const template = TEMPLATES.find(t => t.id === 'matches-category');
  const labels = [], appendDefinition = [], questions = {};
  for (const [index, phrase] of intents.entries()) {
    const intent = byPhrase.get(phrase);
    insist(intent, `Unknown intent phrase: ${phrase}`);
    insist(variant !== 'Rdef' || intent.id === 'rage', 'Rdef is rage-only');
    const label = variant === 'Rdef' ? 'rage bait' : intent[variant];
    insist(typeof label === 'string', `Variant ${variant} unavailable for ${phrase}`);
    const defined = intent.id === 'rage' && ['D', 'Rdef'].includes(variant);
    const base = template.instructions.replace('{category}', () => JSON.stringify(label));
    questions[`f${index}`] = { type: 'noul', instructions: defined ? `${base}\n\n${RAGE_DEFINITION}` : base };
    labels.push(label); appendDefinition.push(defined);
  }
  return { labels, appendDefinition, questions };
}

export async function loadProbeCases(selection) {
  const discovery = await loadCorpora('discovery');
  const later = await loadCorpora({ split: 'validation', selection, variant: { id: VARIANT.id, templateId: selection.templateId },
    templateHash: selection.templateHash, runtimeSettings: selection.runtimeSettings });
  return [...discovery.cases.map(c => ({ ...c, dataset: 'discovery', sourceCorpus: c.corpus === 'rage' ? 'eval-corpus.ts' : 'native-benchmark-corpus.ts' })),
    ...later.cases.map(c => ({ ...c, dataset: c.sourceCorpus === 'native-isolation-holdout.json' ? 'isolation' : 'migration' }))]
    .map(c => ({ key: `${c.dataset}:${c.corpus}:${c.id}`, corpus: c.dataset, sourceCorpus: c.sourceCorpus, id: c.id,
      text: c.text, filters: c.filters, expected: c.expected, caseIdentitySha256: caseIdentityHash(c) }));
}

export function buildProbeRequests(cases, seed = 0xdec1b032) {
  const requests = [];
  for (const c of cases) {
    for (const intent of c.filters) {
      insist(byPhrase.has(intent), `Unmapped intent: ${intent}`);
      const variants = ['D', 'K1', 'K2', ...(byPhrase.get(intent).X ? ['X'] : []), ...(intent === 'rage bait' ? ['Rdef'] : [])];
      for (const variant of variants) requests.push({ mode: 'single', variant, caseKey: c.key, intents: [intent], ...probeQuestionSpec([intent], variant) });
    }
    if (c.filters.length > 1) for (const variant of ['D', 'K1']) requests.push({ mode: 'multi', variant, caseKey: c.key,
      intents: c.filters, ...probeQuestionSpec(c.filters, variant) });
  }
  // Fixed Fisher–Yates shuffle disperses repeated posts/controls across styles.
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
  for (let n = requests.length - 1; n > 0; n--) { const k = Math.floor(random() * (n + 1)); [requests[n], requests[k]] = [requests[k], requests[n]]; }
  return requests.map((request, index) => ({ index, ...request }));
}

const median = values => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length ? s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 : null; };
const groups = (rows, intentKey = 'intent') => {
  const buckets = new Map();
  for (const row of rows) for (const intent of ['all', row[intentKey]]) for (const corpus of ['all', row.corpus]) {
    const key = JSON.stringify([intent, corpus]);
    if (!buckets.has(key)) buckets.set(key, { intent, corpus, rows: [] });
    buckets.get(key).rows.push(row);
  }
  return [...buckets.values()];
};

/** Re-score stored probe probabilities only; no model calls or frozen-selection writes. */
export function analyzeProbe(raw) {
  insist(raw.status === 'complete' && raw.phase === 'exploratory-label-wording', 'A complete exploratory probe is required');
  const cases = new Map(raw.cases.map(c => [c.key, c]));
  const singles = [], multis = [], requestStats = [];
  for (const request of raw.requests) {
    const c = cases.get(request.caseKey);
    insist(c && request.probabilities.length === request.intents.length, 'Invalid recorded probe request');
    const unique = new Set();
    for (const [index, intent] of request.intents.entries()) {
      const filterIndex = c.filters.indexOf(intent); insist(filterIndex >= 0 && !unique.has(intent), 'Invalid recorded intent'); unique.add(intent);
      const row = { variant: request.variant, intent, corpus: c.corpus, caseKey: c.key, gold: c.expected[filterIndex],
        probability: request.probabilities[index], label: request.labels[index], inputTokens: request.usage.input_tokens, wallMs: request.wallMs };
      (request.mode === 'single' ? singles : multis).push(row);
    }
  }
  const metrics = [], paired = [], flipRows = [], interference = [];
  const key = r => JSON.stringify([r.caseKey, r.intent]);
  const d = new Map(singles.filter(r => r.variant === 'D').map(r => [key(r), r]));
  const singleByStyle = new Map(singles.map(r => [JSON.stringify([r.variant, r.caseKey, r.intent]), r]));
  insist(d.size === raw.counts.decisions && singles.length === singleByStyle.size, 'Incomplete or duplicate single-filter decisions');
  for (const variant of ['D', 'K1', 'K2', 'Rdef', 'X']) {
    const rows = singles.filter(r => r.variant === variant);
    for (const group of groups(rows)) {
      metrics.push({ variant, intent: group.intent, corpus: group.corpus, ...decisionMetrics(group.rows, raw.cutoff), optimal: optimalCutoff(group.rows) });
      if (variant === 'D') continue;
      const reference = group.rows.map(r => { const ref = d.get(key(r)); insist(ref && ref.gold === r.gold, 'Unpaired descriptive decision'); return ref; });
      const dScores = decisionMetrics(reference, raw.cutoff), kScores = decisionMetrics(group.rows, raw.cutoff);
      const comparisons = group.rows.map((r, index) => ({ dCorrect: (reference[index].probability >= raw.cutoff) === r.gold,
        kCorrect: (r.probability >= raw.cutoff) === r.gold }));
      paired.push({ variant, intent: group.intent, corpus: group.corpus, n: group.rows.length,
        aucDifference: dScores.auc === null || kScores.auc === null ? null : kScores.auc - dScores.auc,
        errorDifference: kScores.errors - dScores.errors, mcnemar: mcnemar(comparisons),
        flips: comparisons.filter(p => p.dCorrect !== p.kCorrect).length });
    }
    if (['K1', 'K2'].includes(variant)) for (const r of rows) {
      const ref = d.get(key(r));
      if ((ref.probability >= raw.cutoff) === (r.probability >= raw.cutoff)) continue;
      flipRows.push({ variant, corpus: r.corpus, caseKey: r.caseKey, intent: r.intent, text: cases.get(r.caseKey).text,
        gold: r.gold, dLabel: ref.label, kLabel: r.label, dProbability: ref.probability, kProbability: r.probability,
        dCorrect: (ref.probability >= raw.cutoff) === r.gold, kCorrect: (r.probability >= raw.cutoff) === r.gold });
    }
    for (const mode of ['single', 'multi']) {
      const requests = raw.requests.filter(r => r.variant === variant && r.mode === mode);
      // Multi requests have one timing/token reading, not one copy per question.
      for (const group of groups(requests.map(r => ({ ...r, intent: r.mode === 'single' ? r.intents[0] : 'multi-filter', corpus: cases.get(r.caseKey).corpus })))) {
        const values = group.rows, tokens = values.map(r => r.usage.input_tokens);
        requestStats.push({ variant, mode, intent: group.intent, corpus: group.corpus, n: values.length,
          medianMs: median(values.map(r => r.wallMs)), medianInputTokens: median(tokens), meanInputTokens: tokens.reduce((a, b) => a + b, 0) / tokens.length,
          minInputTokens: Math.min(...tokens), maxInputTokens: Math.max(...tokens) });
      }
    }
  }
  for (const style of ['D', 'K1']) for (const group of groups(multis.filter(r => r.variant === style))) {
    const deltas = group.rows.map(r => { const alone = singleByStyle.get(JSON.stringify([style, r.caseKey, r.intent])); insist(alone, 'Missing alone/multi pair');
      return { abs: Math.abs(r.probability - alone.probability), flip: (r.probability >= raw.cutoff) !== (alone.probability >= raw.cutoff) }; });
    interference.push({ style, intent: group.intent, corpus: group.corpus, n: deltas.length,
      medianAbsDelta: median(deltas.map(d => d.abs)), worstAbsDelta: Math.max(...deltas.map(d => d.abs)), flips: deltas.filter(d => d.flip).length });
  }
  return { metrics, paired, requestStats, interference, flips: { schemaVersion: 1, phase: raw.phase, cutoff: raw.cutoff, rows: flipRows },
    roundedCutoff: .2908, roundedCutoffDecisionDifferences: [...singles, ...multis].filter(r => (r.probability >= raw.cutoff) !== (r.probability >= .2908)).length };
}

async function save(name, value) {
  await mkdir(LOCAL, { recursive: true });
  const temp = new URL(`probe-${name}.tmp`, LOCAL);
  await writeFile(temp, JSON.stringify(publicValue(value), null, 2) + '\n'); await rename(temp, new URL(name, OUT));
}
async function protectedHashes() {
  const names = (await readdir(OUT)).filter(n => n.startsWith('decision-') && !n.startsWith('decision-wording-probe-'));
  return Object.fromEntries(await Promise.all(names.map(async n => [`docs/benchmarks/data/${n}`, hash(await readFile(new URL(n, OUT)))])));
}
async function checkProtected(before) {
  for (const [name, digest] of Object.entries(before)) insist(hash(await readFile(new URL(name, ROOT))) === digest, `Protected receipt changed: ${name}`);
}
const active = entry => !['unloaded', 'incomplete'].includes(entry.status.value);
export async function inventory() {
  const entries = (await json(`${ENDPOINTS.llama}/models`)).data;
  insist(entries.filter(active).every(e => e.id === VARIANT.model), 'Another Llama model is loaded'); return entries;
}
export async function probeSettings(selection, identityRecord) {
  const runner = (await inventory()).find(e => e.id === VARIANT.model); assertPreset(VARIANT, runner);
  const props = await json(`${ENDPOINTS.llama}/props?model=${encodeURIComponent(VARIANT.model)}`);
  const settings = normalizedSettings(VARIANT, { runner, props }); assertPinned(VARIANT, settings);
  validateSelection(selection, { id: VARIANT.id, templateId: selection.templateId }, CORPUS_HASHES, templateHash('matches-category'), settings);
  insist(props.model_path.endsWith(identityRecord.identity.file), 'Loaded model file differs');
  return { settings, props };
}
export async function unloadProbe() {
  if ((await inventory()).some(e => e.id === VARIANT.model && active(e))) await json(`${ENDPOINTS.llama}/models/unload`, { model: VARIANT.model });
  for (let n = 0; n < 240; n++) {
    if (!(await inventory()).some(active)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Llama unload not confirmed');
}

export async function scoreProbe() {
  const bytes = await readFile(new URL(FILES.raw, OUT)), raw = JSON.parse(bytes), analyzed = analyzeProbe(raw);
  await checkProtected(raw.protectedHashes);
  await save(FILES.flips, analyzed.flips);
  const { flips, ...metrics } = analyzed;
  await save(FILES.summary, { schemaVersion: 1, phase: raw.phase, status: 'complete', rawFile: FILES.raw, rawSha256: hash(bytes),
    flipsFile: FILES.flips, flipsSha256: hash(await readFile(new URL(FILES.flips, OUT))), model: raw.model, cutoff: raw.cutoff, counts: raw.counts,
    runtimeSettings: raw.runtimeSettings, environment: raw.environment, goldProvisional: true, immutableEvidenceUnchanged: true, ...metrics });
}

export async function runProbe() {
  // A dedicated evidence file keeps this exploratory replay outside phase 2.
  const empty = { schemaVersion: 1, phase: 'exploratory-label-wording', status: 'preparing', startedAt: new Date().toISOString() };
  await writeFile(new URL(FILES.raw, OUT), JSON.stringify(empty, null, 2) + '\n', { flag: 'wx' });
  const raw = { ...empty, protectedHashes: await protectedHashes() };
  let failure;
  try {
    const selectionBytes = await readFile(new URL('decision-1b-selection-llama-d1-2b-q8.json', OUT));
    const selection = JSON.parse(selectionBytes);
    const identityRecord = JSON.parse(await readFile(new URL('decision-1b-identity-llama-d1-2b-q8.json', OUT)));
    insist(same(identityRecord.variant, VARIANT) && hash(identityRecord.identity) === selection.identityHash
      && selection.templateId === 'matches-category', 'Frozen probe model or template binding differs');
    const entries = await inventory(); assertPreset(VARIANT, entries.find(e => e.id === VARIANT.model));
    if (!entries.some(e => e.id === VARIANT.model && active(e))) await json(`${ENDPOINTS.llama}/models/load`, { model: VARIANT.model });
    const { settings, props } = await probeSettings(selection, identityRecord);
    const digest = createHash('sha256'); for await (const chunk of createReadStream(props.model_path)) digest.update(chunk);
    insist(digest.digest('hex') === identityRecord.identity.sha256, 'Loaded GGUF bytes differ from frozen artifact');
    raw.model = { variantId: VARIANT.id, model: VARIANT.model, identityHash: selection.identityHash, selectionSha256: hash(selectionBytes) };
    raw.cutoff = selection.cutoff; raw.runtimeSettings = settings; raw.corpusHashes = CORPUS_HASHES;
    raw.environment = publicValue(await environment()); raw.cases = await loadProbeCases(selection); raw.intents = INTENTS;
    insist(raw.cases.length === 280 && raw.cases.reduce((n, c) => n + c.filters.length, 0) === 940, 'Probe input coverage differs');
    const schedule = buildProbeRequests(raw.cases), cases = new Map(raw.cases.map(c => [c.key, c]));
    raw.counts = { cases: raw.cases.length, decisions: 940, requests: schedule.length };
    raw.schedule = { seed: '0xdec1b032', method: 'Fixed Fisher-Yates shuffle of all single and multi requests',
      consecutiveSamePost: schedule.slice(1).filter((r, i) => r.caseKey === schedule[i].caseKey).length };
    raw.status = 'running'; raw.requests = []; raw.requestsIssued = 0;
    await save(FILES.raw, raw);
    for (const request of schedule) {
      if (request.index % 100 === 0) {
        await probeSettings(selection, identityRecord);
        console.log(`${new Date().toISOString()} wording probe ${request.index}/${schedule.length}`);
      }
      raw.activeRequest = { index: request.index, caseKey: request.caseKey, variant: request.variant, mode: request.mode };
      raw.requestsIssued++;
      const start = performance.now();
      const response = await json(`${ENDPOINTS.llama}/v1/systemone`, { model: VARIANT.model, state: cases.get(request.caseKey).text, questions: request.questions });
      const wallMs = performance.now() - start;
      assertNoTruncation(response, settings.effectiveContext);
      raw.requests.push({ ...request, probabilities: parseProbabilities(response, request.intents.length), usage: response.usage, wallMs });
      raw.activeRequest = null;
      if (raw.requests.length % 50 === 0) await save(FILES.raw, raw);
    }
    await probeSettings(selection, identityRecord); await checkProtected(raw.protectedHashes);
    raw.status = 'complete'; raw.finishedAt = new Date().toISOString();
  } catch (error) { failure = error; raw.status = 'failed'; raw.error = publicValue(error.message); }
  finally {
    try { await unloadProbe(); } catch (error) { failure ??= error; raw.status = 'failed'; raw.error = publicValue(error.message); }
    await save(FILES.raw, raw);
  }
  if (failure) throw failure;
  await scoreProbe();
  console.log(`Completed exploratory wording probe: ${raw.requests.length} requests; Llama unloaded.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !['run', 'score'].includes(command)) throw new Error('Usage: node scripts/decision-eval/wording-probe.mjs run|score');
  (command === 'run' ? runProbe() : scoreProbe()).catch(error => { console.error(publicValue(error.message)); process.exitCode = 1; });
}
