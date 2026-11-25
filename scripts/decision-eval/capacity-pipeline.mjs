import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { CORPUS_HASHES, loadCorpora, validateSelection } from './corpora.mjs';
import { scoreRows, optimizeThreshold, chooseSelection, leaveOneOut } from './metrics.mjs';
import { loadBaselines } from './baselines.mjs';
import { TEMPLATES, templateHash } from './templates.mjs';
import * as capacityRuntime from './capacity-runtime.mjs';
import { environment, startMemorySampler, summarizeMemory } from './observations.mjs';

const OUT = new URL('../../docs/benchmarks/data/', import.meta.url);
export function capacityFile(kind, id) {
  if (!/^[a-z0-9-]+$/.test(kind) || !/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid capacity result filename');
  return new URL(`decision-capacity-${kind}-${id}.json`, OUT);
}
export const readCapacity = async (kind, id) => JSON.parse(await readFile(capacityFile(kind, id), 'utf8'));
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
async function existsFile(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function saveFile(path, value) {
  await mkdir(OUT, { recursive: true });
  await writeFile(path, JSON.stringify(capacityRuntime.publicValue(value), null, 2) + '\n', { flag: 'wx' });
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p90: sorted[Math.ceil(sorted.length * .9) - 1], min: sorted[0], max: sorted.at(-1) };
}

/** The original phase 1b algorithms, with separate files and Llama-only IO. */
export function createCapacityPipeline({
  runtime = capacityRuntime, corpusLoader = loadCorpora, baselineLoader = loadBaselines,
  observeEnvironment = environment, memorySampler = startMemorySampler, memorySummary = summarizeMemory,
  read = async path => JSON.parse(await readFile(path, 'utf8')), readBytes = readFile,
  exists = existsFile, save = saveFile, wait = delay, now = () => Date.now(),
  announce = message => console.log(`${new Date().toISOString()} ${message}`),
} = {}) {
  const assertVariant = v => {
    const pinned = capacityRuntime.CAPACITY_VARIANTS.find(item => item.id === v?.id);
    if (!pinned || !isDeepStrictEqual(v, pinned)) throw new Error('Capacity pipeline requires an unchanged capacity variant');
  };
  async function cachedIdentity(v) {
    const receipt = await read(capacityFile('identity', v.id));
    if (receipt.schemaVersion !== 2 || !isDeepStrictEqual(receipt.variant, v)) throw new Error('Capacity registry changed after identity freeze');
    return receipt.identity;
  }
  async function prepareCapacity(v) {
    assertVariant(v);
    if (await exists(capacityFile('identity', v.id))) return cachedIdentity(v);
    await runtime.state(v);
    try {
      await runtime.load(v);
      await runtime.settings(v);
      const identity = await runtime.identify(v);
      await save(capacityFile('identity', v.id), { schemaVersion: 2, variant: v, identity });
      return identity;
    } finally { await runtime.unload(v); }
  }
  async function discoveryCapacity(v) {
    assertVariant(v);
    // Refuse before loading: existing/incomplete discovery must never be rerun.
    for (const kind of ['selection', 'discovery']) {
      if (await exists(capacityFile(kind, v.id))) throw new Error(`Capacity ${kind} already exists for ${v.id}; discovery is immutable`);
    }
    for (const name of [`attempt-discovery-${v.id}.json`, `failed-discovery-${v.id}.json`]) {
      if (await runtime.hasLocalRecord(name)) throw new Error(`Prior capacity discovery attempt exists for ${v.id}; inference must not be rerun`);
    }
    const identity = await cachedIdentity(v);
    await runtime.state(v);
    const corpus = await corpusLoader('discovery'), baseline = await baselineLoader(corpus.cases);
    const start = await runtime.logOffset();
    let inFlight;
    const result = { schemaVersion: 2, phase: 'discovery', variant: v, identityHash: hash(identity), corpusHashes: corpus.hashes,
      environment: runtime.publicValue(await observeEnvironment()), startedAt: new Date(now()).toISOString(), templates: [] };
    try {
      await runtime.load(v);
      await runtime.verifyIdentity(v, identity);
      result.runtimeSettings = await runtime.settings(v);
      await runtime.localRecord(`attempt-discovery-${v.id}.json`, { schemaVersion: 2, phase: 'discovery',
        variantId: v.id, identityHash: result.identityHash, startedAt: result.startedAt });
      // Same discovery-only preflight and ordered two-template corpus as phase 1b.
      const longest = [...corpus.cases].sort((a, b) => (b.text.length + b.filters.join('').length) - (a.text.length + a.filters.join('').length))[0];
      await runtime.request(v, longest.text, longest.filters, TEMPLATES[0].id);
      if (!isDeepStrictEqual(await runtime.settings(v), result.runtimeSettings)) throw new Error('Settings changed during discovery preflight');
      for (const template of TEMPLATES) {
        announce(`capacity discovery ${v.id} ${template.id}`);
        const rows = [];
        inFlight = { templateId: template.id, rows };
        for (const c of corpus.cases) rows.push({ id: c.id, corpus: c.corpus, filters: c.filters, expected: c.expected,
          ...await runtime.request(v, c.text, c.filters, template.id, result.runtimeSettings.effectiveContext) });
        const probabilities = rows.flatMap(row => row.probabilities);
        if (Math.max(...probabilities) - Math.min(...probabilities) < 1e-8) throw new Error('Constant probabilities');
        result.templates.push({ id: template.id, hash: templateHash(template.id), rows,
          at05: scoreRows(rows, .5, baseline), optimized: optimizeThreshold(rows, baseline) });
      }
      const current = await runtime.settings(v);
      if (!isDeepStrictEqual(current, result.runtimeSettings)) throw new Error('Settings changed during discovery');
      const chosen = chooseSelection(result.templates, baseline), loo = leaveOneOut(result.templates, baseline);
      result.finishedAt = new Date(now()).toISOString();
      await save(capacityFile('discovery', v.id), result);
      const selection = { schemaVersion: 2, phase: 'discovery', frozen: true, frozenAt: new Date(now()).toISOString(), variantId: v.id,
        templateId: chosen.templateId, templateHash: templateHash(chosen.templateId), cutoff: chosen.cutoff, interval: chosen.interval,
        loo, corpusHashes: CORPUS_HASHES, identityHash: hash(identity), runtimeSettings: result.runtimeSettings,
        discoverySha256: hash(await readBytes(capacityFile('discovery', v.id))) };
      validateSelection(selection, { id: v.id, templateId: selection.templateId }, CORPUS_HASHES, selection.templateHash, current);
      await save(capacityFile('selection', v.id), selection);
      announce(`capacity frozen ${v.id} exact=${chosen.scores.all.exactVectors}/${corpus.cases.length} cutoff=${chosen.cutoff} width=${chosen.interval.width} loo=${loo.exactVectors}/${corpus.cases.length}`);
      return { identity, selection, discovery: result };
    } catch (error) {
      await runtime.localRecord(`failed-discovery-${v.id}.json`, { result, inFlight, error: error.message });
      throw error;
    } finally {
      try { await runtime.unload(v); }
      finally { await runtime.localRecord(`discovery-${v.id}.log`, await runtime.logSince(start)); }
    }
  }
  async function performanceCapacity(v, repetition, order) {
    assertVariant(v);
    if (![0, 1, 2].includes(repetition)) throw new Error('Capacity repetition must be 0, 1, or 2');
    if (!Array.isArray(order) || order.length !== capacityRuntime.CAPACITY_VARIANTS.length
        || new Set(order).size !== order.length || capacityRuntime.CAPACITY_VARIANTS.some(item => !order.includes(item.id))) {
      throw new Error('Capacity performance requires the full rotation order');
    }
    const output = capacityFile(`speed-r${repetition}`, v.id);
    if (await exists(output)) throw new Error(`Capacity performance already exists for ${v.id} repetition ${repetition}`);
    const attempt = `attempt-speed-${v.id}-r${repetition}.json`;
    if (await runtime.hasLocalRecord(attempt)) throw new Error(`Prior capacity performance attempt exists for ${v.id} repetition ${repetition}; inference must not be rerun`);
    const corpus = await corpusLoader('discovery'), selection = await read(capacityFile('selection', v.id)), identity = await cachedIdentity(v);
    if (selection.identityHash !== hash(identity) || selection.discoverySha256 !== hash(await readBytes(capacityFile('discovery', v.id)))) throw new Error('Frozen capacity evidence changed');
    await runtime.state(v);
    // Phase 1b verifies frozen bytes before the cold clock and memory observer.
    await runtime.verifyIdentity(v, identity);
    const data = { schemaVersion: 2, phase: 'performance', variant: v, repetition, order, selection, identityHash: hash(identity),
      artifact: { model: v.model, format: v.format, digest: identity.sha256, disk: identity.disk }, environment: runtime.publicValue(await observeEnvironment()),
      startedAt: new Date(now()).toISOString(), cells: {}, method: { context: 4096, parallel: 1,
        cacheControl: 'Fresh model child per cell; distinct warmups; unchanged20 medium posts', memoryIntervalMs: 200,
        coldScope: 'Explicit /models/load plus observed settings plus first answer; integrity hashing excluded' } };
    const offset = await runtime.logOffset(), sampler = await memorySampler(9931);
    try {
      await runtime.localRecord(attempt, { schemaVersion: 2, phase: 'performance', variantId: v.id,
        repetition, order, identityHash: data.identityHash, startedAt: data.startedAt });
      const coldStart = now();
      await runtime.load(v);
      data.runtimeSettings = await runtime.settings(v);
      data.coldLoadMs = now() - coldStart;
      validateSelection(selection, { id: v.id, templateId: selection.templateId }, CORPUS_HASHES, selection.templateHash, data.runtimeSettings);
      const verificationStart = now();
      await runtime.verifyIdentity(v, identity);
      data.coldArtifactVerificationMs = now() - verificationStart;
      data.cold = await runtime.request(v, corpus.latency.posts[0], corpus.latency.filters3, selection.templateId);
      for (const count of [3, 10]) for (const n of [0, 1]) {
        await runtime.request(v, `Warmup ${count} ${n}: ${corpus.latency.posts[19]}`, corpus.latency[`filters${count}`], selection.templateId);
      }
      const steadyStart = now();
      await wait(5000);
      data.steadyMemory = memorySummary(sampler.samples, steadyStart, now());
      const cells = [3, 10].map(n => ({ key: String(n), n, templateId: selection.templateId }));
      if (repetition % 2) cells.reverse();
      const speedStart = now();
      for (const cell of cells) {
        await runtime.unload(v);
        await runtime.state(v);
        await runtime.load(v);
        await runtime.verifyIdentity(v, identity);
        validateSelection(selection, { id: v.id, templateId: selection.templateId }, CORPUS_HASHES, selection.templateHash, await runtime.settings(v));
        for (const n of [0, 1]) {
          await runtime.request(v, `Warmup ${cell.key} ${n}: ${corpus.latency.posts[19]}`, corpus.latency[`filters${cell.n}`], cell.templateId);
        }
        const rows = [];
        for (const [index, text] of corpus.latency.posts.entries()) rows.push({ index,
          ...await runtime.request(v, text, corpus.latency[`filters${cell.n}`], cell.templateId) });
        data.cells[cell.key] = { templateId: cell.templateId, filters: corpus.latency[`filters${cell.n}`], rows, wallMs: stats(rows.map(row => row.wallMs)) };
      }
      data.identicalRequests = [];
      for (let n = 0; n < 5; n++) data.identicalRequests.push(await runtime.request(v, corpus.latency.posts[0], corpus.latency.filters3, selection.templateId));
      data.identicalProbabilities = data.identicalRequests.every(row => JSON.stringify(row.probabilities) === JSON.stringify(data.identicalRequests[0].probabilities));
      data.speedMemory = memorySummary(sampler.samples, speedStart, now());
      data.finishedAt = new Date(now()).toISOString();
      return data;
    } catch (error) {
      await runtime.localRecord(`failed-speed-${v.id}-r${repetition}.json`, { data, error: error.message });
      throw error;
    } finally {
      try { await runtime.unload(v); }
      finally {
        await sampler.close();
        if (data.finishedAt) data.runMemory = memorySummary(sampler.samples, Date.parse(data.startedAt), Date.parse(data.finishedAt));
        await runtime.localRecord(`memory-${v.id}-r${repetition}.json`, sampler.samples);
        await runtime.localRecord(`speed-${v.id}-r${repetition}.log`, await runtime.logSince(offset));
        await save(output, data);
      }
    }
  }
  return { prepareCapacity, discoveryCapacity, performanceCapacity };
}

export const { prepareCapacity, discoveryCapacity, performanceCapacity } = createCapacityPipeline();
