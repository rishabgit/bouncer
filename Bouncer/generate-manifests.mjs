// Chrome is the sole product target. manifest.json is generated from these
// checked-in sources; preserve the Chrome key to keep the extension origin.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export function generateManifest({ root = ROOT } = {}) {
  const readJSON = filename => JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8'));
  const manifest = { ...readJSON('manifest.base.json'), ...readJSON('manifest.chrome.json') };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('Generated Chrome manifest.json');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) {
    console.error('This fork generates only a Chrome manifest; target options have been retired.');
    process.exitCode = 1;
  } else {
    generateManifest();
  }
}
