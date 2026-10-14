import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { extensionId, launchArguments, prepareAcceptance, treeReceipt } from './prepare-isolated-acceptance.mjs';
import { assertCleanupReport, browserIsRunning, expectedArguments, readOwnership, verifyPackage } from './isolated-acceptance-session.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = extensionId(JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'Bouncer', 'manifest.chrome.json'), 'utf8')).key);
const fakeBrowser = { executable: '/synthetic/Google Chrome for Testing', version: '155.0.8059.39' };

test('help requires no browser or native dependency and does not prepare a session', () => {
  const output = execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'prepare-isolated-acceptance.mjs'), '--help'], { encoding: 'utf8' });
  assert.match(output, /HUMAN-OPERATED/);
  assert.match(output, /never launches/);
});

test('manual launch retains mock Keychain and sandbox, isolates all profile state and uses stable origin', () => {
  assert.equal(id, 'bkijmhafoocfloemhancbgadknkgdkcm');
  const directory = '/private/tmp/bouncer-acceptance-SYNTHETIC';
  const arguments_ = launchArguments(directory, id);
  assert.deepEqual(arguments_, expectedArguments(directory, id));
  assert.ok(arguments_.includes('--use-mock-keychain'));
  assert.ok(arguments_.includes(`--user-data-dir=${directory}/profile`));
  assert.ok(arguments_.includes(`chrome-extension://${id}/benchmark.html`));
  assert.ok(arguments_.every(argument => !/remote-debugging|no-sandbox|disable-web-security|allow-insecure|password-store/.test(argument)));
});

test('cleanup refuses uncertain, pending, interrupted and unrelated reports even if models appear idle', () => {
  const ownership = { runId: 'synthetic-run' };
  const completed = { schemaVersion: 1, runId: ownership.runId, terminal: true, pendingRequests: 0, safeToCleanup: true };
  assert.doesNotThrow(() => assertCleanupReport(completed, ownership));
  for (const delta of [
    { runId: 'another-run' }, { terminal: false }, { pendingRequests: 1 }, { safeToCleanup: false },
    { safeToCleanup: undefined }, { schemaVersion: 2 },
  ]) assert.throws(() => assertCleanupReport({ ...completed, ...delta, candidateResident: false }, ownership));
});

test('process-stop check distinguishes no owned browser from inaccessible diagnostics and never kills anything', () => {
  const calls = [];
  const running = browserIsRunning('/private/tmp/bouncer-acceptance-test', (command, args) => {
    calls.push({ command, args }); return '123\n';
  });
  assert.equal(running, true);
  assert.equal(calls[0].command, '/usr/bin/pgrep');
  assert.deepEqual(calls[0].args, ['-f', 'user-data-dir=/private/tmp/bouncer-acceptance-test/profile']);
  assert.equal(browserIsRunning('/private/tmp/bouncer-acceptance-test', () => { throw { status: 1 }; }), false);
  assert.throws(() => browserIsRunning('/private/tmp/bouncer-acceptance-test', () => { throw new Error('denied'); }), /denied/);
});

test('owned package verification detects executable/config changes and symlink escapes', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bouncer-acceptance-')));
  try {
    mkdirSync(path.join(root, 'extension'));
    writeFileSync(path.join(root, 'extension', 'runner.js'), 'synthetic bytes');
    const owned = { schemaVersion: 1, kind: 'bouncer-isolated-acceptance', runId: '12345678-1234-1234-1234-123456789abc', session: root, packageTree: treeReceipt(path.join(root, 'extension')) };
    writeFileSync(path.join(root, 'ownership.json'), JSON.stringify(owned));
    assert.equal(readOwnership(root).runId, owned.runId);
    assert.doesNotThrow(() => verifyPackage(root, owned));
    writeFileSync(path.join(root, 'extension', 'runner.js'), 'changed code');
    assert.throws(() => verifyPackage(root, owned), /changed/);
    rmSync(path.join(root, 'extension', 'runner.js'));
    symlinkSync('/synthetic/outside', path.join(root, 'extension', 'runner.js'));
    assert.throws(() => verifyPackage(root, owned), /Symlinks/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preparation builds only an owned scratch copy and preserves native permissions, CSP, key and production bytes', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bouncer-acceptance-test-')));
  const temporaryRoot = path.join(root, 'temporary');
  const project = path.join(root, 'project');
  const source = path.join(project, 'Bouncer');
  mkdirSync(temporaryRoot);
  mkdirSync(source, { recursive: true });
  mkdirSync(path.join(source, 'node_modules'));
  for (const name of ['@litert-lm/core', '@litertjs/wasm-utils', '@noble/hashes', 'dompurify', 'html-to-image', 'typescript']) mkdirSync(path.join(source, 'node_modules', name), { recursive: true });
  writeFileSync(path.join(source, 'node_modules', 'typescript', 'LICENSE.txt'), 'synthetic license');
  for (const directory of ['src', 'adapters', 'icons']) mkdirSync(path.join(source, directory));
  const manifest = {
    ...JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'Bouncer', 'manifest.base.json'), 'utf8')),
    ...JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'Bouncer', 'manifest.chrome.json'), 'utf8')),
  };
  for (const filename of [
    'background.js', 'popup.js', 'content.js', 'offscreen.js', 'benchmark.js', 'setup.html', 'offscreen.html',
    'popup.css', 'content.css', 'dompurify.js', 'manifest.base.json', 'manifest.chrome.json', 'package.json', 'tsconfig.json',
  ]) writeFileSync(path.join(source, filename), 'synthetic source');
  writeFileSync(path.join(source, 'popup.html'), '<body><script src="dist/popup.js"></script></body>');
  writeFileSync(path.join(project, 'LICENSE.txt'), 'synthetic license');
  cpSync(path.join(PROJECT_ROOT, 'scripts', 'acceptance'), path.join(project, 'scripts', 'acceptance'), { recursive: true });
  copyFileSync(path.join(PROJECT_ROOT, 'scripts', 'isolated-acceptance-session.mjs'), path.join(project, 'scripts', 'isolated-acceptance-session.mjs'));
  const original = treeReceipt(source);
  const builds = [];
  let dev = false;
  try {
    const result = await prepareAcceptance({
      browser: fakeBrowser, projectRoot: project, temporaryRoot,
      buildExtension: async options => { builds.push(options); dev = options.dev; assert.notEqual(options.root, source); },
      stageExtension: (from, to) => {
        mkdirSync(path.join(to, 'dist'), { recursive: true });
        writeFileSync(path.join(to, 'dist', 'background.js'), dev ? 'synthetic dev diagnostics' : 'synthetic prod');
        writeFileSync(path.join(to, 'dist', 'popup.js'), 'synthetic popup module');
        writeFileSync(path.join(to, 'manifest.json'), JSON.stringify(manifest));
        copyFileSync(path.join(from, 'popup.html'), path.join(to, 'popup.html'));
      },
    });
    assert.equal(builds.length, 2);
    assert.deepEqual(builds.map(build => build.dev), [false, true]);
    assert.deepEqual(treeReceipt(source), original);
    assert.deepEqual(JSON.parse(readFileSync(path.join(result.session, 'extension', 'manifest.json'), 'utf8')), manifest);
    assert.deepEqual(result.receipt.development.productionDifferences, ['dist/background.js']);
    assert.ok(!readFileSync(path.join(result.session, 'Start test.command'), 'utf8').includes('open -a'));
    assert.equal(result.receipt.production.backgroundSha256, treeReceipt(path.join(result.session, 'production')).backgroundSha256);
    assert.doesNotThrow(() => verifyPackage(result.session, result.ownership));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
