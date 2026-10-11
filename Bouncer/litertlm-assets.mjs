import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** Return the exact loader/binary pairs supported by this build target. */
export function getLitertlmAssetNames(target) {
  let stems;
  switch (target) {
    case 'chrome':
    case 'firefox':
      stems = ['litertlm_wasm_internal', 'litertlm_wasm_compat_internal'];
      break;
    case 'safari':
      stems = ['litertlm_wasm_asyncify_internal', 'litertlm_wasm_compat_asyncify_internal'];
      break;
    default:
      throw new Error(`Unknown LiteRT-LM build target: ${target}`);
  }
  return stems.flatMap(stem => [`${stem}.js`, `${stem}.wasm`]);
}

/** Copy only the target's assets; an incomplete installation fails the build. */
export function copyLitertlmAssets(srcDir, dstDir, target) {
  const names = getLitertlmAssetNames(target);
  // The destination is generated output. Remove stale variants even when the
  // source package is incomplete, so a failed build cannot retain old assets.
  rmSync(dstDir, { recursive: true, force: true });
  for (const name of names) {
    const source = path.join(srcDir, name);
    let isFile = false;
    try {
      const stat = statSync(source);
      isFile = stat.isFile() && stat.size > 0;
    } catch {
      // Report the required asset and target rather than silently skipping it.
    }
    if (!isFile) {
      throw new Error(`Missing LiteRT-LM ${target} asset: ${name}`);
    }
  }

  mkdirSync(dstDir, { recursive: true });
  try {
    for (const name of names) {
      copyFileSync(path.join(srcDir, name), path.join(dstDir, name));
    }
  } catch (error) {
    rmSync(dstDir, { recursive: true, force: true });
    throw error;
  }
  return names;
}
