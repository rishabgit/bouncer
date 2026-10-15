#!/usr/bin/env node
// Operator-only macOS preparation. This file is never imported by the extension.
// Ollama 0.40.3 reads OLLAMA_ORIGINS from its environment, not server.json.
// https://github.com/ollama/ollama/blob/v0.40.3/envconfig/config.go
// The app's browser-access checkbox permits '*'; do not use it for this setup.
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_ORIGIN = 'chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm';
export const LABEL = 'local.bouncer.ollama-origins';
export const QUALIFIED_OLLAMA_VERSION = '0.40.3';
export const PINNED_MODEL = 'sha256:fbc40c82cb8acd3f63077d417d6040a42b5aeac406ed078fa8ba888fb38cfc19';
export const PINNED_WEIGHT = '3646b4c147cd235a44d91df1546d3b7d8e29b547dbe4e1f80856419aa455e6fd';
export const PREDECESSOR_SCRIPT_HASH = '557d1d76052a35427b96c6bdf023272eca982c49c5ceb8831467dc989dac2c30';
export const CORRECTED_PREDECESSOR_SCRIPT_HASH = '12b988be0ac15a7417deb7a0617d0da93587f7723626f28296c60b0199a3bd26';
export const STARTUP_DEADLINE_MS = 20000;
export const REQUEST_TIMEOUT_MS = 2000;
const METADATA_BODY_BYTES = 256 * 1024;
const OLLAMA_URL = 'http://127.0.0.1:11434';
const OWNER = 'bouncer-macos-ollama-origins-v1';
const digest = text => createHash('sha256').update(text).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

export const HELP_TEXT = `Usage: node scripts/macos-ollama-setup.mjs [action] [options]

Actions:
  --help, -h         Show this help without reading or changing native state.
  --prepare          Write review artifacts under .macos-ollama-setup-review
                     (default action). No native configuration is changed.
  --install          Install the owned launcher after reviewing --prepare.
                     Requires --mode manual or --mode login-hook,
                     --confirm-origin-setup and --confirm-ollama-stopped.
                     In login-hook mode, writes files; register the LaunchAgent
                     separately using the operator procedure in docs/models.md.
  --launch           Launch through an existing owned setup and verify metadata.
                     Requires --confirm-ollama-stopped.
  --upgrade          Update only a recognized, unchanged owned launcher and hash;
                     preserve installation identity, Node path, plist and origins.
  --uninstall        Remove unchanged owned files and restore owned origins.
                     Requires --confirm-remove-setup; does not stop Ollama.
                     Remove owned job registration separately; see docs/models.md.
  --run-login-hook   Internal one-shot action used by the installed LaunchAgent.

Options:
  --mode manual      Prepare or install a launcher used for explicit --launch.
  --mode login-hook  Prepare or install a one-shot login hook. Installation also
                     requires --confirm-login-item-disabled.
  --origins LIST     Finite comma-separated origins for --prepare review only.
                     Installation preserves the actual login-session origins.
  --confirm-origin-setup
                     Confirm exact extension-Origin rejection and reviewed setup.
  --confirm-ollama-stopped
                     Confirm clients are idle and Ollama was normally quit.
  --confirm-login-item-disabled
                     Confirm the competing com.ollama.ollama user service is
                     disabled and verified through the official UI or the narrow
                     operator launchctl override documented in docs/models.md.
                     Recheck its disabled state after the official app opens.
  --confirm-remove-setup
                     Confirm removal of the owned setup and origin restoration.

Installation and launch require macOS and the existing /Applications/Ollama.app.
The helper never disables/restores independent startup, quits the app, installs
Ollama, submits inference, downloads models or changes loopback/cloud settings.
See docs/models.md for the fixed model, operator procedure and recovery contract.
`;

export function parseOrigins(value) {
  if (value === null || value === undefined || value === '') return [];
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid origin list; no environment values were printed.');
  const entries = [...new Set(value.split(',').map(entry => entry.trim()).filter(Boolean))];
  for (const entry of entries) {
    if (entry.includes('*')) throw new Error('Wildcard origins must be resolved by the operator before exact-origin setup.');
    let url;
    try { url = new URL(entry); } catch { throw new Error('Invalid origin entry; no environment values were printed.'); }
    if (!['http:', 'https:', 'chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(url.protocol)
      || !url.hostname || url.username || url.password || url.search || url.hash
      || !['', '/'].includes(url.pathname) || /[\s'"\\]/.test(entry)) {
      throw new Error('Only finite public origins are supported; no environment values were printed.');
    }
  }
  return entries;
}

export function mergeOrigins(...values) {
  return [...new Set([...values.flatMap(parseOrigins), EXTENSION_ORIGIN])].join(',');
}

export function setupPaths(home) {
  const directory = path.join(home, 'Library', 'Application Support', 'Bouncer', 'OllamaOrigins');
  return {
    directory,
    script: path.join(directory, 'macos-ollama-setup.mjs'),
    state: path.join(directory, 'ownership.json'),
    lock: path.join(directory, '.operator-lock'),
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  };
}

export function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

export function launchAgentPlist(nodePath, scriptPath) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(scriptPath) || /[\0\r\n]/.test(nodePath + scriptPath)) throw new Error('Absolute, single-line executable paths are required.');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key><array>\n    <string>${xmlEscape(nodePath)}</string>\n    <string>${xmlEscape(scriptPath)}</string>\n    <string>--run-login-hook</string>\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><false/>\n  <key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
}

function requireMac(adapter) {
  if (adapter.platform !== 'darwin') throw new Error('Installation and launch are macOS-only; use --prepare to review elsewhere.');
}

function requireConfirmations(options) {
  if (!options.confirmOriginSetup) throw new Error('Installation requires --confirm-origin-setup after reviewing --prepare.');
  if (!options.confirmOllamaStopped) throw new Error('Quit Ollama normally after all clients are idle, then supply --confirm-ollama-stopped. The helper never quits or restarts it.');
  if (!['manual', 'login-hook'].includes(options.mode)) throw new Error('Choose --mode manual or --mode login-hook.');
  if (options.mode === 'login-hook' && !options.confirmLoginItemDisabled) {
    throw new Error('Disable the competing com.ollama.ollama user login/background service through the official UI or the narrow operator override in docs/models.md, verify its disabled state, then supply --confirm-login-item-disabled. Independent startup would race this hook.');
  }
}

function readState(adapter, paths) {
  const raw = adapter.read(paths.state);
  if (raw === null) throw new Error('No owned installation exists.');
  let state;
  try { state = JSON.parse(raw); } catch { throw new Error('Ownership state is unreadable; preserve it for operator review.'); }
  if (state.owner !== OWNER || !['manual', 'login-hook'].includes(state.mode)
    || typeof state.installation !== 'string' || !/^[a-f0-9-]{36}$/.test(state.installation)
    || typeof state.nodeExecutable !== 'string' || !path.isAbsolute(state.nodeExecutable) || /[\0\r\n]/.test(state.nodeExecutable)
    || !/^[a-f0-9]{64}$/.test(state.scriptHash ?? '')
    || state.app !== '/Applications/Ollama.app'
    || (state.mode === 'login-hook' && (!state.loginItemDisabled || !/^[a-f0-9]{64}$/.test(state.plistHash ?? '')))
    || (state.mode === 'manual' && (state.loginItemDisabled !== false || state.plistHash !== null))
    || !state.previousFiles || ['script', 'state', 'plist'].some(key => state.previousFiles[key] !== 'absent')
    || typeof state.addedOrigin !== 'boolean' || typeof state.preservedOrigins !== 'string'
    || typeof state.lastApplied !== 'string' || (state.restoreValue !== null && typeof state.restoreValue !== 'string')) throw new Error('Unknown ownership state; no changes made.');
  parseOrigins(state.preservedOrigins);
  parseOrigins(state.lastApplied);
  parseOrigins(state.restoreValue);
  if (!parseOrigins(state.lastApplied).includes(EXTENSION_ORIGIN)) throw new Error('Invalid ownership state; no changes made.');
  const script = adapter.read(paths.script);
  if (script === null || digest(script) !== state.scriptHash) throw new Error('Owned launcher changed; no changes made.');
  let plist = null;
  if (state.mode === 'login-hook') {
    plist = adapter.read(paths.plist);
    if (plist === null || digest(plist) !== state.plistHash || plist !== launchAgentPlist(state.nodeExecutable, paths.script)) throw new Error('Owned LaunchAgent changed; no changes made.');
  } else if (adapter.read(paths.plist) !== null) {
    throw new Error('Unexpected LaunchAgent occupies a manual installation; no changes made.');
  }
  return { state, raw, script, plist };
}

function withLock(adapter, paths, callback) {
  const lock = `${OWNER}\n${randomUUID()}\n`;
  adapter.write(paths.lock, lock, { exclusive: true });
  try { return callback(); } finally { adapter.remove(paths.lock, lock); }
}

async function withAsyncLock(adapter, paths, callback) {
  const lock = `${OWNER}\n${randomUUID()}\n`;
  adapter.write(paths.lock, lock, { exclusive: true });
  try { return await callback(); } finally { adapter.remove(paths.lock, lock); }
}

// Only a transient connection failure permits opening an app or startup retries.
// A responding incompatible server, HTTP 403, or malformed metadata is final.
export class StartupConnectionError extends Error {
  constructor() { super('The local Ollama startup connection is not available.'); }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function assertPinnedMetadata(value) {
  const body = record(value);
  const details = record(body.details);
  const info = record(body.model_info);
  const local = value => ['remote_host', 'remote_model'].every(key => value[key] === undefined || value[key] === null || value[key] === '');
  const lines = typeof body.modelfile === 'string' ? body.modelfile.split(/\r?\n/) : [];
  const from = lines.filter(line => /^FROM\s/i.test(line));
  const parameters = typeof body.parameters === 'string' ? body.parameters.split(/\r?\n/).map(line => line.trim()).filter(Boolean).sort() : [];
  if (!local(body) || !local(details) || details.format !== 'gguf' || details.family !== 'gemma4'
    || details.quantization_level !== 'Q4_0' || details.runner !== 'llamacpp' || details.parameter_size !== '4.6B'
    || details.parent_model !== `sha256-${PINNED_WEIGHT}` || !Array.isArray(details.families)
    || details.families.length !== 1 || details.families[0] !== 'gemma4'
    || !Array.isArray(body.capabilities) || body.capabilities.length !== 3 || body.capabilities.slice().sort().join(',') !== 'completion,thinking,tools'
    || info['general.architecture'] !== 'gemma4' || info['general.parameter_count'] !== 4628569635
    || info['gemma4.block_count'] !== 35 || info['gemma4.embedding_length'] !== 1536 || info['gemma4.context_length'] !== 131072
    || from.length !== 1 || !from[0].trim().endsWith(`sha256-${PINNED_WEIGHT}`)
    || lines.filter(line => /^RENDERER\s/i.test(line)).join('\n') !== 'RENDERER gemma4-small'
    || lines.filter(line => /^PARSER\s/i.test(line)).join('\n') !== 'PARSER gemma4'
    || lines.some(line => /^(?:ADAPTER|DRAFT|PROJECTOR)\s/i.test(line)) || body.template !== '{{ .Prompt }}'
    || parameters.length !== 3 || !parameters.some(line => /^temperature\s+1$/.test(line))
    || !parameters.some(line => /^top_k\s+64$/.test(line)) || !parameters.some(line => /^top_p\s+0\.95$/.test(line))) {
    throw new Error('The pinned classifier metadata is incompatible; preserve the running app and review model setup.');
  }
}

function deniedOrigin(origins) {
  const allowed = new Set(parseOrigins(origins).map(origin => new URL(origin).origin));
  let index = 0;
  while (allowed.has(`https://bouncer-startup-denied-${index}.invalid`)) index++;
  return `https://bouncer-startup-denied-${index}.invalid`;
}

function remainingTime(adapter, deadline) {
  const remaining = deadline - adapter.now();
  if (remaining <= 0) throw new Error('Ollama metadata readiness exceeded the 20-second startup deadline; preserve the installation and inspect the existing app.');
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

async function probeReadiness(adapter, origins, deadline) {
  const request = (apiPath, origin) => adapter.request(apiPath, {
    ...(apiPath === '/api/show' ? { body: { model: PINNED_MODEL }, origin } : {}),
    timeoutMs: remainingTime(adapter, deadline),
  });
  const version = await request('/api/version');
  if (version.status !== 200) throw new Error('The local server rejected runtime metadata; preserve the existing app and review startup.');
  if (record(version.body).version !== QUALIFIED_OLLAMA_VERSION) throw new Error(`The local server is not qualified Ollama ${QUALIFIED_OLLAMA_VERSION}; preserve the existing app and review setup.`);
  const permitted = await request('/api/show', EXTENSION_ORIGIN);
  if (permitted.status === 403) throw new Error('Ollama rejects the exact extension Origin. Disable the competing Ollama login/background startup, then normally quit the app after clients are idle and launch this helper again. The helper will not quit or restart the app.');
  if (permitted.status !== 200) throw new Error('The local server did not return the pinned classifier metadata; review model setup.');
  assertPinnedMetadata(permitted.body);
  const denied = await request('/api/show', deniedOrigin(origins));
  if (denied.status !== 403) throw new Error('Ollama did not reject an Origin outside the finite union; review native origin settings before continuing.');
  remainingTime(adapter, deadline);
}

async function existingReadiness(adapter, origins, deadline) {
  try { await probeReadiness(adapter, origins, deadline); return true; }
  catch (error) { if (error instanceof StartupConnectionError) return false; throw error; }
}

async function waitForReadiness(adapter, origins, deadline) {
  for (;;) {
    try { await probeReadiness(adapter, origins, deadline); return; }
    catch (error) {
      if (!(error instanceof StartupConnectionError)) throw error;
      const delay = Math.min(250, remainingTime(adapter, deadline));
      await adapter.sleep(delay);
    }
  }
}

function openApp(adapter, app, origins) {
  // LaunchServices does not reliably inherit GUI launchctl changes when an
  // independent startup already spawned the app. Give the fresh launch its env.
  adapter.run('/usr/bin/open', ['--env', `OLLAMA_ORIGINS=${origins}`, '-a', app]);
}

function setEnvironment(adapter, value) {
  // Pass literal values as argv; never interpolate origins into shell code.
  adapter.run('/bin/launchctl', value === null ? ['unsetenv', 'OLLAMA_ORIGINS'] : ['setenv', 'OLLAMA_ORIGINS', value]);
}

function rollbackEnvironment(adapter, expected, previous) {
  if (adapter.getOrigins() !== expected) throw new Error('Origin environment changed during setup; it was preserved for operator review.');
  setEnvironment(adapter, previous);
}

function rollbackBeforeOpen(adapter, applied, previous) {
  const current = adapter.getOrigins();
  if (current === previous) return;
  rollbackEnvironment(adapter, applied, previous);
}

export function prepareSetup(adapter, options = {}) {
  const paths = setupPaths(adapter.home);
  const mode = options.mode ?? 'manual';
  if (!['manual', 'login-hook'].includes(mode)) throw new Error('Choose --mode manual or --mode login-hook.');
  const directory = path.resolve(adapter.cwd, '.macos-ollama-setup-review');
  const preview = {
    owner: OWNER, reviewOnly: true, mode, exactOrigin: EXTENSION_ORIGIN,
    previewOrigins: mergeOrigins(options.origins ?? null),
    installedPaths: paths, existingApp: '/Applications/Ollama.app', nodeExecutable: adapter.nodePath,
    prerequisites: [
      'Confirm the actual Chrome service-worker metadata POST is rejected for its Origin.',
      'Preserve the existing loopback binding and cloud-disabled setting; this helper does not edit server.json.',
      'Quit Ollama normally only after every client has finished work; no forced quit or restart is performed.',
      ...(mode === 'login-hook' ? ['Disable the competing com.ollama.ollama user login/background service through the official UI or the narrow operator override in docs/models.md; verify it is disabled before installation and remains disabled after the official app opens.', 'Keep the selected existing Node executable available at its absolute path.'] : []),
    ],
    behavior: 'Preserve finite existing origins and append the exact extension origin. A responding server must pass qualified runtime and pinned metadata Origin checks. Otherwise explicitly pass the finite union through open --env to the existing official app and verify metadata within 20 seconds. Login-hook installation writes files but does not register the LaunchAgent; follow docs/models.md for registration. The registered login hook runs once and exits; it installs no daemon, proxy, inference, or heartbeat.',
    uninstall: 'Remove only unchanged owned files and undo only the known owned origin addition. Other origin entries are retained. Independent login/background startup is never edited or automatically restored.',
  };
  adapter.mkdir(directory);
  adapter.write(path.join(directory, 'preview.json'), json(preview), { exclusive: true });
  adapter.write(path.join(directory, 'macos-ollama-setup.mjs'), adapter.sourceText, { exclusive: true });
  if (mode === 'login-hook') adapter.write(path.join(directory, `${LABEL}.plist`), launchAgentPlist(adapter.nodePath, paths.script), { exclusive: true });
  return { action: 'prepared', directory, mode, note: 'Review artifacts only; no native configuration, environment, independent login/background startup, or application was changed.' };
}

export async function installSetup(adapter, options) {
  requireMac(adapter);
  requireConfirmations(options);
  const paths = setupPaths(adapter.home);
  // Never adopt or overwrite an existing file, even if it uses our label.
  for (const file of [paths.state, paths.script, paths.plist, paths.lock]) {
    if (adapter.read(file) !== null) throw new Error('A setup path is already occupied; no existing file was overwritten.');
  }
  if (!adapter.appExists('/Applications/Ollama.app')) throw new Error('The existing official /Applications/Ollama.app is required; nothing is installed or downloaded.');
  const previous = adapter.getOrigins();
  const existing = parseOrigins(previous);
  const applied = existing.includes(EXTENSION_ORIGIN) ? previous : mergeOrigins(previous);
  const deadline = adapter.now() + STARTUP_DEADLINE_MS;
  const ready = await existingReadiness(adapter, applied, deadline);
  const plist = options.mode === 'login-hook' ? launchAgentPlist(adapter.nodePath, paths.script) : null;
  const state = {
    owner: OWNER, installation: randomUUID(), mode: options.mode, app: '/Applications/Ollama.app',
    nodeExecutable: adapter.nodePath, scriptHash: digest(adapter.sourceText),
    plistHash: plist === null ? null : digest(plist),
    loginItemDisabled: options.mode === 'login-hook',
    previousFiles: { script: 'absent', state: 'absent', plist: 'absent' },
    preservedOrigins: existing.join(','), addedOrigin: !existing.includes(EXTENSION_ORIGIN),
    lastApplied: applied, restoreValue: previous,
  };
  adapter.mkdir(paths.directory);
  if (plist !== null) adapter.mkdir(path.dirname(paths.plist));
  return withAsyncLock(adapter, paths, async () => {
    const created = [];
    let environmentAttempted = false;
    let openAttempted = false;
    try {
      for (const [file, content] of [[paths.script, adapter.sourceText], ...(plist === null ? [] : [[paths.plist, plist]]), [paths.state, json(state)]]) {
        adapter.write(file, content, { exclusive: true });
        created.push([file, content]);
      }
      if (adapter.getOrigins() !== previous) throw new Error('Origin environment changed during preparation; retry after reviewing its current state.');
      environmentAttempted = true;
      setEnvironment(adapter, applied);
      if (!ready) {
        openAttempted = true;
        openApp(adapter, state.app, applied);
        await waitForReadiness(adapter, applied, deadline);
      }
      return { action: 'installed', mode: state.mode, script: paths.script, plist: plist === null ? null : paths.plist, opened: !ready, note: `Qualified runtime and pinned metadata verified: exact extension Origin accepted and an Origin outside the finite union rejected. Verify Chrome worker readiness separately. ${plist === null ? '' : 'Login-hook files were written; register the LaunchAgent separately using docs/models.md. '}The helper does not alter independent login/background startup.` };
    } catch (error) {
      // Even nonzero open status cannot prove the application never started.
      // Preserve the applied environment and ownership evidence after attempt.
      if (openAttempted) throw new Error(`${error.message} App startup was attempted; the applied origins and owned installation were preserved for operator review. No app was stopped.`);
      if (environmentAttempted) rollbackBeforeOpen(adapter, applied, previous);
      for (const [file, content] of created.reverse()) adapter.remove(file, content);
      throw error;
    }
  });
}

export async function launchSetup(adapter, options = {}) {
  requireMac(adapter);
  const paths = setupPaths(adapter.home);
  return withAsyncLock(adapter, paths, async () => {
    const { state, raw } = readState(adapter, paths);
    if (options.loginHook) {
      if (state.mode !== 'login-hook' || !state.loginItemDisabled) throw new Error('This installation does not own login startup.');
    } else if (!options.confirmOllamaStopped) {
      throw new Error('Quit Ollama normally after all clients are idle, then supply --confirm-ollama-stopped. No restart is performed.');
    }
    if (!adapter.appExists(state.app)) throw new Error('The existing official Ollama app is missing; no replacement is installed.');
    const previous = adapter.getOrigins();
    parseOrigins(previous);
    const applied = mergeOrigins(state.preservedOrigins, previous);
    const deadline = adapter.now() + STARTUP_DEADLINE_MS;
    const ready = await existingReadiness(adapter, applied, deadline);
    const restoreEntries = parseOrigins(applied).filter(origin => !state.addedOrigin || origin !== EXTENSION_ORIGIN);
    const next = {
      ...state, lastApplied: applied,
      restoreValue: previous === state.lastApplied ? state.restoreValue
        : restoreEntries.length ? restoreEntries.join(',') : null,
    };
    // Validate before the first mutation, including an unexpected existing '*'.
    adapter.write(paths.state, json(next), { expected: raw });
    let environmentAttempted = false;
    let openAttempted = false;
    try {
      if (adapter.getOrigins() !== previous) throw new Error('Origin environment changed during launch; no app was opened.');
      environmentAttempted = true;
      setEnvironment(adapter, applied);
      if (!ready) {
        openAttempted = true;
        openApp(adapter, state.app, applied);
        await waitForReadiness(adapter, applied, deadline);
      }
    } catch (error) {
      if (openAttempted) throw new Error(`${error.message} App startup was attempted; the applied origins and ownership evidence were preserved for operator review. No app was stopped.`);
      if (environmentAttempted) rollbackBeforeOpen(adapter, applied, previous);
      adapter.write(paths.state, raw, { expected: json(next) });
      throw error;
    }
    return { action: ready ? 'ready' : 'opened', note: 'Qualified runtime and pinned metadata verified: exact extension Origin accepted and an Origin outside the finite union rejected. Verify the actual Chrome worker separately. No inference was submitted.' };
  });
}

export function upgradeSetup(adapter) {
  requireMac(adapter);
  const paths = setupPaths(adapter.home);
  return withLock(adapter, paths, () => {
    const { state, raw, script } = readState(adapter, paths);
    const nextHash = digest(adapter.sourceText);
    if (![PREDECESSOR_SCRIPT_HASH, CORRECTED_PREDECESSOR_SCRIPT_HASH, nextHash].includes(state.scriptHash)) {
      throw new Error('Owned launcher is not the recognized predecessor or current source; no upgrade performed.');
    }
    if (state.scriptHash === nextHash) return { action: 'up-to-date', note: 'Owned launcher already matches this source. No native setting or app was changed.' };
    const nextRaw = json({ ...state, scriptHash: nextHash });
    // Each replacement is compare-and-swap guarded. The pair is not atomic:
    // a crash between writes leaves a hash mismatch that fails closed.
    adapter.write(paths.script, adapter.sourceText, { expected: script });
    try { adapter.write(paths.state, nextRaw, { expected: raw }); }
    catch {
      if (adapter.read(paths.script) !== adapter.sourceText || adapter.read(paths.state) !== raw) {
        throw new Error('Upgrade ownership update failed and concurrent edits were preserved. Launcher and ownership may disagree; preserve both files for explicit operator recovery.');
      }
      try { adapter.write(paths.script, script, { expected: adapter.sourceText }); }
      catch { throw new Error('Upgrade ownership update failed and launcher rollback was interrupted; preserve both files for explicit operator recovery.'); }
      throw new Error('Upgrade ownership update failed; the known predecessor was restored. No native setting or app was changed.');
    }
    return { action: 'upgraded', note: 'Only the owned launcher and its ownership hash were updated. Existing installation identity, Node path, origins and LaunchAgent were preserved. No native setting or app was changed.' };
  });
}

export function uninstallSetup(adapter, options = {}) {
  requireMac(adapter);
  if (!options.confirmRemoveSetup) throw new Error('Uninstall requires --confirm-remove-setup. It never quits Ollama.');
  const paths = setupPaths(adapter.home);
  return withLock(adapter, paths, () => {
    const { state, raw, script, plist } = readState(adapter, paths);
    if (adapter.getOrigins() !== state.lastApplied) throw new Error('Origin environment changed outside this helper; preserve the installation for operator review.');
    setEnvironment(adapter, state.restoreValue);
    try {
      if (state.mode === 'login-hook') adapter.remove(paths.plist, plist);
      adapter.remove(paths.script, script);
      adapter.remove(paths.state, raw);
    } catch {
      throw new Error('Origin restoration completed, but owned file removal was interrupted; preserve remaining files for operator review.');
    }
    return { action: 'uninstalled', note: 'Known owned origins/startup files removed. No app was stopped. An already running app retains its old environment until a later normal launch. Remove any owned job registration separately using docs/models.md. Independent login/background startup was never edited; restore it manually after removing this hook if desired. A completed one-shot job may remain registered until logout, but has no KeepAlive or scheduled rerun.' };
  });
}

class MetadataRequestError extends Error {}

export async function nativeMetadataRequest(apiPath, options, fetchImplementation = globalThis.fetch) {
  if (!['/api/version', '/api/show'].includes(apiPath)
    || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > REQUEST_TIMEOUT_MS
    || (apiPath === '/api/show' && (options.body?.model !== PINNED_MODEL || Object.keys(options.body).length !== 1
      || parseOrigins(options.origin).length !== 1))
    || (apiPath === '/api/version' && (options.body !== undefined || options.origin !== undefined))) {
    throw new Error('Invalid fixed metadata request; no supplied values were printed.');
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MetadataRequestError('The local metadata request exceeded its bounded timeout; preserve the existing app and inspect startup.'));
    }, options.timeoutMs);
  });
  const work = (async () => {
    let response;
    try {
      response = await fetchImplementation(`${OLLAMA_URL}${apiPath}`, {
        method: apiPath === '/api/show' ? 'POST' : 'GET',
        ...(apiPath === '/api/show' ? { headers: { 'Content-Type': 'application/json', Origin: options.origin }, body: JSON.stringify(options.body) } : {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
    } catch (error) {
      if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(error?.cause?.code)) throw new StartupConnectionError();
      throw new MetadataRequestError('The fixed loopback metadata request failed; no response or environment values were printed.');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, body: null };
    }
    if (!response.body) throw new MetadataRequestError('Ollama returned empty metadata.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > METADATA_BODY_BYTES) throw new MetadataRequestError('Ollama metadata exceeded the bounded response size.');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      let body;
      try { body = JSON.parse(text); }
      catch { throw new MetadataRequestError('Ollama returned invalid metadata JSON; no response was printed.'); }
      return { status: response.status, body };
    } catch (error) {
      if (!(error instanceof MetadataRequestError)) throw new MetadataRequestError('Ollama returned invalid metadata bytes; no response was printed.');
      throw error;
    } finally {
      // No response text, status body, or error from the stream is logged.
      void reader.cancel().catch(() => {});
    }
  })();
  try { return await Promise.race([work, timeout]); }
  catch (error) {
    if (error instanceof StartupConnectionError || error instanceof MetadataRequestError) throw error;
    throw new MetadataRequestError('The fixed loopback metadata request failed; no response or environment values were printed.');
  }
  finally { clearTimeout(timer); controller.abort(); }
}

export function nativeAdapter() {
  const sourcePath = fileURLToPath(import.meta.url);
  function checkParents(file) {
    const parent = path.dirname(file);
    if (parent !== file) checkParents(parent);
    let stat;
    try { stat = fs.lstatSync(parent); } catch (error) { if (error.code === 'ENOENT') return; throw new Error('Unable to inspect setup directory.'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Setup parent directories must not be symlinks.');
  }
  function read(file) {
    checkParents(file);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Unable to inspect setup file.'); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Setup files must be regular files, never symlinks.');
    return fs.readFileSync(file, 'utf8');
  }
  function mkdir(directory) {
    const parent = path.dirname(directory);
    if (parent !== directory) mkdir(parent);
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Setup directory must be a real directory.');
      return;
    }
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  function write(file, content, { exclusive = false, expected } = {}) {
    if (!exclusive && (expected === undefined || read(file) !== expected)) throw new Error('Owned setup file changed; no overwrite performed.');
    const temporary = `${file}.tmp-${randomUUID()}`;
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    try {
      if (exclusive) fs.linkSync(temporary, file); // Atomic creation that cannot replace another file.
      else {
        if (read(file) !== expected) throw new Error('Owned setup file changed; no overwrite performed.');
        fs.renameSync(temporary, file);
      }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function run(executable, args) {
    try { execFileSync(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: REQUEST_TIMEOUT_MS, maxBuffer: 64 * 1024 }); }
    catch { throw new Error(`Operator command failed: ${path.basename(executable)}. No command output or environment values were printed.`); }
  }
  return {
    home: homedir(), cwd: process.cwd(), platform: process.platform,
    nodePath: process.execPath, sourceText: fs.readFileSync(sourcePath, 'utf8'), read, mkdir, write, run,
    now: () => performance.now(), sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    request: nativeMetadataRequest,
    remove(file, expected) {
      if (read(file) !== expected) throw new Error('Owned setup file changed; no deletion performed.');
      fs.unlinkSync(file);
    },
    appExists(app) { try { return fs.statSync(app).isDirectory(); } catch { return false; } },
    getOrigins() {
      try { return execFileSync('/bin/launchctl', ['getenv', 'OLLAMA_ORIGINS'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: REQUEST_TIMEOUT_MS, maxBuffer: 64 * 1024 }).replace(/\n$/, ''); }
      catch (error) { if (error.status === 1) return null; throw new Error('Unable to read the login-session origin setting; no changes made.'); }
    },
  };
}

export function parseArguments(args) {
  const options = {};
  const commands = new Set(['--prepare', '--install', '--launch', '--uninstall', '--upgrade', '--run-login-hook', '--help']);
  const flags = {
    '--confirm-origin-setup': 'confirmOriginSetup', '--confirm-ollama-stopped': 'confirmOllamaStopped',
    '--confirm-login-item-disabled': 'confirmLoginItemDisabled', '--confirm-remove-setup': 'confirmRemoveSetup',
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] === '-h' ? '--help' : args[index];
    if (commands.has(argument)) {
      if (options.command) throw new Error('Choose exactly one setup action.');
      options.command = argument;
    } else if (argument === '--mode' || argument === '--origins') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('A setup option value is missing.');
      if (options[argument.slice(2)] !== undefined) throw new Error('A setup option was repeated; no supplied values were printed.');
      options[argument.slice(2)] = args[++index];
    } else if (flags[argument]) options[flags[argument]] = true;
    else throw new Error('Unknown setup option; no supplied values were printed.');
  }
  options.command ??= '--prepare';
  if (options.origins !== undefined && options.command !== '--prepare') throw new Error('--origins is a review-only input; installation preserves the actual login-session setting.');
  if (options.mode !== undefined && !['manual', 'login-hook'].includes(options.mode)) throw new Error('Choose --mode manual or --mode login-hook.');
  const allowed = {
    '--help': [], '--prepare': ['mode', 'origins'],
    '--install': ['mode', 'confirmOriginSetup', 'confirmOllamaStopped', 'confirmLoginItemDisabled'],
    '--launch': ['confirmOllamaStopped'], '--upgrade': [],
    '--uninstall': ['confirmRemoveSetup'], '--run-login-hook': [],
  };
  if (Object.keys(options).some(key => key !== 'command' && !allowed[options.command].includes(key))) throw new Error('A setup option is unsupported for this action; no supplied values were printed.');
  if (options.origins !== undefined) parseOrigins(options.origins);
  if (options.command === '--install') requireConfirmations(options);
  if (options.command === '--launch' && !options.confirmOllamaStopped) throw new Error('Quit Ollama normally after all clients are idle, then supply --confirm-ollama-stopped. No restart is performed.');
  if (options.command === '--uninstall' && !options.confirmRemoveSetup) throw new Error('Uninstall requires --confirm-remove-setup. It never quits Ollama.');
  return options;
}

// Parse before constructing the native adapter; tests may inject a lazy factory.
export function main(args = process.argv.slice(2), adapter = nativeAdapter) {
  const options = parseArguments(args);
  if (options.command === '--help') return HELP_TEXT;
  if (typeof adapter === 'function') adapter = adapter();
  if (options.command === '--prepare') return prepareSetup(adapter, options);
  if (options.command === '--install') return installSetup(adapter, options);
  if (options.command === '--launch') return launchSetup(adapter, options);
  if (options.command === '--run-login-hook') return launchSetup(adapter, { loginHook: true });
  if (options.command === '--upgrade') return upgradeSetup(adapter);
  return uninstallSetup(adapter, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main();
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
