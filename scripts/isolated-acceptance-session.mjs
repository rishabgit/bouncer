// Copied into an owned session. Only the human runs the launch command.
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function readOwnership(directory) {
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory
      || !path.basename(directory).startsWith('bouncer-acceptance-')) throw new Error('Not an exact owned disposable session.');
  const ownershipPath = path.join(directory, 'ownership.json');
  if (lstatSync(ownershipPath).isSymbolicLink()) throw new Error('Symlinked ownership is not accepted.');
  const owned = JSON.parse(readFileSync(ownershipPath, 'utf8'));
  if (owned.schemaVersion !== 1 || owned.kind !== 'bouncer-isolated-acceptance'
      || owned.session !== directory || typeof owned.runId !== 'string'
      || !/^[0-9a-f-]{36}$/.test(owned.runId)) throw new Error('Invalid disposable-session ownership.');
  return owned;
}
export function verifyPackage(directory, ownership) {
  const root = path.join(directory, 'extension');
  if (lstatSync(root).isSymbolicLink() || !Array.isArray(ownership.packageTree?.files)) throw new Error('Invalid test package.');
  const actual = [];
  const walk = (current, prefix = '') => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Symlinks in the test package are not accepted.');
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative + '/');
      else if (entry.isFile()) actual.push(relative);
      else throw new Error('Unsupported test package entry.');
    }
  };
  walk(root);
  const expected = ownership.packageTree.files;
  if (actual.length !== expected.length) throw new Error('The test package changed.');
  for (const item of expected) {
    if (typeof item.path !== 'string' || !actual.includes(item.path)
        || sha256(readFileSync(path.join(root, item.path))) !== item.sha256) throw new Error('The test package changed. Prepare a fresh session.');
  }
}
export function assertCleanupReport(report, ownership) {
  if (report?.schemaVersion !== 1 || report.runId !== ownership.runId
      || report.terminal !== true || report.pendingRequests !== 0 || report.safeToCleanup !== true) {
    throw new Error('Cleanup requires this run’s terminal exported report, zero pending requests and safeToCleanup=true. Preserve uncertain native work.');
  }
}
export function processPattern(directory) {
  return 'user-data-dir=' + path.join(directory, 'profile').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function browserIsRunning(directory, run = execFileSync) {
  try { return run('/usr/bin/pgrep', ['-f', processPattern(directory)], { encoding: 'utf8' }).trim().length > 0; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
function inspectBundle(ownership) {
  const actual = realpathSync(ownership.browserExecutable);
  if (actual !== ownership.browserExecutable || path.basename(actual) !== 'Google Chrome for Testing') throw new Error('Unexpected executable.');
  accessSync(actual, constants.X_OK);
  const plist = path.resolve(actual, '../../Info.plist');
  const read = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  if (read('CFBundleIdentifier') !== 'com.google.chrome.for.testing'
      || read('CFBundleShortVersionString') !== ownership.browserVersion
      || !/^[0-9a-f]{64}$/.test(ownership.browserExecutableSha256)
      || sha256(readFileSync(actual)) !== ownership.browserExecutableSha256) throw new Error('Browser changed; prepare and requalify a fresh session.');
}
export function expectedArguments(directory, id) {
  if (typeof id !== 'string' || !/^[a-p]{32}$/.test(id)) throw new Error('Invalid extension identity.');
  return ['--use-mock-keychain', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-networking', '--disable-component-update',
    `--user-data-dir=${path.join(directory, 'profile')}`,
    `--disable-extensions-except=${path.join(directory, 'extension')}`,
    `--load-extension=${path.join(directory, 'extension')}`,
    'chrome://extensions/', `chrome-extension://${id}/benchmark.html`];
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['launch', 'cleanup'].includes(args[0])) throw new Error('Use launch or cleanup; no other browser controls are provided.');
  const owned = readOwnership(ROOT);
  verifyPackage(ROOT, owned);
  if (browserIsRunning(ROOT)) throw new Error('The owned test browser is still running. No second launch or cleanup is allowed.');
  if (args[0] === 'cleanup') {
    const ui = createInterface({ input: process.stdin, output: process.stdout });
    let filename;
    try { filename = (await ui.question('Paste the exported JSON report path (after normally quitting the test browser): ')).trim(); }
    finally { ui.close(); }
    const reportBytes = readFileSync(filename);
    if (reportBytes.length > 2_000_000) throw new Error('Report is too large.');
    assertCleanupReport(JSON.parse(reportBytes), owned);
    // Recheck just before removal. No process is killed, and no native operation
    // is canceled or inferred settled from elapsed time/residency.
    if (browserIsRunning(ROOT)) throw new Error('The owned test browser is active.');
    rmSync(ROOT, { recursive: true, force: false });
    console.log('Removed only the owned disposable session. The exported report is preserved.');
    return;
  }
  if (existsSync(path.join(ROOT, 'launch.json')) || existsSync(path.join(ROOT, 'profile'))) {
    throw new Error('This session is single-use. Preserve its report/profile and prepare a new one instead of silently resuming a possible native fence.');
  }
  inspectBundle(owned);
  const launchArgs = expectedArguments(ROOT, owned.extensionId);
  if (JSON.stringify(launchArgs) !== JSON.stringify(owned.arguments)) throw new Error('Launch arguments changed.');
  writeFileSync(path.join(ROOT, 'launch.json'), JSON.stringify({ runId: owned.runId, startedAt: new Date().toISOString(), arguments: launchArgs }, null, 2) + '\n');
  console.log('Opening ONLY this disposable Chrome for Testing, without debugging, with mock Keychain and the browser sandbox retained.');
  console.log('Enable Developer mode if off, then open the acceptance tab. Leave other local AI clients idle.');
  console.log('Keep this launcher open. Export a terminal safe report before normally quitting the test browser. Cancel unexpected authentication prompts.');
  const child = spawn(owned.browserExecutable, launchArgs, { stdio: 'ignore' });
  child.on('error', error => { console.error(`Test browser launch failed: ${error.message}`); process.exitCode = 1; });
  child.on('spawn', () => writeFileSync(path.join(ROOT, 'process.json'), JSON.stringify({ runId: owned.runId, pid: child.pid }) + '\n'));
  child.on('exit', (code, signal) => {
    writeFileSync(path.join(ROOT, 'exit.json'), JSON.stringify({ runId: owned.runId, endedAt: new Date().toISOString(), code, signal }) + '\n');
    console.log('Test browser exited. No profile or native data was removed. Use the guarded cleanup only with a terminal safe report.');
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(`Session stopped: ${error.message}`);
  process.exitCode = 1;
});
