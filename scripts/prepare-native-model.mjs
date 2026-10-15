#!/usr/bin/env node
// Operator-only installation. Never imported by the extension.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const base = 'http://127.0.0.1:11434';
const weight = '3646b4c147cd235a44d91df1546d3b7d8e29b547dbe4e1f80856419aa455e6fd';
const bytes = 3349514112;
const alias = 'bouncer-gemma4-e2b-qat-text:v1';

export const HELP_TEXT = `Usage: node scripts/prepare-native-model.mjs [--help]

With no arguments, prepare ${alias} using existing local source weights.
Requires the existing Ollama 0.40.3 app at ${base}, no resident
native models, and the exact Gemma 4 E2B QAT weights and license in ~/.ollama/models.
Verifies source size/SHA-256, imports the alias only when absent, preserves
existing aliases and verifies the imported local model without inference.
Writes the Modelfile and identity report under .native-preparation in the
current directory. Nothing is downloaded and native model files are not edited
directly. See docs/models.md for the exact artifact and operator procedure.

  --help, -h  Show this help without native reads, requests or model preparation.
No other arguments are supported.
`;

export function parseArguments(args) {
  if (args.length === 0) return 'prepare';
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return 'help';
  throw new Error('Unsupported model preparation option; use --help. No supplied values were printed.');
}
async function api(route, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}
// The mutating CLI must target the same loopback service as verification.
export function importLocalModel(modelfile, create = spawn) {
  return new Promise((resolve, reject) => {
    const child = create('ollama', ['create', alias, '-f', modelfile], {
      stdio: 'inherit', env: { ...process.env, OLLAMA_HOST: base },
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ollama create exited ${code}`)));
  });
}

export async function prepareNativeModel() {
const store = path.join(homedir(), '.ollama', 'models');
const blob = path.join(store, 'blobs', `sha256-${weight}`);
const licensePath = path.join(store, 'blobs', 'sha256-0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594');
const folder = path.resolve('.native-preparation');
const version = await api('/api/version');
if (version.version !== '0.40.3') throw new Error('Qualify the installed Ollama version before preparing this recipe');
const ps = await api('/api/ps');
if (ps.models?.length) throw new Error('Prepare while no native model is resident; existing work was preserved');
const original = await api('/api/tags');
const existing = original.models.find(m => m.name === alias);
if ((await stat(blob)).size !== bytes) throw new Error('Wrong source size');
const hash = createHash('sha256');
for await (const chunk of createReadStream(blob)) hash.update(chunk);
if (hash.digest('hex') !== weight) throw new Error('Wrong source SHA-256');
const license = await readFile(licensePath, 'utf8');
if (license.includes('"""')) throw new Error('Unexpected license delimiter');
await mkdir(folder, { recursive: true });
const modelfile = path.join(folder, 'Modelfile.qat-text');
await writeFile(modelfile, `FROM ${blob}\nRENDERER gemma4-small\nPARSER gemma4\nREQUIRES 0.30.5\nPARAMETER temperature 1\nPARAMETER top_k 64\nPARAMETER top_p 0.95\nLICENSE """${license}"""\n`);
if (!existing) await importLocalModel(modelfile);
const tags = await api('/api/tags');
const model = tags.models.find(m => m.name === alias);
if (!model || !/^[a-f0-9]{64}$/.test(model.digest)) throw new Error('Created alias metadata missing');
for (const old of original.models) {
  if (!tags.models.some(m => m.name === old.name && m.digest === old.digest)) throw new Error('An existing alias changed');
}
// New Ollama creates content-addressed manifest blobs instead of legacy alias files.
const manifestBytes = await readFile(path.join(store, 'blobs', `sha256-${model.digest}`));
if (createHash('sha256').update(manifestBytes).digest('hex') !== model.digest) throw new Error('Manifest hash mismatch');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifest.layers.some(l => /projector|draft/.test(l.mediaType))) throw new Error('Unexpected projector/draft layer');
const weights = manifest.layers.filter(l => l.mediaType === 'application/vnd.ollama.image.model');
if (weights.length !== 1 || weights[0].digest !== `sha256:${weight}` || weights[0].size !== bytes) throw new Error('Imported weights changed');
const config = JSON.parse(await readFile(path.join(store, 'blobs', manifest.config.digest.replace(':', '-')), 'utf8'));
if (config.renderer !== 'gemma4-small' || config.parser !== 'gemma4') throw new Error('Wrong renderer/parser');
const show = await api('/api/show', { model: `sha256-${model.digest}:local` });
if (show.remote_host || show.remote_model || !show.capabilities?.includes('completion')) throw new Error('Not a local completion model');
if ((await api('/api/ps')).models?.length) throw new Error('Preparation unexpectedly loaded a model');
const report = { preparedAt: new Date().toISOString(), version, alias, model, weights, config, show, note: 'No inference; original native aliases preserved; exact existing weights reused' };
await writeFile(path.join(folder, 'qat-text-identity.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ alias, digest: model.digest, bytes: model.size, capabilities: show.capabilities, residentModels: 0 }));
}

// CLI validation happens before any preparation, including native path lookup.
export async function main(args = process.argv.slice(2), prepare = prepareNativeModel) {
  if (parseArguments(args) === 'help') return HELP_TEXT;
  return prepare();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await main();
    if (typeof result === 'string') console.log(result);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
