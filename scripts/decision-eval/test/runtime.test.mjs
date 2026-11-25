import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { VARIANTS, variantById } from '../registry.mjs';
import { parseProbabilities, assertNoTruncation, assertPreset, normalizedSettings, assertPinned, publicValue } from '../runtime.mjs';
import { assertTokenParity } from '../run.mjs';

test('phase1b registry distinguishes d1 checkpoints and excludes retired Laya',()=>{
  assert.equal(new Set(VARIANTS.map(v=>v.id)).size,VARIANTS.length);
  for(const id of ['llama-kev-q8','ollama-kev-q8','ollama-kev-mxfp8','llama-d1omni2b-q8','llama-d1-2b-q8','llama-d1-2b-q4km','ollama-d1-2b-mxfp8','ollama-d1-2b-nvfp4','llama-d1omni600m-q8'])assert.equal(variantById(id).id,id);
  assert(!VARIANTS.some(v=>v.model.includes('Laya')));
  assert.notEqual(variantById('llama-d1omni2b-q8').family,variantById('ollama-d1-2b-mxfp8').family);
  assert.equal(variantById('llama-d1-2b-q8').family,variantById('ollama-d1-2b-mxfp8').family);
});
test('strict noul parser rejects incomplete or nonfinite probabilities',()=>{
  assert.deepEqual(parseProbabilities({answers:{f0:{type:'noul',noul:0},f1:{type:'noul',noul:1}}},2),[0,1]);
  for(const r of[{},null,{answers:{f0:{type:'noul',noul:NaN}}},{answers:{f0:{type:'choice',noul:.5}}}])assert.throws(()=>parseProbabilities(r,1));
});
test('token accounting detects context overflow, missing accounting and truncation',()=>{
  assert.equal(assertNoTruncation({usage:{input_tokens:4095}},4096),4095);
  for(const r of[{usage:{input_tokens:4096}},{usage:{input_tokens:5000}},{usage:{}},{usage:{input_tokens:20},truncated:true},{usage:{input_tokens:20,truncated:true}}])assert.throws(()=>assertNoTruncation(r,4096),/Truncation/);
  assert.doesNotThrow(()=>assertTokenParity([140,140]));assert.throws(()=>assertTokenParity([140,141]),/Token parity differs/);
});
test('pinned preset requires the source binding as well as context and slots',()=>{
  const v=variantById('llama-d1-2b-q8');const args=['--ctx-size','4096','--parallel','1','--batch-size','4096','--ubatch-size','4096','--no-mmproj-auto'];
  assert.throws(()=>assertPreset(v,{status:{args}}),/Missing model binding/);
  assert.doesNotThrow(()=>assertPreset(v,{status:{args:[...args,'--hf-repo',v.model]}}));
  assert.throws(()=>assertPinned(v,{effectiveContext:73728,parallel:1,projector:false}),/not pinned/);
});
test('serialized public values never retain a private home path',()=>{
  const home='/'+'Users/'+'someone';const s=publicValue({path:home+'/cache/model',nested:[home+'/log']});
  assert(!JSON.stringify(s).includes('/'+'Users/'));
});
test('validation CLI rejects an unregistered variant before runtime requests',async()=>{
  await assert.rejects(promisify(execFile)(process.execPath,[new URL('../run.mjs',import.meta.url).pathname,'validation','not-registered']),e=>/not pre-registered/.test(e.stderr));
});
