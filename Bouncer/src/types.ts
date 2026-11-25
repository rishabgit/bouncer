// ==================== Site IDs ====================

/** Known platform adapter identifiers. Add new entries when adding adapters. */
export type SiteId = 'twitter';

// ==================== Core Evaluation ====================

/** Snapshot of one detector's contribution to an evaluation. Persisted in the
 *  cache so the popup can replay tabs identically on cache hits. */
export interface DetectorSnapshot {
  status: 'success' | 'error' | 'skipped';
  shouldHide?: boolean;
  reasoning?: string;
  category?: string | null;
  /** Exact matched phrases for automatic or phrase-based manual decisions. */
  matches?: string[];
  error?: string;
  /** Either pre-run skip reason or post-race "aborted because other detector
   *  hid first" — both render the same way in the popup. */
  skipReason?: string;
}

export interface FilterScore {
  label: string;
  score: number;
}

/** Request-time data retained for debugging, including the final truncated state. */
export interface ClassificationDetails {
  scores?: FilterScore[];
  textSent?: string;
  timestamp?: number;
  model?: string;
}

/** The cached verdict for a post — what the local classifier produces and what gets stored. */
export interface EvaluationResult extends ClassificationDetails {
  shouldHide: boolean;
  reasoning: string;
  category?: string | null;
  /** Exact matched phrases for automatic or phrase-based manual decisions. */
  matches?: string[];
  rawResponse?: string | null;
  /** Set by the background when the result came from the evaluation cache. */
  cached?: boolean;
  /** Fixed local provider that produced this verdict. */
  engine?: 'llama.app';
  /** Fixed decision model, question template, cutoff and input contract. */
  classifierFingerprint?: string;
  /** Explicit local Bounce/Restore decision, preserved across DOM updates. */
  userOverride?: boolean;
  /** Per-detector snapshots so a cache hit can rebuild the same tab UI. */
  detectorStates?: { names: string[]; map: Record<string, DetectorSnapshot> };
}

/** The post data sent to a model for evaluation. */
export interface EvaluationPostData {
  text: string;
}

// ==================== Pipeline Response ====================

/** What the pipeline returns to content scripts via chrome.runtime.sendMessage. */
export type PipelineResponse = EvaluationResult | PipelineError | PipelineRetry | null;

/** Evaluation failed for this post — content keeps it visible and records the error. */
export interface PipelineError {
  error: 'local_model';
  reasoning: string;
}

/** Transient signal — content should remove from processed and retry later. */
export interface PipelineRetry {
  retry: true;
  reasoning: string;
  retryAfterMs?: number;
}

// ==================== Post Content ====================

/** Quoted tweet metadata, extracted from DOM or store. */
export interface QuoteContent {
  textHtml: string;
  author: string;
  handle: string;
  avatarUrl: string | null;
  timeText: string | null;
}

/** Extracted from DOM by the platform adapter. */
export interface PostContent {
  text: string;
  author: string;
  handle: string;
  avatarUrl: string | null;
  timeText: string | null;
  textHtml: string;
  quote: QuoteContent | null;
  postUrl: string | null;
  imageUrls: string[];
  hasMediaContainer: boolean;
  fromStore?: boolean;
  mediaBlurred?: boolean;
}

/** Stored for the "filtered posts" panel — includes captured display data for re-rendering. */
export interface FilteredPost {
  /** Snapshot of the post content at the time it was filtered. */
  post: PostContent;
  /** The evaluation text string sent to the AI (for cache key / feedback). */
  evaluationText: string;
  reasoning: string;
  rawResponse: string;
  category: string | null;
  matches?: string[];
  userOverride?: boolean;
  classification?: ClassificationDetails;
  timestamp: number;
}

// ==================== Models & Config ====================

/** Fields shared between runtime Settings and the chrome.storage.local schema. */
interface SettingsBase {
  enabled: boolean;
  // When false, replies on permalink (/status/<id>) pages are not
  // submitted for evaluation. The main timeline is unaffected either way.
  // Defaults to true to preserve historical behavior.
  filterReplies: boolean;
}

export interface Settings extends SettingsBase {
  descriptions: string[];
}

export interface LocalModelStatus {
  state: 'checking' | 'ready' | 'unavailable'
    | 'missing_model' | 'settings_required' | 'error';
  message: string;
  revision: number;
}

// ==================== Platform Adapter ====================

export interface PlatformSelectors {
  post: string;
  sidebar: string;
  sidebarContent: string;
  primaryColumn: string;
  nav: string;
  bottomBar: string;
  mutations: string;
  textContent: string;
}

export interface PlatformAdapter {
  siteId: SiteId;
  selectors: PlatformSelectors;
  extractPostContent(article: HTMLElement): PostContent;
  shouldProcessCurrentPage(): boolean;
  isMainPost(article: HTMLElement): boolean;
  /**
   * True when the current page is a permalink / conversation view — the
   * main post sits at the top and everything below it is replies. Used
   * by the "Filter replies/comments" toggle to gate evaluation on those
   * replies. Returns false on home / explore / search.
   */
  isPermalinkView(): boolean;
  getPostUrl(article: HTMLElement): string | null;
  getPostContentKey(article: HTMLElement): string;
  getPostContainer(article: HTMLElement): HTMLElement;
  hidePost(article: HTMLElement, includeThread?: boolean, keepVisible?: (article: HTMLElement) => boolean): void;
  /** Restore stale Bouncer cell state when X mounts different content in it. */
  restoreRecycledPost(article: HTMLElement): boolean;
  getThemeMode(): 'light' | 'dim' | 'dark';
  extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null>;
  cleanupFilteredPostHtml(tweetContent: HTMLElement, imageUrls: string[]): void;
  getShareButton(article: HTMLElement): HTMLElement | null;
  insertActionButton(article: HTMLElement, button: HTMLElement): void;
  getSearchForm(): HTMLElement | null;
}

// ==================== Pipeline Internals ====================

export interface ErrorState {
  type: 'local_model' | null;
  count: number;
}

export interface PendingEvaluation {
  /** Per-call UUID so tab dispatch messages can be routed back to the
   *  originating article even when its postUrl is null (ads, etc.). */
  evaluationId: string;
  post: string;
  resolve: (result: PipelineResponse) => void;
  cacheKey: string;
  tabId: number | undefined;
  postUrl: string | null;
  siteId: SiteId;
}

// ==================== Chrome Extension Messages ====================

export type ContentToBackgroundMessage =
  | { type: 'pageLoad' }
  | { type: 'evaluatePost'; evaluationId: string; post: string; postUrl: string | null; siteId: SiteId }
  | { type: 'clearCache' }
  | { type: 'clearSinglePost'; post: string }
  | { type: 'bouncePost'; post: string; phrase: string; reasoning?: string; siteId: SiteId }
  | { type: 'addFilterPhrase' | 'removeFilterPhrase'; siteId: SiteId; phrase: string }
  | { type: 'setFilterStrictness'; siteId: SiteId; phrase: string; strict: boolean }
  | { type: 'getStats' }
  | { type: 'getReasoning'; post: string }
  | { type: 'getErrorStatus' }
  | { type: 'getLocalModelStatus' }
  | { type: 'overrideCacheEntry'; post: string; shouldHide: boolean; reasoning?: string };

export type BackgroundToContentMessage =
  | { type: 'ping' }
  | { type: 'errorStatusUpdate'; errorType: 'local_model' | null; count: number }
  | { type: 'getPositions'; postUrls: string[]; evaluationIds?: string[] }
  | { type: 'evaluationStarted'; evaluationId: string; detectorNames: string[] }
  | { type: 'detectorResponse'; evaluationId: string; detectorName: string; shouldHide?: boolean; reasoning?: string; category?: string | null; matches?: string[]; error?: string; skipped?: boolean; skipReason?: string };

// ==================== Dependency Injection ====================

export interface PlatformContext {
  adapter: PlatformAdapter;
  descriptionsKey: DescriptionKey;
}

export interface PostOperations {
  findPosts: () => HTMLElement[];
  extractPostContent: (article: HTMLElement) => PostContent;
  reEvaluateAllPosts: () => void;
  processExistingPosts: () => void;
  evaluatePost: (article: HTMLElement) => Promise<void>;
  reEvaluateSinglePost: (article: HTMLElement) => Promise<void>;
}

export interface PostState {
  processedPosts: WeakSet<HTMLElement>;
  postReasonings: WeakMap<HTMLElement, ClassificationDetails & { shouldHide: boolean; reasoning: string; rawResponse?: string | null; isModelError?: boolean; category?: string | null; matches?: string[]; userOverride?: boolean }>;
  pendingPosts: Set<HTMLElement>;
}

export interface ContentUIDeps extends PlatformContext, PostOperations, PostState {}

// ==================== Chrome Storage Schema ====================

/** Per-site description keys, derived from SiteId. */
type DescriptionKeys = { [K in SiteId as `descriptions_${K}`]: string[] };
type StrictFilterKeys = { [K in SiteId as `strictFilters_${K}`]: string[] };

/** Valid storage keys for site-specific descriptions. */
export type DescriptionKey = `descriptions_${SiteId}`;
export type StrictFiltersKey = `strictFilters_${SiteId}`;

/** Typed schema for chrome.storage.local keys. */
export type StorageSchema = SettingsBase & {
  nativeModelStatus: LocalModelStatus;
  evaluationCache: Record<string, EvaluationResult>;
  stats: { filtered: number; evaluated: number; totalCost: number };
} & DescriptionKeys & StrictFilterKeys;
