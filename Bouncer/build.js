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

// This is a local-only fork: all cloud/remote backends (and the Firebase auth +
// Imbue websocket they needed) were removed, so there are no build-time secrets.
// HAS_IMBUE_BACKEND is hard-wired to "false" — a few inert branches in the
// content script still reference it and must resolve to a literal at build time.
const define = {
  'process.env.NODE_ENV': '"production"',
  'process.env.HAS_IMBUE_BACKEND': '"false"',
  'process.env.BOUNCER_ENV': JSON.stringify(env),
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

async function build() {
  console.log(`Building local-only (env: ${env}, target: ${target})`);

  // 0. Regenerate manifest.json from manifest.base.json + manifest.<target>.json.
  generateManifest(target);

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

  const contexts = [bgCtx, otherCtx];

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

    console.log(`Build complete (env: ${env}): dist/background.js, dist/popup.js, dist/content.js` +
      (hasAdapterTs ? ', dist/TwitterAdapter.js' : ''));
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
