import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CORPUS_HASHES } from '../corpora.mjs';
import { buildReport } from '../report.mjs';
import { VARIANTS } from '../registry.mjs';
import { TEMPLATES, templateHash } from '../templates.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('tiny recorded fixture renders stored scores and full settings without choosing a model', async () => {
  const scratch = new URL('../.tmp/', import.meta.url);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(new URL('report-test-', scratch));
  const variant = VARIANTS[0], identity = { sha256: 'a'.repeat(64), disk: { logicalBytes: 123, allocatedBytes: 512, scope: 'primary GGUF; no projector' } };
  const runtimeSettings = { runtime: 'llama', effectiveContext: 4096, parallel: 1, projector: 'none', aliasDefinition: `definition-${'x'.repeat(240)}` };
  const group = { hide: { tp: 1, tn: 0, n: 1, f1: 1 }, exactVectors: 1, totalVectors: 1,
    falseHides: 0, missedHides: 0, newFalseHides: null, newMissedHides: null };
  const scores = { all: group, rage: group, broad: group };
  const discovery = { schemaVersion: 2, phase: 'discovery', variant, identityHash: sha256(JSON.stringify(identity)), corpusHashes: CORPUS_HASHES,
    runtimeSettings, templates: TEMPLATES.map(item => ({ id: item.id, hash: templateHash(item.id), rows: [], at05: scores,
      optimized: { cutoff: 0.75, interval: { lower: 0.6, upper: 0.9 }, scores } })) };
  const rawDiscovery = JSON.stringify(discovery);
  const selection = { schemaVersion: 2, phase: 'discovery', frozen: true, variantId: variant.id, templateId: TEMPLATES[0].id,
    templateHash: templateHash(TEMPLATES[0].id), cutoff: 0.75, interval: discovery.templates[0].optimized.interval,
    identityHash: discovery.identityHash, corpusHashes: CORPUS_HASHES, discoverySha256: sha256(rawDiscovery), runtimeSettings, loo: scores };
  const save = (name, value) => writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  try {
    await save('decision-baselines.json', { baselines: [], sources: { originalDiscovery: {} } });
    await save(`decision-1b-identity-${variant.id}.json`, { schemaVersion: 2, variant, identity });
    await save(`decision-1b-discovery-${variant.id}.json`, rawDiscovery);
    await save(`decision-1b-selection-${variant.id}.json`, selection);
    for (const repetition of [0, 1, 2]) {
      const cell = { rows: [{ wallMs: 10 + repetition, usage: { input_tokens: 20 + repetition } }] };
      await save(`decision-1b-speed-r${repetition}-${variant.id}.json`, { schemaVersion: 2, phase: 'performance',
        variant, repetition, identityHash: discovery.identityHash, selection, runtimeSettings,
        artifact: { model: variant.model, format: variant.format, digest: identity.sha256, disk: identity.disk },
        cells: { 3: cell, 10: cell, parity3: cell, parity10: cell }, cold: { wallMs: 30 + repetition } });
    }
    const result = await buildReport({ partial: true, dataDirectory: directory });
    const publicSummary = (await readFile(new URL('../public-summary.md', import.meta.url), 'utf8')).trim();
    assert.ok(result.markdown.startsWith('# Decision-model evaluation\n\n' + publicSummary + '\n\n'));
    assert.match(result.markdown, /Historical Gemma baselines were recorded on the same machine in October 2026/);
    assert.doesNotMatch(result.markdown, /github\.com\/https:|blob\/undefined|commit `undefined`/);
    assert.equal(result.variants, VARIANTS.length);
    assert.equal(result.complete, 1);
    assert.match(result.markdown, /Same template at 0\.5/);
    assert.match(result.markdown, /Leave-one-out selection/);
    assert.ok(result.markdown.includes(runtimeSettings.aliasDefinition), 'recorded settings must not be truncated');
    assert.match(result.markdown, /No input truncation is permitted/);
    assert.match(result.markdown, /21\.0 \(20–22\)/);
    assert.match(result.markdown, /11\.00 \/ 12\.00 \(3\)/);
    assert.match(result.markdown, /— \/ —/);
    assert.doesNotMatch(result.markdown, /My pick|recommended candidate|\/Users\//);
    await assert.rejects(buildReport({ dataDirectory: directory }), /ENOENT/);
    await save(`decision-1b-selection-${variant.id}.json`, { ...selection, discoverySha256: 'b'.repeat(64) });
    await assert.rejects(buildReport({ partial: true, dataDirectory: directory }), /frozen selection binding differs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
