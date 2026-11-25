import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CORPUS_HASHES, loadCorpora, validateSelection } from './corpora.mjs';
import { scoreRows, optimizeThreshold, chooseSelection, leaveOneOut } from './metrics.mjs';
import { loadBaselines } from './baselines.mjs';
import { TEMPLATES, templateHash } from './templates.mjs';
import { VARIANTS, variantById } from './registry.mjs';
import { publicValue, LOCAL, localRecord, prepare, identity, classify, runtimeInfo, normalizedSettings, assertPinned,
  assertExclusive, unload, verifyPinned, logOffset, logSince } from './runtime.mjs';
import { environment, startMemorySampler, summarizeMemory } from './observations.mjs';
import { buildReport } from './report.mjs';

const OUT=new URL('../../docs/benchmarks/data/',import.meta.url);
const path=(kind,id)=>new URL(`decision-1b-${kind}-${id}.json`,OUT);
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
async function save(p,x,exclusive=false){await writeFile(p,JSON.stringify(publicValue(x),null,2)+'\n',{flag:exclusive?'wx':'w'});}
const announce=x=>console.log(`${new Date().toISOString()} ${x}`);
function stats(a){a=[...a].sort((x,y)=>x-y);return{n:a.length,median:a.length%2?a[Math.floor(a.length/2)]:(a[a.length/2-1]+a[a.length/2])/2,p90:a[Math.ceil(a.length*.9)-1],min:a[0],max:a.at(-1)};}
async function exists(p){try{await stat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function artifact(v,alias){
  const p=path('identity',v.id);
  if(await exists(p)){const a=await read(p);if(!isDeepStrictEqual(a.variant,v))throw new Error('Registry changed after identity freeze');return a.identity;}
  const value=await identity(v,alias);await save(p,{schemaVersion:2,variant:v,identity:value},true);return value;
}
async function settings(v,alias){const info=await runtimeInfo(v);await localRecord(`runtime-${v.id}.json`,info);const s=normalizedSettings(v,info,alias);assertPinned(v,s);return s;}
async function discovery(v,alias){
  await assertExclusive(v);const corpus=await loadCorpora('discovery'),baseline=await loadBaselines(corpus.cases);
  const id=await artifact(v,alias);await verifyPinned(v,id);
  const receipt=path('selection',v.id);
  const start=v.runtime==='llama'?await logOffset():null;
  let inFlight;
  const result={schemaVersion:2,phase:'discovery',variant:v,identityHash:hash(id),corpusHashes:corpus.hashes,
    environment:publicValue(await environment()),startedAt:new Date().toISOString(),templates:[]};
  try{
    // Real discovery-only preflight observes effective settings before tuning.
    const longest=[...corpus.cases].sort((a,b)=>(b.text.length+b.filters.join('').length)-(a.text.length+a.filters.join('').length))[0];
    await classify(v,longest.text,longest.filters,TEMPLATES[0].id);
    result.runtimeSettings=await settings(v,alias);
    if(await exists(receipt)){
      const frozen=await read(receipt);validateSelection(frozen,{id:v.id,templateId:frozen.templateId},CORPUS_HASHES,templateHash(frozen.templateId),result.runtimeSettings);
      if(frozen.identityHash!==hash(id)||frozen.discoverySha256!==hash(await readFile(path('discovery',v.id))))throw new Error('Frozen evidence changed');
      announce(`retaining phase1b selection ${v.id}`);return;
    }
    for(const t of TEMPLATES){
      announce(`discovery ${v.id} ${t.id}`);const rows=[];inFlight={templateId:t.id,rows};
      for(const c of corpus.cases)rows.push({id:c.id,corpus:c.corpus,filters:c.filters,expected:c.expected,...await classify(v,c.text,c.filters,t.id,result.runtimeSettings.effectiveContext)});
      const ps=rows.flatMap(r=>r.probabilities);if(Math.max(...ps)-Math.min(...ps)<1e-8)throw new Error('Constant probabilities');
      result.templates.push({id:t.id,hash:templateHash(t.id),rows,at05:scoreRows(rows,.5,baseline),optimized:optimizeThreshold(rows,baseline)});
    }
    const current=await settings(v,alias);if(!isDeepStrictEqual(current,result.runtimeSettings))throw new Error('Settings changed during discovery');
    const chosen=chooseSelection(result.templates,baseline),loo=leaveOneOut(result.templates,baseline);
    result.finishedAt=new Date().toISOString();await save(path('discovery',v.id),result);
    const selection={schemaVersion:2,phase:'discovery',frozen:true,frozenAt:new Date().toISOString(),variantId:v.id,templateId:chosen.templateId,
      templateHash:templateHash(chosen.templateId),cutoff:chosen.cutoff,interval:chosen.interval,loo,corpusHashes:CORPUS_HASHES,
      identityHash:hash(id),runtimeSettings:result.runtimeSettings,discoverySha256:hash(await readFile(path('discovery',v.id)))};
    validateSelection(selection,{id:v.id,templateId:selection.templateId},CORPUS_HASHES,selection.templateHash,current);
    await save(receipt,selection,true);announce(`frozen ${v.id} exact=${chosen.scores.all.exactVectors}/88 cutoff=${chosen.cutoff} width=${chosen.interval.width} loo=${loo.exactVectors}/88`);
  }catch(error){await localRecord(`failed-discovery-${v.id}.json`,{result,inFlight,error:error.message});throw error;}
  finally{await unload(v);if(start!==null)await localRecord(`discovery-${v.id}.log`,await logSince(start));}
}
async function performanceRun(v,alias,repetition,order){
  await assertExclusive(v);const corpus=await loadCorpora('discovery'),selection=await read(path('selection',v.id)),id=await artifact(v,alias);
  await verifyPinned(v,id);
  const data={schemaVersion:2,phase:'performance',variant:v,repetition,order,selection,identityHash:hash(id),
    artifact:{model:v.model,format:v.format,digest:id.sha256??id.manifestSha256,disk:id.disk},environment:publicValue(await environment()),
    startedAt:new Date().toISOString(),cells:{},method:{context:4096,parallel:1,cacheControl:'Fresh model child per cell; distinct warmups; unchanged20 medium posts',memoryIntervalMs:200}};
  const sampler=await startMemorySampler(v.runtime==='llama'?9931:11434),offset=v.runtime==='llama'?await logOffset():null;
  try{
    data.cold=await classify(v,corpus.latency.posts[0],corpus.latency.filters3,selection.templateId);
    data.runtimeSettings=await settings(v,alias);
    validateSelection(selection,{id:v.id,templateId:selection.templateId},CORPUS_HASHES,selection.templateHash,data.runtimeSettings);
    for(const count of[3,10])for(const n of[0,1])await classify(v,`Warmup ${count} ${n}: ${corpus.latency.posts[19]}`,corpus.latency[`filters${count}`],selection.templateId);
    const steadyStart=Date.now();await delay(5000);data.steadyMemory=summarizeMemory(sampler.samples,steadyStart,Date.now());
    const cells=[...[3,10].map(n=>({key:String(n),n,templateId:selection.templateId})),...(v.parityGroup?[3,10].map(n=>({key:`parity${n}`,n,templateId:'matches-category'})):[])];
    if(repetition%2)cells.reverse();const speedStart=Date.now();
    for(const c of cells){
      await unload(v);await assertExclusive(v);
      for(const n of[0,1])await classify(v,`Warmup ${c.key} ${n}: ${corpus.latency.posts[19]}`,corpus.latency[`filters${c.n}`],c.templateId);
      validateSelection(selection,{id:v.id,templateId:selection.templateId},CORPUS_HASHES,selection.templateHash,await settings(v,alias));
      const rows=[];for(const [index,text]of corpus.latency.posts.entries())rows.push({index,...await classify(v,text,corpus.latency[`filters${c.n}`],c.templateId)});
      data.cells[c.key]={templateId:c.templateId,filters:corpus.latency[`filters${c.n}`],rows,wallMs:stats(rows.map(r=>r.wallMs))};
    }
    data.identicalRequests=[];for(let n=0;n<5;n++)data.identicalRequests.push(await classify(v,corpus.latency.posts[0],corpus.latency.filters3,selection.templateId));
    data.identicalProbabilities=data.identicalRequests.every(r=>JSON.stringify(r.probabilities)===JSON.stringify(data.identicalRequests[0].probabilities));
    data.speedMemory=summarizeMemory(sampler.samples,speedStart,Date.now());data.finishedAt=new Date().toISOString();
  }finally{
    await unload(v);await sampler.close();
    if(data.finishedAt)data.runMemory=summarizeMemory(sampler.samples,Date.parse(data.startedAt),Date.parse(data.finishedAt));
    await localRecord(`memory-${v.id}-r${repetition}.json`,sampler.samples);
    if(offset!==null)await localRecord(`speed-${v.id}-r${repetition}.log`,await logSince(offset));
    await save(path(`speed-r${repetition}`,v.id),data);
  }
}
export function assertTokenParity(values){if(!values.length||!values.every(n=>Number.isInteger(n)&&n===values[0]))throw new Error(`Token parity differs: ${values.join(',')}`);}
async function parityReceipt(){
  const groups={};
  for(const group of [...new Set(VARIANTS.map(v=>v.parityGroup).filter(Boolean))]){
    const members=VARIANTS.filter(v=>v.parityGroup===group),differences=[];
    for(const repetition of[0,1,2])for(const count of[3,10]){
      const rows=await Promise.all(members.map(async v=>(await read(path(`speed-r${repetition}`,v.id))).cells[`parity${count}`].rows));
      for(let index=0;index<20;index++){const tokens=rows.map(rs=>rs[index].usage.input_tokens);try{assertTokenParity(tokens);}catch{differences.push({repetition,count,index,tokens:Object.fromEntries(members.map((v,i)=>[v.id,tokens[i]]))});}}
    }
    groups[group]={templateId:'matches-category',variants:members.map(v=>v.id),passed:differences.length===0,differences};
  }
  await save(new URL('decision-1b-parity.json',OUT),{schemaVersion:2,groups});
}
async function archiveRaw(){
  const raw=new URL('raw/',LOCAL),tar=new URL('decision-raw.tar',LOCAL);await mkdir(raw,{recursive:true});
  await promisify(execFile)('tar',['-cf',fileURLToPath(tar),'-C',fileURLToPath(raw),'.']);
  await save(new URL('decision-1b-archive.json',OUT),{schemaVersion:2,path:'scripts/decision-eval/.tmp/decision-raw.tar',sha256:hash(await readFile(tar)),bytes:(await stat(tar)).size,entries:await readdir(raw)});
}
async function main(){
  const [command,id,repetition]=process.argv.slice(2);
  if(command==='validation'){
    if(repetition!==undefined)throw new Error('Validation accepts only an optional pre-registered variant id');
    await(await import('./run-validation.mjs')).runValidation(id);return;
  }
  if(command==='list'){console.log(JSON.stringify(VARIANTS,null,2));return;}
  if(!['prepare','discovery','speed','all','archive'].includes(command))throw new Error('Usage: node scripts/decision-eval/run.mjs all|discovery|speed|prepare|archive [id] [repetition]');
  await mkdir(OUT,{recursive:true});if(command==='archive'){await archiveRaw();return;}
  const variants=id?[variantById(id)]:VARIANTS,aliases=new Map();
  for(const v of variants){const alias=await prepare(v);aliases.set(v.id,alias);if(['all','discovery'].includes(command))await discovery(v,alias);}
  if(['all','speed'].includes(command))for(const r of repetition===undefined?[0,1,2]:[Number(repetition)]){
    if(![0,1,2].includes(r))throw new Error('Repetition must be0,1,2');const shift=Math.floor(VARIANTS.length*r/3),order=[...VARIANTS.slice(shift),...VARIANTS.slice(0,shift)].filter(v=>variants.includes(v));
    for(const v of order){announce(`speed ${v.id} rotation${r}`);await performanceRun(v,aliases.get(v.id),r,order.map(v=>v.id));}
  }
  if(command==='all'){
    if(!id)await parityReceipt();await archiveRaw();const report=await buildReport({partial:Boolean(id)});await writeFile(new URL('../decision-models.md',OUT),report.markdown);
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch(e=>{console.error(publicValue(e.message));process.exitCode=1;});
