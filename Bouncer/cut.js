import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateManifest } from './generate-manifests.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE_MANIFEST_PATH = resolve(ROOT, 'manifest.base.json');

// Positive runtime allowlist: source files, diagnostics, dependencies and stale
// generated assets cannot enter an archive merely because they exist locally.
const RELEASE_FILES = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'content.css',
  'dompurify.js',
  'dist/background.js',
  'dist/popup.js',
  'dist/content.js',
  'dist/TwitterAdapter.js',
  'adapters/twitter/twitter.css',
  'adapters/twitter/fiber-extractor.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/a-bouncer-2x-black.png',
];

export function stageRelease(root, destination) {
  const files = RELEASE_FILES.map(relative => [resolve(root, relative), relative]);
  files.push([resolve(root, '../LICENSE.txt'), 'LICENSE.txt']);
  for (const [source] of files) {
    let valid = false;
    try {
      const stat = statSync(source);
      valid = stat.isFile() && stat.size > 0;
    } catch {
      // A release requires every declared runtime asset and its license.
    }
    if (!valid) throw new Error(`Missing release asset: ${source}`);
  }
  mkdirSync(destination, { recursive: true });
  try {
    for (const [source, relative] of files) {
      const target = resolve(destination, relative);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const difference = (partsA[i] || 0) - (partsB[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function incrementPatch(version) {
  const parts = version.split('.').map(Number);
  parts[parts.length - 1]++;
  return parts.join('.');
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolveAnswer => {
    rl.question(question, answer => {
      rl.close();
      resolveAnswer(answer.trim());
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const unsupported = args.find(arg => arg !== '--same-version');
  if (unsupported) throw new Error(`Unsupported release option: ${unsupported}. This fork releases only Chrome.`);
  const sameVersion = args.includes('--same-version');

  console.log('Running npm ci...');
  execFileSync('npm', ['ci'], { cwd: ROOT, stdio: 'inherit' });
  console.log('Running node build.js...');
  execFileSync(process.execPath, ['build.js'], { cwd: ROOT, stdio: 'inherit' });

  const manifest = JSON.parse(readFileSync(BASE_MANIFEST_PATH, 'utf8'));
  const currentVersion = manifest.version;
  let newVersion = currentVersion;
  if (!sameVersion) {
    const defaultVersion = incrementPatch(currentVersion);
    newVersion = await prompt(`Enter new version number (must be > ${currentVersion}) [${defaultVersion}]: `) || defaultVersion;
    if (!/^\d+(\.\d+)*$/.test(newVersion)) throw new Error('Invalid version format. Use semver like 1.2.3');
    if (compareVersions(newVersion, currentVersion) <= 0) throw new Error(`New version ${newVersion} must be greater than ${currentVersion}`);
    manifest.version = newVersion;
    writeFileSync(BASE_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    generateManifest();
  }

  const zipPath = resolve(ROOT, '..', `${basename(ROOT)}-${newVersion}.zip`);
  const stage = mkdtempSync(resolve(tmpdir(), 'bouncer-chrome-release-'));
  try {
    stageRelease(ROOT, stage);
    rmSync(zipPath, { force: true });
    console.log(`Creating ${basename(zipPath)}...`);
    execFileSync('zip', ['-r', zipPath, '.'], { cwd: stage, stdio: 'inherit' });
    console.log(`Done! Created ${zipPath}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Release failed:', error);
    process.exitCode = 1;
  });
}
