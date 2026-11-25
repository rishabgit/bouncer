import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { ENDPOINTS } from './registry.mjs';
import { questions } from './templates.mjs';

export function publicValue(value) {
  if (typeof value === 'string') return value.replaceAll(homedir(), '~').replace(/\/Users\/[^/\s"']+/g, '~');
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, publicValue(v)]));
  return value;
}
export const LOCAL = new URL('./.tmp/', import.meta.url);
export async function localRecord(name, value) {
  await mkdir(new URL('raw/phase1b/', LOCAL), { recursive: true });
  await writeFile(new URL(`raw/phase1b/${name}`, LOCAL), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
export async function json(url, body, timeout = 180_000) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 1500)}`);
  const result = JSON.parse(text);
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result;
}
export async function residency() {
  return { llama: (await json(`${ENDPOINTS.llama}/models`)).data, ollama: (await json(`${ENDPOINTS.ollama}/api/ps`)).models };
}
const active = model => model.status?.value && !['unloaded', 'incomplete'].includes(model.status.value);
export async function assertExclusive(variant, allowOwn = false) {
  const state = await residency();
  const busy = [...state.llama.filter(active).map(m=>({runtime:'llama',model:m.id})), ...state.ollama.map(m=>({runtime:'ollama',model:m.name}))]
    .filter(m=>!(allowOwn && m.runtime===variant.runtime && m.model===variant.model));
  if (busy.length) throw new Error(`Another model owns the GPU: ${JSON.stringify(busy)}`);
  return state;
}
export async function unload(v) {
  const state = await residency();
  if (v.runtime==='ollama' && state.ollama.some(m=>m.name===v.model)) await json(`${ENDPOINTS.ollama}/api/generate`,{model:v.model,keep_alive:0,stream:false});
  if (v.runtime==='llama' && state.llama.some(m=>m.id===v.model&&active(m))) await json(`${ENDPOINTS.llama}/models/unload`,{model:v.model});
  for (let n=0;n<240;n++) {
    const s=await residency();
    if (!(v.runtime==='llama'?s.llama.some(m=>m.id===v.model&&active(m)):s.ollama.some(m=>m.name===v.model))) return;
    await delay(250);
  }
  throw new Error(`Unload not confirmed: ${v.id}`);
}
function arg(args, key, fallback=null) { const n=args?.indexOf(key)??-1; return n>=0?Number(args[n+1]):fallback; }
export function assertPreset(v, entry) {
  const a=entry?.status?.args;
  const required=[['--ctx-size',4096],['--parallel',1],...(v.batch?[['--batch-size',4096],['--ubatch-size',4096]]:[])];
  if (!a || required.some(([key,n])=>arg(a,key)!==n) || (v.batch && !a.includes('--no-mmproj-auto'))) {
    throw new Error(`Missing pinned preset [${v.model}]: ctx-size=4096, parallel=1${v.batch?', batch-size=4096, ubatch-size=4096, no-mmproj=true':''}`);
  }
  if (!a.includes('--hf-repo') && !a.includes('--model') && !a.includes('-m')) {
    throw new Error(`Missing model binding in [${v.model}]: hf-repo = ${v.model}`);
  }
}
export async function prepare(v) {
  const state=await assertExclusive(v);
  if (v.runtime==='ollama') {
    await json(`${ENDPOINTS.ollama}/api/pull`,{model:v.sourceModel,stream:false},1_800_000);
    const source=(await json(`${ENDPOINTS.ollama}/api/tags`)).models.find(m=>m.name===v.sourceModel);
    await json(`${ENDPOINTS.ollama}/api/create`,{model:v.model,from:v.sourceModel,parameters:{num_ctx:4096},stream:false},1_800_000);
    const show=await json(`${ENDPOINTS.ollama}/api/show`,{model:v.model});
    if (!/num_ctx\s+4096\b/.test(show.parameters??'')) throw new Error(`Derived alias did not pin context: ${v.id}`);
    return {model:v.model,from:v.sourceModel,sourceDigest:source.digest,parameters:{num_ctx:4096}};
  }
  const existing=state.llama.find(m=>m.id===v.model);
  if (existing) { assertPreset(v,existing); return null; }
  throw new Error(`Missing pinned preset [${v.model}]: hf-repo=${v.model}, ctx-size=4096, parallel=1${v.batch?', batch-size=4096, ubatch-size=4096, no-mmproj=true':''}`);
}
export function parseProbabilities(response, count) {
  if (!response?.answers || Object.keys(response.answers).length!==count) throw new Error('Incomplete noul answers');
  return Array.from({length:count},(_,i)=>{
    const a=response.answers[`f${i}`];
    if (a?.type!=='noul'||!Number.isFinite(a.noul)||a.noul<0||a.noul>1) throw new Error(`Invalid noul answer f${i}`);
    return a.noul;
  });
}
export function assertNoTruncation(response, context) {
  const n=response?.usage?.input_tokens;
  if (!Number.isSafeInteger(n)||n<=0||!Number.isInteger(context)||n>=context || response.truncated===true || response.usage.truncated===true) {
    throw new Error(`Truncation or invalid token accounting: input_tokens=${n}, context=${context}`);
  }
  return n;
}
export async function classify(v, text, filters, templateId, context=4096) {
  const start=performance.now();
  const response=await json(`${ENDPOINTS[v.runtime]}/v1/systemone`,{model:v.model,state:text,questions:questions(filters,templateId),...(v.runtime==='ollama'?{keep_alive:'10m'}:{})});
  const wallMs=performance.now()-start;
  assertNoTruncation(response,context);
  return {wallMs,probabilities:parseProbabilities(response,filters.length),usage:response.usage};
}
export async function runtimeInfo(v) {
  const s=await residency();
  return v.runtime==='ollama'
    ? {version:await json(`${ENDPOINTS.ollama}/api/version`),runner:s.ollama.find(m=>m.name===v.model)}
    : {props:await json(`${ENDPOINTS.llama}/props?model=${encodeURIComponent(v.model)}`),runner:s.llama.find(m=>m.id===v.model)};
}
export function normalizedSettings(v, info, aliasDefinition=null) {
  if (v.runtime==='llama') {
    const a=info.runner.status.args;
    return {runtime:'llama',version:'0.49.0',build:info.props.build_info,effectiveContext:info.props.default_generation_settings.n_ctx,
      parallel:info.props.total_slots,batch:arg(a,'--batch-size',2048),ubatch:arg(a,'--ubatch-size',512),
      projector:Boolean(info.props.modalities?.vision||info.props.modalities?.audio),runner:'llamacpp',quantization:info.props.model_ftype,aliasDefinition:null};
  }
  return {runtime:'ollama',version:info.version.version,build:`official-v${info.version.version}`,effectiveContext:info.runner.context_length,
    parallel:1,batch:null,ubatch:null,projector:'package components retained; no image requests',runner:info.runner.runner,
    quantization:v.format.split(' ').at(-1),aliasDefinition};
}
export function assertPinned(v, settings) {
  if (settings.effectiveContext!==4096||settings.parallel!==1 || (v.runtime==='llama' && settings.projector!==false)
      || (v.batch && (settings.batch!==4096||settings.ubatch!==4096))) throw new Error(`Runtime settings are not pinned for ${v.id}: ${JSON.stringify(settings)}`);
}
async function fileDigest(path) { const h=createHash('sha256'); for await(const x of createReadStream(path)) h.update(x); return h.digest('hex'); }
async function nativeManifest(model) {
  const [name,tag]=model.split(':');
  // Locally created0.40.18 aliases use v2 named symlinks; older pulls may
  // retain legacy anchors. Both ultimately identify the API's manifest blob.
  let path=join(homedir(),'.ollama/models/manifests-v2/ollama.com/library',name,tag);
  let bytes;
  try { bytes=await readFile(path); } catch(error) {
    if(error.code!=='ENOENT')throw error;
    path=join(homedir(),'.ollama/models/manifests/registry.ollama.ai/library',name,tag);
    bytes=await readFile(path);
  }
  const manifest=JSON.parse(bytes);
  const api=(await json(`${ENDPOINTS.ollama}/api/tags`)).models.find(m=>m.name===model);
  const digest=api.digest.replace(/^sha256:/,'');
  if(createHash('sha256').update(bytes).digest('hex')!==digest) {
    const extra=manifest.layers.find(l=>l.digest===`sha256:${digest}`&&l.mediaType==='application/vnd.docker.distribution.manifest.v2+json');
    if(!extra)throw new Error('Unbound published manifest');
    const raw=await readFile(join(homedir(),'.ollama/models/blobs',extra.digest.replace(':','-')));
    if(createHash('sha256').update(raw).digest('hex')!==digest || !isDeepStrictEqual({...manifest,layers:manifest.layers.filter(l=>l!==extra)},JSON.parse(raw)))throw new Error('Manifest digest mismatch');
  }
  let logicalBytes=bytes.length,allocatedBytes=(await stat(path)).blocks*512;
  for(const l of new Map([...manifest.layers,manifest.config].map(l=>[l.digest,l])).values()) {
    const s=await stat(join(homedir(),'.ollama/models/blobs',l.digest.replace(':','-')));
    if(s.size!==l.size)throw new Error('Model blob size mismatch');logicalBytes+=s.size;allocatedBytes+=s.blocks*512;
  }
  return {digest,disk:{logicalBytes,allocatedBytes,scope:'Full derived-alias package; any vision/projector tensors included; shared blobs charged fully'}};
}
export async function identity(v, aliasDefinition) {
  if(v.runtime==='ollama') {
    const m=await nativeManifest(v.model);const show=await json(`${ENDPOINTS.ollama}/api/show`,{model:v.model});
    return publicValue({manifestSha256:m.digest,sourceManifestSha256:aliasDefinition.sourceDigest,family:v.family,format:v.format,aliasDefinition,
      metadata:{details:show.details,model_info:show.model_info,parameters:show.parameters,requires:show.requires,capabilities:show.capabilities},disk:m.disk});
  }
  const repo=v.model.split(':')[0], meta=await json(`https://huggingface.co/api/models/${repo}?blobs=true`);
  const file=meta.siblings.find(x=>x.rfilename===v.file);if(!file?.lfs?.sha256)throw new Error(`Missing exact file ${v.file}`);
  await assertExclusive(v);await json(`${ENDPOINTS.llama}/models/load`,{model:v.model});
  let info;try{info=await runtimeInfo(v);}finally{await unload(v);}
  const path=info.props.model_path;
  if(!path.endsWith(join(`models--${repo.replace('/','--')}`,'snapshots',meta.sha,v.file)))throw new Error('Unexpected downloaded revision/path');
  if(await fileDigest(path)!==file.lfs.sha256)throw new Error('GGUF SHA mismatch');
  await localRecord(`local-${v.id}.json`,{path,info});
  const s=await stat(path);
  return {repository:repo,revision:meta.sha,file:v.file,sha256:file.lfs.sha256,family:v.family,architecture:meta.gguf?.architecture??null,
    disk:{logicalBytes:s.size,allocatedBytes:s.blocks*512,scope:'Primary text GGUF only; projector excluded (no-mmproj)'}};
}
export async function verifyPinned(v, id) {
  if(v.runtime==='ollama') {
    const api=(await json(`${ENDPOINTS.ollama}/api/tags`)).models.find(m=>m.name===v.model);
    if(api?.digest.replace(/^sha256:/,'')!==id.manifestSha256)throw new Error('Alias changed since freeze');
  } else { const local=JSON.parse(await readFile(new URL(`raw/phase1b/local-${v.id}.json`,LOCAL))); if(await fileDigest(local.path)!==id.sha256)throw new Error('GGUF changed since freeze'); }
}
export const LLAMA_LOG=join(homedir(),'Library/Logs/Llama/llama-server.log');
export async function logOffset(){return(await stat(LLAMA_LOG)).size;}
export async function logSince(n){return(await readFile(LLAMA_LOG)).subarray(n).toString('utf8');}
