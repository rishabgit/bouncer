import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateManifest } from './generate-manifests.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export async function build({ root = ROOT, dev = false, watch = false } = {}) {
  const env = dev ? 'dev' : 'prod';
  console.log(`Building local-only Chrome extension (env: ${env})`);

  // Recreate generated output so retired runtimes and dev bundles cannot leak
  // into the next build. Native inference uses fetch; it ships no model assets.
  const distDir = path.join(root, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  generateManifest({ root });

  const define = {
    'process.env.NODE_ENV': '"production"',
    // Actual-extension diagnostics are stripped from production bundles.
    '__DEV__': String(dev),
  };
  const entries = ['background.js', 'popup.js', 'content.js'];
  if (dev) entries.push('benchmark.js');

  const contexts = [];
  let watching = false;
  try {
    contexts.push(await esbuild.context({
      entryPoints: entries.map(entry => path.join(root, entry)),
      outdir: distDir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      minify: false,
      sourcemap: false,
      define,
    }));

    // The adapter is a standalone content script declared in the manifest.
    contexts.push(await esbuild.context({
      entryPoints: [path.join(root, 'adapters/twitter/TwitterAdapter.ts')],
      outfile: path.join(distDir, 'TwitterAdapter.js'),
      bundle: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
    }));

    if (watch) {
      await Promise.all(contexts.map(context => context.watch()));
      watching = true;
      console.log(`Watching for changes... (env: ${env})`);
    } else {
      await Promise.all(contexts.map(context => context.rebuild()));
      console.log(`Build complete (env: ${env}): ${entries.map(entry => `dist/${entry}`).join(', ')}, dist/TwitterAdapter.js`);
    }
  } finally {
    if (!watching) await Promise.all(contexts.map(context => context.dispose()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const unsupported = args.find(arg => !['--dev', '--watch'].includes(arg));
  if (unsupported) {
    console.error(`Unsupported build option: ${unsupported}. This fork builds only Chrome.`);
    process.exitCode = 1;
  } else {
    build({ dev: args.includes('--dev'), watch: args.includes('--watch') }).catch(error => {
      console.error('Build failed:', error);
      process.exitCode = 1;
    });
  }
}
