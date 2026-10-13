import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyLitertlmAssets, getLitertlmAssetNames } from '../../litertlm-assets.mjs';

const MODERN_ASSETS = [
  'litertlm_wasm_internal.js',
  'litertlm_wasm_internal.wasm',
  'litertlm_wasm_compat_internal.js',
  'litertlm_wasm_compat_internal.wasm',
];
const ASYNCIFY_ASSETS = [
  'litertlm_wasm_asyncify_internal.js',
  'litertlm_wasm_asyncify_internal.wasm',
  'litertlm_wasm_compat_asyncify_internal.js',
  'litertlm_wasm_compat_asyncify_internal.wasm',
];
const TARGETS = [['chrome', MODERN_ASSETS]];

let fixtureDir;
let sourceDir;
let destinationDir;

beforeEach(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'bouncer-wasm-assets-'));
  sourceDir = path.join(fixtureDir, 'source');
  destinationDir = path.join(fixtureDir, 'destination');
  mkdirSync(sourceDir);
  for (const name of [...MODERN_ASSETS, ...ASYNCIFY_ASSETS, 'future-variant.js']) {
    writeFileSync(path.join(sourceDir, name), `synthetic asset: ${name}`);
  }
});

afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe('target-specific LiteRT-LM packaging', () => {
  it.each(TARGETS)('copies only the four %s assets and removes stale variants', (target, expected) => {
    mkdirSync(destinationDir);
    for (const name of [...MODERN_ASSETS, ...ASYNCIFY_ASSETS, 'stale.js']) {
      writeFileSync(path.join(destinationDir, name), 'old build');
    }

    expect(getLitertlmAssetNames(target)).toEqual(expected);
    expect(copyLitertlmAssets(sourceDir, destinationDir, target)).toEqual(expected);
    expect(readdirSync(destinationDir).sort()).toEqual([...expected].sort());
    for (const name of expected) {
      expect(readFileSync(path.join(destinationDir, name), 'utf8')).toBe(`synthetic asset: ${name}`);
    }
  });

  it.each(TARGETS.flatMap(([target, expected]) => expected.map(name => [target, name])))(
    'fails the %s build when required %s is missing', (target, missing) => {
      rmSync(path.join(sourceDir, missing));
      mkdirSync(destinationDir);
      writeFileSync(path.join(destinationDir, 'stale.js'), 'old build');

      expect(() => copyLitertlmAssets(sourceDir, destinationDir, target)).toThrow(
        `Missing LiteRT-LM ${target} asset: ${missing}`,
      );
      expect(existsSync(destinationDir)).toBe(false);
    },
  );

  it.each(TARGETS)('does not require unshipped variants for %s', (target, expected) => {
    for (const name of [...MODERN_ASSETS, ...ASYNCIFY_ASSETS]) {
      if (!expected.includes(name)) rmSync(path.join(sourceDir, name));
    }

    copyLitertlmAssets(sourceDir, destinationDir, target);

    expect(readdirSync(destinationDir).sort()).toEqual([...expected].sort());
  });

  it('fails when the installed WASM directory is missing', () => {
    rmSync(sourceDir, { recursive: true });

    expect(() => copyLitertlmAssets(sourceDir, destinationDir, 'chrome')).toThrow(
      'Missing LiteRT-LM chrome asset: litertlm_wasm_internal.js',
    );
    expect(existsSync(destinationDir)).toBe(false);
  });

  it('rejects a directory masquerading as a required asset', () => {
    const invalid = path.join(sourceDir, MODERN_ASSETS[0]);
    rmSync(invalid);
    mkdirSync(invalid);

    expect(() => copyLitertlmAssets(sourceDir, destinationDir, 'chrome')).toThrow(
      `Missing LiteRT-LM chrome asset: ${MODERN_ASSETS[0]}`,
    );
    expect(existsSync(destinationDir)).toBe(false);
  });

  it('rejects an empty required asset from an incomplete installation', () => {
    writeFileSync(path.join(sourceDir, MODERN_ASSETS[1]), '');

    expect(() => copyLitertlmAssets(sourceDir, destinationDir, 'chrome')).toThrow(
      `Missing LiteRT-LM chrome asset: ${MODERN_ASSETS[1]}`,
    );
    expect(existsSync(destinationDir)).toBe(false);
  });

  it('rejects unknown build targets', () => {
    expect(() => copyLitertlmAssets(sourceDir, destinationDir, 'unknown')).toThrow(
      'Unknown LiteRT-LM build target: unknown',
    );
  });

  it('declares browser minimums that support the packaged JSPI loaders', () => {
    const chrome = JSON.parse(readFileSync(new URL('../../manifest.chrome.json', import.meta.url), 'utf8'));

    expect(chrome.minimum_chrome_version).toBe('137');
  });
});
