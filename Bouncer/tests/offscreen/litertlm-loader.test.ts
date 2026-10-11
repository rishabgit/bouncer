import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLitertlmLoaderUrl } from '../../src/offscreen/litertlm-loader.js';

const BASE_URL = 'chrome-extension://test/dist/litertlm-wasm/';

function stubFeatures(target: string | undefined, relaxedSimd: boolean, jspi: boolean) {
  const validate = vi.fn().mockReturnValue(relaxedSimd);
  vi.stubGlobal('__BOUNCER_BUILD_TARGET__', target);
  vi.stubGlobal('WebAssembly', {
    validate,
    ...(jspi ? { Suspending: class {} } : {}),
  });
  return validate;
}

afterEach(() => vi.unstubAllGlobals());

describe('getLitertlmLoaderUrl', () => {
  it.each([
    ['chrome', true, 'litertlm_wasm_internal.js'],
    ['chrome', false, 'litertlm_wasm_compat_internal.js'],
    ['firefox', true, 'litertlm_wasm_internal.js'],
    ['firefox', false, 'litertlm_wasm_compat_internal.js'],
  ] as const)('selects the packaged %s loader with relaxed-SIMD=%s', (target, simd, file) => {
    stubFeatures(target, simd, true);

    expect(getLitertlmLoaderUrl(BASE_URL)).toBe(`${BASE_URL}${file}`);
  });

  it.each([
    [true, true, 'litertlm_wasm_asyncify_internal.js'],
    [true, false, 'litertlm_wasm_asyncify_internal.js'],
    [false, true, 'litertlm_wasm_compat_asyncify_internal.js'],
    [false, false, 'litertlm_wasm_compat_asyncify_internal.js'],
  ] as const)('pins Safari to asyncify with relaxed-SIMD=%s, JSPI=%s', (simd, jspi, file) => {
    stubFeatures('safari', simd, jspi);

    expect(getLitertlmLoaderUrl(BASE_URL)).toBe(`${BASE_URL}${file}`);
  });

  it.each(['chrome', 'firefox'])('fails clearly when %s has no JSPI', (target) => {
    const validate = stubFeatures(target, true, false);

    expect(() => getLitertlmLoaderUrl(BASE_URL)).toThrow(
      'LiteRT-LM requires WebAssembly JSPI. Use Chrome 137+ or Firefox 145+.',
    );
    expect(validate).not.toHaveBeenCalled();
  });

  it('does not mistake an undefined JSPI property for support', () => {
    stubFeatures('chrome', true, false);
    vi.stubGlobal('WebAssembly', { validate: vi.fn(), Suspending: undefined });

    expect(() => getLitertlmLoaderUrl(BASE_URL)).toThrow('WebAssembly JSPI');
  });

  it('defaults an undefined build target to Chrome for the localhost harness', () => {
    stubFeatures(undefined, false, true);

    expect(getLitertlmLoaderUrl('http://localhost:4173/dist/litertlm-wasm')).toBe(
      'http://localhost:4173/dist/litertlm-wasm/litertlm_wasm_compat_internal.js',
    );
  });

  it('requires JSPI for the default Chrome target too', () => {
    stubFeatures(undefined, true, false);

    expect(() => getLitertlmLoaderUrl(BASE_URL)).toThrow('WebAssembly JSPI');
  });

  it('validates the official relaxed-SIMD probe from the installed core package', () => {
    const validate = stubFeatures('chrome', true, true);
    const upstream = readFileSync(new URL(
      '../../node_modules/@litert-lm/core/dist/wasm_feature_detect.js', import.meta.url,
    ), 'utf8');
    const bytes = upstream.match(/WASM_RELAXED_SIMD_CHECK = new Uint8Array\(\[([\s\S]*?)\]\)/);
    expect(bytes).not.toBeNull();
    const officialProbe = new Uint8Array(JSON.parse(`[${bytes![1]}]`) as number[]);

    getLitertlmLoaderUrl(BASE_URL);

    expect(validate).toHaveBeenCalledExactlyOnceWith(officialProbe);
  });

  it('rejects an unknown target rather than guessing an unpackaged variant', () => {
    stubFeatures('unknown-browser', true, true);

    expect(() => getLitertlmLoaderUrl(BASE_URL)).toThrow('Unknown LiteRT-LM build target');
  });

  it('reports unavailable WebAssembly clearly', () => {
    stubFeatures('safari', true, false);
    vi.stubGlobal('WebAssembly', undefined);

    expect(() => getLitertlmLoaderUrl(BASE_URL)).toThrow('LiteRT-LM requires WebAssembly support.');
  });
});
