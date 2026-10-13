import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build } from '../../build.js';
import { stageRelease } from '../../cut.js';

const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
let fixtureDir;
let root;

function put(relative, content = `synthetic asset: ${relative}`) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function filesIn(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    return entry.isDirectory()
      ? filesIn(path.join(directory, entry.name), `${relative}/`)
      : [relative];
  }).sort();
}

beforeEach(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'bouncer-native-package-'));
  root = path.join(fixtureDir, 'Bouncer');
  mkdirSync(root);
  for (const filename of ['manifest.base.json', 'manifest.chrome.json']) {
    copyFileSync(path.join(SOURCE_ROOT, filename), path.join(root, filename));
  }
  for (const entry of ['popup.js', 'content.js', 'benchmark.js']) {
    put(entry, `console.log(${JSON.stringify(entry)});`);
  }
  put('background.js', 'if (__DEV__) import("./diagnostics.js"); console.log("native background");');
  put('diagnostics.js', 'console.log("development-diagnostic-marker");');
  put('adapters/twitter/TwitterAdapter.ts', 'globalThis.syntheticAdapter = true;');
  for (const asset of [
    'popup.html', 'popup.css', 'content.css', 'dompurify.js',
    'adapters/twitter/twitter.css', 'adapters/twitter/fiber-extractor.js',
    'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png', 'icons/a-bouncer-2x-black.png',
  ]) put(asset);
  writeFileSync(path.join(fixtureDir, 'LICENSE.txt'), 'Synthetic AGPL license fixture');
});

afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe('fixed native Chrome packaging', () => {
  it('cleans stale browser runtime and dev assets without a runtime package installation', async () => {
    put('dist/litertlm-wasm/stale.wasm');
    put('dist/offscreen.js');
    put('dist/gemma-comparison.js');
    put('dist/benchmark.js');

    await build({ root });

    expect(filesIn(path.join(root, 'dist'))).toEqual([
      'TwitterAdapter.js', 'background.js', 'content.js', 'popup.js',
    ]);
    expect(readFileSync(path.join(root, 'dist/background.js'), 'utf8'))
      .not.toContain('development-diagnostic-marker');
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false);
  });

  it('builds the actual-extension benchmark only in development mode', async () => {
    await build({ root, dev: true });
    expect(filesIn(path.join(root, 'dist'))).toEqual([
      'TwitterAdapter.js', 'background.js', 'benchmark.js', 'content.js', 'popup.js',
    ]);
    expect(readFileSync(path.join(root, 'dist/background.js'), 'utf8'))
      .toContain('development-diagnostic-marker');
    await build({ root });
    expect(existsSync(path.join(root, 'dist/benchmark.js'))).toBe(false);
  });

  it('preserves the Chrome identity and limits network access to X and optional fixed loopback', async () => {
    await build({ root });
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
    const extensionID = [...hash].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');

    expect(extensionID).toBe('bkijmhafoocfloemhancbgadknkgdkcm');
    expect(manifest.minimum_chrome_version).toBe('137');
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.host_permissions).toEqual(['https://x.com/*']);
    expect(manifest.optional_host_permissions).toEqual(['http://127.0.0.1:11434/*']);
    expect(manifest.content_security_policy.extension_pages).toBe(
      "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:11434",
    );
    expect(manifest.background).toEqual({ service_worker: 'dist/background.js', type: 'module' });
    expect(JSON.stringify(manifest)).not.toMatch(/wasm|offscreen|polyfill|firefox|safari/iu);
  });

  it('stages only Chrome runtime assets and the license, excluding stale runtime and development files', async () => {
    await build({ root, dev: true });
    for (const obsolete of [
      'offscreen.html', 'offscreen.js', 'browser-polyfill.js', 'gemma-comparison.html',
      'benchmark.html', 'dist/offscreen.js', 'dist/gemma-comparison.js', 'dist/litertlm-wasm/stale.wasm',
      'node_modules/runtime.js', 'src/obsolete.ts',
    ]) put(obsolete);
    const stage = path.join(fixtureDir, 'release');

    stageRelease(root, stage);

    const staged = filesIn(stage);
    expect(staged).not.toContain('benchmark.html');
    expect(staged).not.toContain('dist/benchmark.js');
    expect(staged.join('\n')).not.toMatch(/offscreen|wasm|polyfill|comparison|node_modules|src\//iu);
    expect(staged).toContain('LICENSE.txt');
    const manifest = JSON.parse(readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
    const declared = [
      manifest.background.service_worker, manifest.action.default_popup,
      ...Object.values(manifest.icons),
      ...manifest.content_scripts.flatMap(script => [...script.js, ...script.css]),
      ...manifest.web_accessible_resources.flatMap(resource => resource.resources),
    ];
    for (const asset of declared) expect(staged).toContain(asset);
    expect(readFileSync(path.join(stage, 'dompurify.js'), 'utf8')).toBe('synthetic asset: dompurify.js');
  });

  it('fails a release before staging if a required Chrome asset is missing', async () => {
    await build({ root });
    rmSync(path.join(root, 'adapters/twitter/fiber-extractor.js'));
    const stage = path.join(fixtureDir, 'release');
    expect(() => stageRelease(root, stage)).toThrow('Missing release asset:');
    expect(existsSync(stage)).toBe(false);
  });

  it.each([
    ['build.js', '--target=firefox'],
    ['generate-manifests.mjs', '--target=safari'],
    ['cut.js', '--firefox'],
  ])('rejects retired platform options in %s before building or installing', (script, option) => {
    const result = spawnSync(process.execPath, [path.join(SOURCE_ROOT, script), option], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/only.*Chrome|only a Chrome/iu);
    expect(result.stdout).not.toMatch(/Building|npm ci/iu);
  });

  it('requires no inference SDK and exposes no retired platform command', () => {
    const pkg = JSON.parse(readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['dompurify', 'html-to-image']);
    expect(Object.keys(pkg.scripts).join('\n')).not.toMatch(/firefox|safari/iu);
  });
});
