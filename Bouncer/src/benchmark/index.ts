// Dev-only latency benchmark — page-side orchestrator + UI.
//
// The PAGE owns the run loop and drives a thin background worker
// (src/background/benchmark.ts) one bounded op at a time, so the MV3 service
// worker is never asked to hold a response open for a whole run. Headline metric
// is `inferenceTime` (generation-call seconds from the app's inference wrapper).
// Wall time includes the selected engine's transport and shared serial lease.

import { POSTS, categories, type CorpusPost } from '../shared/benchmark-corpus';
import { summarize, mean, type LatencyStats } from '../shared/benchmark-stats';
import type {
  BenchmarkClassifierIdentity, BenchmarkInferResult, BenchmarkLoadKind,
  BenchmarkLoadResult, BenchmarkPost, BenchmarkPromptMode, BenchmarkStatusResult,
} from '../shared/benchmark-types';
import { EVAL_POSTS, EVAL_VARIANTS, expectsHide, type EvalPost, type EvalVariant } from '../shared/eval-corpus';
import { score, scoreByKind, unstableCount, type EvalScore } from '../shared/eval-metrics';

// ---- Run shape -------------------------------------------------------------

interface Sample {
  inferenceMs: number;
  wallMs: number;
  completionChars: number;
  usage: BenchmarkInferResult['usage'];
}
interface CellResult { postId: CorpusPost['id']; postLabel: string; nCats: number; samples: Sample[]; }
interface ModelResult extends BenchmarkClassifierIdentity {
  loadKind: BenchmarkLoadKind;
  loadMs: number; firstInferMs: number; cells: CellResult[];
}
interface EnvInfo { userAgent: string; classifier: BenchmarkClassifierIdentity; date: string }
interface Report {
  startedAt: string; env: EnvInfo; config: { warmup: number; timed: number }; models: ModelResult[];
}

// ---- Accuracy-eval shapes --------------------------------------------------

// Fixed repeats per post: odd, so the majority vote (hideCount*2 > RUNS) never
// ties and catches any unexpected instability in deterministic Gemma output.
const RUNS = 3;

interface EvalRow {
  id: string;
  kind: EvalPost['kind'];
  expected: boolean;
  predicted: boolean;
  hideCount: number; // of RUNS, how many said hide — doubles as a confidence signal
  reasoning: string; // last run's reasoning, for eyeballing failures
  runs: EvalRun[];
}
interface EvalRun { run: number; shouldHide: boolean; reasoning: string; rawResponse: string | null; }
interface EvalScores {
  all: EvalScore;
  byKind: Partial<Record<EvalPost['kind'], EvalScore>>;
  unstableRows: number;
}
interface EvalVariantResult {
  variantId: EvalVariant['id'];
  label: string;
  description: string;
  filters: string[];
  promptMode: BenchmarkPromptMode;
  rows: EvalRow[];
  scores: EvalScores;
}
interface EvalModelResult extends BenchmarkClassifierIdentity { variants: EvalVariantResult[]; }
interface EvalReport {
  startedAt: string; env: EnvInfo; runs: number; variants: EvalVariant[]; models: EvalModelResult[];
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
let lastEvalReport: EvalReport | null = null;
let modelBadge: HTMLElement | null = null;
let modelLabel: HTMLElement | null = null;

// ---- DOM helpers -----------------------------------------------------------

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`benchmark: missing #${id}`);
  return node as T;
}

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—';
}

// ---- Messaging -------------------------------------------------------------

async function send(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res: Record<string, unknown> | undefined = await chrome.runtime.sendMessage(msg);
  if (res && typeof res.error === 'string' && res.error) throw new Error(res.error);
  return res ?? {};
}

interface MadeCell { post: BenchmarkPost; categories: string[]; label: string; promptMode?: BenchmarkPromptMode }
function makeCell(postId: CorpusPost['id'], nCats: number): MadeCell {
  return {
    post: { text: POSTS[postId].text },
    categories: categories(nCats),
    label: `${POSTS[postId].label} ×${nCats}`,
  };
}

function assertIdentity(expected: BenchmarkClassifierIdentity, actual: BenchmarkClassifierIdentity): void {
  if (actual.engine !== expected.engine || actual.modelId !== expected.modelId
      || actual.selectionRevision !== expected.selectionRevision
      || actual.classifierFingerprint !== expected.classifierFingerprint) {
    throw new Error('The selected engine changed. Start a new benchmark run.');
  }
}

async function infer(identity: BenchmarkClassifierIdentity, cell: MadeCell): Promise<BenchmarkInferResult> {
  const result = (await send({
    type: 'benchmark', op: 'infer', post: cell.post, categories: cell.categories, promptMode: cell.promptMode,
    selectionRevision: identity.selectionRevision,
  })) as unknown as BenchmarkInferResult;
  assertIdentity(identity, result);
  return result;
}

// ---- Environment -----------------------------------------------------------

function captureEnv(identity: BenchmarkClassifierIdentity): EnvInfo {
  return { userAgent: navigator.userAgent, classifier: identity, date: new Date().toISOString() };
}

// ---- Status / buttons ------------------------------------------------------

function setStatus(text: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info'): void {
  const s = need('status');
  s.textContent = text;
  s.className = `status status-${kind}`;
}

function updateButtons(): void {
  need<HTMLButtonElement>('run').disabled = running;
  need<HTMLButtonElement>('runEval').disabled = running;
  need<HTMLButtonElement>('stop').disabled = !running;
  need<HTMLButtonElement>('exportJson').disabled = !lastReport;
  need<HTMLButtonElement>('exportCsv').disabled = !lastReport;
  need<HTMLButtonElement>('exportEvalJson').disabled = !lastEvalReport;
}

// ---- Selected fixed classifier ---------------------------------------------

function buildModelChecks(): void {
  const container = need('models');
  modelLabel = document.createElement('span');
  modelLabel.textContent = 'Selected engine: reading saved choice…';
  modelBadge = document.createElement('span');
  modelBadge.className = 'badge badge-unknown';
  modelBadge.textContent = '…';
  container.replaceChildren(modelLabel, modelBadge);
}

function renderSelected(response: BenchmarkStatusResult): void {
  if (modelLabel) modelLabel.textContent = response.identity
    ? `${response.identity.display} · ${engineLabel(response.identity.engine)} · ${response.identity.modelId}`
    : 'Choose an engine in the Bouncer popup';
  if (modelBadge) {
    modelBadge.textContent = response.status.state;
    modelBadge.className = `badge badge-${response.status.state === 'ready' ? 'ok' : 'warn'}`;
  }
}

function engineLabel(engine: BenchmarkClassifierIdentity['engine']): string {
  return engine === 'litertlm' ? 'Browser (LiteRT-LM)' : 'Ollama on this Mac';
}

async function refreshStatuses(): Promise<void> {
  try {
    const response = await send({ type: 'benchmark', op: 'status' }) as unknown as BenchmarkStatusResult;
    renderSelected(response);
  } catch (error) {
    setStatus(`Could not read selected engine status: ${(error as Error).message}`, 'error');
  }
}

async function resolveReady(): Promise<BenchmarkClassifierIdentity | null> {
  const response = await send({ type: 'benchmark', op: 'status' }) as unknown as BenchmarkStatusResult;
  renderSelected(response);
  if (!response.identity || response.status.state !== 'ready') {
    setStatus(`${response.status.message} Choose, download, connect or retry from the Bouncer popup before running.`, 'error');
    return null;
  }
  return response.identity;
}

async function run(): Promise<void> {
  if (running) return;

  const warmup = Math.max(0, parseInt(need<HTMLInputElement>('warmup').value, 10) || 0);
  const timed = Math.max(1, parseInt(need<HTMLInputElement>('timed').value, 10) || 1);

  running = true; cancelled = false; lastReport = null; updateButtons();
  need('results').replaceChildren();
  let identity: BenchmarkClassifierIdentity | null = null;
  try {
    identity = await resolveReady();
    if (!identity || cancelled) return;
    const env = captureEnv(identity);
    renderEnv(env);
    const report: Report = { startedAt: new Date().toISOString(), env, config: { warmup, timed }, models: [] };

    setStatus(`Preparing ${engineLabel(identity.engine)}…`);
    const loadRes = (await send({ type: 'benchmark', op: 'load', selectionRevision: identity.selectionRevision })) as unknown as BenchmarkLoadResult;
    assertIdentity(identity, loadRes);
    if (cancelled) { setStatus('Stopped.', 'warn'); return; }

    // Browser initialization is measured above. A first native inference may
    // load an expired shared runner, independently of metadata readiness.
    setStatus(`${identity.display}: first inference…`);
    const first = await infer(identity, makeCell('medium', 3));
    const firstInferMs = first.inferenceTime * 1000;

    const cells: CellResult[] = [];
    let cellIdx = 0;
    for (const cell of CELLS) {
      if (cancelled) break;
      cellIdx++;
      const made = makeCell(cell.postId, cell.nCats);

      for (let w = 0; w < warmup && !cancelled; w++) {
        setStatus(`${identity.display} · ${made.label} · warmup ${w + 1}/${warmup}`);
        await infer(identity, made);
      }

      const samples: Sample[] = [];
      for (let i = 0; i < timed && !cancelled; i++) {
        setStatus(`${identity.display} · ${made.label} · timed ${i + 1}/${timed} (cell ${cellIdx}/${CELLS.length})`);
        const r = await infer(identity, made);
        samples.push({ inferenceMs: r.inferenceTime * 1000, wallMs: r.wallMs, completionChars: r.completionChars, usage: r.usage });
      }
      cells.push({ postId: cell.postId, postLabel: POSTS[cell.postId].label, nCats: cell.nCats, samples });
    }

    report.models.push({ ...identity, loadKind: loadRes.loadKind, loadMs: loadRes.loadMs, firstInferMs, cells });
    lastReport = report;
    renderResults(report);
    updateButtons();
    setStatus(cancelled ? 'Stopped.' : 'Done.', cancelled ? 'warn' : 'ok');
  } catch (e) {
    setStatus('Error: ' + (e as Error).message, 'error');
  } finally {
    // Revision-bound cleanup cannot retire a newly selected engine.
    if (identity) {
      try { await send({ type: 'benchmark', op: 'unload', selectionRevision: identity.selectionRevision }); } catch { /* selection may have changed */ }
    }
    running = false;
    updateButtons();
  }
}

// ---- Rendering -------------------------------------------------------------

function nums(samples: Sample[], pick: (s: Sample) => number | undefined): number[] {
  return samples.map(pick).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

function renderEnv(env: EnvInfo): void {
  const identity = env.classifier;
  need('env').textContent = `${engineLabel(identity.engine)} · ${identity.modelId} · runtime ${identity.runtimeVersion} · selection ${identity.selectionRevision} · weights ${identity.weightDigest} · classifier ${identity.classifierFingerprint} · ${env.date} · ${env.userAgent}`;
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
    header.textContent = `${model.display} — ${engineLabel(model.engine)}`;
    const sub = document.createElement('div');
    sub.className = 'muted';
    const preparation = model.loadKind === 'browser_initialization' ? 'cached Browser initialization' : 'native metadata readiness';
    sub.textContent = `${preparation} ${fmt(model.loadMs, 0)} ms · first-inference ${fmt(model.firstInferMs, 0)} ms · warm: median inferenceTime (generation call)`;
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
    'model', 'model_id', 'engine', 'selection_revision', 'classifier_fingerprint',
    'weight_digest', 'manifest_digest', 'runtime_version', 'preparation_kind', 'preparation_ms', 'first_infer_ms',
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
        model.display, model.modelId, model.engine, model.selectionRevision, model.classifierFingerprint,
        model.weightDigest, model.manifestDigest ?? '', model.runtimeVersion,
        model.loadKind, fmt(model.loadMs, 0), fmt(model.firstInferMs, 0),
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
      rows.push(v.map(x => { const str = String(x); return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; }).join(','));
    }
  }
  const stamp = lastReport.startedAt.replace(/[:.]/g, '-');
  download(`bouncer-latency-${stamp}.csv`, rows.join('\n'), 'text/csv');
}

// ==== Accuracy eval =========================================================
// Reuses the latency harness's plumbing — resolveReady / load / infer / unload,
// the selected fixed classifier, the running+cancelled flags, and the DOM helpers. Each
// post is classified RUNS times against EVAL_FILTERS and majority-voted.

async function runEval(): Promise<void> {
  if (running) return;

  running = true; cancelled = false; lastEvalReport = null; updateButtons();
  need('evalResults').replaceChildren();
  let identity: BenchmarkClassifierIdentity | null = null;
  try {
    identity = await resolveReady();
    if (!identity || cancelled) return;
    const env = captureEnv(identity);
    renderEnv(env);
    const report: EvalReport = {
      startedAt: new Date().toISOString(), env, runs: RUNS, variants: EVAL_VARIANTS, models: [],
    };

    setStatus(`Preparing ${engineLabel(identity.engine)}…`);
    const loadRes = await send({ type: 'benchmark', op: 'load', selectionRevision: identity.selectionRevision }) as unknown as BenchmarkLoadResult;
    assertIdentity(identity, loadRes);

    const variantResults: EvalVariantResult[] = [];
    for (const variant of EVAL_VARIANTS) {
      if (cancelled) break;
      const rows: EvalRow[] = [];
      let i = 0;
      for (const post of EVAL_POSTS) {
        if (cancelled) break;
        i++;
        const runs: EvalRun[] = [];
        for (let r = 0; r < RUNS && !cancelled; r++) {
          setStatus(`${identity.display} · ${variant.label} · ${post.id} · run ${r + 1}/${RUNS} (post ${i}/${EVAL_POSTS.length})`);
          const out = await infer(identity, {
            post: { text: post.text },
            categories: variant.filters,
            label: `${variant.id}:${post.id}`,
            promptMode: variant.promptMode,
          });
          runs.push({
            run: r + 1,
            shouldHide: out.shouldHide,
            reasoning: out.reasoning,
            rawResponse: out.rawResponse,
          });
        }
        if (cancelled) break; // don't record a post we only partially measured
        const hideCount = runs.filter(r => r.shouldHide).length;
        // Strict majority — RUNS is odd, so this never ties.
        const predicted = hideCount * 2 > RUNS;
        const reasoning = runs[runs.length - 1]?.reasoning ?? '';
        rows.push({ id: post.id, kind: post.kind, expected: expectsHide(post), predicted, hideCount, reasoning, runs });
      }

      variantResults.push({
        variantId: variant.id,
        label: variant.label,
        description: variant.description,
        filters: variant.filters,
        promptMode: variant.promptMode,
        rows,
        scores: evalScores(rows),
      });
      renderEval({ ...report, models: [{ ...identity, variants: variantResults }] });
    }

    report.models.push({ ...identity, variants: variantResults });
    lastEvalReport = report;
    renderEval(report);
    updateButtons();
    setStatus(cancelled ? 'Stopped.' : 'Eval done.', cancelled ? 'warn' : 'ok');
  } catch (e) {
    setStatus('Error: ' + (e as Error).message, 'error');
  } finally {
    if (identity) {
      try { await send({ type: 'benchmark', op: 'unload', selectionRevision: identity.selectionRevision }); } catch { /* selection may have changed */ }
    }
    running = false;
    updateButtons();
  }
}

function evalScores(rows: EvalRow[]): EvalScores {
  return {
    all: score(rows.map(r => ({ expected: r.expected, predicted: r.predicted }))),
    byKind: scoreByKind(rows.map(r => ({ kind: r.kind, expected: r.expected, predicted: r.predicted }))),
    unstableRows: unstableCount(rows),
  };
}

function scoreLine(s: EvalScore): string {
  return `accuracy ${pct(s.accuracy)} · precision ${pct(s.precision)} · recall ${pct(s.recall)} · F1 ${fmt(s.f1, 2)}` +
    ` · specificity ${pct(s.specificity)} · FPR ${pct(s.falsePositiveRate)}` +
    ` · TP ${s.tp} / FP ${s.fp} / FN ${s.fn} / TN ${s.tn}`;
}

function kindLine(scores: EvalScores): string {
  const order: EvalPost['kind'][] = ['pos', 'neg-easy', 'neg-amb'];
  return order.map(kind => {
    const s = scores.byKind[kind];
    return s ? `${kind}: ${s.tp}/${s.fp}/${s.fn}/${s.tn}, acc ${pct(s.accuracy)}` : `${kind}: —`;
  }).join(' · ');
}

function renderEval(report: EvalReport): void {
  const root = need('evalResults');
  root.replaceChildren();

  for (const model of report.models) {
    const header = document.createElement('h3');
    header.textContent = `${model.display} — ${engineLabel(model.engine)}`;
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.textContent = `${report.runs} runs/post, majority vote · positive class = "should hide"`;
    root.append(header, sub);

    const baseline = model.variants.find(v => v.variantId === 'baseline') ?? null;
    const baselineAmbFp = baseline?.scores.byKind['neg-amb']?.fp ?? null;
    const baselineRecall = baseline?.scores.all.recall ?? null;

    for (const variant of model.variants) {
      const variantHeader = document.createElement('h4');
      variantHeader.textContent = variant.label;
      const variantSub = document.createElement('div');
      variantSub.className = 'muted';
      variantSub.textContent = `filter: ${variant.filters.join(', ')} · prompt: ${variant.promptMode} · ${variant.description}`;
      root.append(variantHeader, variantSub);

      const summary = document.createElement('div');
      summary.textContent = scoreLine(variant.scores.all);
      root.append(summary);

      const amb = variant.scores.byKind['neg-amb'];
      const stress = document.createElement('div');
      stress.className = 'muted';
      const eligibility = baseline && variant.variantId !== 'baseline' && baselineAmbFp !== null && baselineRecall !== null
        ? ` · conservative ship bar: ${amb && amb.fp < baselineAmbFp && variant.scores.all.recall >= baselineRecall ? 'passes' : 'does not pass'}`
        : '';
      stress.textContent = `slices: ${kindLine(variant.scores)} · ambiguous-negative FP ${amb?.fp ?? 0}/${(amb?.fp ?? 0) + (amb?.tn ?? 0)} · unstable rows ${variant.scores.unstableRows}${eligibility}`;
      root.append(stress);

      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const hrow = document.createElement('tr');
      ['post', 'kind', 'expected', `hide-rate /${report.runs}`, 'result', 'reasoning'].forEach(h => hrow.append(th(h)));
      thead.append(hrow);
      table.append(thead);

      const tbody = document.createElement('tbody');
      for (const r of variant.rows) {
        const correct = r.predicted === r.expected;
        const reasoningCell = td(r.reasoning);
        reasoningCell.className = 'wrap';
        const row = document.createElement('tr');
        row.append(
          td(r.id),
          td(r.kind),
          td(r.expected ? 'hide' : 'allow'),
          td(`${r.hideCount}/${report.runs}`),
          td(correct ? '✓' : '✗'),
          reasoningCell,
        );
        if (!correct) row.classList.add('bad');
        tbody.append(row);
      }
      table.append(tbody);
      root.append(table);
    }
  }
}

function exportEvalJson(): void {
  if (!lastEvalReport) return;
  const stamp = lastEvalReport.startedAt.replace(/[:.]/g, '-');
  download(`bouncer-eval-${stamp}.json`, JSON.stringify(lastEvalReport, null, 2), 'application/json');
}

// ---- Init ------------------------------------------------------------------

function init(): void {
  buildModelChecks();
  need('run').addEventListener('click', () => { void run(); });
  need('runEval').addEventListener('click', () => { void runEval(); });
  need('stop').addEventListener('click', () => { cancelled = true; setStatus('Stopping after current inference…', 'warn'); });
  need('exportJson').addEventListener('click', exportJson);
  need('exportCsv').addEventListener('click', exportCsv);
  need('exportEvalJson').addEventListener('click', exportEvalJson);
  updateButtons();
  void refreshStatuses();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
