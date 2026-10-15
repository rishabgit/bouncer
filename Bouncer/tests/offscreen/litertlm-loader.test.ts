import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLitertlmLoaderUrl } from '../../src/offscreen/litertlm-loader';
const BASE = 'chrome-extension://test/dist/litertlm-wasm/';
afterEach(() => vi.unstubAllGlobals());
describe('Chrome LiteRT-LM loader', () => {
  it.each([[true, 'litertlm_wasm_internal.js'], [false, 'litertlm_wasm_compat_internal.js']])('selects only the packaged JSPI pair for relaxed SIMD=%s', (simd, name) => {
    vi.stubGlobal('WebAssembly', { validate: vi.fn().mockReturnValue(simd), Suspending: class {} });
    expect(getLitertlmLoaderUrl(BASE)).toBe(BASE + name);
  });
  it('fails clearly without JSPI', () => {
    vi.stubGlobal('WebAssembly', { validate: vi.fn() });
    expect(() => getLitertlmLoaderUrl(BASE)).toThrow('LiteRT-LM requires WebAssembly JSPI. Use Chrome 137+.');
  });
  it('fails clearly without WebAssembly', () => {
    vi.stubGlobal('WebAssembly', undefined);
    expect(() => getLitertlmLoaderUrl(BASE)).toThrow('WebAssembly support');
  });
  it('uses the installed SDK relaxed-SIMD probe', () => {
    const validate = vi.fn().mockReturnValue(true);
    vi.stubGlobal('WebAssembly', { validate, Suspending: class {} });
    const source = readFileSync(new URL('../../node_modules/@litert-lm/core/dist/wasm_feature_detect.js', import.meta.url), 'utf8');
    const bytes = source.match(/WASM_RELAXED_SIMD_CHECK = new Uint8Array\(\[([\s\S]*?)\]\)/)!;
    getLitertlmLoaderUrl(BASE);
    expect(validate).toHaveBeenCalledExactlyOnceWith(new Uint8Array(JSON.parse(`[${bytes[1]}]`) as number[]));
  });
});
