// All UI injection, modals, alerts, theming, filter phrase management

import { toBlob } from 'html-to-image';
import { asyncHandler } from '../shared/async';
import { cleanReasoning, escapeHtml, formatPostForEvaluation, parseHTML } from '../shared/utils';
import {
  encodeFilterPackCode, decodeFilterPackCode, buildFilterPackShareUrl,
  FILTER_PACK_SHARE_URL_REGEX,
} from '../shared/share-encoding';
import type { ContentUIDeps, EngineSelection, FilteredPost, PostContent, LocalModelStatus } from '../types';
import { engineStatusView, statusMatchesSelection } from '../shared/engine-status-view';
import { getStorage, getDescriptions, setDescriptions } from '../shared/storage';
import {
  tooltipContentMaxHeight,
  tooltipHorizontalPosition,
  tooltipVerticalPosition,
} from './geometry';
import { cancelScheduledFilteredHide, hasScheduledFilteredHide, isRendered, restoreFilteredContainer, scheduleFilteredHide } from './dom-state';
import {
  currentPostDecision, displayedMatches, forgetPostDecision, getPostDecision,
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
  automaticRevision: number;
}
type ExplicitPostDecision = LivePostDecision & { persistence?: DecisionPersistence };
let automaticDecisionRevision = 0;

function completeDecisionPersistence(persistence: DecisionPersistence, state: 'committed' | 'canceled' | 'failed', result: SettledPostDecision): void {
  let decision = result.decision;
  // A manual action keeps ownership while an engine switch restores automatic
  // work. Its failure must not resurrect the previous engine's automatic hide.
  if (decision && !decision.userOverride && persistence.automaticRevision !== automaticDecisionRevision) {
    decision = { ...decision, shouldHide: false, matches: undefined };
    result = { ...result, reasoning: undefined };
  }
  // Provisional manual ownership can delay the automatic rule-edit handling.
  // Recheck its predecessor against the latest observed rules after all awaits,
  // including outcomes retained by an earlier failed reservation.
  if (decision?.shouldHide && !decision.userOverride && reconciledFilterPhrases) {
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
    decision: decision ? { identity: decision.identity, shouldHide: decision.shouldHide, matches: decision.matches ? [...decision.matches] : undefined, userOverride: decision.userOverride } : undefined,
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
let activePopupSuggestionCleanup: (() => void) | null = null;
export interface SuggestionResponse {
  reasons?: string[];
  retry?: boolean;
  error?: string;
  engine?: EngineSelection['engine'];
  selectionRevision?: number;
  classifierFingerprint?: string;
}

export function suggestionResponseError(response: SuggestionResponse | null | undefined): string | null {
  if (!response) return 'The local model did not respond. Try again.';
  if (response.retry) return response.error || 'The local model is busy. Try again.';
  return response.error || null;
}

export interface SuggestionRequestEntry {
  postKey: string;
  engineKey: string;
  promise: Promise<SuggestionResponse>;
}

const annoyingReasonsCache: WeakMap<HTMLElement, SuggestionRequestEntry> = new WeakMap();
const annoyingTooltipCleanup = new WeakMap<HTMLElement, () => void>();
let contentEngineSelection: EngineSelection | undefined;
let contentLocalModelStatus: LocalModelStatus | undefined;
const suggestionSelectionListeners = new Set<() => void>();

function suggestionEngineKey(): string {
  return contentEngineSelection ? `${contentEngineSelection.engine}:${contentEngineSelection.revision}` : 'legacy';
}

export function updateContentEngineSelection(selection: EngineSelection): void {
  if (contentEngineSelection && selection.revision <= contentEngineSelection.revision) return;
  contentEngineSelection = { ...selection };
  if (contentLocalModelStatus && !statusMatchesSelection(contentLocalModelStatus, selection)) contentLocalModelStatus = undefined;
  suggestionSelectionListeners.forEach(listener => listener());
}

function suggestionSetupMessage(): string | null {
  // Legacy unit fixtures have no engine selection. Production always supplies
  // the committed choice, so an absent browser artifact cannot start a fetch.
  if (!contentEngineSelection) return null;
  if (!contentEngineSelection.engine) return 'Choose Browser AI or Ollama in Settings to find filter suggestions.';
  const status = contentLocalModelStatus;
  if (status && statusMatchesSelection(status, contentEngineSelection)
      && ['ready', 'filtering', 'loading'].includes(status.state)) return null;
  if (status?.state === 'switching') return 'The engine is switching. Open Settings for its status.';
  if (status?.state === 'recovery_required') return 'A previous local request needs recovery. Open Settings; manual Bounce and Restore still work.';
  return contentEngineSelection.engine === 'litertlm'
    ? 'Browser AI setup is needed for suggestions. Open Settings.'
    : 'Suggestions need an Ollama connection. Open Settings.';
}

function requestSuggestions(article: HTMLElement, postKey: string, post: string): SuggestionRequestEntry {
  return getSuggestionRequest(article, postKey, () => {
    const setup = suggestionSetupMessage();
    return setup ? Promise.resolve({ retry: true, error: setup }) : chrome.runtime.sendMessage({
      type: 'suggestAnnoyingReasons', post, siteId: _deps.adapter.siteId,
    });
  });
}

export function getSuggestionRequest(
  article: HTMLElement,
  postKey: string,
  create: () => Promise<SuggestionResponse>,
): SuggestionRequestEntry {
  const cached = annoyingReasonsCache.get(article);
  const engineKey = suggestionEngineKey();
  if (cached?.postKey === postKey && cached.engineKey === engineKey) return cached;
  const entry = { postKey, engineKey, promise: create() };
  annoyingReasonsCache.set(article, entry);
  return entry;
}

export function isSuggestionRequestCurrent(
  article: HTMLElement,
  entry: SuggestionRequestEntry,
  currentPostKey: string,
): boolean {
  return annoyingReasonsCache.get(article) === entry && entry.postKey === currentPostKey
    && entry.engineKey === suggestionEngineKey();
}

function suggestionResponseMatchesSelection(response: SuggestionResponse | null | undefined): boolean {
  return !response || !contentEngineSelection || response.engine === undefined && response.selectionRevision === undefined
    || response.engine === contentEngineSelection.engine && response.selectionRevision === contentEngineSelection.revision;
}

function clearSuggestionRequest(article: HTMLElement, entry: SuggestionRequestEntry): void {
  if (annoyingReasonsCache.get(article) === entry) annoyingReasonsCache.delete(article);
}

function removeAnnoyingTooltip(tooltip: Element): void {
  if (tooltip instanceof HTMLElement) {
    annoyingTooltipCleanup.get(tooltip)?.();
    annoyingTooltipCleanup.delete(tooltip);
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

/** Engine identity invalidates every automatic verdict, even when its phrases survive. */
export function reconcileEngineChange(): void {
  automaticDecisionRevision++;
  const posts = _deps.findPosts();
  const manualContainers = new Set<HTMLElement>();
  const manualKeys = new Set<string>();
  for (const article of posts) {
    if (!currentPostDecision(_deps.adapter, article)?.userOverride) continue;
    manualContainers.add(_deps.adapter.getPostContainer(article));
    const key = filteredKeyByArticle.get(article);
    if (key) manualKeys.add(key);
  }
  for (const article of posts) {
    const container = _deps.adapter.getPostContainer(article);
    if (manualContainers.has(container)) continue;
    restoreFilteredContainer(container, article);
    forgetPostDecision(article);
    _deps.processedPosts.delete(article);
    _deps.postReasonings.delete(article);
    postDetectorStates.delete(article);
    _deps.pendingPosts.delete(article);
    clearPendingDimTimer(article);
    article.removeAttribute('data-ff-pending');
    delete article.dataset.pendingStartTime;
    delete article.dataset.errorType;
    article.classList.remove('ff-error');
    article.querySelector('.post-verification-bar')?.remove();
    filteredKeyByArticle.delete(article);
    refreshActivePopupIfFor(article);
  }
  // Thread siblings and temporarily unmounted cells can carry only the hiding
  // marker. Restore them as well, retaining live explicit action ownership.
  document.querySelectorAll<HTMLElement>('[data-filtered-by-extension="true"]').forEach(container => {
    if (!manualContainers.has(container)) restoreFilteredContainer(container);
  });
  for (let index = filteredPosts.length - 1; index >= 0; index--) {
    const post = filteredPosts[index];
    if (post.userOverride || manualKeys.has(filteredPostKey(post)) || filteredRestoreStatuses.get(post)?.pending) continue;
    filteredRestoreStatuses.delete(post);
    filteredPosts.splice(index, 1);
    filteredPostKeys.delete(filteredPostKey(post));
  }
  refreshFilteredPostsView();
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
    if (isRendered(layout)) return layout;
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

}

// ==================== Selected engine status ====================

interface ModelStatusView {
  variant: 'info' | 'progress' | 'warning';
  body: string;
  dismissible: boolean;
}

export function modelStatusView(status: LocalModelStatus, selection?: EngineSelection): ModelStatusView | null {
  if (selection && !statusMatchesSelection(status, selection)) return null;
  if (status.state === 'ready' || status.state === 'filtering') return null;
  const view = engineStatusView(status, selection);
  const progress = ['loading', 'downloading', 'canceling', 'switching'].includes(status.state);
  return {
    variant: progress ? 'progress' : view.tone === 'error' ? 'warning' : 'info',
    body: [view.text, view.progressText].filter(Boolean).join(' '),
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

export function updateModelStatusIndicator(status: LocalModelStatus, selection?: EngineSelection): void {
  const presentationRevision = ++modelStatusPresentationRevision;
  contentLocalModelStatus = status;
  if (selection) updateContentEngineSelection(selection);
  // Each committed choice has its own dismissal; inactive engine snapshots
  // cannot redisplay a warning or replace the selected engine's status.
  const condition = `${selection?.engine ?? status.engine ?? 'legacy'}:${selection?.revision ?? status.selectionRevision ?? 0}:${status.state}:${status.reason || ''}`;
  if (modelStatusDismissed !== condition) modelStatusDismissed = null;
  const view = !statusFilteringEnabled || !statusHasFilters || modelStatusDismissed === condition
    ? null : modelStatusView(status, selection);
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
  engineSelection?: EngineSelection;
  localModelStatus?: LocalModelStatus;
  nativeModelStatus?: LocalModelStatus;
}
interface ModelLoadingCoordinator {
  handleChanges: (changes: Record<string, chrome.storage.StorageChange>) => void;
  finishInitialLoad: (snapshot: ModelLoadingStorageSnapshot) => void;
  getStatus: () => LocalModelStatus;
  getSelection: () => EngineSelection | undefined;
}

const disconnectedStatus = (): LocalModelStatus => ({ state: 'not_connected', message: '', revision: 0 });
const selectionStatus = (selection: EngineSelection): LocalModelStatus => ({
  state: selection.engine ? 'switching' : 'not_configured', message: '', revision: 0,
  engine: selection.engine, selectionRevision: selection.revision,
});
const needsRecovery = (status: LocalModelStatus | undefined): boolean => !!status
  && !['ready', 'filtering', 'loading'].includes(status.state);

/** Listener-before-snapshot initialization compares revisions only within one selected engine. */
export function createModelLoadingCoordinator(
  render: (status: LocalModelStatus) => void,
  processExistingPosts: () => void,
): ModelLoadingCoordinator {
  let selection: EngineSelection | undefined;
  let currentStatus = disconnectedStatus();
  let legacyNative = true;
  let initialLoadFinished = false;
  const queuedChanges: Array<Record<string, chrome.storage.StorageChange>> = [];
  let lastRecoveredReadyRevision: string | undefined;
  const matches = (status: LocalModelStatus): boolean => selection
    ? statusMatchesSelection(status, selection)
    : legacyNative && status.engine === undefined && status.selectionRevision === undefined;
  const applyChanges = (changes: Record<string, chrome.storage.StorageChange>, shouldRender: boolean) => {
    let changed = false;
    const nextSelection = changes.engineSelection?.newValue as EngineSelection | undefined;
    if (nextSelection && (!selection || nextSelection.revision > selection.revision)) {
      selection = { ...nextSelection };
      legacyNative = false;
      currentStatus = selectionStatus(selection);
      changed = true;
    }
    const storageChange = changes.localModelStatus || (legacyNative ? changes.nativeModelStatus : undefined);
    if (storageChange) {
      const next = storageChange.newValue as LocalModelStatus | undefined;
      // Status counters belong to the engine/selection pair. Never compare a
      // browser progress revision with an Ollama revision or accept old Ready.
      if (next && matches(next) && (next.revision > currentStatus.revision || changed
          || !shouldRender && next.revision === currentStatus.revision && next.state === currentStatus.state)) {
        const eventPrevious = storageChange.oldValue as LocalModelStatus | undefined;
        const previous = eventPrevious && matches(eventPrevious) ? eventPrevious : currentStatus;
        currentStatus = next;
        changed = true;
        const recoveryKey = `${selection?.engine ?? 'legacy'}:${selection?.revision ?? 0}:${next.revision}`;
        if (next.state === 'ready' && needsRecovery(previous) && lastRecoveredReadyRevision !== recoveryKey) {
          lastRecoveredReadyRevision = recoveryKey;
          processExistingPosts();
        }
      }
    }
    if (changed && shouldRender) render(currentStatus);
  };
  return {
    handleChanges(changes) {
      if (!initialLoadFinished) { queuedChanges.push(changes); return; }
      applyChanges(changes, true);
    },
    finishInitialLoad(snapshot) {
      if (initialLoadFinished) return;
      selection = snapshot.engineSelection ? { ...snapshot.engineSelection } : undefined;
      legacyNative = !selection && !snapshot.localModelStatus;
      const status = snapshot.localModelStatus || (legacyNative ? snapshot.nativeModelStatus : undefined);
      currentStatus = status && matches(status) ? status : selection ? selectionStatus(selection) : disconnectedStatus();
      for (const changes of queuedChanges) applyChanges(changes, false);
      queuedChanges.length = 0;
      initialLoadFinished = true;
      render(currentStatus);
    },
    getStatus: () => currentStatus,
    getSelection: () => selection,
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
    status => updateModelStatusIndicator(status, coordinator.getSelection()),
    () => _deps.processExistingPosts(),
  );
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (snapshotPending) Object.keys(changes).forEach(key => changedContext.add(key));
    if (changes.enabled) statusFilteringEnabled = changes.enabled.newValue !== false;
    if (changes[descriptionsKey]) statusHasFilters = !!(changes[descriptionsKey].newValue as string[] | undefined)?.length;
    coordinator.handleChanges(changes);
    if (changes.enabled || changes[descriptionsKey]) updateModelStatusIndicator(coordinator.getStatus(), coordinator.getSelection());
  });
  getStorage(['engineSelection', 'localModelStatus', 'nativeModelStatus', 'enabled', descriptionsKey])
    .then(data => {
      if (!changedContext.has('enabled')) statusFilteringEnabled = data.enabled !== false;
      if (!changedContext.has(descriptionsKey)) statusHasFilters = !!data[descriptionsKey]?.length;
      snapshotPending = false;
      coordinator.finishInitialLoad(data);
    })
    .catch(err => {
      console.error('[UI] Failed to load local engine status:', err);
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

    // Reasoning — table_yesno (Gemma) posts carry matched categories in
    // `post.category` and a terse pipe-row in `post.reasoning`; show the clean
    // "Matched: …" summary instead of running the pipe-row through cleanReasoning.
    // Keep a fallback for malformed/legacy cache entries without a category.
    const reasoning = document.createElement('div');
    reasoning.className = 'slop-post-reasoning';
    reasoning.textContent = displayedMatches(post).length
      ? `Matched: ${displayedMatches(post).join(', ')}`
      : (cleanReasoning(post.reasoning) || 'Filtered');
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
      automaticRevision: automaticDecisionRevision,
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
        _deps.processedPosts.delete(target.article);
        postDetectorStates.delete(target.article);
        _deps.processExistingPosts();
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

export function storeFilteredPost(article: HTMLElement, contentObj: PostContent, reasoning: string, rawResponse = '', category: string | null = null, matches?: string[], userOverride?: boolean, evaluationText?: string) {
  // Use postUrl or content hash as dedup key
  const evalText = evaluationText ?? formatPostForEvaluation(contentObj);
  const key = contentObj.postUrl || evalText.substring(0, 200);
  filteredKeyByArticle.set(article, key);
  if (filteredPostKeys.has(key)) {
    const index = filteredPosts.findIndex(post => filteredPostKey(post) === key);
    if (index !== -1) {
      const previous = filteredPosts[index];
      const status = filteredRestoreStatuses.get(previous);
      const replacement = { ...previous, evaluationText: evaluationText ?? previous.evaluationText, reasoning, rawResponse, category, matches: matches ? [...matches] : undefined, userOverride };
      filteredPosts[index] = replacement;
      if (status && !userOverride) filteredRestoreStatuses.set(replacement, status);
      filteredRestoreStatuses.delete(previous);
      refreshRestoreControls();
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
  _deps.adapter.hidePost(article, !currentPostDecision(_deps.adapter, article)?.userOverride);
}

/** One atomic background action establishes both the rule and durable override. */
export async function bouncePost(article: HTMLElement, content: PostContent, phrase?: string, reasoning = phrase ? `User blocked: ${phrase}` : 'User reported: should have been filtered'): Promise<boolean> {
  const identity = postIdentity(_deps.adapter, article);
  const currentContent = _deps.extractPostContent(article);
  if (!article.isConnected || currentContent.postUrl !== content.postUrl || formatPostForEvaluation(currentContent) !== formatPostForEvaluation(content)) return false;
  const matches = phrase ? [phrase] : undefined;
  let settlePersistence!: () => void;
  const persistence: DecisionPersistence = {
    state: 'extracting', settled: new Promise(resolve => { settlePersistence = resolve; }),
    previousDecision: getPostDecision(article), previousReasoning: _deps.postReasonings.get(article),
    automaticRevision: automaticDecisionRevision,
  };
  const decision = { identity, shouldHide: true, matches, userOverride: true, persistence };
  rememberPostDecision(article, decision);
  const manualDecision = getPostDecision(article);
  postDetectorStates.delete(article);
  const manualReasoning = { shouldHide: true, reasoning, category: phrase || null, matches, userOverride: true };
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
    // Durable feedback must use the same author and complete text as automatic
    // evaluation. DOM author labels include handles/times and text may be cut.
    const evaluationContent = await _deps.adapter.extractPostContentFromStore(article);
    if (!isPostIdentityCurrent(_deps.adapter, article, identity) || getPostDecision(article) !== manualDecision) {
      const previous = await settledPostDecision(persistence.previousDecision, persistence.previousReasoning);
      completeDecisionPersistence(persistence, 'canceled', previous);
      return false;
    }
    if (!evaluationContent) throw new Error('Could not extract post data from store. Try Bounce again.');
    const evaluationText = formatPostForEvaluation(evaluationContent);
    storeFilteredPost(article, content, reasoning, '', phrase || null, matches, true, evaluationText);
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
    completeDecisionPersistence(persistence, 'failed', {});
    console.error('[Bouncer] Bounce action error:', err);
    // A failed durable write must not leave a pretend-success hidden post.
    if (isPostIdentityCurrent(_deps.adapter, article, identity) && getPostDecision(article) === manualDecision) {
      restoreFilteredContainer(_deps.adapter.getPostContainer(article), article);
      forgetPostDecision(article);
      removeFilteredPostForArticle(article);
      _deps.postReasonings.delete(article);
      markPostVerified(article);
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
  const openedPostIdentity = postIdentity(_deps.adapter, article);
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
      // it). Keep a text fallback for malformed/legacy cache entries.
      const reasoningBody = displayedMatches(active).length
        ? `<div class="reasoning-match-label">Matched categories</div><div class="reasoning-match-chips">${displayedMatches(active).map(c => `<span class="reasoning-match-chip">${escapeHtml(c)}</span>`).join('')}</div>`
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
    bodyHtml = displayedMatches(stored || {}).length
      ? `<div class="reasoning-match-label">Matched categories</div><div class="reasoning-match-chips">${displayedMatches(stored!).map(c => `<span class="reasoning-match-chip">${escapeHtml(c)}</span>`).join('')}</div>`
      : `<div class="reasoning-text">${escapeHtml(cleanReasoning(reasoning) ?? '')}</div>`;
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
    <button class="reasoning-suggest-btn">Find filter suggestions</button>
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

  const suggestButton = popup.querySelector<HTMLButtonElement>('.reasoning-suggest-btn')!;
  const suggestionsDiv = popup.querySelector<HTMLElement>('.reasoning-suggestions')!;
  const openedPostKey = `${_deps.adapter.getPostUrl(article) || ''}\n${formatPostForEvaluation(content)}`;
  const showSuggestionSetup = (message: string) => {
    suggestionsDiv.replaceChildren();
    const label = document.createElement('span');
    label.textContent = message;
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.textContent = 'Settings';
    settings.addEventListener('click', showSettingsModal);
    suggestionsDiv.append(label, settings);
    suggestButton.disabled = false;
    suggestButton.style.display = '';
    suggestButton.textContent = 'Find filter suggestions';
  };
  const onSelectionChange = () => showSuggestionSetup(suggestionSetupMessage() || 'The engine changed. Find filter suggestions again.');
  suggestionSelectionListeners.add(onSelectionChange);
  activePopupSuggestionCleanup = () => suggestionSelectionListeners.delete(onSelectionChange);
  suggestButton.addEventListener('click', () => {
    (async () => {
      const setup = suggestionSetupMessage();
      if (setup) { showSuggestionSetup(setup); return; }
      suggestButton.disabled = true;
      suggestButton.textContent = 'Finding suggestions…';
      suggestionsDiv.replaceChildren();
      const entry = requestSuggestions(article, openedPostKey, content.text);
      try {
        const response = await entry.promise;
        if (!isPostIdentityCurrent(_deps.adapter, article, openedPostIdentity) || !popup.isConnected
            || !isSuggestionRequestCurrent(article, entry, openedPostKey)) return;
        if (!suggestionResponseMatchesSelection(response)) {
          clearSuggestionRequest(article, entry);
          showSuggestionSetup('The engine changed. Find filter suggestions again.');
          return;
        }
        const responseError = suggestionResponseError(response);
        if (responseError) {
          clearSuggestionRequest(article, entry);
          showSuggestionSetup(responseError);
        } else if (response.reasons?.length) {
          suggestButton.style.display = 'none';
          suggestionsDiv.replaceChildren(parseHTML(response.reasons.map(r =>
            `<button class="reasoning-suggestion-chip">${escapeHtml(r)}</button>`
          ).join('')));
          suggestionsDiv.querySelectorAll('.reasoning-suggestion-chip').forEach(chip => {
            chip.addEventListener('click', asyncHandler(async () => {
              const phrase = chip.textContent ?? '';
              if (!isPostIdentityCurrent(_deps.adapter, article, openedPostIdentity)
                  || !isSuggestionRequestCurrent(article, entry, openedPostKey)) return;
              (chip as HTMLButtonElement).disabled = true;
              if (await bouncePost(article, content, phrase)) {
                chip.classList.add('suggestion-added');
                chip.textContent = `+ ${phrase}`;
              } else {
                (chip as HTMLButtonElement).disabled = false;
              }
            }));
          });
        } else {
          suggestButton.textContent = 'No useful suggestions';
          suggestButton.disabled = true;
        }
      } catch (err) {
        if (!popup.isConnected || !isSuggestionRequestCurrent(article, entry, openedPostKey)) return;
        clearSuggestionRequest(article, entry);
        showSuggestionSetup(err instanceof Error ? err.message : 'Try again.');
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
  activePopupSuggestionCleanup?.();
  activePopupSuggestionCleanup = null;
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
  const engineKey = suggestionEngineKey();

  try {
    const content = await _deps.adapter.extractPostContentFromStore(article);
    if (!content?.text.trim() || !isPostIdentityCurrent(_deps.adapter, article, identity)
        || getPostDecision(article) !== decision || _deps.postReasonings.has(article) || engineKey !== suggestionEngineKey()) return;
    const response: { found?: boolean; shouldHide?: boolean; reasoning?: string; rawResponse?: string; matches?: string[]; category?: string | null; userOverride?: boolean } | undefined = await chrome.runtime.sendMessage({
      type: 'getReasoning',
      post: formatPostForEvaluation(content)
    });

    if (response && response.found && isPostIdentityCurrent(_deps.adapter, article, identity)
        && getPostDecision(article) === decision && !_deps.postReasonings.has(article) && engineKey === suggestionEngineKey()) {
      _deps.postReasonings.set(article, {
        shouldHide: response.shouldHide ?? false,
        reasoning: response.reasoning ?? '',
        rawResponse: response.rawResponse ?? null,
        matches: response.matches,
        category: response.category,
        userOverride: response.userOverride,
      });
    }
  } catch (err) {
    console.debug('Failed to get reasoning:', err);
  }
}

// ==================== DOM Mutation Handler ====================

// ==================== Why Annoying Button ====================

interface BounceSuggestionState {
  pending?: boolean;
  reasons?: string[];
  error?: string;
  settings?: boolean;
}

/** Suggestions are optional; the user's explicit manual decision always remains available. */
export function createBounceComposer(
  container: HTMLElement,
  onBounce: (phrase?: string) => void,
  onCancel: () => void,
): { setState: (state: BounceSuggestionState) => void } {
  const suggestions = document.createElement('div');
  suggestions.className = 'ff-annoying-suggestions';
  suggestions.setAttribute('aria-live', 'polite');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ff-annoying-custom-input';
  input.placeholder = 'Filter phrase (optional)';
  input.setAttribute('aria-label', 'Filter phrase (optional)');
  const actions = document.createElement('div');
  actions.className = 'ff-annoying-actions';
  const bounce = document.createElement('button');
  bounce.type = 'button';
  bounce.className = 'ff-annoying-bounce';
  bounce.textContent = 'Bounce';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ff-annoying-cancel';
  cancel.textContent = 'Cancel';
  actions.append(bounce, cancel);
  container.replaceChildren(suggestions, input, actions);
  input.addEventListener('click', event => event.stopPropagation());
  bounce.addEventListener('click', event => {
    event.stopPropagation();
    onBounce(input.value.trim() || undefined);
  });
  cancel.addEventListener('click', event => { event.stopPropagation(); onCancel(); });
  return {
    setState(state) {
      suggestions.replaceChildren();
      const reasons = [...new Set((state.reasons || []).map(reason => reason.trim()).filter(Boolean))].slice(0, 3);
      if (state.pending || state.error || !reasons.length) {
        const label = document.createElement('span');
        label.className = 'ff-annoying-empty';
        label.textContent = state.pending ? 'Finding suggestions…'
          : state.error ? `Suggestions unavailable. ${state.error}` : 'No useful suggestions';
        suggestions.appendChild(label);
        if (state.settings) {
          const settings = document.createElement('button');
          settings.type = 'button';
          settings.textContent = 'Settings';
          settings.addEventListener('click', event => { event.stopPropagation(); showSettingsModal(); });
          suggestions.appendChild(settings);
        }
        return;
      }
      const label = document.createElement('span');
      label.className = 'ff-annoying-label';
      label.textContent = 'Choose or edit a filter phrase:';
      suggestions.appendChild(label);
      reasons.forEach(reason => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ff-annoying-chip';
        chip.textContent = reason;
        chip.addEventListener('click', event => {
          event.stopPropagation();
          input.value = reason;
          input.focus();
        });
        suggestions.appendChild(chip);
      });
    },
  };
}

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
      removeAnnoyingTooltip(btnTooltip);
      btnTooltip = null;
      return;
    }

    // Close any other open tooltips
    document.querySelectorAll('.ff-annoying-tooltip').forEach(removeAnnoyingTooltip);

    const content = _deps.extractPostContent(article);
    const openedPostKey = `${_deps.adapter.getPostUrl(article) || ''}\n${formatPostForEvaluation(content)}`;

    // Create tooltip — append to body with fixed positioning so it escapes
    // any overflow:hidden ancestors in Twitter's DOM
    const tooltip = document.createElement('div');
    tooltip.className = 'ff-annoying-tooltip';
    const tooltipContent = document.createElement('div');
    tooltipContent.className = 'ff-annoying-tooltip-content';
    tooltip.appendChild(tooltipContent);
    document.body.appendChild(tooltip);
    btnTooltip = tooltip;

    // Keep the tooltip inside both viewport axes. A ResizeObserver reruns this
    // when async content replaces the spinner and changes its dimensions.
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
      tooltip.classList.remove('ff-annoying-tooltip--align-left', 'ff-annoying-tooltip--align-center');
      tooltip.style.removeProperty('--ff-notch-x');
      if (horizontal.alignment === 'right') {
        tooltip.style.right = `${horizontal.right}px`;
      } else {
        tooltip.style.left = `${horizontal.left}px`;
        tooltip.classList.add(`ff-annoying-tooltip--align-${horizontal.alignment}`);
        if (horizontal.notchX !== undefined) {
          tooltip.style.setProperty('--ff-notch-x', `${horizontal.notchX}px`);
        }
      }
      tooltip.style.bottom = '';
      tooltip.style.top = `${vertical.top}px`;
      tooltip.classList.toggle('ff-annoying-tooltip--flipped', vertical.flipped);
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
      removeAnnoyingTooltip(tooltip);
      if (btnTooltip === tooltip) btnTooltip = null;
    };

    let requestEntry: SuggestionRequestEntry | null = null;
    const identityObserver = new MutationObserver(() => {
      const currentPostKey = `${_deps.adapter.getPostUrl(article) || ''}\n${formatPostForEvaluation(_deps.extractPostContent(article))}`;
      if (currentPostKey === openedPostKey) return;
      if (requestEntry) clearSuggestionRequest(article, requestEntry);
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
    annoyingTooltipCleanup.set(tooltip, () => {
      selectionCleanup?.();
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
      resizeObserver?.disconnect();
      identityObserver.disconnect();
      if (positionFrame !== null) cancelAnimationFrame(positionFrame);
      positionFrame = null;
    });
    schedulePosition();

    const composer = createBounceComposer(tooltipContent, phrase => {
      removeTooltip();
      void bouncePost(article, content, phrase);
    }, removeTooltip);
    const onSelectionChange = () => {
      composer.setState({ error: suggestionSetupMessage() || 'The engine changed. Reopen Bounce to find suggestions.', settings: true });
      schedulePosition();
    };
    suggestionSelectionListeners.add(onSelectionChange);
    const selectionCleanup = () => suggestionSelectionListeners.delete(onSelectionChange);
    composer.setState({ pending: true });
    // Only this explicit user action asks for suggestions. Their completion
    // replaces the suggestion area, preserving any phrase the user is editing.
    requestEntry = requestSuggestions(article, openedPostKey, content.text);
    const entry = requestEntry;
    void entry.promise.then(response => {
      const currentPostKey = `${_deps.adapter.getPostUrl(article) || ''}\n${formatPostForEvaluation(_deps.extractPostContent(article))}`;
      if (!tooltip.isConnected || !isSuggestionRequestCurrent(article, entry, currentPostKey)) return;
      const error = suggestionResponseMatchesSelection(response) ? suggestionResponseError(response) : 'The engine changed. Reopen Bounce to find suggestions.';
      if (error) clearSuggestionRequest(article, entry);
      composer.setState(error ? { error, settings: true } : { reasons: response.reasons || [] });
      schedulePosition();
    }).catch(err => {
      if (!tooltip.isConnected || !isSuggestionRequestCurrent(article, entry, openedPostKey)) return;
      clearSuggestionRequest(article, entry);
      composer.setState({ error: err instanceof Error ? err.message : 'Try again.' });
      schedulePosition();
    });
  });

  // Outside-click tooltip dismissal is handled by a single module-level
  // listener registered via setupAnnoyingTooltipCloser — do NOT register a
  // per-button document listener here (it would accumulate one per post and
  // fire for every click on the page).
}

// Close any open .ff-annoying-tooltip when the user clicks outside of its
// button and the tooltip itself. Registered once per page from initUI.
export function setupAnnoyingTooltipCloser() {
  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    // If the click is on any why-annoying button, let that button's own
    // click handler manage the tooltip. Skip.
    if (target instanceof Element && target.closest('.ff-why-annoying-btn')) return;
    const tooltips = document.querySelectorAll('.ff-annoying-tooltip');
    if (tooltips.length === 0) return;
    tooltips.forEach((t) => {
      if (!t.contains(target)) {
        removeAnnoyingTooltip(t);
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
