/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DOMPurify from 'dompurify';
import type { BackgroundToContentMessage, EvaluationResult, PipelineResponse, PlatformAdapter, PostContent } from '../../src/types.js';
import { generateCacheKey } from '../../src/shared/utils.js';
import { FILTER_LABEL_GUIDANCE } from '../../src/shared/filter-guidance.js';
import { DECISION_MODEL, MAX_ACTIVE_FILTERS, MAX_FILTERS_WARNING } from '../../src/shared/decision-model.js';

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
  let storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName?: string) => void>;
  let messageListeners: Array<(message: BackgroundToContentMessage, sender: object, respond: () => void) => void>;
  let evaluations: Array<{ message: { evaluationId: string; post: string }; resolve: (value: PipelineResponse) => void }>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let permalink: boolean;
  let mutationObservers: Array<{ callback: MutationCallback; options?: MutationObserverInit }>;
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
    storageListeners.forEach(listener => listener({ [key]: { oldValue, newValue } }, 'local'));
  }

  async function start(): Promise<void> {
    await import('../../src/content/index.js');
    await flush();
    ui = await import('../../src/content/ui.js');
  }

  async function verdict(index: number, matches: string[], cached = true): Promise<void> {
    evaluations[index].resolve({ shouldHide: true, reasoning: '| yes |', matches, category: matches.join(', '), cached });
    await flush();
  }

  async function openBounce(article: HTMLElement): Promise<void> {
    article.querySelector<HTMLElement>('.ff-bounce-button')!.click();
    await flush();
  }

  async function startReady(): Promise<void> {
    storage.nativeModelStatus = { state: 'ready', message: '', revision: 90 };
    await start();
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
      text: 'A formatted excerpt with the complete store-only continuation.',
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
    bounceResponse = null;
    restoreResponse = null;
    evaluations = [];
    storageListeners = [];
    messageListeners = [];
    mutationObservers = [];
    storage = { enabled: true, filterReplies: true, nativeModelStatus: { state: 'ready', message: '', revision: 1 }, descriptions_twitter: ['rage'] };
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
      hidePost: vi.fn((article, includeThread = true, keepVisible?: (article: HTMLElement) => boolean) => {
        let cell: HTMLElement | null = adapter.getPostContainer(article);
        do {
          const reply = cell.querySelector<HTMLElement>('article');
          if (cell === adapter.getPostContainer(article) || !reply || !keepVisible?.(reply)) {
            cell.dataset.filteredByExtension = 'true';
            cell.style.display = 'none';
          }
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

    sendMessage = vi.fn(async (message: { type: string; evaluationId: string; post: string; phrase?: string; strict?: boolean }) => {
      if (message.type === 'evaluatePost') {
        const evaluation = deferred<PipelineResponse>();
        evaluations.push({ message, resolve: evaluation.resolve });
        return evaluation.promise;
      }
      if (message.type === 'bouncePost') {
        if (message.phrase && !(storage.descriptions_twitter as string[]).includes(message.phrase)) {
          change('descriptions_twitter', [...storage.descriptions_twitter as string[], message.phrase]);
        }
        return bounceResponse?.promise || { success: true };
      }
      if (message.type === 'setFilterStrictness') {
        const strict = new Set(storage.strictFilters_twitter as string[] | undefined);
        if (message.strict) strict.add(message.phrase!); else strict.delete(message.phrase!);
        change('strictFilters_twitter', [...strict]);
        return { success: true };
      }
      if (message.type === 'addFilterPhrase' || message.type === 'removeFilterPhrase') {
        const descriptions = storage.descriptions_twitter as string[];
        const added = message.type === 'addFilterPhrase' && !descriptions.includes(message.phrase!);
        const updated = message.type === 'removeFilterPhrase'
          ? descriptions.filter(phrase => phrase !== message.phrase)
          : added ? [...descriptions, message.phrase!] : descriptions;
        const strict = (storage.strictFilters_twitter as string[] | undefined ?? []).filter(phrase => updated.includes(phrase));
        change('descriptions_twitter', updated);
        change('strictFilters_twitter', strict);
        return { success: true, added };
      }
      if (message.type === 'overrideCacheEntry') return restoreResponse?.promise || { success: true };
      return { success: true };
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, getManifest: () => ({ version: '2.0.0' }), getURL: (path: string) => path, onMessage: { addListener: (listener: typeof messageListeners[number]) => messageListeners.push(listener), removeListener: () => {} } },
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

  describe('strictness verification regressions', () => {
    async function score(index: number, scores: Array<{ label: string; score: number }>, matches: string[]) {
      evaluations[index].resolve({ shouldHide: matches.length > 0, reasoning: 'Synthetic scored decision',
        matches, category: matches.join(', ') || null, scores, textSent: 'A synthetic post with several words.', cached: true });
      await flush();
    }

    it.each([
      { initialStrict: false, parentScore: 0.9 },
      { initialStrict: true, parentScore: 0.5 },
    ])('preserves a manually restored thread reply when rejudging its parent (initialStrict=$initialStrict)', async ({ initialStrict, parentScore }) => {
      storage.strictFilters_twitter = initialStrict ? ['rage'] : [];
      const parent = post('1');
      const reply = post('2', 'A synthetic reply with several words.', true);
      await start();
      await score(0, [{ label: 'rage', score: parentScore }], initialStrict ? [] : ['rage']);
      await score(1, [{ label: 'rage', score: 0.9 }], ['rage']);
      const panel = document.createElement('div');
      document.body.appendChild(panel);
      ui.renderFilteredPostsView(panel);
      panel.querySelector<HTMLButtonElement>(`a[href="${reply.dataset.url}"] .slop-restore`)!.click();
      await flush();
      const { currentPostDecision } = await import('../../src/content/filter-actions.js');
      expect(currentPostDecision(adapter, reply)).toMatchObject({ shouldHide: false, userOverride: true });
      expect(adapter.getPostContainer(reply).style.display).toBe('');

      ui.reconcileFilterStrictness(['rage'], initialStrict ? [] : ['rage']);
      expect(adapter.getPostContainer(parent).style.display).toBe('none');
      expect(adapter.getPostContainer(reply).style.display).toBe('');
      expect(adapter.getPostContainer(reply).dataset.filteredByExtension).toBeUndefined();
      expect(currentPostDecision(adapter, reply)).toMatchObject({ shouldHide: false, userOverride: true });
      expect(evaluations).toHaveLength(2);
    });

    it.each([
      { removedFirst: false, rageScore: 0.9 }, { removedFirst: true, rageScore: 0.9 },
      { removedFirst: false, rageScore: 0.5 }, { removedFirst: true, rageScore: 0.5 },
    ])('retains surviving score evidence when removing a Strict phrase (removedFirst=$removedFirst, score=$rageScore)', async ({ removedFirst, rageScore }) => {
      storage.descriptions_twitter = removedFirst ? ['other', 'rage'] : ['rage', 'other'];
      storage.strictFilters_twitter = ['other'];
      const article = post('1');
      await start();
      const scores = (storage.descriptions_twitter as string[]).map(label => ({ label, score: label === 'rage' ? rageScore : 0.1 }));
      await score(0, scores, ['rage']);
      await ui.removeFilterPhrase('other');
      await flush();
      ui.reconcileFilterStrictness(['rage'], []);
      expect(adapter.getPostContainer(article).style.display).toBe('none');
      expect(ui.getFilteredPosts()).toHaveLength(1);
      expect(ui.getFilteredPosts()[0]).toMatchObject({ matches: ['rage'], classification: {
        scores: [{ label: 'rage', score: rageScore }], textSent: 'A synthetic post with several words.',
      } });
      expect(evaluations).toHaveLength(1);

      change('strictFilters_twitter', ['rage']);
      await flush();
      expect(adapter.getPostContainer(article).style.display).toBe(rageScore < 0.72 ? '' : 'none');
      change('strictFilters_twitter', []);
      await flush();
      expect(adapter.getPostContainer(article).style.display).toBe('none');
      expect(ui.getFilteredPosts()[0].classification?.scores).toEqual([{ label: 'rage', score: rageScore }]);
      expect(evaluations).toHaveLength(1);
    });

    it('routes content phrase edits through worker actions instead of writing phrase and Strict snapshots', async () => {
      storage.strictFilters_twitter = ['rage'];
      await start();
      vi.mocked(chrome.storage.local.set).mockClear();
      await expect(ui.addFilterPhrase('birds')).resolves.toBe(true);
      expect(sendMessage).toHaveBeenCalledWith({ type: 'addFilterPhrase', siteId: 'twitter', phrase: 'birds' });
      expect(storage.strictFilters_twitter).toEqual(['rage']);
      await ui.removeFilterPhrase('birds');
      expect(sendMessage).toHaveBeenCalledWith({ type: 'removeFilterPhrase', siteId: 'twitter', phrase: 'birds' });
      expect(storage.descriptions_twitter).toEqual(['rage']);
      expect(storage.strictFilters_twitter).toEqual(['rage']);
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
  });

  describe('strictness delta corrections', () => {
    async function score(index: number, scores: Array<{ label: string; score: number }>, matches: string[]) {
      evaluations[index].resolve({ shouldHide: matches.length > 0, reasoning: matches.length ? `Matched: ${matches.join(', ')}` : 'No matching filters',
        matches, scores, textSent: 'A synthetic post with several words.', cached: true });
      await flush();
    }
    function displays(...articles: HTMLElement[]) { return articles.map(article => adapter.getPostContainer(article).style.display); }

    it('makes a Strict-to-Standard thread switch match fresh evaluations at Standard', async () => {
      storage.strictFilters_twitter = ['rage'];
      const parent = post('1');
      const reply = post('2', 'Synthetic reply with several words.', true);
      await start();
      await score(0, [{ label: 'rage', score: 0.5 }], []);
      await score(1, [{ label: 'rage', score: 0.1 }], []);
      change('strictFilters_twitter', []);
      await flush();
      const switched = displays(parent, reply);

      const freshParent = post('3');
      const freshReply = post('4', 'Fresh reply with several words.', true);
      notifyMountedArticle(freshParent);
      notifyMountedArticle(freshReply);
      await flush();
      await score(2, [{ label: 'rage', score: 0.5 }], ['rage']);
      await score(3, [{ label: 'rage', score: 0.1 }], []);
      expect(displays(freshParent, freshReply)).toEqual(['none', 'none']);
      expect(switched).toEqual(displays(freshParent, freshReply));
    });

    it.each([false, true])('keeps automatic thread replies hidden and explicit restores visible after an unrelated switch (realAdapter=%s)', async realAdapter => {
      storage.descriptions_twitter = ['rage', 'other'];
      if (realAdapter) await useRealTwitterAdapter();
      const parent = post('1');
      const restored = post('2', 'Restored thread reply with several words.', true);
      const automatic = post('3', 'Automatic thread reply with several words.', true);
      for (const reply of [restored, automatic]) {
        reply.querySelector('[data-text]')!.insertAdjacentHTML('beforeend', '<div><div><div><span></span><span></span></div></div></div>');
      }
      await start();
      if (realAdapter) {
        vi.spyOn(adapter as unknown as { _isReplyInThread: (cell: HTMLElement) => boolean }, '_isReplyInThread')
          .mockImplementation(cell => cell.dataset.threaded === 'true');
      }
      const scores = (probability: number) => [{ label: 'rage', score: probability }, { label: 'other', score: 0.1 }];
      await score(1, scores(0.9), ['rage']);
      renderRestorePanel().click();
      await flush();
      await score(2, scores(0.1), []);
      await score(0, scores(0.9), ['rage']);
      expect(displays(parent, restored, automatic)).toEqual(['none', '', 'none']);
      change('strictFilters_twitter', ['other']);
      await flush();
      expect(displays(parent, restored, automatic)).toEqual(['none', '', 'none']);
      const { currentPostDecision } = await import('../../src/content/filter-actions.js');
      expect(currentPostDecision(adapter, restored)).toMatchObject({ userOverride: true, shouldHide: false });
      expect(evaluations).toHaveLength(3);
    });

    it('settles a scored pending keep immediately when its in-flight response is retired', async () => {
      storage.descriptions_twitter = ['rage', 'other'];
      const article = post('1');
      await start();
      await score(0, [{ label: 'rage', score: 0.1 }, { label: 'other', score: 0.1 }], []);
      change('descriptions_twitter', ['rage']);
      await flush();
      await vi.advanceTimersByTimeAsync(150);
      expect(article.hasAttribute('data-ff-pending')).toBe(true);
      expect(evaluations).toHaveLength(2);
      change('strictFilters_twitter', ['rage']);
      await flush();
      expect(article.hasAttribute('data-ff-pending')).toBe(false);
      expect(article.querySelector('.post-verification-bar')?.classList.contains('verified')).toBe(true);
      await score(1, [{ label: 'rage', score: 0.1 }], []);
      await vi.advanceTimersByTimeAsync(10_500);
      expect(article.hasAttribute('data-ff-pending')).toBe(false);
      expect(article.querySelector('.post-verification-bar')?.classList.contains('verified')).toBe(true);
      expect(evaluations).toHaveLength(2);
    });

    it('re-evaluates an unmatched partial predecessor after Bounce saves its phrase but fails persistence', async () => {
      const article = post('1');
      await start();
      await score(0, [{ label: 'rage', score: 0.1 }], []);
      bounceResponse = deferred();
      const action = ui.bouncePost(article, adapter.extractPostContent(article), 'birds');
      await flush();
      expect(storage.descriptions_twitter).toEqual(['rage', 'birds']);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      bounceResponse.resolve({ success: false, error: 'Synthetic failure after phrase save' });
      await expect(action).resolves.toBe(false);
      await flush();
      expect(evaluations).toHaveLength(2);
      const { currentPostDecision } = await import('../../src/content/filter-actions.js');
      expect(currentPostDecision(adapter, article)).toBeUndefined();
      expect(displays(article)).toEqual(['']);
      await score(1, [{ label: 'rage', score: 0.1 }, { label: 'birds', score: 0.9 }], ['birds']);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(displays(article)).toEqual(['none']);
      expect(evaluations).toHaveLength(2);
    });

    it('re-evaluates after failed Bounce when its predecessor phrase was removed during extraction', async () => {
      const article = post('1');
      await start();
      await score(0, [{ label: 'rage', score: 0.9 }], ['rage']);
      expect(displays(article)).toEqual(['none']);
      const content = adapter.extractPostContent(article);
      const extraction = deferred<PostContent | null>();
      vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(extraction.promise);
      bounceResponse = deferred();
      const action = ui.bouncePost(article, content, 'birds');
      await flush();
      await ui.removeFilterPhrase('rage');
      await flush();
      expect(storage.descriptions_twitter).toEqual([]);
      expect(evaluations).toHaveLength(1);
      extraction.resolve(content);
      await flush();
      expect(storage.descriptions_twitter).toEqual(['birds']);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      bounceResponse.resolve({ success: false, error: 'Synthetic failure after phrase save' });
      await expect(action).resolves.toBe(false);
      await flush();
      expect(evaluations).toHaveLength(2);
      const { currentPostDecision } = await import('../../src/content/filter-actions.js');
      expect(currentPostDecision(adapter, article)).toBeUndefined();
      expect(displays(article)).toEqual(['']);
      await score(1, [{ label: 'birds', score: 0.9 }], ['birds']);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(displays(article)).toEqual(['none']);
      expect(evaluations).toHaveLength(2);
    });

    it('closes on Escape without moving focus out of a field reached by Tab', async () => {
      await start();
      document.querySelector<HTMLButtonElement>('.filter-phrase-inline')!.click();
      const input = document.querySelector<HTMLInputElement>('.filter-phrases-input')!;
      input.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(document.querySelector('.filter-strictness-popover')).toBeNull();
      expect(document.activeElement).toBe(input);
    });
  });

  describe('strictness corrections', () => {
    function anchor(phrase = 'rage') {
      return [...document.querySelectorAll<HTMLButtonElement>('.filter-phrase-inline')].find(button => button.dataset.filterPhrase === phrase)!;
    }
    async function scored(index: number, probability: number, cached = true) {
      evaluations[index].resolve({ shouldHide: true, matches: ['rage'], reasoning: 'Matched: rage',
        scores: [{ label: 'rage', score: probability }], textSent: 'A synthetic post with several words.', cached });
      await flush();
    }
    function row(id: string, matches: string[], scores?: Array<{ label: string; score: number }>, textSent = 'A synthetic post with several words.', manual = false) {
      const content = canonicalXContent(id);
      ui.storeFilteredPost(document.createElement('article'), content, 'Synthetic saved decision', '', matches.join(', '), matches, manual,
        content.text, scores ? { scores, textSent } : undefined);
    }

    it.each(['birds', 'rage'])('keeps live and historical partial-score hides after adding birds then making %s Strict', async phrase => {
      const hidden = post('1');
      await start();
      await scored(0, 0.9);
      row('77', ['rage'], [{ label: 'rage', score: 0.9 }]);
      change('descriptions_twitter', ['rage', 'birds']);
      await flush();
      change('strictFilters_twitter', [phrase]);
      await flush();
      expect(adapter.getPostContainer(hidden).style.display).toBe('none');
      expect(ui.getFilteredPosts().map(post => post.post.postUrl)).toEqual([
        'https://x.com/synthetic/status/1', 'https://x.com/synthetic/status/77',
      ]);
      const { currentPostDecision } = await import('../../src/content/filter-actions.js');
      expect(currentPostDecision(adapter, hidden)).toMatchObject({ shouldHide: true, matches: ['rage'] });
      expect(evaluations).toHaveLength(1);
    });

    it('releases and evaluates a partial vector only when its present scores cease matching', async () => {
      const hidden = post('1');
      await start();
      await scored(0, 0.5);
      change('descriptions_twitter', ['rage', 'birds']);
      await flush();
      change('strictFilters_twitter', ['rage']);
      await flush();
      expect(adapter.getPostContainer(hidden).style.display).toBe('');
      expect(ui.getFilteredPosts()).toHaveLength(0);
      expect(evaluations).toHaveLength(2);
    });

    it.each(['toggle-back', 'delayed-no-change'])('keeps a matching fade hidden across a %s saved-level event', async phase => {
      if (phase === 'delayed-no-change') storage.strictFilters_twitter = ['rage'];
      const fading = post('1');
      await start();
      await scored(0, 0.95, false);
      expect(fading.style.opacity).toBe('0');
      if (phase === 'toggle-back') {
        change('strictFilters_twitter', ['rage']);
        change('strictFilters_twitter', []);
      } else {
        storageListeners.forEach(listener => listener({ strictFilters_twitter: { oldValue: [], newValue: ['rage'] } }, 'local'));
      }
      await flush();
      await vi.advanceTimersByTimeAsync(400);
      expect(adapter.getPostContainer(fading).style.display).toBe('none');
      expect(ui.getFilteredPosts()).toHaveLength(1);
      expect(evaluations).toHaveLength(1);
    });

    it('counts the selected phrase with present scores, current other levels and the short-post floor', async () => {
      storage.descriptions_twitter = ['rage', 'other', 'new'];
      await start();
      row('1', ['rage', 'other'], [{ label: 'rage', score: 0.5 }, { label: 'other', score: 0.6 }]);
      row('2', ['other'], [{ label: 'rage', score: 0.1 }, { label: 'other', score: 0.6 }]);
      row('3', ['rage'], [{ label: 'rage', score: 0.71 }, { label: 'other', score: 0.6 }], 'one two three');
      row('4', ['rage'], [{ label: 'rage', score: 0.5 }, { label: 'other', score: 0.1 }]);
      row('5', ['rage'], [{ label: 'rage', score: 0.5 }]);
      row('6', ['rage'], [{ label: 'other', score: 0.1 }]);
      row('7', ['rage'], undefined, undefined, true);
      row('8', ['rage']);
      row('9', ['rage'], [{ label: 'rage', score: 0.9 }]);
      anchor().click();
      const impact = document.querySelector<HTMLElement>('.filter-strictness-impact')!;
      expect(impact.textContent).toBe('Strict would bring back 3 of 8 hidden posts.');
      expect(impact.hidden).toBe(false);
      document.querySelector<HTMLButtonElement>('[data-strictness="strict"]')!.click();
      await flush();
      expect(ui.getFilteredPosts().some(post => post.matches?.includes('rage'))).toBe(true);
      expect(impact.hidden).toBe(true);
    });

    it('marks the phrase expanded and repositions on scroll without recounting snapshots', async () => {
      await start();
      row('1', ['rage'], [{ label: 'rage', score: 0.5 }]);
      const button = anchor();
      let left = 120;
      let bottom = 140;
      button.getBoundingClientRect = () => ({ left, right: left + 70, top: bottom - 20, bottom, width: 70, height: 20, x: left, y: bottom - 20, toJSON: () => ({}) });
      button.click();
      expect(button.getAttribute('aria-expanded')).toBe('true');
      const popover = document.querySelector<HTMLElement>('.filter-strictness-popover')!;
      expect(popover.style.left).toBe('120px');
      expect(popover.style.top).toBe('148px');
      const iterate = vi.spyOn(ui.getFilteredPosts(), Symbol.iterator);
      left = 200;
      bottom = 240;
      window.dispatchEvent(new Event('scroll'));
      expect(popover.style.left).toBe('200px');
      expect(popover.style.top).toBe('248px');
      expect(iterate).not.toHaveBeenCalled();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(button);
    });

    it.each(['standard', 'strict'])('keeps keyboard focus on the %s segment during and after saving', async segment => {
      storage.strictFilters_twitter = segment === 'standard' ? ['rage'] : [];
      await start();
      const saved = deferred<void>();
      const original = sendMessage.getMockImplementation()!;
      sendMessage.mockImplementation(message => message.type === 'setFilterStrictness'
        ? saved.promise.then(() => original(message)) : original(message));
      anchor().click();
      const button = document.querySelector<HTMLButtonElement>(`[data-strictness="${segment}"]`)!;
      button.focus();
      button.click();
      button.click();
      expect(button.disabled).toBe(false);
      expect(document.activeElement).toBe(button);
      expect(sendMessage.mock.calls.filter(([message]) => message.type === 'setFilterStrictness')).toHaveLength(1);
      saved.resolve();
      await flush();
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(document.activeElement).toBe(button);
    });

    it('leaves outside input focus where the user clicked', async () => {
      await start();
      const button = anchor();
      button.click();
      const input = document.querySelector<HTMLInputElement>('.filter-phrases-input')!;
      input.focus();
      input.click();
      expect(document.querySelector('.filter-strictness-popover')).toBeNull();
      expect(document.activeElement).toBe(input);
      expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    it('removes orphaned strictness popovers during reinjection cleanup', async () => {
      const orphan = document.createElement('div');
      orphan.className = 'filter-strictness-popover';
      document.body.appendChild(orphan);
      await start();
      expect(orphan.isConnected).toBe(false);
    });

    it('preserves pending and errored state when a strictness release needs more evidence', async () => {
      const pending = post('1');
      const failed = post('2');
      await start();
      ui.markPostPending(pending);
      evaluations[1].resolve({ error: 'local_model', reasoning: 'Synthetic inference error' });
      await flush();
      expect(failed.classList.contains('ff-error')).toBe(true);
      ui.reconcileFilterStrictness(['rage'], ['rage']);
      expect(pending.hasAttribute('data-ff-pending')).toBe(true);
      expect(pending.querySelector('.post-verification-bar')?.classList.contains('pending')).toBe(true);
      expect(pending.querySelector('.post-verification-bar')?.classList.contains('verified')).toBe(false);
      expect(failed.classList.contains('ff-error')).toBe(true);
      expect(failed.querySelector('.post-verification-bar')?.classList.contains('verified')).toBe(false);
      ui.showReasoningPopup(failed, 0, 0);
      expect(document.querySelector('.reasoning-status')?.textContent).toBe('ERROR');
    });

    it('keeps a restored real thread reply visible when its pending parent verdict lands', async () => {
      await useRealTwitterAdapter();
      const parent = post('1');
      const reply = post('2', 'Synthetic thread reply', true);
      reply.querySelector('[data-text]')!.insertAdjacentHTML('beforeend', '<div><div><div><span></span><span></span></div></div></div>');
      await start();
      await scored(1, 0.9);
      renderRestorePanel().click();
      await flush();
      expect(adapter.getPostContainer(reply).style.display).toBe('');
      await scored(0, 0.9);
      expect(adapter.getPostContainer(parent).style.display).toBe('none');
      expect(adapter.getPostContainer(reply).style.display).toBe('');
      expect(adapter.getPostContainer(reply).dataset.filteredByExtension).toBeUndefined();
      expect(adapter.hidePost).toHaveBeenLastCalledWith(parent, true, expect.any(Function));
    });
  });

  describe('per-filter strictness', () => {
  function phraseButton(phrase = 'rage', container: ParentNode = document): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLButtonElement>('.filter-phrase-inline')]
      .find(button => button.dataset.filterPhrase === phrase)!;
  }

  async function scoredVerdict(index: number, scores = [{ label: 'rage', score: 0.5 }], textSent = 'A synthetic post with several words.', cached = true): Promise<void> {
    const { decideMatches } = await import('../../src/shared/decision-model.js');
    const judged = decideMatches(scores, textSent, storage.strictFilters_twitter as string[] | undefined);
    evaluations[index].resolve({ shouldHide: judged.shouldHide, matches: judged.matches,
      category: judged.matches.join(', '), reasoning: judged.shouldHide ? `Matched: ${judged.matches.join(', ')}` : 'No matching filters',
      scores, textSent, cached, timestamp: 123 });
    await flush();
  }

  it('opens a keyboard reachable phrase popover and returns focus on Done, Escape and outside click', async () => {
    await start();
    const anchor = phraseButton();
    expect(anchor.tagName).toBe('BUTTON');
    expect(anchor.tabIndex).toBe(0);
    expect(anchor.title).toBe('');
    anchor.click();
    let popover = document.querySelector<HTMLElement>('.filter-strictness-popover')!;
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.querySelector('strong')?.textContent).toBe('rage');
    expect(popover.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Strictness');
    expect([...popover.querySelectorAll('[data-strictness]')].map(button => [button.textContent, button.getAttribute('aria-pressed')]))
      .toEqual([['Standard', 'true'], ['Strict', 'false']]);
    expect(popover.querySelector<HTMLElement>('.filter-strictness-impact')?.hidden).toBe(true);
    expect(document.activeElement?.textContent).toBe('Standard');
    popover.querySelector<HTMLButtonElement>('.filter-strictness-actions button:last-child')!.click();
    expect(document.querySelector('.filter-strictness-popover')).toBeNull();
    expect(document.activeElement).toBe(anchor);
    anchor.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.filter-strictness-popover')).toBeNull();
    expect(document.activeElement).toBe(anchor);
    anchor.click();
    popover = document.querySelector<HTMLElement>('.filter-strictness-popover')!;
    popover.querySelector('strong')!.click();
    expect(popover.isConnected).toBe(true);
    document.body.click();
    expect(popover.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('persists Strict through the worker, updates every phrase renderer and removes through the existing path', async () => {
    document.body.innerHTML = '<aside class="absent-sidebar"><div class="absent-content"></div></aside><nav class="absent-nav"></nav>';
    await start();
    expect(document.querySelectorAll('.filter-phrase-inline')).toHaveLength(3);
    const anchor = phraseButton();
    anchor.click();
    document.querySelector<HTMLButtonElement>('[data-strictness="strict"]')!.click();
    await flush();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'setFilterStrictness', siteId: 'twitter', phrase: 'rage', strict: true });
    expect(storage.strictFilters_twitter).toEqual(['rage']);
    expect(document.querySelectorAll('.filter-strict-pill')).toHaveLength(3);
    expect([...document.querySelectorAll('.filter-phrase-inline')].every(button => button.lastChild?.textContent === 'Strict')).toBe(true);
    expect(document.querySelector('[data-strictness="strict"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector<HTMLElement>('.filter-strictness-impact')?.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('.filter-strictness-remove')!.click();
    await flush();
    expect(storage.descriptions_twitter).toEqual([]);
    expect(storage.strictFilters_twitter).toEqual([]);
    expect(document.querySelector('.filter-strictness-popover')).toBeNull();
    expect(document.querySelector('.filter-phrase-inline')).toBeNull();
    expect({ tag: document.activeElement?.tagName, className: document.activeElement?.className })
      .toEqual({ tag: 'INPUT', className: 'filter-phrases-input' });
  });

  it('keeps Standard and the phrase visible when strictness persistence fails', async () => {
    await start();
    phraseButton().click();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sendMessage.mockResolvedValueOnce({ success: false, error: 'Synthetic level failure' });
    document.querySelector<HTMLButtonElement>('[data-strictness="strict"]')!.click();
    await flush();
    expect(document.querySelector('[data-strictness="standard"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.filter-strict-pill')).toBeNull();
    expect(document.querySelector('.filter-strictness-popover')?.textContent).toBe('rageStandardStrictStrict would bring back 0 of 0 hidden posts.Remove filterDone');
    expect(document.querySelector<HTMLButtonElement>('[data-strictness="strict"]')?.disabled).toBe(false);
  });

  it('counts only automatic scored posts that every current filter would release, retaining unknown and manual posts in the denominator', async () => {
    storage.descriptions_twitter = ['rage', 'other'];
    storage.strictFilters_twitter = ['other'];
    const articles = Array.from({ length: 6 }, (_, index) => post(String(index)));
    await start();
    await scoredVerdict(0, [{ label: 'rage', score: 0.5 }, { label: 'other', score: 0.2 }]);
    await scoredVerdict(1, [{ label: 'rage', score: 0.9 }, { label: 'other', score: 0.2 }]);
    await scoredVerdict(2, [{ label: 'rage', score: 0.5 }, { label: 'other', score: 0.8 }]);
    await scoredVerdict(3, [{ label: 'rage', score: 0.5 }, { label: 'other', score: 0.5 }]);
    await verdict(4, ['rage']);
    await ui.bouncePost(articles[5], adapter.extractPostContent(articles[5]), 'rage');
    phraseButton().click();
    expect(document.querySelector('.filter-strictness-impact')?.textContent).toBe('Strict would bring back 2 of 6 hidden posts.');
    expect(document.querySelector<HTMLElement>('.filter-strictness-impact')?.hidden).toBe(false);
    change('descriptions_twitter', ['rage']);
    await flush();
    expect(document.querySelector('.filter-strictness-impact')?.textContent).toBe('Strict would bring back 3 of 6 hidden posts.');
  });

  it('rejudges visible and hidden scored posts immediately without another worker evaluation, preserving evidence across repeated switches', async () => {
    storage.strictFilters_twitter = ['rage'];
    const visible = post('1');
    const hidden = post('2');
    await start();
    await scoredVerdict(0);
    await scoredVerdict(1, [{ label: 'rage', score: 0.9 }]);
    expect(adapter.getPostContainer(visible).style.display).toBe('');
    expect(adapter.getPostContainer(hidden).style.display).toBe('none');
    change('strictFilters_twitter', []);
    await flush();
    expect(adapter.getPostContainer(visible).style.display).toBe('none');
    expect(ui.getFilteredPosts()).toHaveLength(2);
    change('strictFilters_twitter', ['rage']);
    await flush();
    expect(adapter.getPostContainer(visible).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(1);
    change('strictFilters_twitter', []);
    await flush();
    expect(adapter.getPostContainer(visible).style.display).toBe('none');
    expect(evaluations).toHaveLength(2);
    ui.showReasoningPopup(visible, 0, 0);
    expect(document.querySelector('.reasoning-match-chip')?.textContent).toBe('rage');
    expect(document.querySelector('.classification-scores')?.textContent).toContain('0.50');
  });

  it('cancels a scheduled automatic hide at a Strict boundary and rejects the old in-flight response and detector event', async () => {
    const fading = post('1');
    const pending = post('2');
    await start();
    const pendingId = evaluations[1].message.evaluationId;
    await scoredVerdict(0, [{ label: 'rage', score: 0.5 }], 'A synthetic post with several words.', false);
    expect(fading.style.opacity).toBe('0');
    change('strictFilters_twitter', ['rage']);
    await flush();
    expect(evaluations).toHaveLength(3);
    await scoredVerdict(1, [{ label: 'rage', score: 0.95 }]);
    messageListeners.forEach(listener => listener({ type: 'detectorResponse', evaluationId: pendingId, detectorName: 'Local', shouldHide: true, matches: ['rage'], category: 'rage' }, {}, () => {}));
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(fading).style.display).toBe('');
    expect(adapter.getPostContainer(pending).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    await scoredVerdict(2);
    expect(adapter.getPostContainer(pending).style.display).toBe('');
  });

  it('keeps manual Bounce and Restore decisions through both level switches', async () => {
    const bounced = post('1');
    const restored = post('2');
    await start();
    await scoredVerdict(0);
    await scoredVerdict(1);
    await ui.bouncePost(bounced, adapter.extractPostContent(bounced), 'rage');
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    ui.renderFilteredPostsView(panel);
    panel.querySelector<HTMLButtonElement>(`a[href="${restored.dataset.url}"] .slop-restore`)!.click();
    await flush();
    change('strictFilters_twitter', ['rage']);
    change('strictFilters_twitter', []);
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(bounced).style.display).toBe('none');
    expect(adapter.getPostContainer(restored).style.display).toBe('');
    expect(ui.getFilteredPosts().map(post => post.userOverride)).toEqual([true]);
    expect(evaluations).toHaveLength(2);
  });

  it('rejudges a scored automatic predecessor after a pending Restore fails at Strict, retaining scores for Standard', async () => {
    const article = post('1');
    await start();
    await scoredVerdict(0);
    restoreResponse = deferred();
    renderRestorePanel().click();
    await flush();
    change('strictFilters_twitter', ['rage']);
    await flush();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreResponse.resolve({ success: false, error: 'Synthetic Restore failure after Strict' });
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    change('strictFilters_twitter', []);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].matches).toEqual(['rage']);
    expect(evaluations).toHaveLength(1);
  });

  it('uses saved levels from storage events and ignores an older event payload', async () => {
    const hidden = post('1');
    const pending = post('2');
    await start();
    await scoredVerdict(0);
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation((message: { type: string; strict?: boolean; phrase?: string }) => {
      if (message.type === 'setFilterStrictness') {
        const previous = storage.strictFilters_twitter;
        storage.strictFilters_twitter = message.strict ? [message.phrase] : [];
        storageListeners.forEach(listener => listener({ strictFilters_twitter: { oldValue: previous, newValue: storage.strictFilters_twitter } }, 'local'));
        return Promise.resolve({ success: true });
      }
      return original(message);
    });
    phraseButton().click();
    document.querySelector<HTMLButtonElement>('[data-strictness="strict"]')!.click();
    await flush();
    expect(adapter.getPostContainer(hidden).style.display).toBe('');
    expect(document.querySelector('.filter-strict-pill')?.textContent).toBe('Strict');
    await scoredVerdict(1, [{ label: 'rage', score: 0.99 }]);
    expect(adapter.getPostContainer(pending).style.display).toBe('');
    storageListeners.forEach(listener => listener({ strictFilters_twitter: { oldValue: ['rage'], newValue: [] } }, 'local'));
    await flush();
    expect(adapter.getPostContainer(hidden).style.display).toBe('');
    expect(document.querySelector('[data-strictness="strict"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.filter-strict-pill')?.textContent).toBe('Strict');
  });

  it('rejudges a completed score when its pending saved-level read resolves', async () => {
    const hidden = post('1');
    const pending = post('2');
    await start();
    await scoredVerdict(0);
    const read = deferred<Record<string, unknown>>();
    const get = chrome.storage.local.get as ReturnType<typeof vi.fn>;
    const original = get.getMockImplementation()!;
    get.mockImplementation((keys: string[]) => keys.includes('strictFilters_twitter') ? read.promise : original(keys));
    change('strictFilters_twitter', ['rage']);
    await scoredVerdict(1, [{ label: 'rage', score: 0.99 }]);
    expect(adapter.getPostContainer(pending).style.display).toBe('none');
    read.resolve({ descriptions_twitter: ['rage'], strictFilters_twitter: ['rage'] });
    await flush();
    expect(adapter.getPostContainer(hidden).style.display).toBe('');
    expect(adapter.getPostContainer(pending).style.display).toBe('none');
    expect(evaluations).toHaveLength(2);
    expect(document.querySelector('.filter-strict-pill')?.textContent).toBe('Strict');
  });

  it.each([true, false])('preserves a scored predecessor after failed Bounce with a strict change during persistence=%s', async changesDuringBounce => {
    storage.strictFilters_twitter = changesDuringBounce ? [] : ['rage'];
    const article = post('1');
    await start();
    await scoredVerdict(0);
    bounceResponse = deferred();
    const action = ui.bouncePost(article, adapter.extractPostContent(article), 'rage');
    await flush();
    if (changesDuringBounce) change('strictFilters_twitter', ['rage']);
    await flush();
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    bounceResponse.resolve({ success: false, error: 'Synthetic Bounce failure with stored scores' });
    await expect(action).resolves.toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    change('strictFilters_twitter', []);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].classification?.scores).toEqual([{ label: 'rage', score: 0.5 }]);
    expect(evaluations).toHaveLength(1);
  });

  });

  it.each([false, true].flatMap(cached => [
    { cached, textSent: 'Criticism of rudeness. 😤', cutoff: 0.7 },
    { cached, textSent: 'Criticism of this rudeness. 😤', cutoff: DECISION_MODEL.cutoff },
  ]))('renders scores and copies exact classification details with cached=$cached cutoff=$cutoff', async ({ cached, textSent, cutoff }) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    storage.descriptions_twitter = ['excessive rudeness', 'spam, scams', 'bird watching'];
    await useRealTwitterAdapter();
    const article = post('1', textSent);
    article.insertAdjacentHTML('beforeend', '<div role="link"><div data-testid="tweetText">A rude quoted post.</div></div>');
    await start();
    expect(evaluations[0].message.post).toBe(textSent);
    const scores = [
      { label: 'excessive rudeness', score: 0.7 },
      { label: 'spam, scams', score: 0.09 },
      { label: 'bird watching', score: DECISION_MODEL.cutoff },
    ];
    const birdMatched = cutoff === DECISION_MODEL.cutoff;
    const timestamp = 1795551234567;
    evaluations[0].resolve({ shouldHide: true, reasoning: 'Matched', matches: birdMatched ? ['excessive rudeness', 'bird watching'] : ['excessive rudeness'],
      scores, textSent, model: DECISION_MODEL.id, timestamp, cached, rawResponse: '{"answers":{"f0":{}}}',
    });
    await flush();
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    ui.renderFilteredPostsView(panel);
    expect(panel.querySelector('.slop-post-text')?.textContent).toBe(textSent);
    expect(panel.querySelector('.slop-post-reasoning')?.textContent).toBe(birdMatched
      ? 'Matched: excessive rudeness · 0.70, bird watching · 0.29' : 'Matched: excessive rudeness · 0.70');
    const details = panel.querySelector<HTMLDetailsElement>('.classification-details')!;
    expect(details.open).toBe(false);
    expect(details.closest('a')).toBeNull();
    expect(details.querySelector('summary')?.textContent).toBe('Details');
    expect(details.textContent).not.toContain('Matched when score');
    expect(Array.from(details.querySelectorAll('li'), item => item.textContent)).toEqual([
      `excessive rudeness · 0.70 · needs ${cutoff.toFixed(2)}${cutoff === 0.7 ? ' · short post' : ''} · Matched`,
      `spam, scams · 0.09 · needs ${cutoff.toFixed(2)}${cutoff === 0.7 ? ' · short post' : ''} · Not matched`,
      `bird watching · 0.29 · needs ${cutoff.toFixed(2)}${cutoff === 0.7 ? ' · short post' : ''} · ${birdMatched ? 'Matched' : 'Not matched'}`,
    ]);
    expect(details.querySelector('pre')?.textContent).toBe(textSent);
    expect(ui.getFilteredPosts()[0].evaluationText).toBe(textSent);
    expect(panel.querySelector('.slop-quote-text')?.textContent).toBe('A rude quoted post.');
    expect(writeText).not.toHaveBeenCalled();
    const messagesBeforeCopy = sendMessage.mock.calls.length;
    details.open = true;
    details.querySelector<HTMLButtonElement>('.classification-copy')!.click();
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({
      bouncerVersion: '2.0.0', model: DECISION_MODEL.id, templateId: DECISION_MODEL.templateId,
      postUrl: 'https://x.com/synthetic/status/1', textSent,
      scores: [{ ...scores[0], cutoff, strict: false, matched: true }, { ...scores[1], cutoff, strict: false, matched: false }, { ...scores[2], cutoff, strict: false, matched: birdMatched }], classifiedAt: timestamp,
    });
    expect(sendMessage).toHaveBeenCalledTimes(messagesBeforeCopy);
    expect(details.querySelector('[role="status"]')?.textContent).toBe('Copied');
    await vi.advanceTimersByTimeAsync(1500);
    expect(details.querySelector('[role="status"]')?.textContent).toBe('');
    ui.showReasoningPopup(article, 0, 0);
    expect(document.querySelector('.reasoning-details pre')?.textContent).toBe(textSent);
    expect(document.querySelector('.reasoning-details')?.textContent).toContain(`needs ${cutoff.toFixed(2)}`);
    expect(document.querySelector('.post-filter-reasoning-popup')?.textContent).not.toContain('Raw Model Response');
  });

  it.each(['bare quote', 'media only'])('leaves a %s visible without submitting an evaluation', async kind => {
    await useRealTwitterAdapter();
    const article = post('1');
    article.querySelector('[data-text]')!.remove();
    article.insertAdjacentHTML('beforeend', kind === 'bare quote'
      ? '<div role="link"><div data-testid="tweetText">A rude quoted post.</div></div>'
      : '<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/synthetic.jpg"></div>');
    await start();
    expect(evaluations).toHaveLength(0);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it('classifies a quoted post independently when it also appears on its own', async () => {
    await useRealTwitterAdapter();
    const ownText = 'This rudeness is unacceptable.';
    const rudeText = 'A rude quoted post.';
    const quoter = post('1', ownText);
    quoter.insertAdjacentHTML('beforeend', `<div role="link"><div data-testid="tweetText">${rudeText}</div></div>`);
    const standalone = post('2', rudeText);
    await start();
    expect(evaluations.map(({ message }) => message.post)).toEqual([ownText, rudeText]);
    expect(generateCacheKey(evaluations[0].message.post)).not.toBe(generateCacheKey(`${ownText} [Quoted: ${rudeText}]`));
    evaluations[0].resolve({ shouldHide: false, reasoning: 'No match', matches: [] });
    await verdict(1, ['rage']);
    expect(adapter.getPostContainer(quoter).style.display).toBe('');
    expect(adapter.getPostContainer(standalone).style.display).toBe('none');
    expect(ui.getFilteredPosts().map(entry => entry.post.postUrl)).toEqual([standalone.dataset.url]);
  });

  it.each(['unavailable', 'denied'])('renders entries without scores and selects JSON when clipboard is %s', async mode => {
    vi.stubGlobal('navigator', { clipboard: mode === 'unavailable' ? undefined
      : { writeText: vi.fn().mockRejectedValue(new Error('Clipboard denied')) } });
    post('1');
    await start();
    await verdict(0, ['rage']);
    renderRestorePanel();
    const details = document.querySelector<HTMLDetailsElement>('.classification-details')!;
    expect(document.querySelector('.slop-post-reasoning')?.textContent).toBe('Matched: rage');
    expect(details.querySelectorAll('li')).toHaveLength(0);
    details.open = true;
    details.querySelector<HTMLButtonElement>('.classification-copy')!.click();
    await flush();
    const fallback = details.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(fallback.readOnly).toBe(true);
    expect(document.activeElement).toBe(fallback);
    expect(fallback.selectionStart).toBe(0);
    expect(fallback.selectionEnd).toBe(fallback.value.length);
    expect(JSON.parse(fallback.value)).toEqual({
      bouncerVersion: '2.0.0', model: DECISION_MODEL.id, templateId: DECISION_MODEL.templateId,
      postUrl: 'https://x.com/synthetic/status/1', textSent: null, scores: [], classifiedAt: null,
    });
  });

  it('replaces score snapshots and clears automatic details when a manual hide replaces them', async () => {
    const article = post('1');
    await start();
    const scores = [{ label: 'rage', score: 0.8 }];
    evaluations[0].resolve({ shouldHide: true, reasoning: 'Matched', matches: ['rage'], scores, textSent: 'Original state' });
    await flush();
    scores[0].score = 0.1;
    expect(ui.getFilteredPosts()[0].classification?.scores).toEqual([{ label: 'rage', score: 0.8 }]);
    const content = adapter.extractPostContent(article);
    ui.storeFilteredPost(article, content, 'New classification', '', 'rage', ['rage'], false, content.text,
      { scores: [{ label: 'rage', score: 0.7 }], textSent: 'New state' });
    expect(ui.getFilteredPosts()[0].classification?.textSent).toBe('New state');
    expect(ui.getFilteredPosts()[0].classification?.scores).toEqual([{ label: 'rage', score: 0.7 }]);
    ui.storeFilteredPost(article, content, 'Bounced by you', '', 'rage', ['rage'], true);
    expect(ui.getFilteredPosts()[0].classification).toBeUndefined();
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

  it('restores and evaluates equal-length rule replacements with exact matches', async () => {
    const article = post('1');
    await start();
    await verdict(0, ['rage']);
    change('descriptions_twitter', ['replacement']);
    await flush();
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(evaluations.length).toBe(2);
  });

  it('preserves a cached explicit hide across rule changes', async () => {
    const article = post('1', 'Synthetic manually hidden post');
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
    expect(adapter.hidePost).toHaveBeenCalledWith(article, false, expect.any(Function));
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
    expect(evaluations[0].message.post).toBe(canonical.text);
    expect(evaluations[0].message.post).not.toContain('Synthetic Ada');
    expect(evaluations[0].message.post).not.toContain('@synthetic');

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
    sendMessage.mockImplementation(async (message: { type: string; post: string; phrase?: string; strict?: boolean }) => {
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
    ui.storeFilteredPost(article, display, 'Synthetic current display snapshot', '', 'rage', ['rage']);
    expect(ui.getFilteredPosts()[0].evaluationText).toBe('A formatted excerpt…');

    await ui.bouncePost(article, display, 'rage');
    expect(ui.getFilteredPosts()).toHaveLength(1);
    expect(ui.getFilteredPosts()[0].evaluationText).toBe(canonical.text);
    renderRestorePanel().click();
    await flush();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'overrideCacheEntry', post: canonical.text }));
  });

  it('lets Restore supersede an older canonical Bounce lookup without persisting or republishing its hide', async () => {
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
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'overrideCacheEntry', post: canonical.text }));
  });

  it('looks up reasoning by the complete canonical X text', async () => {
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

  it('keeps an eleventh filter draft in the phrase input and shows the count limit', async () => {
    storage.descriptions_twitter = Array.from({ length: MAX_ACTIVE_FILTERS }, (_, index) => `saved filter ${index}`);
    await start();
    const input = document.querySelector<HTMLInputElement>('.filter-phrases-input')!;
    input.value = 'posts mocking strangers';
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
    await flush();
    expect(input.value).toBe('posts mocking strangers');
    expect(document.querySelector('.ff-category-limit-warning')?.textContent).toBe(MAX_FILTERS_WARNING);
    expect(storage.descriptions_twitter).toHaveLength(MAX_ACTIVE_FILTERS);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('keeps the unaccepted pasted phrases when the tenth filter fills the limit', async () => {
    storage.descriptions_twitter = Array.from({ length: MAX_ACTIVE_FILTERS - 1 }, (_, index) => `saved filter ${index}`);
    await start();
    const input = document.querySelector<HTMLInputElement>('.filter-phrases-input')!;
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'celebrity gossip, posts mocking strangers' } });
    input.dispatchEvent(paste);
    await flush();
    expect(input.value).toBe('posts mocking strangers');
    expect(storage.descriptions_twitter).toHaveLength(MAX_ACTIVE_FILTERS);
    expect(storage.descriptions_twitter).toContain('celebrity gossip');
    expect(document.querySelector('.ff-category-limit-warning')?.textContent).toBe(MAX_FILTERS_WARNING);
  });

  it('uses plain placeholder examples and omits blank stored filter rows', async () => {
    storage.descriptions_twitter = [' ', 'celebrity gossip', '\n'];
    await start();
    expect([...document.querySelectorAll('.filter-phrase-inline')].map(phrase => phrase.textContent)).toEqual(['celebrity gossip']);
    expect([...document.querySelectorAll('.filter-placeholder-track span')].map(phrase => phrase.textContent)).toEqual([
      'posts asking for likes or reposts', 'celebrity gossip', 'crypto price predictions', 'posts mocking strangers',
      'posts asking for likes or reposts',
    ]);
  });

  it('preserves literal category prefixes and pipes in displayed reasoning', async () => {
    const article = post('1');
    await start();
    const reasoning = 'category 1: literal label | <plain text>';
    evaluations[0].resolve({ shouldHide: false, reasoning });
    await flush();
    ui.showReasoningPopup(article, 20, 20);
    expect(document.querySelector('.post-filter-reasoning-popup .reasoning-text')?.textContent).toBe(reasoning);
    expect(document.querySelector('.post-filter-reasoning-popup plain')).toBeNull();
  });

  it.each(['rage', 'crypto price hype'])('bounces an entered existing/new label atomically despite an older automatic keep: %s', async phrase => {
    const article = post('1');
    await start();
    bounceResponse = deferred();
    const messagesBeforeOpen = sendMessage.mock.calls.length;
    await openBounce(article);
    expect(sendMessage).toHaveBeenCalledTimes(messagesBeforeOpen);
    const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
    input.value = phrase;
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await flush();
    evaluations[0].resolve({ shouldHide: false, reasoning: 'old automatic keep' });
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(ui.getFilteredPosts()[0].userOverride).toBe(true);
    expect(ui.getFilteredPosts()[0].matches).toEqual([phrase]);
    expect(sendMessage.mock.calls.slice(messagesBeforeOpen).map(([message]) => message.type)).toEqual(['bouncePost']);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bouncePost', phrase, siteId: 'twitter' }));
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'overrideCacheEntry')).toBe(false);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    bounceResponse.resolve({ success: true });
    await flush();
  });

  it('places the Bounce box before focusing its field, without scrolling the feed', async () => {
    const article = post('1');
    await start();
    const realFocus = HTMLElement.prototype.focus;
    let placementAtFocus: string | undefined;
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      placementAtFocus = this.closest<HTMLElement>('.ff-bounce-tooltip')?.style.position;
      realFocus.call(this, options);
    });
    await openBounce(article);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(placementAtFocus).toBe('fixed');
    expect(document.activeElement).toBe(document.querySelector('.ff-bounce-input'));
    focus.mockRestore();
  });

  it('keeps an over-limit new label draft and post visible with the existing limit warning', async () => {
    storage.descriptions_twitter = ['x'.repeat(1000)];
    const article = post('1');
    await start();
    await openBounce(article);
    const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
    input.value = 'crypto price hype';
    input.dispatchEvent(new Event('input'));
    const calls = sendMessage.mock.calls.length;
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(input.value).toBe('crypto price hype');
    expect(document.querySelector('.ff-bounce-tooltip')).not.toBeNull();
    expect(document.querySelector('.ff-bounce-tooltip .ff-category-limit-warning')?.textContent).toContain('too many filter categories');
    expect(document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')?.disabled).toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(sendMessage).toHaveBeenCalledTimes(calls);
    expect(storage.descriptions_twitter).toEqual(['x'.repeat(1000)]);
  });

  it('retains the label and shows the limit warning when the authoritative background rejects it', async () => {
    const article = post('1');
    await start();
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async message => message.type === 'bouncePost'
      ? { success: false, error: 'Filter phrases exceed the 1000-character limit.' } : original(message));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openBounce(article);
    const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
    input.value = 'crypto price hype';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bouncePost', phrase: 'crypto price hype' }));
    expect(input.value).toBe('crypto price hype');
    expect(document.querySelector('.ff-bounce-tooltip')).not.toBeNull();
    expect(document.querySelector('.ff-bounce-tooltip .ff-category-limit-warning')?.textContent).toContain('too many filter categories');
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(storage.descriptions_twitter).toEqual(['rage']);
  });

  it('still Bounces an existing duplicate label at full filter capacity', async () => {
    const phrase = 'x'.repeat(1000);
    storage.descriptions_twitter = [phrase];
    const article = post('1');
    await start();
    await openBounce(article);
    const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
    input.value = phrase;
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(document.querySelector('.ff-bounce-tooltip')).toBeNull();
    expect(document.querySelector('.ff-category-limit-warning')).toBeNull();
    expect(storage.descriptions_twitter).toEqual([phrase]);
    expect(ui.getFilteredPosts()[0].matches).toEqual([phrase]);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bouncePost', phrase }));
  });

  it('keeps an eleventh Bounce label draft visible without submitting a manual decision', async () => {
    storage.descriptions_twitter = Array.from({ length: MAX_ACTIVE_FILTERS }, (_, index) => `saved filter ${index}`);
    const article = post('1');
    await start();
    await openBounce(article);
    const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
    input.value = 'posts mocking strangers';
    input.dispatchEvent(new Event('input'));
    const calls = sendMessage.mock.calls.length;
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(input.value).toBe('posts mocking strangers');
    expect(document.querySelector('.ff-bounce-tooltip .ff-category-limit-warning')?.textContent).toBe(MAX_FILTERS_WARNING);
    expect(document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')?.disabled).toBe(false);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(sendMessage).toHaveBeenCalledTimes(calls);
  });

  it('still Bounces an existing saved label when ten filters are active', async () => {
    const phrases = Array.from({ length: MAX_ACTIVE_FILTERS }, (_, index) => `saved filter ${index}`);
    storage.descriptions_twitter = phrases;
    const article = post('1');
    await start();
    await openBounce(article);
    const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
    input.value = phrases[0];
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(document.querySelector('.ff-bounce-tooltip')).toBeNull();
    expect(storage.descriptions_twitter).toEqual(phrases);
    expect(ui.getFilteredPosts()[0].matches).toEqual([phrases[0]]);
  });

  it('retains the Bounce draft when the background rejects a newly full filter list', async () => {
    const article = post('1');
    await start();
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async message => message.type === 'bouncePost'
      ? { success: false, error: MAX_FILTERS_WARNING } : original(message));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openBounce(article);
    const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
    input.value = 'posts mocking strangers';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(input.value).toBe('posts mocking strangers');
    expect(document.querySelector('.ff-bounce-tooltip .ff-category-limit-warning')?.textContent).toBe(MAX_FILTERS_WARNING);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
  });

  it('normalizes required labels and rejects empty helper calls before claiming the post', async () => {
    const article = post('1');
    await start();
    const calls = sendMessage.mock.calls.length;
    await expect(ui.bouncePost(article, adapter.extractPostContent(article), '  ')).resolves.toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(calls);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    await expect(ui.bouncePost(article, adapter.extractPostContent(article), '  rage  ')).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bouncePost', phrase: 'rage', reasoning: 'User blocked: rage' }));
    expect(ui.getFilteredPosts()[0].matches).toEqual(['rage']);
  });

  it('renders the shared guidance once and leaves a blank-label post visible without model messages', async () => {
    const article = post('1');
    await start();
    const calls = sendMessage.mock.calls.length;
    await openBounce(article);
    const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
    expect(document.querySelectorAll('.filter-label-guidance')).toHaveLength(1);
    expect(document.querySelector('.filter-label-guidance')?.textContent).toBe(FILTER_LABEL_GUIDANCE);
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    expect(document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')?.disabled).toBe(true);
    document.querySelector<HTMLFormElement>('.ff-bounce-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(document.querySelector('.ff-bounce-tooltip')).not.toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(calls);
  });

  it('selects a missed saved filter without model messages or a duplicate phrase', async () => {
    const article = post('1');
    await start();
    const calls = sendMessage.mock.calls.length;
    await openBounce(article);
    document.querySelector<HTMLButtonElement>('.ff-missed-link')!.click();
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(calls);
    const choice = document.querySelector<HTMLButtonElement>('.ff-existing-filter')!;
    expect(choice.textContent).toBe('rage');
    choice.click();
    expect(document.querySelector<HTMLInputElement>('.ff-bounce-input')?.value).toBe('rage');
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.getPostContainer(article).style.display).toBe('none');
    expect(storage.descriptions_twitter).toEqual(['rage']);
    expect(sendMessage.mock.calls.slice(calls).map(([message]) => message.type)).toEqual(['bouncePost']);
  });

  it.each(['entered label', 'missed saved filter'])('rejects a stale %s submission after X recycles the article', async path => {
    const article = post('1');
    await start();
    await openBounce(article);
    if (path === 'missed saved filter') {
      document.querySelector<HTMLButtonElement>('.ff-missed-link')!.click();
      await flush();
      document.querySelector<HTMLButtonElement>('.ff-existing-filter')!.click();
    } else {
      const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
      input.value = 'crypto price hype';
      input.dispatchEvent(new Event('input'));
    }
    const calls = sendMessage.mock.calls.length;
    recycle(article, '2');
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(sendMessage).toHaveBeenCalledTimes(calls);
    expect(adapter.getPostContainer(article).style.display).toBe('');
    expect(ui.getFilteredPosts()).toHaveLength(0);
    expect(document.querySelector('.ff-bounce-tooltip')).toBeNull();
  });

  it('offers explicit Bounce with reply filtering already off and hides only the selected reply', async () => {
    permalink = true;
    storage.filterReplies = false;
    const reply = post('1');
    const nextReply = post('2', 'synthetic next reply', true);
    await start();
    expect(evaluations).toHaveLength(0);
    await openBounce(reply);
    const input = document.querySelector<HTMLInputElement>('.ff-bounce-input')!;
    input.value = 'rage';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.ff-bounce-confirm')!.click();
    await vi.advanceTimersByTimeAsync(300);
    notifyRecycling(reply);
    await vi.advanceTimersByTimeAsync(50);
    expect(adapter.getPostContainer(reply).style.display).toBe('none');
    expect(adapter.getPostContainer(nextReply).style.display).toBe('');
    expect(adapter.hidePost).toHaveBeenCalledWith(reply, false, expect.any(Function));
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
  it('keeps local label entry usable while Llama.app is unavailable', async () => {
    const article = post('1');
    await startReady();
    change('nativeModelStatus', { state: 'unavailable', message: '', revision: 91 });
    const calls = sendMessage.mock.calls.length;
    await openBounce(article);
    expect(document.querySelector<HTMLInputElement>('.ff-bounce-input')?.disabled).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(calls);
    document.querySelector<HTMLButtonElement>('.ff-bounce-cancel')!.click();
    expect(document.querySelector('.ff-bounce-tooltip')).toBeNull();
  });

  it('shows one native status banner when automatic filtering has phrases and is enabled', async () => {
    post('1');
    await startReady();
    change('nativeModelStatus', { state: 'unavailable', message: '', revision: 91 });
    await vi.advanceTimersByTimeAsync(20);
    const banner = document.querySelector<HTMLElement>('.bouncer-model-status')!;
    expect(banner.classList.contains('visible')).toBe(true);
    expect(document.querySelectorAll('.bouncer-model-status')).toHaveLength(1);
    expect(banner.textContent).toContain('Start Llama.app');
    change('enabled', false);
    expect(banner.classList.contains('visible')).toBe(false);
    change('enabled', true);
    await vi.advanceTimersByTimeAsync(20);
    expect(banner.classList.contains('visible')).toBe(true);
    change('descriptions_twitter', []);
    expect(banner.classList.contains('visible')).toBe(false);
  });

  it('does not submit a reply after its setting changes during store extraction', async () => {
    permalink = true;
    const reply = post('1');
    const lookup = deferred<PostContent | null>();
    vi.spyOn(adapter, 'extractPostContentFromStore').mockReturnValueOnce(lookup.promise);
    await startReady();
    change('filterReplies', false);
    lookup.resolve(adapter.extractPostContent(reply));
    await flush();
    expect(evaluations).toHaveLength(0);
    expect(adapter.getPostContainer(reply).style.display).toBe('');
  });

  it('does not revive an old warning animation after Llama.app is ready', async () => {
    post('1');
    await startReady();
    change('nativeModelStatus', { state: 'unavailable', message: '', revision: 91 });
    change('nativeModelStatus', { state: 'ready', message: '', revision: 92 });
    await vi.advanceTimersByTimeAsync(20);
    expect(document.querySelector('.bouncer-model-status')?.classList.contains('visible')).toBe(false);
  });

  it('keeps the native status banner quiet when stored filters contain only whitespace', async () => {
    storage.descriptions_twitter = [' ', '\n'];
    storage.nativeModelStatus = { state: 'unavailable', message: '', revision: 1 };
    post('1');
    await start();
    await vi.advanceTimersByTimeAsync(20);
    expect(document.querySelector('.bouncer-model-status')?.classList.contains('visible')).not.toBe(true);
  });

});
