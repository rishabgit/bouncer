import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CAPACITY_ARTIFACTS, CAPACITY_VARIANTS, createCapacityRuntime, publicValue } from '../capacity-runtime.mjs';
import { capacityFile, createCapacityPipeline } from '../capacity-pipeline.mjs';
import { CORPUS_HASHES, loadCorpora } from '../corpora.mjs';
import { chooseSelection, leaveOneOut } from '../metrics.mjs';
import { TEMPLATES } from '../templates.mjs';
import { VARIANTS } from '../registry.mjs';

const v = CAPACITY_VARIANTS[0];
const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const settings = Object.freeze({ runtime: 'llama', version: '0.49.0', build: 'test-build', effectiveContext: 4096,
  parallel: 1, batch: 4096, ubatch: 4096, projector: false, runner: 'llamacpp', quantization: 'Q8_0', aliasDefinition: null });
const identity = Object.freeze({ ...CAPACITY_ARTIFACTS[v.id], family: v.family, architecture: 'lfm2',
  disk: { logicalBytes: CAPACITY_ARTIFACTS[v.id].logicalBytes, allocatedBytes: 100, scope: 'test' } });
function entry(variant = v, status = 'unloaded') {
  return { id: variant.model, status: { value: status, args: ['--ctx-size', '4096', '--parallel', '1',
    '--batch-size', '4096', '--ubatch-size', '4096', '--no-mmproj-auto', '--hf-repo', variant.model] } };
}
function adapterFixture() {
  const inventory = [entry()], calls = [], records = new Map();
  const pins = CAPACITY_ARTIFACTS[v.id];
  const props = { model_path: `/tmp/llama-cache/${v.file}`, default_generation_settings: { n_ctx: 4096 },
    total_slots: 1, modalities: { vision: false, audio: false }, build_info: 'test-build', model_ftype: 'Q8_0' };
  let digest = pins.sha256;
  const api = createCapacityRuntime({
    jsonRequest: async (url, body, timeout) => {
      calls.push({ url, body, timeout });
      assert(!url.includes('11434'), 'Ollama must never be queried');
      if (url.endsWith('/models')) return { data: inventory };
      if (url.endsWith('/models/load')) { inventory[0].status.value = 'loaded'; return { success: true }; }
      if (url.endsWith('/models/unload')) { inventory[0].status.value = 'unloaded'; return { success: true }; }
      if (url.includes('/props?')) return props;
      if (url.includes('huggingface.co')) return { sha: pins.revision, gguf: { architecture: 'lfm2' },
        siblings: [{ rfilename: pins.file, size: pins.logicalBytes, lfs: { sha256: pins.sha256, size: pins.logicalBytes } }] };
      if (url.endsWith('/v1/systemone')) return { answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: .6 }])), usage: { input_tokens: 100 } };
      throw new Error(`Unexpected test endpoint: ${url}`);
    },
    record: async (name, value) => records.set(name, value), fileHash: async () => digest,
    fileStat: async () => ({ size: pins.logicalBytes, blocks: 123 }),
    readLocal: async name => { if (!records.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return records.get(name); },
    wait: async () => {}, now: (() => { let n = 0; return () => ++n; })(),
    timestamp: () => '2026-11-25T00:00:00.000Z',
  });
  return { api, inventory, calls, props, records, changeDigest: value => { digest = value; } };
}

test('capacity artifacts are separate, frozen official text GGUF pins', () => {
  assert.equal(CAPACITY_VARIANTS.length, 3);
  assert(Object.isFrozen(CAPACITY_VARIANTS));
  for (const variant of CAPACITY_VARIANTS) {
    assert(!VARIANTS.some(old => old.id === variant.id));
    const pin = CAPACITY_ARTIFACTS[variant.id];
    assert.equal(pin.file, variant.file);
    assert.equal(pin.repository, variant.model.split(':')[0]);
    assert.match(pin.revision, /^[a-f0-9]{40}$/);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.equal(variant.batch, 4096);
    assert(Object.isFrozen(pin));
  }
  assert.match(capacityFile('speed-r2', v.id).pathname, /decision-capacity-speed-r2-llama-d1-3b-q8\.json$/);
  assert.throws(() => capacityFile('../old', v.id));
});

test('Llama adapter rejects other residents and validates pins before load, without Ollama', async () => {
  const f = adapterFixture();
  await f.api.load(v);
  assert.equal(f.calls.find(call => call.url.endsWith('/models/load')).timeout, 1_800_000);
  assert.deepEqual(await f.api.settings(v), settings);
  await assert.rejects(f.api.state(v), /owns the GPU/);
  await f.api.state(v, { allowOwn: true });
  await f.api.unload(v);
  assert(f.inventory.every(model => model.status.value === 'unloaded'));
  f.inventory.push(entry({ ...v, model: 'another/model:Q8_0' }, 'loaded'));
  await assert.rejects(f.api.load(v), /owns the GPU/);
  f.inventory.pop();
  f.inventory[0].status.args = ['--ctx-size', '8000'];
  await assert.rejects(f.api.load(v), /pinned preset/);
});

test('Llama adapter waits for asynchronous router readiness before returning a loaded model', async () => {
  let status = 'unloaded', polls = 0, waits = 0;
  const api = createCapacityRuntime({
    jsonRequest: async (url, body) => {
      if (url.endsWith('/models/load')) { assert.equal(body.model, v.model); status = 'loading'; return { success: true }; }
      assert.ok(url.endsWith('/models'));
      if (status === 'loading' && ++polls === 3) status = 'loaded';
      return { data: [entry(v, status)] };
    }, wait: async ms => { assert.equal(ms, 250); waits++; },
  });
  await api.load(v); assert.equal(status, 'loaded'); assert.equal(waits, 2);
});

test('identity hashes the actual temporary path against official metadata and detects changes', async () => {
  const f = adapterFixture();
  await f.api.load(v);
  f.props.model_path = '/tmp/llama-cache/router-renamed-text-weights.gguf';
  const found = await f.api.identify(v);
  assert.equal(found.sha256, CAPACITY_ARTIFACTS[v.id].sha256);
  assert.equal(found.disk.scope, 'Primary text GGUF; projector excluded; temporary runtime cache');
  assert.equal(f.records.get(`local-${v.id}.json`).path, f.props.model_path);
  assert(f.calls.some(call => call.url.includes(`/revision/${found.revision}?blobs=true`)));
  assert(!f.calls.some(call => call.url.endsWith('/v1/systemone')));
  await f.api.verifyIdentity(v, found);
  f.changeDigest('0'.repeat(64));
  await assert.rejects(f.api.verifyIdentity(v, found), /changed since freeze/);
});

test('loaded identity verification supports old Llama identity without requiring capacity local record', async () => {
  const f = adapterFixture(), old = VARIANTS.find(item => item.id === 'llama-d1-2b-q8');
  f.inventory[0] = entry(old, 'loaded');
  f.props.model_path = `/tmp/llama-cache/${old.file}`;
  const id = { repository: old.model.split(':')[0], file: old.file, revision: 'a'.repeat(40), sha256: CAPACITY_ARTIFACTS[v.id].sha256,
    disk: { logicalBytes: CAPACITY_ARTIFACTS[v.id].logicalBytes } };
  await f.api.verifyIdentity(old, id);
  assert.equal(f.records.get(`local-${old.id}.json`).path, f.props.model_path);
});

test('requestQuestions sends the existing body, validates strict accounting and saves raw locally', async () => {
  const f = adapterFixture();
  const q = { f0: { type: 'noul', instructions: 'Apply the frozen rubric.' } };
  const answer = await f.api.requestQuestions(v, 'Test post', q);
  assert.deepEqual(answer, { wallMs: 1, probabilities: [.6], usage: { input_tokens: 100 } });
  assert.deepEqual(f.calls.at(-1).body, { model: v.model, state: 'Test post', questions: q });
  assert([...f.records.keys()].some(name => name.startsWith(`request-${v.id}-`)));
  await assert.rejects(f.api.requestQuestions(v, 'Test post', { f1: q.f0 }), /ordered/);
  await assert.rejects(f.api.requestQuestions(v, 'Test post', q, 100), /Truncation/);
});

async function pipelineFixture() {
  const corpus = await loadCorpora('discovery');
  const baseline = new Map(corpus.cases.map(c => [`${c.corpus}:${c.id}`, c.expected.some(Boolean)]));
  const files = new Map(), calls = [], local = new Map();
  let loaded = false, checked = false, time = Date.parse('2026-11-25T00:00:00Z');
  const runtime = {
    publicValue,
    state: async () => { calls.push(['state']); assert(!loaded); },
    load: async () => { calls.push(['load']); assert(!loaded); loaded = true; checked = false; },
    unload: async () => { calls.push(['unload']); loaded = false; },
    settings: async () => { calls.push(['settings']); assert(loaded); checked = true; return settings; },
    identify: async () => { calls.push(['identify']); assert(loaded); return identity; },
    verifyIdentity: async () => { calls.push(['verify', loaded]); },
    request: async (variant, text, filters, templateId, context = 4096) => {
      assert(loaded && checked, 'settings must be checked before inference');
      calls.push(['request', text, filters, templateId, context]);
      const c = corpus.cases.find(c => c.text === text && JSON.stringify(c.filters) === JSON.stringify(filters));
      return { wallMs: 10, usage: { input_tokens: 100 }, probabilities: c ? c.expected.map(value => value ? .8 : .2) : filters.map(() => .2) };
    },
    logOffset: async () => 0, logSince: async () => 'full model log',
    localRecord: async (name, value) => local.set(name, value),
    hasLocalRecord: async name => local.has(name),
  };
  const pipeline = createCapacityPipeline({ runtime,
    corpusLoader: async split => { assert.equal(split, 'discovery'); return corpus; }, baselineLoader: async () => baseline,
    read: async path => JSON.parse(files.get(path.href)), readBytes: async path => files.get(path.href), exists: async path => files.has(path.href),
    save: async (path, value) => { assert(!files.has(path.href), 'results must be exclusive'); files.set(path.href, Buffer.from(JSON.stringify(publicValue(value), null, 2) + '\n')); },
    observeEnvironment: async () => ({ host: { nodeVersion: 'test' }, path: '/'+'Users/'+'test/private' }),
    memorySampler: async port => { assert.equal(port, 9931); return { samples: [{ time }], close: async () => calls.push(['closeSampler']) }; },
    memorySummary: () => ({ sampleCount: 10, peakFootprintBytes: 123, peakRssBytes: 100 }),
    now: () => ++time, wait: async ms => { assert.equal(ms, 5000); time += ms; }, announce: () => {},
  });
  return { pipeline, files, calls, local, corpus, baseline, runtime };
}

test('prepare freezes only new identity, unloads, and reuses it without loading or inference', async () => {
  const f = await pipelineFixture();
  assert.deepEqual(await f.pipeline.prepareCapacity(v), identity);
  assert.equal(f.calls.filter(call => call[0] === 'request').length, 0);
  assert.equal(f.calls.at(-1)[0], 'unload');
  const before = f.calls.length;
  assert.deepEqual(await f.pipeline.prepareCapacity(v), identity);
  assert.equal(f.calls.length, before);
  assert([...f.files.keys()].every(path => path.includes('decision-capacity-')));
});

test('discovery preserves both templates, all 88 cases, original metrics and immutable receipt', async () => {
  const f = await pipelineFixture();
  await f.pipeline.prepareCapacity(v);
  const { selection, discovery } = await f.pipeline.discoveryCapacity(v);
  assert.equal(f.corpus.cases.length, 88);
  assert.equal(f.calls.filter(call => call[0] === 'request').length, 177);
  assert.deepEqual(discovery.templates.map(template => template.id), TEMPLATES.map(template => template.id));
  assert(discovery.templates.every(template => template.rows.length === 88));
  const chosen = chooseSelection(discovery.templates, f.baseline);
  assert.equal(selection.cutoff, chosen.cutoff);
  assert.deepEqual(selection.interval, chosen.interval);
  assert.deepEqual(selection.loo, leaveOneOut(discovery.templates, f.baseline));
  assert.deepEqual(selection.corpusHashes, CORPUS_HASHES);
  assert.equal(selection.identityHash, hash(identity));
  assert.equal(selection.discoverySha256, hash(f.files.get(capacityFile('discovery', v.id).href)));
  assert(!JSON.stringify(discovery).includes('/'+'Users/'));
  const count = f.calls.length;
  await assert.rejects(f.pipeline.discoveryCapacity(v), /already exists/);
  assert.equal(f.calls.length, count, 'refusal happens before any model call');
});

test('performance retains fresh cells, distinct warmups, 20 posts, five controls and raw-only samples', async () => {
  const f = await pipelineFixture();
  await f.pipeline.prepareCapacity(v);
  await f.pipeline.discoveryCapacity(v);
  f.calls.length = 0;
  const order = CAPACITY_VARIANTS.map(variant => variant.id);
  const result = await f.pipeline.performanceCapacity(v, 1, order);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.phase, 'performance');
  assert.equal(result.coldLoadMs > 0, true);
  assert.equal(result.cold.wallMs, 10);
  assert.equal(f.calls.find(call => call[0] === 'verify')[1], false);
  assert.equal(result.coldArtifactVerificationMs > 0, true);
  assert.match(result.method.coldScope, /integrity hashing excluded/);
  assert.equal(f.calls.filter(call => call[0] === 'load').length, 3);
  assert.equal(f.calls.filter(call => call[0] === 'unload').length, 3);
  assert.equal(f.calls.filter(call => call[0] === 'request').length, 54);
  for (const count of [3, 10]) {
    assert.equal(result.cells[count].rows.length, 20);
    assert.equal(result.cells[count].filters.length, count);
  }
  const requests = f.calls.filter(call => call[0] === 'request');
  assert.match(requests[5][1], /^Warmup 10 0:/, 'odd repetition reverses cell order');
  assert.equal(new Set(requests.filter(call => call[1].startsWith('Warmup')).map(call => call[1])).size, 4);
  assert.equal(result.identicalRequests.length, 5);
  assert.equal(result.identicalProbabilities, true);
  assert.equal(result.method.memoryIntervalMs, 200);
  assert(f.local.has(`memory-${v.id}-r1.json`));
  assert(f.local.has(`speed-${v.id}-r1.log`));
  assert(!Object.hasOwn(result, 'samples'));
  const before = f.calls.length;
  await assert.rejects(f.pipeline.performanceCapacity(v, 1, order), /already exists/);
  assert.equal(f.calls.length, before);
});

test('discovery errors preserve raw evidence, unload and never freeze a selection', async () => {
  const f = await pipelineFixture();
  await f.pipeline.prepareCapacity(v);
  f.runtime.request = async () => { throw new Error('test failed request'); };
  await assert.rejects(f.pipeline.discoveryCapacity(v), /test failed request/);
  assert.equal(f.calls.at(-1)[0], 'unload');
  assert(!f.files.has(capacityFile('selection', v.id).href));
  assert(f.local.has(`failed-discovery-${v.id}.json`));
  assert(f.local.has(`discovery-${v.id}.log`));
  const count = f.calls.length;
  await assert.rejects(f.pipeline.discoveryCapacity(v), /Prior capacity discovery attempt/);
  assert.equal(f.calls.length, count, 'interrupted attempts cannot cause new inference');
});
