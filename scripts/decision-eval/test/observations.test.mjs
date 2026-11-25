import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { environment, startMemorySampler, summarizeMemory } from '../observations.mjs';

test('public environment omits host OS releases and stable battery identifiers', async () => {
  const calls = [];
  const observed = await environment({ query: async (file, args) => {
    calls.push([file, args]);
    if (args.includes('machdep.cpu.brand_string')) return { available: true, raw: 'Test processor' };
    if (args.includes('hw.memsize')) return { available: true, raw: '1024' };
    if (file.endsWith('/pmset')) return { available: true, raw: '-InternalBattery-0 (id=12345678) 80%; discharging' };
    return { available: false, error: 'query_unavailable' };
  } });
  assert.equal(observed.chip.name, 'Test processor');
  assert.equal(observed.ram.bytes, 1024);
  assert.equal(observed.power.raw, '-InternalBattery-0 (id=redacted) 80%; discharging');
  assert.ok(!Object.hasOwn(observed.host, 'release'));
  assert.ok(!Object.hasOwn(observed, 'macOS'));
  assert.ok(calls.every(([file]) => !file.endsWith('/sw_vers')));
});

function sample(time, pairs = [[30, 60], [70, 140]]) {
  const processes = pairs.map(([footprintBytes, rssBytes], index) => ({
    pid: 11 + index,
    parentPid: index === 0 ? null : 11,
    startIdentity: String(1000 + index),
    footprintBytes,
    rssBytes,
  }));
  return {
    time, complete: true, rootPid: 11, processes,
    footprintBytes: pairs.reduce((sum, [footprint]) => sum + footprint, 0),
    rssBytes: pairs.reduce((sum, [, rss]) => sum + rss, 0),
  };
}

function fakeSpawner(lines, { exitImmediately = false } = {}) {
  const state = { signals: [], eof: false };
  state.spawn = (command, args, options) => {
    state.command = command;
    state.args = args;
    state.options = options;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);
    };
    child.stdin.on('finish', () => { state.eof = true; queueMicrotask(finish); });
    child.kill = signal => { state.signals.push(signal); finish(); return true; };
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
      if (exitImmediately) finish();
    });
    return child;
  };
  return state;
}

test('memory peaks use simultaneous whole-tree sums rather than per-process peaks', () => {
  const result = summarizeMemory([
    sample(100, [[30, 60], [70, 140]]),
    sample(200, [[80, 160], [20, 40]]),
    sample(300, [[40, 80], [80, 160]]),
  ], 100, 300);
  assert.deepEqual(result, {
    sampleCount: 3, incompleteCount: 0,
    medianFootprintBytes: 100, peakFootprintBytes: 120,
    medianRssBytes: 200, peakRssBytes: 240,
    maxSampleGapMs: 100,
  });
});

test('window summaries count missing readings and gaps without reporting zero memory', () => {
  const incomplete = { time: 150, complete: false, footprintBytes: null, rssBytes: null, error: 'permission_denied' };
  const invalidZero = sample(300, [[0, 0]]);
  const result = summarizeMemory([sample(50), sample(100), incomplete, sample(200, [[20, 40]]), invalidZero, sample(600)], 75, 500);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.incompleteCount, 2);
  assert.equal(result.medianFootprintBytes, 60);
  assert.equal(result.medianRssBytes, 120);
  assert.equal(result.maxSampleGapMs, 300); // Last complete sample to the end of the window.
  assert.deepEqual(summarizeMemory([incomplete], 100, 400), {
    sampleCount: 0, incompleteCount: 1,
    medianFootprintBytes: null, peakFootprintBytes: null,
    medianRssBytes: null, peakRssBytes: null, maxSampleGapMs: 300,
  });
});

test('claimed-complete samples require exact totals, identities and a connected serving tree', () => {
  const wrongTotal = { ...sample(100), footprintBytes: 9999 };
  const unrelated = sample(200);
  unrelated.processes[1].parentPid = 999;
  const reusedPid = sample(300);
  reusedPid.processes[1].pid = 11;
  const result = summarizeMemory([wrongTotal, unrelated, reusedPid], 0, 400);
  assert.equal(result.sampleCount, 0);
  assert.equal(result.incompleteCount, 3);
  assert.equal(result.peakFootprintBytes, null);
  assert.throws(() => summarizeMemory([], 10, 0), /ordered finite window/);
  assert.throws(() => summarizeMemory([{ complete: false }], 0, 10), /timestamped samples/);
});

test('sampler starts unbuffered Python without bytecode and closes using stdin EOF only', async () => {
  const fake = fakeSpawner([{ time: 50, complete: false }, sample(100)]);
  const sampler = await startMemorySampler(9931, { spawnProcess: fake.spawn, baselineTimeoutMs: 100 });
  assert.equal(sampler.samples.length, 2);
  assert.equal(fake.command, 'python3');
  assert(fake.args.includes('-B'));
  assert(fake.args.includes('9931'));
  assert.equal(fake.options.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.deepEqual(fake.options.stdio, ['pipe', 'pipe', 'pipe']);
  await Promise.all([sampler.close(), sampler.close()]);
  assert.equal(fake.eof, true);
  assert.deepEqual(fake.signals, []);
});

test('sampler rejects absent, zero and incomplete baselines and cleans up its child', async () => {
  for (const lines of [[], [{ time: 100, complete: false, error: 'permission_denied' }], [sample(100, [[0, 0]])]]) {
    const fake = fakeSpawner(lines);
    await assert.rejects(startMemorySampler(11434, { spawnProcess: fake.spawn, baselineTimeoutMs: 15 }), /No complete memory baseline/);
    assert.equal(fake.eof, true);
    assert.deepEqual(fake.signals, []);
  }
  const exited = fakeSpawner([], { exitImmediately: true });
  await assert.rejects(startMemorySampler(9931, { spawnProcess: exited.spawn, baselineTimeoutMs: 100 }), /without complete baseline/);
  await assert.rejects(startMemorySampler(8080), /port must be/);
  const malformed = fakeSpawner(['not-json']);
  await assert.rejects(startMemorySampler(9931, { spawnProcess: malformed.spawn }), /invalid JSON/);
  assert.equal(malformed.eof, true);
});

test('libproc snapshot includes descendants and invalidates the aggregate on tree races', async () => {
  const script = `
import runpy, sys, types
module = runpy.run_path(sys.argv[1], run_name="memory_sampler_test")
Sampler = module["MemorySampler"]
s = Sampler.__new__(Sampler)
s.root_pid, s.root_start = 11, 101
s.listener = lambda: None
s.children = lambda pid: {11: [12], 12: [13], 13: []}[pid]
def usage(pid, expected=None):
    start = {11: 101, 12: 102, 13: 103}[pid]
    if expected is not None and expected != start:
        raise OSError("identity changed")
    return types.SimpleNamespace(proc_start_abstime=start, phys_footprint=pid * 10, resident_size=pid * 20)
s.usage = usage
good = s.snapshot()
assert good["complete"] and good["footprintBytes"] == 360 and good["rssBytes"] == 720
assert [(p["pid"], p["parentPid"], p["startIdentity"]) for p in good["processes"]] == [(11, None, "101"), (12, 11, "102"), (13, 12, "103")]
original_tree = s.tree
calls = [0]
def changed_tree():
    calls[0] += 1
    parents, starts = original_tree()
    if calls[0] == 2:
        starts[13] += 1
    return parents, starts
s.tree = changed_tree
bad = s.snapshot()
assert not bad["complete"] and bad["footprintBytes"] is None and bad["rssBytes"] is None
assert bad["processes"] == [] and bad["error"] == "incomplete_snapshot"
def denied(pid, expected=None):
    raise PermissionError(1, "permission denied")
s.usage = denied
denied_sample = s.snapshot()
assert not denied_sample["complete"] and denied_sample["footprintBytes"] is None
assert denied_sample["error"] == "permission_denied"
print("ok")
`;
  const { stdout } = await promisify(execFile)('python3', [
    '-B', '-c', script, fileURLToPath(new URL('../memory.py', import.meta.url)),
  ], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 3000 });
  assert.equal(stdout.trim(), 'ok');
});
