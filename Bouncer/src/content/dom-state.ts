const pendingFilteredHides = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * Schedule the fade-out's final hide in a way that can be cancelled when the
 * user disables reply filtering while classification is still settling.
 */
export function scheduleFilteredHide(
  article: HTMLElement,
  hide: () => void,
  delayMs = 300,
): void {
  cancelScheduledFilteredHide(article);
  const timer = setTimeout(() => {
    pendingFilteredHides.delete(article);
    hide();
  }, delayMs);
  pendingFilteredHides.set(article, timer);
}

export function cancelScheduledFilteredHide(article: HTMLElement): boolean {
  const timer = pendingFilteredHides.get(article);
  if (timer === undefined) return false;
  clearTimeout(timer);
  pendingFilteredHides.delete(article);
  return true;
}

/** Restore only state that Bouncer itself applied to an automatically hidden post. */
export function restoreFilteredContainer(
  container: HTMLElement,
  article?: HTMLElement,
): boolean {
  const cancelledPendingHide = article ? cancelScheduledFilteredHide(article) : false;
  const wasFiltered = container.dataset.filteredByExtension === 'true';
  if (!wasFiltered && !cancelledPendingHide) return false;

  container.style.display = '';
  container.style.opacity = '';
  container.style.transition = '';
  delete container.dataset.filteredByExtension;
  if (article) {
    article.style.opacity = '';
    article.style.transition = '';
  }
  return true;
}

export function isRendered(element: HTMLElement): boolean {
  return typeof element.checkVisibility === 'function'
    ? element.checkVisibility()
    : element.offsetParent !== null;
}
