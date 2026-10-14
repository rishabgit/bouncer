import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { AcceptanceFault, PINS, CASES, QUIET_MS, NATIVE_MANIFEST, assertIdentity, assertSmoke,
  summarizeContexts, assertAbsentBeforeWake, assertRecreated, createQuietSample, advanceQuiet,
  assertQuietComplete, quietWakeSequence, summarizeNativePs, readNativeResidency, sanitizeReceipt, restoreSafetyLedger } from './runner-core.mjs';

const identity = (engine = 'litertlm', revision = 4) => ({ ...PINS[engine], selectionRevision: revision });
const response = (rawResponse = '| yes | no |') => ({ ...identity(), rawResponse, shouldHide: true, wallMs: 400, inferenceTime: .3 });
const contexts = (backgroundId, offscreen = false) => summarizeContexts([
  { contextType: 'TAB', contextId: 'runner' },
  ...(backgroundId ? [{ contextType: 'BACKGROUND', contextId: backgroundId }] : []),
  ...(offscreen ? [{ contextType: 'OFFSCREEN_DOCUMENT', contextId: 'offscreen' }] : []),
]);
const beforeBrowser = contexts('worker-before', true);
const beforeNative = contexts('native-before');
const absent = contexts(null);
function fullQuiet() {
  let sample = createQuietSample(10, 10_000, true);
  for (let second = 1; second <= QUIET_MS / 1000; second++) sample = advanceQuiet(sample, 10 + second * 1000, 10_000 + second * 1000, true);
  return sample;
}
const code = expected => error => error instanceof AcceptanceFault && error.code === expected;

test('correct hide boolean cannot hide a wrong classifier, engine or selection revision', () => {
  assert.throws(() => assertSmoke({ ...response(), classifierFingerprint: PINS.ollama.classifierFingerprint }, identity(), CASES[0]), code('classifier_identity_mismatch'));
  assert.throws(() => assertSmoke({ ...response(), selectionRevision: 3 }, identity(), CASES[0]), code('selection_revision_mismatch'));
  assert.throws(() => assertIdentity({ ...identity(), weightDigest: '0'.repeat(64) }, 'litertlm'), code('classifier_identity_mismatch'));
});
test('astronomy/cooking swap is rejected even when shouldHide remains true', () => {
  assert.throws(() => assertSmoke(response('| no | yes |'), identity(), CASES[0]), code('synthetic_verdict_mismatch'));
  assert.throws(() => assertSmoke({ ...response(), shouldHide: false }, identity(), CASES[0]), code('hide_vector_mismatch'));
  assert.deepEqual(assertSmoke(response(), identity(), CASES[0]).vector, [true, false]);
});
test('full ordered labels are checked; extra prose and invented labels cannot pass', () => {
  assert.throws(() => assertSmoke(response('| cooking | yes | astronomy | no |'), identity(), CASES[0]), code('verdict_shape_invalid'));
  assert.throws(() => assertSmoke(response('Sure: | yes | no |'), identity(), CASES[0]), code('verdict_shape_invalid'));
  assert.deepEqual(assertSmoke(response('| astronomy | yes |\n| cooking | no |'), identity(), CASES[0]).vector, [true, false]);
});
test('context gate refuses presence before wake and requires new worker plus real offscreen', () => {
  assert.throws(() => assertAbsentBeforeWake(contexts('still-here')), code('idle_contexts_still_present'));
  assert.throws(() => assertRecreated(beforeBrowser, contexts('still-here'), contexts('new', true), 'litertlm'), code('idle_contexts_still_present'));
  assert.throws(() => assertRecreated(beforeBrowser, absent, beforeBrowser, 'litertlm'), code('worker_context_not_recreated'));
  assert.throws(() => assertRecreated(beforeBrowser, absent, contexts('new'), 'litertlm'), code('before_quiet_offscreen_mismatch'));
  assert.equal(assertRecreated(beforeBrowser, absent, contexts('new', true), 'litertlm'), true);
});
test('quiet accepts 120 continuous seconds and rejects hidden, sleep, clock jumps and resume', () => {
  assert.equal(assertQuietComplete(fullQuiet()), QUIET_MS);
  const start = createQuietSample(0, 100_000, true);
  assert.throws(() => assertQuietComplete(advanceQuiet(start, QUIET_MS, 100_000 + QUIET_MS, true)), code('quiet_clock_or_sleep_interrupted'));
  assert.throws(() => assertQuietComplete(advanceQuiet(start, 1000, 101_000, false)), code('quiet_hidden'));
  assert.throws(() => assertQuietComplete(advanceQuiet(start, 1000, 101_000, true, 'resume')), code('quiet_lifecycle_interrupted'));
  assert.throws(() => assertQuietComplete(advanceQuiet(start, 1000, 104_000, true)), code('quiet_clock_or_sleep_interrupted'));
  assert.throws(() => assertQuietComplete(advanceQuiet(start, 1000, 101_000, true)), code('quiet_too_short'));
});

function fakeIdle({ engine = 'litertlm', idleContexts = absent, quietSample = fullQuiet(), residentAfter = { candidateResident: false, otherResidentCount: 0 } } = {}) {
  const calls = [];
  let detached = false;
  let quiet = false;
  let contextReads = 0;
  const read = name => {
    assert.equal(quiet, false, `${name} must never execute during quiet`);
    assert.equal(detached, true, `${name} requires detached popup ports and storage listener`);
    calls.push(name);
  };
  const adapters = { engine, before: engine === 'litertlm' ? beforeBrowser : beforeNative,
    residentBefore: engine === 'ollama' ? { candidateResident: true, otherResidentCount: 0 } : null,
    detach: () => { detached = true; calls.push('detach-popup-ports-storage'); },
    quietInterval: async () => {
      assert.equal(detached, true); quiet = true;
      // Only local clock/DOM work for the whole fake 120-second interval.
      for (let second = 1; second <= 120; second++) calls.push(`local-tick-${second}`);
      quiet = false; return quietSample;
    },
    readContexts: async () => {
      read('getContexts'); contextReads++;
      return contextReads === 1 ? idleContexts : contexts('worker-after', engine === 'litertlm');
    },
    readNativePs: async () => { read('native-ps'); return residentAfter; },
    wake: async () => { read('real-uncached-infer'); return { caseId: 'wake' }; },
  };
  return { calls, adapters };
}
test('runtime coordinator closes controller surfaces, stays quiet, inspects absence, then wakes', async () => {
  const fake = fakeIdle();
  const evidence = await quietWakeSequence(fake.adapters);
  assert.equal(evidence.quietMs, 120_000);
  assert.deepEqual(fake.calls.slice(121), ['getContexts', 'real-uncached-infer', 'getContexts']);
  assert.equal(fake.calls[0], 'detach-popup-ports-storage');
  assert.ok(fake.calls.slice(1, 121).every(call => call.startsWith('local-tick-')));
});
test('surviving worker blocks all wake and metadata operations', async () => {
  const fake = fakeIdle({ engine: 'ollama', idleContexts: contexts('survivor') });
  await assert.rejects(quietWakeSequence(fake.adapters), error => {
    assert.equal(error.details.observedAfterQuiet.counts.BACKGROUND, 1);
    assert.equal(error.details.before.counts.BACKGROUND, 1);
    return code('idle_contexts_still_present')(error);
  });
  assert.deepEqual(fake.calls.slice(121), ['getContexts']);
});
test('invalid quiet interval blocks even the post-quiet extension read', async () => {
  const fake = fakeIdle({ quietSample: { ...fullQuiet(), invalid: 'quiet_hidden' } });
  await assert.rejects(quietWakeSequence(fake.adapters), error => {
    assert.equal(error.details.before.counts.OFFSCREEN_DOCUMENT, 1);
    return code('quiet_hidden')(error);
  });
  assert.ok(!fake.calls.includes('getContexts'));
  assert.ok(!fake.calls.includes('real-uncached-infer'));
});
test('native residency is read only after absence; residency extension is inconclusive without wake', async () => {
  const fake = fakeIdle({ engine: 'ollama', residentAfter: { candidateResident: true, otherResidentCount: 1 } });
  await assert.rejects(quietWakeSequence(fake.adapters), error => {
    assert.equal(error.details.residentAfter.otherResidentCount, 1);
    return code('native_residency_extended')(error);
  });
  assert.deepEqual(fake.calls.slice(121), ['getContexts', 'native-ps']);
  const success = fakeIdle({ engine: 'ollama' });
  await quietWakeSequence(success.adapters);
  assert.deepEqual(success.calls.slice(121), ['getContexts', 'native-ps', 'real-uncached-infer', 'getContexts']);
});
test('native residency summary emits no names, unrelated digests or metadata', () => {
  const privateName = 'private-owner-project-model';
  const summary = summarizeNativePs({ models: [
    { name: privateName, model: privateName, digest: 'd'.repeat(64), details: { secret: privateName } },
    { name: 'bouncer-alias', digest: NATIVE_MANIFEST },
    { name: privateName + '-2', digest: 'e'.repeat(64) },
  ] });
  assert.deepEqual(summary, { candidateResident: true, otherResidentCount: 2 });
  assert.ok(!JSON.stringify(summary).includes(privateName));
  assert.ok(!JSON.stringify(summary).includes('d'.repeat(64)));
  assert.throws(() => summarizeNativePs({ models: [{ name: privateName }] }), code('native_ps_invalid'));
});

function metadataDeadline() {
  let expire;
  let cleared = 0;
  return { timers: {
    setTimeout(callback, milliseconds) { assert.equal(milliseconds, 5000); expire = callback; return 7; },
    clearTimeout(handle) { assert.equal(handle, 7); cleared++; },
  }, expire: () => expire(), cleared: () => cleared };
}
test('fixed residency metadata GET aborts stalled headers without any generation or private error output', async () => {
  const clock = metadataDeadline();
  const pending = readNativeResidency((url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/ps');
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('synthetic private error'))));
  }, clock.timers);
  clock.expire();
  await assert.rejects(pending, code('native_ps_unavailable'));
  assert.equal(clock.cleared(), 1);
});
test('the same metadata deadline covers a stalled body and releases its reader', async () => {
  const clock = metadataDeadline();
  let reading = false; let released = false;
  const pending = readNativeResidency(async (_, options) => ({ ok: true, body: { getReader: () => ({
    read() { reading = true; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('stalled body')))); },
    releaseLock() { released = true; },
  }) } }), clock.timers);
  await Promise.resolve();
  assert.equal(reading, true);
  clock.expire();
  await assert.rejects(pending, code('native_ps_unavailable'));
  assert.equal(released, true);
  assert.equal(clock.cleared(), 1);
});
test('successful residency read cancels its metadata timer and retains only the masked summary', async () => {
  const clock = metadataDeadline();
  const value = await readNativeResidency(async () => new Response(JSON.stringify({ models: [{ name: 'synthetic hidden alias', digest: NATIVE_MANIFEST }] })), clock.timers);
  assert.deepEqual(value, { candidateResident: true, otherResidentCount: 0 });
  assert.equal(clock.cleared(), 1);
});

function receipt() {
  const hash = 'a'.repeat(64);
  return { schemaVersion: 1, runId: '11111111-1111-4111-8111-111111111111', preparedAt: '2026-10-14T00:00:00Z',
    extensionId: 'bkijmhafoocfloemhancbgadknkgdkcm', label: 'unexpected arbitrary label',
    browser: { name: 'Chrome for Testing', version: '155.0.8059.39', executableSha256: hash, mockKeychain: true, sandbox: true, debugger: false },
    source: { commit: 'a'.repeat(40), nodeVersion: 'v24.10.0', litertRuntime: '0.17.0', ollamaRuntime: '0.40.3' },
    production: { treeSha256: hash, backgroundSha256: hash, fileCount: 1, totalBytes: 4, files: [{ path: 'manifest.json', bytes: 4, sha256: hash }] },
    development: { treeSha256: hash, backgroundSha256: hash, overlayTreeSha256: hash, productionDifferences: ['dist/background.js'],
      testOverlayFiles: [{ path: 'popup-bridge.js', bytes: 4, sha256: hash }] }, privatePath: '/Users/owner/private' };
}
test('receipt records final fixture hashes and strips arbitrary source text/absolute paths', () => {
  const clean = sanitizeReceipt(receipt());
  assert.equal(clean.development.overlayTreeSha256, 'a'.repeat(64));
  assert.ok(!JSON.stringify(clean).includes('/Users/'));
  assert.ok(!JSON.stringify(clean).includes('unexpected arbitrary label'));
  const invalid = receipt(); invalid.development.testOverlayFiles[0].path = '../private';
  assert.throws(() => sanitizeReceipt(invalid), code('source_receipt_invalid'));
});
test('reload never clears native uncertainty between renderer settlement and terminal persistence', () => {
  const interrupted = { schemaVersion: 1, runId: 'run-1', pendingRequests: 0, terminal: false,
    nativeEverAttempted: true, nativeUncertain: true, safeToCleanup: false };
  assert.deepEqual(restoreSafetyLedger(interrupted, 'run-1'), { pendingRequests: 0, nativeUncertain: true,
    nativeEverAttempted: true, safeToCleanup: false });
  const missingFlag = { ...interrupted }; delete missingFlag.nativeUncertain;
  assert.equal(restoreSafetyLedger(missingFlag, 'run-1').safeToCleanup, false);
  assert.equal(restoreSafetyLedger({ ...interrupted, pendingRequests: 1, nativeUncertain: false }, 'run-1').nativeUncertain, true);
  assert.equal(restoreSafetyLedger({ ...interrupted, nativeUncertain: false }, 'run-1').safeToCleanup, true);
});

async function popupFixture(parentPath = '/benchmark.html') {
  const source = await fs.readFile(new URL('./popup-bridge.js', import.meta.url), 'utf8');
  const id = 'bkijmhafoocfloemhancbgadknkgdkcm';
  const origin = `chrome-extension://${id}`;
  const windowListeners = new Map(); const documentListeners = new Map(); const sent = [];
  let storageListener;
  const parent = { location: { href: `${origin}${parentPath}` } };
  const port = { messages: [], postMessage(value) { this.messages.push(value); }, start() {} };
  const elements = { useEngineButton: { disabled: false }, checkLocalModelStatus: { hidden: true, disabled: false }, connectNativeModel: { disabled: false } };
  const window = { parent, addEventListener(type, fn) { windowListeners.set(type, fn); } };
  const document = { body: {}, getElementById(id) { return elements[id]; }, addEventListener(type, fn) { documentListeners.set(type, fn); } };
  const chrome = { runtime: { id, async sendMessage(message) {
    sent.push(message); return { success: true, selection: { engine: message.engine ?? 'litertlm', revision: 7 },
      status: { engine: message.engine ?? 'litertlm', selectionRevision: 7, revision: 2, state: 'ready' } };
  } }, storage: { onChanged: { addListener(fn) { storageListener = fn; } } } };
  vm.runInNewContext(source, { window, document, chrome, location: { pathname: '/popup.html' }, URL, Element: class Element {}, MutationObserver: class {} });
  const token = 'a'.repeat(32);
  const hello = (overrides = {}) => windowListeners.get('message')({ source: parent, origin, ports: [port],
    data: { protocol: 'bouncer-acceptance-v1', token, allowConnect: true }, ...overrides });
  const command = request => port.onmessage({ data: { protocol: 'bouncer-acceptance-v1', token, ...request } });
  return { hello, command, port, sent, storage: (...args) => storageListener(...args), parent, origin };
}
test('popup relay rejects wrong parent/path, arbitrary endpoints, recovery and replay', async () => {
  const wrong = await popupFixture('/other.html'); wrong.hello(); assert.equal(wrong.port.onmessage, undefined);
  const fixture = await popupFixture();
  fixture.hello({ source: {} }); assert.equal(fixture.port.onmessage, undefined);
  fixture.hello();
  await fixture.command({ id: 1, command: 'selectInferenceEngine', engine: 'ollama', endpoint: 'http://other/' });
  await fixture.command({ id: 2, command: 'recoverNativeModel' });
  assert.equal(fixture.sent.length, 0);
  await fixture.command({ id: 3, command: 'selectInferenceEngine', engine: 'ollama' });
  assert.deepEqual(fixture.sent.map(message => ({ ...message })), [{ type: 'selectInferenceEngine', engine: 'ollama' }]);
  await fixture.command({ id: 3, command: 'selectInferenceEngine', engine: 'litertlm' });
  assert.equal(fixture.sent.length, 1);
});
test('popup relay permanently refuses more actions after recovery-required status', async () => {
  const fixture = await popupFixture(); fixture.hello();
  fixture.storage({ localModelStatus: { newValue: { state: 'recovery_required' } } }, 'local');
  await fixture.command({ id: 1, command: 'selectInferenceEngine', engine: 'litertlm' });
  assert.equal(fixture.sent.length, 0);
  assert.ok(fixture.port.messages.some(message => message.event === 'blocked'));
});
