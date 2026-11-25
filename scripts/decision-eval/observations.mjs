import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const isPid = value => Number.isSafeInteger(value) && value > 0;
const isBytes = value => Number.isSafeInteger(value) && value >= 0;

function completeSample(sample) {
  if (!sample || sample.complete !== true || !Number.isFinite(sample.time)
      || !isPid(sample.rootPid) || !Array.isArray(sample.processes) || !sample.processes.length
      || !isBytes(sample.footprintBytes) || !isBytes(sample.rssBytes)
      || sample.footprintBytes === 0 || sample.rssBytes === 0) return false;
  const byPid = new Map();
  for (const process of sample.processes) {
    if (!process || !isPid(process.pid) || byPid.has(process.pid)
        || !(process.parentPid === null || isPid(process.parentPid))
        || typeof process.startIdentity !== 'string' || !/^[1-9]\d*$/.test(process.startIdentity)
        || !isBytes(process.footprintBytes) || !isBytes(process.rssBytes)) return false;
    byPid.set(process.pid, process);
  }
  if (byPid.get(sample.rootPid)?.parentPid !== null) return false;
  for (const process of sample.processes) {
    let pid = process.pid;
    const seen = new Set();
    while (pid !== sample.rootPid) {
      if (seen.has(pid) || !byPid.has(pid)) return false;
      seen.add(pid);
      pid = byPid.get(pid).parentPid;
    }
  }
  return sample.processes.reduce((total, process) => total + process.footprintBytes, 0) === sample.footprintBytes
    && sample.processes.reduce((total, process) => total + process.rssBytes, 0) === sample.rssBytes;
}

/** Start only the observer child. Closing it never signals a serving process. */
export async function startMemorySampler(port, { spawnProcess = spawn, baselineTimeoutMs = 3000 } = {}) {
  if (![9931, 11434].includes(port)) throw new Error('Memory sampler port must be 9931 or 11434');
  if (!Number.isFinite(baselineTimeoutMs) || baselineTimeoutMs <= 0) throw new Error('Invalid baseline timeout');
  const child = spawnProcess('python3', [
    '-B', fileURLToPath(new URL('./memory.py', import.meta.url)),
    '--port', String(port), '--interval', '.2',
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const samples = [];
  let closing = false;
  let closed = false;
  let closePromise;
  let ready = false;
  let accept;
  let reject;
  const baseline = new Promise((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
  const exited = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  const timer = setTimeout(() => reject(new Error('No complete memory baseline samples before timeout')), baselineTimeoutMs);
  child.stdin.on('error', () => {});
  child.stderr.resume(); // Drain diagnostics without retaining command lines or arbitrary stderr.
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let sample;
    try { sample = JSON.parse(line); } catch {
      reject(new Error('Memory sampler emitted invalid JSON'));
      samples.push({ time: Date.now(), complete: false, error: 'invalid_sampler_json' });
      return;
    }
    if (!sample || !Number.isFinite(sample.time)) {
      reject(new Error('Memory sampler emitted an invalid timestamp'));
      samples.push({ time: Date.now(), complete: false, error: 'invalid_sampler_timestamp' });
      return;
    }
    if (sample.complete && !completeSample(sample)) {
      sample = { time: sample.time, complete: false, error: 'invalid_complete_sample' };
    }
    samples.push(sample);
    if (completeSample(sample) && !ready) {
      ready = true;
      clearTimeout(timer);
      accept();
    }
  });
  child.once('error', () => reject(new Error('Memory sampler could not start')));
  child.once('close', () => {
    clearTimeout(timer);
    if (!ready) reject(new Error('Memory sampler exited without complete baseline samples'));
    if (!closing && ready) samples.push({ time: Date.now(), complete: false, error: 'sampler_exited' });
  });
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(timer);
    closePromise = (async () => {
      child.stdin.end();
      // EOF normally ends the sampler immediately. These signals target only
      // this observer PID if a failed system query prevents a prompt exit.
      const terminate = setTimeout(() => { if (!closed) child.kill('SIGTERM'); }, 1200);
      const kill = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2200);
      try { await exited; } finally { clearTimeout(terminate); clearTimeout(kill); lines.close(); }
    })();
    return closePromise;
  };
  try { await baseline; } catch (error) { await close(); throw error; }
  return { samples, close };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Peaks use complete simultaneous tree sums; incomplete readings never become zero. */
export function summarizeMemory(samples, startMs, endMs) {
  if (!Array.isArray(samples) || samples.some(sample => !sample || !Number.isFinite(sample.time))
      || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new Error('Memory summary requires timestamped samples and an ordered finite window');
  }
  const selected = samples.filter(sample => sample.time >= startMs && sample.time <= endMs);
  const complete = selected.filter(completeSample).sort((left, right) => left.time - right.time);
  const footprint = complete.map(sample => sample.footprintBytes);
  const rss = complete.map(sample => sample.rssBytes);
  const points = [startMs, ...complete.map(sample => sample.time), endMs];
  return {
    sampleCount: complete.length,
    incompleteCount: selected.length - complete.length,
    medianFootprintBytes: median(footprint),
    peakFootprintBytes: footprint.length ? Math.max(...footprint) : null,
    medianRssBytes: median(rss),
    peakRssBytes: rss.length ? Math.max(...rss) : null,
    // Missing complete readings and both window edges count toward coverage.
    maxSampleGapMs: Math.max(0, ...points.slice(1).map((point, index) => point - points[index])),
  };
}

async function command(file, args) {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: 2500, maxBuffer: 128 * 1024 });
    return { available: true, raw: stdout.trim() };
  } catch (error) {
    return { available: false, error: typeof error.code === 'string' ? error.code : 'query_unavailable' };
  }
}

/** Fixed read-only host queries; chip/RAM may retain explicit supplied provenance. */
export async function environment({ query = command } = {}) {
  const [chipRead, ramRead, power, memoryPressure, vmStat] = await Promise.all([
    query('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
    query('/usr/sbin/sysctl', ['-n', 'hw.memsize']),
    query('/usr/bin/pmset', ['-g', 'batt']),
    query('/usr/bin/memory_pressure', ['-Q']),
    query('/usr/bin/vm_stat', []),
  ]);
  const chip = chipRead.available && chipRead.raw
    ? { name: chipRead.raw, provenance: 'measured:sysctl machdep.cpu.brand_string' }
    : { name: 'Apple M5 Pro', provenance: 'user-supplied' };
  const sysctlRam = ramRead.available && /^\d+$/.test(ramRead.raw) ? Number(ramRead.raw) : null;
  const pressureRam = memoryPressure.available ? Number(memoryPressure.raw.match(/system has\s+(\d+)/i)?.[1]) : null;
  const ram = Number.isSafeInteger(sysctlRam) && sysctlRam > 0
    ? { bytes: sysctlRam, provenance: 'measured:sysctl hw.memsize' }
    : Number.isSafeInteger(pressureRam) && pressureRam > 0
      ? { bytes: pressureRam, provenance: 'measured:memory_pressure -Q' }
      : { bytes: 64 * 1024 ** 3, provenance: 'user-supplied' };
  return {
    time: Date.now(),
    host: { platform: os.platform(), architecture: os.arch(), nodeVersion: process.version },
    chip,
    ram,
    loadAverage: os.loadavg(),
    power: power.available ? { ...power, raw: power.raw.replace(/\bid=\d+\b/g, 'id=redacted') } : power,
    memoryPressure,
    vmStat,
  };
}
