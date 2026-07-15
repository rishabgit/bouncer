export const TAB_NAVIGATION_UNLOAD_GRACE_MS = 1500;

/**
 * A full page reload briefly removes the content script before document_idle
 * registers its replacement. Delay only navigation-triggered unloads so that
 * replacement can invalidate the captured lifecycle generation. Closed tabs
 * bypass this helper and unload immediately.
 */
export function scheduleNavigationUnload(
  expectedGeneration: number,
  isStillCurrent: (expectedGeneration: number) => boolean,
  unload: (expectedGeneration: number) => void,
  delayMs = TAB_NAVIGATION_UNLOAD_GRACE_MS,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (isStillCurrent(expectedGeneration)) {
      unload(expectedGeneration);
    }
  }, delayMs);
}
