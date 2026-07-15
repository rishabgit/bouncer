import { beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  onInstalled: null as ((details: { reason: string }) => void) | null,
  onStorageChanged: null as ((
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => void) | null,
  storage: {
    localModelStatuses: {
      'gemma-4-E2B-it-web': {
        state: 'error',
        error: 'Local inference timed out. Retry from the Bouncer popup.',
      },
    },
  } as Record<string, unknown>,
  localEngine: {
    engine: null,
    loadedModel: null,
    syncAllStatuses: vi.fn().mockResolvedValue(undefined),
    checkCached: vi.fn().mockResolvedValue(true),
    isMaintaining: vi.fn(() => false),
    isModelLoaded: vi.fn(() => false),
    isInitializing: vi.fn(() => false),
    initialize: vi.fn().mockResolvedValue(null),
    cancelDownload: vi.fn().mockResolvedValue(false),
    deleteModelCache: vi.fn().mockResolvedValue({ success: true }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    runMaintenance: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    reset: vi.fn().mockResolvedValue(undefined),
    preempt: vi.fn(),
    teardown: vi.fn(),
  },
  handleSettingsChange: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/background/local-model.js', () => ({
  localEngine: state.localEngine,
  MODEL_MAINTENANCE_ERROR: 'Local model maintenance in progress',
}));

vi.mock('../../src/background/backends/litertlm-backend.js', () => ({
  forceCloseLitertlmOffscreen: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/background/model-migration.js', () => ({
  migrateToGemmaOnlyModel: vi.fn().mockResolvedValue({
    storageNormalized: false,
    retiredCachesCleaned: false,
  }),
}));

vi.mock('../../src/background/benchmark.js', () => ({
  handleBenchmark: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/background/pipeline.js', () => ({
  initPipeline: vi.fn(),
  loadCache: vi.fn().mockResolvedValue(undefined),
  saveCache: vi.fn().mockResolvedValue(undefined),
  setActiveTab: vi.fn(),
  enqueuePost: vi.fn(),
  isKeyPending: vi.fn(() => false),
  clearTabQueue: vi.fn(),
  scheduleBatch: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({
    enabled: true,
    descriptions: [],
    selectedModel: 'local:gemma-4-E2B-it-web',
    filterReplies: true,
  }),
  errorState: { type: null, count: 0 },
  evaluationCache: new Map(),
  clearEvaluationCache: vi.fn().mockResolvedValue(undefined),
  handleSettingsChange: state.handleSettingsChange,
  handleFilterPackChange: vi.fn().mockResolvedValue(undefined),
  handlePageLoad: vi.fn(),
  suggestAnnoyingReasons: vi.fn().mockResolvedValue([]),
  replayDetectorStates: vi.fn(),
  runModelMaintenance: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  triggerErrorRetry: vi.fn().mockResolvedValue(undefined),
  requiresLocalInference: vi.fn(() => false),
}));

const storageGet = vi.fn(async (keys?: string | string[]) => {
  if (keys === undefined) return structuredClone(state.storage);
  const requested = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(
    requested
      .filter(key => Object.prototype.hasOwnProperty.call(state.storage, key))
      .map(key => [key, structuredClone(state.storage[key])]),
  );
});
const storageSet = vi.fn(async (items: Record<string, unknown>) => {
  Object.assign(state.storage, structuredClone(items));
});

globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
    onMessage: { addListener: vi.fn() },
    onInstalled: {
      addListener: vi.fn((listener: (details: { reason: string }) => void) => {
        state.onInstalled = listener;
      }),
    },
    onSuspend: { addListener: vi.fn() },
  },
  storage: {
    local: {
      get: storageGet,
      set: storageSet,
      remove: vi.fn().mockResolvedValue(undefined),
    },
    onChanged: {
      addListener: vi.fn((listener: (
        changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        areaName: string,
      ) => void) => {
        state.onStorageChanged = listener;
      }),
    },
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onActivated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: { addListener: vi.fn() },
  },
} as unknown as typeof chrome;

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { gpu: {} },
});

describe('background extension lifecycle', () => {
  beforeAll(async () => {
    await import('../../src/background/index.js');
    await vi.waitFor(() => expect(state.localEngine.syncAllStatuses).toHaveBeenCalled());
  });

  it('preserves a terminal model error when an extension update reconciles cache status', async () => {
    expect(state.onInstalled).toBeTypeOf('function');

    state.onInstalled!({ reason: 'update' });

    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledWith({
      localModelStatuses: {
        'gemma-4-E2B-it-web': {
          state: 'error',
          error: 'Local inference timed out. Retry from the Bouncer popup.',
        },
      },
    }));
    expect(state.localEngine.checkCached).not.toHaveBeenCalled();
  });

  it('flushes captured verdicts when filtering is disabled', async () => {
    expect(state.onStorageChanged).toBeTypeOf('function');
    const changes = {
      enabled: { oldValue: true, newValue: false },
    };

    state.onStorageChanged!(changes, 'local');

    await vi.waitFor(() => expect(state.handleSettingsChange).toHaveBeenCalledWith(changes));
  });
});
