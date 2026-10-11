// Dev-only, normal-page Gemma comparison runner.
//
// Chrome automation cannot inspect another extension's chrome-extension://
// pages. This localhost surface deliberately has no extension privileges: it
// instantiates the same LiteRT runtime directly and reuses the same pinned model
// definitions, prompt builders, parsers, and corpora. The shipped MV3 path stays
// covered by the extension benchmark; this runner makes E2B/E4B model evidence
// repeatable without weakening the extension's security boundary.

import { LitertlmRuntime, prefetchLitertlmModel, warmLitertlmWasm } from '../offscreen/litertlm-runtime';
import { GEMMA_BENCHMARK_MODELS } from '../shared/benchmark-models';
import type { LocalPromptMode } from '../shared/prompts';
import { parseTableYesnoResponse } from '../shared/table-yesno';
import { buildTableYesnoRequest } from '../shared/table-yesno-request';
import { buildSuggestionSystemPrompt, parseCandidatePhrases } from '../shared/suggestions';
import { POSTS, categories, type CorpusPost } from '../shared/benchmark-corpus';
import { summarize } from '../shared/benchmark-stats';
import { EVAL_POSTS, EVAL_VARIANTS, expectsHide } from '../shared/eval-corpus';
import { score, scoreByKind, unstableCount } from '../shared/eval-metrics';
import type { ChatMessage, LocalModelDef } from '../types';

// Injected from the installed package by build.js, including baseline builds.
declare const __LITERTLM_VERSION__: string;

const WARMUPS = 3;
const TIMED_RUNS = 20;
const ACCURACY_RUNS = 3;
const CELLS: Array<{ postId: CorpusPost['id']; nCats: number }> = [
  { postId: 'medium', nCats: 1 },
  { postId: 'medium', nCats: 3 },
  { postId: 'medium', nCats: 5 },
  { postId: 'medium', nCats: 10 },
  { postId: 'short', nCats: 3 },
  { postId: 'long', nCats: 3 },
];

const SUGGESTION_FIXTURES = [
  'absolutely disgusting. quote this everywhere until the company is forced to answer for it.',
  '100x incoming. buy this coin before the crowd wakes up and thank me later 🚀',
  'look at this celebrity meltdown. tag a friend and pile on before the post disappears.',
  'another AI founder claiming their wrapper changes everything. repost if you are tired of the hype.',
  'just a humble reminder that I work harder than everyone complaining in my replies.',
];

const NEGATIVE_SIGNALS = [
  'bait', 'clickbait', 'rage', 'outrage', 'spam', 'scam', 'hype', 'toxic',
  'harass', 'pile-on', 'shaming', 'mockery', 'negativity', 'doom', 'fear',
  'misleading', 'sensational', 'brag', 'smug', 'aggressive', 'manipulation',
  'hostile', 'engagement farming', 'deceptive', 'pump and dump', 'dogpiling',
];

interface InferResult {
  shouldHide: boolean;
  matches: string[];
  malformed: boolean;
  rawResponse: string;
  generationMs: number;
  fullCallMs: number;
}

interface SuggestionResult {
  post: string;
  rawGeneration: string;
  candidates: string[];
  uniqueCandidates: string[];
  invalidWordCount: string[];
  negativeSignalCandidates: string[];
  validationRaw: string;
  validationMalformed: boolean;
  fallbackUsed: boolean;
  fallbackRuns: Array<{ phrase: string; shouldHide: boolean; malformed: boolean; rawResponse: string }>;
  accepted: string[];
  generationMs: number;
  validationMs: number;
  passesAutomatedChecks: boolean;
  requiresManualSemanticReview: true;
}

const statusEl = document.getElementById('status') as HTMLDivElement;
const progressEl = document.getElementById('progress') as HTMLProgressElement;
const summaryEl = document.getElementById('summary') as HTMLPreElement;
const runButton = document.getElementById('run') as HTMLButtonElement;
const downloadButton = document.getElementById('download-report') as HTMLButtonElement;
let downloadableReport: { json: string; filename: string } | null = null;
const pageParams = new URL(location.href).searchParams;
if (pageParams.get('scope') === 'smoke') runButton.textContent = 'Run E2B lifecycle smoke';
else if (pageParams.get('model') === 'e2b') {
  runButton.textContent = pageParams.get('scope') === 'suggestions'
    ? 'Run E2B suggestion verification' : 'Run E2B verification';
}

function setStatus(text: string, kind: 'info' | 'ok' | 'error' = 'info', progress?: number): void {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
  if (progress !== undefined) progressEl.value = Math.max(0, Math.min(1, progress));
}

function gemmaModels(): LocalModelDef[] {
  const params = new URL(location.href).searchParams;
  const selectedModel = params.get('model');
  if (selectedModel !== null && selectedModel !== 'e2b') {
    throw new Error(`Unsupported benchmark model selection: ${selectedModel}. Use model=e2b or omit model for the comparison.`);
  }
  if (selectedModel === 'e2b' || params.get('scope') === 'smoke') {
    const models = GEMMA_BENCHMARK_MODELS.filter(model => model.name.includes('E2B'));
    if (models.length !== 1) throw new Error(`Expected one pinned E2B model; found ${models.length}.`);
    return models;
  }
  const models = [...GEMMA_BENCHMARK_MODELS];
  if (models.length !== 2) throw new Error(`Expected E2B and E4B in the dev build; found ${models.length}.`);
  const order = params.get('order');
  if (order === 'e2b-first') {
    models.sort((a, b) => Number(b.name.includes('E2B')) - Number(a.name.includes('E2B')));
  } else {
    models.sort((a, b) => Number(b.name.includes('E4B')) - Number(a.name.includes('E4B')));
  }
  return models;
}

function modelIdentity(model: LocalModelDef): Record<string, unknown> {
  const modelUrl = model.litertlmConfig.modelUrl;
  return {
    modelId: model.name,
    display: model.display,
    sizeGB: model.sizeGB,
    modelUrl,
    modelRevision: new URL(modelUrl).pathname.match(/\/resolve\/([^/]+)\//)?.[1] ?? null,
  };
}

function buildMessages(
  postText: string,
  cats: string[],
  mode: LocalPromptMode,
): { messages: ChatMessage[]; maxOutputTokens: number } {
  return buildTableYesnoRequest(postText, cats, mode);
}

async function infer(
  runtime: LitertlmRuntime,
  model: LocalModelDef,
  postText: string,
  cats: string[],
  mode: LocalPromptMode = 'baseline',
): Promise<InferResult> {
  const fullCallStarted = performance.now();
  const maxTokens = model.litertlmConfig?.maxTokens ?? 1024;
  const empty = buildMessages('', cats, mode);
  const overheadText = empty.messages.map(message => message.content).join('\n');
  const overheadTokens = await runtime.countTokens(overheadText);
  const budget = Math.max(0, maxTokens - overheadTokens - empty.maxOutputTokens);
  const truncatedPost = await runtime.truncateText(postText, budget);
  const request = buildMessages(truncatedPost, cats, mode);
  const generationStarted = performance.now();
  const rawResponse = await runtime.generate(request.messages, request.maxOutputTokens);
  const generationMs = performance.now() - generationStarted;
  const parsed = parseTableYesnoResponse(rawResponse, cats);
  return { ...parsed, rawResponse, generationMs, fullCallMs: performance.now() - fullCallStarted };
}

async function evaluateSuggestion(runtime: LitertlmRuntime, model: LocalModelDef, post: string): Promise<SuggestionResult> {
  const generationStarted = performance.now();
  const rawGeneration = await runtime.generate([
    { role: 'system', content: buildSuggestionSystemPrompt(9) },
    { role: 'user', content: post },
  ], 150);
  const generationMs = performance.now() - generationStarted;
  const candidates = parseCandidatePhrases(rawGeneration, 9);
  const uniqueCandidates = [...new Set(candidates)];
  const invalidWordCount = uniqueCandidates.filter(candidate => {
    const words = candidate.trim().split(/\s+/).filter(Boolean);
    return words.length < 1 || words.length > 3;
  });
  // This is an inspection aid, not an automated semantic score. Word/phrase
  // boundaries avoid false hits such as "average" containing "rage", but no
  // keyword list can decide whether a generated phrase is genuinely useful.
  const negativeSignalCandidates = uniqueCandidates.filter(candidate =>
    NEGATIVE_SIGNALS.some(signal => {
      const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|\\b)${escaped}(?:$|\\b)`, 'i').test(candidate);
    })
  );

  let validationRaw = '';
  let validationMalformed = true;
  const fallbackRuns: SuggestionResult['fallbackRuns'] = [];
  let accepted: string[] = [];
  let validationMs = 0;
  if (uniqueCandidates.length > 0) {
    const validation = await infer(runtime, model, post, uniqueCandidates);
    validationRaw = validation.rawResponse;
    validationMalformed = validation.malformed;
    accepted = validation.matches.slice(0, 3);
    validationMs = validation.fullCallMs;

    // Match production: malformed batch output never becomes an all-no. Retry
    // candidates through the strict one-category path until the UI's three
    // slots are filled. Operational failures propagate in both paths.
    if (validationMalformed) {
      accepted = [];
      for (const phrase of uniqueCandidates) {
        const fallback = await infer(runtime, model, post, [phrase]);
        fallbackRuns.push({
          phrase,
          shouldHide: fallback.shouldHide,
          malformed: fallback.malformed,
          rawResponse: fallback.rawResponse,
        });
        validationMs += fallback.fullCallMs;
        if (!fallback.malformed && fallback.shouldHide) {
          accepted.push(phrase);
          if (accepted.length === 3) break;
        }
      }
    }
  }

  return {
    post,
    rawGeneration,
    candidates,
    uniqueCandidates,
    invalidWordCount,
    negativeSignalCandidates,
    validationRaw,
    validationMalformed,
    fallbackUsed: validationMalformed,
    fallbackRuns,
    accepted,
    generationMs,
    validationMs,
    passesAutomatedChecks: uniqueCandidates.length === 9
      && invalidWordCount.length === 0
      && fallbackRuns.every(run => !run.malformed)
      && accepted.length >= 3,
    requiresManualSemanticReview: true,
  };
}

async function prepareModel(model: LocalModelDef, modelIndex: number, total: number): Promise<void> {
  if (await LitertlmRuntime.isCached(model)) return;
  setStatus(`Downloading ${model.display}…`, 'info', modelIndex / total);
  await prefetchLitertlmModel(model, update => {
    const withinModel = Number.isFinite(update.progress) ? update.progress : 0;
    setStatus(
      `Downloading ${model.display}: ${Math.round(withinModel * 100)}%`,
      'info',
      (modelIndex + withinModel) / total,
    );
  }, new AbortController().signal);
}

async function describeGpu(): Promise<string> {
  try {
    const gpu = navigator.gpu as undefined | {
      requestAdapter(): Promise<null | { info?: {
        vendor?: string;
        architecture?: string;
        device?: string;
        description?: string;
      } }>;
    };
    const adapter = await gpu?.requestAdapter();
    const info = adapter?.info;
    return [info?.vendor, info?.architecture, info?.device, info?.description].filter(Boolean).join(' / ') || 'WebGPU';
  } catch (error) {
    return `WebGPU info unavailable: ${(error as Error).message}`;
  }
}

async function interruptProbe(runtime: LitertlmRuntime, delayMs: number): Promise<Record<string, unknown>> {
  const cats = categories(3);
  const request = buildMessages(POSTS.medium.text, cats, 'baseline');
  const started = performance.now();
  let pending = true;
  const generation = runtime.generate(request.messages, request.maxOutputTokens).then(
    rawResponse => {
      pending = false;
      return {
        status: 'fulfilled',
        settledAfterMs: performance.now() - started,
        rawResponse,
        parsed: parseTableYesnoResponse(rawResponse, cats),
      };
    },
    (error: unknown) => {
      pending = false;
      return {
        status: 'rejected',
        settledAfterMs: performance.now() - started,
        errorName: error instanceof Error ? error.name : null,
        error: error instanceof Error ? error.message : String(error),
      };
    },
  );
  if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
  const pendingAtInterrupt = pending;
  const interruptRequestedAfterMs = performance.now() - started;
  let interruptError: string | null = null;
  try { await runtime.interrupt(); }
  catch (error) { interruptError = error instanceof Error ? error.message : String(error); }
  return {
    attemptedPhase: delayMs === 0 ? 'request-setup' : 'pending-work',
    requestedDelayMs: delayMs,
    interruptRequestedAfterMs,
    requestPendingAtInterrupt: pendingAtInterrupt,
    activeDecodeTargeted: 'unverified: public runtime API does not expose setup, prefill, or decode state',
    interruptResolvedAfterMs: performance.now() - started,
    interruptError,
    generation: await generation,
  };
}

async function smoke(runtime: LitertlmRuntime, model: LocalModelDef): Promise<Record<string, unknown>> {
  const classifications: Array<{
    stage: string; postId: string; categories: string[]; promptMode: LocalPromptMode; result: InferResult;
  }> = [];
  const classify = async (
    stage: string,
    post: { id: string; text: string },
    cats: string[],
    mode: LocalPromptMode = 'baseline',
  ): Promise<void> => {
    setStatus(`${model.display}: smoke ${stage}`, 'info');
    classifications.push({ stage, postId: post.id, categories: cats, promptMode: mode,
      result: await infer(runtime, model, post.text, cats, mode) });
  };

  // Reuse existing synthetic inputs and prompt variants; this is a lifecycle
  // probe rather than an additional corpus or ground-truth quality score.
  await classify('independent-first', EVAL_POSTS[0], ['rage bait']);
  await classify('independent-second', POSTS.short, ['rage bait']);
  await classify('single-filter', POSTS.medium, categories(1));
  await classify('multiple-filters', POSTS.medium, categories(3));
  await classify('prompt-mode-change', POSTS.medium, categories(3), 'intent');
  setStatus(`${model.display}: smoke suggestion flow`, 'info');
  const suggestion = await evaluateSuggestion(runtime, model, SUGGESTION_FIXTURES[0]);
  await classify('after-suggestion', POSTS.medium, categories(3));

  setStatus(`${model.display}: smoke interrupt during request setup`, 'info');
  const setupInterrupt = await interruptProbe(runtime, 0);
  await classify('after-setup-interrupt', POSTS.medium, categories(3));
  setStatus(`${model.display}: smoke interrupt pending work`, 'info');
  const pendingInterrupt = await interruptProbe(runtime, 25);
  await classify('after-pending-interrupt', POSTS.medium, categories(3));

  setStatus(`${model.display}: smoke unload and reload`, 'info');
  const unloadStarted = performance.now();
  await runtime.unload();
  const unloadMs = performance.now() - unloadStarted;
  const reloadStarted = performance.now();
  await runtime.initialize(model, () => undefined, new AbortController().signal);
  const reloadMs = performance.now() - reloadStarted;
  await classify('after-reload', POSTS.medium, categories(3));

  return {
    classifications,
    suggestion,
    interrupts: [setupInterrupt, pendingInterrupt],
    unloadMs,
    reloadMs,
    allClassificationsWellFormed: classifications.every(row => !row.result.malformed),
    suggestionAutomatedPass: suggestion.passesAutomatedChecks,
    requiresManualSemanticReview: true,
  };
}

async function compare(): Promise<void> {
  // Reset before any validation or async work so a failed rerun cannot export
  // a previous run's successful report or leave a stale completion marker.
  globalThis.__BOUNCER_GEMMA_REPORT__ = undefined;
  downloadableReport = null;
  downloadButton.disabled = true;
  summaryEl.dataset.complete = 'false';
  summaryEl.textContent = 'Run in progress.';
  progressEl.value = 0;
  const startedAt = new Date().toISOString();
  if (!navigator.gpu) throw new Error('WebGPU is unavailable in this Chrome tab.');
  const requestedScope = new URL(location.href).searchParams.get('scope');
  const scope = requestedScope === 'suggestions' || requestedScope === 'smoke' ? requestedScope : 'full';
  const suggestionsOnly = scope === 'suggestions';
  const models = gemmaModels();

  const report = {
    startedAt,
    runtimeVersion: __LITERTLM_VERSION__,
    environment: { userAgent: navigator.userAgent, gpu: await describeGpu() },
    config: {
      warmups: WARMUPS,
      timedRuns: TIMED_RUNS,
      accuracyRuns: ACCURACY_RUNS,
      scope,
      selectedModels: models.map(modelIdentity),
      modelOrder: models.map(model => model.name),
      timer: 'direct full call (prompt budgeting + truncation + generation); excludes MV3 IPC',
      progressUnits: 'classification calls and completed suggestion fixtures; each fixture includes any strict fallback calls',
    },
    wasmWarmupMs: 0,
    models: [] as Array<Record<string, unknown>>,
  };

  for (let index = 0; index < models.length; index++) {
    await prepareModel(models[index], index, models.length);
  }

  const wasmStarted = performance.now();
  await warmLitertlmWasm();
  report.wasmWarmupMs = performance.now() - wasmStarted;

  const fullWork = suggestionsOnly
    ? 0
    : 1 + CELLS.length * (WARMUPS + TIMED_RUNS)
      + EVAL_VARIANTS.length * EVAL_POSTS.length * ACCURACY_RUNS;
  const workPerModel = fullWork + SUGGESTION_FIXTURES.length;
  const totalWork = workPerModel * models.length;
  let completed = 0;

  for (const model of models) {
    const runtime = new LitertlmRuntime();
    try {
      setStatus(`Loading ${model.display} from cache…`, 'info', completed / totalWork);
      const loadStarted = performance.now();
      await runtime.initialize(model, () => undefined, new AbortController().signal);
      const loadMs = performance.now() - loadStarted;

      if (scope === 'smoke') {
        report.models.push({ ...modelIdentity(model), loadMs, smoke: await smoke(runtime, model) });
        summaryEl.textContent = JSON.stringify(report, null, 2);
        continue;
      }

      let first: InferResult | null = null;
      const latency: Array<Record<string, unknown>> = [];
      const accuracy: Array<Record<string, unknown>> = [];
      if (!suggestionsOnly) {
        first = await infer(runtime, model, POSTS.medium.text, categories(3));
        completed++;

        for (const cell of CELLS) {
          const post = POSTS[cell.postId];
          const cats = categories(cell.nCats);
          for (let warmup = 0; warmup < WARMUPS; warmup++) {
            setStatus(`${model.display}: ${post.label} ×${cell.nCats}, warmup ${warmup + 1}/${WARMUPS}`, 'info', completed / totalWork);
            await infer(runtime, model, post.text, cats);
            completed++;
          }
          const samples: Array<{ fullCallMs: number; generationMs: number }> = [];
          for (let run = 0; run < TIMED_RUNS; run++) {
            setStatus(`${model.display}: ${post.label} ×${cell.nCats}, timed ${run + 1}/${TIMED_RUNS}`, 'info', completed / totalWork);
            const measured = await infer(runtime, model, post.text, cats);
            samples.push({ fullCallMs: measured.fullCallMs, generationMs: measured.generationMs });
            completed++;
          }
          latency.push({
            postId: cell.postId,
            nCats: cell.nCats,
            samples,
            fullCallSummary: summarize(samples.map(sample => sample.fullCallMs)),
            generationSummary: summarize(samples.map(sample => sample.generationMs)),
          });
        }

        for (const variant of EVAL_VARIANTS) {
          const rows = [];
          for (const post of EVAL_POSTS) {
            const runs: InferResult[] = [];
            for (let run = 0; run < ACCURACY_RUNS; run++) {
              setStatus(`${model.display}: accuracy ${variant.label}, ${post.id}, run ${run + 1}/${ACCURACY_RUNS}`, 'info', completed / totalWork);
              runs.push(await infer(runtime, model, post.text, variant.filters, variant.promptMode));
              completed++;
            }
            const hideCount = runs.filter(run => run.shouldHide).length;
            rows.push({
              id: post.id,
              kind: post.kind,
              expected: expectsHide(post),
              predicted: hideCount * 2 > ACCURACY_RUNS,
              hideCount,
              runs,
            });
          }
          accuracy.push({
            variantId: variant.id,
            rows,
            score: score(rows),
            byKind: scoreByKind(rows),
            unstableRows: unstableCount(rows),
            malformedRuns: rows.flatMap(row => row.runs).filter(run => run.malformed).length,
          });
        }
      }

      const suggestions: SuggestionResult[] = [];
      for (const post of SUGGESTION_FIXTURES) {
        setStatus(`${model.display}: suggestion fixture ${suggestions.length + 1}/${SUGGESTION_FIXTURES.length}`, 'info', completed / totalWork);
        suggestions.push(await evaluateSuggestion(runtime, model, post));
        completed++;
      }

      report.models.push({
        ...modelIdentity(model),
        loadMs,
        firstInferenceMs: first?.fullCallMs ?? null,
        firstGenerationMs: first?.generationMs ?? null,
        latency,
        accuracy,
        suggestions,
        suggestionAutomatedPasses: suggestions.filter(result => result.passesAutomatedChecks).length,
      });
      summaryEl.textContent = JSON.stringify(report, null, 2);
    } finally {
      await runtime.unload();
    }
  }

  const finished = { ...report, finishedAt: new Date().toISOString() };
  summaryEl.textContent = JSON.stringify(finished, null, 2);
  summaryEl.dataset.complete = 'true';
  globalThis.__BOUNCER_GEMMA_REPORT__ = finished;
  downloadableReport = {
    json: JSON.stringify(finished, null, 2),
    filename: `bouncer-gemma-${scope}-${finished.runtimeVersion}-${finished.finishedAt.replace(/[:.]/g, '-')}.json`,
  };
  downloadButton.disabled = false;
  setStatus(`${scope === 'smoke' ? 'Smoke run' : models.length === 1 ? 'E2B verification' : 'Comparison'} complete.`, 'ok', 1);
}

declare global {
  // Browser automation reads the finished structured report without parsing UI copy.
  var __BOUNCER_GEMMA_REPORT__: unknown;
}

runButton.addEventListener('click', () => {
  runButton.disabled = true;
  summaryEl.dataset.complete = 'false';
  compare().catch(error => {
    console.error(error);
    setStatus(`Error: ${(error as Error).message}`, 'error');
    summaryEl.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }).finally(() => {
    runButton.disabled = false;
  });
});

downloadButton.addEventListener('click', () => {
  if (!downloadableReport || summaryEl.dataset.complete !== 'true') return;
  const url = URL.createObjectURL(new Blob([downloadableReport.json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = downloadableReport.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

if (new URL(location.href).searchParams.get('autorun') === '1') runButton.click();
