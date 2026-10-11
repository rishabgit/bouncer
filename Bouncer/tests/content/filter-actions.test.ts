/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DOMPurify from 'dompurify';
import type { BackgroundToContentMessage, EvaluationResult, PlatformAdapter, PostContent } from '../../src/types.js';

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
  let evaluations: Array<{ message: { evaluationId: string; post: string }; resolve: (value: EvaluationResult) => void }>;
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

  async function useRealTwitterAdapter(): Promise<void> {
    const append = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation(node => node instanceof HTMLScriptElement ? node : append(node));
    await import('../../adapters/twitter/TwitterAdapter.js');
    const TwitterAdapter = window.BouncerAdapter;
    vi.spyOn(TwitterAdapter.prototype, 'shouldProcessCurrentPage').mockReturnValue(true);
    vi.spyOn(TwitterAdapter.prototype, 'isMainPost').mockReturnValue(false);
    vi.spyOn(TwitterAdapter.prototype, 'isPermalinkView').mockReturnValue(false);
    vi.spyOn(TwitterAdapter.prototype, 'extractPostContentFromStore').mockImplementation(async article => adapter.extractPostContent(article));
    vi.spyOn(TwitterAdapter.prototype, 'hidePost');
    vi.stubGlobal('BouncerAdapter', class { constructor() { adapter = new TwitterAdapter(); return adapter; } });
  }

  function renderRestorePanel(): HTMLButtonElement {
    const panel = document.createElement('div');
    panel.className = 'filtered-modal-content';
    document.body.appendChild(panel);
    ui.renderFilteredPostsView(panel);
    return panel.querySelector<HTMLButtonElement>('.slop-restore')!;
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
        const evaluation = deferred<EvaluationResult>();
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

  it.each(['custom', 'missed', 'loading missed'])('uses the same atomic chosen-post action for %s', async action => {
    const article = post('1');
    await start();
    if (action === 'loading missed') suggestions = deferred();
    await openBounce(article);
    if (action === 'custom') {
      const input = document.querySelector<HTMLInputElement>('.ff-annoying-custom-input')!;
      input.value = 'rage';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    } else {
      document.querySelector<HTMLElement>('.ff-missed-link')!.click();
    }
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
