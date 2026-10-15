import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function getLitertlmAssetNames(target = 'chrome') {
  if (target !== 'chrome') throw new Error(`Unknown LiteRT-LM build target: ${target}`);
  return ['litertlm_wasm_internal', 'litertlm_wasm_compat_internal'].flatMap(stem => [`${stem}.js`, `${stem}.wasm`]);
}
export function copyLitertlmAssets(srcDir, dstDir, target = 'chrome') {
  const names = getLitertlmAssetNames(target);
  rmSync(dstDir, { recursive: true, force: true });
  for (const name of names) {
    let valid = false;
    try { const stat = statSync(path.join(srcDir, name)); valid = stat.isFile() && stat.size > 0; } catch { /* missing installation */ }
    if (!valid) throw new Error(`Missing LiteRT-LM ${target} asset: ${name}`);
  }
  mkdirSync(dstDir, { recursive: true });
  try { for (const name of names) copyFileSync(path.join(srcDir, name), path.join(dstDir, name)); }
  catch (error) { rmSync(dstDir, { recursive: true, force: true }); throw error; }
  return names;
}
/** Keep SDK identity and third-party notices tied to the same installed packages. */
export function packageLitertlmRuntime(root, distDir) {
  const modules = path.join(root, 'node_modules');
  for (const [name, version] of [['@litert-lm/core', '0.17.0'], ['@litertjs/wasm-utils', '2.5.0'], ['@noble/hashes', '2.4.0']]) {
    const installed = JSON.parse(readFileSync(path.join(modules, name, 'package.json'), 'utf8'));
    if (installed.version !== version) throw new Error(`Unsupported ${name} version: expected ${version}`);
  }
  copyLitertlmAssets(path.join(modules, '@litert-lm/core/wasm'), path.join(distDir, 'litertlm-wasm'));
  const apache = readFileSync(path.join(modules, 'typescript/LICENSE.txt'), 'utf8');
  if (!apache.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')) throw new Error('Missing Apache-2.0 license notice');
  const mit = readFileSync(path.join(modules, '@noble/hashes/LICENSE'), 'utf8');
  writeFileSync(path.join(distDir, 'THIRD-PARTY-NOTICES.txt'),
    '@litert-lm/core 0.17.0 and @litertjs/wasm-utils 2.5.0\nCopyright 2026 Google LLC\nApache License 2.0\n' + apache +
    '\n\n@noble/hashes 2.4.0\n' + mit);
}
