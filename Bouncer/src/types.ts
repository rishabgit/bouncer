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
  /** Exact matched phrases when known; legacy cache entries may omit them. */
  matches?: string[];
  error?: string;
  /** Either pre-run skip reason or post-race "aborted because other detector
   *  hid first" — both render the same way in the popup. */
  skipReason?: string;
}

/** The cached verdict for a post — what the local classifier produces and what gets stored. */
export interface EvaluationResult {
  shouldHide: boolean;
  reasoning: string;
  category?: string | null;
  /** Exact matched phrases when known; legacy cache entries may omit them. */
  matches?: string[];
  rawResponse?: string | null;
  timestamp?: number;
  /** Which model produced this evaluation. */
  model?: string;
  /** Set by the background when the result came from the evaluation cache. */
  cached?: boolean;
  /** Fixed native artifact, prompt/parser and inference/input contract. */
  classifierFingerprint?: string;
  /** Invalid model output remains an explicit failure, never a negative hit. */
  malformed?: boolean;
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

/** Evaluation failed — content should track for retry via error broadcasts. */
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
  timestamp: number;
}

// ==================== Models & Config ====================

/** The fixed native classifier. There is no runtime model or endpoint picker. */
export interface LocalModelDef {
  name: string;
  display: string;
  backend: 'ollama';
  manifestDigest: string | null;
  weightDigest: string;
  contextTokens: number;
}

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
  state: 'not_connected' | 'ready' | 'loading' | 'filtering' | 'paused'
    | 'missing_model' | 'blocked' | 'recovery_required' | 'error';
  message: string;
  reason?: string;
  revision: number;
  /** Qualified operator restart is an explicit trust boundary, not an API ack. */
  recoveryQualified?: boolean;
}

/** Durable native lease. Never store post text, phrases, or response content. */
export interface NativeOperationFence {
  schemaVersion: 1;
  operationId: string;
  epoch: number;
  startedAt: number;
  modelDigest: string;
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
  hidePost(article: HTMLElement, includeThread?: boolean): void;
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

// ==================== Chat Messages ====================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ==================== Chrome Extension Messages ====================

export type ContentToBackgroundMessage =
  | { type: 'pageLoad' }
  | { type: 'evaluatePost'; evaluationId: string; post: string; postUrl: string | null; siteId: SiteId }
  | { type: 'suggestAnnoyingReasons'; post: string; siteId?: SiteId }
  | { type: 'clearCache' }
  | { type: 'clearSinglePost'; post: string }
  | { type: 'bouncePost'; post: string; phrase?: string; reasoning?: string; siteId: SiteId }
  | { type: 'getStats' }
  | { type: 'getReasoning'; post: string }
  | { type: 'getErrorStatus' }
  | { type: 'getNativeModelStatus' }
  | { type: 'connectNativeModel' }
  | { type: 'retryNativeModel' }
  | { type: 'recoverNativeModel'; operatorRestartConfirmed: true }
  | { type: 'preemptInference' }
  | { type: 'overrideCacheEntry'; post: string; shouldHide: boolean; reasoning?: string }
  // Dev-only latency benchmark (gated by __DEV__ in the background dispatch).
  | { type: 'benchmark'; op: 'load' | 'infer' | 'unload'; modelId?: string; post?: { text: string }; categories?: string[]; promptMode?: 'baseline' | 'intent' };

export type BackgroundToContentMessage =
  | { type: 'ping' }
  | { type: 'errorStatusUpdate'; errorType: 'local_model' | null; count: number }
  | { type: 'reEvaluateErrors' }
  | { type: 'getPositions'; postUrls: string[]; evaluationIds?: string[] }
  | { type: 'processingPost'; postUrl: string }
  | { type: 'annoyingProgress'; verified: number; total: number }
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
  postReasonings: WeakMap<HTMLElement, { shouldHide: boolean; reasoning: string; rawResponse?: string | null; isModelError?: boolean; category?: string | null; matches?: string[]; userOverride?: boolean }>;
  pendingPosts: Set<HTMLElement>;
}

export interface ContentUIDeps extends PlatformContext, PostOperations, PostState {}

// ==================== Chrome Storage Schema ====================

/** Per-site description keys, derived from SiteId. */
type DescriptionKeys = { [K in SiteId as `descriptions_${K}`]: string[] };

/** Valid storage keys for site-specific descriptions. */
export type DescriptionKey = `descriptions_${SiteId}`;

/** Typed schema for chrome.storage.local keys. */
export type StorageSchema = SettingsBase & {
  nativeModelStatus: LocalModelStatus;
  nativeOperationFence: NativeOperationFence;
  evaluationCache: Record<string, EvaluationResult>;
  stats: { filtered: number; evaluated: number; totalCost: number };
  nativeCutoverSchemaVersion: number;
  nativeModelCacheCleanupVersion: number;
} & DescriptionKeys;
