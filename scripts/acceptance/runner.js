import { AcceptanceFault, PINS, CASES, CATEGORIES, WAKE_CASES, QUIET_MS, assertIdentity, assertSmoke,
  summarizeContexts, assertBeforeQuiet, quietWakeSequence,
  createQuietSample, advanceQuiet, readNativeResidency, sanitizeReceipt, validTime, restoreSafetyLedger } from './runner-core.mjs';

const byId = id => document.getElementById(id);
const origin = `chrome-extension://${chrome.runtime.id}`;
const protocol = 'bouncer-acceptance-v1';
const labels = Object.freeze({ browser_setup: 'Browser selection and explicit download', browser_smoke: 'Browser synthetic verdict smoke',
  browser_idle: 'Browser quiet expiry and real-work recreation', to_native: 'Browser → Ollama selection',
  native_connect: 'Owner-operated Connect and genuine Chrome grant', native_smoke: 'Ollama synthetic verdict smoke',
  native_idle: 'Ollama residency expiry and real-work recreation', initialization_retirement: 'Browser in-flight initialization retirement attempt',
  to_browser: 'Ollama → Browser selection and real inference', return_native: 'Browser → Ollama final real inference' });
const inconclusiveCodes = new Set(['quiet_hidden', 'quiet_lifecycle_interrupted', 'quiet_clock_or_sleep_interrupted',
  'native_residency_extended', 'native_ps_unavailable', 'native_ps_invalid', 'native_candidate_not_observed',
  'native_request_uncertain', 'reloaded_run_cannot_resume', 'page_lifecycle_interrupted', 'owner_ended_before_native']);
let config = null;
let report = null;
let running = false;
let quiet = false;
let unsafeNative = false;
let blocked = false;
let currentPhase = null;
let relay = null;
let continueGate = null;
let progressAttached = false;
let loadingObserver = null;
let lifecycleInterrupted = false;
let ledgerKey = null;
let prepared = false;

function fault(code) { throw new AcceptanceFault(code); }
function controls() {
  const idle = prepared && !running && report === null && config !== null;
  byId('start').disabled = !idle || !byId('otherClientsIdle').checked || !byId('quietReady').checked;
  byId('otherClientsIdle').disabled = running || report !== null;
  byId('quietReady').disabled = running || report !== null;
  byId('continue').disabled = quiet || !continueGate || report?.pendingRequests > 0;
  byId('finish').disabled = quiet || !continueGate || report?.pendingRequests > 0;
  byId('export').disabled = quiet || !report?.terminal;
  document.body.classList.toggle('quiet', quiet);
}
function persist() {
  if (quiet || !report || !ledgerKey) return;
  report.nativeUncertain = report.nativeUncertain === true || unsafeNative;
  report.safeToCleanup = report.terminal && report.pendingRequests === 0 && !report.nativeUncertain;
  try { localStorage.setItem(ledgerKey, JSON.stringify(report)); }
  catch { fault('report_persistence_unavailable'); }
}
function render() {
  const list = byId('steps'); list.replaceChildren();
  for (const phase of report?.phases ?? []) {
    const item = document.createElement('li');
    item.dataset.status = phase.status;
    item.textContent = `${labels[phase.id] ?? 'Run interruption'}: ${phase.status}${phase.code ? ` (${phase.code})` : ''}`;
    list.append(item);
  }
  controls();
}
function record(id, status, details = {}, code = null) {
  report.phases.push({ id, status, at: new Date().toISOString(), ...(code ? { code } : {}), details });
  persist(); render();
}
function state(text) { byId('state').textContent = text; }
function noteStatus(status) {
  if (status?.state === 'recovery_required') { blocked = true; unsafeNative = true; }
  if (status?.reason === 'browser_cleanup_failed') blocked = true;
}
function gateWork() {
  if (quiet) fault('worker_action_during_quiet');
  if (blocked || unsafeNative) fault('recovery_or_cleanup_blocked');
  if (lifecycleInterrupted) fault('page_lifecycle_interrupted');
}
async function tracked(action, nativeGeneration = false) {
  gateWork(); report.pendingRequests++;
  if (nativeGeneration) report.nativeEverAttempted = true;
  try { persist(); controls(); return await action(); }
  catch (error) {
    if (nativeGeneration) { unsafeNative = true; blocked = true; throw new AcceptanceFault('native_request_uncertain'); }
    throw error instanceof AcceptanceFault ? error : new AcceptanceFault('extension_request_failed');
  } finally { report.pendingRequests--; persist(); controls(); }
}
async function benchmark(op, identity, testCase) {
  const message = op === 'status' ? { type: 'benchmark', op: 'status' }
    : { type: 'benchmark', op: 'infer', selectionRevision: identity.selectionRevision,
      post: { text: testCase.text }, categories: [...CATEGORIES] };
  return tracked(async () => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result || result.error) fault('benchmark_request_failed');
    if (op === 'status') noteStatus(result.status);
    return result;
  }, op === 'infer' && identity.engine === 'ollama');
}
async function infer(identity, testCase) {
  const result = await benchmark('infer', identity, testCase);
  // A successful transport is already settled before a verdict/identity gate
  // can fail. No response content or free-form native errors are persisted.
  return assertSmoke(result, identity, testCase);
}
async function identityFor(engine, selectionRevision) {
  const result = await benchmark('status');
  assertReady(result.status, engine, selectionRevision);
  return assertIdentity(result.identity, engine, selectionRevision);
}
function assertReady(status, engine, revision) {
  noteStatus(status); gateWork();
  if (!status || status.engine !== engine || status.selectionRevision !== revision) fault('status_selection_mismatch');
  if (status.state !== 'ready') fault('selected_engine_not_ready');
}

function storageProgress(changes, area) {
  if (quiet || area !== 'local') return;
  for (const key of ['localModelStatus', 'browserModelStatus', 'nativeModelStatus']) noteStatus(changes[key]?.newValue);
  const status = changes.browserModelStatus?.newValue ?? changes.localModelStatus?.newValue;
  if (status?.engine === 'litertlm' && ['downloading', 'loading'].includes(status.state)) {
    if (status.state === 'downloading') {
      const bytes = status.receivedBytes;
      const total = status.totalBytes;
      byId('progress').hidden = false;
      if (Number.isFinite(bytes) && bytes >= 0 && bytes <= 2_008_432_640 && total === 2_008_432_640) {
        byId('progress').value = bytes / total * 100;
        byId('progressText').textContent = `${(bytes / 1e9).toFixed(2)} GB of 2.01 GB received; production integrity verification is required before use.`;
      }
    }
    if (status.state === 'loading') loadingObserver?.(status);
  }
}
function attachProgress() {
  if (quiet || progressAttached) return;
  chrome.storage.onChanged.addListener(storageProgress); progressAttached = true;
}
function detachProgress() {
  if (!progressAttached) return;
  chrome.storage.onChanged.removeListener(storageProgress); progressAttached = false;
}
async function openPopup(allowConnect = false) {
  gateWork();
  if (relay) fault('popup_already_open');
  const frame = document.createElement('iframe');
  frame.title = 'Actual Bouncer settings document'; frame.src = 'popup.html';
  byId('popupHost').hidden = false;
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  byId('popupHost').append(frame);
  await loaded;
  const channel = new MessageChannel();
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise(resolve => {
    channel.port1.onmessage = event => {
      const message = event.data;
      if (!message || message.protocol !== protocol || message.token !== token) return;
      if (message.event === 'blocked') {
        blocked = true; if (message.kind !== 'browser_cleanup') unsafeNative = true;
        persist(); return;
      }
      if (message.ready === true) { resolve(); return; }
      const owned = pending.get(message.id);
      if (!owned) return;
      pending.delete(message.id);
      if (message.error) {
        if (message.error === 'relay_blocked') {
          blocked = true; if (message.kind !== 'browser_cleanup') unsafeNative = true;
        }
        owned.reject(new AcceptanceFault(message.error === 'relay_blocked' ? 'recovery_or_cleanup_blocked' : 'popup_command_failed'));
      }
      else { noteStatus(message.result?.status); owned.resolve(message.result); }
    };
  });
  channel.port1.start();
  relay = { frame, port: channel.port1, pending, command(command, engine) {
    return new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject });
      channel.port1.postMessage({ protocol, token, id, command, ...(engine ? { engine } : {}) });
    });
  } };
  frame.contentWindow.postMessage({ protocol, token, allowConnect }, origin, [channel.port2]);
  await ready;
}
function closePopup() {
  if (!relay) return;
  if (relay.pending.size) fault('popup_commands_pending');
  relay.port.onmessage = null; relay.port.close(); relay.frame.remove(); relay = null;
  byId('popupHost').hidden = true;
}
async function popupCommand(command, engine) {
  if (!relay) fault('popup_missing');
  return tracked(() => relay.command(command, engine));
}
async function select(engine, previousRevision = 0) {
  const result = await popupCommand('selectInferenceEngine', engine);
  if (!result || result.success !== true || result.selection?.engine !== engine
      || !Number.isSafeInteger(result.selection.revision) || result.selection.revision <= previousRevision
      || result.status?.engine !== engine || result.status.selectionRevision !== result.selection.revision) fault('selection_readback_failed');
  noteStatus(result.status); gateWork();
  return result;
}
async function pauseForNativeConnect(selection) {
  currentPhase = 'native_connect';
  state('Paused for the owner’s genuine Connect gesture. No classification is running.');
  byId('instruction').hidden = false;
  byId('instruction').textContent = 'In the actual settings document below, click Connect to Ollama, then use Chrome’s Allow action for only http://127.0.0.1:11434/*. After Ready appears, click Check readiness and continue. If a recovery fence or setup problem appears, stop this run; do not restart, recover or alter native setup here.';
  byId('continue').hidden = false; byId('finish').hidden = false;
  await new Promise((resolve, reject) => { continueGate = { selection, resolve, reject }; controls(); });
  continueGate = null; byId('continue').hidden = true; byId('finish').hidden = true; byId('instruction').hidden = true;
  // The bridge waited for the genuine popup action's DOM busy state to settle.
  closePopup();
  record('native_connect', 'passed', { selectionRevision: selection.revision,
    gesture: 'owner_operated_product_connect', browserGrant: 'human_operated_chrome_ui',
    limit: 'grant_ui_observation_requires_owner_report' });
}
byId('continue').addEventListener('click', async () => {
  if (!continueGate || quiet || report.pendingRequests > 0) return;
  const owned = continueGate;
  try {
    const result = await popupCommand('getLocalModelStatus');
    assertReady(result.status, 'ollama', owned.selection.revision);
    if (continueGate === owned) owned.resolve();
  } catch (error) {
    if (blocked || unsafeNative) { continueGate = null; owned.reject(error); }
    else {
      state('Ollama is not Ready. Complete the genuine Connect/Allow step, or leave the profile and report intact for diagnosis.');
      controls();
    }
  }
});
byId('finish').addEventListener('click', () => {
  if (!continueGate || quiet || report.pendingRequests > 0) return;
  const owned = continueGate; continueGate = null;
  owned.reject(new AcceptanceFault('owner_ended_before_native'));
});

async function contexts() {
  if (quiet) fault('context_read_during_quiet');
  return summarizeContexts(await chrome.runtime.getContexts({}));
}
function quietLocally() {
  return new Promise(resolve => {
    let sample = createQuietSample(performance.now(), Date.now(), document.visibilityState === 'visible');
    const mark = event => { sample = advanceQuiet(sample, performance.now(), Date.now(), document.visibilityState === 'visible', event.type); };
    document.addEventListener('visibilitychange', mark);
    document.addEventListener('freeze', mark); document.addEventListener('resume', mark);
    window.addEventListener('pagehide', mark); window.addEventListener('pageshow', mark);
    const tick = () => {
      sample = advanceQuiet(sample, performance.now(), Date.now(), document.visibilityState === 'visible');
      const remaining = Math.max(0, Math.ceil((QUIET_MS - sample.elapsedMs) / 1000));
      state(`Quiet interval: ${remaining} seconds remaining. Keep this tab visible and the Mac awake.`);
      if (!sample.invalid && sample.elapsedMs < QUIET_MS) { setTimeout(tick, 1000); return; }
      document.removeEventListener('visibilitychange', mark);
      document.removeEventListener('freeze', mark); document.removeEventListener('resume', mark);
      window.removeEventListener('pagehide', mark); window.removeEventListener('pageshow', mark);
      resolve(sample);
    };
    setTimeout(tick, 1000);
  });
}
async function nativePs() {
  if (quiet) fault('native_read_during_quiet');
  return readNativeResidency(fetch, { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) });
}
async function idleAndWake(identity) {
  const id = identity.engine === 'litertlm' ? 'browser_idle' : 'native_idle';
  currentPhase = id;
  if (relay) await popupCommand('getLocalModelStatus');
  if (report.pendingRequests !== 0) fault('requests_pending_before_quiet');
  const before = assertBeforeQuiet(await contexts(), identity.engine);
  const residentBefore = identity.engine === 'ollama' ? await nativePs() : null;
  if (residentBefore && !residentBefore.candidateResident) fault('native_candidate_not_observed');
  const evidence = await quietWakeSequence({ engine: identity.engine, before, residentBefore,
    detach: () => {
      detachProgress(); closePopup();
      if (report.pendingRequests !== 0) fault('requests_pending_before_quiet');
      byId('progress').hidden = true; byId('progressText').textContent = '';
      report.status = 'quiet'; persist();
    },
    quietInterval: async () => {
      quiet = true; controls();
      try { return await quietLocally(); } finally { quiet = false; }
    },
    // The coordinator invokes this first after quiet, before any listener,
    // popup recreation or worker message. Surviving workers are never woken.
    readContexts: contexts, readNativePs: nativePs,
    wake: async () => {
      gateWork(); state(`${identity.engine === 'litertlm' ? 'Browser' : 'Ollama'} real uncached wake inference…`);
      return infer(identity, WAKE_CASES[identity.engine]);
    },
  });
  record(id, 'passed', evidence);
  report.status = 'running'; persist(); attachProgress();
}

async function initializationRetirement(nativeIdentity) {
  currentPhase = 'initialization_retirement';
  state('Attempting a switch while a cold Browser initialization is in flight…');
  await openPopup();
  const browserSelection = await select('litertlm', nativeIdentity.selectionRevision);
  const browserIdentity = await identityFor('litertlm', browserSelection.selection.revision);
  let settled = false;
  let sawLoading = false;
  let loadingSelection = null;
  let resolveLoading;
  const loading = new Promise(resolve => { resolveLoading = resolve; });
  loadingObserver = status => {
    if (status.selectionRevision !== browserIdentity.selectionRevision || settled) return;
    sawLoading = true; loadingSelection = status.selectionRevision; resolveLoading('loading');
  };
  // Browser-only race: both branches retain and await the original operation.
  // This never abandons or interrupts a native request.
  const pending = benchmark('infer', browserIdentity, CASES[0]).then(value => {
    settled = true; return { ok: true, value };
  }, error => { settled = true; return { ok: false, error }; });
  const boundary = await Promise.race([loading, pending.then(() => 'settled')]);
  loadingObserver = null;
  if (boundary !== 'loading' || settled) {
    const result = await pending;
    if (!result.ok) throw result.error;
    assertSmoke(result.value, browserIdentity, CASES[0]);
    record('initialization_retirement', 'inconclusive', { sawLoading }, 'initialization_boundary_not_captured');
    const nativeSelection = await select('ollama', browserIdentity.selectionRevision);
    closePopup();
    return identityFor('ollama', nativeSelection.selection.revision);
  }
  let nativeSelection;
  let result;
  try { nativeSelection = await select('ollama', browserIdentity.selectionRevision); }
  finally { result = await pending; }
  gateWork();
  // Success for the retired revision would violate the stale-result contract.
  if (result.ok) fault('retired_browser_result_accepted');
  assertReady(nativeSelection.status, 'ollama', nativeSelection.selection.revision);
  closePopup();
  const current = await identityFor('ollama', nativeSelection.selection.revision);
  record('initialization_retirement', 'passed', { observedState: 'loading', loadingSelection,
    retiredSelectionRevision: browserIdentity.selectionRevision, replacementSelectionRevision: current.selectionRevision,
    retiredResult: 'rejected', limit: 'physical_initialization_boundary_not_independently_instrumented' });
  return current;
}

async function run() {
  if (running || report || !config || !byId('otherClientsIdle').checked || !byId('quietReady').checked) return;
  running = true; attachProgress();
  report = { schemaVersion: 1, runId: config.runId, status: 'running', terminal: false, pendingRequests: 0,
    safeToCleanup: false, nativeUncertain: false, nativeEverAttempted: false,
    startedAt: new Date().toISOString(), completedAt: null, sourceReceipt: config,
    modelPins: PINS, phases: [], coverage: { syntheticSmoke: true, productionByteIdentity: false,
      toolbarPopup: false, manualDecisions: false, suggestions: false, nativeFenceRecovery: false, normalLogin: false },
    ownerAttestations: { otherLocalClientsIdle: true, disposableMockSandboxNoDebugger: true } };
  try {
    persist(); render(); currentPhase = 'browser_setup';
    await openPopup();
    const browserSelection = await select('litertlm');
    if (browserSelection.status.state === 'needs_download' || browserSelection.status.state === 'missing_model') {
      state('Explicitly downloading and verifying the pinned 2.01 GB Browser model…');
      const downloaded = await popupCommand('downloadBrowserModel');
      assertReady(downloaded.status, 'litertlm', browserSelection.selection.revision);
    } else assertReady(browserSelection.status, 'litertlm', browserSelection.selection.revision);
    byId('progress').hidden = true; byId('progressText').textContent = '';
    let browserIdentity = await identityFor('litertlm', browserSelection.selection.revision);
    record('browser_setup', 'passed', { identity: browserIdentity, explicitDownloadAuthorizedBytes: 2_008_432_640 });
    currentPhase = 'browser_smoke'; state('Browser: three fixed synthetic smoke cases…');
    const browserCases = []; for (const testCase of CASES) browserCases.push(await infer(browserIdentity, testCase));
    record('browser_smoke', 'passed', { identity: browserIdentity, cases: browserCases });
    await idleAndWake(browserIdentity);
    currentPhase = 'to_native'; await openPopup(true);
    const nativeSelection = await select('ollama', browserIdentity.selectionRevision);
    record('to_native', 'passed', { fromRevision: browserIdentity.selectionRevision, toRevision: nativeSelection.selection.revision });
    await pauseForNativeConnect(nativeSelection.selection);
    let nativeIdentity = await identityFor('ollama', nativeSelection.selection.revision);
    currentPhase = 'native_smoke'; state('Ollama: three fixed synthetic smoke cases. The first request may load weights…');
    const nativeCases = []; for (const testCase of CASES) nativeCases.push(await infer(nativeIdentity, testCase));
    record('native_smoke', 'passed', { identity: nativeIdentity, cases: nativeCases });
    await idleAndWake(nativeIdentity);
    nativeIdentity = await initializationRetirement(nativeIdentity);
    // Prove that retiring Browser work left native generation available before
    // taking the other switching direction. No native-interruption scenario.
    await infer(nativeIdentity, CASES[2]);
    currentPhase = 'to_browser'; await openPopup();
    const browserAgain = await select('litertlm', nativeIdentity.selectionRevision);
    browserIdentity = await identityFor('litertlm', browserAgain.selection.revision);
    const switchedBrowser = await infer(browserIdentity, CASES[1]);
    record('to_browser', 'passed', { identity: browserIdentity, result: switchedBrowser });
    currentPhase = 'return_native';
    const nativeAgain = await select('ollama', browserIdentity.selectionRevision);
    closePopup(); nativeIdentity = await identityFor('ollama', nativeAgain.selection.revision);
    const switchedNative = await infer(nativeIdentity, CASES[0]);
    record('return_native', 'passed', { identity: nativeIdentity, result: switchedNative });
    report.status = report.phases.some(phase => phase.status === 'inconclusive') ? 'inconclusive' : 'passed';
    state(report.status === 'passed' ? 'Development acceptance passed. Production final checks remain pending. Export the report; the page will stay available.'
      : 'The finite run completed with an inconclusive boundary. Export the report; production final checks remain pending.');
  } catch (error) {
    const code = error instanceof AcceptanceFault ? error.code : 'runner_failed';
    report.status = unsafeNative || inconclusiveCodes.has(code) ? 'inconclusive' : 'failed';
    if (!report.phases.some(phase => phase.id === currentPhase && phase.code === code)) record(currentPhase, report.status, error?.details ?? {}, code);
    state(unsafeNative ? 'Stopped: native settlement is uncertain or recovery is required. Preserve this profile and export the report. Do not restart, recover, switch or submit more work here.'
      : `Run ${report.status}. Export the report and preserve the evidence for review. No cleanup or replacement generation will run.`);
  } finally {
    // No unload or recovery in finally: automatic lifecycle is what was tested.
    quiet = false; loadingObserver = null; detachProgress();
    if (relay && !relay.pending.size) closePopup();
    continueGate = null; byId('continue').hidden = true; byId('finish').hidden = true; byId('instruction').hidden = true;
    running = false; report.terminal = true; report.completedAt = new Date().toISOString();
    try { persist(); } catch { report.safeToCleanup = false; state('Report persistence failed. Keep this page open and export the JSON evidence.'); }
    render();
  }
}

function savedLedger(value) {
  const safety = restoreSafetyLedger(value, config.runId);
  unsafeNative = safety.nativeUncertain;
  const phases = Array.isArray(value.phases) ? value.phases.slice(0, 30).filter(phase => labels[phase?.id]
    && ['passed', 'failed', 'inconclusive'].includes(phase.status)).map(phase => ({ id: phase.id, status: phase.status,
      at: validTime(phase.at), details: { priorSummaryOnly: true } })) : [];
  // A reload never resumes controls or trusts saved content as request input.
  return { schemaVersion: 1, runId: config.runId, status: 'inconclusive', terminal: true,
    ...safety,
    startedAt: validTime(value.startedAt), completedAt: new Date().toISOString(), sourceReceipt: config,
    modelPins: PINS, phases: [...phases, { id: 'interruption', status: 'inconclusive',
      code: 'reloaded_run_cannot_resume', at: new Date().toISOString(), details: {} }] };
}
async function init() {
  if (location.pathname !== '/benchmark.html' || location.search || location.hash) fault('runner_location_invalid');
  const response = await fetch('acceptance-config.json', { credentials: 'omit', redirect: 'error', cache: 'no-store' });
  if (!response.ok) fault('source_receipt_unavailable');
  const text = await response.text(); if (text.length > 100_000) fault('source_receipt_invalid');
  config = sanitizeReceipt(JSON.parse(text)); ledgerKey = `bouncer.acceptance.v1.${config.runId}`;
  byId('receipt').textContent = `Run ${config.runId} · Chrome for Testing ${config.browser.version} · source ${config.source.commit} · production tree ${config.production.treeSha256} · development tree ${config.development.treeSha256}`;
  const stored = localStorage.getItem(ledgerKey);
  if (stored) {
    try {
      if (stored.length > 100_000) fault('saved_ledger_invalid');
      report = savedLedger(JSON.parse(stored));
    } catch {
      unsafeNative = true;
      report = { schemaVersion: 1, runId: config.runId, status: 'inconclusive', terminal: true,
        pendingRequests: 1, safeToCleanup: false, nativeUncertain: true, nativeEverAttempted: true,
        startedAt: null, completedAt: new Date().toISOString(), sourceReceipt: config, modelPins: PINS,
        phases: [{ id: 'interruption', status: 'inconclusive', at: new Date().toISOString(), code: 'saved_ledger_invalid', details: {} }] };
    }
    persist(); prepared = true; render();
    state(unsafeNative ? 'This run was reloaded with uncertain work. It cannot resume. Preserve the profile and export the summary; cleanup is blocked.'
      : 'This run was reloaded. Its quiet interval and detailed runtime evidence cannot be resumed. Export the inconclusive summary.');
  } else { prepared = true; state('Ready for the finite synthetic development acceptance run.'); controls(); }
}
byId('start').addEventListener('click', () => { void run(); });
for (const id of ['otherClientsIdle', 'quietReady']) byId(id).addEventListener('change', controls);
byId('export').addEventListener('click', () => {
  if (quiet || !report?.terminal) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `bouncer-acceptance-report-${config.runId}.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('resume', () => { if (running) lifecycleInterrupted = true; });
window.addEventListener('pageshow', event => { if (running && event.persisted) lifecycleInterrupted = true; });
void init().catch(() => { prepared = false; state('The prepared receipt or saved safety ledger could not be validated. Start is disabled. Preserve this profile for review.'); controls(); });
