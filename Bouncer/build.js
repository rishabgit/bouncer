import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateManifest } from './generate-manifests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const env = process.argv.includes('--dev') ? 'dev' : 'prod';
const targetArg = process.argv.find((a) => a.startsWith('--target='));
const target = targetArg ? targetArg.split('=')[1] : 'chrome';

// This is a local-only fork: all cloud/remote backends were removed, so there
// are no build-time secrets. NODE_ENV is the only define the vendored deps read.
const define = {
  'process.env.NODE_ENV': '"production"',
};

const adapterTsPath = path.join(__dirname, 'adapters/twitter/TwitterAdapter.ts');
const hasAdapterTs = fs.existsSync(adapterTsPath);

// esbuild plugin: rewrites `@mlc-ai/web-llm` imports to the pre-built
// `./webllm.js` bundle so it stays external and background.js stays small.
const externalizeWebLLM = {
  name: 'externalize-webllm',
  setup(build) {
    build.onResolve({ filter: /^@mlc-ai\/web-llm$/ }, () => ({
      path: './webllm.js',
      external: true,
    }));
  },
};

// Post-process dist/webllm.js: web-llm embeds large base64-encoded WASM
// binaries as inline data-URIs.  AMO rejects JS files over 5 MB, so we
// extract each blob into its own small module and import it back in.
function extractWebLLMWasmBlobs() {
  const webllmPath = path.join(__dirname, 'dist/webllm.js');
  let src = fs.readFileSync(webllmPath, 'utf8');

  // Match: wasmBinaryFile = "data:application/octet-stream;base64,<huge>"\n
  const re = /wasmBinaryFile\s*=\s*"(data:application\/octet-stream;base64,[A-Za-z0-9+/=]+)"/g;
  const imports = [];
  let i = 0;

  src = src.replace(re, (match, dataUri) => {
    // Only bother extracting blobs large enough to matter (> 100 KB).
    if (match.length < 100_000) return match;

    const varName = `__wasm_data_${i}`;
    const blobFile = `webllm-wasm-${i}.js`;
    fs.writeFileSync(
      path.join(__dirname, 'dist', blobFile),
      `export default "${dataUri}";\n`,
    );
    imports.push(`import ${varName} from "./${blobFile}";`);
    i++;
    return `wasmBinaryFile = ${varName}`;
  });

  if (imports.length) {
    src = imports.join('\n') + '\n' + src;
    fs.writeFileSync(webllmPath, src);
    console.log(`Extracted ${imports.length} WASM blob(s) from webllm.js`);
  }
}

// Copy LiteRT-LM's wasm loader + binaries into dist/litertlm-wasm/ so the
// offscreen document (Chrome) / event page (Firefox) can resolve them via
// chrome.runtime.getURL(...). The runtime feature-detects relaxed-SIMD and
// loads either litertlm_wasm_internal or litertlm_wasm_compat_internal; each
// .js fetches its sibling .wasm, so all four files sit at the same URL prefix.
// By default the package resolves these from a CDN URL the extension CSP
// blocks — loadLiteRtLm() points at this local directory instead.
function copyLitertlmAssets() {
  const srcDir = path.join(__dirname, 'node_modules/@litert-lm/core/wasm');
  const dstDir = path.join(__dirname, 'dist/litertlm-wasm');
  if (!fs.existsSync(srcDir)) {
    console.warn('@litert-lm/core wasm dir not found — skipping copy');
    return;
  }
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, name), path.join(dstDir, name));
  }
  console.log('Copied LiteRT-LM wasm assets into dist/litertlm-wasm/');
}

async function build() {
  console.log(`Building local-only (env: ${env}, target: ${target})`);

  // 0. Regenerate manifest.json from manifest.base.json + manifest.<target>.json.
  generateManifest(target);

  // Copy LiteRT-LM's wasm loader + binaries into dist/litertlm-wasm/.
  copyLitertlmAssets();

  // 1. Bundle web-llm into dist/webllm.js, then extract the large inline
  //    base64-encoded WASM blobs into separate files so every file stays under
  //    AMO's 5 MB parse limit.  background.js imports webllm.js via a static
  //    ESM import (dynamic import() is disallowed in service workers).
  await esbuild.build({
    stdin: { contents: 'export * from "@mlc-ai/web-llm";', resolveDir: __dirname },
    outfile: path.join(__dirname, 'dist/webllm.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    external: ['url'],
  });
  extractWebLLMWasmBlobs();

  // 2. Background: web-llm is externalized → resolved to dist/webllm.js at runtime.
  const bgCtx = await esbuild.context({
    entryPoints: [path.join(__dirname, 'background.js')],
    outdir: path.join(__dirname, 'dist'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    sourcemap: false,
    external: ['url'],
    define,
    plugins: [externalizeWebLLM],
  });

  // 2b. Offscreen document bundle (Chrome): hosts LiteRT-LM's Engine. The SW
  //     opens this page on demand because the LiteRT-LM wasm loader uses
  //     script-tag injection (via @litertjs/wasm-utils), unavailable in MV3
  //     ESM service workers. @litert-lm/core is bundled in here directly; its
  //     wasm binaries are copied separately into dist/litertlm-wasm/. Do NOT
  //     apply externalizeWebLLM — the offscreen doc doesn't use web-llm.
  const offscreenCtx = await esbuild.context({
    entryPoints: [path.join(__dirname, 'offscreen.js')],
    outdir: path.join(__dirname, 'dist'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    sourcemap: false,
    external: ['url'],
    define,
  });

  // 3. Popup & content: fully self-contained (no external imports).
  const otherCtx = await esbuild.context({
    entryPoints: [
      path.join(__dirname, 'popup.js'),
      path.join(__dirname, 'content.js')
    ],
    bundle: true,
    outdir: path.join(__dirname, 'dist'),
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    sourcemap: false,
    external: ['url'],
    define,
  });

  const contexts = [bgCtx, offscreenCtx, otherCtx];

  // Type-strip the adapter (unbundled, standalone content script)
  if (hasAdapterTs) {
    const adapterCtx = await esbuild.context({
      entryPoints: [adapterTsPath],
      outfile: path.join(__dirname, 'dist/TwitterAdapter.js'),
      bundle: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
    });
    contexts.push(adapterCtx);
  }

  if (isWatch) {
    await Promise.all(contexts.map(c => c.watch()));
    console.log(`Watching for changes... (env: ${env})`);
  } else {
    await Promise.all(contexts.map(c => c.rebuild()));
    await Promise.all(contexts.map(c => c.dispose()));

    console.log(`Build complete (env: ${env}): dist/background.js, dist/offscreen.js, dist/popup.js, dist/content.js` +
      (hasAdapterTs ? ', dist/TwitterAdapter.js' : ''));
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
