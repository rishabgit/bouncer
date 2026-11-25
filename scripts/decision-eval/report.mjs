import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CORPUS_HASHES } from './corpora.mjs';
import { VARIANTS } from './registry.mjs';
import { TEMPLATES, templateHash } from './templates.mjs';
import { renderValidation } from './validation-report.mjs';
import { renderWordingProbe } from './wording-report.mjs';
import { renderGuidanceFresh } from './guidance-report.mjs';
import { renderCapacity } from './capacity-report.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA = resolve(ROOT, 'docs/benchmarks/data');
const OUTPUT = resolve(DATA, '../decision-models.md');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashIdentity = value => sha256(JSON.stringify(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = isDeepStrictEqual;
const text = value => value == null ? '—' : String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const number = (value, places = 2) => Number.isFinite(value) ? value.toFixed(places) : '—';
const gib = value => Number.isFinite(value) ? number(value / 1024 ** 3, 3) : '—';
const gb = value => Number.isFinite(value) ? number(value / 1e9, 3) : '—';
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(text).join(' | ')} |`)].join('\n');
const median = values => { const a = values.filter(Number.isFinite).sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length ? a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 : null; };

async function readJson(directory, name, optional, pending) {
  try { const raw = await readFile(resolve(directory, name)); return { value: JSON.parse(raw.toString('utf8')), sha256: sha256(raw) }; }
  catch (error) { if (error.code === 'ENOENT' && optional) { pending?.push(name); return null; } throw new Error(`${name}: ${error.message}`, { cause: error }); }
}

// Check recorded provenance, not model behavior or recomputed optimizer results.
function bind(files, variant) {
  const id = variant.id, identity = files.identity?.value, discovery = files.discovery?.value, selection = files.selection?.value;
  if (identity) assert(identity.schemaVersion === 2 && same(identity.variant, variant) && identity.identity, `${id}: identity differs`);
  if (discovery) {
    assert(identity && discovery.schemaVersion === 2 && discovery.phase === 'discovery' && same(discovery.variant, variant)
      && discovery.identityHash === hashIdentity(identity.identity) && same(discovery.corpusHashes, CORPUS_HASHES), `${id}: discovery provenance differs`);
    assert(discovery.templates?.length === TEMPLATES.length && discovery.templates.every((item, i) => item.id === TEMPLATES[i].id
      && item.hash === templateHash(item.id)), `${id}: discovery template hashes differ`);
  }
  const chosen = discovery?.templates.find(item => item.id === selection?.templateId);
  if (selection) assert(chosen && selection.schemaVersion === 2 && selection.phase === 'discovery' && selection.frozen === true
    && selection.variantId === id && selection.identityHash === hashIdentity(identity.identity)
    && selection.discoverySha256 === files.discovery.sha256 && same(selection.corpusHashes, CORPUS_HASHES)
    && selection.templateHash === chosen.hash && selection.cutoff === chosen.optimized.cutoff
    && same(selection.interval, chosen.optimized.interval) && same(selection.runtimeSettings, discovery.runtimeSettings), `${id}: frozen selection binding differs`);
  const speed = [0, 1, 2].flatMap(repetition => {
    const value = files[`speed-r${repetition}`]?.value;
    if (!value) return [];
    assert(selection && value.schemaVersion === 2 && value.phase === 'performance' && value.repetition === repetition
      && same(value.variant, variant) && value.identityHash === hashIdentity(identity.identity) && same(value.selection, selection)
      && value.artifact?.model === variant.model && value.artifact?.format === variant.format
      && value.artifact?.digest === (identity.identity.sha256 ?? identity.identity.manifestSha256)
      && same(value.artifact?.disk, identity.identity.disk) && same(value.runtimeSettings, selection.runtimeSettings), `${id}: speed provenance differs`);
    return [value];
  });
  return { variant, identity: identity?.identity, discovery, selection, chosen, speed };
}

function quality(scores) {
  if (!scores) return ['—', '—', '—', '—', '—'];
  const groups = scores.groups ?? scores, all = groups.all ?? groups;
  const hide = group => group?.hide ? `${group.hide.tp + group.hide.tn}/${group.hide.n}; F1 ${number(group.hide.f1, 4)}` : '—';
  return [hide(groups.rage), groups.broad ? `${hide(groups.broad)}; E ${groups.broad.exactVectors}/${groups.broad.totalVectors}` : '—',
    `${text(all.exactVectors)}/${text(all.totalVectors)}`, `${text(all.falseHides)} / ${text(all.missedHides)}`,
    `${text(all.newFalseHides)} / ${text(all.newMissedHides)}`];
}

function timing(runs, cell) {
  const rows = runs.flatMap(run => run.cells?.[cell]?.rows ?? []);
  if (runs.length !== 3 || !rows.length) return ['pending', 'pending'];
  const times = rows.map(row => row.wallMs).sort((a, b) => a - b), tokens = rows.map(row => row.usage?.input_tokens);
  return [`${number(median(times))} / ${number(times[Math.ceil(times.length * .9) - 1])} (${times.length})`,
    tokens.every(Number.isFinite) ? `${number(tokens.reduce((sum, value) => sum + value, 0) / tokens.length, 1)} (${Math.min(...tokens)}–${Math.max(...tokens)})` : 'unavailable'];
}

function speedRow(item, parity = false) {
  return [item.variant.id, ...timing(item.speed, parity ? 'parity3' : '3'), ...timing(item.speed, parity ? 'parity10' : '10')];
}

function memoryRow(item) {
  const runs = item.speed.length === 3 ? item.speed : [];
  return [item.variant.id, gib(median(runs.map(run => run.steadyMemory?.medianRssBytes))), gib(median(runs.map(run => run.steadyMemory?.medianFootprintBytes))),
    gib(runs.length ? Math.max(...runs.map(run => (run.runMemory ?? run.speedMemory)?.peakRssBytes)) : null),
    gib(runs.length ? Math.max(...runs.map(run => (run.runMemory ?? run.speedMemory)?.peakFootprintBytes)) : null)];
}

/** Saved evidence rendering: no runtime imports, inference, scoring, or optimization. */
export async function buildReport({ partial = false, dataDirectory = DATA } = {}) {
  const pending = [], results = [];
  const publicSummary = (await readFile(new URL('./public-summary.md', import.meta.url), 'utf8')).trim();
  const baselines = (await readJson(dataDirectory, 'decision-baselines.json', false)).value;
  const phase1 = (await readJson(dataDirectory, 'decision-phase1.json', true))?.value;
  const parity = (await readJson(dataDirectory, 'decision-1b-parity.json', true))?.value;
  const archive = (await readJson(dataDirectory, 'decision-1b-archive.json', true))?.value;
  const blocker = (await readJson(dataDirectory, 'decision-1b-blocker.json', true))?.value;
  const validation = await renderValidation({ dataDirectory });
  const wordingProbe = await renderWordingProbe({ dataDirectory });
  const guidanceFresh = await renderGuidanceFresh({ dataDirectory });
  const capacity = await renderCapacity({ dataDirectory });
  for (const variant of VARIANTS) {
    const kinds = ['identity', 'discovery', 'selection', 'speed-r0', 'speed-r1', 'speed-r2'];
    const files = await Promise.all(kinds.map(kind => readJson(dataDirectory, `decision-1b-${kind}-${variant.id}.json`, partial, pending)));
    results.push(bind(Object.fromEntries(kinds.map((kind, i) => [kind, files[i]])), variant));
  }
  const complete = results.filter(item => item.selection && item.speed.length === 3).length;
  const browser = baselines.baselines?.find(item => item.id === 'litert');
  const comparisonRows = results.map(item => [item.variant.id, item.variant.format, gb(item.identity?.disk?.logicalBytes),
    `${gib(median(item.speed.map(run => run.steadyMemory?.medianRssBytes)))} / ${gib(median(item.speed.map(run => run.steadyMemory?.medianFootprintBytes)))}`,
    timing(item.speed, '3')[0], timing(item.speed, '10')[0], number(median(item.speed.map(run => run.cold?.wallMs))),
    `${text(item.chosen?.optimized.scores.all.exactVectors)}/88; ${text(item.chosen?.at05.all.exactVectors)}/88`]);
  for (const baseline of [...(baselines.baselines ?? [])].reverse()) {
    const increment = baseline.id === 'litert';
    const memory = field => gib(median(baseline.memory.runs.map(run => run[increment ? 'loadedIdleDeltaBytes' : 'loadedIdleMedianBytes'][field])));
    const latency = n => { const cell = baseline.warmLatencyMsByCell[`medium-${n}-distinct`]; return `${number(cell.median)} / ${number(cell.p90)} (${cell.n})`; };
    comparisonRows.unshift([`${baseline.label} (historical)`, [baseline.artifact.format, baseline.artifact.quantization].filter(Boolean).join(' '), gb(baseline.artifact.bytes),
      `${memory('rss_bytes')} / ${memory('footprint_bytes')}${increment ? ' increment' : ''}`, latency(3), latency(10), number(baseline.coldLatencyMs.median),
      `${baseline.quality.combined.exactVectorCorrectCases}/88 (historical prompt)`]);
  }
  const historical = baselines.sources?.originalDiscovery;
  const browserMemory = browser?.memory.runs.map(run => run.loadedIdleDeltaBytes.footprint_bytes).filter(Number.isFinite) ?? [];
  const browserRange = field => browser ? `${gib(Math.min(...browser.memory.runs.map(run => run.loadedIdleDeltaBytes[field])))}–${gib(Math.max(...browser.memory.runs.map(run => run.loadedIdleDeltaBytes[field])))}` : '—';
  const memoryRows = results.map(memoryRow);
  if (browser) memoryRows.unshift(['Browser Gemma (historical increment)', browserRange('rss_bytes'), browserRange('footprint_bytes'),
    gib(Math.max(...browser.memory.runs.map(run => run.sampledCurrentPeakBytes.rss_bytes-run.baselineMedianBytes.rss_bytes))),
    gib(Math.max(...browser.memory.runs.map(run => run.sampledCurrentPeakBytes.footprint_bytes-run.baselineMedianBytes.footprint_bytes)))]);
  const timingRows = results.map(item => [...speedRow(item), item.speed.length === 3 ? number(median(item.speed.map(run => run.cold?.wallMs))) : 'pending',
    item.speed.length === 3 ? item.speed.every(run => run.identicalProbabilities) ? 'yes (5 × 3 controls)' : 'no; see receipts' : 'pending']);
  if (browser) {
    const cell = n => browser.warmLatencyMsByCell[`medium-${n}-distinct`];
    timingRows.unshift(['Browser Gemma (historical)', `${number(cell(3).median)} / ${number(cell(3).p90)} (${cell(3).n})`, 'different tokenizer',
      `${number(cell(10).median)} / ${number(cell(10).p90)} (${cell(10).n})`, 'different tokenizer', number(browser.coldLatencyMs.median), 'not a probability API']);
  }
  const artifacts = results.map(item => [item.variant.id, item.variant.model, item.variant.format,
    `${gb(item.identity?.disk?.logicalBytes)} / ${gb(item.identity?.disk?.allocatedBytes)}`, item.identity?.disk?.scope ?? 'pending',
    (item.speed[0]?.runtimeSettings ?? item.discovery?.runtimeSettings)?.projector ?? 'pending']);
  const qualities = results.flatMap(item => item.selection ? [
    [item.variant.id, `${item.selection.templateId} ≥ ${item.selection.cutoff}; ${text(item.selection.interval)}`, ...quality(item.chosen.optimized.scores)],
    [item.variant.id, 'Same template at 0.5', ...quality(item.chosen.at05)],
    [item.variant.id, 'Leave-one-out selection', ...quality(item.selection.loo?.scores ?? item.selection.loo)],
  ] : [[item.variant.id, 'pending', ...quality(null)]]);
  if (browser) {
    const q = browser.quality;
    qualities.unshift(['Browser Gemma (historical)', 'Historical prompt; no tuned cutoff', `${q.rage.correctHideCases}/${q.rage.uniqueCases}; F1 ${number(q.rage.hideF1, 4)}`,
      `${q.broad.correctHideCases}/${q.broad.uniqueCases}; F1 ${number(q.broad.hideF1, 4)}; E ${q.broad.exactVectorCorrectCases}/${q.broad.uniqueCases}`,
      `${q.combined.exactVectorCorrectCases}/${q.combined.uniqueCases}`, `${q.combined.confusion.fp} / ${q.combined.confusion.fn}`, '0 / 0 (self)']);
  }
  const settings = results.map(item => {
    const s = item.speed[0]?.runtimeSettings ?? item.discovery?.runtimeSettings ?? {};
    return [item.variant.id, s.runtime, s.version, s.build, s.effectiveContext, s.parallel, `${text(s.batch)} / ${text(s.ubatch)}`, s.runner, s.quantization, s.aliasDefinition];
  });
  const parityRows = results.filter(item => item.speed.some(run => run.cells?.parity3 || run.cells?.parity10));
  const lines = [
    '# Decision-model evaluation', '', publicSummary, '',
    `## Detailed recorded evidence: ${validation.hasResults ? 'phase 1b and phase 2' : 'phase 1b'}`, '',
    `**${pending.length ? 'Partial evidence' : 'Recorded evidence'}: ${complete}/${VARIANTS.length} variants have frozen discovery selections and all three speed repetitions.** Generated from recorded JSON only; report generation performs no inference.`, '',
    ...(blocker?.status === 'blocked' ? [`Host setup is blocked: ${text(blocker.reason)} Add these keys to the existing sections in \`${text(blocker.file)}\`, preserving the pinned limits: ${blocker.requiredSections.map(item => `\`[${text(item.section)}]\` → \`${text(item.add)}\``).join('; ')}. See the [blocker receipt](data/decision-1b-blocker.json).`, ''] : []),
    `The phase-1b comparison is exploratory discovery, not production qualification. The 40 rage and 48 broad cases tune one template and shared \`probability >= cutoff\` threshold per variant. Leave-one-out selection repeats that tuning without each held-out discovery case. It estimates selection optimism on this small corpus; it is not independent decision-model validation. Both later validation corpora were previously used to qualify Gemma, so neither is globally untouched. ${validation.hasResults ? 'Recorded phase-2 validation status and preregistered gates appear below.' : 'This harness has run no decision-model validation.'}`, '',
    '`ggml-org/d1-Omni-2B-GGUF` is the `lfm3` LFM3 Omni 2B checkpoint. Ollama `d1:2b` is the different `lfm3_vl` Liquid d1-2B checkpoint, paired here with `LiquidAI/d1-2B-GGUF`. The 600M Omni checkpoint is separate again. Similar names do not establish a same-checkpoint comparison. `filter-decision` never won phase 1 and is omitted from phase 1b; the remaining templates are `matches-category` and `category-applies`.', '',
    table(['Variant', 'Format', 'Disk GB', 'Steady RSS / footprint GiB', 'Warm ×3 p50 / p90 ms (n)', 'Warm ×10 p50 / p90 ms (n)', 'Cold ms', 'Discovery exact: chosen; 0.5'], comparisonRows), '',
    'Historical Gemma rows come from the [recorded baseline file](data/decision-baselines.json), which names their aggregate and raw evidence sources. Browser used a 1024-token budget; original Ollama Gemma QAT and MLX requested 1024 but allocated 2048. The QAT reference is the original combined package, not the later text-only import. Historical memory uses a loaded-model increment for Browser and the serving process tree for Ollama; current decision rows all use 4096 tokens and one slot. Historical prompts have no probability cutoff.', '',
    table(['Variant', 'Model', 'Format', 'Logical / allocated GB', 'Disk scope', 'Projector'], artifacts), '',
    'Llama GGUF rows account for the primary text weights with no projector. Native-package rows account for all manifest blobs, including any bundled projector, even when only text is submitted. Shared blobs are charged fully per variant; runtime binaries and unrelated artifacts are excluded. Logical GB are decimal; memory GiB are binary.', '',
    table(['Variant', 'Template / cutoff and equivalent interval', 'Rage hide correct; F1', 'Broad hide correct; exact vectors', 'All exact vectors', 'FH / MH', 'New FH / new MH vs Browser'], qualities), '',
    'FH/MH are false hides/missed hides. New FH and new MH count regressions only against a known Browser-correct decision on the same exact case; unavailable paired evidence is —, never zero. Exact vectors require every ordered category answer to match. Undefined ratios are —. Discovery results are stored scores, not recomputed by this renderer.', '',
    table(['Variant', 'Warm ×3 p50 / p90 ms (n)', '×3 input tokens mean (min–max)', 'Warm ×10 p50 / p90 ms (n)', '×10 input tokens mean (min–max)', 'Cold median ms', 'Identical repeated probabilities'], timingRows), '',
    'Each primary cell pools 20 unchanged medium posts across three repetitions (60 samples), with a fresh model child and distinct warmups before each cell. P90 is nearest rank. Cold is the median unloaded-to-first-answer wall time with downloaded weights and uncontrolled OS file cache. Per-row input-token counts remain in the receipts. No input truncation is permitted. Serial execution uses one loaded benchmark model and one request in flight; all phase-1b effective contexts are pinned to 4096 and parallelism to one. These are configured-stack timings, not extension lifecycle or concurrent-serving measurements.', '',
    table(['Variant: common matches-category template', 'Parity ×3 p50 / p90 ms (n)', '×3 input tokens mean (min–max)', 'Parity ×10 p50 / p90 ms (n)', '×10 input tokens mean (min–max)'], parityRows.map(item => speedRow(item, true))), '',
    `Parity cells compare Kev Q8 across runtimes and the Liquid d1-2B GGUF Q8/Q4_K_M pair against Ollama MXFP8/NVFP4 using the same category template. Shared text and categories do not guarantee identical token counts. ${parity ? 'Recorded discrepancies and checkpoint bindings are in the [parity receipt](data/decision-1b-parity.json).' : 'The parity receipt is pending.'}`, '',
    table(['Variant', 'Steady RSS GiB', 'Steady physical footprint GiB', 'Full-run peak RSS GiB', 'Full-run peak physical footprint GiB'], memoryRows), '',
    'Steady values are medians of three five-second loaded-idle process-tree medians. Peaks cover the full run, including cold initialization, warmup, timed cells and controls. RSS and physical footprint answer different questions: memory-mapped GGUF weights can appear in RSS without being charged to physical footprint; MLX weights are generally charged to footprint. Neither metric alone gives a fair cross-format model-size comparison. Peak RSS and footprint need not occur at the same sample. Sampling every 200 ms may miss shorter spikes; raw sample lists are archived rather than embedded in public summaries.', '',
    `Historical Browser reference: loaded-model physical-footprint increment ${browserMemory.length ? `${gib(Math.min(...browserMemory))}–${gib(Math.max(...browserMemory))}` : '1.96–3.00'} GiB, rather than whole shared-Chrome memory. ${browser ? `Its original medium-post warm medians were ${number(browser.warmLatencyMsByCell['medium-3-distinct'].median)} / ${number(browser.warmLatencyMsByCell['medium-10-distinct'].median)} ms for three/ten filters.` : ''} Browser uses the separately pinned Gemma artifact and historical prompt; these normal-page results do not qualify current MV3/offscreen/download/switching behavior. Historical native results remain in [portable baselines](data/decision-baselines.json), with their own corpus and runtime provenance.`, '',
    table(['Variant', 'Runtime', 'Version', 'Build', 'Effective context', 'Parallel', 'Batch / ubatch', 'Runner', 'Quantization', 'Alias definition'], settings), '',
    'The d1 Llama.app runs required a manual text-only override: batch and ubatch 4096, automatic projector disabled, context 4096 and one slot. The three LiquidAI presets also needed explicit matching `hf-repo` keys before loading worked; the [resolved host-setup receipt](data/decision-1b-blocker.json) records that repair. This is integration friction a Bouncer user would encounter. Their memory is measured with those text-only settings, excluding projector files.', '',
    'Context is read from each loaded runner; Llama slots and projector state come from `/props`, and explicit batch limits come from router arguments. Kev retains llama.cpp defaults of batch 2048 / ubatch 512. Ollama parallelism is the host launch contract `OLLAMA_NUM_PARALLEL=1`, with one request in flight; its API does not expose batch/ubatch, so those fields stay —. Llama.app version 0.49.0 and the official Ollama build provenance were established by the host; llama.cpp build and Ollama version are read back. Native quantization labels are bound to the package identity, not inferred from latency. Artifact identity, discovery bytes, frozen choice and these normalized runtime settings are bound by receipts.', '',
    ...(phase1 ? ['[Historical phase-1 summary](data/decision-phase1.json) retains the retired Laya variants and original d1 integration friction; those runs do not join the normalized phase-1b comparison.', ''] : []),
    ...(phase1?.laya ? [table(['Retired phase-1 Laya variant', 'Format', 'Disk GB', 'Rage correct /40', 'Broad hide /48; exact /48', 'New FH', 'Warm ×3 /×10 median ms'], phase1.laya.map(item => [item.variant.id, item.variant.format, gb(item.identity.disk.logicalBytes), item.quality.chosen.rage.correctHideCases, `${item.quality.chosen.broad.correctHideCases}; ${item.quality.chosen.broad.exactVectors}`, item.quality.chosen.all.newFalseHides, `${number(item.performance.warmLatencyMsByFilterCount[3].median)} / ${number(item.performance.warmLatencyMsByFilterCount[10].median)}`])), '', 'These historical Laya results retain the original phase-1 settings and edge cutoffs. They are recorded rejected candidates, not phase-1b midpoint or 4096-token measurements.', ''] : []),
    ...(archive ? [`The ignored raw evidence archive combines phase-1 and phase-1b logs and 200 ms samples. [Public archive descriptor](data/decision-1b-archive.json): ${text(archive.bytes)} bytes, SHA-256 \`${text(archive.sha256)}\`.`, ''] : []),
    ...(historical ? ['Historical Gemma baselines were recorded on the same machine in October 2026 and are included in `decision-baselines.json`. The current native text-only QAT contract has separate [qualification](ollama-qualification.md); no later quality score is combined with historical timing or memory.', ''] : []),
    ...(validation.hasPreregistration ? [validation.markdown, ''] : []),
    ...(wordingProbe.hasResults ? [wordingProbe.markdown, ''] : []),
    ...(guidanceFresh.hasPreregistration ? [guidanceFresh.markdown, ''] : []),
    ...(capacity.hasPreregistration ? [capacity.markdown, ''] : []),
    'Regenerate with `node scripts/decision-eval/report.mjs`; strict mode requires all registry variants and three speed receipts each. `--partial` leaves missing evidence pending while rejecting inconsistent available provenance. This renderer checks hashes and frozen bindings; runtime/response validation belongs to the runner and its tests.', '',
    'To add a future model, add an explicit registry entry and run `node scripts/decision-eval/run.mjs all <id>`. The command prepares the artifact, runs discovery, freezes selection and records three speed repetitions. Omit `<id>` for the full rotated matrix. Model execution is separate from report generation.', '',
    'Pinned corpus hashes:', '', ...Object.entries(CORPUS_HASHES).map(([name, hash]) => `- \`${name}\`: \`${hash}\``), '',
  ];
  if (pending.length) lines.push(`Pending evidence files: ${pending.length}. Incomplete speed repetitions are not presented as full 60-sample cells.`, '');
  return { markdown: lines.join('\n'), pending, complete, variants: VARIANTS.length, validation, wordingProbe, guidanceFresh, capacity };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === '--partial'), 'Usage: node scripts/decision-eval/report.mjs [--partial]');
  buildReport({ partial: args.includes('--partial') }).then(async result => {
    await writeFile(OUTPUT, result.markdown);
    console.log(`Wrote decision-models.md: ${result.complete}/${result.variants} complete variants; ${result.pending.length} pending files.`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
