/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DOMPurify from 'dompurify';
import type { BackgroundToContentMessage, EvaluationResult, PipelineResponse, PlatformAdapter, PostContent } from '../../src/types.js';
import { generateCacheKey } from '../../src/shared/utils.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('live content filter actions', () => {
  let ui: typeof import('../../src/content/ui.js');
  let adapter: PlatformAdapter;
  let storage: Record<string, unknown>;
  let storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>) => void>;
  let messageListeners: Array<(message: BackgroundToContentMessage, sender: object, respond: () => void) => void>;
  let evaluations: Array<{ message: { evaluationId: string; post: string }; resolve: (value: PipelineResponse) => void }>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let permalink: boolean;
  let mutationObservers: Array<{ callback: MutationCallback; options?: MutationObserverInit }>;
  let suggestions: ReturnType<typeof deferred<{ reasons: string[] }>> | null;
  let bounceResponse: ReturnType<typeof deferred<{ success: boolean; error?: string }>> | null;
  let restoreResponse: ReturnType<typeof deferred<{ success: boolean; error?: string }>> | null;

  function post(id: string, text = `synthetic tweet ${id}`, threaded = false): HTMLElement {
    const cell = document.createElement('div');
    cell.dataset.cell = '';
    cell.dataset.testid = 'cellInnerDiv';
    cell.dataset.threaded = String(threaded);
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.dataset.url = `https://x.com/synthetic/status/${id}`;
    article.innerHTML = `<a href="${article.dataset.url}"><time>now</time></a><div data-text data-testid="tweetText">${text}</div><button data-share aria-label="Share post">Share</button>`;
    cell.appendChild(article);
    document.body.appendChild(cell);
    const rect = { bottom: 120, top: 100, left: 0, right: 500, width: 500, height: 20, x: 0, y: 100, toJSON: () => ({}) };
    cell.getBoundingClientRect = () => rect;
    article.getBoundingClientRect = () => rect;
    return article;
  }

  async function flush(): Promise<void> {
    for (let index = 0; index < 25; index++) await Promise.resolve();
  }

  function change(key: string, newValue: unknown): void {
    const oldValue = storage[key];
    storage[key] = newValue;
    storageListeners.forEach(listener => listener({ [key]: { oldValue, newValue } }));
  }

  async function start(): Promise<void> {
    await import('../../src/content/index.js');
    await flush();
    ui = await import('../../src/content/ui.js');
  }

  async function verdict(index: number, matches?: string[], cached = true): Promise<void> {
    evaluations[index].resolve({ shouldHide: true, reasoning: '| yes |', matches, category: matches?.join(', ') || 'legacy', cached });
    await flush();
  }

  async function openBounce(article: HTMLElement): Promise<void> {
    article.querySelector<HTMLElement>('.ff-why-annoying-btn')!.click();
    await flush();
  }

  function recycle(article: HTMLElement, id: string): void {
    article.dataset.url = `https://x.com/synthetic/status/${id}`;
    article.querySelector<HTMLAnchorElement>('a')!.href = article.dataset.url;
    article.querySelector('[data-text]')!.textContent = `synthetic replacement ${id}`;
  }

  function notifyRecycling(article: HTMLElement): void {
    const observer = mutationObservers.find(entry => entry.options?.attributeFilter?.includes('href'))!;
    observer.callback([{ target: article, addedNodes: [] } as unknown as MutationRecord], {} as MutationObserver);
  }

  function notifyMountedArticle(article: HTMLElement): void {
    const observer = mutationObservers.find(entry => entry.options?.attributeFilter?.includes('href'))!;
    observer.callback([{ target: adapter.getPostContainer(article), addedNodes: [article] } as unknown as MutationRecord], {} as MutationObserver);
  }

  async function useRealTwitterAdapter(storeContent?: PostContent): Promise<void> {
    const append = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation(node => node instanceof HTMLScriptElement ? node : append(node));
    await import('../../adapters/twitter/TwitterAdapter.js');
    const TwitterAdapter = window.BouncerAdapter;
    vi.spyOn(TwitterAdapter.prototype, 'shouldProcessCurrentPage').mockReturnValue(true);
    vi.spyOn(TwitterAdapter.prototype, 'isMainPost').mockReturnValue(false);
    vi.spyOn(TwitterAdapter.prototype, 'isPermalinkView').mockReturnValue(false);
    vi.spyOn(TwitterAdapter.prototype, 'extractPostContentFromStore').mockImplementation(async article => storeContent || adapter.extractPostContent(article));
    vi.spyOn(TwitterAdapter.prototype, 'hidePost');
    vi.stubGlobal('BouncerAdapter', class { constructor() { adapter = new TwitterAdapter(); return adapter; } });
  }

  function realXPost(id: string, time = '2h'): HTMLElement {
    const article = post(id, 'A formatted excerpt…');
    article.querySelector('[data-text]')!.innerHTML = 'A <a href="https://example.com/synthetic">formatted</a> excerpt…';
    const author = document.createElement('div');
    author.dataset.testid = 'User-Name';
    author.innerHTML = '<a role="link" href="/synthetic">Synthetic Ada</a><a role="link" href="/synthetic">@synthetic</a><span>·</span>';
    const timestamp = article.querySelector<HTMLAnchorElement>('a:has(time)')!;
    timestamp.querySelector('time')!.textContent = time;
    author.appendChild(timestamp);
    article.prepend(author);
    return article;
  }

  function canonicalXContent(id = '1'): PostContent {
    return {
      text: 'A formatted excerpt with the complete store-only continuation. [Quoted: Complete synthetic quote.]',
      author: 'Synthetic Ada', handle: '@synthetic', avatarUrl: null, timeText: null,
      textHtml: '', quote: null, postUrl: `https://x.com/synthetic/status/${id}`,
      imageUrls: [], hasMediaContainer: false, fromStore: true,
    };
  }

  function renderRestorePanel(): HTMLButtonElement {
    const panel = document.createElement('div');
    panel.className = 'filtered-modal-content';
    document.body.appendChild(panel);
    ui.renderFilteredPostsView(panel);
    return panel.querySelector<HTMLButtonElement>('.slop-restore')!;
  }

  function adoptFilteredCount(): HTMLElement {
    const count = document.createElement('span');
    count.className = 'filtered-toggle-count';
    count.textContent = '(0)';
    const filterBox = document.createElement('div');
    filterBox.className = 'filter-phrases-sidebar';
    filterBox.appendChild(count);
    document.body.appendChild(filterBox);
    ui.injectFilterPhrasesInput();
    return count;
  }

  function fillSnapshots(firstId: number, lastId: number, template: PostContent): void {
    for (let id = firstId; id <= lastId; id++) {
      const content = { ...template, text: `Synthetic snapshot ${id}`, postUrl: `https://x.com/synthetic/status/${id}` };
      ui.storeFilteredPost(document.createElement('article'), content, 'Synthetic matched rage', '', 'rage', ['rage']);
    }
  }

  async function prepareRestoreAtCapacity(id = 500) {
    const article = post(String(id));
    await start();
    const count = adoptFilteredCount();
    const content = adapter.extractPostContent(article);
    if (id === 500) fillSnapshots(1, 499, content);
    await verdict(0, ['rage']);
    if (id === 1) fillSnapshots(2, 500, content);
    renderRestorePanel();
    const button = document.querySelector<HTMLButtonElement>(`a[href="${content.postUrl}"] .slop-restore`)!;
    return { article, content, count, button };
  }

  function currentRestoreButton(content: PostContent): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(`a[href="${content.postUrl}"] .slop-restore`)!;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.replaceChildren();
    document.head.replaceChildren();
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    delete (window as Window & { __bouncerContentScriptLoaded?: boolean }).__bouncerContentScriptLoaded;
    permalink = false;
    suggestions = null;
    bounceResponse = null;
    restoreResponse = null;
    evaluations = [];
    storageListeners = [];
    messageListeners = [];
    mutationObservers = [];
    storage = { enabled: true, filterReplies: true, selectedModel: 'local:gemma-4-E2B-it-web', descriptions_twitter: ['rage'] };
    vi.stubGlobal('DOMPurify', DOMPurify);

    vi.stubGlobal('MutationObserver', class {
      entry: { callback: MutationCallback; options?: MutationObserverInit };
      constructor(callback: MutationCallback) {
        this.entry = { callback };
        mutationObservers.push(this.entry);
      }
      observe(_target: Node, options: MutationObserverInit) { this.entry.options = options; }
      disconnect() {}
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

    const extract = (article: HTMLElement): PostContent => ({
      text: article.querySelector('[data-text]')?.textContent || '', textHtml: '',
      author: 'Synthetic author', handle: '@synthetic', avatarUrl: null, timeText: null,
      quote: null, postUrl: article.dataset.url || null, imageUrls: [], hasMediaContainer: false,
    });
    adapter = {
      siteId: 'twitter',
      selectors: { post: 'article', textContent: '[data-text]', mutations: '[data-text]', sidebar: '.absent-sidebar', sidebarContent: '.absent-content', primaryColumn: '.absent-primary', nav: '.absent-nav', bottomBar: '.absent-bottom' },
      extractPostContent: extract,
      extractPostContentFromStore: async article => extract(article),
      getPostUrl: article => article.dataset.url || null,
      getPostContentKey: article => article.dataset.url || '',
      getPostContainer: article => article.closest<HTMLElement>('[data-cell]') || article,
      hidePost: vi.fn((article, includeThread = true) => {
        let cell: HTMLElement | null = adapter.getPostContainer(article);
        do {
          cell.dataset.filteredByExtension = 'true';
          cell.style.display = 'none';
          cell = cell.nextElementSibling as HTMLElement | null;
        } while (includeThread && cell?.dataset.threaded === 'true');
      }),
      restoreRecycledPost: vi.fn(() => false),
      getThemeMode: () => 'light',
      isMainPost: article => article.dataset.main === 'true',
      isPermalinkView: () => permalink,
      shouldProcessCurrentPage: () => true,
      cleanupFilteredPostHtml: () => {},
      getShareButton: article => article.querySelector('[data-share]'),
      insertActionButton: (article, button) => article.appendChild(button),
      getSearchForm: () => null,
    };
    vi.stubGlobal('BouncerAdapter', class { constructor() { return adapter; } });

    sendMessage = vi.fn(async (message: { type: string; evaluationId: string; post: string; phrase?: string }) => {
      if (message.type === 'evaluatePost') {
        const evaluation = deferred<PipelineResponse>();
        evaluations.push({ message, resolve: evaluation.resolve });
        return evaluation.promise;
      }
      if (message.type === 'suggestAnnoyingReasons') return suggestions?.promise || { reasons: ['rage', 'new phrase'] };
      if (message.type === 'bouncePost') {
        if (message.phrase && !(storage.descriptions_twitter as string[]).includes(message.phrase)) {
          change('descriptions_twitter', [...storage.descriptions_twitter as string[], message.phrase]);
        }
        return bounceResponse?.promise || { success: true };
      }
      if (message.type === 'overrideCacheEntry') return restoreResponse?.promise || { success: true };
      return { success: true };
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, getURL: (path: string) => path, onMessage: { addListener: (listener: typeof messageListeners[number]) => messageListeners.push(listener), removeListener: () => {} } },
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(key => [key, storage[key]]))),
          set: vi.fn(async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) change(key, value); }),
          remove: vi.fn(async () => {}),
        },
        onChanged: { addListener: (listener: typeof storageListeners[number]) => storageListeners.push(listener) },
      },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('submits a fresh evaluation for an unchanged queued article after SPA queue cancellation', async () => {
    const article = post('1');
    await start();
    const cancelled = evaluations[0];
    // clearTabQueue resolves pending work with null on receipt of loading.
    cancelled.resolve(null);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(evaluations).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluations).toHaveLength(2);
    expect(evaluations[1].message.post).toBe(cancelled.message.post);
    expect(evaluations[1].message.evaluationId).not.toBe(cancelled.message.evaluationId);
    evaluations[1].resolve({ shouldHide: false, reasoning: 'Fresh surviving document verdict' });
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(evaluations).toHaveLength(2);
    expect(adapter.getPostContainer(article).style.display).toBe('');
  });

  it.each(['manual Bounce', 'filter edit', 'disable', 'recycle', 'detach', 'reply filtering off'] as const)('does not retry a cancelled article after a newer %s takes ownership', async boundary => {
      const article = post('1');
      await start();
      evaluations[0].resolve(null);
      await flush();
      if (boundary === 'manual Bounce') await ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
      else if (boundary === 'filter edit') change('descriptions_twitter', ['replacement']);
      else if (boundary === 'disable') change('enabled', false);
      else if (boundary === 'recycle') recycle(article, '2');
      else if (boundary === 'detach') article.remove();
      else {
        permalink = true;
        change('filterReplies', false);
      }
      await flush();
      const freshBoundaryEvaluations = boundary === 'filter edit' ? 2 : 1;
      expect(evaluations).toHaveLength(freshBoundaryEvaluations);
      await vi.advanceTimersByTimeAsync(1000);
      expect(evaluations).toHaveLength(freshBoundaryEvaluations);
      if (boundary === 'manual Bounce') expect(adapter.getPostContainer(article).style.display).toBe('none');
    });

  it.each(['cancelled queue', 'retryable request'] as const)('keeps a %s retry within the adapter page scope', async outcome => {
    const article = post('1');
    await start();
    evaluations[0].resolve(outcome === 'cancelled queue'
      ? null : { retry: true, reasoning: 'Retired originating document', retryAfterMs: 1000 });
    await flush();
    const pageScope = vi.spyOn(adapter, 'shouldProcessCurrentPage').mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluations).toHaveLength(1);
    // Returning to an eligible route can process the same surviving article.
    pageScope.mockReturnValue(true);
    notifyMountedArticle(article);
    await flush();
    expect(evaluations).toHaveLength(2);
  });

  it('does not duplicate fresh observer work before a cancellation retry fires', async () => {
    const article = post('1');
    await start();
    evaluations[0].resolve(null);
    await flush();
    notifyMountedArticle(article);
    await flush();
    expect(evaluations).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluations).toHaveLength(2);
  });

  it('rechecks the adapter page scope after a cancellation retry waits for the store', async () => {
    const article = post('1');
    await start();
    evaluations[0].resolve(null);
    await flush();
    const storeLookup = deferred<PostContent | null>();
    const extract = vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(storeLookup.promise);
    await vi.advanceTimersByTimeAsync(1000);
    expect(extract).toHaveBeenCalledOnce();
    const pageScope = vi.spyOn(adapter, 'shouldProcessCurrentPage').mockReturnValue(false);
    storeLookup.resolve(adapter.extractPostContent(article));
    await flush();
    expect(evaluations).toHaveLength(1);
    pageScope.mockReturnValue(true);
    notifyMountedArticle(article);
    await flush();
    expect(evaluations).toHaveLength(2);
  });

  it('restores a sole-rule parent and collateral thread reply after panel eviction', async () => {
    const parent = post('1');
    const reply = post('2', 'synthetic reply', true);
    await start();
    await verdict(0, ['rage']);
    expect(adapter.getPostContainer(reply).style.display).toBe('none');
    ui.clearFilteredPosts();

    await ui.removeFilterPhrase('rage');
    await flush();

    expect(adapter.getPostContainer(parent).style.display).toBe('');
    expect(adapter.getPostContainer(reply).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it('retains the newest 500 snapshots without changing an evicted live hide or its rule-removal restoration', async () => {
    const original = post('1');
    await start();
    const count = adoptFilteredCount();
    await verdict(0, ['rage']);
    fillSnapshots(2, 500, adapter.extractPostContent(original));
    const panel = document.createElement('div');
    panel.className = 'filtered-modal-content';
    document.body.appendChild(panel);
    ui.renderFilteredPostsView(panel);
    expect(panel.querySelector('a[href="https://x.com/synthetic/status/1"]')).not.toBeNull();
    fillSnapshots(501, 502, adapter.extractPostContent(original));

    expect(ui.getFilteredPosts()).toHaveLength(500);
    expect(ui.getFilteredPosts().map(entry => entry.post.postUrl)).toEqual(
      Array.from({ length: 500 }, (_, index) => `https://x.com/synthetic/status/${index + 3}`),
    );
    expect(count.textContent).toBe('(500)');
    expect(panel.querySelectorAll('.slop-post-wrapper')).toHaveLength(500);
    expect(panel.querySelector('a[href="https://x.com/synthetic/status/1"]')).toBeNull();
    expect(panel.querySelector('a[href="https://x.com/synthetic/status/2"]')).toBeNull();
    expect(panel.querySelector('a[href="https://x.com/synthetic/status/502"]')).not.toBeNull();
    expect(adapter.getPostContainer(original).style.display).toBe('none');
    expect(adapter.getPostContainer(original).dataset.filteredByExtension).toBe('true');

    await ui.removeFilterPhrase('rage');
    await flush();
    expect(adapter.getPostContainer(original).style.display).toBe('');
    expect(adapter.getPostContainer(original).dataset.filteredByExtension).toBeUndefined();
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(count.textContent).toBe('(0)');
  });

  it('readmits evicted dedup keys while duplicates replace snapshots without growth or FIFO eviction', async () => {
    const original = post('1');
    await start();
    const count = adoptFilteredCount();
    await verdict(0, ['rage']);
    const content = adapter.extractPostContent(original);
    fillSnapshots(2, 501, content);
    const oldestSurvivor = ui.getFilteredPosts()[0];
    const duplicate = ui.getFilteredPosts()[298];
    ui.storeFilteredPost(document.createElement('article'), duplicate.post, 'Synthetic refreshed match', '', 'rage', ['rage']);

    expect(ui.getFilteredPosts()).toHaveLength(500);
    expect(ui.getFilteredPosts()[0]).toBe(oldestSurvivor);
    expect(ui.getFilteredPosts()[298]).not.toBe(duplicate);
    expect(ui.getFilteredPosts()[298].reasoning).toBe('Synthetic refreshed match');
    expect(count.textContent).toBe('(500)');

    ui.storeFilteredPost(original, content, 'Synthetic readmitted match', '', 'rage', ['rage']);
    expect(ui.getFilteredPosts()).toHaveLength(500);
    expect(ui.getFilteredPosts()[0].post.postUrl).toBe('https://x.com/synthetic/status/3');
    expect(ui.getFilteredPosts().at(-1)?.post.postUrl).toBe(content.postUrl);
    expect(ui.getFilteredPosts().filter(entry => entry.post.postUrl === content.postUrl)).toHaveLength(1);
    expect(count.textContent).toBe('(500)');
    expect(adapter.getPostContainer(original).style.display).toBe('none');

    ui.storeFilteredPost(original, content, 'Synthetic duplicate readmission', '', 'rage', ['rage']);
    expect(ui.getFilteredPosts()).toHaveLength(500);
    expect(ui.getFilteredPosts()[0].post.postUrl).toBe('https://x.com/synthetic/status/3');
    expect(ui.getFilteredPosts().at(-1)?.reasoning).toBe('Synthetic duplicate readmission');
  });

  it('restores an evicted live reply on toggle-off without disturbing retained historical snapshots', async () => {
    permalink = true;
    const reply = post('1');
    await start();
    const count = adoptFilteredCount();
    await verdict(0, ['rage']);
    fillSnapshots(2, 501, adapter.extractPostContent(reply));
    expect(ui.getFilteredPosts().some(entry => entry.post.postUrl?.endsWith('/1'))).toBe(false);

    change('filterReplies', false);
    await flush();
    expect(adapter.getPostContainer(reply).style.display).toBe('');
    expect(adapter.getPostContainer(reply).dataset.filteredByExtension).toBeUndefined();
    expect(ui.getFilteredPosts()).toHaveLength(500);
    expect(count.textContent).toBe('(500)');
  });

  it.each(['success', 'failure', 'rejection'])('keeps a retained Restore visibly pending through unrelated eviction and handles %s', async outcome => {
    const { article, content, count, button } = await prepareRestoreAtCapacity();
    restoreResponse = deferred();
    button.click();
    await flush();
    fillSnapshots(501, 501, content);
    const renderedButton = currentRestoreButton(content);

    expect(renderedButton).not.toBe(button);
    expect(button.isConnected).toBe(false);
    expect(renderedButton.disabled).toBe(true);
    expect(renderedButton.textContent).toBe('Restoring…');
    renderedButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'overrideCacheEntry')).toHaveLength(1);
    expect(adapter.getPostContainer(article).style.display).toBe('none');

    if (outcome === 'success') restoreResponse.resolve({ success: true });
    else {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      if (outcome === 'failure') restoreResponse.resolve({ success: false, error: 'Synthetic retained failure' });
      else restoreResponse.reject(new Error('Synthetic retained rejection'));
    }
    await flush();

    if (outcome !== 'success') {
      const retry = currentRestoreButton(content);
      expect(retry.disabled).toBe(false);
      expect(retry.textContent).toBe('Retry Restore');
      expect(retry.parentElement?.querySelector('[role="alert"]')?.textContent).toContain(`Restore failed: Synthetic retained ${outcome}`);
      expect(adapter.getPostContainer(article).style.display).toBe('none');
      expect(ui.getFilteredPosts()).toHaveLength(500);
      restoreResponse = deferred();
      retry.click();
      await flush();
      expect(retry.disabled).toBe(true);
      expect(retry.parentElement?.querySelector('[role="alert"]')?.textContent).toBe('');
      expect(sendMessage.mock.calls.filter(([message]) => message.type === 'overrideCacheEntry')).toHaveLength(2);
      restoreResponse.resolve({ success: true });
      await flush();
    }
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(499);
    expect(count.textContent).toBe('(499)');

    // Completion must not attach the previous operation/error to readmission.
    ui.storeFilteredPost(article, content, 'Synthetic readmitted history', '', 'rage', ['rage']);
    fillSnapshots(502, 502, content);
    expect(currentRestoreButton(content).disabled).toBe(false);
    expect(currentRestoreButton(content).textContent).toBe('Restore');
    expect(currentRestoreButton(content).parentElement?.querySelector('[role="alert"]')?.textContent).toBe('');
  });

  it('carries Restore ownership across an automatic duplicate snapshot refresh and eviction render', async () => {
    const { article, content, button } = await prepareRestoreAtCapacity();
    restoreResponse = deferred();
    button.click();
    await flush();
    ui.storeFilteredPost(article, content, 'Synthetic automatic refresh', '', 'rage', ['rage']);
    fillSnapshots(501, 501, content);
    expect(currentRestoreButton(content).disabled).toBe(true);
    expect(currentRestoreButton(content).textContent).toBe('Restoring…');
    currentRestoreButton(content).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'overrideCacheEntry')).toHaveLength(1);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success: false, error: 'Synthetic duplicate failure' });
    await flush();
    expect(currentRestoreButton(content).textContent).toBe('Retry Restore');
    expect(currentRestoreButton(content).parentElement?.querySelector('[role="alert"]')?.textContent).toContain('Synthetic duplicate failure');
    expect(adapter.getPostContainer(article).style.display).toBe('none');
  });

  it('lets a later Bounce and Restore own current controls when an older Restore completes after eviction', async () => {
    const { article, content, button } = await prepareRestoreAtCapacity();
    const oldRestore = deferred<{ success: boolean; error?: string }>();
    restoreResponse = oldRestore;
    button.click();
    await flush();
    await ui.bouncePost(article, content, 'new phrase');
    await vi.advanceTimersByTimeAsync(300);
    fillSnapshots(501, 501, content);
    expect(currentRestoreButton(content).disabled).toBe(false);
    expect(currentRestoreButton(content).textContent).toBe('Restore');
    expect(ui.getFilteredPosts().find(entry => entry.post.postUrl === content.postUrl)?.matches).toEqual(['new phrase']);

    restoreResponse = deferred();
    currentRestoreButton(content).click();
    await flush();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    oldRestore.reject(new Error('Synthetic superseded failure'));
    await flush();
    expect(currentRestoreButton(content).disabled).toBe(true);
    expect(currentRestoreButton(content).textContent).toBe('Restoring…');
    expect(currentRestoreButton(content).parentElement?.querySelector('[role="alert"]')?.textContent).toBe('');
    expect(adapter.getPostContainer(article).style.display).toBe('none');

    restoreResponse.resolve({ success: true });
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('');
  });

  it.each(['success', 'failure', 'rejection'])('drops an evicted row Restore association after %s without leaking it into readmission', async outcome => {
    const { article, content, button } = await prepareRestoreAtCapacity(1);
    restoreResponse = deferred();
    button.click();
    await flush();
    fillSnapshots(501, 501, content);
    expect(document.querySelector(`a[href="${content.postUrl}"] .slop-restore`)).toBeNull();
    expect(ui.getFilteredPosts().some(entry => entry.post.postUrl === content.postUrl)).toBe(false);

    if (outcome === 'success') restoreResponse.resolve({ success: true });
    else {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      if (outcome === 'failure') restoreResponse.resolve({ success: false, error: 'Synthetic evicted failure' });
      else restoreResponse.reject(new Error('Synthetic evicted rejection'));
    }
    await flush();
    expect(document.querySelector('.slop-restore-error')?.textContent).toBe('');
    expect(adapter.getPostContainer(article).style.display).toBe(outcome === 'success' ? '' : 'none');

    ui.storeFilteredPost(article, content, 'Synthetic readmitted evicted history', '', 'rage', ['rage']);
    expect(currentRestoreButton(content).disabled).toBe(false);
    expect(currentRestoreButton(content).textContent).toBe('Restore');
    expect(currentRestoreButton(content).parentElement?.querySelector('[role="alert"]')?.textContent).toBe('');
  });

  it('retains a surviving comma-containing exact match in the panel and detector popup', async () => {
    storage.descriptions_twitter = ['rage', 'spam, scams'];
    const article = post('1');
    await start();
    const id = evaluations[0].message.evaluationId;
    messageListeners.forEach(listener => listener({ type: 'detectorResponse', evaluationId: id, detectorName: 'Local', shouldHide: true, category: 'rage, spam, scams', matches: ['rage', 'spam, scams'], reasoning: '| yes | yes |' }, {}, () => {}));
    await verdict(0, ['rage', 'spam, scams']);
    ui.showReasoningPopup(article, 0, 0);

    change('descriptions_twitter', ['spam, scams']);
    await flush();
    const panel = document.createElement('div');
    ui.renderFilteredPostsView(panel);

    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].matches).toEqual(['spam, scams']);
    expect(Array.from(panel.querySelectorAll('.slop-category-tag'), tag => tag.textContent)).toEqual(['SPAM, SCAMS']);
    expect(panel.querySelector('.slop-post-reasoning')?.textContent).toBe('Matched: spam, scams');
    expect(Array.from(document.querySelectorAll('.reasoning-match-chip'), chip => chip.textContent)).toEqual(['spam, scams']);
  });

  it.each([true, false])('restores and evaluates equal-length rule replacements with complete matches: %s', async complete => {
    const article = post('1');
    await start();
    await verdict(0, complete ? ['rage'] : undefined);
    change('descriptions_twitter', ['replacement']);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(evaluations.length).toBe(2);
  });

  it('preserves a cached explicit hide across rule changes and the automatic share-code exemption', async () => {
    const article = post('1', 'Synthetic filter pack bncr2_example');
    const nextReply = post('2', 'Synthetic threaded reply', true);
    await start();
    evaluations[0].resolve({ shouldHide: true, reasoning: 'User blocked', userOverride: true, cached: true });
    await flush();
    change('descriptions_twitter', ['replacement']);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(adapter.getPostContainer(nextReply).style.display).toBe('');
    expect(ui.getFilteredPosts()[0].userOverride).toBe(true);
  });

  it('rejects a late evaluation and late detector event after the article identity changes', async () => {
    const article = post('1');
    await start();
    const id = evaluations[0].message.evaluationId;
    recycle(article, '2');
    await verdict(0, ['rage']);
    messageListeners.forEach(listener => listener({ type: 'detectorResponse', evaluationId: id, detectorName: 'Local', shouldHide: true, matches: ['rage'], category: 'rage' }, {}, () => {}));
    ui.showReasoningPopup(article, 0, 0);
    expect(adapter.hidePost).not.toHaveBeenCalled();
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(document.querySelector('.reasoning-match-chip')).toBeNull();
  });

  it('vetoes a fade after recycling even before the observer runs', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage'], false);
    expect(article.style.opacity).toBe('0');
    recycle(article, '2');
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.hidePost).not.toHaveBeenCalled();
    expect(article.style.opacity).toBe('');
  });

  it.each(['combined', 'separate'])('does not finish a pending automatic hide across a %s disable/rule-change boundary', async boundary => {
    storage.descriptions_twitter = ['rage', 'spam'];
    const pendingArticle = post('1');
    const hiddenArticle = post('2');
    await start();
    await verdict(0, ['rage', 'spam'], false);
    await verdict(1, ['rage']);

    if (boundary === 'combined') {
      storage.enabled = false;
      storage.descriptions_twitter = ['rage'];
      storageListeners.forEach(listener => listener({
        enabled: { oldValue: true, newValue: false },
        descriptions_twitter: { oldValue: ['rage', 'spam'], newValue: ['rage'] },
      }));
    } else {
      change('enabled', false);
      change('descriptions_twitter', ['rage']);
    }
    await vi.advanceTimersByTimeAsync(300);

    expect(adapter.getPostContainer(pendingArticle).style.display).toBe('');
    expect(pendingArticle.style.opacity).toBe('');
    expect(adapter.getPostContainer(hiddenArticle).style.display).toBe('none');
    expect(adapter.hidePost).toHaveBeenCalledTimes(1);
    expect(evaluations).toHaveLength(2);

    change('enabled', true);
    await flush();
    expect(evaluations).toHaveLength(3);
    expect(evaluations[2].message.post).toContain('synthetic tweet 1');
  });

  it('detects recycling inside an already-hidden container and releases its old snapshot', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    recycle(article, '2');
    notifyRecycling(article);
    await vi.advanceTimersByTimeAsync(50);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(evaluations[1].message.post).toContain('synthetic replacement 2');
  });

  it('restores a hidden real X cell immediately when its entire article node is replaced', async () => {
    await useRealTwitterAdapter();
    const original = post('1');
    await start();
    await verdict(0, ['rage']);
    const cell = adapter.getPostContainer(original);
    expect(cell.style.display).toBe('none');

    const replacement = post('2');
    const temporaryCell = replacement.parentElement!;
    cell.replaceChildren(replacement);
    temporaryCell.remove();
    notifyMountedArticle(replacement);
    await flush();

    expect(cell.style.display).toBe('');
    expect(cell.dataset.filteredByExtension).toBeUndefined();
    evaluations[1].resolve({ shouldHide: false, reasoning: 'Fresh synthetic KEEP' });
    await flush();
    expect(cell.style.display).toBe('');
    expect(ui.getFilteredPosts().some(entry => entry.post.postUrl?.endsWith('/2'))).toBe(false);
  });

  it('preserves unchanged real X collateral-thread ownership during content processing', async () => {
    await useRealTwitterAdapter();
    const parent = post('1');
    const reply = post('2');
    const threadColumn = document.createElement('div');
    threadColumn.innerHTML = '<div><div><span></span><span></span></div></div>';
    reply.querySelector('[data-text]')!.appendChild(threadColumn);
    await start();
    await verdict(0, ['rage']);
    expect(adapter.getPostContainer(parent).style.display).toBe('none');
    expect(adapter.getPostContainer(reply).style.display).toBe('none');
    notifyMountedArticle(reply);
    evaluations[1].resolve({ shouldHide: false, reasoning: 'Synthetic reply KEEP' });
    await flush();
    expect(adapter.getPostContainer(reply).style.display).toBe('none');
  });

  it('delegates manual above-viewport hides to the real adapter so scroll return finishes the chosen cell', async () => {
    await useRealTwitterAdapter();
    const article = post('1');
    const nextReply = post('2', 'Synthetic next reply', true);
    const cell = article.parentElement!;
    let top = -200;
    cell.getBoundingClientRect = () => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: top, toJSON: () => ({}) });
    await start();
    await ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.hidePost).toHaveBeenCalledWith(article, false);
    expect(cell.dataset.filteredByExtension).toBe('true');
    expect(cell.style.display).toBe('');

    top = 120;
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(300);
    expect(cell.style.display).toBe('none');
    expect(adapter.getPostContainer(nextReply).style.display).toBe('');
  });

  it.each(['response', 'transport'])('keeps the hidden post/panel and displays a truthful Restore %s failure', async failure => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    const before = ui.getFilteredPosts()[0];
    restoreResponse = deferred();
    const button = renderRestorePanel();
    button.click();
    await flush();
    expect(button.textContent).toBe('Restoring…');
    expect(button.disabled).toBe(true);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0]).toBe(before);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    if (failure === 'response') restoreResponse.resolve({ success: false, error: 'Synthetic durable write failure' });
    else restoreResponse.reject(new Error('Synthetic transport failure'));
    await flush();

    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0]).toBe(before);
    expect(ui.getFilteredPosts()[0].userOverride).not.toBe(true);
    expect(button.textContent).toBe('Retry Restore');
    expect(button.disabled).toBe(false);
    expect(document.querySelector('.slop-restore-error')?.textContent).toContain('Restore failed: Synthetic');
  });

  it.each(['recycled', 'replaced'])('does not restore a newer chosen hide on a %s article during the durable Restore wait', async mode => {
    await useRealTwitterAdapter();
    const original = post('1');
    await start();
    await verdict(0, ['rage']);
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();

    let replacement = original;
    if (mode === 'recycled') recycle(original, '2');
    else {
      replacement = post('2');
      const temporaryCell = replacement.parentElement!;
      adapter.getPostContainer(original).replaceChildren(replacement);
      temporaryCell.remove();
    }
    notifyMountedArticle(replacement);
    await flush();
    await ui.bouncePost(replacement, adapter.extractPostContent(replacement), 'rage');
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(replacement).style.display).toBe('none');

    restoreResponse.resolve({ success: true });
    await flush();
    expect(adapter.getPostContainer(replacement).style.display).toBe('none');
    expect(ui.getFilteredPosts()).toHaveLength(1);
    expect(ui.getFilteredPosts()[0].post.postUrl).toContain('/2');
    expect(ui.getFilteredPosts()[0].userOverride).toBe(true);
  });

  it('lets a later explicit Bounce of the same post supersede a pending Restore', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    await ui.bouncePost(article, adapter.extractPostContent(article), 'new phrase');
    await vi.advanceTimersByTimeAsync(300);
    restoreResponse.resolve({ success: true });
    await flush();

    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()).toHaveLength(1);
    expect(ui.getFilteredPosts()[0].matches).toEqual(['new phrase']);
    expect(ui.getFilteredPosts()[0].userOverride).toBe(true);
  });

  it('applies a successful Restore only after durable success and vetoes the older automatic evaluation', async () => {
    const article = post('1');
    await start();
    await ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await vi.advanceTimersByTimeAsync(300);
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    restoreResponse.resolve({ success: true });
    await flush();
    await verdict(0, ['rage']);

    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it('uses the full canonical X input for Bounce and Restore while retaining the DOM display snapshot', async () => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    const display = adapter.extractPostContent(article);
    expect(display.author).toBe('Synthetic Ada@synthetic·2h');
    expect(display.text).toBe('A formatted excerpt…');
    expect(evaluations[0].message.post).toBe(`Synthetic Ada: ${canonical.text}`);

    await ui.bouncePost(article, display, 'rage');
    await vi.advanceTimersByTimeAsync(300);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bouncePost', post: evaluations[0].message.post }));
    expect(ui.getFilteredPosts()[0].post).toBe(display);
    expect(ui.getFilteredPosts()[0].evaluationText).toBe(evaluations[0].message.post);
    expect(ui.getFilteredPosts()[0].post.textHtml).toContain('href="https://example.com/synthetic"');

    renderRestorePanel().click();
    await flush();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'overrideCacheEntry', post: evaluations[0].message.post, shouldHide: false }));
    expect(adapter.getPostContainer(article).style.display).toBe('');
  });

  it('reads the same durable manual hide and restore after page reloads with changed X timestamps and no native service', async () => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const cache = new Map<string, EvaluationResult>();
    let uncachedEvaluations = 0;
    sendMessage.mockImplementation(async (message: { type: string; post: string; phrase?: string }) => {
      const key = generateCacheKey(message.post || '');
      if (message.type === 'evaluatePost') {
        const result = cache.get(key);
        if (result) return { ...result, cached: true };
        uncachedEvaluations++;
        return { retry: true, reasoning: 'Synthetic local service is unavailable.' };
      }
      if (message.type === 'bouncePost' || message.type === 'overrideCacheEntry') {
        cache.set(key, {
          shouldHide: message.type === 'bouncePost', reasoning: 'Synthetic persisted manual decision',
          userOverride: true, matches: message.phrase ? [message.phrase] : undefined,
        });
      }
      return { success: true };
    });
    const article = realXPost('1');
    await start();
    await ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');

    const reload = async (time: string) => {
      vi.clearAllTimers();
      vi.resetModules();
      document.body.replaceChildren();
      storageListeners = [];
      messageListeners = [];
      mutationObservers = [];
      delete (window as Window & { __bouncerContentScriptLoaded?: boolean }).__bouncerContentScriptLoaded;
      const reloadedArticle = realXPost('1', time);
      await start();
      return reloadedArticle;
    };

    const hiddenReload = await reload('1d');
    expect(adapter.getPostContainer(hiddenReload).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].userOverride).toBe(true);
    renderRestorePanel().click();
    await flush();
    expect(adapter.getPostContainer(hiddenReload).style.display).toBe('');
    const restoredReload = await reload('2d');
    expect(adapter.getPostContainer(restoredReload).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(cache.size).toBe(1);
    expect(uncachedEvaluations).toBe(1);
  });

  it('replaces a duplicate URL snapshot key with the canonical manual input', async () => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    const display = adapter.extractPostContent(article);
    ui.storeFilteredPost(article, display, 'Synthetic legacy snapshot', '', 'rage', ['rage']);
    expect(ui.getFilteredPosts()[0].evaluationText).toBe('Synthetic Ada@synthetic·2h: A formatted excerpt…');

    await ui.bouncePost(article, display, 'rage');
    expect(ui.getFilteredPosts()).toHaveLength(1);
    expect(ui.getFilteredPosts()[0].evaluationText).toBe(`Synthetic Ada: ${canonical.text}`);
    renderRestorePanel().click();
    await flush();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'overrideCacheEntry', post: `Synthetic Ada: ${canonical.text}` }));
  });

  it('lets Restore preempt an older canonical Bounce lookup without persisting or republishing its hide', async () => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    await verdict(0, ['rage']);
    const lookup = deferred<PostContent | null>();
    vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    const action = ui.bouncePost(article, adapter.extractPostContent(article), 'new phrase');
    renderRestorePanel().click();
    await flush();
    lookup.resolve(canonical);
    await expect(action).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(300);

    expect(sendMessage.mock.calls.some(([message]) => message.type === 'bouncePost')).toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it.each([true, false])('gives a pending Restore ownership before an older canonical Bounce lookup resolves (success=%s)', async success => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    await verdict(0, ['rage']);
    const lookup = deferred<PostContent | null>();
    vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    const oldAction = ui.bouncePost(article, adapter.extractPostContent(article), 'new phrase');
    restoreResponse = deferred();
    const button = renderRestorePanel();
    button.click();
    await flush();
    lookup.resolve(canonical);
    await expect(oldAction).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'bouncePost')).toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(button.textContent).toBe('Restoring…');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success, error: success ? undefined : 'Synthetic Restore failure' });
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe(success ? '' : 'none');
    expect(ui.getFilteredPosts()).toHaveLength(success ? 0 : 1);
    if (!success) {
      expect(button.textContent).toBe('Retry Restore');
      change('descriptions_twitter', []);
      await flush();
      expect(adapter.getPostContainer(article).style.display).toBe('');
    }
  });

  it('keeps a newer Bounce after an older Restore reservation fails', async () => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    await verdict(0, ['rage']);
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    await ui.bouncePost(article, adapter.extractPostContent(article), 'new phrase');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success: false, error: 'Synthetic older Restore failure' });
    await flush();
    await vi.advanceTimersByTimeAsync(300);

    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].matches).toEqual(['new phrase']);
    expect(ui.getFilteredPosts()[0].userOverride).toBe(true);
    change('descriptions_twitter', []);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('none');
  });

  it('preserves an automatic hide when Restore fails before an older Bounce fade timer runs', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    const lookup = deferred<PostContent | null>();
    const canonical = adapter.extractPostContent(article);
    vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    const action = ui.bouncePost(article, canonical, 'new phrase');
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    lookup.resolve(canonical);
    await expect(action).resolves.toBe(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success: false, error: 'Synthetic Restore failure before fade' });
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    await vi.advanceTimersByTimeAsync(300);

    expect(sendMessage.mock.calls.some(([message]) => message.type === 'bouncePost')).toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()).toHaveLength(1);
    change('descriptions_twitter', []);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('');
  });

  it('does not reinstate an automatic hide when its rule is removed before Restore fails', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    change('descriptions_twitter', []);
    await flush();
    expect(ui.getFilteredPosts()).toHaveLength(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success: false, error: 'Synthetic Restore failure after rule removal' });
    await flush();
    await vi.advanceTimersByTimeAsync(300);

    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it('rechecks a retained failed Restore outcome after rules change during a later reservation', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    const firstRestore = deferred<{ success: boolean; error?: string }>();
    restoreResponse = firstRestore;
    const button = renderRestorePanel();
    button.click();
    await flush();
    const lookup = deferred<PostContent | null>();
    const canonical = adapter.extractPostContent(article);
    vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    const action = ui.bouncePost(article, canonical, 'new phrase');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    firstRestore.resolve({ success: false, error: 'Synthetic first Restore failure' });
    await flush();
    restoreResponse = deferred();
    button.click();
    await flush();
    change('descriptions_twitter', []);
    await flush();
    restoreResponse.resolve({ success: false, error: 'Synthetic retry Restore failure after rule removal' });
    await flush();
    lookup.resolve(canonical);
    await expect(action).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(300);

    expect(sendMessage.mock.calls.some(([message]) => message.type === 'bouncePost')).toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it('retains only surviving automatic matches when a pending Restore fails', async () => {
    storage.descriptions_twitter = ['rage', 'keep'];
    const article = post('1');
    await start();
    await verdict(0, ['rage', 'keep']);
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    change('descriptions_twitter', ['keep']);
    await flush();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success: false, error: 'Synthetic Restore failure with surviving rule' });
    await flush();

    const { currentPostDecision } = await import('../../src/content/filter-actions.js');
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(currentPostDecision(adapter, article)?.matches).toEqual(['keep']);
    expect(currentPostDecision(adapter, article)?.userOverride).not.toBe(true);
    expect(ui.getFilteredPosts()[0].matches).toEqual(['keep']);
    expect(evaluations).toHaveLength(1);
  });

  it('re-evaluates replacement rules after a failed Restore releases its invalid automatic predecessor', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    change('descriptions_twitter', ['new phrase']);
    await flush();
    expect(evaluations).toHaveLength(1);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success: false, error: 'Synthetic Restore failure after replacement' });
    await flush();

    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(evaluations).toHaveLength(2);
    await verdict(1, ['new phrase']);
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].matches).toEqual(['new phrase']);
  });

  it('preserves a committed manual hide when its phrase is removed before Restore fails', async () => {
    const article = post('1');
    await start();
    await ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await vi.advanceTimersByTimeAsync(300);
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    change('descriptions_twitter', []);
    await flush();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success: false, error: 'Synthetic Restore failure after manual phrase removal' });
    await flush();

    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].userOverride).toBe(true);
  });

  it('unwinds failed Restore reservations across a canceled Bounce back to the automatic hide', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    const firstRestore = deferred<{ success: boolean; error?: string }>();
    restoreResponse = firstRestore;
    const button = renderRestorePanel();
    button.click();
    await flush();
    const lookup = deferred<PostContent | null>();
    const canonical = adapter.extractPostContent(article);
    vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    const action = ui.bouncePost(article, canonical, 'new phrase');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    firstRestore.resolve({ success: false, error: 'Synthetic first Restore failure' });
    await flush();
    expect(button.textContent).toBe('Retry Restore');
    restoreResponse = deferred();
    button.click();
    await flush();
    restoreResponse.resolve({ success: false, error: 'Synthetic retry Restore failure' });
    await flush();
    lookup.resolve(canonical);
    await expect(action).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(300);

    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'overrideCacheEntry')).toHaveLength(2);
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'bouncePost')).toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()).toHaveLength(1);
    change('descriptions_twitter', []);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it.each([true, false])('rolls a failed Restore back to the actual older Bounce write outcome (success=%s)', async success => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    bounceResponse = deferred();
    const action = ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await flush();
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Even if the Restore failure arrives first, its rollback must settle the
    // earlier write rather than restore an uncommitted provisional decision.
    restoreResponse.resolve({ success: false, error: 'Synthetic Restore failure' });
    await flush();
    bounceResponse.resolve({ success, error: success ? undefined : 'Synthetic Bounce failure' });
    await expect(action).resolves.toBe(false);
    await flush();

    expect(adapter.getPostContainer(article).style.display).toBe(success ? 'none' : '');
    expect(ui.getFilteredPosts()).toHaveLength(success ? 1 : 0);
    change('descriptions_twitter', []);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe(success ? 'none' : '');
  });

  it('does not roll an older failed Restore over a new Bounce while it waits for previous persistence', async () => {
    const article = post('1');
    await start();
    const olderWrite = deferred<{ success: boolean; error?: string }>();
    bounceResponse = olderWrite;
    const olderAction = ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await flush();
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success: false, error: 'Synthetic Restore failure' });
    await flush();
    bounceResponse = null;
    await ui.bouncePost(article, adapter.extractPostContent(article), 'new phrase');
    olderWrite.resolve({ success: false, error: 'Synthetic older Bounce failure' });
    await expect(olderAction).resolves.toBe(false);
    await flush();
    await vi.advanceTimersByTimeAsync(300);

    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].matches).toEqual(['new phrase']);
    expect(ui.getFilteredPosts()[0].userOverride).toBe(true);
  });

  it('rolls back a failed canonical Bounce after a later Restore also fails', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    const lookup = deferred<PostContent | null>();
    vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    const action = ui.bouncePost(article, adapter.extractPostContent(article), 'new phrase');
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    lookup.reject(new Error('Synthetic canonical extraction failure'));
    await expect(action).resolves.toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    restoreResponse.resolve({ success: false, error: 'Synthetic Restore failure' });
    await flush();

    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'bouncePost')).toBe(false);
  });

  it.each(['new Bounce', 'recycled post'])('discards an older canonical Bounce lookup after a %s takes ownership', async replacement => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    const lookup = deferred<PostContent | null>();
    vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    const oldAction = ui.bouncePost(article, adapter.extractPostContent(article), 'old phrase');
    if (replacement === 'recycled post') {
      recycle(article, '2');
      vi.spyOn(adapter, 'extractPostContentFromStore').mockResolvedValue(canonicalXContent('2'));
    }
    await ui.bouncePost(article, adapter.extractPostContent(article), 'new phrase');
    lookup.resolve(canonical);
    await expect(oldAction).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(300);

    const bounces = sendMessage.mock.calls.filter(([message]) => message.type === 'bouncePost');
    expect(bounces).toHaveLength(1);
    expect(bounces[0][0].phrase).toBe('new phrase');
    expect(ui.getFilteredPosts()).toHaveLength(1);
    expect(ui.getFilteredPosts()[0].matches).toEqual(['new phrase']);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
  });

  it('does not publish an older successful Bounce after Restore owns the same post', async () => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    bounceResponse = deferred();
    const action = ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await flush();
    renderRestorePanel().click();
    await flush();
    bounceResponse.resolve({ success: true });
    await expect(action).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(300);

    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it.each(['missing', 'rejected'])('rolls back the immediate manual fade when canonical extraction is %s', async failure => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    const lookup = deferred<PostContent | null>();
    vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const action = ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    expect(article.style.opacity).toBe('0');
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    if (failure === 'missing') lookup.resolve(null);
    else lookup.reject(new Error('Synthetic store bridge error'));
    await expect(action).resolves.toBe(false);

    expect(sendMessage.mock.calls.some(([message]) => message.type === 'bouncePost')).toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it('restores a canonical manual snapshot without a post URL using its live article association', async () => {
    const article = post('1');
    delete article.dataset.url;
    const canonical = { ...canonicalXContent(), postUrl: null };
    vi.spyOn(adapter, 'extractPostContentFromStore').mockResolvedValue(canonical);
    await start();
    await ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await vi.advanceTimersByTimeAsync(300);
    renderRestorePanel().click();
    await flush();

    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'overrideCacheEntry', post: `Synthetic Ada: ${canonical.text}` }));
  });

  it('looks up reasoning by the canonical X author and complete store text', async () => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async message => message.type === 'getReasoning'
      ? { found: true, shouldHide: false, reasoning: 'Synthetic cached KEEP' }
      : original(message));
    article.dispatchEvent(new MouseEvent('contextmenu', { ctrlKey: true }));
    await flush();

    const lookups = sendMessage.mock.calls.filter(([message]) => message.type === 'getReasoning');
    expect(lookups).toHaveLength(1);
    expect(lookups[0][0].post).toBe(evaluations[0].message.post);
    expect(document.querySelector('.post-filter-reasoning-popup')?.textContent).toContain('KEPT');
  });

  it.each(['extraction', 'response'])('keeps a later Bounce in charge when a reasoning %s is delayed', async stage => {
    const canonical = canonicalXContent();
    await useRealTwitterAdapter(canonical);
    const article = realXPost('1');
    await start();
    const lookup = deferred<PostContent | null>();
    const response = deferred<{ found: boolean; shouldHide: boolean; reasoning: string }>();
    if (stage === 'extraction') vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async message => message.type === 'getReasoning' ? response.promise : original(message));
    article.dispatchEvent(new MouseEvent('contextmenu', { ctrlKey: true }));
    await flush();
    await ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    if (stage === 'extraction') lookup.resolve(canonical);
    else response.resolve({ found: true, shouldHide: false, reasoning: 'Synthetic stale KEEP' });
    await flush();
    await vi.advanceTimersByTimeAsync(300);

    if (stage === 'extraction') expect(sendMessage.mock.calls.some(([message]) => message.type === 'getReasoning')).toBe(false);
    expect(document.querySelector('.post-filter-reasoning-popup')?.textContent).toContain('HIDDEN');
    expect(adapter.getPostContainer(article).style.display).toBe('none');
  });

  it('re-evaluates once through the storage listener when the filter-input path adds a phrase', async () => {
    post('1');
    await start();
    evaluations[0].resolve({ shouldHide: false, reasoning: 'Synthetic KEEP' });
    await flush();
    await ui.addFilterPhrase('new phrase');
    await flush();
    expect(evaluations).toHaveLength(2);
  });

  it.each(['rage', 'new phrase'])('bounces an existing/new suggested chip atomically despite an older automatic keep: %s', async phrase => {
    const article = post('1');
    await start();
    bounceResponse = deferred();
    await openBounce(article);
    Array.from(document.querySelectorAll<HTMLButtonElement>('.ff-annoying-chip')).find(chip => chip.textContent === phrase)!.click();
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'bouncePost')).toBe(false);
    document.querySelector<HTMLButtonElement>('.ff-annoying-bounce')!.click();
    await flush();
    evaluations[0].resolve({ shouldHide: false, reasoning: 'old automatic keep' });
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].userOverride).toBe(true);
    expect(ui.getFilteredPosts()[0].matches).toEqual([phrase]);
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'bouncePost')).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bouncePost', phrase, siteId: 'twitter' }));
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'overrideCacheEntry')).toBe(false);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    bounceResponse.resolve({ success: true });
    await flush();
  });

  it.each(['custom', 'without phrase', 'pending suggestions'])('uses the same atomic chosen-post action for %s', async action => {
    const article = post('1');
    await start();
    if (action === 'pending suggestions') suggestions = deferred();
    await openBounce(article);
    if (action === 'custom') {
      const input = document.querySelector<HTMLInputElement>('.ff-annoying-custom-input')!;
      input.value = 'rage';
    }
    document.querySelector<HTMLButtonElement>('.ff-annoying-bounce')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bouncePost', phrase: action === 'custom' ? 'rage' : undefined }));
  });

  it('offers explicit Bounce with reply filtering already off and hides only the selected reply', async () => {
    permalink = true;
    storage.filterReplies = false;
    const reply = post('1');
    const nextReply = post('2', 'synthetic next reply', true);
    await start();
    expect(evaluations).toHaveLength(0);
    await openBounce(reply);
    document.querySelector<HTMLElement>('.ff-annoying-chip')!.click();
    document.querySelector<HTMLButtonElement>('.ff-annoying-bounce')!.click();
    await vi.advanceTimersByTimeAsync(300);
    notifyRecycling(reply);
    await vi.advanceTimersByTimeAsync(50);
    expect(adapter.getPostContainer(reply).style.display).toBe('none');
    expect(adapter.getPostContainer(nextReply).style.display).toBe('');
    expect(adapter.hidePost).toHaveBeenCalledWith(reply, false);
  });

  it.each(['inference', 'automatic fade', 'manual fade'])('turning reply filtering off cancels %s and removes panel entries/counts', async stage => {
    permalink = true;
    const reply = post('1');
    const count = document.createElement('span');
    count.className = 'filtered-toggle-count';
    count.textContent = '(0)';
    await start();
    const filterBox = document.createElement('div');
    filterBox.className = 'filter-phrases-sidebar';
    filterBox.appendChild(count);
    document.body.appendChild(filterBox);
    ui.injectFilterPhrasesInput();
    if (stage === 'automatic fade') await verdict(0, ['rage'], false);
    if (stage === 'manual fade') await ui.bouncePost(reply, adapter.extractPostContent(reply), 'rage');
    change('filterReplies', false);
    if (stage === 'inference') await verdict(0, ['rage']);
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(reply).style.display).toBe('');
    expect(reply.style.opacity).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(count.textContent).toBe('(0)');
    expect(adapter.hidePost).not.toHaveBeenCalled();
  });

  it('restores a provisional hide when the atomic durable action fails', async () => {
    const article = post('1');
    await start();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    bounceResponse = deferred();
    const action = ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await vi.advanceTimersByTimeAsync(300);
    bounceResponse.resolve({ success: false, error: 'synthetic storage failure' });
    await expect(action).resolves.toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(error).toHaveBeenCalled();
  });
});
