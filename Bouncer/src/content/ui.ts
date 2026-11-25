// All UI injection, modals, alerts, theming, filter phrase management

import { asyncHandler } from '../shared/async';
import { escapeHtml, formatPostForEvaluation, parseHTML } from '../shared/utils';
import { FILTER_LABEL_GUIDANCE } from '../shared/filter-guidance';
import { decideMatches, MAX_ACTIVE_FILTERS, MAX_FILTERS_CHARACTERS, MAX_FILTERS_WARNING } from '../shared/decision-model';
import type { ClassificationDetails, ContentUIDeps, FilteredPost, PostContent, LocalModelStatus } from '../types';
import { createClassificationDetails } from './classification-details';
import { localModelStatusView, normalizeLocalModelStatus } from '../shared/engine-status-view';
import { getStorage, getDescriptions } from '../shared/storage';
import {
  tooltipContentMaxHeight,
  tooltipHorizontalPosition,
  tooltipVerticalPosition,
} from './geometry';
import { cancelScheduledFilteredHide, hasScheduledFilteredHide, restoreFilteredContainer, scheduleFilteredHide } from './dom-state';
import {
  currentPostDecision, displayedMatches, forgetPostDecision, getPostDecision, hasScoresForFilters,
  isPostIdentityCurrent, postIdentity, rememberPostDecision, survivingMatches,
  type LivePostDecision,
} from './filter-actions';

// Dependencies (set by initUI from index.ts)
let _deps: ContentUIDeps;

export function initUI(deps: ContentUIDeps) {
  _deps = deps;

  // Reinjection on an already-loaded tab must not leave duplicate UI. The new injection has a
  // fresh module scope, so its filter-container variables are null and the
  // injection guards think no box exists — resulting in duplicate UI.
  // Proactively remove any leftover boxes from a prior injection.
  const stale = document.querySelectorAll(
    '.filter-phrases-sidebar, .filter-phrases-bottom, .filter-phrases-mobile, .filter-strictness-popover'
  );
  console.log('[Bouncer] initUI: clearing', stale.length, 'stale filter box(es) from prior injection');
  stale.forEach((el) => el.remove());

  // Register the single page-wide tooltip-dismissal listener (replaces a
  // per-post capture-phase listener that used to accumulate with each post).
  setupBounceTooltipCloser();
}

// ==================== UI State ====================

// Filtered posts storage
const MAX_FILTERED_POSTS = 500;
const filteredPosts: FilteredPost[] = [];
const filteredPostKeys = new Set<string>();
const filteredKeyByArticle = new WeakMap<HTMLElement, string>();
interface RestoreStatus {
  pending: boolean;
  error?: string;
}
// Status contains no DOM nodes or snapshot references. It survives row
// replacement only while the corresponding snapshot remains retained.
const filteredRestoreStatuses = new WeakMap<FilteredPost, RestoreStatus>();
const renderedFilteredSnapshots = new WeakMap<HTMLElement, FilteredPost>();
let reconciledFilterPhrases: string[] | undefined;
let strictFilterPhrases: readonly string[] = [];
let phraseSyncRead = 0;

export function getStrictFilterPhrases(): readonly string[] { return strictFilterPhrases; }

type PostReasoning = ReturnType<ContentUIDeps['postReasonings']['get']>;
interface SettledPostDecision {
  decision?: LivePostDecision;
  reasoning?: PostReasoning;
}
interface DecisionPersistence {
  state: 'extracting' | 'writing' | 'committed' | 'canceled' | 'failed';
  settled: Promise<void>;
  result?: SettledPostDecision;
  previousDecision?: LivePostDecision;
  previousReasoning?: PostReasoning;
}
type ExplicitPostDecision = LivePostDecision & { persistence?: DecisionPersistence };

function completeDecisionPersistence(persistence: DecisionPersistence, state: 'committed' | 'canceled' | 'failed', result: SettledPostDecision): void {
  let decision = result.decision;
  // Provisional manual ownership can delay the automatic rule-edit handling.
  // Recheck its predecessor against the latest observed rules after all awaits,
  // including outcomes retained by an earlier failed reservation.
  const scores = result.reasoning?.scores?.filter(({ label }) => reconciledFilterPhrases?.includes(label));
  if (decision && !decision.userOverride && scores?.length) {
    const judged = decideMatches(scores, result.reasoning?.textSent, strictFilterPhrases);
    decision = { ...decision, shouldHide: judged.shouldHide, matches: judged.matches };
    result = { ...result, reasoning: { ...result.reasoning!, scores, shouldHide: judged.shouldHide,
      matches: judged.matches, category: judged.matches.join(', ') || null,
      reasoning: judged.shouldHide ? `Matched: ${judged.matches.join(', ')}` : 'No matching filters' } };
  } else if (decision?.shouldHide && !decision.userOverride && reconciledFilterPhrases) {
    const matches = survivingMatches(decision.matches, reconciledFilterPhrases);
    decision = { ...decision, shouldHide: !!matches?.length, matches: matches ?? undefined };
    result = { ...result, reasoning: matches?.length && result.reasoning
      ? { ...result.reasoning, matches, category: matches.join(', ') }
      : undefined };
  }
  persistence.result = {
    ...result,
    // Settled outcomes contain no action lineage, so retries cannot retain an
    // ever-growing chain of completed reservations and provisional Bounces.
    decision: decision ? { identity: decision.identity, shouldHide: decision.shouldHide, matches: decision.matches ? [...decision.matches] : undefined, userOverride: decision.userOverride, evaluationText: decision.evaluationText } : undefined,
  };
  persistence.state = state;
  delete persistence.previousDecision;
  delete persistence.previousReasoning;
}

async function settledPostDecision(decision: LivePostDecision | undefined, reasoning: PostReasoning): Promise<SettledPostDecision> {
  while (decision) {
    const persistence = (decision as ExplicitPostDecision).persistence;
    if (!persistence) return { decision, reasoning };
    if (persistence.state === 'writing') await persistence.settled;
    if (persistence.result) return persistence.result;
    // Extraction has not written anything; a later explicit action abandons
    // this provisional Bounce and falls back to its actual predecessor.
    reasoning = persistence.previousReasoning;
    decision = persistence.previousDecision;
  }
  return { reasoning };
}

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
const bounceTooltipCleanup = new WeakMap<HTMLElement, () => void>();

function removeBounceTooltip(tooltip: Element): void {
  if (tooltip instanceof HTMLElement) {
    bounceTooltipCleanup.get(tooltip)?.();
    bounceTooltipCleanup.delete(tooltip);
  }
  tooltip.remove();
}

// Track previous count for animation
let previousFilteredCount = 0;

// Feed-level model-status indicator (bottom-left, theme-aware): one state-driven
// element shown when the local model isn't ready to classify. See updateModelStatusIndicator.
let modelStatusEl: HTMLElement | null = null;
let modelStatusDismissed: string | null = null; // derived state the user dismissed

// ==================== Update Banner ====================

// ==================== Placeholder animation ====================

const PLACEHOLDER_PHRASES = ['posts asking for likes or reposts', 'celebrity gossip', 'crypto price predictions', 'posts mocking strangers'];
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



// X-style horizontal ellipsis icon used by the settings button on the actions row.
const settingsIconSVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g><path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"></path></g></svg>';

// ==================== State Accessors ====================

export function getFilteredPosts() { return filteredPosts; }
export function getFilteredTabActive() { return filteredTabActive; }

// ==================== Filtered Posts ====================

export function clearFilteredPosts() {
  filteredPosts.forEach(post => filteredRestoreStatuses.delete(post));
  filteredPosts.length = 0;
  filteredPostKeys.clear();
  updateFilteredTabCount();
  // Re-render filtered view if it's currently showing
  if (filteredTabActive && filteredViewContainer) {
    const content = filteredViewContainer.querySelector('.filtered-modal-content');
    if (content) renderFilteredPostsView(content);
  }
}

function filteredPostKey(post: FilteredPost): string {
  return post.post.postUrl || post.evaluationText.substring(0, 200);
}

function applyRestoreStatus(button: HTMLButtonElement, errorEl: HTMLElement, status?: RestoreStatus): void {
  button.disabled = status?.pending ?? false;
  button.textContent = status?.pending ? 'Restoring…' : status?.error ? 'Retry Restore' : 'Restore';
  errorEl.textContent = status?.error || '';
}

function refreshRestoreControls(status?: RestoreStatus): void {
  const rows = document.querySelectorAll<HTMLElement>('.slop-post-wrapper');
  if (!rows.length) return;
  const retained = new Map(filteredPosts.map(post => [filteredPostKey(post), post]));
  rows.forEach(row => {
    const rendered = renderedFilteredSnapshots.get(row);
    const post = rendered ? retained.get(filteredPostKey(rendered)) : undefined;
    const currentStatus = post ? filteredRestoreStatuses.get(post) : undefined;
    if (status && currentStatus !== status) return;
    const button = row.querySelector<HTMLButtonElement>('.slop-restore');
    const errorEl = row.querySelector<HTMLElement>('.slop-restore-error');
    if (button && errorEl) applyRestoreStatus(button, errorEl, currentStatus);
  });
}

function refreshFilteredPostsView(): void {
  updateFilteredTabCount();
  const containers = document.querySelectorAll('.filtered-modal-content');
  containers.forEach(renderFilteredPostsView);
}

export function removeFilteredPostForArticle(article: HTMLElement, refresh = true): void {
  const content = _deps.extractPostContent(article);
  const key = filteredKeyByArticle.get(article)
    || content.postUrl || formatPostForEvaluation(content).substring(0, 200);
  const index = filteredPosts.findIndex(post => filteredPostKey(post) === key);
  if (index !== -1) {
    filteredRestoreStatuses.delete(filteredPosts[index]);
    filteredPosts.splice(index, 1);
  }
  filteredPostKeys.delete(key);
  filteredKeyByArticle.delete(article);
  if (index !== -1 && refresh) refreshFilteredPostsView();
}

export function resetPostForRecycling(article: HTMLElement): void {
  restoreFilteredContainer(_deps.adapter.getPostContainer(article), article);
  forgetPostDecision(article);
  removeFilteredPostForArticle(article);
  postDetectorStates.delete(article);
  _deps.postReasonings.delete(article);
  _deps.processedPosts.delete(article);
  _deps.pendingPosts.delete(article);
  clearPendingDimTimer(article);
  article.removeAttribute('data-ff-pending');
  delete article.dataset.pendingStartTime;
  article.querySelector('.post-verification-bar')?.remove();
}

/** Reconcile every live hiding unit, including adapter-hidden thread siblings. */
export function reconcileFilterChanges(phrases: string[], processRestoredPosts = true): void {
  reconciledFilterPhrases = [...phrases];
  const posts = _deps.findPosts();
  const liveContainers = new Set(posts.map(article => _deps.adapter.getPostContainer(article)));
  let shouldProcessRestoredPosts = false;
  for (const article of posts) {
    const container = _deps.adapter.getPostContainer(article);
    const decision = currentPostDecision(_deps.adapter, article);
    if (decision?.userOverride) continue;
    const hidden = container.dataset.filteredByExtension === 'true' || hasScheduledFilteredHide(article);
    if (!decision?.shouldHide && !hidden) continue;
    const matches = decision?.shouldHide ? survivingMatches(decision.matches, phrases) : null;
    if (matches?.length) {
      rememberPostDecision(article, { ...decision!, matches });
      if (hasScheduledFilteredHide(article)) {
        cancelScheduledFilteredHide(article);
        hidePost(article);
      }
      const stored = _deps.postReasonings.get(article);
      if (stored) Object.assign(stored, { matches, category: matches.join(', ') });
      const detectors = postDetectorStates.get(article);
      detectors?.byName.forEach(state => {
        if (state.shouldHide) Object.assign(state, { matches: [...matches], category: matches.join(', ') });
      });
      refreshActivePopupIfFor(article);
      continue;
    }
    restoreFilteredContainer(container, article);
    forgetPostDecision(article);
    _deps.processedPosts.delete(article);
    _deps.postReasonings.delete(article);
    postDetectorStates.delete(article);
    removeFilteredPostForArticle(article, false);
    markPostVerified(article);
    if (matches === null) shouldProcessRestoredPosts = true;
    refreshActivePopupIfFor(article);
  }
  // A virtualized cell can temporarily have no article. Its Bouncer marker is
  // sufficient authority to restore it; newly mounted content is observed later.
  document.querySelectorAll<HTMLElement>('[data-filtered-by-extension="true"]').forEach(container => {
    if (!liveContainers.has(container)) {
      restoreFilteredContainer(container);
    }
  });
  for (let index = filteredPosts.length - 1; index >= 0; index--) {
    const post = filteredPosts[index];
    if (post.userOverride) continue;
    const matches = survivingMatches(post.matches, phrases);
    if (matches?.length) {
      post.matches = matches;
      post.category = matches.join(', ');
    } else {
      filteredRestoreStatuses.delete(post);
      filteredPosts.splice(index, 1);
      filteredPostKeys.delete(filteredPostKey(post));
    }
  }
  refreshFilteredPostsView();
  if (shouldProcessRestoredPosts && processRestoredPosts) _deps.processExistingPosts();
}

/** Apply a level edit to retained probabilities, including posts currently visible. */
export function reconcileFilterStrictness(phrases: string[], strictPhrases: readonly string[], posts: HTMLElement[] = _deps.findPosts()): void {
  reconciledFilterPhrases = [...phrases];
  strictFilterPhrases = [...strictPhrases];
  const hides: HTMLElement[] = [];
  for (const article of posts) {
    const decision = currentPostDecision(_deps.adapter, article);
    if (decision?.userOverride) continue;
    const stored = _deps.postReasonings.get(article);
    // A removal leaves usable evidence for every surviving phrase. Retired
    // labels must neither reject that evidence nor participate in its verdict.
    const scores = stored?.scores?.filter(({ label }) => phrases.includes(label));
    const judged = decideMatches(scores ?? [], stored?.textSent, strictFilterPhrases);
    if (decision && stored && scores?.length && (judged.shouldHide || hasScoresForFilters(scores, phrases))) {
      stored.scores = scores;
      Object.assign(stored, { shouldHide: judged.shouldHide, matches: judged.matches, category: judged.matches.join(', ') || null,
        reasoning: judged.shouldHide ? `Matched: ${judged.matches.join(', ')}` : 'No matching filters' });
      rememberPostDecision(article, { ...decision, shouldHide: judged.shouldHide, matches: judged.matches });
      postDetectorStates.delete(article);
      if (judged.shouldHide) {
        const content = _deps.extractPostContent(article);
        storeFilteredPost(article, content, stored.reasoning, stored.rawResponse || '', stored.category || null,
          judged.matches, false, decision.evaluationText || formatPostForEvaluation(content), stored);
        cancelScheduledFilteredHide(article);
        hides.push(article);
      } else {
        restoreFilteredContainer(_deps.adapter.getPostContainer(article), article);
        removeFilteredPostForArticle(article, false);
        if (!stored.isModelError) markPostVerified(article);
      }
      _deps.processedPosts.add(article);
      refreshActivePopupIfFor(article);
    } else {
      // A nonmatching partial vector cannot rule out the missing filters.
      // Preserve pending/error UI while the worker supplies the missing evidence.
      restoreFilteredContainer(_deps.adapter.getPostContainer(article), article);
      forgetPostDecision(article);
      _deps.processedPosts.delete(article);
      if (!_deps.pendingPosts.has(article) && !stored?.isModelError && !article.classList.contains('ff-error')) {
        _deps.postReasonings.delete(article);
        postDetectorStates.delete(article);
        markPostVerified(article);
      }
      removeFilteredPostForArticle(article, false);
      refreshActivePopupIfFor(article);
    }
  }
  // Restore/release individual replies before applying their parents' thread
  // hides, just as a fresh evaluation would. Explicit restores remain exempt.
  hides.forEach(hidePost);
  for (let index = filteredPosts.length - 1; index >= 0; index--) {
    const post = filteredPosts[index];
    if (post.userOverride) continue;
    const classification = post.classification;
    const scores = classification?.scores?.filter(({ label }) => phrases.includes(label));
    const judged = decideMatches(scores ?? [], classification?.textSent, strictFilterPhrases);
    if (classification) classification.scores = scores;
    if (judged.shouldHide) {
      post.matches = judged.matches;
      post.category = judged.matches.join(', ');
      post.reasoning = `Matched: ${judged.matches.join(', ')}`;
    } else {
      filteredRestoreStatuses.delete(post);
      filteredPosts.splice(index, 1);
      filteredPostKeys.delete(filteredPostKey(post));
    }
  }
  refreshFilteredPostsView();
  refreshPhrasePopover();
  syncFilterPhrases();
}

// ==================== Theme ====================

export function updateTheme() {
  const theme = _deps.adapter.getThemeMode();
  const elements = [filterPhrasesContainer, filteredViewContainer, bottomFilterContainer, mobileFilterContainer].filter(Boolean) as Element[];

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
      <div class="filter-phrases-actions">
        <div class="filter-phrases-actions-left">
          <button class="filtered-toggle-btn">
            <span class="filtered-toggle-text">View filtered</span>
            <span class="filtered-toggle-count">(0)</span>
          </button>
        </div>
        <div class="filter-phrases-actions-right">
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
  const toggleBtn = container.querySelector('.filtered-toggle-btn')!;
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

  // Load and render saved descriptions
  syncFilterPhrases();

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
        for (let index = 0; index < phrases.length; index++) {
          if (!await addFilterPhrase(phrases[index]) && !(await getDescriptions(_deps.descriptionsKey)).includes(phrases[index])) {
            input.value = phrases.slice(index).join(', ');
            updatePlaceholderVisibility();
            return;
          }
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
  const read = ++phraseSyncRead;
  getDescriptions(_deps.descriptionsKey).then(descriptions => {
    if (read !== phraseSyncRead) return;

    // Update desktop/tablet/mobile containers
    [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer].forEach(container => {
      if (container && container.isConnected) {
        const phrasesListContainer = container.querySelector('.filter-phrases-list');
        if (phrasesListContainer) {
          renderPhrasesInContainer(phrasesListContainer, descriptions);
        }
      }
    });
    refreshPhrasePopover();

  }).catch(err => console.error('[UI] Failed to sync filter phrases:', err));
}

function activeFilterPhrases(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((phrase): phrase is string => typeof phrase === 'string' && !!phrase.trim()) : [];
}

function renderPhrasesInContainer(container: Element, descriptions: string[]) {
  descriptions = activeFilterPhrases(descriptions);
  const previousAnchor = phrasePopover?.anchor;
  const replacesAnchor = previousAnchor && container.contains(previousAnchor);
  container.replaceChildren();
  const len = descriptions.length;
  descriptions.forEach((desc, index) => {
    const phrase = document.createElement('button');
    phrase.type = 'button';
    phrase.className = 'filter-phrase-inline';
    phrase.dataset.filterPhrase = desc;
    phrase.textContent = desc;
    phrase.setAttribute('aria-haspopup', 'dialog');
    phrase.setAttribute('aria-expanded', String(!!(phrasePopover?.phrase === desc && replacesAnchor)));
    if (strictFilterPhrases.includes(desc)) {
      const pill = document.createElement('span');
      pill.className = 'filter-strict-pill';
      pill.textContent = 'Strict';
      phrase.appendChild(pill);
    }
    phrase.addEventListener('click', () => {
      if (phrasePopover?.anchor === phrase) closePhrasePopover();
      else openPhrasePopover(phrase, desc);
    });
    container.appendChild(phrase);
    if (replacesAnchor && phrasePopover?.phrase === desc) {
      phrasePopover.anchor = phrase;
    }

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
  if (replacesAnchor && phrasePopover && !descriptions.includes(phrasePopover.phrase)) closePhrasePopover();
}

interface PhrasePopover {
  element: HTMLElement;
  phrase: string;
  anchor: HTMLButtonElement;
  returnFocus: HTMLElement;
  saving: boolean;
  cleanup: () => void;
}
let phrasePopover: PhrasePopover | undefined;
let phrasePopoverId = 0;

function closePhrasePopover(returnFocus = true): void {
  const current = phrasePopover;
  if (!current) return;
  phrasePopover = undefined;
  current.cleanup();
  current.element.remove();
  current.anchor.setAttribute('aria-expanded', 'false');
  if (returnFocus || document.activeElement === document.body || current.element.contains(document.activeElement)) {
    if (current.anchor.isConnected) current.anchor.focus();
    else if (current.returnFocus.isConnected) current.returnFocus.focus();
  }
}

function refreshPhrasePopover(): void {
  const current = phrasePopover;
  if (!current) return;
  if (!current.anchor.isConnected) {
    closePhrasePopover();
    return;
  }
  const strict = strictFilterPhrases.includes(current.phrase);
  current.element.querySelectorAll<HTMLButtonElement>('[data-strictness]').forEach(button => {
    button.setAttribute('aria-pressed', String((button.dataset.strictness === 'strict') === strict));
  });
  let total = 0;
  let restored = 0;
  const projectedStrict = [...new Set([...strictFilterPhrases, current.phrase])];
  const activePhrases = reconciledFilterPhrases ?? [];
  for (const post of filteredPosts) {
    if (!displayedMatches(post).includes(current.phrase)) continue;
    total++;
    const scores = post.classification?.scores?.filter(score => activePhrases.includes(score.label));
    if (!post.userOverride && scores?.some(score => score.label === current.phrase)
        && !decideMatches(scores, post.classification?.textSent, projectedStrict).shouldHide) restored++;
  }
  const impact = current.element.querySelector<HTMLElement>('.filter-strictness-impact')!;
  impact.hidden = strict || total === 0;
  impact.textContent = `Strict would bring back ${restored} of ${total} hidden posts.`;
  positionPhrasePopover();
}

function positionPhrasePopover(): void {
  const current = phrasePopover;
  if (!current) return;
  const rect = current.anchor.getBoundingClientRect();
  const width = current.element.getBoundingClientRect().width || 264;
  const height = current.element.getBoundingClientRect().height || 180;
  current.element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  const below = rect.bottom + 8;
  current.element.style.top = `${below + height <= window.innerHeight ? below : Math.max(8, rect.top - height - 8)}px`;
}

function openPhrasePopover(anchor: HTMLButtonElement, phrase: string): void {
  closePhrasePopover();
  const element = document.createElement('div');
  element.className = 'filter-strictness-popover';
  element.setAttribute('role', 'dialog');
  const title = document.createElement('strong');
  title.id = `filter-strictness-title-${++phrasePopoverId}`;
  title.textContent = phrase;
  element.setAttribute('aria-labelledby', title.id);
  const group = document.createElement('div');
  group.className = 'filter-strictness-options';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Strictness');
  for (const strict of [false, true]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.strictness = strict ? 'strict' : 'standard';
    button.textContent = strict ? 'Strict' : 'Standard';
    button.addEventListener('click', asyncHandler(async () => {
      const current = phrasePopover;
      if (!current || current.element !== element || current.saving || strictFilterPhrases.includes(phrase) === strict) return;
      current.saving = true;
      refreshPhrasePopover();
      try {
        const response: { success?: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
          type: 'setFilterStrictness', siteId: _deps.adapter.siteId, phrase, strict,
        });
        if (!response?.success) throw new Error(response?.error || 'Filter strictness could not be saved.');
      } catch (error) {
        console.error('[Bouncer] Filter strictness save failed:', error);
      } finally {
        current.saving = false;
        refreshPhrasePopover();
      }
    }));
    group.appendChild(button);
  }
  const impact = document.createElement('p');
  impact.className = 'filter-strictness-impact';
  const actions = document.createElement('div');
  actions.className = 'filter-strictness-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'filter-strictness-remove';
  remove.textContent = 'Remove filter';
  remove.addEventListener('click', asyncHandler(async () => {
    const returnFocus = phrasePopover?.returnFocus;
    await removeFilterPhrase(phrase);
    if (phrasePopover?.element === element) closePhrasePopover();
    if (!phrasePopover && returnFocus?.isConnected) returnFocus.focus();
  }));
  const done = document.createElement('button');
  done.type = 'button';
  done.textContent = 'Done';
  done.addEventListener('click', () => closePhrasePopover());
  actions.append(remove, done);
  element.append(title, group, impact, actions);
  const outside = (event: Event) => {
    if (event.target instanceof Node && !element.contains(event.target) && !phrasePopover?.anchor.contains(event.target)) closePhrasePopover(false);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); closePhrasePopover(false); }
  };
  document.addEventListener('click', outside, true);
  document.addEventListener('keydown', escape);
  window.addEventListener('resize', positionPhrasePopover);
  window.addEventListener('scroll', positionPhrasePopover, true);
  phrasePopover = { element, phrase, anchor,
    returnFocus: anchor.closest('.filter-phrases-container')?.querySelector<HTMLElement>('.filter-phrases-input') || anchor,
    saving: false, cleanup: () => {
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', escape);
    window.removeEventListener('resize', positionPhrasePopover);
    window.removeEventListener('scroll', positionPhrasePopover, true);
  } };
  anchor.setAttribute('aria-expanded', 'true');
  document.body.appendChild(element);
  refreshPhrasePopover();
  group.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
}

const CATEGORY_LIMIT_WARNING = 'You have too many filter categories - please remove some before adding more';

function filterLimitWarning(descriptions: string[], phrase: string): string | undefined {
  if (descriptions.includes(phrase)) return;
  if (descriptions.length >= MAX_ACTIVE_FILTERS) return MAX_FILTERS_WARNING;
  if (descriptions.reduce((total, value) => total + value.length, phrase.length) > MAX_FILTERS_CHARACTERS) return CATEGORY_LIMIT_WARNING;
}

export async function addFilterPhrase(text: string) {
  console.log('[Bouncer] addFilterPhrase called with:', text);
  text = text.trim();
  if (!text) return false;

  try {
    const descriptions = await getDescriptions(_deps.descriptionsKey);
    console.log('[Bouncer] Current descriptions:', descriptions);

    if (descriptions.includes(text)) { console.log('[Bouncer] Already exists'); return false; }

    const warning = filterLimitWarning(descriptions, text);
    if (warning) {
      showCategoryLimitWarning(warning);
      return false;
    }

    const response: { success?: boolean; added?: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: 'addFilterPhrase', siteId: _deps.adapter.siteId, phrase: text,
    });
    if (!response?.success) throw new Error(response?.error || 'The local filter action did not complete.');
    if (!response.added) return false;
    console.log('[Bouncer] addFilterPhrase complete');
    syncFilterPhrases();
    return true;
  } catch (err) {
    if (err instanceof Error && err.message === MAX_FILTERS_WARNING) showCategoryLimitWarning(MAX_FILTERS_WARNING);
    if (err instanceof Error && err.message === 'Filter phrases exceed the 1000-character limit.') showCategoryLimitWarning(CATEGORY_LIMIT_WARNING);
    console.error('[Bouncer] addFilterPhrase error:', err);
    return false;
  }
}

export async function removeFilterPhrase(phrase: string) {
  const response: { success?: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
    type: 'removeFilterPhrase', siteId: _deps.adapter.siteId, phrase,
  });
  if (!response?.success) throw new Error(response?.error || 'The local filter action did not complete.');
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

  const iframe = document.createElement('iframe');
  iframe.className = 'settings-modal-iframe';
  iframe.src = chrome.runtime.getURL('popup.html');
  iframe.addEventListener('load', () => {
    const theme = _deps.adapter.getThemeMode();
    iframe.contentWindow?.postMessage({ type: 'setTheme', theme }, '*');
  });
  settingsModal.appendChild(iframe);
  document.body.appendChild(settingsModal);

  // Listen for messages from iframe
  let hasResized = false;
  const messageHandler = (event: MessageEvent<{ type?: string; height?: number }>) => {
    if (event.source !== iframe.contentWindow || !event.data) return;
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
      const toggleBtn = container.querySelector('.filtered-toggle-btn');
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
  refreshPhrasePopover();
}

// ==================== Local model status ====================

interface ModelStatusView {
  variant: 'info' | 'progress' | 'warning';
  body: string;
  dismissible: boolean;
}

export function modelStatusView(status: LocalModelStatus): ModelStatusView | null {
  status = normalizeLocalModelStatus(status);
  if (status.state === 'ready') return null;
  const view = localModelStatusView(status);
  const progress = status.state === 'checking';
  return {
    variant: progress ? 'progress' : view.tone === 'error' ? 'warning' : 'info',
    body: view.text,
    dismissible: !progress,
  };
}

function ensureModelStatusEl(): HTMLElement {
  if (modelStatusEl && document.body.contains(modelStatusEl)) return modelStatusEl;
  modelStatusEl = document.createElement('div');
  modelStatusEl.className = 'bouncer-model-status';
  document.body.appendChild(modelStatusEl);
  return modelStatusEl;
}

let statusFilteringEnabled = true;
let statusHasFilters = false;
let modelStatusPresentationRevision = 0;

export function updateModelStatusIndicator(status: LocalModelStatus): void {
  status = normalizeLocalModelStatus(status);
  const presentationRevision = ++modelStatusPresentationRevision;
  const condition = status.state;
  if (modelStatusDismissed !== condition) modelStatusDismissed = null;
  const view = !statusFilteringEnabled || !statusHasFilters || modelStatusDismissed === condition
    ? null : modelStatusView(status);
  if (!view) {
    modelStatusEl?.classList.remove('visible');
    return;
  }
  const el = ensureModelStatusEl();
  el.classList.remove('bouncer-model-status--info', 'bouncer-model-status--progress', 'bouncer-model-status--warning');
  el.classList.add(`bouncer-model-status--${view.variant}`);
  el.replaceChildren(parseHTML(
    `<span class="bouncer-model-status-dot"></span>` +
    `<span class="bouncer-model-status-text"><strong>Bouncer:</strong> ${escapeHtml(view.body)}</span>` +
    '<button class="bouncer-model-status-settings" type="button">Settings</button>' +
    (view.dismissible ? '<button class="bouncer-model-status-close" aria-label="Dismiss">&times;</button>' : '')
  ));
  el.querySelector('.bouncer-model-status-settings')?.addEventListener('click', showSettingsModal);
  el.querySelector('.bouncer-model-status-close')?.addEventListener('click', () => {
    modelStatusDismissed = condition;
    el.classList.remove('visible');
  });
  requestAnimationFrame(() => {
    if (presentationRevision === modelStatusPresentationRevision && statusFilteringEnabled
        && statusHasFilters && modelStatusDismissed !== condition) el.classList.add('visible');
  });
}

interface ModelLoadingStorageSnapshot {
  nativeModelStatus?: unknown;
}
interface ModelLoadingCoordinator {
  handleChanges: (changes: Record<string, chrome.storage.StorageChange>) => void;
  finishInitialLoad: (snapshot: ModelLoadingStorageSnapshot) => void;
  getStatus: () => LocalModelStatus;
}

const initialModelStatus = (): LocalModelStatus => ({ state: 'checking', message: '', revision: 0 });
const wasUnavailable = (status: LocalModelStatus | undefined): boolean => !!status
  && ['unavailable', 'missing_model', 'settings_required'].includes(status.state);

/** Listener-before-snapshot initialization retains newer model status revisions. */
export function createModelLoadingCoordinator(
  render: (status: LocalModelStatus) => void,
  processExistingPosts: () => void,
): ModelLoadingCoordinator {
  let currentStatus = initialModelStatus();
  let initialLoadFinished = false;
  const queuedChanges: Array<Record<string, chrome.storage.StorageChange>> = [];
  let lastReprocessedReadyRevision: number | undefined;
  let reprocessWhenReady = false;
  const applyChanges = (changes: Record<string, chrome.storage.StorageChange>, shouldRender: boolean) => {
    const storageChange = changes.nativeModelStatus;
    if (!storageChange) return;
    const next = normalizeLocalModelStatus(storageChange.newValue);
    if (!(next.revision > currentStatus.revision
        || !shouldRender && next.revision === currentStatus.revision && next.state === currentStatus.state)) return;
    const previous = storageChange.oldValue === undefined ? currentStatus : normalizeLocalModelStatus(storageChange.oldValue);
    currentStatus = next;
    if (wasUnavailable(previous) || wasUnavailable(next)) reprocessWhenReady = true;
    if (next.state === 'ready' && reprocessWhenReady) {
      reprocessWhenReady = false;
      if (lastReprocessedReadyRevision !== next.revision) {
        lastReprocessedReadyRevision = next.revision;
        processExistingPosts();
      }
    }
    if (shouldRender) render(currentStatus);
  };
  return {
    handleChanges(changes) {
      if (!initialLoadFinished) { queuedChanges.push(changes); return; }
      applyChanges(changes, true);
    },
    finishInitialLoad(snapshot) {
      if (initialLoadFinished) return;
      currentStatus = snapshot.nativeModelStatus === undefined ? initialModelStatus() : normalizeLocalModelStatus(snapshot.nativeModelStatus);
      reprocessWhenReady = wasUnavailable(currentStatus) || queuedChanges.some(changes => {
        const change = changes.nativeModelStatus;
        return wasUnavailable(normalizeLocalModelStatus(change?.oldValue))
          || wasUnavailable(normalizeLocalModelStatus(change?.newValue));
      });
      for (const changes of queuedChanges) applyChanges(changes, false);
      queuedChanges.length = 0;
      if (currentStatus.state === 'ready' && reprocessWhenReady) {
        reprocessWhenReady = false;
        if (lastReprocessedReadyRevision !== currentStatus.revision) {
          lastReprocessedReadyRevision = currentStatus.revision;
          processExistingPosts();
        }
      }
      initialLoadFinished = true;
      render(currentStatus);
    },
    getStatus: () => currentStatus,
  };
}

let modelLoadingListenerInitialized = false;
export function initModelLoadingListener(): void {
  if (modelLoadingListenerInitialized) return;
  modelLoadingListenerInitialized = true;
  const descriptionsKey = _deps.descriptionsKey;
  let snapshotPending = true;
  const changedContext = new Set<string>();
  const coordinator = createModelLoadingCoordinator(
    status => updateModelStatusIndicator(status),
    () => _deps.processExistingPosts(),
  );
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (snapshotPending) Object.keys(changes).forEach(key => changedContext.add(key));
    if (changes.enabled) statusFilteringEnabled = changes.enabled.newValue !== false;
    if (changes[descriptionsKey]) statusHasFilters = activeFilterPhrases(changes[descriptionsKey].newValue).length > 0;
    coordinator.handleChanges(changes);
    if (changes.enabled || changes[descriptionsKey]) updateModelStatusIndicator(coordinator.getStatus());
  });
  getStorage(['nativeModelStatus', 'enabled', descriptionsKey])
    .then(data => {
      if (!changedContext.has('enabled')) statusFilteringEnabled = data.enabled !== false;
      if (!changedContext.has(descriptionsKey)) statusHasFilters = activeFilterPhrases(data[descriptionsKey]).length > 0;
      snapshotPending = false;
      coordinator.finishInitialLoad(data);
    })
    .catch(err => {
      console.error('[UI] Failed to load local model status:', err);
      snapshotPending = false;
      coordinator.finishInitialLoad({});
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
    renderedFilteredSnapshots.set(wrapper, post);

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

    if (displayedMatches(post).length) {
      const names = displayedMatches(post);
      if (names.length > 0) {
        const tagGroup = document.createElement('div');
        tagGroup.style.display = 'flex';
        tagGroup.style.gap = '5px';
        tagGroup.style.marginLeft = '8px';
        for (const name of names) {
          const tag = document.createElement('span');
          tag.className = 'slop-category-tag';
          tag.style.marginLeft = '0';
          tag.textContent = name.toUpperCase();
          tagGroup.appendChild(tag);
        }
        top.appendChild(tagGroup);
      }
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

    // Show exact matches for classifications and labeled manual actions.
    // A manual action without a label uses its current action text instead.
    const reasoning = document.createElement('div');
    reasoning.className = 'slop-post-reasoning';
    reasoning.textContent = displayedMatches(post).length
      ? `Matched: ${displayedMatches(post).map(label => {
        const score = post.classification?.scores?.find(entry => entry.label === label)?.score;
        return score === undefined ? label : `${label} · ${score.toFixed(2)}`;
      }).join(', ')}`
      : (post.reasoning || 'Filtered');
    body.appendChild(reasoning);

    // Actions row
    const actions = document.createElement('div');
    actions.className = 'slop-post-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'slop-restore';
    restoreBtn.textContent = 'Restore';
    const restoreError = document.createElement('span');
    restoreError.className = 'slop-restore-error';
    restoreError.setAttribute('role', 'alert');
    applyRestoreStatus(restoreBtn, restoreError, filteredRestoreStatuses.get(post));
    restoreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      asyncHandler(() => restorePostSnapshot(post, restoreBtn, restoreError))();
    });
    actions.appendChild(restoreBtn);
    actions.appendChild(restoreError);
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

    // Keep interactive details outside the post link so selecting text or
    // opening the disclosure cannot navigate to X.
    wrapper.appendChild(createClassificationDetails(post.classification, postContent.postUrl, () => strictFilterPhrases));
    postsContainer.appendChild(wrapper);
  });
}

async function restorePostSnapshot(post: FilteredPost, button: HTMLButtonElement, errorEl: HTMLElement): Promise<void> {
  const key = filteredPostKey(post);
  post = filteredPosts.find(entry => filteredPostKey(entry) === key) || post;
  if (filteredRestoreStatuses.get(post)?.pending || button.disabled) return;
  const targets = _deps.findPosts().filter(article => {
    const content = _deps.extractPostContent(article);
    return post.post.postUrl
      ? _deps.adapter.getPostUrl(article) === post.post.postUrl
      : filteredKeyByArticle.get(article) === key && !!currentPostDecision(_deps.adapter, article)
        || formatPostForEvaluation(content) === post.evaluationText;
  }).map(article => {
    const identity = postIdentity(_deps.adapter, article);
    const decision = getPostDecision(article);
    let settlePersistence!: () => void;
    const persistence: DecisionPersistence = {
      state: 'writing', settled: new Promise(resolve => { settlePersistence = resolve; }),
      previousDecision: decision, previousReasoning: _deps.postReasonings.get(article),
    };
    // Claim this explicit action immediately, while preserving the current
    // hide until persistence succeeds. Earlier canonical lookups must yield.
    const reservation = { identity, shouldHide: decision?.shouldHide ?? true, matches: decision?.matches, userOverride: true, persistence };
    rememberPostDecision(article, reservation);
    return { article, identity, persistence, settlePersistence, restoreDecision: getPostDecision(article) };
  });
  const status: RestoreStatus = { pending: true };
  filteredRestoreStatuses.set(post, status);
  applyRestoreStatus(button, errorEl, status);
  refreshRestoreControls(status);
  try {
    const response: { success?: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: 'overrideCacheEntry', post: post.evaluationText, shouldHide: false,
      reasoning: 'User reported: false positive',
    });
    if (!response?.success) throw new Error(response?.error || 'The local Restore action did not complete.');

    for (const target of targets) {
      completeDecisionPersistence(target.persistence, 'committed', {
        decision: { identity: target.identity, shouldHide: false, userOverride: true },
        reasoning: { shouldHide: false, reasoning: 'User reported: false positive', userOverride: true },
      });
    }

    const index = filteredPosts.findIndex(entry => filteredPostKey(entry) === key);
    // A later explicit Bounce owns its snapshot and live hide. Automatic
    // refreshes of the same post still yield to this successful user Restore.
    const snapshot = filteredPosts[index];
    const superseded = snapshot && snapshot !== post && snapshot.userOverride;
    if (!superseded) {
      for (const target of targets) {
        if (!isPostIdentityCurrent(_deps.adapter, target.article, target.identity)) continue;
        if (getPostDecision(target.article) !== target.restoreDecision) continue;
        restoreFilteredContainer(_deps.adapter.getPostContainer(target.article), target.article);
        rememberPostDecision(target.article, { identity: target.identity, shouldHide: false, userOverride: true });
        _deps.postReasonings.set(target.article, { shouldHide: false, reasoning: 'User reported: false positive', userOverride: true });
        postDetectorStates.delete(target.article);
        _deps.processedPosts.delete(target.article);
        markPostVerified(target.article);
      }
      if (index !== -1) {
        filteredRestoreStatuses.delete(filteredPosts[index]);
        filteredPosts.splice(index, 1);
      }
      filteredPostKeys.delete(key);
      refreshFilteredPostsView();
    }
    filteredRestoreStatuses.delete(post);
  } catch (err) {
    console.error('[Bouncer] Restore action error:', err);
    for (const target of targets) {
      const previous = await settledPostDecision(target.persistence.previousDecision, target.persistence.previousReasoning);
      // Record the settled outcome even if another action now owns the live
      // post: that action may need this predecessor when it also fails.
      completeDecisionPersistence(target.persistence, 'failed', previous);
      const rollback = target.persistence.result!;
      if (!isPostIdentityCurrent(_deps.adapter, target.article, target.identity)
          || getPostDecision(target.article) !== target.restoreDecision) continue;
      if (rollback.decision) rememberPostDecision(target.article, rollback.decision);
      else forgetPostDecision(target.article);
      if (!rollback.decision?.shouldHide) {
        restoreFilteredContainer(_deps.adapter.getPostContainer(target.article), target.article);
        removeFilteredPostForArticle(target.article);
        markPostVerified(target.article);
      }
      if (rollback.reasoning) {
        _deps.postReasonings.set(target.article, rollback.reasoning);
      } else {
        _deps.postReasonings.delete(target.article);
      }
      if (rollback.decision && !rollback.decision.userOverride && !rollback.decision.shouldHide) {
        postDetectorStates.delete(target.article);
        if (reconciledFilterPhrases && hasScoresForFilters(rollback.reasoning?.scores, reconciledFilterPhrases)) {
          _deps.processedPosts.add(target.article);
        } else {
          _deps.processedPosts.delete(target.article);
          _deps.processExistingPosts();
        }
      }
    }
    status.error = `Restore failed: ${err instanceof Error ? err.message : 'Try again.'}`;
  } finally {
    for (const target of targets) target.settlePersistence();
    status.pending = false;
    refreshRestoreControls(status);
  }
}

// ==================== Filtered Post Storage ====================

export function storeFilteredPost(article: HTMLElement, contentObj: PostContent, reasoning: string, rawResponse = '', category: string | null = null, matches?: string[], userOverride?: boolean, evaluationText?: string, classification?: ClassificationDetails) {
  // Use postUrl or content hash as dedup key
  const evalText = evaluationText ?? formatPostForEvaluation(contentObj);
  const key = contentObj.postUrl || evalText.substring(0, 200);
  const classificationSnapshot = classification && !userOverride ? {
    scores: classification.scores?.map(({ label, score }) => ({ label, score })),
    textSent: classification.textSent,
    model: classification.model,
    timestamp: classification.timestamp,
  } : undefined;
  filteredKeyByArticle.set(article, key);
  if (filteredPostKeys.has(key)) {
    const index = filteredPosts.findIndex(post => filteredPostKey(post) === key);
    if (index !== -1) {
      const previous = filteredPosts[index];
      const status = filteredRestoreStatuses.get(previous);
      const replacement = { ...previous, evaluationText: evaluationText ?? previous.evaluationText, reasoning, rawResponse, category, matches: matches ? [...matches] : undefined, userOverride, classification: classificationSnapshot };
      filteredPosts[index] = replacement;
      if (status && !userOverride) filteredRestoreStatuses.set(replacement, status);
      filteredRestoreStatuses.delete(previous);
      refreshRestoreControls();
      refreshPhrasePopover();
    }
    return; // Already stored
  }
  filteredPostKeys.add(key);

  filteredPosts.push({
    post: contentObj,
    evaluationText: evalText,
    reasoning,
    rawResponse,
    category: category || null,
    matches: matches ? [...matches] : undefined,
    userOverride,
    classification: classificationSnapshot,
    timestamp: Date.now()
  });
  let evictedSnapshot = false;
  while (filteredPosts.length > MAX_FILTERED_POSTS) {
    const evicted = filteredPosts.shift()!;
    filteredPostKeys.delete(filteredPostKey(evicted));
    filteredRestoreStatuses.delete(evicted);
    evictedSnapshot = true;
  }
  if (evictedSnapshot) refreshFilteredPostsView();
  else updateFilteredTabCount();
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
  bar.classList.remove('verified');
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
  bar.classList.remove('pending');
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
  cancelScheduledFilteredHide(article);
  _deps.pendingPosts.delete(article);
  delete article.dataset.pendingStartTime;
  article.removeAttribute('data-ff-pending');
  clearPendingDimTimer(article);

  // The adapter owns deferred scroll hiding; explicit actions target one cell.
  _deps.adapter.hidePost(article, !currentPostDecision(_deps.adapter, article)?.userOverride,
    reply => { const decision = currentPostDecision(_deps.adapter, reply); return !!decision?.userOverride && !decision.shouldHide; });
}

/** One atomic background action establishes both the rule and durable override. */
export async function bouncePost(article: HTMLElement, content: PostContent, phrase: string, reasoning?: string): Promise<boolean> {
  if (typeof phrase !== 'string') return false;
  phrase = phrase.trim();
  if (!phrase) return false;
  reasoning ??= `User blocked: ${phrase}`;
  const identity = postIdentity(_deps.adapter, article);
  const currentContent = _deps.extractPostContent(article);
  if (!article.isConnected || currentContent.postUrl !== content.postUrl || formatPostForEvaluation(currentContent) !== formatPostForEvaluation(content)) return false;
  const matches = [phrase];
  let settlePersistence!: () => void;
  const persistence: DecisionPersistence = {
    state: 'extracting', settled: new Promise(resolve => { settlePersistence = resolve; }),
    previousDecision: getPostDecision(article), previousReasoning: _deps.postReasonings.get(article),
  };
  const decision = { identity, shouldHide: true, matches, userOverride: true, persistence };
  rememberPostDecision(article, decision);
  const manualDecision = getPostDecision(article);
  postDetectorStates.delete(article);
  const manualReasoning = { shouldHide: true, reasoning, category: phrase, matches, userOverride: true };
  _deps.postReasonings.set(article, manualReasoning);
  article.style.transition = 'opacity 0.3s ease';
  article.style.opacity = '0';
  scheduleFilteredHide(article, () => {
    if (!isPostIdentityCurrent(_deps.adapter, article, identity)) return;
    // A failed newer action can roll back to an automatic hide. Respect the
    // current identity-valid verdict rather than the old fade's action kind.
    if (currentPostDecision(_deps.adapter, article)?.shouldHide) hidePost(article);
    else restoreFilteredContainer(_deps.adapter.getPostContainer(article), article);
  });
  try {
    // Durable feedback uses the same complete post text as automatic evaluation;
    // the DOM display may contain only an excerpt.
    const [evaluationContent, descriptions] = await Promise.all([
      _deps.adapter.extractPostContentFromStore(article),
      getDescriptions(_deps.descriptionsKey),
    ]);
    if (!isPostIdentityCurrent(_deps.adapter, article, identity) || getPostDecision(article) !== manualDecision) {
      const previous = await settledPostDecision(persistence.previousDecision, persistence.previousReasoning);
      completeDecisionPersistence(persistence, 'canceled', previous);
      return false;
    }
    const warning = filterLimitWarning(descriptions, phrase);
    if (warning) {
      showCategoryLimitWarning(warning);
      throw new Error(warning);
    }
    if (!evaluationContent) throw new Error('Could not extract post data from store. Try Bounce again.');
    const evaluationText = formatPostForEvaluation(evaluationContent);
    storeFilteredPost(article, content, reasoning, '', phrase, matches, true, evaluationText);
    persistence.state = 'writing';
    const response: { success?: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: 'bouncePost', post: evaluationText, phrase, reasoning, siteId: _deps.adapter.siteId,
    });
    if (!response?.success) throw new Error(response?.error || 'The local Bounce action did not complete.');
    completeDecisionPersistence(persistence, 'committed', { decision: manualDecision, reasoning: manualReasoning });
    if (!isPostIdentityCurrent(_deps.adapter, article, identity) || getPostDecision(article) !== manualDecision) return false;
    syncFilterPhrases();
    return true;
  } catch (err) {
    const predecessor = persistence.previousDecision;
    const previousReasoning = persistence.previousReasoning;
    const scoredPredecessor = predecessor && !predecessor.userOverride && previousReasoning?.scores?.length;
    completeDecisionPersistence(persistence, 'failed', scoredPredecessor
      ? { decision: predecessor, reasoning: previousReasoning } : {});
    if (err instanceof Error && err.message === 'Filter phrases exceed the 1000-character limit.') showCategoryLimitWarning();
    if (err instanceof Error && err.message === MAX_FILTERS_WARNING) showCategoryLimitWarning(MAX_FILTERS_WARNING);
    console.error('[Bouncer] Bounce action error:', err);
    // A failed durable write must not leave a pretend-success hidden post.
    if (isPostIdentityCurrent(_deps.adapter, article, identity) && getPostDecision(article) === manualDecision) {
      restoreFilteredContainer(_deps.adapter.getPostContainer(article), article);
      forgetPostDecision(article);
      removeFilteredPostForArticle(article);
      _deps.postReasonings.delete(article);
      markPostVerified(article);
      if (scoredPredecessor && previousReasoning) {
        const restored = persistence.result!;
        if (restored.decision && restored.reasoning) {
          rememberPostDecision(article, restored.decision);
          _deps.postReasonings.set(article, restored.reasoning);
          if (restored.decision.shouldHide) {
            storeFilteredPost(article, content, restored.reasoning.reasoning, restored.reasoning.rawResponse || '',
              restored.reasoning.category || null, restored.decision.matches, false, predecessor.evaluationText, restored.reasoning);
            hidePost(article);
          } else if (!reconciledFilterPhrases || !hasScoresForFilters(restored.reasoning.scores, reconciledFilterPhrases)) {
            forgetPostDecision(article);
            _deps.processedPosts.delete(article);
            _deps.processExistingPosts();
          }
        } else {
          _deps.processedPosts.delete(article);
          _deps.processExistingPosts();
        }
      }
    }
    return false;
  } finally {
    settlePersistence();
  }
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
  if (stored?.isModelError) {
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
      // Show the classifier's exact matches without splitting labels on commas.
      // Current keeps and failed results can have no matches; show their text.
      const reasoningBody = displayedMatches(active).length
        ? `<div class="reasoning-match-label">Matched categories</div><div class="reasoning-match-chips">${displayedMatches(active).map(c => `<span class="reasoning-match-chip">${escapeHtml(c)}</span>`).join('')}</div>`
        : `<div class="reasoning-text">${escapeHtml(active.reasoning ?? '')}</div>`;
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
    // Current cached/manual decisions and unevaluated posts have no detector tabs.
    const reasoning = stored?.reasoning ?? 'Post not yet evaluated. It may be queued or no filter rules are set.';
    bodyHtml = displayedMatches(stored || {}).length
      ? `<div class="reasoning-match-label">Matched categories</div><div class="reasoning-match-chips">${displayedMatches(stored!).map(c => `<span class="reasoning-match-chip">${escapeHtml(c)}</span>`).join('')}</div>`
      : `<div class="reasoning-text">${escapeHtml(reasoning ?? '')}</div>`;
  }

  popup.replaceChildren(parseHTML(`
    <div class="reasoning-header">
      <span class="reasoning-status ${statusClass}">${statusText}</span>
      <button class="reasoning-close">&times;</button>
    </div>
    ${bodyHtml}
    <div class="reasoning-post">${escapeHtml(content.text.substring(0, 100))}${content.text.length > 100 ? '...' : ''}</div>
    <div class="reasoning-details"></div>
    <button class="reasoning-reeval-btn">${stored ? 'Re-evaluate' : 'Evaluate Now'}</button>
  `));
  if (stored && !stored.isModelError) {
    popup.querySelector('.reasoning-details')!.appendChild(createClassificationDetails(stored, content.postUrl, () => strictFilterPhrases));
  }

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
// Cache hits, manual decisions and no-filter results have no detector entry;
// the popup renders their current decision text directly.

interface DetectorPopupState {
  status: 'pending' | 'success' | 'error' | 'skipped';
  shouldHide?: boolean;
  reasoning?: string;
  category?: string | null;
  matches?: string[];
  error?: string;
  skipReason?: string;
}

interface DetectorPopupEntry {
  /** Ordered by priority: index 0 is the highest-priority detector. */
  names: string[];
  byName: Map<string, DetectorPopupState>;
}

const postDetectorStates = new WeakMap<HTMLElement, DetectorPopupEntry>();

export function clearDetectorStates(article: HTMLElement): void {
  postDetectorStates.delete(article);
  refreshActivePopupIfFor(article);
}

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

function showCategoryLimitWarning(message = CATEGORY_LIMIT_WARNING) {
  // Keep the same limit warning beside both filter entry controls and Bounce.
  const containers = [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer,
    ...document.querySelectorAll<HTMLElement>('.ff-bounce-tooltip-content')].filter(Boolean) as HTMLElement[];
  for (const container of containers) {
    // Don't add duplicate warnings
    const existing = container.querySelector('.ff-category-limit-warning');
    if (existing) { existing.textContent = message; continue; }
    const warning = document.createElement('div');
    warning.className = 'ff-category-limit-warning';
    warning.setAttribute('role', 'alert');
    warning.textContent = message;
    const actionsRow = container.querySelector('.filter-phrases-actions, .ff-bounce-actions');
    if (actionsRow) {
      actionsRow.parentNode!.insertBefore(warning, actionsRow);
    }
    // Remove when user types or clicks elsewhere
    const input = container.querySelector<HTMLInputElement>('.filter-phrases-input, .ff-bounce-input');
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

const contextMenuArticles = new WeakSet<HTMLElement>();

export function addContextMenuHandler(article: HTMLElement) {
  if (contextMenuArticles.has(article)) return;
  contextMenuArticles.add(article);
  const openPopup = (x: number, y: number) => {
    const identity = postIdentity(_deps.adapter, article);
    (async () => {
      await fetchReasoningIfNeeded(article);
      if (!isPostIdentityCurrent(_deps.adapter, article, identity)) return;
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


}

async function fetchReasoningIfNeeded(article: HTMLElement) {
  if (_deps.postReasonings.has(article)) return;

  const identity = postIdentity(_deps.adapter, article);
  const decision = getPostDecision(article);

  try {
    const content = await _deps.adapter.extractPostContentFromStore(article);
    if (!content?.text.trim() || !isPostIdentityCurrent(_deps.adapter, article, identity)
        || getPostDecision(article) !== decision || _deps.postReasonings.has(article)) return;
    const response: (ClassificationDetails & { found?: boolean; shouldHide?: boolean; reasoning?: string; rawResponse?: string; matches?: string[]; category?: string | null; userOverride?: boolean }) | undefined = await chrome.runtime.sendMessage({
      type: 'getReasoning',
      post: formatPostForEvaluation(content)
    });

    if (response && response.found && isPostIdentityCurrent(_deps.adapter, article, identity)
        && getPostDecision(article) === decision && !_deps.postReasonings.has(article)) {
      _deps.postReasonings.set(article, {
        shouldHide: response.shouldHide ?? false,
        reasoning: response.reasoning ?? '',
        rawResponse: response.rawResponse ?? null,
        matches: response.matches,
        category: response.category,
        userOverride: response.userOverride,
        scores: response.scores,
        textSent: response.textSent,
        model: response.model,
        timestamp: response.userOverride ? undefined : response.timestamp,
      });
    }
  } catch (err) {
    console.debug('Failed to get reasoning:', err);
  }
}

// ==================== DOM Mutation Handler ====================

// ==================== Bounce Label Entry ====================

let bounceComposerId = 0;

/** This form records only the label the user enters or selects. */
export function createBounceComposer(
  container: HTMLElement,
  onBounce: (phrase: string) => void | Promise<boolean>,
  onCancel: () => void,
  loadExistingFilters: () => Promise<string[]> = () => Promise.resolve([]),
): { focus: () => void } {
  const form = document.createElement('form');
  form.className = 'ff-bounce-form';
  const label = document.createElement('label');
  label.className = 'ff-bounce-label';
  label.textContent = 'Filter label';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ff-bounce-input';
  input.placeholder = 'What should Bouncer hide?';
  input.required = true;
  input.id = `bouncer-filter-label-${++bounceComposerId}`;
  label.htmlFor = input.id;
  const guidance = document.createElement('p');
  guidance.className = 'filter-label-guidance';
  guidance.id = `${input.id}-guidance`;
  guidance.textContent = FILTER_LABEL_GUIDANCE;
  input.setAttribute('aria-describedby', guidance.id);
  const actions = document.createElement('div');
  actions.className = 'ff-bounce-actions';
  const bounce = document.createElement('button');
  bounce.type = 'submit';
  bounce.className = 'ff-bounce-confirm';
  bounce.textContent = 'Bounce';
  bounce.disabled = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ff-bounce-cancel';
  cancel.textContent = 'Cancel';
  actions.append(bounce, cancel);
  const missed = document.createElement('button');
  missed.type = 'button';
  missed.className = 'ff-missed-link';
  missed.textContent = 'Bouncer missed an existing filter?';
  const filters = document.createElement('div');
  filters.className = 'ff-existing-filters';
  filters.hidden = true;
  filters.setAttribute('aria-live', 'polite');
  missed.setAttribute('aria-expanded', 'false');
  const error = document.createElement('div');
  error.className = 'ff-bounce-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');
  form.append(label, input, guidance, error, actions, missed, filters);
  container.replaceChildren(form);
  let submitting = false;
  const updateInput = () => { input.setCustomValidity(''); error.hidden = true; bounce.disabled = submitting || !input.value.trim(); };
  const setSubmitting = (pending: boolean) => {
    submitting = pending;
    input.disabled = pending;
    cancel.disabled = pending;
    missed.disabled = pending;
    filters.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = pending; });
    bounce.disabled = pending || !input.value.trim();
  };
  const showFailure = () => {
    if (container.querySelector('.ff-category-limit-warning')) return;
    error.textContent = 'Couldn’t save this filter. Try again.';
    error.hidden = false;
  };
  input.addEventListener('input', updateInput);
  input.addEventListener('click', event => event.stopPropagation());
  form.addEventListener('submit', event => {
    event.preventDefault();
    event.stopPropagation();
    if (submitting) return;
    const phrase = input.value.trim();
    if (!phrase) {
      input.setCustomValidity('Enter a filter label.');
      input.reportValidity();
      return;
    }
    error.hidden = true;
    setSubmitting(true);
    void (async () => {
      try {
        if (await onBounce(phrase) === false) showFailure();
      } catch {
        showFailure();
      } finally {
        setSubmitting(false);
      }
    })();
  });
  cancel.addEventListener('click', event => { event.stopPropagation(); onCancel(); });
  let filtersRead = 0;
  missed.addEventListener('click', event => {
    event.stopPropagation();
    filters.hidden = !filters.hidden;
    missed.setAttribute('aria-expanded', String(!filters.hidden));
    const read = ++filtersRead;
    if (filters.hidden) return;
    filters.replaceChildren();
    void loadExistingFilters().then(phrases => {
      if (read !== filtersRead) return;
      const heading = document.createElement('span');
      heading.className = 'ff-existing-filters-label';
      heading.textContent = phrases.length ? 'Which filter should have matched?' : 'No saved filters yet. Enter a label above.';
      filters.appendChild(heading);
      [...new Set(phrases)].forEach(phrase => {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'ff-existing-filter';
        choice.textContent = phrase;
        choice.addEventListener('click', choiceEvent => {
          choiceEvent.stopPropagation();
          input.value = phrase;
          updateInput();
          input.focus();
        });
        filters.appendChild(choice);
      });
    }).catch(() => {
      if (read === filtersRead) filters.textContent = 'Couldn’t read your filters. Close and reopen this list to try again.';
    });
  });
  return { focus: () => input.focus() };
}

// Add a local Bounce action beside the post controls.
export function addBounceButton(article: HTMLElement) {
  if (!_deps.adapter.getShareButton(article)) {
    return;
  }
  // Don't add twice
  if (article.querySelector('.ff-bounce-button')) {
    return;
  }

  const btn = document.createElement('div');
  btn.className = 'ff-bounce-button';
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
      removeBounceTooltip(btnTooltip);
      btnTooltip = null;
      return;
    }

    // Close any other open tooltips
    document.querySelectorAll('.ff-bounce-tooltip').forEach(removeBounceTooltip);

    const content = _deps.extractPostContent(article);
    const openedPostKey = `${_deps.adapter.getPostUrl(article) || ''}\n${formatPostForEvaluation(content)}`;

    // Create tooltip — append to body with fixed positioning so it escapes
    // any overflow:hidden ancestors in Twitter's DOM
    const tooltip = document.createElement('div');
    tooltip.className = 'ff-bounce-tooltip';
    const tooltipContent = document.createElement('div');
    tooltipContent.className = 'ff-bounce-tooltip-content';
    tooltip.appendChild(tooltipContent);
    document.body.appendChild(tooltip);
    btnTooltip = tooltip;

    // Keep the tooltip inside both viewport axes. A ResizeObserver reruns this
    // when the local existing-filter chooser changes its dimensions.
    const positionTooltip = () => {
      if (!tooltip.isConnected || !btn.isConnected) return;
      const btnRect = btn.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      tooltipContent.style.maxHeight = `${tooltipContentMaxHeight(viewportHeight)}px`;
      const horizontal = tooltipHorizontalPosition(
        btnRect,
        tooltip.offsetWidth,
        viewportWidth,
      );
      const vertical = tooltipVerticalPosition(
        btnRect,
        tooltip.offsetHeight,
        viewportHeight,
      );
      tooltip.style.position = 'fixed';
      tooltip.style.left = '';
      tooltip.style.right = '';
      tooltip.classList.remove('ff-bounce-tooltip--align-left', 'ff-bounce-tooltip--align-center');
      tooltip.style.removeProperty('--ff-notch-x');
      if (horizontal.alignment === 'right') {
        tooltip.style.right = `${horizontal.right}px`;
      } else {
        tooltip.style.left = `${horizontal.left}px`;
        tooltip.classList.add(`ff-bounce-tooltip--align-${horizontal.alignment}`);
        if (horizontal.notchX !== undefined) {
          tooltip.style.setProperty('--ff-notch-x', `${horizontal.notchX}px`);
        }
      }
      tooltip.style.bottom = '';
      tooltip.style.top = `${vertical.top}px`;
      tooltip.classList.toggle('ff-bounce-tooltip--flipped', vertical.flipped);
    };

    let positionFrame: number | null = null;
    const schedulePosition = () => {
      if (positionFrame !== null) return;
      positionFrame = requestAnimationFrame(() => {
        positionFrame = null;
        positionTooltip();
      });
    };
    const removeTooltip = () => {
      removeBounceTooltip(tooltip);
      if (btnTooltip === tooltip) btnTooltip = null;
    };

    const identityObserver = new MutationObserver(() => {
      const currentPostKey = `${_deps.adapter.getPostUrl(article) || ''}\n${formatPostForEvaluation(_deps.extractPostContent(article))}`;
      if (currentPostKey === openedPostKey) return;
      btn.title = 'Bounce this tweet';
      removeTooltip();
    });
    identityObserver.observe(article, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    // Reposition on scroll/resize; dismiss if X recycles the button or it
    // leaves the viewport.
    const onViewportChange = () => {
      if (!tooltip.isConnected || !btn.isConnected) {
        removeTooltip();
        return;
      }
      const btnRect = btn.getBoundingClientRect();
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      if (btnRect.bottom < 0 || btnRect.top > viewportHeight) {
        removeTooltip();
        return;
      }
      schedulePosition();
    };
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(schedulePosition);
    resizeObserver?.observe(tooltip);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    bounceTooltipCleanup.set(tooltip, () => {
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
      resizeObserver?.disconnect();
      identityObserver.disconnect();
      if (positionFrame !== null) cancelAnimationFrame(positionFrame);
      positionFrame = null;
    });
    schedulePosition();

    const composer = createBounceComposer(tooltipContent, async phrase => {
      const isCurrent = () => tooltip.isConnected
        && `${_deps.adapter.getPostUrl(article) || ''}\n${formatPostForEvaluation(_deps.extractPostContent(article))}` === openedPostKey;
      if (!isCurrent()) { removeTooltip(); return false; }
      const descriptions = await getDescriptions(_deps.descriptionsKey);
      if (!isCurrent()) { removeTooltip(); return false; }
      const warning = filterLimitWarning(descriptions, phrase);
      if (warning) {
        showCategoryLimitWarning(warning);
        schedulePosition();
        return false;
      }
      const saved = await bouncePost(article, content, phrase);
      if (saved) removeTooltip();
      else schedulePosition();
      return saved;
    }, removeTooltip, () => getDescriptions(_deps.descriptionsKey));
    composer.focus();
  });

  // Outside-click tooltip dismissal is handled by a single module-level
  // listener registered via setupBounceTooltipCloser — do NOT register a
  // per-button document listener here (it would accumulate one per post and
  // fire for every click on the page).
}

// Close any open .ff-bounce-tooltip when the user clicks outside of its
// button and the tooltip itself. Registered once per page from initUI.
export function setupBounceTooltipCloser() {
  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    // If the click is on any Bounce button, let that button's own
    // click handler manage the tooltip. Skip.
    if (target instanceof Element && target.closest('.ff-bounce-button')) return;
    const tooltips = document.querySelectorAll('.ff-bounce-tooltip');
    if (tooltips.length === 0) return;
    tooltips.forEach((t) => {
      if (!t.contains(target)) {
        removeBounceTooltip(t);
      }
    });
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
