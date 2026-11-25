/** One-off offline discovery conversion; never loads a model or holdout file. */
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { ROOT, FILES, hash, saveTone, serializeTone } from './tone-label.mjs';
import { expandToneEvidence, packToneEvidence } from './tone-label-evidence.mjs';
import { analyzeTone } from './tone-label-study.mjs';
import { publicValue } from './runtime.mjs';

const insist = (ok, message) => { if (!ok) throw new Error(message); };
export function discoveryHeadlines(summary) {
  const p0 = summary.policies.find(row => row.id === 'P0');
  const short = summary.shortRuleGrid.bestByMaxOwnWords.find(row => row.maxOwnWords === 3);
  return { P0: { errors: p0.errors, FP: p0.FP, FN: p0.FN },
    wordingErrors: Object.fromEntries(summary.wordings.map(row => [row.id, row.errors])),
    shortRuleN3: { cutoff: short.cutoff, errors: short.errors },
    twinMedianDrop: Object.fromEntries(summary.diagnostics.twins.map(row => [row.wording, row.medianSourceMinusTwin])) };
}

export function discoverySummary(raw) {
  raw = expandToneEvidence(raw);
  insist(raw.phase === 'tone-label-discovery' && raw.status === 'complete' && raw.corpusSnapshot.split === 'discovery', 'Complete discovery evidence is required');
  insist(raw.requestsIssued === raw.requests.length && raw.activeRequest === null, 'Discovery evidence has unfinished sends');
  return { ...analyzeTone({ phase: 'discovery', corpus: raw.corpusSnapshot, rows: raw.rows, plan: raw.plan,
    requests: raw.requests, policies: raw.policies, wordings: raw.wordings }), schemaVersion: 1, phase: raw.phase, status: 'complete',
  startedAt: raw.startedAt, finishedAt: raw.finishedAt, rawFile: FILES.discoveryRaw,
  model: raw.model, corpusHashes: raw.corpusHashes, immutableEvidenceUnchanged: true };
}

/** All checks and equality comparisons precede replacement of the old evidence. */
export async function convertDiscovery({ root = ROOT, log = console.log } = {}) {
  const out = new URL('docs/benchmarks/data/', root), local = new URL('scripts/decision-eval/.tmp/tone-label-conversion/', root);
  const rawBytes = await readFile(new URL(FILES.discoveryRaw, out)), oldRaw = JSON.parse(rawBytes);
  insist(oldRaw.evidenceFormat === undefined, 'Discovery is already converted; use verify instead');
  const summaryBytes = await readFile(new URL(FILES.discoverySummary, out)), oldSummary = JSON.parse(summaryBytes);
  insist(oldSummary.rawFile === FILES.discoveryRaw && oldSummary.rawSha256 === hash(rawBytes), 'Original discovery summary SHA-256 differs');
  const before = discoveryHeadlines(oldSummary), summary = discoverySummary(oldRaw), after = discoveryHeadlines(summary);
  insist(same(before, after), 'Discovery headlines changed; refusing conversion');
  let journalBytes, oldJournal;
  const raw = structuredClone(oldRaw);
  if (raw.journal) {
    const name = FILES.discoveryRaw.replace(/\.json$/, '-journal.jsonl');
    insist(raw.journal.file === name, 'Unexpected original discovery journal path');
    oldJournal = new URL(name, out); journalBytes = await readFile(oldJournal);
    insist(hash(journalBytes) === raw.journal.sha256, 'Original discovery journal SHA-256 differs');
    raw.journal.file = `scripts/decision-eval/.tmp/tone-label/${name}`;
  }
  raw.conversion = { fromSchemaVersion: 1, inputRawSha256: hash(rawBytes), inputSummarySha256: hash(summaryBytes), headlinesBefore: before };
  const packed = packToneEvidence(raw), expanded = expandToneEvidence(JSON.parse(serializeTone(packed)));
  insist(same(expanded, raw), 'Raw evidence cannot be reconstructed losslessly');
  const bytes = Buffer.byteLength(serializeTone(packed));
  insist(bytes < 4_000_000, 'Compact discovery raw exceeds 4 MB');
  await mkdir(local, { recursive: true });
  await copyFile(new URL(FILES.discoveryRaw, out), new URL('original-raw.json', local));
  await copyFile(new URL(FILES.discoverySummary, out), new URL('original-summary.json', local));
  if (journalBytes) {
    const target = new URL(raw.journal.file, root); await mkdir(new URL('./', target), { recursive: true });
    await writeFile(target, journalBytes);
  }
  await saveTone(FILES.discoveryRaw, packed, out);
  summary.rawSha256 = hash(await readFile(new URL(FILES.discoveryRaw, out)));
  await saveTone(FILES.discoverySummary, summary, out);
  if (oldJournal) await rm(oldJournal);
  log(`BEFORE ${JSON.stringify(publicValue(before))}`);
  log(`AFTER  ${JSON.stringify(publicValue(after))}`);
  log(`MATCH true; discovery raw ${rawBytes.length} -> ${bytes} bytes`);
  return { before, after, bytes };
}

export async function verifyDiscovery({ root = ROOT, log = console.log } = {}) {
  const out = new URL('docs/benchmarks/data/', root), bytes = await readFile(new URL(FILES.discoveryRaw, out));
  const raw = expandToneEvidence(JSON.parse(bytes));
  const summary = JSON.parse(await readFile(new URL(FILES.discoverySummary, out)));
  const before = raw.conversion?.headlinesBefore ?? discoveryHeadlines(summary), after = discoveryHeadlines(discoverySummary(raw));
  insist(summary.rawSha256 === hash(bytes) && same(before, after) && same(after, discoveryHeadlines(summary)), 'Discovery conversion verification differs');
  log(`BEFORE ${JSON.stringify(publicValue(before))}`); log(`AFTER  ${JSON.stringify(publicValue(after))}`);
  log(`MATCH true; discovery raw ${bytes.length} bytes`);
  return { before, after, bytes: bytes.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(resolve(process.argv[1])))) {
  const [command = 'convert', ...args] = process.argv.slice(2);
  if (args.length || !['convert', 'verify'].includes(command)) throw new Error('Usage: node scripts/decision-eval/tone-label-convert.mjs convert|verify');
  (command === 'convert' ? convertDiscovery() : verifyDiscovery()).catch(error => { console.error(publicValue(error.message)); process.exitCode = 1; });
}
