// Post processing pipeline: queue, cache, error/latency state

import { generateCacheKey } from '../shared/utils';
import { runDetector, type DetectorResult } from './detectors';
import { callLocalInference, localEngine, STALE_WORK_ERROR } from './local-model';
import { getStorage, setStorage, getDescriptions } from '../shared/storage';
import type {
  EvaluationResult, PipelineResponse, PipelineError, PendingEvaluation,
  ErrorState, Settings, BackgroundToContentMessage,
  SiteId, DetectorSnapshot,
} from '../types';

// ==================== Constants ====================

const CACHE_SIZE = 500; // Increased for persistent storage
const AUTOMATIC_CACHE_WRITE_DELAY_MS = 3000;
const MAX_CONCURRENT_BATCHES = 1; // One active batch preserves fresh viewport order


// =============================================================================
// Sole-classifier dispatch helpers used by processBatch.
// =============================================================================

interface TabPlanEntry {
  name: string;
  willRun: boolean;
  skipReason?: string;
}

// The per-post plan: one 'filter' entry (the local classifier). A filter that
// can't run (no phrases configured) gets a skipReason instead of willRun=true.
function buildTabPlan(
  filterEnabled: boolean,
): TabPlanEntry[] {
  return [
    {
      name: 'filter',
      willRun: filterEnabled,
      skipReason: filterEnabled ? undefined : 'No filter phrases configured',
    },
  ];
}

// Send the initial evaluationStarted + per-skipped detectorResponse messages
// and seed the snapshots map so cache writes capture skipped state too.
function dispatchInitialTabs(
  tabId: number,
  evaluationId: string,
  tabPlan: TabPlanEntry[],
): Map<string, DetectorSnapshot> {
  const snapshots = new Map<string, DetectorSnapshot>();
  if (tabPlan.length === 0) return snapshots;

  void sendToTab(tabId, {
    type: 'evaluationStarted',
    evaluationId,
    detectorNames: tabPlan.map(t => t.name),
  });
  for (const entry of tabPlan) {
    if (!entry.willRun) {
      snapshots.set(entry.name, { status: 'skipped', skipReason: entry.skipReason });
      void sendToTab(tabId, {
        type: 'detectorResponse',
        evaluationId,
        detectorName: entry.name,
        skipped: true,
        skipReason: entry.skipReason,
      });
    }
  }
  return snapshots;
}

// The sole classifier keeps the same started/result/error dispatch and cached
// snapshot contract without racing unused sibling detectors.
async function runFilterAndCaptureSnapshot(
  runFilter: () => Promise<DetectorResult>,
  snapshots: Map<string, DetectorSnapshot>,
  tabId: number,
  evaluationId: string,
  isCurrent: () => boolean,
): Promise<DetectorResult> {
  return runDetector('filter', runFilter(), (name, value, error) => {
    if (!isCurrent()) return;
    if (value) {
      snapshots.set(name, {
        status: 'success', shouldHide: value.shouldHide, reasoning: value.reasoning,
        category: value.category ?? null,
        ...(value.matches !== undefined && { matches: value.matches }),
      });
    } else if (error) {
      snapshots.set(name, { status: 'error', error: error.message });
    }
    void sendToTab(tabId, {
      type: 'detectorResponse', evaluationId, detectorName: name,
      ...(value && { shouldHide: value.shouldHide, reasoning: value.reasoning,
        category: value.category ?? null,
        ...(value.matches !== undefined && { matches: value.matches }) }),
      ...(error && { error: error.message }),
    });
  });
}

// Build a stable detectorStates blob from a tab plan + accumulated snapshots,
// suitable for persisting on EvaluationResult.
function buildDetectorStates(
  tabPlan: TabPlanEntry[],
  snapshots: Map<string, DetectorSnapshot>,
): EvaluationResult['detectorStates'] {
  if (tabPlan.length === 0) return undefined;
  return {
    names: tabPlan.map(t => t.name),
    map: Object.fromEntries(snapshots),
  };
}


// ==================== Pipeline State ====================

export let evaluationCache = new Map<string, EvaluationResult>();
let inFlightBatches = 0; // Counter for concurrent batch processing
let cacheLoaded = false;
let cacheWriteChain: Promise<void> = Promise.resolve();
let automaticCacheSaveTimeout: ReturnType<typeof setTimeout> | null = null;

// Per-tab queue management
const tabQueues = new Map<number, PendingEvaluation[]>();      // tabId -> array of queue items
const tabPendingKeys = new Map<number, Set<string>>(); // tabId -> Set of cacheKeys
const tabDuplicateResolvers = new Map<number, Map<string, Array<(result: PipelineResponse) => void>>>(); // tabId -> Map<cacheKey, [resolve]>
// Invalidates processBatch closures that were captured before a queue flush.
// Settings/filter flushes must not allow a stale batch to write cache
// entries after they return.
let pipelineGeneration = 0;
// Only active automatic evaluations own fences. User actions retire these
// tokens without accumulating a per-post generation map over a long session.
interface PostEvaluationFence { cacheKey: string; current: boolean }
const postEvaluationFences = new Map<string, Set<PostEvaluationFence>>();
// Only pending explicit writes own an entry. Every cache reader waits here,
// including readers that have not claimed an automatic-evaluation fence yet.
const pendingPostDecisions = new Map<string, Promise<void>>();

function retirePostEvaluations(cacheKey: string): void {
  for (const fence of postEvaluationFences.get(cacheKey) ?? []) fence.current = false;
}

function beginPostDecision(cacheKey: string): () => void {
  let resolve!: () => void;
  const decision = new Promise<void>(done => { resolve = done; });
  pendingPostDecisions.set(cacheKey, decision);
  return () => {
    if (pendingPostDecisions.get(cacheKey) === decision) pendingPostDecisions.delete(cacheKey);
    resolve();
  };
}

function claimPostEvaluation(cacheKey: string): PostEvaluationFence {
  const fence = { cacheKey, current: true };
  const fences = postEvaluationFences.get(cacheKey) ?? new Set<PostEvaluationFence>();
  fences.add(fence);
  postEvaluationFences.set(cacheKey, fences);
  return fence;
}

function releasePostEvaluation(fence: PostEvaluationFence): void {
  const fences = postEvaluationFences.get(fence.cacheKey);
  fences?.delete(fence);
  if (fences?.size === 0) postEvaluationFences.delete(fence.cacheKey);
}

async function retiredEvaluationResponse(fence: PostEvaluationFence | null): Promise<PipelineResponse> {
  const manual = fence && !fence.current && await readCachedEvaluation(fence.cacheKey);
  if (manual && manual.userOverride) return { ...manual, cached: true };
  return {
    retry: true,
    reasoning: 'Local model or filter settings changed during evaluation.',
    retryAfterMs: 250,
  };
}
let activeTabId: number | null = null;

function assertPipelineGeneration(expected: number): void {
  if (pipelineGeneration !== expected) {
    throw new Error(STALE_WORK_ERROR);
  }
}

// Unified error state
export let errorState: ErrorState = {
  type: null,
  count: 0,
};

// Tab set reference (set from index.ts)
let activeContentTabsRef: Set<number> | null = null;

// ==================== Initialization ====================

export function initPipeline(tabs: Set<number>): void {
  activeContentTabsRef = tabs;
}

export function requiresLocalInference(
  settings: Pick<Settings, 'enabled' | 'descriptions'>,
): boolean {
  return settings.enabled && settings.descriptions.length > 0;
}

// ==================== Per-tab queue management ====================

// Update queue priority. The current finite post operation finishes normally.
export function setActiveTab(tabId: number | null): void {
  if (tabId === activeTabId) return;
  activeTabId = tabId;
  if (tabId !== null && tabQueues.has(tabId) && tabQueues.get(tabId)!.length > 0) {
    scheduleBatch();
  }
}

// Enqueue a post for a specific tab. Returns true if the cacheKey was already queued (duplicate).
// Duplicates are NOT added to the queue array — their resolve callbacks are stored separately
// and called when the original item completes, avoiding redundant processing cycles.
export function enqueuePost(tabId: number, item: PendingEvaluation): boolean {
  if (!tabQueues.has(tabId)) {
    tabQueues.set(tabId, []);
    tabPendingKeys.set(tabId, new Set());
    tabDuplicateResolvers.set(tabId, new Map());
  }
  const keys = tabPendingKeys.get(tabId)!;
  const isDuplicate = keys.has(item.cacheKey);
  if (isDuplicate) {
    // Store resolver to be called when the original item completes
    const dupes = tabDuplicateResolvers.get(tabId)!;
    if (!dupes.has(item.cacheKey)) dupes.set(item.cacheKey, []);
    dupes.get(item.cacheKey)!.push(item.resolve);
    return true;
  }
  keys.add(item.cacheKey);
  tabQueues.get(tabId)!.push(item);
  return false;
}

// Check if a cacheKey is pending in a specific tab's queue.
export function isKeyPending(tabId: number, cacheKey: string): boolean {
  const keys = tabPendingKeys.get(tabId);
  return keys ? keys.has(cacheKey) : false;
}

// Resolve an item AND any duplicate resolvers waiting on the same cacheKey.
function resolveWithDuplicates(tabId: number, item: PendingEvaluation, result: PipelineResponse): void {
  item.resolve(result);
  const dupes = tabDuplicateResolvers.get(tabId);
  if (dupes && item.cacheKey && dupes.has(item.cacheKey)) {
    for (const resolve of dupes.get(item.cacheKey)!) {
      resolve(result);
    }
    dupes.delete(item.cacheKey);
  }
}

// Clear a specific tab's queue — resolved items are silently dropped (null).
export function clearTabQueue(tabId: number): void {
  const queue = tabQueues.get(tabId);
  if (queue) {
    for (const item of queue) {
      resolveWithDuplicates(tabId, item, null);
    }
    // The original for a duplicate key may already have been shifted into an
    // in-flight batch. Those duplicate callbacks then exist only in this map;
    // resolve them before dropping tab state so no sendMessage promise hangs.
    const remainingDuplicates = tabDuplicateResolvers.get(tabId);
    if (remainingDuplicates) {
      for (const resolvers of remainingDuplicates.values()) {
        for (const resolve of resolvers) resolve(null);
      }
      remainingDuplicates.clear();
    }
    tabQueues.delete(tabId);
    tabPendingKeys.delete(tabId);
    tabDuplicateResolvers.delete(tabId);
  }
}

// ==================== Broadcast helpers ====================

// Send a typed message to a single tab
export function sendToTab(tabId: number, message: BackgroundToContentMessage): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message);
}

// Replay classifier snapshots or a current manual decision for the post UI.
export function replayDetectorStates(tabId: number, evaluationId: string, evalResult: EvaluationResult): void {
  if (evalResult.detectorStates) {
    const { names, map } = evalResult.detectorStates;
    void sendToTab(tabId, { type: 'evaluationStarted', evaluationId, detectorNames: names });
    for (const name of names) {
      const snap = map[name];
      if (!snap) continue;
      void sendToTab(tabId, {
        type: 'detectorResponse',
        evaluationId,
        detectorName: name,
        ...(snap.status === 'success' && {
          shouldHide: snap.shouldHide,
          reasoning: snap.reasoning,
          category: snap.category ?? null,
          ...(snap.matches !== undefined && { matches: snap.matches }),
        }),
        ...(snap.status === 'error' && { error: snap.error }),
        ...(snap.status === 'skipped' && { skipped: true, skipReason: snap.skipReason }),
      });
    }
    return;
  }

  // Manual Bounce/Restore writes have no classifier snapshots. Present their
  // explicit decision in the filter tab; automatic results replay only snapshots.
  if (evalResult.userOverride !== true) return;
  void sendToTab(tabId, { type: 'evaluationStarted', evaluationId, detectorNames: ['filter'] });
  void sendToTab(tabId, {
    type: 'detectorResponse',
    evaluationId,
    detectorName: 'filter',
    shouldHide: evalResult.shouldHide,
    reasoning: evalResult.reasoning,
    category: evalResult.category ?? null,
    ...(evalResult.matches !== undefined && { matches: evalResult.matches }),
  });
}

// Generic helper to broadcast messages to all tabs with active content scripts
function broadcastToTabs(message: BackgroundToContentMessage): void {
  const tabs = activeContentTabsRef;
  if (!tabs) return;
  for (const tabId of tabs) {
    void sendToTab(tabId, message);
  }
}

// ==================== Settings helper ====================

// Get user settings
// siteId is optional - if provided, fetches site-specific descriptions
export async function getSettings(siteId?: SiteId): Promise<Settings> {
  const descriptionsKey = siteId ? `descriptions_${siteId}` as const : undefined;
  const settingsKeys = [
    'enabled',
    'filterReplies'
  ] as const;
  const [data, descriptions] = await Promise.all([
    getStorage([...settingsKeys]),
    descriptionsKey ? getDescriptions(descriptionsKey) : Promise.resolve([] as string[])
  ]);
  return {
    enabled: data.enabled !== false,
    descriptions,
    filterReplies: data.filterReplies !== false
  };
}

// ==================== Error state management ====================

// Broadcast unified error status to all tabs
export function broadcastErrorStatus(): Promise<void> {
  const status: BackgroundToContentMessage = {
    type: 'errorStatusUpdate',
    errorType: errorState.type,
    count: errorState.count,
  };
  broadcastToTabs(status);
  return Promise.resolve();
}

// Reset error state and broadcast
export async function clearErrorState(): Promise<void> {
  errorState = { type: null, count: 0 };
  await broadcastErrorStatus();
}

// ==================== Cache ====================

/** Read only settled cache state; re-read after explicit persistence/rollback. */
export async function readCachedEvaluation(cacheKey: string): Promise<EvaluationResult | undefined> {
  let decision: Promise<void> | undefined;
  while ((decision = pendingPostDecisions.get(cacheKey))) await decision;
  const cached = evaluationCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.userOverride === true) return cached;
  return typeof cached.shouldHide === 'boolean' && typeof cached.reasoning === 'string'
    && cached.engine === 'llama.app'
    && cached.classifierFingerprint === localEngine.getClassifierFingerprint() ? cached : undefined;
}

// Load cache from persistent storage on startup
export async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  try {
    const data = await getStorage(['evaluationCache']);
    if (data.evaluationCache && typeof data.evaluationCache === 'object') {
      evaluationCache = new Map(Object.entries(data.evaluationCache));
    }
    cacheLoaded = true;
  } catch (err) {
    // A failed read must not bless an empty map and let a later automatic
    // snapshot overwrite saved manual decisions. The startup barrier retries.
    console.error('Failed to load cache:', err);
    throw err;
  }
}

function cancelAutomaticCacheSave(): void {
  if (automaticCacheSaveTimeout === null) return;
  clearTimeout(automaticCacheSaveTimeout);
  automaticCacheSaveTimeout = null;
}

// Automatic verdicts share one bounded write window. Snapshot only when the
// first dirty entry's timer fires; later entries do not slide the deadline.
// A worker terminating within that window can lose these optional cache hits.
export function scheduleAutomaticCacheSave(): void {
  if (automaticCacheSaveTimeout !== null) return;
  automaticCacheSaveTimeout = setTimeout(() => {
    automaticCacheSaveTimeout = null;
    void saveCache();
  }, AUTOMATIC_CACHE_WRITE_DELAY_MS);
}

// Explicit saves are immediate serialized barriers, including user decisions
// and rollback. They also flush any automatic changes waiting for their timer.
export async function saveCache(throwOnError = false): Promise<void> {
  cancelAutomaticCacheSave();
  const cacheObj = Object.fromEntries(evaluationCache);
  try {
    const write = cacheWriteChain
      .catch(() => undefined)
      .then(() => setStorage({ evaluationCache: cacheObj }));
    cacheWriteChain = write.catch(() => undefined);
    await write;
  } catch (err) {
    console.error('Failed to save cache:', err);
    if (throwOnError) throw err;
  }
}

export async function clearEvaluationCache(): Promise<void> {
  cancelAutomaticCacheSave();
  evaluationCache.clear();
  const write = cacheWriteChain
    .catch(() => undefined)
    .then(() => setStorage({ evaluationCache: {} }));
  cacheWriteChain = write.catch(() => undefined);
  await write;
}

/** Durable explicit user decision. A late automatic evaluation cannot replace it. */
export async function overridePost(
  post: string,
  shouldHide: boolean,
  reasoning = 'User override',
  matches?: string[],
): Promise<void> {
  await loadCache();
  const cacheKey = generateCacheKey(post);
  const settleDecision = beginPostDecision(cacheKey);
  retirePostEvaluations(cacheKey);
  const previous = evaluationCache.get(cacheKey);
  const override: EvaluationResult = {
    shouldHide, reasoning, userOverride: true, timestamp: Date.now(),
    ...(matches !== undefined && {
      matches,
      category: matches.length > 0 ? matches.join(', ') : null,
    }),
  };
  evaluationCache.set(cacheKey, override);
  try {
    await saveCache(true);
  } catch (error) {
    if (evaluationCache.get(cacheKey) === override) {
      if (previous) evaluationCache.set(cacheKey, previous);
      else evaluationCache.delete(cacheKey);
      // Another post may already have queued a cache snapshot containing this
      // provisional override. Put the rollback after those serialized writes.
      await saveCache();
    }
    throw error;
  } finally {
    settleDecision();
  }
}

export async function clearPost(post: string): Promise<void> {
  await loadCache();
  const cacheKey = generateCacheKey(post);
  retirePostEvaluations(cacheKey);
  const previous = evaluationCache.get(cacheKey);
  if (!previous) {
    // Even a missing-key clear finishes pending automatic persistence. Flush a
    // waiting timer now, or wait for an already-running write without duplicating it.
    if (automaticCacheSaveTimeout !== null) await saveCache(true);
    else await cacheWriteChain;
    return;
  }
  const settleDecision = beginPostDecision(cacheKey);
  evaluationCache.delete(cacheKey);
  try {
    await saveCache(true);
  } catch (error) {
    if (!evaluationCache.has(cacheKey)) {
      evaluationCache.set(cacheKey, previous);
      await saveCache();
    }
    throw error;
  } finally {
    settleDecision();
  }
}

// ==================== Viewport prioritization ====================

// Prioritize pending posts by their distance to viewport center
// Requests current positions from content scripts and sorts the queue
export async function prioritizeByViewportDistance(queue: PendingEvaluation[]): Promise<void> {
  if (queue.length === 0) return;

  // Group pending posts by tab. Normal tweets are located by postUrl; ads and
  // other no-permalink posts fall back to evaluationId so they can still be
  // prioritized by visible viewport distance.
  const postsByTab = new Map<number | undefined, { postUrls: string[]; evaluationIds: string[] }>();
  queue.forEach(item => {
    if (!postsByTab.has(item.tabId)) {
      postsByTab.set(item.tabId, { postUrls: [], evaluationIds: [] });
    }
    const entry = postsByTab.get(item.tabId)!;
    if (item.postUrl) {
      entry.postUrls.push(item.postUrl);
    } else {
      entry.evaluationIds.push(item.evaluationId);
    }
  });

  // Request positions from each tab
  const positionPromises: Promise<{ tabId: number | undefined; positions: Record<string, number> }>[] = [];
  for (const [tabId, { postUrls, evaluationIds }] of postsByTab) {
    positionPromises.push(
      chrome.tabs.sendMessage(tabId!, { type: 'getPositions', postUrls, evaluationIds })
        .then((response: { positions?: Record<string, number> } | undefined) => ({ tabId, positions: response?.positions || {} }))
        .catch(() => {
          return { tabId, positions: {} as Record<string, number> };
        })
    );
  }

  const results = await Promise.all(positionPromises);

  // Build distance map: postUrl or evaluationId -> distance to viewport center
  const distanceMap = new Map<string, number>();
  for (const { positions } of results) {
    for (const [key, distance] of Object.entries(positions)) {
      distanceMap.set(key, distance);
    }
  }

  // Sort by distance (closest first), posts not found in DOM go to end
  queue.sort((a, b) => {
    const distA = distanceMap.get(a.postUrl ?? a.evaluationId) ?? Infinity;
    const distB = distanceMap.get(b.postUrl ?? b.evaluationId) ?? Infinity;
    return distA - distB;
  });

}


// ==================== Batch processing ====================

// Process a batch of posts
async function processBatch(): Promise<void> {
  if (activeTabId === null) return;

  // The current batch owns the serial slot and wakes the next eligible post
  // after its finite operation settles.
  if (inFlightBatches >= MAX_CONCURRENT_BATCHES) return;

  // Capture tab ID before any async work
  const batchTabId = activeTabId;
  const pendingEvaluations = tabQueues.get(batchTabId);
  const pendingKeys = tabPendingKeys.get(batchTabId);

  if (!pendingEvaluations || pendingEvaluations.length === 0) return;

  inFlightBatches++;
  const batchGeneration = pipelineGeneration;
  let suppressWakeOnExit = false;
  let postFence: PostEvaluationFence | null = null;

  try {

  const settings = await getSettings(pendingEvaluations[0]?.siteId);
  if (batchGeneration !== pipelineGeneration) {
    return;
  }
  // The native classifier is serial. Re-sort before each dequeue so active
  // viewport changes retain priority while another response is settling.
  if (pendingEvaluations.length > 0) {
    await prioritizeByViewportDistance(pendingEvaluations);
    if (batchGeneration !== pipelineGeneration) return;
  }

  // setActiveTab() can run while settings or viewport ordering is awaiting.
  // Keep this tab's item queued instead of starting battery-expensive inference
  // for a tab that is no longer active; the finalizer wakes the new active tab.
  if (activeTabId !== batchTabId) {
    return;
  }

  // Grab one post from the queue (re-check length — async ops above may have drained it)
  if (pendingEvaluations.length === 0) {
    return;
  }
  const item = pendingEvaluations.shift()!;
  if (item.cacheKey) pendingKeys!.delete(item.cacheKey);

  // Handle disabled case
  if (!settings.enabled) {
    resolveWithDuplicates(batchTabId, item, { shouldHide: false, reasoning: 'Filtering is disabled' });
    return;
  }

  // The filter runs only when the user has configured filter phrases. We still
  // flow through the tab-dispatch logic below so the popup shows the filter tab
  // (marked skipped when no phrases are set).
  const filterEnabled = !!(settings.descriptions && settings.descriptions.length > 0);

  // Check cache
  const cacheKey = generateCacheKey(item.post);
  // Own the post before the cache read yields, including an already-settled
  // miss. An explicit decision can begin in that await's continuation window.
  postFence = claimPostEvaluation(cacheKey);
  const isEvaluationCurrent = (): boolean => batchGeneration === pipelineGeneration
    && postFence!.current && tabQueues.get(batchTabId) === pendingEvaluations;
  const cached = await readCachedEvaluation(cacheKey);
  if (!isEvaluationCurrent()) {
    resolveWithDuplicates(batchTabId, item, await retiredEvaluationResponse(postFence));
    return;
  }
  if (cached) {
    replayDetectorStates(batchTabId, item.evaluationId, cached);
    resolveWithDuplicates(batchTabId, item, { ...cached, cached: true });
    return;
  }

  const postData = { text: item.post };
  const inferenceEpoch = localEngine.operationEpoch;
  try {
    // The fixed native classifier.
    const runFilter = async (): Promise<DetectorResult> => {
      return callLocalInference(
        postData, settings.descriptions, {
          assertCurrent: () => {
            assertPipelineGeneration(batchGeneration);
            if (!postFence!.current || tabQueues.get(batchTabId) !== pendingEvaluations) {
              throw new Error(STALE_WORK_ERROR);
            }
          },
        },
      );
    };

    const tabPlan = buildTabPlan(filterEnabled);
    const snapshots = dispatchInitialTabs(batchTabId, item.evaluationId, tabPlan);
    const result = filterEnabled
      ? await runFilterAndCaptureSnapshot(runFilter, snapshots, batchTabId, item.evaluationId, isEvaluationCurrent)
      : { shouldHide: false, reasoning: 'No filter phrases set.' };

    // A settings/model flush may have happened while inference was running.
    // Never persist or publish a result computed under the retired generation.
    if (!isEvaluationCurrent()) {
      resolveWithDuplicates(batchTabId, item, await retiredEvaluationResponse(postFence));
      return;
    }

    localEngine.assertOperationEpoch(inferenceEpoch);
    console.log(`[Eval] shouldHide=${result.shouldHide}, category="${result.category}", reasoning="${result.reasoning?.substring(0, 80)}"`);

    const evalResult: EvaluationResult = {
      shouldHide: result.shouldHide,
      reasoning: result.reasoning,
      category: result.category || null,
      ...(result.matches !== undefined && { matches: result.matches }),
      ...(result.scores !== undefined && { scores: result.scores }),
      ...(result.textSent !== undefined && { textSent: result.textSent }),
      rawResponse: result.rawResponse || null,
      ...(result.modelId !== undefined && { model: result.modelId }),
      ...(result.engine !== undefined && { engine: result.engine }),
      ...(result.classifierFingerprint !== undefined && { classifierFingerprint: result.classifierFingerprint }),
      timestamp: Date.now(),
      detectorStates: buildDetectorStates(tabPlan, snapshots),
    };

    // Stats persistence does not change the classification decision. A failed
    // counter write must not turn a successful evaluation into a model error.
    try {
      const statsData = await getStorage(['stats']);
      const stats = statsData.stats || { filtered: 0, evaluated: 0, totalCost: 0 };
      stats.evaluated++;
      if (evalResult.shouldHide) {
        stats.filtered++;
      }
      await setStorage({ stats });
    } catch (statsError) {
      console.error('[Stats] Failed to update evaluation counters:', statsError);
    }

    // A filter/model change can arrive while stats storage is pending. Do not
    // repopulate the just-invalidated cache or publish a verdict from the old
    // rules after that boundary.
    if (!isEvaluationCurrent()) {
      resolveWithDuplicates(batchTabId, item, await retiredEvaluationResponse(postFence));
      return;
    }

    localEngine.assertOperationEpoch(inferenceEpoch);
    evaluationCache.set(cacheKey, evalResult);
    if (evaluationCache.size > CACHE_SIZE) {
      const firstKey = evaluationCache.keys().next().value;
      if (firstKey !== undefined) evaluationCache.delete(firstKey);
    }
    scheduleAutomaticCacheSave();

    if (!isEvaluationCurrent()) {
      if (evaluationCache.get(cacheKey) === evalResult) {
        evaluationCache.delete(cacheKey);
        scheduleAutomaticCacheSave();
      }
      resolveWithDuplicates(batchTabId, item, await retiredEvaluationResponse(postFence));
      return;
    }

    // A successful post clears the connection indicator. Earlier failed posts
    // stay visible; they do not block or automatically retry later work.
    if (errorState.type) await clearErrorState();

    if (!isEvaluationCurrent() || localEngine.operationEpoch !== inferenceEpoch) {
      if (evaluationCache.get(cacheKey) === evalResult) {
        evaluationCache.delete(cacheKey);
        scheduleAutomaticCacheSave();
      }
      resolveWithDuplicates(batchTabId, item, await retiredEvaluationResponse(postFence));
      return;
    }
    resolveWithDuplicates(batchTabId, item, evalResult);
  } catch (error) {
    const errorMessage = (error as Error).message;
    if (tabQueues.get(batchTabId) !== pendingEvaluations && batchGeneration === pipelineGeneration) {
      suppressWakeOnExit = true;
      resolveWithDuplicates(batchTabId, item, null);
      return;
    }
    if (!isEvaluationCurrent() || errorMessage === STALE_WORK_ERROR) {
      resolveWithDuplicates(batchTabId, item, await retiredEvaluationResponse(postFence));
      return;
    }

    console.error('Inference error:', error);

    errorState.type = 'local_model';
    errorState.count++;
    broadcastErrorStatus().catch(err => console.error('[Error] Broadcast failed:', err));

    const errorResult: PipelineError = {
      error: 'local_model',
      reasoning: errorMessage || 'Local filtering failed for this post. The post remains visible.',
    };
    resolveWithDuplicates(batchTabId, item, errorResult);
  }

  } catch (error) {
    // Infrastructure failed before an item reached the inner inference/error
    // boundary (for example, chrome.storage was briefly unavailable). Release
    // one caller with a bounded retry instead of leaving its Promise parked.
    const failedItem = pendingEvaluations.shift();
    if (failedItem) {
      if (failedItem.cacheKey) pendingKeys?.delete(failedItem.cacheKey);
      resolveWithDuplicates(batchTabId, failedItem, {
        retry: true,
        reasoning: (error as Error).message || 'Local pipeline temporarily unavailable.',
        retryAfterMs: 1000,
      });
    }
    console.error('[Pipeline] Batch preparation failed:', error);
  } finally {
    if (postFence) releasePostEvaluation(postFence);
    // Every path after claiming a batch slot—including storage, viewport, and
    // cache failures—must release it. A leaked count permanently stalls this
    // serial local pipeline because later work looks spuriously concurrent.
    inFlightBatches--;

    // Clean up empty tab queue entries to prevent memory leak over long sessions.
    const batchQueue = tabQueues.get(batchTabId);
    if (batchQueue && batchQueue.length === 0) {
      tabQueues.delete(batchTabId);
      tabPendingKeys.delete(batchTabId);
      tabDuplicateResolvers.delete(batchTabId);
    }

    // A concurrent local attempt may have returned while this older batch was
    // still settling. The final owner of the serial slot is responsible for
    // waking whatever is now queued, regardless of its own exit path.
    const activeQueue = activeTabId !== null ? tabQueues.get(activeTabId) : null;
    if ((!suppressWakeOnExit || activeTabId !== batchTabId)
        && inFlightBatches === 0
        && activeQueue
        && activeQueue.length > 0) {
      scheduleBatch();
    }
  }
}

// Schedule processing for the next pending post
export function scheduleBatch(): void {
  if (activeTabId === null) {
    return;
  }

  const activeQueue = tabQueues.get(activeTabId);
  if (!activeQueue || activeQueue.length === 0) {
    return;
  }

  processBatch().catch(err => console.error('[Pipeline] processBatch failed:', err));
}

// ==================== Settings change handling ====================

// Drain in-flight pipeline state without touching the cache. Used when we want in-flight
// and queued classifications to be retried against fresh settings while keeping cached
// classifications intact.
function flushPipelineQueues(reason: string): void {
  pipelineGeneration++;
  // A queue flush retires active and pending results. An in-flight request
  // settles or times out before the serial client submits fresh work.
  localEngine.invalidate();
  for (const [tabId, queue] of tabQueues.entries()) {
    const result: PipelineResponse = {
      retry: true as const,
      reasoning: reason,
      retryAfterMs: 250,
    };
    for (const queueItem of queue) {
      resolveWithDuplicates(tabId, queueItem, result);
    }
    queue.length = 0;
    // processBatch shifts its item before awaiting inference. Same-key callers
    // registered after that shift live only in the duplicate map, so resolve
    // any entries left after the queued originals before deleting tab state.
    const remainingDuplicates = tabDuplicateResolvers.get(tabId);
    if (remainingDuplicates) {
      for (const resolvers of remainingDuplicates.values()) {
        for (const resolve of resolvers) resolve(result);
      }
      remainingDuplicates.clear();
    }
    tabQueues.delete(tabId);
    tabPendingKeys.delete(tabId);
    tabDuplicateResolvers.delete(tabId);
  }
}

export function handleSettingsChange(_changes: Record<string, chrome.storage.StorageChange>): Promise<void> {
  try {
    flushPipelineQueues('Settings changed, re-evaluating...');
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

// Called when the filter phrase list changed. Clears the cache and flushes in-flight
// batches so they re-run against the updated phrase set.
export async function handleFilterChange(): Promise<void> {
  flushPipelineQueues('Filter phrases changed, re-evaluating...');
  await clearEvaluationCache();
}

// Handle page load: clear pending evaluations for a specific tab
export function handlePageLoad(tabId: number): void {
  clearTabQueue(tabId);
  if (tabId === activeTabId) {
    localEngine.clearQueue();
  }
}

// ==================== Request ownership ====================

export interface InferenceRequestFence {
  assertCurrent: () => void;
}

/** Capture before any startup/settings/queue await, including at message receipt. */
export function captureInferenceRequest(
  assertDocumentCurrent: () => void = () => undefined,
): InferenceRequestFence {
  const generation = pipelineGeneration;
  const epoch = localEngine.operationEpoch;
  return {
    assertCurrent: () => {
      assertPipelineGeneration(generation);
      localEngine.assertOperationEpoch(epoch);
      assertDocumentCurrent();
    },
  };
}
