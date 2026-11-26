#!/usr/bin/env node
// Serves the built Bouncer content scripts on a local X-shaped page with
// synthetic posts and stubbed extension APIs, so feed UI can be clicked
// through without X, a browser profile or Llama.app. Build Bouncer first.
//
//   node scripts/ui-harness/serve.mjs [port]   # default 4177, loopback only
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const extension = await realpath(resolve(here, '../../Bouncer'));
const port = Number(process.argv[2] || process.env.PORT || 4177);
// Only what the page loads, never the rest of the extension folder.
const extensionFiles = ['dist/', 'adapters/', 'icons/', 'content.css', 'dompurify.js', 'popup.html', 'popup.css'];
// Another site cannot reach the server through DNS rebinding under these names.
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function extensionFile(encoded) {
  const path = posix.normalize(decodeURIComponent(encoded));
  if (!extensionFiles.some(allowed => allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed)) return null;
  // Resolve symlinks so none can lead out of the extension folder.
  const file = await realpath(join(extension, path));
  return file.startsWith(extension + sep) ? file : null;
}

async function route(pathname) {
  // Extension files load from /ext/, as chrome.runtime.getURL resolves them.
  if (pathname.startsWith('/ext/')) return extensionFile(pathname.slice(5));
  if (pathname === '/mock-chrome.js') return join(here, 'mock-chrome.js');
  // /, /home and /<user>/status/<id> all render the feed page.
  return extname(pathname) ? null : join(here, 'index.html');
}

createServer(async (request, response) => {
  if (!hosts.has(request.headers.host)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const file = await route(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!file) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(body);
  } catch (error) {
    const status = error instanceof URIError ? 400 : ['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code) ? 404 : 500;
    response.writeHead(status).end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Bouncer UI harness: http://127.0.0.1:${port}/home`);
});
