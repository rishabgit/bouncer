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

const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
let fixtureDir;
let root;

function put(relative, content = `synthetic asset: ${relative}`) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function filesIn(directory) {
  return readdirSync(directory).sort();
}

beforeEach(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'bouncer-native-package-'));
  root = path.join(fixtureDir, 'Bouncer');
  mkdirSync(root);
  for (const filename of ['manifest.base.json', 'manifest.chrome.json']) {
    copyFileSync(path.join(SOURCE_ROOT, filename), path.join(root, filename));
  }
  for (const entry of ['background.js', 'popup.js', 'content.js']) {
    put(entry, `console.log(${JSON.stringify(entry)});`);
  }
  put('adapters/twitter/TwitterAdapter.ts', 'globalThis.syntheticAdapter = true;');
});

afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe('native-only Chrome packaging', () => {
  it('replaces stale generated files with the runtime bundles', async () => {
    put('dist/stale.js');

    await build({ root });

    expect(filesIn(path.join(root, 'dist'))).toEqual([
      'TwitterAdapter.js', 'background.js', 'content.js', 'popup.js',
    ]);
    expect(existsSync(path.join(root, 'dist/stale.js'))).toBe(false);
  });

  it('preserves the Chrome identity and limits network access to X and required fixed loopback', async () => {
    await build({ root });
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
    const extensionID = [...hash].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');

    expect(extensionID).toBe('bkijmhafoocfloemhancbgadknkgdkcm');
    expect(manifest.minimum_chrome_version).toBe('137');
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.host_permissions).toEqual(['https://x.com/*', 'http://127.0.0.1:9931/*']);
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.content_security_policy.extension_pages).toBe(
      "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:9931",
    );
    expect(manifest.background).toEqual({ service_worker: 'dist/background.js', type: 'module' });
    expect(JSON.stringify(manifest)).not.toMatch(/'unsafe-eval'|polyfill|firefox|safari/iu);
  });

  it.each([
    ['build.js', '--dev'],
    ['build.js', '--target=firefox'],
    ['generate-manifests.mjs', '--target=safari'],
  ])('rejects unsupported options in %s before building', (script, option) => {
    const result = spawnSync(process.execPath, [path.join(SOURCE_ROOT, script), option], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/only.*Chromium|only a Chromium/iu);
    expect(result.stdout).not.toMatch(/Building/iu);
  });

  it('uses only the expected runtime dependencies and platform commands', () => {
    const pkg = JSON.parse(readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['dompurify']);
    expect(pkg.overrides).toBeUndefined();
    expect(Object.keys(pkg.scripts).join('\n')).not.toMatch(/firefox|safari/iu);
  });
});
