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
  // Dev-only flag: gates the latency-benchmark surface so it's stripped from prod
  // bundles (the `if (__DEV__)` branch in background/index.ts becomes `if(false)`).
  '__DEV__': String(env === 'dev'),
};

const adapterTsPath = path.join(__dirname, 'adapters/twitter/TwitterAdapter.ts');
const hasAdapterTs = fs.existsSync(adapterTsPath);

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

  // dist is wholly generated. Recreate it on every build so removed engines,
  // old app bundles, and dev-only benchmark files cannot leak into a release.
  const distDir = path.join(__dirname, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  // 0. Regenerate manifest.json from manifest.base.json + manifest.<target>.json.
  generateManifest(target);

  // Copy LiteRT-LM's wasm loader + binaries into dist/litertlm-wasm/.
  copyLitertlmAssets();

  // 1. Background service worker.
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
  });

  // 2. Offscreen document bundle (Chrome): hosts LiteRT-LM's Engine. The SW
  //     opens this page on demand because the LiteRT-LM wasm loader uses
  //     script-tag injection (via @litertjs/wasm-utils), unavailable in MV3
  //     ESM service workers. @litert-lm/core is bundled in here directly; its
  //     wasm binaries are copied separately into dist/litertlm-wasm/.
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

  // 3. Popup & content: fully self-contained (no external imports). In --dev we
  //    also build the latency-benchmark page (chrome-extension://<id>/benchmark.html);
  //    it's omitted from prod builds so it can never ship.
  const otherEntries = [
    path.join(__dirname, 'popup.js'),
    path.join(__dirname, 'content.js'),
  ];
  if (env === 'dev') {
    otherEntries.push(
      path.join(__dirname, 'benchmark.js'),
      path.join(__dirname, 'gemma-comparison.js'),
    );
  }

  const otherCtx = await esbuild.context({
    entryPoints: otherEntries,
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
