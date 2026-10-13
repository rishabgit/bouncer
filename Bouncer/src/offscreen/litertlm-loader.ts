// Official relaxed-SIMD probe from @litert-lm/core's
// dist/wasm_feature_detect.js (Google LLC, Apache-2.0).
const WASM_RELAXED_SIMD_CHECK = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1,
  0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11,
]);

/** Select a full loader URL from the pairs packaged for this build target. */
export function getLitertlmLoaderUrl(baseUrl: string): string {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
    throw new Error('LiteRT-LM requires WebAssembly support.');
  }
  const wasm = WebAssembly as typeof WebAssembly & { Suspending?: unknown };
  if (typeof wasm.Suspending !== 'function') {
    throw new Error(
      'LiteRT-LM requires WebAssembly JSPI. Use Chrome 137+.',
    );
  }

  const compat = WebAssembly.validate(WASM_RELAXED_SIMD_CHECK) ? '' : '_compat';
  const filename = `litertlm_wasm${compat}_internal.js`;
  const directory = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(filename, directory).href;
}
