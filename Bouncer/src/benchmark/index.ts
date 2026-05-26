// Dev-only latency benchmark — page-side orchestrator + UI.
//
// The PAGE owns the run loop and drives a thin background worker
// (src/background/benchmark.ts) one bounded op at a time, so the MV3 service
// worker is never asked to hold a response open for a whole run. Headline metric
// is `inferenceTime` (generate-only seconds, matching the app's latencyUpdate);
// for Qwen/WebLLM we also surface the usage.extra decomposition. LiteRT/Gemma
// reports wall-clock only. See the plan for the full rationale.

import { PREDEFINED_MODELS } from '../shared/models';
import { POSTS, categories, type CorpusPost } from '../shared/benchmark-corpus';
import { summarize, mean, type LatencyStats } from '../shared/benchmark-stats';
import type { BenchmarkInferResult, BenchmarkLoadResult, BenchmarkPost } from '../shared/benchmark-types';

// ---- Run shape -------------------------------------------------------------

interface Sample {
  inferenceMs: number;
  wallMs: number;
  completionChars: number;
  usage: BenchmarkInferResult['usage'];
}
interface CellResult { postId: CorpusPost['id']; postLabel: string; nCats: number; samples: Sample[]; }
interface ModelResult {
  modelId: string; display: string; backend: string; sizeGB?: number;
  loadMs: number; firstInferMs: number; cells: CellResult[];
}
interface EnvInfo { userAgent: string; gpu: string; date: string }
interface Report {
  startedAt: string; env: EnvInfo; config: { warmup: number; timed: number }; models: ModelResult[];
}

// Deduplicated cells: filter-count sweep on the medium post (1/3/5/10) +
// post-length sweep at 3 cats (short/long; medium×3 already covered). The
// (medium, 3) cell is the shared midpoint.
const CELLS: { postId: CorpusPost['id']; nCats: number }[] = [
  { postId: 'medium', nCats: 1 },
  { postId: 'medium', nCats: 3 },
  { postId: 'medium', nCats: 5 },
  { postId: 'medium', nCats: 10 },
  { postId: 'short', nCats: 3 },
  { postId: 'long', nCats: 3 },
];

// ---- State -----------------------------------------------------------------

let running = false;
let cancelled = false;
let lastReport: Report | null = null;
const modelChecks: { modelId: string; checkbox: HTMLInputElement; badge: HTMLElement }[] = [];

// ---- DOM helpers -----------------------------------------------------------

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`benchmark: missing #${id}`);
  return node as T;
}

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

// ---- Messaging -------------------------------------------------------------

async function send(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res: Record<string, unknown> | undefined = await chrome.runtime.sendMessage(msg);
  if (res && typeof res.error === 'string' && res.error) throw new Error(res.error);
  return res ?? {};
}

interface MadeCell { post: BenchmarkPost; categories: string[]; label: string }
function makeCell(postId: CorpusPost['id'], nCats: number): MadeCell {
  return {
    post: { text: POSTS[postId].text, imageUrls: [] },
    categories: categories(nCats),
    label: `${POSTS[postId].label} ×${nCats}`,
  };
}

async function infer(modelId: string, cell: MadeCell): Promise<BenchmarkInferResult> {
  return (await send({
    type: 'benchmark', op: 'infer', modelId, post: cell.post, categories: cell.categories,
  })) as unknown as BenchmarkInferResult;
}

// ---- Environment -----------------------------------------------------------

interface AdapterInfoLike { vendor?: string; architecture?: string; device?: string; description?: string }
interface AdapterLike { info?: AdapterInfoLike; requestAdapterInfo?: () => Promise<AdapterInfoLike> }
interface GpuLike { requestAdapter?: () => Promise<AdapterLike | null> }

async function describeGpu(): Promise<string> {
  try {
    const g = (navigator as unknown as { gpu?: GpuLike }).gpu;
    if (!g?.requestAdapter) return 'no navigator.gpu';
    const adapter = await g.requestAdapter();
    let info = adapter?.info;
    if (!info && adapter?.requestAdapterInfo) info = await adapter.requestAdapterInfo();
    if (info) {
      return [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || 'webgpu';
    }
    return adapter ? 'webgpu (adapter info unavailable)' : 'no adapter';
  } catch (e) {
    return 'error: ' + (e as Error).message;
  }
}

async function captureEnv(): Promise<EnvInfo> {
  return { userAgent: navigator.userAgent, gpu: await describeGpu(), date: new Date().toISOString() };
}

// ---- Status / buttons ------------------------------------------------------

function setStatus(text: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info'): void {
  const s = need('status');
  s.textContent = text;
  s.className = `status status-${kind}`;
}

function updateButtons(): void {
  need<HTMLButtonElement>('run').disabled = running;
  need<HTMLButtonElement>('stop').disabled = !running;
  need<HTMLButtonElement>('exportJson').disabled = !lastReport;
  need<HTMLButtonElement>('exportCsv').disabled = !lastReport;
}

// ---- Model picker ----------------------------------------------------------

function buildModelChecks(): void {
  const container = need('models');
  container.replaceChildren();
  for (const m of PREDEFINED_MODELS.local) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!m.recommended || m.backend === 'litertlm'; // default: Qwen3.5 + Gemma

    const badge = document.createElement('span');
    badge.className = 'badge badge-unknown';
    badge.textContent = '…';

    const label = document.createElement('label');
    label.className = 'model-row';
    const name = document.createElement('span');
    name.textContent = `${m.display}  `;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `(${m.backend}, ${m.sizeGB ?? '?'} GB)`;
    label.append(checkbox, name, meta, badge);
    container.append(label);

    modelChecks.push({ modelId: m.name, checkbox, badge });
  }
}

async function refreshStatuses(): Promise<void> {
  try {
    const res = (await send({ type: 'getAllLocalModelStatuses' })) as unknown as {
      statuses: Record<string, { state: string }>; webgpuSupported: boolean;
    };
    for (const { modelId, checkbox, badge } of modelChecks) {
      const state = res.statuses?.[modelId]?.state ?? 'unknown';
      const ready = state === 'cached' || state === 'ready';
      badge.textContent = state;
      badge.className = `badge badge-${ready ? 'ok' : 'warn'}`;
      if (!res.webgpuSupported) {
        checkbox.checked = false;
        checkbox.disabled = true;
        badge.textContent = 'WebGPU unavailable';
      }
    }
  } catch (e) {
    setStatus('Could not read model statuses: ' + (e as Error).message, 'error');
  }
}

// ---- Run -------------------------------------------------------------------

async function run(): Promise<void> {
  if (running) return;

  const warmup = Math.max(0, parseInt(need<HTMLInputElement>('warmup').value, 10) || 0);
  const timed = Math.max(1, parseInt(need<HTMLInputElement>('timed').value, 10) || 1);

  const selected = modelChecks.filter(c => c.checkbox.checked).map(c => c.modelId);
  if (!selected.length) { setStatus('Select at least one model.', 'warn'); return; }

  // Pre-download guard: ensureLoaded would DOWNLOAD an absent model (multi-GB)
  // inside the timed path, so only benchmark already-cached/ready models.
  const statusRes = (await send({ type: 'getAllLocalModelStatuses' })) as unknown as {
    statuses: Record<string, { state: string }>;
  };
  const ready = selected.filter(id => ['cached', 'ready'].includes(statusRes.statuses?.[id]?.state));
  const skipped = selected.filter(id => !ready.includes(id));
  if (!ready.length) {
    setStatus('No selected model is downloaded. Download one from the popup first, then retry.', 'error');
    return;
  }

  running = true; cancelled = false; lastReport = null; updateButtons();
  need('results').replaceChildren();

  const env = await captureEnv();
  renderEnv(env);
  if (skipped.length) setStatus(`Skipping (not downloaded): ${skipped.join(', ')}. Continuing with the rest.`, 'warn');

  const report: Report = { startedAt: new Date().toISOString(), env, config: { warmup, timed }, models: [] };

  try {
    for (const modelId of ready) {
      if (cancelled) break;
      const mdef = PREDEFINED_MODELS.local.find(m => m.name === modelId);
      if (!mdef) continue;

      setStatus(`Loading ${mdef.display} (cold)…`);
      const loadRes = (await send({ type: 'benchmark', op: 'load', modelId })) as unknown as BenchmarkLoadResult;

      // First inference after load: shader-compile / prefill warmup outlier.
      setStatus(`${mdef.display}: first inference (cold)…`);
      const first = await infer(modelId, makeCell('medium', 3));
      const firstInferMs = first.inferenceTime * 1000;

      const cells: CellResult[] = [];
      let cellIdx = 0;
      for (const cell of CELLS) {
        if (cancelled) break;
        cellIdx++;
        const made = makeCell(cell.postId, cell.nCats);

        for (let w = 0; w < warmup && !cancelled; w++) {
          setStatus(`${mdef.display} · ${made.label} · warmup ${w + 1}/${warmup}`);
          await infer(modelId, made);
        }

        const samples: Sample[] = [];
        for (let i = 0; i < timed && !cancelled; i++) {
          setStatus(`${mdef.display} · ${made.label} · timed ${i + 1}/${timed} (cell ${cellIdx}/${CELLS.length})`);
          const r = await infer(modelId, made);
          samples.push({ inferenceMs: r.inferenceTime * 1000, wallMs: r.wallMs, completionChars: r.completionChars, usage: r.usage });
        }
        cells.push({ postId: cell.postId, postLabel: POSTS[cell.postId].label, nCats: cell.nCats, samples });
      }

      await send({ type: 'benchmark', op: 'unload', modelId });
      report.models.push({
        modelId, display: mdef.display, backend: mdef.backend ?? '?', sizeGB: mdef.sizeGB,
        loadMs: loadRes.loadMs, firstInferMs, cells,
      });
      lastReport = report;
      renderResults(report);
      updateButtons();
    }
    setStatus(cancelled ? 'Stopped.' : 'Done.', cancelled ? 'warn' : 'ok');
  } catch (e) {
    setStatus('Error: ' + (e as Error).message, 'error');
  } finally {
    running = false;
    updateButtons();
    // Best-effort: free GPU memory if a run errored mid-flight.
    try { await send({ type: 'benchmark', op: 'unload' }); } catch { /* ignore */ }
  }
}

// ---- Rendering -------------------------------------------------------------

function nums(samples: Sample[], pick: (s: Sample) => number | undefined): number[] {
  return samples.map(pick).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

function renderEnv(env: EnvInfo): void {
  need('env').textContent = `GPU: ${env.gpu}  ·  ${env.date}  ·  ${env.userAgent}`;
}

function th(text: string): HTMLTableCellElement {
  const c = document.createElement('th');
  c.textContent = text;
  return c;
}
function td(text: string): HTMLTableCellElement {
  const c = document.createElement('td');
  c.textContent = text;
  return c;
}

function renderResults(report: Report): void {
  const root = need('results');
  root.replaceChildren();

  for (const model of report.models) {
    const header = document.createElement('h3');
    header.textContent = `${model.display} — ${model.backend}, ${model.sizeGB ?? '?'} GB`;
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.textContent = `cold-load ${fmt(model.loadMs, 0)} ms · first-inference ${fmt(model.firstInferMs, 0)} ms · warm: median inferenceTime (generate-only)`;
    root.append(header, sub);

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    ['Cell (post × filters)', 'n', 'inf median', 'inf mean', 'inf p90', 'inf p95', 'min', 'max', 'σ', 'wall median', 'out chars', 'compl. toks', 'TTFT ms', 'decode tok/s']
      .forEach(h => hrow.append(th(h)));
    thead.append(hrow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const cell of model.cells) {
      const inf: LatencyStats = summarize(nums(cell.samples, s => s.inferenceMs));
      const wall: LatencyStats = summarize(nums(cell.samples, s => s.wallMs));
      const outChars = mean(nums(cell.samples, s => s.completionChars));
      const complTok = mean(nums(cell.samples, s => s.usage?.completionTokens));
      const ttftMs = mean(nums(cell.samples, s => s.usage?.timeToFirstTokenS)) * 1000;
      const decodeTps = mean(nums(cell.samples, s => s.usage?.decodeTokensPerS));

      const row = document.createElement('tr');
      row.append(
        td(`${cell.postLabel} × ${cell.nCats}`),
        td(String(inf.n)),
        td(fmt(inf.median)), td(fmt(inf.mean)), td(fmt(inf.p90)), td(fmt(inf.p95)),
        td(fmt(inf.min)), td(fmt(inf.max)), td(fmt(inf.stddev)),
        td(fmt(wall.median)),
        td(fmt(outChars, 0)),
        td(fmt(complTok, 0)), td(fmt(ttftMs, 0)), td(fmt(decodeTps, 0)),
      );
      tbody.append(row);
    }
    table.append(tbody);
    root.append(table);
  }
}

// ---- Export ----------------------------------------------------------------

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportJson(): void {
  if (!lastReport) return;
  const stamp = lastReport.startedAt.replace(/[:.]/g, '-');
  download(`bouncer-latency-${stamp}.json`, JSON.stringify(lastReport, null, 2), 'application/json');
}

function exportCsv(): void {
  if (!lastReport) return;
  const cols = [
    'model', 'backend', 'sizeGB', 'cold_load_ms', 'first_infer_ms',
    'post', 'n_filters', 'n', 'inf_median_ms', 'inf_mean_ms', 'inf_p90_ms', 'inf_p95_ms',
    'inf_min_ms', 'inf_max_ms', 'inf_stddev_ms', 'wall_median_ms', 'out_chars_mean',
    'completion_tokens_mean', 'ttft_ms_mean', 'tpot_ms_mean', 'decode_tps_mean', 'prefill_tps_mean',
  ];
  const rows: string[] = [cols.join(',')];
  for (const model of lastReport.models) {
    for (const cell of model.cells) {
      const inf = summarize(nums(cell.samples, s => s.inferenceMs));
      const wall = summarize(nums(cell.samples, s => s.wallMs));
      const v = [
        model.display, model.backend, model.sizeGB ?? '', fmt(model.loadMs, 0), fmt(model.firstInferMs, 0),
        cell.postLabel, cell.nCats, inf.n,
        fmt(inf.median, 2), fmt(inf.mean, 2), fmt(inf.p90, 2), fmt(inf.p95, 2),
        fmt(inf.min, 2), fmt(inf.max, 2), fmt(inf.stddev, 2), fmt(wall.median, 2),
        fmt(mean(nums(cell.samples, s => s.completionChars)), 0),
        fmt(mean(nums(cell.samples, s => s.usage?.completionTokens)), 1),
        fmt(mean(nums(cell.samples, s => s.usage?.timeToFirstTokenS)) * 1000, 1),
        fmt(mean(nums(cell.samples, s => s.usage?.timePerOutputTokenS)) * 1000, 2),
        fmt(mean(nums(cell.samples, s => s.usage?.decodeTokensPerS)), 1),
        fmt(mean(nums(cell.samples, s => s.usage?.prefillTokensPerS)), 1),
      ];
      // Quote any field containing a comma.
      rows.push(v.map(x => { const str = String(x); return str.includes(',') ? `"${str}"` : str; }).join(','));
    }
  }
  const stamp = lastReport.startedAt.replace(/[:.]/g, '-');
  download(`bouncer-latency-${stamp}.csv`, rows.join('\n'), 'text/csv');
}

// ---- Init ------------------------------------------------------------------

function init(): void {
  buildModelChecks();
  need('run').addEventListener('click', () => { void run(); });
  need('stop').addEventListener('click', () => { cancelled = true; setStatus('Stopping after current inference…', 'warn'); });
  need('exportJson').addEventListener('click', exportJson);
  need('exportCsv').addEventListener('click', exportCsv);
  updateButtons();
  void refreshStatuses();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
