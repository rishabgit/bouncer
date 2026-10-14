// Prepare a human-operated, debugger-free test session. Never launch a browser
// from this preparation command or change an installed extension/profile.
import {
  accessSync, constants, copyFileSync, cpSync, existsSync,
  mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(SCRIPT_ROOT);
const SOURCE_INPUTS = [
  'src', 'adapters', 'icons', 'background.js', 'popup.js', 'content.js',
  'offscreen.js', 'benchmark.js', 'popup.html', 'setup.html', 'offscreen.html',
  'popup.css', 'content.css', 'dompurify.js', 'manifest.base.json',
  'manifest.chrome.json', 'package.json', 'tsconfig.json',
];
const FIXTURE_FILES = ['runner.html', 'runner.css', 'runner.js', 'runner-core.mjs', 'popup-bridge.js'];
const RUNTIME_PACKAGES = ['@litert-lm/core', '@litertjs/wasm-utils', '@noble/hashes', 'dompurify', 'html-to-image'];
const LAUNCH_FLAGS = [
  '--use-mock-keychain', '--no-first-run', '--no-default-browser-check',
  '--disable-sync', '--disable-background-networking', '--disable-component-update',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`;

export function treeReceipt(directory) {
  const files = [];
  const walk = (current, prefix = '') => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Test packages must not contain symlinks.');
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative + '/');
      else if (entry.isFile()) {
        const bytes = readFileSync(path.join(current, entry.name));
        files.push({ path: relative, sha256: digest(bytes), bytes: bytes.length });
      } else throw new Error('Unsupported test package entry.');
    }
  };
  walk(directory);
  return {
    treeSha256: digest(JSON.stringify(files)),
    backgroundSha256: files.find(file => file.path === 'dist/background.js')?.sha256,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

export function extensionId(key) {
  if (typeof key !== 'string' || !key.length) throw new Error('The stable Chrome key is required.');
  return createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)));
}

export function launchArguments(session, id) {
  return [
    ...LAUNCH_FLAGS,
    `--user-data-dir=${path.join(session, 'profile')}`,
    `--disable-extensions-except=${path.join(session, 'extension')}`,
    `--load-extension=${path.join(session, 'extension')}`,
    'chrome://extensions/',
    `chrome-extension://${id}/benchmark.html`,
  ];
}

export function inspectBrowser(executable) {
  const actual = realpathSync(executable);
  accessSync(actual, constants.X_OK);
  if (path.basename(actual) !== 'Google Chrome for Testing'
      || path.basename(path.dirname(actual)) !== 'MacOS') {
    throw new Error('Choose the approved Chrome for Testing executable, not everyday Chrome.');
  }
  const plist = path.resolve(actual, '../../Info.plist');
  const read = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  if (read('CFBundleIdentifier') !== 'com.google.chrome.for.testing') {
    throw new Error('Unexpected browser bundle identity.');
  }
  return { executable: actual, version: read('CFBundleShortVersionString'), executableSha256: digest(readFileSync(actual)) };
}

export async function prepareAcceptance({
  browser, projectRoot = PROJECT_ROOT, temporaryRoot = tmpdir(),
  buildExtension, stageExtension, sourceCommit = null,
}) {
  const source = path.join(projectRoot, 'Bouncer');
  const session = mkdtempSync(path.join(temporaryRoot, 'bouncer-acceptance-'));
  const runId = randomUUID();
  const sourceCopy = path.join(session, 'build-source', 'Bouncer');
  try {
    mkdirSync(sourceCopy, { recursive: true });
    for (const relative of SOURCE_INPUTS) cpSync(path.join(source, relative), path.join(sourceCopy, relative), { recursive: true });
    copyFileSync(path.join(projectRoot, 'LICENSE.txt'), path.join(session, 'build-source', 'LICENSE.txt'));
    // Copy only the installed runtime packages, not build tools or profiles.
    // A symlink here makes esbuild emit outside-package absolute path comments,
    // which would prevent a byte-identical production receipt.
    for (const name of RUNTIME_PACKAGES) cpSync(path.join(source, 'node_modules', name), path.join(sourceCopy, 'node_modules', name), { recursive: true, dereference: true });
    mkdirSync(path.join(sourceCopy, 'node_modules', 'typescript'), { recursive: true });
    copyFileSync(path.join(source, 'node_modules', 'typescript', 'LICENSE.txt'), path.join(sourceCopy, 'node_modules', 'typescript', 'LICENSE.txt'));
    await buildExtension({ root: sourceCopy, dev: false });
    const productionPath = path.join(session, 'production');
    stageExtension(sourceCopy, productionPath);
    const production = treeReceipt(productionPath);
    await buildExtension({ root: sourceCopy, dev: true });
    const testPath = path.join(session, 'extension');
    stageExtension(sourceCopy, testPath);
    const development = treeReceipt(testPath);
    const productionDifferences = development.files.filter(file =>
      production.files.find(original => original.path === file.path)?.sha256 !== file.sha256).map(file => file.path);
    if (productionDifferences.length !== 1 || productionDifferences[0] !== 'dist/background.js') {
      throw new Error('The dev build unexpectedly changed production modules beyond its existing diagnostics branch.');
    }
    if (production.backgroundSha256 === development.backgroundSha256) throw new Error('Dev diagnostics were not enabled.');
    const manifest = JSON.parse(readFileSync(path.join(testPath, 'manifest.json'), 'utf8'));
    const id = extensionId(manifest.key);
    const fixturePath = path.join(projectRoot, 'scripts', 'acceptance');
    for (const relative of FIXTURE_FILES) copyFileSync(path.join(fixturePath, relative), path.join(testPath, relative === 'runner.html' ? 'benchmark.html' : relative));
    const popup = path.join(testPath, 'popup.html');
    const popupBytes = readFileSync(popup, 'utf8');
    if (!popupBytes.includes('</body>')) throw new Error('Expected production popup document.');
    writeFileSync(popup, popupBytes.replace('</body>', '  <script src="popup-bridge.js" type="module"></script>\n</body>'));
    const overlay = treeReceipt(testPath);
    const testOverlayFiles = overlay.files.filter(file =>
      development.files.find(original => original.path === file.path)?.sha256 !== file.sha256);
    const receipt = {
      schemaVersion: 1, runId, preparedAt: new Date().toISOString(),
      label: 'Isolated development acceptance — production final checks pending',
      extensionId: id,
      browser: { name: 'Chrome for Testing', version: browser.version, executableSha256: browser.executableSha256 ?? null, mockKeychain: true, sandbox: true, debugger: false },
      production,
      development: { ...development, productionDifferences, overlayTreeSha256: overlay.treeSha256, testOverlayFiles },
      source: { commit: sourceCommit, nodeVersion: process.version, litertRuntime: '0.17.0', ollamaRuntime: '0.40.3' },
    };
    writeFileSync(path.join(testPath, 'acceptance-config.json'), JSON.stringify(receipt, null, 2) + '\n');
    const ownership = {
      schemaVersion: 1, kind: 'bouncer-isolated-acceptance', runId,
      session: realpathSync(session), browserExecutable: browser.executable,
      browserVersion: browser.version, browserExecutableSha256: browser.executableSha256 ?? null, nodeExecutable: process.execPath,
      extensionId: id, arguments: launchArguments(session, id),
      packageTree: treeReceipt(testPath),
    };
    writeFileSync(path.join(session, 'ownership.json'), JSON.stringify(ownership, null, 2) + '\n', { mode: 0o600 });
    copyFileSync(path.join(projectRoot, 'scripts', 'isolated-acceptance-session.mjs'), path.join(session, 'session.mjs'));
    for (const [filename, action] of [['Start test.command', 'launch'], ['Clean up test.command', 'cleanup']]) {
      writeFileSync(path.join(session, filename), `#!/bin/zsh\nset -eu\n${quoteShell(process.execPath)} ${quoteShell(path.join(session, 'session.mjs'))} ${action}\n`, { mode: 0o700 });
    }
    writeFileSync(path.join(session, 'README.txt'), [
      'BOUNCER — ISOLATED HUMAN-OPERATED ACCEPTANCE',
      '',
      'Double-click Start test.command. This opens a separate Chrome for Testing with synthetic, disposable storage.',
      'In its Extensions tab, enable Developer mode if off. Do not open a service-worker inspector.',
      'Select the Bouncer acceptance tab and reload it if initially blocked. If the extension did not load, use Load unpacked and select the extension folder beside this file.',
      'Leave everyday Bouncer/X and other local AI clients idle. Your normal saved choice remains unchanged.',
      'Read the consent text, tick the idle-clients checkbox and click Start. This explicitly downloads about 2 GB into the TEST profile.',
      'When asked, click the REAL Connect to Ollama button in the embedded settings and approve Chrome’s exact local connection dialog. Then Continue.',
      'Keep the test tab active during both quiet intervals. Close no window while a request is pending.',
      'Export the JSON report when the run reaches its final result. No network/report server receives it.',
      'If any authentication/administrator/Keychain prompt appears, cancel/deny and stop to identify its requester and scope.',
      '',
      'This is a separate development integration build. Its existing benchmark branch is enabled; setup/CSP/host permissions/model pins remain unchanged.',
      'It does not qualify production background bytes, private feed/manual/suggestion UI, interruption recovery, or real-login persistence.',
      'The runner never force-unloads native weights, restarts the shared service or changes macOS settings.',
      '',
      'AFTER EXPORT: only if the report says safeToCleanup=true and pendingRequests=0, normally Quit this Chrome for Testing.',
      'Then double-click Clean up test.command and paste the exported report path when asked.',
      'Cleanup refuses an active owned browser, unsafe/incomplete report, symlinked session, changed package or wrong run identity.',
      'An uncertain native failure preserves this session. Do not delete it or resume other native clients until the uncertainty is resolved.',
      '',
      `Runner URL: chrome-extension://${id}/benchmark.html`,
      `Report filename: bouncer-acceptance-report-${runId}.json`,
    ].join('\n') + '\n');
    // The receipts and staged artifacts are sufficient for acceptance. Keep no
    // duplicate runtime packages/source build tree in the disposable session.
    rmSync(path.join(session, 'build-source'), { recursive: true, force: false });
    return { session, receipt, ownership };
  } catch (error) {
    // No browser is launched during preparation, so this exact new directory
    // cannot hold a submitted native request or another person's profile.
    rmSync(session, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/prepare-isolated-acceptance.mjs --browser /approved/ChromeForTestingExecutable');
    console.log('Builds an owned disposable HUMAN-OPERATED macOS session. Preparation never launches Chrome, downloads models, sends inference, or changes installed profiles/native settings.');
    console.log('Read the generated README.txt; only the human runs Start test.command. No agent-control workaround is authorized.');
    return;
  }
  if (args.length !== 2 || args[0] !== '--browser') throw new Error('Usage: node scripts/prepare-isolated-acceptance.mjs --browser /approved/ChromeForTestingExecutable');
  if (process.platform !== 'darwin') throw new Error('This disposable manual launcher currently targets macOS.');
  const browser = inspectBrowser(args[1]);
  if (!existsSync(path.join(PROJECT_ROOT, 'Bouncer', 'node_modules'))) throw new Error('Install the project’s pinned dependencies before preparing a session.');
  const { stageRelease } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'Bouncer', 'cut.js')).href);
  const buildUrl = pathToFileURL(path.join(PROJECT_ROOT, 'Bouncer', 'build.js')).href;
  const buildExtension = async ({ root, dev }) => {
    // esbuild captures its default working directory when imported. A separate
    // Node process also keeps the source's tsconfig and module-path comments
    // identical to an ordinary build without changing this process's cwd.
    execFileSync(process.execPath, ['--input-type=module', '-e',
      "const { build } = await import(process.argv[1]); await build({ root: process.cwd(), dev: process.argv[2] === 'true' });",
      buildUrl, String(dev)], { cwd: root, stdio: 'inherit' });
  };
  let sourceCommit = null;
  try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(); } catch { /* Content receipts remain authoritative. */ }
  const result = await prepareAcceptance({ browser, temporaryRoot: '/private/tmp', buildExtension, stageExtension: stageRelease, sourceCommit });
  console.log(`Prepared (not launched): ${result.session}`);
  console.log(`Production background: ${result.receipt.production.backgroundSha256}`);
  console.log('No browser, native service or installed profile was changed. Read README.txt and manually run Start test.command.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(`Preparation failed: ${error.message}`);
  process.exitCode = 1;
});
