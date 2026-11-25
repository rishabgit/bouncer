// Live local APIs are forbidden in unit tests; each transport test supplies its own mock.
globalThis.fetch = vi.fn(() => Promise.reject(new Error('Unexpected fetch: provide a unit-test mock')));

// Global mocks for Chrome extension APIs
globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getManifest: () => ({ version: '1.0.0' }),
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onSuspend: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    onChanged: { addListener: vi.fn() },
  },
  tabs: {
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    sendMessage: vi.fn(),
  },
} as unknown as typeof chrome;
