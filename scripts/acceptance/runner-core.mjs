// Pure gates for the finite, human-operated development acceptance page.
export const QUIET_MS = 120_000;
export const NATIVE_MANIFEST = 'fbc40c82cb8acd3f63077d417d6040a42b5aeac406ed078fa8ba888fb38cfc19';
const browserDigest = '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5';
const browserUrl = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/9262660a1676eed6d0c477ab1a86344430854664/gemma-4-E2B-it-web.litertlm';
export const PINS = Object.freeze({
  litertlm: Object.freeze({ engine: 'litertlm', modelId: 'gemma-4-E2B-it-web', weightDigest: browserDigest,
    manifestDigest: null, runtimeVersion: '0.17.0', classifierFingerprint: [
      'browser-v1', browserDigest, browserUrl, 'litert-lm:0.17.0', 'table_yesno-comma-v1',
      'strict-table-parser-v1', 'greedy,context:1024', 'output:min(256,max(64,12*n)),input:ceil(chars/3)',
    ].join('|') }),
  ollama: Object.freeze({ engine: 'ollama', modelId: 'bouncer-gemma4-e2b-qat-text:v1',
    weightDigest: '3646b4c147cd235a44d91df1546d3b7d8e29b547dbe4e1f80856419aa455e6fd',
    manifestDigest: NATIVE_MANIFEST, runtimeVersion: '0.40.3', classifierFingerprint: [
      'native-v1', NATIVE_MANIFEST, 'table_yesno-numbered-v1', 'strict-table-parser-v1',
      'think:false,stream:false,truncate:false,shift:false,temperature:0,seed:0,num_ctx:1024',
      'output:min(256,max(64,12*n)),input:ceil(chars/3)',
    ].join('|') }),
});
export const CATEGORIES = Object.freeze(['astronomy', 'cooking']);
export const CASES = Object.freeze([
  Object.freeze({ id: 'astronomy', text: 'Astronomy observation: a telescope reveals Saturn, its rings, and bright stars in the night sky.', expected: Object.freeze([true, false]) }),
  Object.freeze({ id: 'cooking', text: 'Cooking recipe: simmer tomato soup in a pot, add basil, and serve it with freshly baked bread.', expected: Object.freeze([false, true]) }),
  Object.freeze({ id: 'neutral', text: 'The office meeting starts at nine. Please bring a notebook and take a seat near the front.', expected: Object.freeze([false, false]) }),
]);
// Separate text from the three smoke cases, so wakeup cannot reuse their input.
export const WAKE_CASES = Object.freeze({
  litertlm: Object.freeze({ id: 'browser-wake', text: 'Astronomy field notes: a lunar eclipse makes the Moon dark while Earth blocks sunlight.', expected: Object.freeze([true, false]) }),
  ollama: Object.freeze({ id: 'native-wake', text: 'Cooking instructions: whisk eggs, heat a pan, and cook a plain omelet for breakfast.', expected: Object.freeze([false, true]) }),
});

export class AcceptanceFault extends Error {
  constructor(code, details = null) { super(code); this.name = 'AcceptanceFault'; this.code = code; this.details = details; }
}
const fail = code => { throw new AcceptanceFault(code); };
export function assertIdentity(identity, engine, selectionRevision) {
  const expected = PINS[engine];
  if (!identity || !expected || Object.keys(expected).some(key => identity[key] !== expected[key])) fail('classifier_identity_mismatch');
  if (!Number.isSafeInteger(identity.selectionRevision) || identity.selectionRevision < 1
      || (selectionRevision !== undefined && identity.selectionRevision !== selectionRevision)) fail('selection_revision_mismatch');
  return { ...expected, selectionRevision: identity.selectionRevision };
}

function verdict(value) {
  const match = value.trim().match(/^(yes|no)[.!,:;]?$/i);
  return match ? match[1].toLowerCase() === 'yes' : null;
}
function cells(line) {
  const result = line.split('|').map(value => value.trim());
  if (result[0] === '') result.shift();
  if (result.at(-1) === '') result.pop();
  return result;
}
// Inspect the entire output, including category order. shouldHide alone would
// incorrectly pass an astronomy/cooking swap because both cases hide.
export function verdictVector(raw, categories = CATEGORIES) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096) fail('verdict_shape_invalid');
  let text = raw.trim().replace(/^(?:<(?:bos|pad)>[ \t\r\n]*)+/i, '')
    .replace(/(?:[ \t\r\n]*<(?:eos|pad)>)+$/i, '')
    .replace(/^<\|?(?:turn|start_of_turn)\|?>(?:[ \t]*(?:model|assistant)(?=[ \t]*(?:\r?\n|$)))?/i, '')
    .replace(/(?:[ \t\r\n]*<\|?(?:turn|end_of_turn)\|?>)+$/i, '').trim();
  if (/<\|?(?:turn|start_of_turn|end_of_turn)\|?>|<(?:eos|bos|pad)>/i.test(text)) fail('verdict_shape_invalid');
  const lines = text.split('\n').map(value => value.trim()).filter(Boolean);
  const isLabel = (label, index) => label.toLowerCase() === categories[index].toLowerCase();
  let values;
  if (lines.length === 1 && lines[0].includes('|')) {
    const row = cells(lines[0]);
    if (row.length === categories.length * 2 && categories.every((_, index) => isLabel(row[index * 2], index))) {
      values = categories.map((_, index) => verdict(row[index * 2 + 1]));
    } else values = row.map(verdict);
  } else if (lines.length === categories.length && lines.every(line => line.includes('|'))) {
    values = lines.map((line, index) => {
      const row = cells(line);
      return row.length === 2 && isLabel(row[0], index) ? verdict(row[1]) : null;
    });
  } else values = lines.map(verdict);
  if (values.length !== categories.length || values.some(value => value === null)) fail('verdict_shape_invalid');
  return values;
}
export function assertSmoke(result, identity, testCase) {
  assertIdentity(result, identity.engine, identity.selectionRevision);
  const vector = verdictVector(result.rawResponse);
  if (vector.some((value, index) => value !== testCase.expected[index])) fail('synthetic_verdict_mismatch');
  if (typeof result.shouldHide !== 'boolean' || result.shouldHide !== vector.some(Boolean)) fail('hide_vector_mismatch');
  if (![result.wallMs, result.inferenceTime].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) fail('inference_accounting_invalid');
  return { caseId: testCase.id, vector, shouldHide: result.shouldHide,
    wallMs: Math.round(result.wallMs), inferenceSeconds: result.inferenceTime };
}

export function summarizeContexts(contexts) {
  if (!Array.isArray(contexts) || contexts.length > 100) fail('contexts_invalid');
  const counts = { BACKGROUND: 0, OFFSCREEN_DOCUMENT: 0, other: 0 };
  const backgroundIds = [];
  for (const context of contexts) {
    if (!context || typeof context.contextType !== 'string') fail('contexts_invalid');
    if (context.contextType === 'BACKGROUND') {
      if (typeof context.contextId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(context.contextId)) fail('contexts_invalid');
      counts.BACKGROUND++; backgroundIds.push(context.contextId);
    } else if (context.contextType === 'OFFSCREEN_DOCUMENT') counts.OFFSCREEN_DOCUMENT++;
    else counts.other++;
  }
  return { counts, backgroundIds };
}
export function assertBeforeQuiet(snapshot, engine) {
  if (snapshot.counts.BACKGROUND !== 1 || snapshot.backgroundIds.length !== 1) fail('before_quiet_worker_missing');
  if (snapshot.counts.OFFSCREEN_DOCUMENT !== (engine === 'litertlm' ? 1 : 0)) fail('before_quiet_offscreen_mismatch');
  return snapshot;
}
export function assertAbsentBeforeWake(snapshot) {
  if (snapshot.counts.BACKGROUND !== 0 || snapshot.counts.OFFSCREEN_DOCUMENT !== 0) fail('idle_contexts_still_present');
  return snapshot;
}
export function assertRecreated(before, absent, after, engine) {
  // Absence is a mandatory input to this gate, not an optional report note.
  assertAbsentBeforeWake(absent);
  assertBeforeQuiet(before, engine); assertBeforeQuiet(after, engine);
  if (before.backgroundIds[0] === after.backgroundIds[0]) fail('worker_context_not_recreated');
  return true;
}

// This is the actual runner's ordering coordinator, also exercised with fake
// adapters. readContexts after quiet must precede residency and real wake work.
export async function quietWakeSequence({ engine, before, residentBefore = null, detach, quietInterval,
  readContexts, readNativePs, wake }) {
  assertBeforeQuiet(before, engine);
  if (engine === 'ollama' && !residentBefore?.candidateResident) fail('native_candidate_not_observed');
  await detach();
  const sample = await quietInterval();
  let quietMs;
  try { quietMs = assertQuietComplete(sample); }
  catch (error) {
    if (error instanceof AcceptanceFault) error.details = { before,
      quietElapsedMs: Number.isFinite(sample.elapsedMs) ? Math.max(0, Math.min(600_000, Math.floor(sample.elapsedMs))) : null };
    throw error;
  }
  const observedAfterQuiet = await readContexts();
  let absent;
  try { absent = assertAbsentBeforeWake(observedAfterQuiet); }
  catch (error) {
    if (error instanceof AcceptanceFault) error.details = { before, observedAfterQuiet, quietMs };
    throw error;
  }
  let residentAfter;
  try { residentAfter = engine === 'ollama' ? await readNativePs() : null; }
  catch (error) {
    if (error instanceof AcceptanceFault) error.details = { before, absent, quietMs, residentBefore };
    throw error;
  }
  const evidence = { before, absent, quietMs, configuredRetentionSeconds: 60, exactExpiryTimeMeasured: false,
    ...(residentBefore ? { residentBefore, residentAfter } : {}) };
  if (residentAfter?.candidateResident) throw new AcceptanceFault('native_residency_extended', evidence);
  const wakeResult = await wake();
  const after = await readContexts();
  try { assertRecreated(before, absent, after, engine); }
  catch (error) {
    if (error instanceof AcceptanceFault) error.details = { ...evidence, after, wake: wakeResult };
    throw error;
  }
  return { ...evidence, after, wake: wakeResult };
}

export function createQuietSample(perf, wall, visible) {
  if (!visible) fail('quiet_hidden');
  return { perfStart: perf, wallStart: wall, perfLast: perf, wallLast: wall, elapsedMs: 0, invalid: null };
}
export function advanceQuiet(sample, perf, wall, visible, lifecycleEvent = null) {
  const perfGap = perf - sample.perfLast;
  const wallGap = wall - sample.wallLast;
  const perfElapsed = perf - sample.perfStart;
  const wallElapsed = wall - sample.wallStart;
  let invalid = sample.invalid;
  if (!visible) invalid ??= 'quiet_hidden';
  if (lifecycleEvent) invalid ??= 'quiet_lifecycle_interrupted';
  if (![perfGap, wallGap, perfElapsed, wallElapsed].every(Number.isFinite)
      || perfGap < 0 || wallGap < 0 || perfGap > 5000 || wallGap > 5000
      || Math.abs(wallElapsed - perfElapsed) > 2000) invalid ??= 'quiet_clock_or_sleep_interrupted';
  return { ...sample, perfLast: perf, wallLast: wall, elapsedMs: Math.min(perfElapsed, wallElapsed), invalid };
}
export function assertQuietComplete(sample) {
  if (sample.invalid) fail(sample.invalid);
  if (sample.elapsedMs < QUIET_MS) fail('quiet_too_short');
  return Math.floor(sample.elapsedMs);
}

export function summarizeNativePs(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.models) || body.models.length > 100) fail('native_ps_invalid');
  let candidateResident = false;
  let otherResidentCount = 0;
  for (const model of body.models) {
    if (!model || typeof model !== 'object' || typeof model.digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(model.digest)) fail('native_ps_invalid');
    if (model.digest === NATIVE_MANIFEST) candidateResident = true;
    else otherResidentCount++;
  }
  // Raw model names and unrelated model digests never leave this function.
  return { candidateResident, otherResidentCount };
}

// This deadline belongs only to an observational GET, never to generation.
// One signal covers both response headers and complete streamed-body reading.
export async function readNativeResidency(fetcher = globalThis.fetch, timers = { setTimeout, clearTimeout }) {
  const controller = new AbortController();
  const deadline = timers.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetcher('http://127.0.0.1:11434/api/ps', {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new AcceptanceFault('native_ps_unavailable');
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let size = 0; let text = '';
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 262_144) { await reader.cancel(); throw new AcceptanceFault('native_ps_invalid'); }
        text += decoder.decode(part.value, { stream: true });
      }
      return summarizeNativePs(JSON.parse(text + decoder.decode()));
    } finally { reader.releaseLock(); }
  } catch (error) {
    throw error instanceof AcceptanceFault ? error : new AcceptanceFault('native_ps_unavailable');
  } finally { timers.clearTimeout(deadline); }
}

export function sanitizeReceipt(config) {
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const path = value => typeof value === 'string' && value.length < 200
    && /^[A-Za-z0-9_.\/-]+$/.test(value) && !value.startsWith('/') && !value.split('/').includes('..');
  if (!config || config.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/i.test(config.runId ?? '')
      || config.extensionId !== 'bkijmhafoocfloemhancbgadknkgdkcm'
      || config.source?.litertRuntime !== '0.17.0' || config.source?.ollamaRuntime !== '0.40.3'
      || !/^[a-f0-9]{40}$/.test(config.source?.commit ?? '')
      || !/^v?\d+\.\d+\.\d+$/.test(config.source?.nodeVersion ?? '')
      || !/^\d+\.\d+\.\d+\.\d+$/.test(config.browser?.version ?? '')
      || config.browser?.name !== 'Chrome for Testing' || config.browser.mockKeychain !== true
      || config.browser.sandbox !== true || config.browser.debugger !== false
      || !digest(config.browser.executableSha256)) fail('source_receipt_invalid');
  const tree = value => {
    if (!value || !digest(value.treeSha256) || !digest(value.backgroundSha256)) fail('source_receipt_invalid');
    return { treeSha256: value.treeSha256, backgroundSha256: value.backgroundSha256 };
  };
  const production = tree(config.production);
  if (!count(config.production.fileCount) || !count(config.production.totalBytes)
      || !Array.isArray(config.production.files) || config.production.files.length > 200
      || config.production.files.length !== config.production.fileCount
      || !config.production.files.every(file => path(file.path) && digest(file.sha256) && count(file.bytes))) fail('source_receipt_invalid');
  Object.assign(production, { fileCount: config.production.fileCount, totalBytes: config.production.totalBytes,
    files: config.production.files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })) });
  const development = tree(config.development);
  if (!Array.isArray(config.development.productionDifferences) || config.development.productionDifferences.length > 100
      || !config.development.productionDifferences.every(path)) fail('source_receipt_invalid');
  development.productionDifferences = [...config.development.productionDifferences];
  if (!digest(config.development.overlayTreeSha256) || !Array.isArray(config.development.testOverlayFiles)
      || config.development.testOverlayFiles.length > 100
      || !config.development.testOverlayFiles.every(file => path(file.path) && digest(file.sha256) && count(file.bytes))) fail('source_receipt_invalid');
  development.overlayTreeSha256 = config.development.overlayTreeSha256;
  development.testOverlayFiles = config.development.testOverlayFiles.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }));
  return { schemaVersion: 1, runId: config.runId, preparedAt: validTime(config.preparedAt),
    label: 'Isolated development acceptance — production final checks pending', extensionId: config.extensionId,
    browser: { name: 'Chrome for Testing', version: config.browser.version, executableSha256: config.browser.executableSha256,
      mockKeychain: true, sandbox: true, debugger: false },
    production, development, source: { commit: config.source.commit, nodeVersion: config.source.nodeVersion,
      litertRuntime: '0.17.0', ollamaRuntime: '0.40.3' } };
}
export function validTime(value) {
  return typeof value === 'string' && value.length < 40 && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}

export function restoreSafetyLedger(value, runId) {
  if (!value || value.schemaVersion !== 1 || value.runId !== runId
      || !Number.isSafeInteger(value.pendingRequests) || value.pendingRequests < 0 || value.pendingRequests > 100
      || typeof value.safeToCleanup !== 'boolean' || typeof value.terminal !== 'boolean') fail('saved_ledger_invalid');
  // Explicit uncertainty survives the window after a failed native request has
  // settled in the renderer but before terminal finalization is persisted.
  const nativeUncertain = value.nativeUncertain !== false || value.pendingRequests > 0
    || typeof value.nativeEverAttempted !== 'boolean';
  return { pendingRequests: value.pendingRequests, nativeUncertain,
    nativeEverAttempted: value.nativeEverAttempted === true || typeof value.nativeEverAttempted !== 'boolean',
    safeToCleanup: !nativeUncertain && value.pendingRequests === 0 };
}
