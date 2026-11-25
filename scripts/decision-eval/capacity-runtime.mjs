import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { questions } from './templates.mjs';
import { assertNoTruncation, assertPinned, assertPreset, json, logOffset, logSince,
  normalizedSettings, parseProbabilities, publicValue } from './runtime.mjs';

// Deliberately separate from phase 1b's registry: its receipts remain immutable.
export const CAPACITY_VARIANTS = Object.freeze([
  { id: 'llama-d1-3b-q8', runtime: 'llama', model: 'LiquidAI/d1-3B-GGUF:Q8_0', file: 'd1-3B-Q8_0.gguf', family: 'd1-3b', format: 'GGUF Q8_0', batch: 4096 },
  { id: 'llama-kev-4b-q8', runtime: 'llama', model: 'ggml-org/Kev-4B-GGUF:Q8_0', file: 'Kev-4B-Q8_0.gguf', family: 'kev-4b', format: 'GGUF Q8_0', batch: 4096 },
  { id: 'llama-clef-flash-q4km', runtime: 'llama', model: 'ggml-org/Clef-Flash-GGUF:Q4_K_M', file: 'Clef-Flash-Q4_K_M.gguf', family: 'clef-flash', format: 'GGUF Q4_K_M', batch: 4096 },
].map(Object.freeze));

// Official HF API metadata observed before the capacity experiment's first run.
export const CAPACITY_ARTIFACTS = Object.freeze(Object.fromEntries([
  ['llama-d1-3b-q8', { repository: 'LiquidAI/d1-3B-GGUF', revision: 'bb1e436ea78eb96a3f1acb6da865f70c2fbeb563', file: 'd1-3B-Q8_0.gguf', sha256: '2f0942d5a5f64cf69c3356d2be439b71644b1f0eb3a580912a5a0179eeaba77d', logicalBytes: 2874781280 }],
  ['llama-kev-4b-q8', { repository: 'ggml-org/Kev-4B-GGUF', revision: 'f4624b6bb7072f1bab726a622c1cad3f96030b9e', file: 'Kev-4B-Q8_0.gguf', sha256: '7c2ebed90560522c2801389db482ac1dc4c36d828f201f6074c1d60e433948da', logicalBytes: 4483801504 }],
  ['llama-clef-flash-q4km', { repository: 'ggml-org/Clef-Flash-GGUF', revision: 'c3d925454595d792d5333da8b35f3c09911f7568', file: 'Clef-Flash-Q4_K_M.gguf', sha256: 'eef2968c238a80d49d340430f22410ea3db9934ad1c6fdb233a503cbf9a9b54e', logicalBytes: 6732781824 }],
].map(([key, value]) => [key, Object.freeze(value)])));

export const CAPACITY_LOCAL = new URL('./.tmp/raw/capacity/', import.meta.url);
const ENDPOINT = 'http://127.0.0.1:9931';
const active = model => !['unloaded', 'incomplete'].includes(model.status?.value);
const safeId = v => {
  if (v?.runtime !== 'llama' || !/^[a-z0-9-]+$/.test(v.id) || typeof v.model !== 'string' || !v.file) {
    throw new Error('Capacity runtime requires a named Llama GGUF variant');
  }
  return v.id;
};
export async function localRecord(name, value) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid capacity scratch filename');
  await mkdir(CAPACITY_LOCAL, { recursive: true });
  await writeFile(new URL(name, CAPACITY_LOCAL), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

/** Injectable IO keeps the adapter testable without model loading or HTTP. */
export function createCapacityRuntime({
  jsonRequest = json, record = localRecord, fileHash = fileDigest, fileStat = stat,
  readLocal = async name => JSON.parse(await readFile(new URL(name, CAPACITY_LOCAL), 'utf8')),
  wait = delay, now = () => performance.now(), timestamp = () => new Date().toISOString(),
} = {}) {
  let requestSequence = 0;
  async function hasLocalRecord(name) {
    try { await readLocal(name); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function state(v, { allowOwn = false } = {}) {
    safeId(v);
    const response = await jsonRequest(`${ENDPOINT}/models`);
    if (!Array.isArray(response?.data)) throw new Error('Invalid Llama router model inventory');
    const llama = response.data;
    const busy = llama.filter(active).filter(model => !(allowOwn && model.id === v.model));
    if (busy.length) throw new Error(`Another model owns the GPU: ${JSON.stringify(busy.map(model => ({ runtime: 'llama', model: model.id, status: model.status?.value })))}`);
    const own = llama.find(model => model.id === v.model);
    if (!own) throw new Error(`Missing pinned preset [${v.model}]`);
    assertPreset(v, own);
    return { llama };
  }
  async function load(v) {
    const before = await state(v, { allowOwn: true });
    if (!before.llama.some(model => model.id === v.model && active(model))) {
      // Router-managed downloads may take minutes; never manipulate its cache.
      await jsonRequest(`${ENDPOINT}/models/load`, { model: v.model }, 1_800_000);
    }
    // /models/load acknowledges asynchronously, including router downloads.
    for (let n = 0; n < 7200; n++) {
      const current = await state(v, { allowOwn: true });
      const own = current.llama.find(model => model.id === v.model);
      if (own.status?.value === 'loaded') return current;
      if (['failed', 'error'].includes(own.status?.value)) throw new Error(`Llama model load failed: ${v.id} (${own.status.value})`);
      await wait(250);
    }
    throw new Error(`Llama model did not finish loading within 30 minutes: ${v.id}`);
  }
  async function unload(v) {
    const before = await state(v, { allowOwn: true });
    if (before.llama.some(model => model.id === v.model && active(model))) {
      await jsonRequest(`${ENDPOINT}/models/unload`, { model: v.model });
    }
    for (let n = 0; n < 240; n++) {
      const current = await state(v, { allowOwn: true });
      if (!current.llama.some(active)) return;
      await wait(250);
    }
    throw new Error(`Unload not confirmed: ${v.id}`);
  }
  async function info(v) {
    const current = await state(v, { allowOwn: true });
    const runner = current.llama.find(model => model.id === v.model);
    if (runner.status?.value !== 'loaded') throw new Error(`Metadata requires a loaded model: ${v.id}`);
    const props = await jsonRequest(`${ENDPOINT}/props?model=${encodeURIComponent(v.model)}`);
    if (typeof props?.model_path !== 'string' || !props.model_path) throw new Error('Loaded model path is missing');
    return { props, runner };
  }
  async function settings(v) {
    const observed = await info(v);
    await record(`runtime-${safeId(v)}.json`, observed);
    const value = normalizedSettings(v, observed);
    assertPinned(v, value);
    return value;
  }
  async function identify(v) {
    safeId(v);
    const observed = await info(v);
    const repository = v.model.split(':')[0];
    const pinned = CAPACITY_ARTIFACTS[v.id];
    if (pinned && (pinned.repository !== repository || pinned.file !== v.file)) throw new Error('Capacity artifact registry changed');
    const revisionPath = pinned ? `/revision/${pinned.revision}` : '';
    const metadata = await jsonRequest(`https://huggingface.co/api/models/${repository}${revisionPath}?blobs=true`);
    const file = metadata.siblings?.find(item => item.rfilename === v.file);
    if (!file?.lfs?.sha256 || !/^[a-f0-9]{40}$/.test(metadata.sha)) throw new Error(`Missing exact official GGUF metadata: ${v.file}`);
    if (pinned && (metadata.sha !== pinned.revision || file.lfs.sha256 !== pinned.sha256 || file.size !== pinned.logicalBytes)) {
      throw new Error('Official metadata differs from the preregistered capacity artifact');
    }
    const path = observed.props.model_path;
    // Hash props.model_path itself: router caches can rename the downloaded file.
    const disk = await fileStat(path);
    if (disk.size !== (file.lfs.size ?? file.size) || await fileHash(path) !== file.lfs.sha256) throw new Error('GGUF size/SHA mismatch');
    await record(`local-${v.id}.json`, { path, info: observed });
    return publicValue({ repository, revision: metadata.sha, file: v.file, sha256: file.lfs.sha256,
      family: v.family, architecture: metadata.gguf?.architecture ?? null,
      disk: { logicalBytes: disk.size, allocatedBytes: disk.blocks * 512,
        scope: 'Primary text GGUF; projector excluded; temporary runtime cache' } });
  }
  async function verifyIdentity(v, identity) {
    safeId(v);
    if (identity?.repository !== v.model.split(':')[0] || identity.file !== v.file || !/^[a-f0-9]{64}$/.test(identity.sha256)) {
      throw new Error('Frozen identity does not match the variant');
    }
    const pinned = CAPACITY_ARTIFACTS[v.id];
    if (pinned && (identity.revision !== pinned.revision || identity.sha256 !== pinned.sha256 || identity.disk?.logicalBytes !== pinned.logicalBytes)) {
      throw new Error('Frozen identity differs from the preregistered capacity artifact');
    }
    let local;
    try { local = await readLocal(`local-${v.id}.json`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const current = await state(v, { allowOwn: true });
    let path = local?.path, observed;
    if (current.llama.some(model => model.id === v.model && active(model))) {
      observed = await info(v);
      path = observed.props.model_path;
    }
    if (!path) throw new Error(`No local artifact path available for ${v.id}`);
    const disk = await fileStat(path);
    if (disk.size !== identity.disk?.logicalBytes || await fileHash(path) !== identity.sha256) throw new Error('GGUF changed since freeze');
    if (observed) await record(`local-${v.id}.json`, { path, info: observed });
    return true;
  }
  async function requestQuestions(v, text, questionMap, context = 4096) {
    safeId(v);
    const keys = Object.keys(questionMap ?? {});
    if (typeof text !== 'string' || !text.trim() || !keys.length
        || keys.some((key, index) => key !== `f${index}` || questionMap[key]?.type !== 'noul'
          || typeof questionMap[key].instructions !== 'string' || !questionMap[key].instructions.trim())) {
      throw new Error('Capacity requests require ordered f0…fN noul questions and nonempty text');
    }
    const body = { model: v.model, state: text, questions: questionMap };
    const startedAt = timestamp(), start = now();
    const response = await jsonRequest(`${ENDPOINT}/v1/systemone`, body);
    const wallMs = now() - start;
    await record(`request-${v.id}-${startedAt.replaceAll(/[^0-9TZ]/g, '')}-${++requestSequence}.json`, { startedAt, request: body, response, wallMs });
    assertNoTruncation(response, context);
    return { wallMs, probabilities: parseProbabilities(response, keys.length), usage: response.usage };
  }
  const request = (v, text, filters, templateId, context = 4096) => requestQuestions(v, text, questions(filters, templateId), context);
  return { state, load, unload, info, settings, identify, verifyIdentity, request, requestQuestions, hasLocalRecord };
}

const runtime = createCapacityRuntime();
export const { state, load, unload, info, settings, identify, verifyIdentity, request, requestQuestions, hasLocalRecord } = runtime;
export { assertPinned, normalizedSettings, publicValue, logOffset, logSince };
