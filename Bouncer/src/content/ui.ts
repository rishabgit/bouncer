// All UI injection, modals, alerts, theming, filter phrase management

import { toBlob } from 'html-to-image';
import { asyncHandler } from '../shared/async';
import { cleanReasoning, escapeHtml, formatPostForEvaluation, parseHTML } from '../shared/utils';
import { init as initPopup } from '../popup/index';
import {
  encodeFilterPackCode, decodeFilterPackCode, buildFilterPackShareUrl,
  FILTER_PACK_SHARE_URL_REGEX,
} from '../shared/share-encoding';
import type { ContentUIDeps, FilteredPost, PostContent, LocalModelStatus } from '../types';
import { getStorage, getDescriptions, setDescriptions } from '../shared/storage';
import { PREDEFINED_MODELS } from '../shared/models';

// Dependencies (set by initUI from index.ts)
let _deps: ContentUIDeps;

export function initUI(deps: ContentUIDeps) {
  _deps = deps;

  // Safari re-injects content scripts when the user changes extension
  // permissions on a tab that's already loaded. The new injection has a
  // fresh module scope, so its filter-container variables are null and the
  // injection guards think no box exists — resulting in duplicate UI.
  // Proactively remove any leftover boxes from a prior injection.
  const stale = document.querySelectorAll(
    '.filter-phrases-sidebar, .filter-phrases-bottom, .filter-phrases-mobile'
  );
  console.log('[Bouncer] initUI: clearing', stale.length, 'stale filter box(es) from prior injection');
  stale.forEach((el) => el.remove());

  // Register the single page-wide tooltip-dismissal listener (replaces a
  // per-post capture-phase listener that used to accumulate with each post).
  setupAnnoyingTooltipCloser();
}

// ==================== UI State ====================

// Filtered posts storage
const filteredPosts: FilteredPost[] = [];
const filteredPostKeys = new Set<string>();

let filteredTabActive = false;
let filteredModalBackdrop: HTMLElement | null = null;
let filteredViewContainer: HTMLElement | null = null;
let filterPhrasesContainer: HTMLElement | null = null;
let bottomFilterContainer: HTMLElement | null = null;
let mobileFilterContainer: HTMLElement | null = null;
let bottomFilterExpanded = true;
let settingsModal: HTMLElement | null = null;


let activePopup: HTMLElement | null = null;
let activePopupArticle: HTMLElement | null = null;
// Persists across in-place re-renders so the user's tab selection isn't lost
// when a late-arriving detectorResponse triggers a refresh.
let activePopupTab: string | null = null;
const annoyingReasonsCache: WeakMap<HTMLElement, Promise<{ reasons: string[]; hadImages?: boolean }>> = new WeakMap();

// Track previous count for animation
let previousFilteredCount = 0;

// Feed-level model-status indicator (bottom-left, theme-aware): one state-driven
// element shown when the local model isn't ready to classify. See updateModelStatusIndicator.
let modelStatusEl: HTMLElement | null = null;
let modelStatusDismissed: ModelUiState | null = null; // derived state the user dismissed

// ==================== Update Banner ====================

// ==================== Placeholder animation ====================

const PLACEHOLDER_PHRASES = ['politics', 'negativity', 'pessimism', 'political outrage', 'ragebait', 'humblebragging', 'virtue signaling', 'idolizing elites', 'Elon Musk'];
const PLACEHOLDER_DURATION = 10; // seconds for full cycle

// Build placeholder HTML and inject dynamic keyframes once
const placeholderItemsHTML = [...PLACEHOLDER_PHRASES, PLACEHOLDER_PHRASES[0]]
  .map(p => `<span>${p}</span>`).join('');
const placeholderHTML = `<span class="filter-input-wrapper"><input type="text" class="filter-phrases-input"><span class="filter-placeholder-cycle" aria-hidden="true"><span class="filter-placeholder-track">${placeholderItemsHTML}</span></span></span>`;

function injectPlaceholderKeyframes() {
  const n = PLACEHOLDER_PHRASES.length;
  const step = 100 / n;
  const holdPct = 0.8; // fraction of each step spent holding
  const frames: string[] = [];
  for (let i = 0; i < n; i++) {
    const start = step * i;
    const holdEnd = start + step * holdPct;
    frames.push(`${start}%, ${holdEnd}% { transform: translateY(calc(-1.2em * ${i})); }`);
  }
  frames.push(`100% { transform: translateY(calc(-1.2em * ${n})); }`);
  const style = document.createElement('style');
  const duration = (PLACEHOLDER_DURATION / 5) * n; // scale with phrase count
  style.textContent = `
    @keyframes ff-placeholder-scroll { ${frames.join(' ')} }
    .filter-placeholder-track { animation-duration: ${duration}s; }
  `;
  document.head.appendChild(style);
}

// Inject keyframes on load
injectPlaceholderKeyframes();

// X-style share-up icon used by the circular share button on the actions row.
const shareIconSVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g><path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"></path></g></svg>';

// X-style horizontal ellipsis icon used by the settings button on the actions row.
const settingsIconSVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g><path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"></path></g></svg>';

// ==================== State Accessors ====================

export function getFilteredPosts() { return filteredPosts; }
export function getFilteredTabActive() { return filteredTabActive; }

// ==================== Filtered Posts ====================

export function clearFilteredPosts() {
  filteredPosts.length = 0;
  filteredPostKeys.clear();
  updateFilteredTabCount();
  // Re-render filtered view if it's currently showing
  if (filteredTabActive && filteredViewContainer) {
    const content = filteredViewContainer.querySelector('.filtered-modal-content');
    if (content) renderFilteredPostsView(content);
  }
}

// ==================== Theme ====================

export function updateTheme() {
  const theme = _deps.adapter.getThemeMode();
  const iosFilteredModal = document.querySelector('.ff-ios-filtered-modal-backdrop');
  const iosPageContainer = _deps.getIOSPageContainer();
  const elements = [filterPhrasesContainer, filteredViewContainer, bottomFilterContainer, mobileFilterContainer, iosPageContainer, iosFilteredModal].filter(Boolean) as Element[];

  for (const el of elements) {
    el.classList.remove('light-mode', 'dim-mode', 'dark-mode');
    el.classList.add(`${theme}-mode`);
  }

  // Also update the document element for CSS selectors that need it
  document.documentElement.classList.remove('twitter-light', 'twitter-dim', 'twitter-dark');
  document.documentElement.classList.add(`twitter-${theme}`);
}

// ==================== Sidebar Filter ====================

function updateSidebarFilterVisibility() {
  if (!filterPhrasesContainer || !filterPhrasesContainer.isConnected) return;

  if (!_deps.adapter.shouldProcessCurrentPage()) {
    filterPhrasesContainer.remove();
    filterPhrasesContainer = null;
  }
}

function buildFilterContainerHTML(): string {
  return `
    <div class="filter-phrases-container">
      <div class="filter-phrases-title-row">
        <span class="filter-phrases-box-name">Bouncer</span>
      </div>
      <div class="filter-phrases-header">
        <span class="filter-phrases-label">Filter out</span>
        <span class="filter-phrases-list"></span>
        <span class="filter-phrases-and-input">
          <span class="filter-phrases-and">and</span>
          ${placeholderHTML}
        </span>
      </div>
      <div class="filter-model-loading" style="display: none;">
        <div class="model-loading-text">Loading model...</div>
        <div class="model-loading-progress">
          <div class="model-loading-progress-fill"></div>
        </div>
      </div>
      <div class="filter-phrases-actions">
        <div class="filter-phrases-actions-left">
          <button class="filtered-toggle-btn">
            <span class="filtered-toggle-text">View filtered</span>
            <span class="filtered-toggle-count">(0)</span>
          </button>
        </div>
        <div class="filter-phrases-actions-right">
          <button class="filter-pack-share-btn" type="button" aria-label="Share your filters">${shareIconSVG}</button>
          <button class="filter-settings-btn" type="button" aria-label="Settings">${settingsIconSVG}</button>
        </div>
      </div>
    </div>
  `;
}

// Mirrors Twitter's fixed search-bar pattern. The filter box is `position: fixed`
// so it doesn't scroll with the page; we set width/left inline to match the
// sidebar wrapper, and add a sibling spacer whose height tracks the filter box
// so flow content (Premium, News) doesn't slide under us at scroll=0.
function setupFixedInWrapper(filterBox: HTMLElement, wrapper: HTMLElement): void {
  const spacer = document.createElement('div');
  spacer.className = 'filter-phrases-sidebar-spacer';
  spacer.setAttribute('aria-hidden', 'true');
  filterBox.after(spacer);

  // Spacer is box height + a small gap. On Home, Twitter's search-bar
  // placeholder sits in flow above the box and absorbs the area between the
  // viewport top and the box's `top: 70px`; on Explore there's no placeholder
  // so we reserve ~70px more ourselves. Probe `hasSearchBar` live so SPA
  // navigation between Home and Explore swaps the gap correctly (the
  // wrapper-childList observer below re-runs this when Twitter mutates).
  const syncSpacerHeight = () => {
    const hasSearchBar = !!wrapper.querySelector('[data-testid="SearchBox_Search_Input"]');
    const gapBelow = hasSearchBar ? 17 : 87;
    spacer.style.height = `${filterBox.offsetHeight + gapBelow}px`;
  };
  const syncBoxPosition = () => {
    const rect = wrapper.getBoundingClientRect();
    filterBox.style.left = `${rect.left}px`;
    filterBox.style.width = `${rect.width}px`;
    // Wrapper's vertical position relative to viewport can change too (window
    // resize, header collapse), which affects the spacer height calculation.
    syncSpacerHeight();
  };
  syncSpacerHeight();
  syncBoxPosition();
  // Layout may not have settled when we measure synchronously inside a
  // MutationObserver callback (e.g. during SPA navigation, the box's content
  // hasn't laid out yet so its bounding-rect height is 0). Re-measure once a
  // frame after the browser has a chance to do layout.
  requestAnimationFrame(syncSpacerHeight);

  const boxResize = new ResizeObserver(syncSpacerHeight);
  boxResize.observe(filterBox);
  const wrapperResize = new ResizeObserver(syncBoxPosition);
  wrapperResize.observe(wrapper);
  // Wrapper's `left` can change without its size changing (window resize that
  // doesn't change the sidebar width but shifts it horizontally, e.g. when
  // the primary column gets narrower). Listen for window resize too.
  window.addEventListener('resize', syncBoxPosition);

  // Watch the wrapper's children: disconnect when our box leaves the DOM, and
  // otherwise re-sync the spacer. Twitter populates the wrapper asynchronously
  // on SPA navigation (e.g. Home → Explore → Home), so siblings can appear or
  // disappear around our spacer after we've already sized it — without this,
  // a stale measurement leaves news/premium content peeking under the box.
  const lifecycle = new MutationObserver(() => {
    if (!filterBox.isConnected) {
      boxResize.disconnect();
      wrapperResize.disconnect();
      lifecycle.disconnect();
      window.removeEventListener('resize', syncBoxPosition);
      spacer.remove();
      return;
    }
    syncSpacerHeight();
  });
  lifecycle.observe(filterBox.parentNode!, { childList: true });
}

// Twitter's right-sidebar wrapper that holds the scrolling content (Premium,
// News, Trending). On the Home page it also contains the fixed search bar at
// the top; on Explore the search bar lives in the main column instead, but the
// same wrapper is still the first child of sidebarContent. Returns the first
// non-Bouncer child of sidebarContent.
function findSidebarWrapper(sidebarContent: Element): HTMLElement | null {
  for (const child of Array.from(sidebarContent.children)) {
    if (child instanceof HTMLElement
        && !child.classList.contains('filter-phrases-sidebar')) {
      return child;
    }
  }
  return null;
}

export function injectFilterPhrasesInput() {
  const existingInDom = document.querySelectorAll('.filter-phrases-sidebar').length;
  // Adopt any existing node in the DOM (may have been created by a previous
  // content-script injection whose module state is gone).
  if (!filterPhrasesContainer || !filterPhrasesContainer.isConnected) {
    filterPhrasesContainer = document.querySelector<HTMLElement>('.filter-phrases-sidebar');
  }
  if (filterPhrasesContainer && filterPhrasesContainer.isConnected) {
    console.log('[Bouncer] injectFilterPhrasesInput: adopting existing box (DOM count=', existingInDom, ')');
    updateSidebarFilterVisibility();
    return;
  }
  console.log('[Bouncer] injectFilterPhrasesInput: will create new box (DOM count before=', existingInDom, ')');

  // Don't inject on non-applicable pages
  if (!_deps.adapter.shouldProcessCurrentPage()) return;

  const sidebar = document.querySelector(_deps.adapter.selectors.sidebar);
  if (!sidebar) return;
  const sidebarContent = _deps.adapter.selectors.sidebarContent
    ? sidebar.querySelector(_deps.adapter.selectors.sidebarContent)
    : sidebar;
  if (!sidebarContent) return;

  // Preferred target: inside the sidebar wrapper so our z-index can sit between
  // the fixed search bar (z=2, Home only) and scrolling content (z=0). Falls
  // back to the top of sidebarContent if the wrapper can't be found.
  const wrapper = findSidebarWrapper(sidebarContent);
  let insertParent: Element;
  let insertBeforeRef: Node | null;
  let usingWrapper = false;
  if (wrapper) {
    // When the wrapper contains Twitter's fixed search bar (Home), insert AFTER
    // the search bar (children[0]) and its 53px spacer (children[1]) — i.e. as
    // the third child, before the Premium card. On Explore the search bar is
    // in the main column, so insert at the top of the wrapper.
    const hasSearchBar = !!wrapper.querySelector('[data-testid="SearchBox_Search_Input"]');
    const children = Array.from(wrapper.children);
    insertParent = wrapper;
    insertBeforeRef = hasSearchBar ? (children[2] ?? null) : (children[0] ?? null);
    usingWrapper = true;
  } else {
    insertParent = sidebarContent;
    insertBeforeRef = sidebarContent.firstChild;
  }
  // Create the filter phrases container
  filterPhrasesContainer = document.createElement('div');
  filterPhrasesContainer.className = usingWrapper
    ? 'filter-phrases-sidebar filter-phrases-sidebar--in-wrapper'
    : 'filter-phrases-sidebar';

  filterPhrasesContainer.replaceChildren(parseHTML(buildFilterContainerHTML()));

  // Insert at the chosen target (inside the wrapper, or fallback at top of sidebarContent)
  insertParent.insertBefore(filterPhrasesContainer, insertBeforeRef);
  if (usingWrapper && wrapper) setupFixedInWrapper(filterPhrasesContainer, wrapper);

  // Apply theme and update count
  updateTheme();
  updateFilteredTabCount();

  setupFilterBoxEventHandlers(filterPhrasesContainer);

  // Update visibility based on current page
  updateSidebarFilterVisibility();
}

// Common event handler setup for filter boxes (sidebar and bottom)
function setupFilterBoxEventHandlers(container: HTMLElement) {
  // Idempotency guard: a re-entrant inject (e.g. handleDOMMutation firing
  // mid-refresh) would otherwise attach two click handlers and every user
  // click would toggle the filtered modal on then immediately off.
  if ((container as HTMLElement & { __ffWired?: boolean }).__ffWired) return;
  (container as HTMLElement & { __ffWired?: boolean }).__ffWired = true;

  const phrasesListContainer = container.querySelector('.filter-phrases-list')!;
  const input = container.querySelector<HTMLInputElement>('.filter-phrases-input')!;
  const placeholderCycle = container.querySelector('.filter-placeholder-cycle');
  const toggleBtn = container.querySelector('.filtered-toggle-btn:not(.filter-pack-toggle-btn)')!;
  const settingsBtn = container.querySelector('.filter-settings-btn')!;

  // Show/hide animated placeholder based on input state and existing phrases
  function updatePlaceholderVisibility() {
    if (!placeholderCycle) return;
    const hasPhrases = phrasesListContainer.children.length > 0;
    const hasText = input.value.length > 0;
    placeholderCycle.classList.toggle('hidden', hasPhrases || hasText);
  }
  input.addEventListener('input', updatePlaceholderVisibility);

  // Settings button click
  settingsBtn.addEventListener('click', () => showSettingsModal());

  // Toggle filtered view on button click
  toggleBtn.addEventListener('click', () => {
    toggleFilteredTab(!filteredTabActive);
    updateFilteredToggleButtons();
  });

  // "Share filters" button triggers the share flow
  const shareBtn = container.querySelector<HTMLButtonElement>('.filter-pack-share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      shareFilterPack(container).catch(err => console.error('[UI] shareFilterPack failed:', err));
    });
  }

  // Load and render saved descriptions
  getDescriptions(_deps.descriptionsKey).then((descriptions) => {
    if (descriptions.length > 0) {
      renderPhrasesInContainer(phrasesListContainer, descriptions);
    }
  }).catch(err => console.error('[UI] Failed to load descriptions:', err));

  // Enter or comma key to add phrase
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      (async () => {
        const added = await addFilterPhrase(input.value.trim());
        if (added) input.value = '';
        updatePlaceholderVisibility();
      })().catch(err => console.error('[UI] filter phrase keypress handler failed:', err));
    }
  });

  // Handle pasting comma-separated lists
  input.addEventListener('paste', (e) => {
    const pasted = e.clipboardData!.getData('text');
    if (pasted.includes(',')) {
      e.preventDefault();
      (async () => {
        const phrases = pasted.split(',').map(s => s.trim()).filter(Boolean);
        for (const phrase of phrases) {
          await addFilterPhrase(phrase);
        }
        input.value = '';
        updatePlaceholderVisibility();
      })().catch(err => console.error('[UI] filter phrase paste handler failed:', err));
    }
  });

  // Update visibility based on current page
  updateSidebarFilterVisibility();
}

// ==================== Bottom Filter ====================

function toggleBottomFilter(expanded: boolean) {
  bottomFilterExpanded = expanded;

  if (bottomFilterContainer) {
    if (expanded) {
      bottomFilterContainer.classList.add('expanded');
      bottomFilterContainer.classList.remove('collapsed');
    } else {
      bottomFilterContainer.classList.remove('expanded');
      bottomFilterContainer.classList.add('collapsed');
    }
  }
}

function updateBottomFilterPosition() {
  if (!bottomFilterContainer || !bottomFilterContainer.isConnected) return;

  const primaryColumn = document.querySelector(_deps.adapter.selectors.primaryColumn);
  if (primaryColumn) {
    const style = window.getComputedStyle(primaryColumn);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderRight = parseFloat(style.borderRightWidth) || 0;
    const rect = primaryColumn.getBoundingClientRect();

    bottomFilterContainer.style.left = (rect.left + borderLeft) + 'px';
    bottomFilterContainer.style.width = (rect.width - borderLeft - borderRight) + 'px';
  }
}

function updateBottomFilterVisibility() {
  if (!bottomFilterContainer || !bottomFilterContainer.isConnected) return;

  if (!_deps.adapter.shouldProcessCurrentPage()) {
    bottomFilterContainer.remove();
    bottomFilterContainer = null;
  }
}

export function injectBottomFilterBox() {
  if (_deps.IS_IOS) return;
  const existingInDom = document.querySelectorAll('.filter-phrases-bottom').length;
  // Adopt any existing node left by a previous injection
  if (!bottomFilterContainer || !bottomFilterContainer.isConnected) {
    bottomFilterContainer = document.querySelector<HTMLElement>('.filter-phrases-bottom');
  }
  if (bottomFilterContainer && bottomFilterContainer.isConnected) {
    console.log('[Bouncer] injectBottomFilterBox: adopting existing box (DOM count=', existingInDom, ')');
    updateBottomFilterVisibility();
    return;
  }

  // Don't inject on non-applicable pages
  if (!_deps.adapter.shouldProcessCurrentPage()) return;

  // Create the bottom filter container - just the pill itself
  bottomFilterContainer = document.createElement('div');
  bottomFilterContainer.className = 'filter-phrases-bottom expanded';

  bottomFilterContainer.replaceChildren(parseHTML(`
    <div class="filter-collapse-handle">
      <span class="filter-collapse-chevron"></span>
    </div>
    ${buildFilterContainerHTML()}
  `));

  // Append to body
  document.body.appendChild(bottomFilterContainer);

  // Position to match primary column and check visibility
  updateBottomFilterPosition();
  updateBottomFilterVisibility();
  // Update position on resize
  window.addEventListener('resize', updateBottomFilterPosition);
  // Also update position and visibility periodically (for SPA navigation that changes layout)
  const positionInterval = setInterval(() => {
    if (!bottomFilterContainer || !bottomFilterContainer.isConnected) {
      clearInterval(positionInterval);
      return;
    }
    updateBottomFilterPosition();
    updateBottomFilterVisibility();
  }, 500);

  // Apply theme and update count
  updateTheme();
  updateFilteredTabCount();

  setupFilterBoxEventHandlers(bottomFilterContainer);

  // Toggle expand/collapse when clicking the collapse handle
  const collapseHandle = bottomFilterContainer.querySelector('.filter-collapse-handle')!;
  collapseHandle.addEventListener('click', () => {
    toggleBottomFilter(!bottomFilterExpanded);
  });
}

// ==================== Mobile Filter ====================

function updateMobileFilterVisibility() {
  if (!mobileFilterContainer || !mobileFilterContainer.isConnected) return;

  if (!_deps.adapter.shouldProcessCurrentPage()) {
    mobileFilterContainer.remove();
    mobileFilterContainer = null;
  }
}

export function injectMobileFilterBox() {
  if (_deps.IS_IOS) return;
  const existingInDom = document.querySelectorAll('.filter-phrases-mobile').length;
  // Adopt any existing node left by a previous injection
  if (!mobileFilterContainer || !mobileFilterContainer.isConnected) {
    mobileFilterContainer = document.querySelector<HTMLElement>('.filter-phrases-mobile');
  }
  if (mobileFilterContainer && mobileFilterContainer.isConnected) {
    console.log('[Bouncer] injectMobileFilterBox: adopting existing box (DOM count=', existingInDom, ')');
    updateMobileFilterVisibility();
    return;
  }

  // Don't inject on non-applicable pages
  if (!_deps.adapter.shouldProcessCurrentPage()) return;

  // Find the navigation element
  const nav = document.querySelector(_deps.adapter.selectors.nav);
  if (!nav) return;

  // Create the mobile filter container
  mobileFilterContainer = document.createElement('div');
  mobileFilterContainer.className = 'filter-phrases-mobile';

  mobileFilterContainer.replaceChildren(parseHTML(buildFilterContainerHTML()));

  // Insert before the navigation element
  nav.parentNode!.insertBefore(mobileFilterContainer, nav);

  // Apply theme and update count
  updateTheme();
  updateFilteredTabCount();

  setupFilterBoxEventHandlers(mobileFilterContainer);

  // Update visibility based on current page
  updateMobileFilterVisibility();
}

// ==================== Filter Phrases ====================

export function syncFilterPhrases() {
  getDescriptions(_deps.descriptionsKey).then((descriptions) => {

    // Update desktop/tablet/mobile containers
    [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer].forEach(container => {
      if (container && container.isConnected) {
        const phrasesListContainer = container.querySelector('.filter-phrases-list');
        if (phrasesListContainer) {
          renderPhrasesInContainer(phrasesListContainer, descriptions);
        }
      }
    });

    // Update iOS overlay categories if visible
    const iosPageContainer = _deps.getIOSPageContainer();
    if (iosPageContainer && iosPageContainer.isConnected) {
      _deps.renderIOSCategories(iosPageContainer);
    }
  }).catch(err => console.error('[UI] Failed to sync filter phrases:', err));
}

// ==================== Share Filter Pack ====================



let sharingFilterPackInProgress = false;

async function shareFilterPack(container: HTMLElement): Promise<void> {
  if (sharingFilterPackInProgress) return;
  sharingFilterPackInProgress = true;

  const box = container.querySelector<HTMLElement>('.filter-phrases-container');
  if (!box) { sharingFilterPackInProgress = false; return; }

  try {
    const file = await screenshotFilterBox(box);
    const sharedPhrases = await getDescriptions(_deps.descriptionsKey);
    const shareCode = await encodeFilterPackCode({ phrases: sharedPhrases });
    await openComposerWithImage(file, shareCode);
  } catch (err) {
    console.error('[Bouncer] shareFilterPack error:', err);
  } finally {
    sharingFilterPackInProgress = false;
  }
}

async function screenshotFilterBox(box: HTMLElement): Promise<File> {
  box.classList.add('ff-capture');
  let blob: Blob | null;
  try {
    blob = await toBlob(box, {
      pixelRatio: Math.max(window.devicePixelRatio || 1, 3),
      cacheBust: true,
    });
  } finally {
    box.classList.remove('ff-capture');
  }
  if (!blob) throw new Error('html-to-image returned null');
  return new File([blob], 'bouncer-filter-pack.png', { type: 'image/png' });
}

// iOS variant: there's no visible filter card on x.com when the iOS app's
// native sheet is the user's filter UI. We render an off-screen replica of
// the desktop card, screenshot it, and feed it into the same composer-paste
// flow the desktop "Share filters" button uses. The screenshot needs to look
// like what a desktop user would share, so we reuse buildFilterContainerHTML
// + the renderPhrasesInContainer pill rendering.
export async function shareFilterPackForIOS(): Promise<void> {
  if (sharingFilterPackInProgress) return;
  sharingFilterPackInProgress = true;
  try {
    await runShareFilterPackForIOS();
  } finally {
    sharingFilterPackInProgress = false;
  }
}

async function runShareFilterPackForIOS(): Promise<void> {
  const phrases = await getDescriptions(_deps.descriptionsKey);
  if (phrases.length === 0) throw new Error('No phrases to share');

  // Off-screen wrapper carries the theme class so .light-mode/.dark-mode
  // descendant selectors in content.css resolve correctly. position:fixed +
  // far-negative left keeps it out of the viewport without display:none,
  // which html-to-image needs in order to compute layout.
  //
  // Deliberately NOT using the .filter-phrases-sidebar/-bottom/-mobile class
  // here — content.css hides those on body.ff-ios, which would zero out the
  // screenshot. Side effect: the font-family rule at the top of content.css
  // is scoped to those same classes, so we inline the same stack here so the
  // screenshot doesn't fall back to the browser's serif default.
  const theme = _deps.adapter.getThemeMode();
  const wrapper = document.createElement('div');
  wrapper.className = `${theme}-mode`;
  wrapper.style.position = 'fixed';
  wrapper.style.left = '-10000px';
  wrapper.style.top = '0';
  // 320px clipped the right-aligned "Settings" button at the desktop card's
  // gap+padding budget. 380px gives the actions row enough horizontal space
  // for "View filtered (N)" + "Share filters" + "Settings" without overflow.
  wrapper.style.width = '380px';
  wrapper.style.zIndex = '-1';
  wrapper.style.pointerEvents = 'none';
  wrapper.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  wrapper.replaceChildren(parseHTML(buildFilterContainerHTML()));

  const list = wrapper.querySelector<HTMLElement>('.filter-phrases-list');
  if (list) renderPhrasesInContainer(list, phrases);

  document.body.appendChild(wrapper);
  try {
    const box = wrapper.querySelector<HTMLElement>('.filter-phrases-container');
    if (!box) throw new Error('Off-screen filter container missing');
    const file = await screenshotFilterBox(box);
    const shareCode = await encodeFilterPackCode({ phrases });
    await openComposerOnMobile(file, shareCode);
  } finally {
    wrapper.remove();
  }
}

// Mobile X (iPhone WebView UA) renders the composer as a real <textarea>
// instead of the desktop DraftJS contenteditable, with no [role="dialog"]
// wrapper. Synthetic ClipboardEvents that work on the desktop composer don't
// update the textarea's React-tracked value, and the textarea won't accept
// pasted images at all. Set the value through the prototype's native setter
// (so React's value tracker sees the change) and attach the screenshot via
// the composer's hidden file input.
async function openComposerOnMobile(file: File, shareCode: string): Promise<void> {
  const composeLink = document.querySelector<HTMLElement>('a[href="/compose/post"]');
  if (!composeLink) throw new Error('Compose link not found on page');
  composeLink.click();

  const textbox = await waitForElement<HTMLTextAreaElement>('textarea[data-testid="tweetTextarea_0"]', 5000);
  if (!textbox) throw new Error('Compose textarea did not appear');

  // Image first: posting media after text on mobile X sometimes scrolls the
  // textarea on insertion, which can blur input focus mid-flow.
  await attachImageToMobileComposer(file);

  textbox.focus();
  const captionWithCode = `${SHARE_TWEET_TEXT}\n\n${buildFilterPackShareUrl(shareCode)}`;
  setReactTextareaValue(textbox, captionWithCode);
  textbox.dispatchEvent(new Event('input', { bubbles: true }));
}

// Update a React-controlled textarea's value via its prototype's native
// setter so React's value tracker registers the change. Direct assignment
// to .value is silently overwritten on the next render.
function setReactTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (desc?.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
}

// Mobile X exposes a hidden <input type="file"> that the media button proxies
// through. Setting `.files` via DataTransfer + dispatching change is the same
// path that native picker → upload flow takes.
async function attachImageToMobileComposer(file: File): Promise<void> {
  const fileInput = await waitForElement<HTMLInputElement>(
    'input[type="file"][data-testid="fileInput"], input[type="file"][accept*="image"]',
    3000
  );
  if (!fileInput) {
    console.warn('[Bouncer] Mobile composer file input not found — text-only share');
    return;
  }
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  // Give X's media-attach pipeline a tick to ingest the file before we move on
  // to setting the textarea value, which can otherwise race with the upload
  // taking focus.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

// Open the X composer and drop the image into it via a synthetic paste event
// on the composer's contenteditable. X's DraftJS composer runs its paste handler
// on any ClipboardEvent whose clipboardData carries a File, which is the same
// code path as a real Cmd-V of an image — so we just drive that path directly
// instead of fighting with React-controlled <input type="file"> semantics.
const SHARE_TWEET_TEXT = 'I use Bouncer to remove this from my feed.';

async function openComposerWithImage(file: File, shareCode: string): Promise<void> {
  // Click the sidebar Post link the same way a user would — this triggers X's
  // React Router to open the composer as a modal overlay.
  const composeLink = document.querySelector<HTMLElement>('a[href="/compose/post"]');
  if (!composeLink) throw new Error('Compose link not found on page');
  composeLink.click();

  // Scope to the modal dialog — on /home there's also an inline "What's
  // happening?" composer with the same tweetTextarea_0 testid earlier in the
  // DOM, which would otherwise win the querySelector race and steal the paste.
  const textbox = await waitForElement<HTMLElement>('[role="dialog"] [data-testid="tweetTextarea_0"]', 5000);
  if (!textbox) throw new Error('Compose textbox did not appear');

  textbox.focus();

  // Paste image first, then text — DraftJS' paste handler is more reliable
  // with one data type at a time than with a combined file + text/plain
  // payload, which some builds only read one of.
  const imageDt = new DataTransfer();
  imageDt.items.add(file);
  textbox.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: imageDt,
    bubbles: true,
    cancelable: true,
  }));

  // Let DraftJS finish ingesting the image before the text paste — mixing the
  // two synchronously can make the text land inside the media-attach flow.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  textbox.focus();
  const shareUrl = buildFilterPackShareUrl(shareCode);
  const captionWithCode = `${SHARE_TWEET_TEXT}\n\n${shareUrl}`;
  const textDt = new DataTransfer();
  textDt.setData('text/plain', captionWithCode);
  textbox.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: textDt,
    bubbles: true,
    cancelable: true,
  }));
}

function waitForElement<T extends Element>(selector: string, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector<T>(selector);
    if (existing) { resolve(existing); return; }
    const observer = new MutationObserver(() => {
      const el = document.querySelector<T>(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

// ==================== Import Shared Filter Packs ====================

// Tracks tweetText elements we've already swapped a button into so MutationObservers
// don't re-wrap on every React re-render. WeakMap auto-cleans when the tweet element
// leaves the DOM (recycled by Twitter's virtualizer).
const processedImportElements = new WeakSet<HTMLElement>();

// Scan a tweet's text for an imbue.com filter-pack share URL and, if found,
// replace the link (and its leading sentence) with a compact "Import filter
// pack" button. No-op if the tweet has no link or we've already handled it.
export function processImportCodeInPost(article: HTMLElement): void {
  const tweetTextEls = article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]');
  for (const tweetText of tweetTextEls) {
    if (processedImportElements.has(tweetText)) continue;
    const found = findFirstImportLink(tweetText);
    if (!found) {
      // No link in the visible text, but the sentence's opening words might
      // still be visible before a "Show more" truncation — if so, click it so
      // the full tweet (with the link) lands in the DOM and the next observer
      // pass picks it up. We don't mark processedImportElements here, on
      // purpose, so re-scanning works after X re-renders the expanded text.
      maybeExpandForImportCode(article, tweetText);
      continue;
    }
    processedImportElements.add(tweetText);
    // Decode async; if decoding fails we leave the original text alone.
    decodeFilterPackCode(found.code).then((pack) => {
      if (!pack) return;
      if (!tweetText.isConnected || !found.link.isConnected) return;
      swapImportSentenceForButton(found.link, pack.phrases);
    }).catch((err) => console.error('[Bouncer] decodeFilterPackCode failed:', err));
  }
}

// Derive a short signature from SHARE_TWEET_TEXT — the prose the share flow
// always writes before the link — so a partial view (truncated by X's "Show
// more") is still recognizable as the share format and worth expanding. First
// four words are distinctive enough to avoid accidental matches.
const IMPORT_SENTENCE_SIGNATURE = SHARE_TWEET_TEXT.split(' ').slice(0, 4).join(' ');

function maybeExpandForImportCode(article: HTMLElement, tweetText: HTMLElement): void {
  const visible = tweetText.textContent || '';
  if (!visible.includes(IMPORT_SENTENCE_SIGNATURE)) return;
  const showMore = article.querySelector<HTMLElement>('[data-testid="tweet-text-show-more-link"]');
  if (!showMore) return;
  // One-shot per article — don't re-click if the first expansion already
  // happened (even if the re-rendered DOM somehow still includes a "Show more").
  if (article.dataset.bouncerExpandedForImport) return;
  article.dataset.bouncerExpandedForImport = '1';
  showMore.click();

  // X expands the tweet by mutating text nodes inside the existing tweetText
  // element. Our page-level MutationObserver filters to ELEMENT_NODE additions
  // so it misses those, which is why the button didn't appear after the first
  // click. Poll the article for a short window and re-run the transform until
  // the import button lands (or we time out if the expansion never happens —
  // e.g. X navigated to the status page instead).
  let attempts = 0;
  const tick = () => {
    if (++attempts > 30) return; // ~3s at 100ms per tick
    if (!article.isConnected) return;
    if (article.querySelector('.bouncer-import-btn')) return;
    processImportCodeInPost(article);
    setTimeout(tick, 100);
  };
  setTimeout(tick, 50);
}

// Scan <a> elements within `root` for an imbue.com filter-pack share URL.
// Twitter splits the rendered URL across plain text and aria-hidden spans, but
// `innerText` reads them all back as a single string (with stray newlines from
// the inline-block layout that we strip before matching).
function findFirstImportLink(
  root: HTMLElement,
): { code: string; link: HTMLAnchorElement } | null {
  const links = root.querySelectorAll<HTMLAnchorElement>('a');
  for (const link of links) {
    const text = (link.innerText || '').replace(/\n/g, '');
    const m = FILTER_PACK_SHARE_URL_REGEX.exec(text);
    if (m) return { code: m[1], link };
  }
  return null;
}

// Replace the share <a> with the Import button and trim surrounding whitespace
// / <br>s so the button doesn't float on its own line with a visually empty
// gap above. The tweet's preceding prose stays untouched.
function swapImportSentenceForButton(
  link: HTMLAnchorElement,
  phrases: string[],
): void {
  const parent = link.parentNode;
  if (!parent) return;

  const btn = buildImportButton(phrases);
  parent.replaceChild(btn, link);

  // Clean up leading whitespace / <br>s immediately before the button.
  let prev = btn.previousSibling;
  while (prev) {
    if (prev.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === 'BR') {
      const toRemove = prev;
      prev = prev.previousSibling;
      toRemove.parentNode?.removeChild(toRemove);
      continue;
    }
    if (prev.nodeType === Node.TEXT_NODE) {
      const t = prev as Text;
      const trimmed = t.data.replace(/\s+$/, '');
      if (trimmed.length < t.data.length) t.data = trimmed;
      if (t.data.length === 0) {
        const toRemove = t;
        prev = t.previousSibling;
        toRemove.parentNode?.removeChild(toRemove);
        continue;
      }
    }
    break;
  }
}

function buildImportButton(phrases: string[]): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bouncer-import-btn';
  btn.setAttribute('aria-label', 'Import filter pack');
  const phraseCount = phrases.length;
  btn.replaceChildren(parseHTML(`<span>Import filter pack</span><span class="bouncer-import-btn-meta">${phraseCount} ${phraseCount === 1 ? 'phrase' : 'phrases'}</span>`));
  btn.addEventListener('click', (e) => {
    // Stop the click from falling through to the tweet's own click handler
    // (which would navigate into the tweet's permalink page).
    e.stopPropagation();
    e.preventDefault();
    const article = btn.closest<HTMLElement>('article');
    flyScreenshotAndImport(article, phrases).catch((err) =>
      console.error('[Bouncer] import failed:', err),
    );
  });
  return btn;
}

// Three Bouncer layout variants live in the DOM at all times — sidebar (wide),
// bottom (medium), mobile (narrow) — and media queries display:none all but
// one. Returns the variant that's currently rendered so the import-flight
// animation lands on a real, on-screen box. offsetParent is null when the
// element or any ancestor is display:none, which is the rule the media-query
// gating relies on.
function pickVisibleBouncerLayout(): HTMLElement | null {
  const layouts = document.querySelectorAll<HTMLElement>(
    '.filter-phrases-sidebar, .filter-phrases-bottom, .filter-phrases-mobile',
  );
  for (const layout of layouts) {
    if (layout.offsetParent !== null) return layout;
  }
  return null;
}

// Animate the tweet's screenshot image flying into the user's Bouncer box,
// then run the actual import. The flight takes ~700ms; we kick the storage
// writes off in parallel so the new phrases land in the box right as the
// flier dissolves into it. Falls back to a plain import (no animation) if we
// can't find either the source image or the destination box.
async function flyScreenshotAndImport(
  article: HTMLElement | null,
  phrases: string[],
): Promise<void> {
  console.log('[Bouncer/import-anim] click', { hasArticle: !!article, phraseCount: phrases.length });

  // Three layout variants live in the DOM simultaneously (sidebar, bottom,
  // mobile); media queries display:none all but the active one. Pick the
  // visible variant via offsetParent — querySelectorAll('.filter-phrases-
  // container') would return the first in document order, which is often a
  // hidden one with a zero-size rect.
  const visibleLayout = pickVisibleBouncerLayout();
  const containerInLayout = visibleLayout?.querySelector<HTMLElement>('.filter-phrases-container') ?? null;
  // Use the container when it has real dimensions; otherwise the layout pill
  // (.filter-phrases-bottom collapses its inner container to max-height: 0,
  // but the outer pill is still on screen and is what the user perceives as
  // "the Bouncer UI").
  const containerRect = containerInLayout?.getBoundingClientRect();
  const useContainer = containerInLayout && containerRect && containerRect.height >= 24 && containerRect.width >= 24;
  const destEl: HTMLElement | null = useContainer ? containerInLayout : visibleLayout;

  const tweetPhotoImg = article?.querySelector<HTMLImageElement>('[data-testid="tweetPhoto"] img') ?? null;
  const twimgImg = article?.querySelector<HTMLImageElement>('img[src*="pbs.twimg.com/media"]') ?? null;
  const tweetImg = tweetPhotoImg ?? twimgImg;

  console.log('[Bouncer/import-anim] lookups', {
    visibleLayoutClass: visibleLayout?.className,
    containerInLayoutFound: !!containerInLayout,
    containerRect: containerRect ? { w: containerRect.width, h: containerRect.height } : null,
    chosenDestKind: destEl === containerInLayout ? 'container' : destEl ? 'layout-pill' : 'none',
    tweetPhotoImgFound: !!tweetPhotoImg,
    twimgImgFound: !!twimgImg,
    tweetImgSrc: tweetImg?.src,
    articleImgCount: article?.querySelectorAll('img').length,
  });

  if (!destEl || !tweetImg) {
    console.log('[Bouncer/import-anim] bailing — falling back to plain import', {
      reason: !destEl ? 'no visible Bouncer layout on screen' : 'no tweet image found in article',
    });
    await confirmAndImportPack(phrases);
    return;
  }

  const sourceRect = tweetImg.getBoundingClientRect();
  const destRect = destEl.getBoundingClientRect();
  console.log('[Bouncer/import-anim] rects', {
    source: { x: sourceRect.left, y: sourceRect.top, w: sourceRect.width, h: sourceRect.height },
    dest: { x: destRect.left, y: destRect.top, w: destRect.width, h: destRect.height },
  });

  if (sourceRect.width < 4 || destRect.width < 4) {
    console.log('[Bouncer/import-anim] bailing — degenerate rect', {
      sourceWidth: sourceRect.width,
      destWidth: destRect.width,
    });
    await confirmAndImportPack(phrases);
    return;
  }
  console.log('[Bouncer/import-anim] starting flight');

  const flier = document.createElement('div');
  flier.className = 'bouncer-import-flier';
  Object.assign(flier.style, {
    position: 'fixed',
    left: `${sourceRect.left}px`,
    top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
    zIndex: '2147483646',
    pointerEvents: 'none',
    transformOrigin: 'top left',
    willChange: 'transform, opacity',
    borderRadius: '14px',
    overflow: 'hidden',
    boxShadow: '0 16px 48px rgba(0, 0, 0, 0.45)',
  } satisfies Partial<CSSStyleDeclaration>);

  const imgClone = document.createElement('img');
  imgClone.src = tweetImg.src;
  imgClone.alt = '';
  imgClone.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
  flier.appendChild(imgClone);
  document.body.appendChild(flier);

  // Hide the source image during the flight so the screenshot doesn't appear
  // to be in two places at once.
  const originalSourceVis = tweetImg.style.visibility;
  tweetImg.style.visibility = 'hidden';

  const dx = destRect.left - sourceRect.left;
  const dy = destRect.top - sourceRect.top;
  const sx = destRect.width / sourceRect.width;
  const sy = destRect.height / sourceRect.height;

  // Run the storage writes alongside the animation so the new phrases appear
  // in the destination box right as the flier reaches it. Errors during the
  // import are surfaced by the outer catch via the click handler.
  const importPromise = confirmAndImportPack(phrases);

  const flightMs = 720;
  const animation = flier.animate(
    [
      { transform: 'translate(0, 0) scale(1, 1)', opacity: 1, filter: 'blur(0px)' },
      // Mid-flight: lift slightly off the original path with a soft bloom so
      // the eye reads it as movement rather than a linear lerp.
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - Math.min(80, Math.abs(dy) * 0.2)}px) scale(${(1 + sx) / 2}, ${(1 + sy) / 2})`, opacity: 0.95, filter: 'blur(0px)', offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0, filter: 'blur(2px)' },
    ],
    { duration: flightMs, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'forwards' },
  );

  try {
    await animation.finished;
  } catch {
    // Animation can be canceled if the page navigates mid-flight — fall through
    // and ensure cleanup still runs.
  }
  flier.remove();
  tweetImg.style.visibility = originalSourceVis;

  // Brief pulse on the destination so the user's eye lands on the place where
  // the new pack just appeared.
  destEl.classList.add('bouncer-import-landing');
  setTimeout(() => destEl.classList.remove('bouncer-import-landing'), 700);

  // Make sure storage writes are surfaced before we return so callers see real
  // failures and not a silently-completed flight.
  await importPromise;
}

async function confirmAndImportPack(phrases: string[]): Promise<void> {
  const existing = await getDescriptions(_deps.descriptionsKey);
  const newPhrases = phrases.filter(p => !existing.includes(p));
  if (newPhrases.length === 0) return;
  await setDescriptions(_deps.descriptionsKey, [...existing, ...newPhrases]);
  syncFilterPhrases();
  // Push the new phrase list to the native iOS filter sheet — without this the
  // native @Published phrases array stays at its pre-import snapshot until the
  // user opens & closes the sheet.
  if (_deps.IS_IOS) _deps.updateIOSFilteredCount();
  _deps.reEvaluateAllPosts();
}

function renderPhrasesInContainer(container: Element, descriptions: string[]) {
  container.replaceChildren();
  const len = descriptions.length;
  descriptions.forEach((desc, index) => {
    const phrase = document.createElement('span');
    phrase.className = 'filter-phrase-inline';
    phrase.textContent = desc;
    phrase.title = 'Click to remove';
    phrase.addEventListener('click', asyncHandler(() => removeFilterPhrase(desc)));
    container.appendChild(phrase);

    if (index < len - 1) {
      const separator = document.createElement('span');
      separator.className = 'filter-phrase-separator';
      separator.textContent = ', ';
      container.appendChild(separator);
    } else if (len > 1) {
      // Oxford comma before "and" (which lives in the wrapper element)
      const separator = document.createElement('span');
      separator.className = 'filter-phrase-separator';
      separator.textContent = ', ';
      container.appendChild(separator);
    }
  });

  // Hide placeholder when there are any phrases
  const placeholderCycle = container.parentElement?.querySelector('.filter-placeholder-cycle');
  if (placeholderCycle) {
    placeholderCycle.classList.toggle('hidden', len > 0);
  }
}

const MAX_CATEGORIES_LENGTH = 1000;

export async function addFilterPhrase(text: string) {
  console.log('[Bouncer] addFilterPhrase called with:', text);
  if (!text) return false;

  try {
    const descriptions = await getDescriptions(_deps.descriptionsKey);
    console.log('[Bouncer] Current descriptions:', descriptions);

    if (descriptions.includes(text)) { console.log('[Bouncer] Already exists'); return false; }

    // Check total character length with the new phrase
    const totalLength = [...descriptions, text].reduce((sum, d) => sum + d.length, 0);
    if (totalLength > MAX_CATEGORIES_LENGTH) {
      showCategoryLimitWarning();
      return false;
    }

    descriptions.push(text);
    console.log('[Bouncer] Saving descriptions:', descriptions);
    await setDescriptions(_deps.descriptionsKey, descriptions);
    console.log('[Bouncer] addFilterPhrase complete');
    syncFilterPhrases();
    _deps.reEvaluateAllPosts();
    return true;
  } catch (err) {
    console.error('[Bouncer] addFilterPhrase error:', err);
    return false;
  }
}

export async function removeFilterPhrase(phrase: string) {
  const descriptions = await getDescriptions(_deps.descriptionsKey);
  if (!descriptions.includes(phrase)) {
    syncFilterPhrases();
    return;
  }
  await setDescriptions(_deps.descriptionsKey, descriptions.filter((d: string) => d !== phrase));
  clearFilteredPosts();
  syncFilterPhrases();
}

// ==================== Settings Modal ====================

export function showSettingsModal() {
  // Remove existing modal if any
  if (settingsModal && settingsModal.isConnected) {
    settingsModal.remove();
  }

  // Create modal overlay
  settingsModal = document.createElement('div');
  settingsModal.className = 'settings-modal-overlay';

  // Declare iframe outside branches so message handler can access it
  let iframe: HTMLIFrameElement | undefined;

  // In-app mode (WKWebView): inject popup directly into DOM
  if (chrome._polyfilled && window.__feedfilterPopup) {
    const popup = window.__feedfilterPopup;

    // Inject popup CSS once (rewrite body.X-mode selectors to target container div)
    if (!document.getElementById('ff-popup-styles')) {
      const style = document.createElement('style');
      style.id = 'ff-popup-styles';
      style.textContent = popup.css
        .replace(/body\.dark-mode/g, '.settings-modal-iframe.dark-mode')
        .replace(/body\.dim-mode/g, '.settings-modal-iframe.dim-mode')
        .replace(/body\.light-mode/g, '.settings-modal-iframe.light-mode')
        .replace(/body\.modal-mode/g, '.settings-modal-iframe');
      document.head.appendChild(style);
    }

    // Create container with popup HTML
    const container = document.createElement('div');
    container.className = 'settings-modal-iframe';
    container.replaceChildren(parseHTML(popup.html));
    container.style.overflow = 'auto';

    // Show close button (modal mode)
    const closeBtnEl = container.querySelector<HTMLElement>('.modal-close-btn');
    if (closeBtnEl) closeBtnEl.style.display = 'block';

    // Wire up close button
    const modalCloseBtn = container.querySelector('#modalCloseBtn');
    if (modalCloseBtn) {
      modalCloseBtn.addEventListener('click', () => closeSettingsModal());
    }

    // Apply theme
    const theme = _deps.adapter.getThemeMode();
    container.classList.add(theme + '-mode');

    settingsModal.appendChild(container);
    document.body.appendChild(settingsModal);

    // Trigger animation after append
    requestAnimationFrame(() => {
      settingsModal!.classList.add('visible');
    });

    // Run popup JS directly via import (no eval)
    initPopup().catch((e: Error) => {
      console.error('[FeedFilter] Error running popup init:', e, e.stack);
    });
  } else {
    // Extension mode: load popup.html in iframe
    iframe = document.createElement('iframe');
    iframe.className = 'settings-modal-iframe';
    iframe.src = chrome.runtime.getURL('popup.html');

    // Send current theme to iframe once it loads
    iframe.addEventListener('load', () => {
      const theme = _deps.adapter.getThemeMode();
      iframe!.contentWindow!.postMessage({ type: 'setTheme', theme }, '*');
    });

    settingsModal.appendChild(iframe);
    document.body.appendChild(settingsModal);
  }

  // Listen for messages from iframe
  let hasResized = false;
  const messageHandler = (event: MessageEvent<{ type?: string; height?: number }>) => {
    if (!event.data) return;
    if (event.data.type === 'closeSettingsModal') {
      closeSettingsModal();
      window.removeEventListener('message', messageHandler);
    } else if (event.data.type === 'settingsResize' && iframe) {
      if (!hasResized) {
        // First resize: set height without transition, then fade in
        hasResized = true;
        iframe.style.transition = 'transform 0.2s ease';
        iframe.style.height = event.data.height + 'px';
        requestAnimationFrame(() => {
          settingsModal!.classList.add('visible');
          // Re-enable height transitions for subsequent resizes
          setTimeout(() => {
            if (iframe) iframe.style.transition = '';
          }, 200);
        });
      } else {
        iframe.style.height = event.data.height + 'px';
      }
    }
  };
  window.addEventListener('message', messageHandler);

  // Close on overlay click (but not iframe click)
  const modal = settingsModal;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeSettingsModal();
    }
  });

  // Close on escape key
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeSettingsModal();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

function closeSettingsModal() {
  if (settingsModal && settingsModal.isConnected) {
    settingsModal.classList.remove('visible');
    setTimeout(() => {
      if (settingsModal && settingsModal.isConnected) {
        settingsModal.remove();
      }
      settingsModal = null;
    }, 200);
  } else {
    settingsModal = null;
  }
}

// ==================== Filtered Toggle Buttons ====================

export function updateFilteredToggleButtons() {
  const containers = [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer];
  containers.forEach(container => {
    if (container && container.isConnected) {
      const toggleBtn = container.querySelector('.filtered-toggle-btn:not(.filter-pack-toggle-btn)');
      if (toggleBtn) {
        if (filteredTabActive) {
          toggleBtn.classList.add('active');
        } else {
          toggleBtn.classList.remove('active');
        }
      }
    }
  });
}

export function updateFilteredTabCount() {
  const newCount = filteredPosts.length;
  const countText = `(${newCount})`;
  const shouldAnimate = newCount > previousFilteredCount;
  previousFilteredCount = newCount;

  const containers = [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer];
  containers.forEach(container => {
    if (container && container.isConnected) {
      const countEl = container.querySelector('.filtered-toggle-count');
      if (countEl) {
        countEl.textContent = countText;
        if (shouldAnimate) {
          countEl.classList.remove('bump');
          void (countEl as HTMLElement).offsetWidth;
          countEl.classList.add('bump');
        }
      }
    }
  });

  // Also update iOS overlay "View filtered (N)" button
  _deps.updateIOSFilteredCount();

  // Update FAB badge
  const ffFabButton = _deps.getFFFabButton();
  if (ffFabButton && ffFabButton.isConnected) {
    const badge = ffFabButton.querySelector<HTMLElement>('.ff-fab-badge');
    if (badge) {
      badge.textContent = String(newCount);
      badge.style.display = newCount > 0 ? '' : 'none';
      if (shouldAnimate) {
        ffFabButton.classList.remove('ff-fab-bounce');
        void ffFabButton.offsetWidth;
        ffFabButton.classList.add('ff-fab-bounce');
      }
    }
  }
}

// ==================== Model Loading Progress ====================

export function updateModelLoadingProgress(statuses: Record<string, LocalModelStatus>, selectedModel: string) {
  const containers = [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer];

  const isLocalModel = selectedModel && selectedModel.startsWith('local:');
  if (!isLocalModel) {
    containers.forEach(container => {
      if (container && container.isConnected) {
        const loadingEl = container.querySelector<HTMLElement>('.filter-model-loading');
        if (loadingEl) loadingEl.style.display = 'none';
      }
    });

    return;
  }

  const modelId = selectedModel.split(':')[1];
  const status = statuses[modelId];

  if (!status) return;

  // 'cached' means downloaded-but-idle (loads transparently on demand), so it is
  // not shown as loading here — matching the feed-level indicator. Only the
  // genuinely in-progress states surface the bar.
  const isLoading = status.state === 'downloading' || status.state === 'initializing';

  containers.forEach(container => {
    if (container && container.isConnected) {
      const loadingEl = container.querySelector<HTMLElement>('.filter-model-loading');
      if (!loadingEl) return;

      if (isLoading) {
        loadingEl.style.display = 'block';
        const textEl = loadingEl.querySelector('.model-loading-text')!;
        const fillEl = loadingEl.querySelector<HTMLElement>('.model-loading-progress-fill')!;

        if (status.text) {
          textEl.textContent = status.text;
          fillEl.style.width = `${(status.progress || 0) * 100}%`;
        } else {
          textEl.textContent = status.state === 'initializing' ? 'Loading… first run can take a minute' : 'Downloading...';
          fillEl.style.width = `${(status.progress || 0) * 100}%`;
        }
      } else {
        loadingEl.style.display = 'none';
      }
    }
  });

}

// ==================== Feed-level model-status indicator ====================
//
// A single state-driven element (bottom-left, theme-aware) that surfaces *why*
// filtering isn't happening when the local model isn't ready. It is a pure
// function of storage (selectedModel + localModelStatuses), updated by
// initModelLoadingListener below — so it stays in sync with the popup without
// any extra message plumbing. The popup remains the place to set up a model.

type ModelUiState = 'ready' | 'needs_setup' | 'loading' | 'unsupported' | 'error';

// Pure mapping: storage state → derived UI state.
function deriveModelUiState(
  selectedModel: string,
  statuses: Record<string, LocalModelStatus>,
): ModelUiState {
  if (!selectedModel || !selectedModel.startsWith('local:')) return 'needs_setup';
  const status = statuses[selectedModel.split(':')[1]];
  switch (status?.state) {
    // ready or cached = usable now. 'cached' means downloaded but the engine is
    // cold; it loads transparently on the next post, so we stay hidden rather
    // than claim "loading" while nothing is happening. The genuinely in-progress
    // (and possibly slow) load surfaces via 'initializing' below.
    case 'ready':
    case 'cached': return 'ready';
    case 'downloading':
    case 'initializing': return 'loading';
    case 'unsupported': return 'unsupported';
    case 'error': return 'error';
    case 'not_downloaded':
    default: return 'needs_setup';
  }
}

// Display name for a local model id, for user-facing loading copy.
function localModelDisplay(modelId: string): string {
  return PREDEFINED_MODELS.local.find(m => m.name === modelId)?.display ?? 'the model';
}

interface ModelStatusView { variant: 'info' | 'progress' | 'warning'; body: string; dismissible: boolean; }

function modelStatusView(
  state: ModelUiState,
  statuses: Record<string, LocalModelStatus>,
  selectedModel: string,
): ModelStatusView | null {
  switch (state) {
    case 'needs_setup':
      return { variant: 'info', body: 'Open the Bouncer extension to download a model and start filtering.', dismissible: true };
    case 'loading': {
      const modelId = selectedModel.split(':')[1];
      const status = statuses[modelId];
      const display = localModelDisplay(modelId);
      // Real byte-download → show progress. Warm-up / shader-compile (no byte
      // progress) → set the honest "first run can take a minute" expectation,
      // which is the silent phase users mistake for a hang.
      if (status?.state === 'downloading' && typeof status.progress === 'number') {
        const detail = status.text || `${Math.round(status.progress * 100)}%`;
        return { variant: 'progress', body: `Downloading ${display}… ${detail}`, dismissible: false };
      }
      return { variant: 'progress', body: `Loading ${display} — the first run can take up to a minute.`, dismissible: false };
    }
    case 'unsupported':
      return { variant: 'warning', body: "This browser can't run local models — WebGPU isn't available.", dismissible: true };
    case 'error':
      return { variant: 'warning', body: 'The local model failed to load. Open the Bouncer extension to retry.', dismissible: true };
    case 'ready':
    default:
      return null;
  }
}

function ensureModelStatusEl(): HTMLElement {
  if (modelStatusEl && document.body.contains(modelStatusEl)) return modelStatusEl;
  modelStatusEl = document.createElement('div');
  modelStatusEl.className = 'bouncer-model-status';
  document.body.appendChild(modelStatusEl);
  return modelStatusEl;
}

// Update (and create on demand) the indicator from the current storage state.
export function updateModelStatusIndicator(
  statuses: Record<string, LocalModelStatus>,
  selectedModel: string,
): void {
  const state = deriveModelUiState(selectedModel, statuses);

  // Clear a stale dismissal when the condition changes, so a new state (e.g. an
  // error after the setup hint was dismissed) still surfaces.
  if (modelStatusDismissed !== null && modelStatusDismissed !== state) modelStatusDismissed = null;

  const view = modelStatusDismissed === state ? null : modelStatusView(state, statuses, selectedModel);
  if (!view) {
    if (modelStatusEl) modelStatusEl.classList.remove('visible');
    return;
  }

  const el = ensureModelStatusEl();
  el.classList.remove('bouncer-model-status--info', 'bouncer-model-status--progress', 'bouncer-model-status--warning');
  el.classList.add(`bouncer-model-status--${view.variant}`);
  el.replaceChildren(parseHTML(
    `<span class="bouncer-model-status-dot"></span>` +
    `<span class="bouncer-model-status-text"><strong>Bouncer:</strong> ${escapeHtml(view.body)}</span>` +
    (view.dismissible ? `<button class="bouncer-model-status-close" aria-label="Dismiss">&times;</button>` : '')
  ));
  if (view.dismissible) {
    el.querySelector('.bouncer-model-status-close')?.addEventListener('click', () => {
      modelStatusDismissed = state;
      el.classList.remove('visible');
    });
  }
  requestAnimationFrame(() => el.classList.add('visible'));
}

export function initModelLoadingListener() {
  // Get initial state
  getStorage(['localModelStatuses', 'selectedModel']).then((data) => {
    const statuses = (data.localModelStatuses || {});
    const selectedModel = data.selectedModel || '';
    updateModelLoadingProgress(statuses, selectedModel);
    updateModelStatusIndicator(statuses, selectedModel);
  }).catch(err => console.error('[UI] Failed to load model statuses:', err));

  // Listen for changes
  chrome.storage.onChanged.addListener((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName === 'local' && changes.localModelStatuses) {
      getStorage(['selectedModel']).then((data) => {
        const newStatuses = (changes.localModelStatuses.newValue || {}) as Record<string, LocalModelStatus>;
        const oldStatuses = (changes.localModelStatuses.oldValue || {}) as Record<string, LocalModelStatus>;
        const selectedModel = data.selectedModel || '';

        updateModelLoadingProgress(newStatuses, selectedModel);
        updateModelStatusIndicator(newStatuses, selectedModel);

        // Check if selected local model just became ready - trigger re-evaluation
        if (selectedModel?.startsWith('local:')) {
          const modelId = selectedModel.split(':')[1];
          const oldState = oldStatuses[modelId]?.state;
          const newState = newStatuses[modelId]?.state;

          if (newState === 'ready' && oldState && oldState !== 'ready') {
            _deps.processExistingPosts();
          }
        }
      }).catch(err => console.error('[UI] Failed to get selected model:', err));
    }
    if (areaName === 'local' && changes.selectedModel) {
      getStorage(['localModelStatuses']).then((data) => {
        const statuses = (data.localModelStatuses || {});
        const selectedModel = changes.selectedModel.newValue as string;
        updateModelLoadingProgress(statuses, selectedModel);
        updateModelStatusIndicator(statuses, selectedModel);
      }).catch(err => console.error('[UI] Failed to get model statuses:', err));
    }
  });
}

// ==================== Filtered Tab / Modal ====================

export function toggleFilteredTab(active: boolean) {
  if (active === filteredTabActive) return;
  filteredTabActive = active;

  if (active) {
    if (!filteredModalBackdrop || !filteredModalBackdrop.isConnected) {
      filteredModalBackdrop = document.createElement('div');
      filteredModalBackdrop.className = 'filtered-modal-backdrop';

      filteredViewContainer = document.createElement('div');
      filteredViewContainer.className = 'filtered-view-container';

      const header = document.createElement('div');
      header.className = 'filtered-modal-header';
      header.replaceChildren(parseHTML(`
        <button class="filtered-modal-close" aria-label="Close">
          <svg viewBox="0 0 24 24"><path d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"></path></svg>
        </button>
        <span class="filtered-modal-title">Filtered posts</span>
      `));

      const content = document.createElement('div');
      content.className = 'filtered-modal-content';

      filteredViewContainer.appendChild(header);
      filteredViewContainer.appendChild(content);
      filteredModalBackdrop.appendChild(filteredViewContainer);
      document.body.appendChild(filteredModalBackdrop);

      filteredModalBackdrop.addEventListener('click', (e) => {
        if (e.target === filteredModalBackdrop) {
          toggleFilteredTab(false);
          updateFilteredToggleButtons();
        }
      });

      header.querySelector('.filtered-modal-close')!.addEventListener('click', () => {
        toggleFilteredTab(false);
        updateFilteredToggleButtons();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && filteredTabActive) {
          toggleFilteredTab(false);
          updateFilteredToggleButtons();
        }
      });

      updateTheme();
    }

    filteredModalBackdrop.classList.add('visible');
    renderFilteredPostsView(filteredViewContainer!.querySelector('.filtered-modal-content')!);
  } else {
    if (filteredModalBackdrop) {
      filteredModalBackdrop.classList.remove('visible');
    }

    // Restore verification bars that may have been removed while on Filtered tab
    restoreVerificationBars();
  }
}

export function renderFilteredPostsView(container: Element) {
  if (filteredPosts.length === 0) {
    container.replaceChildren(parseHTML(`
      <div class="filtered-posts-container">
        <div class="filtered-posts-empty">
          No posts have been filtered out in this session.<br>
          Removed posts will appear here.
        </div>
      </div>
    `));
    return;
  }

  // Create a container for the posts
  container.replaceChildren(parseHTML('<div class="slop-posts-container"></div>'));
  const postsContainer = container.querySelector('.slop-posts-container')!;

  // Render posts in reverse order (newest first)
  [...filteredPosts].reverse().forEach((post) => {
    const { post: postContent } = post;
    const wrapper = document.createElement('div');
    wrapper.className = 'slop-post-wrapper';

    // Main post row: avatar + body
    const postRow = document.createElement('div');
    postRow.className = 'slop-post';

    // Avatar — show image if available, otherwise show initial as fallback
    const avatar = document.createElement('div');
    avatar.className = 'slop-post-avatar';
    if (postContent.avatarUrl) {
      const img = document.createElement('img');
      img.src = postContent.avatarUrl;
      avatar.appendChild(img);
    } else {
      // Fallback: show first letter of display name or handle
      const initial = (postContent.author?.[0] || postContent.handle?.[1] || '?').toUpperCase();
      const fallback = document.createElement('span');
      fallback.className = 'slop-avatar-initial';
      fallback.textContent = initial;
      avatar.appendChild(fallback);
    }
    postRow.appendChild(avatar);

    // Body
    const body = document.createElement('div');
    body.className = 'slop-post-body';

    // Top row: meta + category tag
    const top = document.createElement('div');
    top.className = 'slop-post-top';

    const meta = document.createElement('div');
    meta.className = 'slop-post-meta';
    if (postContent.author) {
      // Extract display name — author field has "DisplayName@handle · time" concatenated
      // Use handle to split if available, otherwise use full author string
      let displayName = postContent.author;
      if (postContent.handle) {
        const handleIdx = displayName.indexOf(postContent.handle);
        if (handleIdx > 0) displayName = displayName.substring(0, handleIdx);
      }
      const nameSpan = document.createElement('span');
      nameSpan.className = 'slop-post-name';
      nameSpan.textContent = displayName;
      meta.appendChild(nameSpan);
    }
    if (postContent.handle || postContent.timeText) {
      const handleSpan = document.createElement('span');
      handleSpan.className = 'slop-post-handle';
      const parts = [postContent.handle, postContent.timeText].filter(Boolean);
      handleSpan.textContent = parts.join(' · ');
      meta.appendChild(handleSpan);
    }
    top.appendChild(meta);

    if (post.category) {
      const tag = document.createElement('span');
      tag.className = 'slop-category-tag';
      tag.textContent = post.category.toUpperCase();
      top.appendChild(tag);
    }
    body.appendChild(top);

    // Tweet text — use sanitized HTML to preserve links/emojis/formatting
    if (postContent.textHtml) {
      const textDiv = document.createElement('div');
      textDiv.className = 'slop-post-text';
      textDiv.replaceChildren(DOMPurify.sanitize(postContent.textHtml, { RETURN_DOM_FRAGMENT: true }));
      body.appendChild(textDiv);
    } else if (post.evaluationText) {
      const textDiv = document.createElement('div');
      textDiv.className = 'slop-post-text';
      textDiv.textContent = post.evaluationText;
      body.appendChild(textDiv);
    }

    // Quote tweet — render as a mini-card with avatar, author, and text
    if (postContent.quote) {
      const quoteBox = document.createElement('div');
      quoteBox.className = 'slop-quote-box';

      // Quote header: avatar + author info
      const quoteHeader = document.createElement('div');
      quoteHeader.className = 'slop-quote-header';

      if (postContent.quote.avatarUrl) {
        const qAvatar = document.createElement('img');
        qAvatar.className = 'slop-quote-avatar';
        qAvatar.src = postContent.quote.avatarUrl;
        quoteHeader.appendChild(qAvatar);
      }

      if (postContent.quote.author) {
        let qDisplayName = postContent.quote.author;
        if (postContent.quote.handle) {
          const idx = qDisplayName.indexOf(postContent.quote.handle);
          if (idx > 0) qDisplayName = qDisplayName.substring(0, idx);
        }
        const qName = document.createElement('span');
        qName.className = 'slop-quote-name';
        qName.textContent = qDisplayName;
        quoteHeader.appendChild(qName);
      }
      if (postContent.quote.handle || postContent.quote.timeText) {
        const qMeta = document.createElement('span');
        qMeta.className = 'slop-quote-handle';
        const parts = [postContent.quote.handle, postContent.quote.timeText].filter(Boolean);
        qMeta.textContent = parts.join(' · ');
        quoteHeader.appendChild(qMeta);
      }
      quoteBox.appendChild(quoteHeader);

      // Quote text
      if (postContent.quote.textHtml) {
        const quoteText = document.createElement('div');
        quoteText.className = 'slop-quote-text';
        quoteText.replaceChildren(DOMPurify.sanitize(postContent.quote.textHtml, { RETURN_DOM_FRAGMENT: true }));
        quoteBox.appendChild(quoteText);
      }

      body.appendChild(quoteBox);
    }

    // Images (skip if media was blurred/age-restricted on the platform)
    if (postContent.imageUrls && postContent.imageUrls.length > 0 && !postContent.mediaBlurred) {
      const mediaContainer = document.createElement('div');
      mediaContainer.className = 'slop-media-container';
      postContent.imageUrls.forEach(url => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'slop-media-image';
        img.loading = 'lazy';
        mediaContainer.appendChild(img);
      });
      body.appendChild(mediaContainer);
    }

    // Reasoning — table_yesno (Gemma) posts carry matched categories in
    // `post.category` and a terse pipe-row in `post.reasoning`; show the clean
    // "Matched: …" summary instead of running the pipe-row through cleanReasoning.
    // Prose models (Qwen) have no category and keep their reasoning text.
    const reasoning = document.createElement('div');
    reasoning.className = 'slop-post-reasoning';
    reasoning.textContent = post.category
      ? `Matched: ${post.category}`
      : (cleanReasoning(post.reasoning) || 'Filtered');
    body.appendChild(reasoning);

    // Actions row
    const actions = document.createElement('div');
    actions.className = 'slop-post-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'slop-restore';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({
        type: 'sendFeedback',
        siteId: _deps.adapter.siteId,
        tweetData: { text: post.evaluationText, imageUrls: postContent.imageUrls || [] },
        rawResponse: post.rawResponse || '',
        reasoning: post.reasoning || '',
        decision: 'false_positive'
      }).catch(err => console.error('[Bouncer] Undo feedback error:', err));

      // Remove from filtered posts list
      const key = postContent.postUrl || post.evaluationText.substring(0, 200);
      const idx = filteredPosts.findIndex(p => (p.post.postUrl || p.evaluationText.substring(0, 200)) === key);
      if (idx !== -1) filteredPosts.splice(idx, 1);
      filteredPostKeys.delete(key);

      // Try to unhide original article in the feed
      for (const article of _deps.findPosts()) {
        const postUrl = _deps.adapter.getPostUrl(article);
        if (postUrl && postContent.postUrl && postUrl.includes(postContent.postUrl)) {
          const container = _deps.adapter.getPostContainer(article);
          container.style.display = '';
          container.style.visibility = '';
          delete container.dataset.filteredByExtension;
          article.style.opacity = '';
          article.style.transition = '';
          _deps.processedPosts.delete(article);
          markPostVerified(article);
          break;
        }
      }

      // Override cache so re-evaluation keeps post visible
      chrome.runtime.sendMessage({
        type: 'overrideCacheEntry',
        post: post.evaluationText,
        imageUrls: postContent.imageUrls || [],
        shouldHide: false,
        reasoning: 'User reported: false positive'
      }).catch(err => console.error('[Bouncer] Override cache error:', err));

      updateFilteredTabCount();
      const outerContainer = restoreBtn.closest('.filtered-view-container') || restoreBtn.closest('.ff-ios-filtered-modal-backdrop');
      const innerContainer = outerContainer?.querySelector('.filtered-modal-content') || outerContainer?.querySelector('.ff-ios-filtered-modal-content');
      if (innerContainer) renderFilteredPostsView(innerContainer);
    });
    actions.appendChild(restoreBtn);
    body.appendChild(actions);

    postRow.appendChild(body);

    // Wrap in a real <a> so middle-click / ctrl-click open in new tab natively
    if (postContent.postUrl) {
      const link = document.createElement('a');
      link.href = postContent.postUrl;
      link.className = 'slop-post-link';
      link.addEventListener('click', (e) => {
        if ((e.target as Element).closest('button, [role="button"], .slop-restore, .slop-post-actions')) {
          e.preventDefault();
        }
      });
      link.appendChild(postRow);
      wrapper.appendChild(link);
    } else {
      wrapper.appendChild(postRow);
    }

    postsContainer.appendChild(wrapper);
  });
}

// ==================== Filtered Post Storage ====================

export function storeFilteredPost(article: HTMLElement, contentObj: PostContent, reasoning: string, rawResponse = '', category: string | null = null) {
  // Use postUrl or content hash as dedup key
  const evalText = formatPostForEvaluation(contentObj);
  const key = contentObj.postUrl || evalText.substring(0, 200);
  if (filteredPostKeys.has(key)) {
    return; // Already stored
  }
  filteredPostKeys.add(key);

  filteredPosts.push({
    post: contentObj,
    evaluationText: evalText,
    reasoning,
    rawResponse,
    category: category || null,
    timestamp: Date.now()
  });
  updateFilteredTabCount();
}

// ==================== Verification Bars ====================

export function getVerificationBar(article: HTMLElement) {
  let bar = article.querySelector('.post-verification-bar');
  if (!bar) {
    article.style.position = 'relative';
    bar = document.createElement('div');
    bar.className = 'post-verification-bar';
    article.insertBefore(bar, article.firstChild);
  }
  return bar;
}

// Cap how long a post stays visually greyed-out. Processing may continue past
// this — we just stop dimming the post so a slow classification doesn't leave
// the user staring at a grey card.
const PENDING_DIM_CAP_MS = 3000;
const pendingDimTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function clearPendingDimTimer(article: HTMLElement) {
  const t = pendingDimTimers.get(article);
  if (t) {
    clearTimeout(t);
    pendingDimTimers.delete(article);
  }
}

export function markPostPending(article: HTMLElement) {
  const bar = getVerificationBar(article);
  bar.classList.remove('verified', 'api-error');
  bar.classList.add('pending');
  article.setAttribute('data-ff-pending', '');
  article.classList.remove('ff-error');
  _deps.pendingPosts.add(article);
  article.dataset.pendingStartTime = Date.now().toString();

  clearPendingDimTimer(article);
  pendingDimTimers.set(article, setTimeout(() => {
    article.removeAttribute('data-ff-pending');
    bar.classList.remove('pending');
    pendingDimTimers.delete(article);
    // Defensively restore opacity on the article's direct children. The dim
    // is normally CSS-only via [data-ff-pending], so removing the attribute
    // should be enough — but if anything else left an inline opacity behind
    // the post would stay greyed past the cap. Skip the verification bar to
    // match the CSS exclusion.
    article.style.opacity = '';
    for (const child of Array.from(article.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.classList.contains('post-verification-bar')) continue;
      child.style.opacity = '';
    }
  }, PENDING_DIM_CAP_MS));
}

export function markPostVerified(article: HTMLElement) {
  const bar = getVerificationBar(article);
  bar.classList.remove('pending', 'api-error');
  bar.classList.add('verified');
  article.removeAttribute('data-ff-pending');
  article.classList.remove('ff-error');
  _deps.pendingPosts.delete(article);
  delete article.dataset.pendingStartTime;
  clearPendingDimTimer(article);
}

export function restoreVerificationBars() {
  const posts = _deps.findPosts();
  posts.forEach(article => {
    if (_deps.processedPosts.has(article) && _deps.postReasonings.has(article)) {
      const stored = _deps.postReasonings.get(article)!;
      if (!stored.shouldHide) {
        const existingBar = article.querySelector('.post-verification-bar');
        if (!existingBar) {
          markPostVerified(article);
        }
      }
    }
  });
}

// ==================== Post Hiding ====================

export function hidePost(article: HTMLElement) {
  _deps.pendingPosts.delete(article);
  delete article.dataset.pendingStartTime;
  article.removeAttribute('data-ff-pending');
  clearPendingDimTimer(article);

  _deps.adapter.hidePost(article);
}

// ==================== Reasoning Popup ====================

export function showReasoningPopup(article: HTMLElement, x: number, y: number) {
  hideReasoningPopup();

  const content = _deps.extractPostContent(article);
  const stored = _deps.postReasonings.get(article);

  const popup = document.createElement('div');
  popup.className = 'post-filter-reasoning-popup';

  // Header status reflects the overall post-level state: PENDING until the
  // race resolves, then HIDDEN / KEPT / ERROR. Tabs below show per-detector
  // reasoning when the multi-detector flow is in play.
  let statusClass: string, statusText: string;
  if (stored?.isApiError) {
    statusClass = 'status-error';
    statusText = 'ERROR';
  } else if (stored?.shouldHide) {
    statusClass = 'status-hide';
    statusText = 'HIDDEN';
  } else if (stored) {
    statusClass = 'status-show';
    statusText = 'KEPT';
  } else {
    statusClass = 'status-pending';
    statusText = 'PENDING';
  }

  const detectorEntry = postDetectorStates.get(article);
  const rawResponseSection = stored?.rawResponse ? `
    <details class="reasoning-debug">
      <summary>Raw Model Response</summary>
      <pre class="reasoning-debug-html">${escapeHtml(stored.rawResponse)}</pre>
    </details>
  ` : '';

  let bodyHtml: string;
  if (detectorEntry && detectorEntry.names.length > 0) {
    // Pick which tab is active. Preserve user selection if still valid;
    // otherwise default to the highest-priority detector (index 0).
    const activeName = (activePopupTab && detectorEntry.byName.has(activePopupTab))
      ? activePopupTab
      : detectorEntry.names[0];
    activePopupTab = activeName;

    const tabsHtml = detectorEntry.names.map(name => {
      const s = detectorEntry.byName.get(name)!;
      const dot = s.status === 'pending' ? 'pending'
                : s.status === 'error' ? 'error'
                : s.status === 'skipped' ? 'skipped'
                : s.shouldHide ? 'hide' : 'keep';
      const isActive = name === activeName;
      return `<button class="reasoning-tab ${isActive ? 'active' : ''}" data-detector="${escapeHtml(name)}">
        <span class="reasoning-tab-dot reasoning-tab-dot-${dot}"></span>
        ${escapeHtml(detectorLabel(name))}
      </button>`;
    }).join('');

    const active = detectorEntry.byName.get(activeName)!;
    let tabBody: string;
    if (active.status === 'pending') {
      tabBody = `<div class="reasoning-text reasoning-text-pending">Waiting for ${escapeHtml(detectorLabel(activeName))}…</div>`;
    } else if (active.status === 'error') {
      tabBody = `<div class="reasoning-text reasoning-text-error">${escapeHtml(detectorLabel(activeName))} failed: ${escapeHtml(active.error || 'unknown error')}</div>`;
    } else if (active.status === 'skipped') {
      tabBody = `
        <div class="reasoning-tab-verdict verdict-skipped">SKIPPED</div>
        <div class="reasoning-text reasoning-text-skipped">${escapeHtml(active.skipReason || 'No reason given')}</div>
      `;
    } else {
      const verdict = active.shouldHide ? 'HIDE' : 'KEEP';
      const verdictClass = active.shouldHide ? 'verdict-hide' : 'verdict-keep';
      // table_yesno (Gemma) returns matched categories in `category` and a terse
      // pipe-row in `reasoning`. Render the matches as chips rather than running
      // the pipe-row through cleanReasoning (which splits on "|" and would mangle
      // it). Prose models (Qwen) have no category and keep the reasoning text.
      const reasoningBody = active.category
        ? `<div class="reasoning-match-label">Matched categories</div><div class="reasoning-match-chips">${active.category.split(',').map(c => c.trim()).filter(Boolean).map(c => `<span class="reasoning-match-chip">${escapeHtml(c)}</span>`).join('')}</div>`
        : `<div class="reasoning-text">${escapeHtml(cleanReasoning(active.reasoning ?? '') ?? '')}</div>`;
      tabBody = `
        <div class="reasoning-tab-verdict ${verdictClass}">${verdict}</div>
        ${reasoningBody}
      `;
    }

    bodyHtml = `
      <div class="reasoning-tabs">${tabsHtml}</div>
      <div class="reasoning-tab-body">${tabBody}</div>
    `;
  } else {
    // Fallback: single-reason render for cache hits / no-rules / disabled.
    const reasoning = stored?.reasoning ?? 'Post not yet evaluated. It may be queued or no filter rules are set.';
    bodyHtml = `<div class="reasoning-text">${escapeHtml(cleanReasoning(reasoning) ?? '')}</div>`;
  }

  popup.replaceChildren(parseHTML(`
    <div class="reasoning-header">
      <span class="reasoning-status ${statusClass}">${statusText}</span>
      <button class="reasoning-close">&times;</button>
    </div>
    ${bodyHtml}
    <div class="reasoning-post">${escapeHtml(content.text.substring(0, 100))}${content.text.length > 100 ? '...' : ''}</div>
    ${rawResponseSection}
    <button class="reasoning-reeval-btn">${stored ? 'Re-evaluate' : 'Evaluate Now'}</button>
    <button class="reasoning-suggest-btn">Why is this annoying?</button>
    <div class="reasoning-suggestions"></div>
  `));

  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;

  document.body.appendChild(popup);
  activePopup = popup;
  activePopupArticle = article;

  popup.querySelector('.reasoning-close')!.addEventListener('click', hideReasoningPopup);

  popup.querySelectorAll<HTMLButtonElement>('.reasoning-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.detector;
      if (!name || name === activePopupTab) return;
      activePopupTab = name;
      refreshActivePopupIfFor(article);
    });
  });

  popup.querySelector('.reasoning-reeval-btn')!.addEventListener('click', () => {
    (async () => {
      hideReasoningPopup();
      try {
        await _deps.reEvaluateSinglePost(article);
      } catch (err) {
        console.error('[Bouncer] Re-evaluate error:', err);
      }
    })().catch(err => console.error('[UI] reeval handler failed:', err));
  });

  // Suggest annoying reasons button handler
  popup.querySelector('.reasoning-suggest-btn')!.addEventListener('click', (e) => {
    (async () => {
      const btn = e.currentTarget as HTMLButtonElement;
      const suggestionsDiv = popup.querySelector('.reasoning-suggestions')!;
      btn.disabled = true;
      btn.textContent = 'Thinking...';
      suggestionsDiv.replaceChildren();
      try {
        const response: { reasons?: string[] } | undefined = await chrome.runtime.sendMessage({
          type: 'suggestAnnoyingReasons',
          post: content.text,
          imageUrls: content.imageUrls || [],
          siteId: _deps.adapter.siteId
        });
        if (response?.reasons?.length) {
          btn.style.display = 'none';
          suggestionsDiv.replaceChildren(parseHTML(response.reasons.map(r =>
            `<button class="reasoning-suggestion-chip">${escapeHtml(r)}</button>`
          ).join('')));
          suggestionsDiv.querySelectorAll('.reasoning-suggestion-chip').forEach(chip => {
            chip.addEventListener('click', () => {
              const phrase = chip.textContent ?? '';
              addFilterPhrase(phrase).catch(err => console.error('[UI] addFilterPhrase failed:', err));
              chip.classList.add('suggestion-added');
              chip.textContent = `+ ${phrase}`;
              (chip as HTMLButtonElement).disabled = true;
            });
          });
        } else {
          btn.textContent = 'No suggestions';
          btn.disabled = true;
        }
      } catch (err) {
        console.error('[Bouncer] Suggest reasons error:', err);
        btn.textContent = 'Error - try again';
        btn.disabled = false;
      }
    })().catch(err => console.error('[UI] suggest handler failed:', err));
  });

  const rect = popup.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    popup.style.left = `${window.innerWidth - rect.width - 10}px`;
  }
  if (rect.bottom > window.innerHeight) {
    popup.style.top = `${window.innerHeight - rect.height - 10}px`;
  }

  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick);
  }, 0);
}

export function hideReasoningPopup() {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
  activePopupArticle = null;
  document.removeEventListener('click', handleOutsideClick);
}

// ---- Per-detector state for the tabbed popup ----------------------------
//
// Each evaluated post gets a small map of detector name → state. The popup
// renders one tab per detector and reads each tab's content from this map.
// Posts that don't go through the multi-detector pipeline (cache hits, the
// "no filter rules" early return, etc.) won't have an entry here, and the
// popup falls back to the legacy single-reason rendering.

interface DetectorPopupState {
  status: 'pending' | 'success' | 'error' | 'skipped';
  shouldHide?: boolean;
  reasoning?: string;
  category?: string | null;
  error?: string;
  skipReason?: string;
}

interface DetectorPopupEntry {
  /** Ordered by priority: index 0 is the highest-priority detector. */
  names: string[];
  byName: Map<string, DetectorPopupState>;
}

const postDetectorStates = new WeakMap<HTMLElement, DetectorPopupEntry>();

export function initDetectorStates(article: HTMLElement, names: string[]) {
  if (names.length === 0) return;
  const byName = new Map<string, DetectorPopupState>();
  for (const name of names) byName.set(name, { status: 'pending' });
  postDetectorStates.set(article, { names: [...names], byName });
  refreshActivePopupIfFor(article);
}

export function updateDetectorState(
  article: HTMLElement,
  name: string,
  patch: Partial<DetectorPopupState> & { status: DetectorPopupState['status'] },
) {
  let entry = postDetectorStates.get(article);
  if (!entry) {
    // initDetectorStates wasn't called (e.g. message ordering). Synthesize.
    entry = { names: [name], byName: new Map([[name, { status: patch.status }]]) };
    postDetectorStates.set(article, entry);
  }
  if (!entry.byName.has(name)) {
    entry.names.push(name);
    entry.byName.set(name, { status: patch.status });
  }
  Object.assign(entry.byName.get(name)!, patch);
  refreshActivePopupIfFor(article);
}

function refreshActivePopupIfFor(article: HTMLElement) {
  if (!activePopup || activePopupArticle !== article) return;
  const x = parseFloat(activePopup.style.left) || 0;
  const y = parseFloat(activePopup.style.top) || 0;
  showReasoningPopup(article, x, y);
}

// Display label for a detector tab. Falls back to the raw name for
// future detectors without an entry here.
function detectorLabel(name: string): string {
  switch (name) {
    case 'filter': return 'Filter';
    default: return name;
  }
}

function handleOutsideClick(e: MouseEvent) {
  if (activePopup && !activePopup.contains(e.target as Node)) {
    hideReasoningPopup();
  }
}

function showCategoryLimitWarning() {
  // Show warning in all filter box containers
  const containers = [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer].filter(Boolean) as HTMLElement[];
  for (const container of containers) {
    // Don't add duplicate warnings
    if (container.querySelector('.ff-category-limit-warning')) continue;
    const warning = document.createElement('div');
    warning.className = 'ff-category-limit-warning';
    warning.textContent = 'You have too many filter categories - please remove some before adding more';
    const actionsRow = container.querySelector('.filter-phrases-actions');
    if (actionsRow) {
      actionsRow.parentNode!.insertBefore(warning, actionsRow);
    }
    // Remove when user types or clicks elsewhere
    const input = container.querySelector<HTMLInputElement>('.filter-phrases-input');
    if (input) {
      const dismiss = () => {
        warning.remove();
        input.removeEventListener('input', dismiss);
        input.removeEventListener('blur', dismiss);
      };
      input.addEventListener('input', dismiss);
      input.addEventListener('blur', dismiss);
    }
  }
}

// ==================== Context Menu ====================

export function addContextMenuHandler(article: HTMLElement) {
  const openPopup = (x: number, y: number) => {
    (async () => {
      await fetchReasoningIfNeeded(article);
      showReasoningPopup(article, x, y);
    })().catch(err => console.error('[UI] getReasoning handler failed:', err));
  };

  // Desktop: ctrl+right-click
  article.addEventListener('contextmenu', (e) => {
    if (!e.ctrlKey) {
      return;
    }

    e.preventDefault();
    openPopup(e.clientX, e.clientY);
  });

  // iOS: press-and-hold (~500ms) on the post brings up the same popup. The
  // ctrlKey path doesn't apply on touch, so we detect a stationary single-
  // finger touch here and trigger once the timer fires. We swallow the
  // following `click`, `contextmenu`, and `touchend` so the system callout
  // doesn't appear and Twitter doesn't navigate to the post.
  if (_deps.IS_IOS) {
    const LONG_PRESS_MS = 500;
    const MOVE_TOLERANCE_PX = 10;
    let pressTimer: number | null = null;
    let startX = 0;
    let startY = 0;
    let triggered = false;

    const cancelTimer = () => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    article.addEventListener('touchstart', (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        cancelTimer();
        triggered = false;
        return;
      }
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      triggered = false;
      cancelTimer();
      pressTimer = window.setTimeout(() => {
        pressTimer = null;
        triggered = true;
        openPopup(startX, startY);
      }, LONG_PRESS_MS);
    }, { passive: true });

    article.addEventListener('touchmove', (e: TouchEvent) => {
      if (pressTimer === null) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - startX, t.clientY - startY) > MOVE_TOLERANCE_PX) {
        cancelTimer();
      }
    }, { passive: true });

    article.addEventListener('touchend', (e: TouchEvent) => {
      cancelTimer();
      if (triggered) e.preventDefault();
    });

    article.addEventListener('touchcancel', () => {
      cancelTimer();
      triggered = false;
    });

    // Suppress the click that fires after touchend when long-press triggered,
    // so Twitter doesn't navigate to the post detail page.
    article.addEventListener('click', (e) => {
      if (triggered) {
        e.preventDefault();
        e.stopPropagation();
        triggered = false;
      }
    }, true);

    // Also block the iOS system callout menu if the WebView fires it.
    article.addEventListener('contextmenu', (e) => {
      if (triggered || pressTimer !== null) e.preventDefault();
    });
  }
}

async function fetchReasoningIfNeeded(article: HTMLElement) {
  if (_deps.postReasonings.has(article)) return;

  const content = _deps.extractPostContent(article);
  const hasContent = content.text.trim() || (content.imageUrls && content.imageUrls.length > 0);
  if (!hasContent) return;

  try {
    let response: { found?: boolean; shouldHide?: boolean; reasoning?: string; rawResponse?: string } | undefined = await chrome.runtime.sendMessage({
      type: 'getReasoning',
      post: formatPostForEvaluation(content),
      imageUrls: content.imageUrls || []
    });

    // If not found, try with plain text (DOM re-renders may change HTML but not text)
    if (!response?.found && content.text) {
      response = await chrome.runtime.sendMessage({
        type: 'getReasoning',
        post: content.text,
        imageUrls: content.imageUrls || []
      });
    }

    if (response && response.found) {
      _deps.postReasonings.set(article, {
        shouldHide: response.shouldHide ?? false,
        reasoning: response.reasoning ?? '',
        rawResponse: response.rawResponse ?? null
      });
    }
  } catch (err) {
    console.debug('Failed to get reasoning:', err);
  }
}

// ==================== DOM Mutation Handler ====================

// ==================== Why Annoying Button ====================

const DEBUG = false;

// Add inline "why annoying" button next to Share post button
export function addWhyAnnoyingButton(article: HTMLElement) {
  if (!_deps.adapter.getShareButton(article)) {
    return;
  }
  // Don't add twice
  if (article.querySelector('.ff-why-annoying-btn')) {
    return;
  }

  const btn = document.createElement('div');
  btn.className = 'ff-why-annoying-btn';
  btn.setAttribute('role', 'button');
  btn.title = 'Bounce this tweet';
  btn.replaceChildren(parseHTML(`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M5 6v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6"/><line x1="10" y1="10" x2="10" y2="17"/><line x1="14" y1="10" x2="14" y2="17"/></svg>`));

  _deps.adapter.insertActionButton(article, btn);

  // Track tooltip reference on the button element
  let btnTooltip: HTMLElement | null = null;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // If tooltip already open on this button, close it
    if (btnTooltip && btnTooltip.isConnected) {
      btnTooltip.remove();
      btnTooltip = null;
      return;
    }

    // Close any other open tooltips
    document.querySelectorAll('.ff-annoying-tooltip').forEach(t => t.remove());

    const content = _deps.extractPostContent(article);

    // Create tooltip — append to body with fixed positioning so it escapes
    // any overflow:hidden ancestors in Twitter's DOM
    const tooltip = document.createElement('div');
    tooltip.className = 'ff-annoying-tooltip';
    document.body.appendChild(tooltip);
    btnTooltip = tooltip;

    // Position the tooltip above the button
    const positionTooltip = () => {
      const btnRect = btn.getBoundingClientRect();
      tooltip.style.position = 'fixed';
      tooltip.style.right = `${document.documentElement.clientWidth - btnRect.right}px`;
      // Place above the button; if clipped, place below
      tooltip.style.bottom = '';
      tooltip.style.top = '';
      const tentativeTop = btnRect.top - tooltip.offsetHeight - 8;
      if (tentativeTop < 0) {
        tooltip.style.top = `${btnRect.bottom + 8}px`;
        tooltip.classList.add('ff-annoying-tooltip--flipped');
      } else {
        tooltip.style.bottom = `${window.innerHeight - btnRect.top + 8}px`;
        tooltip.classList.remove('ff-annoying-tooltip--flipped');
      }
    };
    requestAnimationFrame(positionTooltip);

    // Reposition on scroll; dismiss if button leaves viewport
    const onScroll = () => {
      if (!tooltip.isConnected) {
        window.removeEventListener('scroll', onScroll, true);
        return;
      }
      const btnRect = btn.getBoundingClientRect();
      if (btnRect.bottom < 0 || btnRect.top > window.innerHeight) {
        tooltip.remove();
        window.removeEventListener('scroll', onScroll, true);
        return;
      }
      positionTooltip();
    };
    window.addEventListener('scroll', onScroll, true);

    // Use prefetched result if available, otherwise fire a new request
    let cachedPromise = annoyingReasonsCache.get(article);
    if (!cachedPromise) {
      cachedPromise = chrome.runtime.sendMessage({
        type: 'suggestAnnoyingReasons',
        post: content.text,
        imageUrls: content.imageUrls || [],
        siteId: _deps.adapter.siteId
      });
      annoyingReasonsCache.set(article, cachedPromise);
    }

    (async () => {
    // Check if the promise is already resolved (settled) by racing with an instant resolve
    let response: { reasons: string[]; hadImages?: boolean } | null = null;
    const settled = await Promise.race([
      cachedPromise.then((r: { reasons: string[]; hadImages?: boolean }) => { response = r; return 'done' as const; }),
      Promise.resolve('pending' as const)
    ]);
    const alreadyDone = settled === 'done';

    if (!alreadyDone) {
      // Still loading — show spinner while we wait
      tooltip.replaceChildren(parseHTML(`<div class="ff-annoying-spinner"><div class="ff-spinner-dot"></div><div class="ff-spinner-dot"></div><div class="ff-spinner-dot"></div></div><span class="ff-annoying-thinking">Diagnosing annoyances</span><div class="ff-progress-bar"><div class="ff-progress-track"><div class="ff-progress-fill" data-stage="0"></div></div></div><a href="#" class="ff-missed-link">This should already be filtered</a>`));

      const progressListener = (message: { type: string; verified: number }) => {
        if (message.type === 'annoyingProgress') {
          const fill = tooltip.querySelector<HTMLElement>('.ff-progress-fill');
          if (fill) {
            const stage = Math.min(message.verified, 3);
            fill.dataset.stage = String(stage);
            fill.style.width = `${(stage / 3) * 100}%`;
          }
        }
      };
      chrome.runtime.onMessage.addListener(progressListener);

      const cleanupProgress = () => {
        chrome.runtime.onMessage.removeListener(progressListener);
      };

      tooltip.querySelector('.ff-missed-link')!.addEventListener('click', (linkEvent) => {
        linkEvent.preventDefault();
        linkEvent.stopPropagation();
        const reasoning = _deps.postReasonings.get(article);
        chrome.runtime.sendMessage({
          type: 'sendFeedback',
          siteId: _deps.adapter.siteId,
          tweetData: { text: formatPostForEvaluation(content), imageUrls: content.imageUrls || [] },
          rawResponse: reasoning?.rawResponse || '',
          reasoning: reasoning?.reasoning || '',
          decision: 'false_negative'
        }).catch(err => console.error('[Bouncer] Missed feedback error:', err));
        tooltip.remove();
        storeFilteredPost(article, content, 'User reported: should have been filtered');
        article.style.transition = 'opacity 0.3s ease';
        article.style.opacity = '0';
        setTimeout(() => hidePost(article), 300);
        chrome.runtime.sendMessage({
          type: 'overrideCacheEntry',
          post: formatPostForEvaluation(content),
          imageUrls: content.imageUrls || [],
          shouldHide: true,
          reasoning: 'User reported: should have been filtered'
        }).catch(err => console.error('[Bouncer] Override cache error:', err));
      });
      try {
        response = await cachedPromise as { reasons: string[]; hadImages?: boolean };
      } catch (err) {
        console.error('[Bouncer] Why annoying error:', err);
        cleanupProgress();
        tooltip.replaceChildren(parseHTML('<span class="ff-annoying-empty">Error - try again</span>'));
        annoyingReasonsCache.delete(article);
        return;
      }
      cleanupProgress();
    }

    // Render results
    tooltip.replaceChildren();
    if (response && response.reasons?.length) {
      const resp = response;
      const label = document.createElement('span');
      label.className = 'ff-annoying-label';
      label.textContent = 'Block this due to:';
      tooltip.appendChild(label);
      resp.reasons.forEach(r => {
        const chip = document.createElement('button');
        chip.className = 'ff-annoying-chip';
        chip.textContent = r;
        if (DEBUG) {
          const imgBadge = document.createElement('span');
          imgBadge.className = 'ff-img-badge';
          imgBadge.textContent = resp.hadImages ? '[img]' : '[txt]';
          chip.appendChild(imgBadge);
        }
        chip.addEventListener('click', (ce) => {
          ce.stopPropagation();
          // Remove tooltip before the filter triggers re-evaluation and captures the post
          tooltip.remove();
          addFilterPhrase(r).catch(err => console.error('[UI] addFilterPhrase failed:', err));
        });
        tooltip.appendChild(chip);
      });

      // "Something else" custom input
      const customWrapper = document.createElement('div');
      customWrapper.className = 'ff-annoying-custom-wrapper';

      const customInput = document.createElement('input');
      customInput.type = 'text';
      customInput.className = 'ff-annoying-custom-input';
      customInput.placeholder = 'something else';

      const sendBtn = document.createElement('button');
      sendBtn.className = 'ff-annoying-send-btn';
      sendBtn.replaceChildren(parseHTML('<svg viewBox="0 0 24 24"><path d="M3 12h18M21 12l-6-6M21 12l-6 6" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'));

      const submitCustomInput = () => {
        const value = customInput.value.trim();
        if (!value) return;
        tooltip.remove();
        addFilterPhrase(value).catch(err => console.error('[UI] addFilterPhrase failed:', err));
        // Forcibly remove this post regardless of AI evaluation
        const reasoning = `User blocked: ${value}`;
        storeFilteredPost(article, content, reasoning, '', value);
        article.style.transition = 'opacity 0.3s ease';
        article.style.opacity = '0';
        setTimeout(() => hidePost(article), 300);
        chrome.runtime.sendMessage({
          type: 'overrideCacheEntry',
          post: formatPostForEvaluation(content),
          imageUrls: content.imageUrls || [],
          shouldHide: true,
          reasoning
        }).catch(err => console.error('[Bouncer] Override cache error:', err));
      };

      customInput.addEventListener('click', (e) => e.stopPropagation());
      customInput.addEventListener('input', () => {
        customWrapper.classList.toggle('has-text', customInput.value.length > 0);
      });
      customInput.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') {
          ke.stopPropagation();
          submitCustomInput();
        }
      });
      sendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        submitCustomInput();
      });

      customWrapper.appendChild(customInput);
      customWrapper.appendChild(sendBtn);
      tooltip.appendChild(customWrapper);
    } else {
      tooltip.replaceChildren(parseHTML('<span class="ff-annoying-empty">No suggestions</span>'));
    }
      // "Should have been filtered" link
      const missedLink = document.createElement('a');
      missedLink.className = 'ff-missed-link';
      missedLink.textContent = 'This should already be filtered';
      missedLink.href = '#';
      missedLink.addEventListener('click', (linkEvent) => {
        linkEvent.preventDefault();
        linkEvent.stopPropagation();
        const reasoning = _deps.postReasonings.get(article);
        chrome.runtime.sendMessage({
          type: 'sendFeedback',
          siteId: _deps.adapter.siteId,
          tweetData: { text: formatPostForEvaluation(content), imageUrls: content.imageUrls || [] },
          rawResponse: reasoning?.rawResponse || '',
          reasoning: reasoning?.reasoning || '',
          decision: 'false_negative'
        }).catch(err => console.error('[Bouncer] Missed feedback error:', err));
        tooltip.remove();
        storeFilteredPost(article, content, 'User reported: should have been filtered');
        article.style.transition = 'opacity 0.3s ease';
        article.style.opacity = '0';
        setTimeout(() => hidePost(article), 300);
        chrome.runtime.sendMessage({
          type: 'overrideCacheEntry',
          post: formatPostForEvaluation(content),
          imageUrls: content.imageUrls || [],
          shouldHide: true,
          reasoning: 'User reported: should have been filtered'
        }).catch(err => console.error('[Bouncer] Override cache error:', err));
      });
      tooltip.appendChild(missedLink);

    // Reposition after content change (height may differ from spinner)
    requestAnimationFrame(positionTooltip);
    })().catch(err => console.error('[UI] annoying reasons tooltip failed:', err));
  });

  // Outside-click tooltip dismissal is handled by a single module-level
  // listener registered via setupAnnoyingTooltipCloser — do NOT register a
  // per-button document listener here (it would accumulate one per post and
  // fire for every click on the page).
}

// Close any open .ff-annoying-tooltip when the user clicks outside of its
// button and the tooltip itself. Registered once per page from initUI.
// On iOS, use capture phase to swallow the dismissing click so the tap only
// closes the tooltip and doesn't also activate the thing it landed on.
export function setupAnnoyingTooltipCloser() {
  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    // If the click is on any why-annoying button, let that button's own
    // click handler manage the tooltip. Skip.
    if (target instanceof Element && target.closest('.ff-why-annoying-btn')) return;
    const tooltips = document.querySelectorAll('.ff-annoying-tooltip');
    if (tooltips.length === 0) return;
    let removedAny = false;
    tooltips.forEach((t) => {
      if (!t.contains(target)) {
        t.remove();
        removedAny = true;
      }
    });
    if (removedAny && _deps.IS_IOS) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

// Hide bouncer sidebar when Twitter's search suggestions menu is open (so it doesn't cover the dropdown)
export function setupSearchBarHide() {
  new MutationObserver(() => {
    const form = _deps.adapter.getSearchForm();
    const secondChild = form?.children[1];
    const menuOpen = secondChild && secondChild.innerHTML.trim() !== '';
    if (filterPhrasesContainer) {
      filterPhrasesContainer.style.display = menuOpen ? 'none' : '';
    }
  }).observe(document.body, { childList: true, subtree: true });
}

export function handleDOMMutation() {
  // Check if containers were disconnected
  if (filterPhrasesContainer && !filterPhrasesContainer.isConnected) {
    filterPhrasesContainer = null;
    filteredTabActive = false;
  }
  if (bottomFilterContainer && !bottomFilterContainer.isConnected) {
    bottomFilterContainer = null;
    bottomFilterExpanded = true;
  }
  if (mobileFilterContainer && !mobileFilterContainer.isConnected) {
    mobileFilterContainer = null;
  }
  // Inject filter phrases input if not present
  if (!filterPhrasesContainer && document.querySelector(_deps.adapter.selectors.sidebar)) {
    injectFilterPhrasesInput();
  } else {
    updateSidebarFilterVisibility();
  }
  // Inject bottom filter box if not present
  if (!bottomFilterContainer) {
    injectBottomFilterBox();
  } else {
    updateBottomFilterVisibility();
  }
  // Inject mobile filter box if not present
  if (!mobileFilterContainer && document.querySelector(_deps.adapter.selectors.nav)) {
    injectMobileFilterBox();
  } else {
    updateMobileFilterVisibility();
  }
}
