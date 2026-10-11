/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadTwitterFixture } from '../fixtures/twitter-dom';
import { formatPostForEvaluation } from '../../src/shared/utils';
import type { PlatformAdapter } from '../../src/types';

let TwitterAdapter: new () => PlatformAdapter;

beforeEach(async () => {
  // Mock IntersectionObserver (not available in happy-dom)
  globalThis.IntersectionObserver = class {
    _cb: IntersectionObserverCallback;
    _opts: IntersectionObserverInit | undefined;
    constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) { this._cb = cb; this._opts = opts; }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
    get root(): Element | Document | null { return null; }
    get rootMargin(): string { return ''; }
    get thresholds(): readonly number[] { return []; }
  } as unknown as typeof IntersectionObserver;

  // Mock chrome extension API before importing the adapter
  globalThis.chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
    } as unknown as typeof chrome.runtime,
  } as typeof chrome;

  // Stub head.appendChild to prevent happy-dom from rejecting chrome-extension:// script loads
  const origAppendChild = document.head.appendChild.bind(document.head);
  document.head.appendChild = function <T extends Node>(node: T): T {
    if (node instanceof HTMLScriptElement && node.src?.startsWith('chrome-extension://')) {
      // Simulate successful load without actually loading
      setTimeout(() => node.onload?.(new Event('load')), 0);
      return node;
    }
    return origAppendChild(node);
  };

  await import('../../adapters/twitter/TwitterAdapter.js');
  TwitterAdapter = window.BouncerAdapter;
});

// ==================== finding tweets ====================

describe('finding tweets', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    loadTwitterFixture();
    adapter = new TwitterAdapter();
  });

  it('finds all tweet articles using the post selector', () => {
    const articles = document.querySelectorAll(adapter.selectors.post);
    expect(articles).toHaveLength(5);
  });

});

describe('filtered post scroll restoration', () => {
  function prepareAboveViewportPost() {
    document.body.innerHTML = '';
    window.location.href = 'https://x.com/home';
    const adapter = new TwitterAdapter();
    const cell = document.createElement('div');
    cell.dataset.testid = 'cellInnerDiv';
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.innerHTML = '<a href="/synthetic/status/1"><time>now</time></a><div data-testid="tweetText">Synthetic original post</div>';
    cell.appendChild(article);
    document.body.appendChild(cell);
    let top = -200;
    cell.getBoundingClientRect = () => ({
      top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100,
      x: 0, y: top, toJSON: () => ({}),
    });
    adapter.hidePost(article);
    top = 120;
    return { adapter, article, cell, setTop: (nextTop: number) => { top = nextTop; } };
  }

  it('does not let a stale fade timer hide a restored cell', () => {
    vi.useFakeTimers();
    try {
      const { cell } = prepareAboveViewportPost();

      window.dispatchEvent(new Event('scroll'));
      expect(cell.style.opacity).toBe('0');

      // Mirrors restoreFilteredContainer without coupling the standalone
      // adapter bundle to the content module.
      delete cell.dataset.filteredByExtension;
      cell.style.display = '';
      cell.style.opacity = '';
      cell.style.transition = '';
      vi.advanceTimersByTime(300);

      expect(cell.style.display).toBe('');
      expect(cell.style.opacity).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still hides the unchanged marked post after the scroll fade', () => {
    vi.useFakeTimers();
    try {
      const { cell } = prepareAboveViewportPost();
      expect(cell.style.display).toBe('');
      window.dispatchEvent(new Event('scroll'));
      expect(cell.style.opacity).toBe('0');
      vi.advanceTimersByTime(300);
      expect(cell.style.display).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['replace article', 'reuse article', 'retain nested original article', 'detach cell'])('vetoes the older scroll fade after X can %s', reuse => {
    vi.useFakeTimers();
    try {
      const { article, cell } = prepareAboveViewportPost();
      window.dispatchEvent(new Event('scroll'));
      expect(cell.style.opacity).toBe('0');

      if (reuse === 'replace article') {
        const replacement = article.cloneNode(true) as HTMLElement;
        article.replaceWith(replacement);
      } else if (reuse === 'reuse article') {
        article.innerHTML = '<a href="/synthetic/status/2"><time>now</time></a><div data-testid="tweetText">Synthetic replacement post</div>';
      } else if (reuse === 'retain nested original article') {
        const replacement = article.cloneNode(true) as HTMLElement;
        article.before(replacement);
        const quote = document.createElement('div');
        quote.setAttribute('role', 'link');
        replacement.appendChild(quote);
        quote.appendChild(article);
      } else {
        cell.remove();
      }
      vi.advanceTimersByTime(300);

      expect(cell.style.display).toBe('');
      expect(cell.style.opacity).toBe('');
      expect(cell.style.transition).toBe('');
      expect(cell.dataset.filteredByExtension).toBeUndefined();
      if (cell.isConnected) {
        window.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(300);
        expect(cell.style.display).toBe('');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('vetoes a recycled unlinked article even when its first 200 text characters are unchanged', () => {
    vi.useFakeTimers();
    try {
      const { adapter, article, cell, setTop } = prepareAboveViewportPost();
      article.innerHTML = `<div data-testid="tweetText">${'a'.repeat(200)} original</div>`;
      // Mark this synthetic no-link identity while still above the viewport.
      setTop(-200);
      adapter.hidePost(article);
      setTop(120);
      window.dispatchEvent(new Event('scroll'));
      expect(cell.style.opacity).toBe('0');
      article.querySelector('[data-testid="tweetText"]')!.textContent = `${'a'.repeat(200)} replacement`;
      vi.advanceTimersByTime(300);
      expect(cell.style.display).toBe('');
      expect(cell.style.opacity).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a newer explicit hide marker while vetoing the older callback', () => {
    vi.useFakeTimers();
    try {
      const { adapter, article, cell, setTop } = prepareAboveViewportPost();
      window.dispatchEvent(new Event('scroll'));
      article.innerHTML = '<a href="/synthetic/status/2"><time>now</time></a><div data-testid="tweetText">Synthetic newly filtered post</div>';
      setTop(-200);
      adapter.hidePost(article);
      setTop(120);
      vi.advanceTimersByTime(300);
      expect(cell.style.display).toBe('');
      expect(cell.style.opacity).toBe('');
      expect(cell.dataset.filteredByExtension).toBe('true');

      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(300);
      expect(cell.style.display).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a recycled already-hidden cell before the scroll display:none early return', () => {
    vi.useFakeTimers();
    try {
      const { article, cell } = prepareAboveViewportPost();
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(300);
      expect(cell.style.display).toBe('none');
      const replacement = article.cloneNode(true) as HTMLElement;
      article.replaceWith(replacement);

      window.dispatchEvent(new Event('scroll'));
      expect(cell.style.display).toBe('');
      expect(cell.style.opacity).toBe('');
      expect(cell.style.transition).toBe('');
      expect(cell.dataset.filteredByExtension).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ==================== extractPostContent ====================

describe('extractPostContent', () => {
  let adapter: PlatformAdapter;
  let articles: HTMLElement[];
  beforeEach(() => {
    loadTwitterFixture();
    adapter = new TwitterAdapter();
    articles = [...document.querySelectorAll(adapter.selectors.post)] as HTMLElement[];
  });

  it('extracts text and author from a text + video tweet', () => {
    // Article 0: Thariq's Claude Code voice mode tweet
    const result = adapter.extractPostContent(articles[0]);
    expect(result.author).toContain('Thariq');
    expect(result.author).toContain('@trq212');
    expect(result.text).toContain('Voice mode is rolling out now in Claude Code');
    expect(result.text).toContain('/voice to toggle it on!');
    const evalText = formatPostForEvaluation(result);
    expect(evalText).toContain('Thariq');
    expect(evalText).toContain('Voice mode');
  });

  it('returns empty text when tweet has no tweetText element', () => {
    // Article 1: Dimitris's image-only tweet (no tweetText)
    const result = adapter.extractPostContent(articles[1]);
    expect(result.text).toBe('');
    expect(result.author).toContain('Dimitris');
    expect(result.author).toContain('@DimitrisPapail');
  });

  it('extracts short tweet text', () => {
    // Article 2: Notion's short tweet
    const result = adapter.extractPostContent(articles[2]);
    expect(result.text).toBe('Allow us to reintroduce ourselves.');
    expect(result.author).toContain('Notion');
    expect(result.author).toContain('@NotionHQ');
  });

  it('extracts truncated tweet text as-is', () => {
    // Article 3: chiefofautism's long tweet (truncated by Twitter's "Show more")
    const result = adapter.extractPostContent(articles[3]);
    expect(result.text).toContain('someone connected LIVING BRAIN CELLS to an LLM');
    expect(result.text).toContain('Cortical Labs');
    expect(result.author).toContain('chiefofautism');
  });

  it('extracts post URL from the timestamp link', () => {
    const result = adapter.extractPostContent(articles[0]);
    expect(result.postUrl).toBe('https://x.com/trq212/status/2028628570692890800');
  });

  it('extracts post URLs for all articles', () => {
    const expectedUrls = [
      'https://x.com/trq212/status/2028628570692890800',
      'https://x.com/DimitrisPapail/status/2028669695344148946',
      'https://x.com/NotionHQ/status/2028533326966088188',
      'https://x.com/chiefofautism/status/2028800881932505187',
      'https://x.com/omarsar0/status/2028823724196343923',
    ];
    articles.forEach((article, i) => {
      const result = adapter.extractPostContent(article);
      expect(result.postUrl).toBe(expectedUrls[i]);
    });
  });

  it('picks up video poster as image URL (amplify_video_thumb)', () => {
    // Article 0: has a video with amplify_video_thumb poster
    const result = adapter.extractPostContent(articles[0]);
    expect(result.imageUrls).toContain(
      'https://pbs.twimg.com/amplify_video_thumb/2028628068517183489/img/pqaAS9fN8tZTs8fY.jpg'
    );
  });

  it('picks up video poster as image URL (pbs.twimg.com/media)', () => {
    // Article 2: Notion's video has a pbs.twimg.com/media poster
    const result = adapter.extractPostContent(articles[2]);
    expect(result.imageUrls).toContain(
      'https://pbs.twimg.com/media/HCbNLTubkAABOG8.jpg'
    );
  });

  it('detects media for tweets with tweetPhoto and videoPlayer', () => {
    // Articles 0, 2, 3 have tweetPhoto + videoPlayer
    for (const idx of [0, 2, 3]) {
      const result = adapter.extractPostContent(articles[idx]);
      expect(result.hasMediaContainer).toBe(true);
    }
  });

  it('detects media for tweet with tweetPhoto only (no video)', () => {
    // Article 4: has tweetPhoto but no videoPlayer
    const result = adapter.extractPostContent(articles[4]);
    expect(result.hasMediaContainer).toBe(true);
  });

  it('reports no media when tweet has no media containers or matching images', () => {
    // Article 1: no tweetPhoto, no videoPlayer, no card.wrapper,
    // and images are local paths (not pbs.twimg.com)
    const result = adapter.extractPostContent(articles[1]);
    expect(result.hasMediaContainer).toBe(false);
  });
});

// ==================== shouldProcessCurrentPage ====================

describe('shouldProcessCurrentPage', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
    document.body.innerHTML = '';
  });

  function setPath(path: string) {
    window.location.href = `https://x.com${path}`;
  }

  function addTabList(tabs: Array<{ text: string; selected: boolean }>) {
    const primaryColumn = document.createElement('main');
    primaryColumn.dataset.testid = 'primaryColumn';
    const nav = document.createElement('nav');
    nav.setAttribute('role', 'navigation');
    const tabBar = document.createElement('div');
    tabBar.setAttribute('role', 'tablist');
    for (const { text, selected } of tabs) {
      const tab = document.createElement('div');
      tab.setAttribute('role', 'tab');
      tab.textContent = text;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tabBar.appendChild(tab);
    }
    nav.appendChild(tabBar);
    primaryColumn.appendChild(nav);
    document.body.appendChild(primaryColumn);
    return tabBar;
  }

  it('returns true on the fixture /home page with For you tab selected', () => {
    loadTwitterFixture();
    setPath('/home');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns true on /home with Following tab selected', () => {
    setPath('/home');
    addTabList([
      { text: 'For you', selected: false },
      { text: 'Following', selected: true },
    ]);
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns true on /home with a localized timeline tab selected', () => {
    setPath('/home');
    addTabList([
      { text: 'おすすめ', selected: true },
      { text: 'フォロー中', selected: false },
    ]);
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('keeps a selected custom feed in the primary Home navigation eligible', () => {
    setPath('/home');
    addTabList([
      { text: 'おすすめ', selected: false },
      { text: 'フォロー中', selected: false },
      { text: 'My custom feed', selected: true },
    ]);
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns false on /home when no tab is selected', () => {
    setPath('/home');
    addTabList([
      { text: 'おすすめ', selected: false },
      { text: 'フォロー中', selected: false },
    ]);
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('ignores a selected tab in an unrelated control outside the timeline navigation', () => {
    setPath('/home');
    const primaryColumn = document.createElement('main');
    primaryColumn.dataset.testid = 'primaryColumn';
    const unrelatedTabList = document.createElement('div');
    unrelatedTabList.setAttribute('role', 'tablist');
    unrelatedTabList.innerHTML = '<div role="tab" aria-selected="true">Media</div>';
    primaryColumn.appendChild(unrelatedTabList);
    document.body.appendChild(primaryColumn);

    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('returns false on /home with no tablist', () => {
    setPath('/home');
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('ignores selected Home-like navigation outside the primary column', () => {
    setPath('/home');
    document.body.innerHTML = '<aside><nav role="navigation"><div role="tablist"><div role="tab" aria-selected="true">For you</div></div></nav></aside>';
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('returns true on status pages', () => {
    setPath('/user/status/12345');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns true on /explore', () => {
    setPath('/explore');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns true on /search paths', () => {
    setPath('/search?q=test');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns false on profile pages', () => {
    setPath('/someuser');
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('returns false on /notifications', () => {
    setPath('/notifications');
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });
});

// ==================== getPostContainer ====================

describe('getPostContainer', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    loadTwitterFixture();
    adapter = new TwitterAdapter();
  });

  it('returns cellInnerDiv wrapper for fixture articles', () => {
    const articles = document.querySelectorAll(adapter.selectors.post);
    for (const article of articles) {
      const container = adapter.getPostContainer(article as HTMLElement);
      expect(container.dataset.testid).toBe('cellInnerDiv');
    }
  });

  it('returns article itself when no cellInnerDiv', () => {
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    document.body.appendChild(article);
    expect(adapter.getPostContainer(article)).toBe(article);
    article.remove();
  });
});

// ==================== getThemeMode ====================

describe('getThemeMode', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
  });

  it('detects light mode from the fixture page', () => {
    loadTwitterFixture();
    expect(adapter.getThemeMode()).toBe('light');
  });

  it('returns dark for black background', () => {
    document.body.style.backgroundColor = 'rgb(0, 0, 0)';
    expect(adapter.getThemeMode()).toBe('dark');
  });

  it('returns dim for Twitter dim mode', () => {
    document.body.style.backgroundColor = 'rgb(21, 32, 43)';
    expect(adapter.getThemeMode()).toBe('dim');
  });

  it('defaults to dark when no bg color parseable', () => {
    document.body.style.backgroundColor = '';
    expect(adapter.getThemeMode()).toBe('dark');
  });
});

// ==================== isMainPost ====================

describe('isMainPost', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
    document.body.innerHTML = '';
  });

  function setPath(path: string) {
    window.location.href = `https://x.com${path}`;
  }

  function buildConversationTimeline(label: string, statuses: Array<string | null>) {
    const timeline = document.createElement('div');
    timeline.setAttribute('aria-label', label);
    const articles: HTMLElement[] = [];
    for (const status of statuses) {
      const article = document.createElement('article');
      article.setAttribute('data-testid', 'tweet');
      article.innerHTML = status
        ? `<div data-testid="User-Name"><a role="link" href="/user/status/${status}"><time>now</time></a></div>`
        : '<time>now</time>';
      timeline.appendChild(article);
      articles.push(article);
    }
    document.body.appendChild(timeline);
    return articles;
  }

  it.each(['Timeline: Conversation', 'Cronología: Conversación'])('protects the opened reply rather than its first ancestor in %s', label => {
    setPath('/user/status/12345');
    const articles = buildConversationTimeline(label, ['98765', '12345', '67890']);
    expect(adapter.isMainPost(articles[0])).toBe(false);
    expect(adapter.isMainPost(articles[1])).toBe(true);
    expect(adapter.isMainPost(articles[2])).toBe(false);
  });

  it('protects an opened post whose own timestamp is not linked, after its ancestor', () => {
    setPath('/user/status/12345');
    const articles = buildConversationTimeline('Timeline: Conversation', ['98765', null, '67890']);
    expect(adapter.isMainPost(articles[0])).toBe(false);
    expect(adapter.isMainPost(articles[1])).toBe(true);
    expect(adapter.isMainPost(articles[2])).toBe(false);
  });

  it('returns false on the home page regardless of article', () => {
    setPath('/home');
    const articles = buildConversationTimeline('Timeline: Conversation', ['12345', null]);
    expect(adapter.isMainPost(articles[0])).toBe(false);
    expect(adapter.isMainPost(articles[1])).toBe(false);
  });

  it.each([
    '<a role="link" href="/quoted/status/12345"><time>quoted</time></a>',
    '<time>quoted</time>',
  ])('does not protect a reply that quotes the current page post: %s', quoteTimestamp => {
    setPath('/user/status/12345');
    const [reply] = buildConversationTimeline('Cronología: Conversación', ['67890']);
    reply.insertAdjacentHTML('afterbegin', `<div role="link" tabindex="0">${quoteTimestamp}<div data-testid="tweetText">Quoted post</div></div>`);

    expect(adapter.isMainPost(reply)).toBe(false);
    expect(adapter.getPostUrl(reply)).toBe('https://x.com/user/status/67890');
  });

  it('protects the opened post when a linked quote precedes its own matching timestamp', () => {
    setPath('/user/status/12345');
    const [main] = buildConversationTimeline('Cronología: Conversación', ['12345']);
    main.insertAdjacentHTML('afterbegin', '<div role="link"><a href="/quoted/status/98765"><time>quoted</time></a><div data-testid="tweetText">Quoted post</div></div>');

    expect(adapter.isMainPost(main)).toBe(true);
    expect(adapter.getPostUrl(main)).toBe('https://x.com/user/status/12345');
  });

  it('keeps the no-self-link fallback when the opened post quotes a different status', () => {
    setPath('/user/status/12345');
    const [main] = buildConversationTimeline('Timeline: Conversation', [null]);
    main.insertAdjacentHTML('afterbegin', '<div role="link"><a href="/quoted/status/98765"><time>quoted</time></a><div data-testid="tweetText">Quoted post</div></div>');

    expect(adapter.isMainPost(main)).toBe(true);
    expect(adapter.getPostUrl(main)).toBeNull();
  });

  it('ignores a timestamp inside an anchor wrapping a whole quoted post', () => {
    setPath('/user/status/12345');
    const [reply] = buildConversationTimeline('Timeline: Conversation', ['67890']);
    reply.insertAdjacentHTML('afterbegin', '<a role="link" href="/quoted/status/12345"><time>quoted</time><div data-testid="tweetText">Quoted post</div></a>');
    expect(adapter.isMainPost(reply)).toBe(false);
    expect(adapter.getPostUrl(reply)).toBe('https://x.com/user/status/67890');
  });

  it('ignores nested article, media, action-group, and text timestamps', () => {
    setPath('/user/status/12345');
    const [reply] = buildConversationTimeline('Timeline: Conversation', ['67890']);
    reply.insertAdjacentHTML('afterbegin', `
      <article data-testid="tweet"><a href="/nested/status/12345"><time>nested</time></a></article>
      <div data-testid="videoPlayer"><a href="/media/status/12345"><time>media</time></a></div>
      <div data-testid="card.wrapper"><a href="/card/status/12345"><time>card</time></a></div>
      <div role="group"><a href="/action/status/12345"><time>action</time></a></div>
      <div data-testid="tweetText"><a href="/text/status/12345"><time>text</time></a></div>
    `);
    expect(adapter.isMainPost(reply)).toBe(false);
    expect(adapter.getPostUrl(reply)).toBe('https://x.com/user/status/67890');
  });

  it('ignores external and non-status timestamp URLs before the post timestamp', () => {
    setPath('/user/status/12345');
    const [reply] = buildConversationTimeline('Timeline: Conversation', ['67890']);
    reply.insertAdjacentHTML('afterbegin', '<a href="http://["><time>malformed</time></a><a href="https://example.com/user/status/12345"><time>external</time></a><a href="/search?q=12345"><time>search</time></a>');
    expect(adapter.isMainPost(reply)).toBe(false);
    expect(adapter.getPostUrl(reply)).toBe('https://x.com/user/status/67890');
  });

  it('accepts the canonical Twitter and i/web status timestamp routes', () => {
    setPath('/user/status/12345');
    const [main] = buildConversationTimeline('Timeline: Conversation', [null]);
    main.innerHTML = '<a href="https://twitter.com/i/web/status/12345?lang=es"><time>now</time></a>';
    expect(adapter.isMainPost(main)).toBe(true);
    expect(adapter.getPostUrl(main)).toBe('https://twitter.com/i/web/status/12345?lang=es');
  });

  it('protects a post with no own timestamp while the DOM is incomplete', () => {
    setPath('/user/status/12345');
    const [main] = buildConversationTimeline('Cronología: Conversación', [null]);
    main.innerHTML = '<div data-testid="tweetText">Loading timestamp</div>';
    expect(adapter.isMainPost(main)).toBe(true);
    expect(adapter.getPostUrl(main)).toBeNull();
  });
});

// ==================== localized action controls ====================

describe('post action controls', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
    document.body.innerHTML = '';
  });

  function buildActions(wrapperDepth = 2) {
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    for (const testid of ['reply', 'retweet', 'like', 'bookmark']) {
      const action = document.createElement('button');
      action.dataset.testid = testid;
      group.appendChild(action);
    }
    const share = document.createElement('button');
    share.setAttribute('aria-label', 'Compartir post');
    let shareAction: HTMLElement = share;
    for (let i = 0; i < wrapperDepth; i++) {
      const wrapper = document.createElement('div');
      wrapper.appendChild(shareAction);
      shareAction = wrapper;
    }
    group.appendChild(shareAction);
    article.appendChild(group);
    document.body.appendChild(article);
    return { article, group, share, shareAction };
  }

  it('finds the real fixture English share controls', () => {
    loadTwitterFixture();
    const articles = document.querySelectorAll<HTMLElement>(adapter.selectors.post);
    for (const article of articles) {
      expect(adapter.getShareButton(article)?.getAttribute('aria-label')).toBe('Share post');
    }
  });

  it('finds the localized untagged share button in the reply action group', () => {
    const { article, share } = buildActions();
    expect(adapter.getShareButton(article)).toBe(share);
  });

  it('ignores quoted and media action groups before and after the native action bar', () => {
    const { article, share } = buildActions();
    article.insertAdjacentHTML('afterbegin', `
      <div role="link"><div role="group"><button data-testid="reply"></button><button aria-label="Share post"></button></div></div>
      <div data-testid="videoPlayer"><div role="group"><button aria-label="Share post"></button></div></div>
      <div role="group"><button>Other control</button></div>
    `);
    article.insertAdjacentHTML('beforeend', '<div role="group"><button>Another control</button></div>');
    expect(adapter.getShareButton(article)).toBe(share);
  });

  it('ignores a nested widget inside the native action bar', () => {
    const { article, group, share } = buildActions();
    group.insertAdjacentHTML('beforeend', '<div role="group"><button>Nested control</button></div>');
    expect(adapter.getShareButton(article)).toBe(share);
  });

  it('does not treat bookmark as share when the untagged action is absent', () => {
    const { article, shareAction } = buildActions();
    shareAction.remove();
    expect(adapter.getShareButton(article)).toBeNull();
  });

  it('does not borrow a role=group from outside the containing article', () => {
    document.body.innerHTML = '<div role="group"><article data-testid="tweet"><button data-testid="reply"></button></article><button>Other control</button></div>';
    const article = document.querySelector<HTMLElement>(adapter.selectors.post)!;
    expect(adapter.getShareButton(article)).toBeNull();
  });

  it.each([0, 1, 2, 3])('inserts Bounce into the native action bar with %i share wrappers', wrapperDepth => {
    const { article, group, shareAction } = buildActions(wrapperDepth);
    const bounce = document.createElement('div');
    bounce.className = 'ff-why-annoying-btn';
    adapter.insertActionButton(article, bounce);
    expect(bounce.parentElement).toBe(group);
    expect(shareAction.nextElementSibling).toBe(bounce);
  });

  it('inserts next to an English share button when no action group is present', () => {
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.innerHTML = '<div><button aria-label="Share post"></button></div>';
    document.body.appendChild(article);
    const bounce = document.createElement('div');
    adapter.insertActionButton(article, bounce);
    expect(article.querySelector('button')?.nextElementSibling).toBe(bounce);
    expect(article.contains(bounce)).toBe(true);
  });

  it('leaves the supplied Bounce action detached when the native action is unavailable', () => {
    const article = document.createElement('article');
    const bounce = document.createElement('div');
    adapter.insertActionButton(article, bounce);
    expect(bounce.parentElement).toBeNull();
  });
});

describe('search form', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
    document.body.innerHTML = '';
  });

  it('finds the localized role=search form', () => {
    document.body.innerHTML = '<form role="search" aria-label="Buscar"></form>';
    expect(adapter.getSearchForm()).toBe(document.querySelector('form'));
  });

  it('prefers role=search over an earlier English-labeled form', () => {
    document.body.innerHTML = '<form aria-label="Search"></form><form role="search" aria-label="Buscar"></form>';
    expect(adapter.getSearchForm()).toBe(document.querySelector('form[role="search"]'));
  });

  it('retains the English label fallback', () => {
    document.body.innerHTML = '<form aria-label="Search"></form>';
    expect(adapter.getSearchForm()).toBe(document.querySelector('form'));
  });

  it('returns null when only an unrelated non-form search landmark exists', () => {
    document.body.innerHTML = '<div role="search"></div><form aria-label="Compose"></form>';
    expect(adapter.getSearchForm()).toBeNull();
  });
});

// ==================== hidePost ====================

describe('hidePost', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
    document.body.innerHTML = '';
  });

  function createPostWithContainer(rectTop: number) {
    const container = document.createElement('div');
    container.setAttribute('data-testid', 'cellInnerDiv');
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    container.appendChild(article);
    document.body.appendChild(container);

    // Mock getBoundingClientRect on the container
    container.getBoundingClientRect = () => ({
      top: rectTop, bottom: rectTop + 200, left: 0, right: 400, width: 400, height: 200,
      x: 0, y: rectTop, toJSON() {},
    });

    return { article, container };
  }

  it('marks posts entirely above viewport without hiding', () => {
    const { article, container } = createPostWithContainer(-300);
    adapter.hidePost(article);
    expect(container.dataset.filteredByExtension).toBe('true');
    expect(container.style.display).not.toBe('none');
    expect(container.style.visibility).not.toBe('hidden');
  });

  it('uses display:none for posts partially above viewport (overlapping)', () => {
    const { article, container } = createPostWithContainer(-100);
    adapter.hidePost(article);
    expect(container.style.display).toBe('none');
  });

  it('uses display:none for posts at or below viewport', () => {
    const { article, container } = createPostWithContainer(0);
    adapter.hidePost(article);
    expect(container.style.display).toBe('none');
  });

  it('uses display:none for posts well below viewport', () => {
    const { article, container } = createPostWithContainer(500);
    adapter.hidePost(article);
    expect(container.style.display).toBe('none');
  });

  it('sets data-filtered-by-extension attribute', () => {
    const { article, container } = createPostWithContainer(100);
    adapter.hidePost(article);
    expect(container.dataset.filteredByExtension).toBe('true');
  });

  function markThreadedReply(article: HTMLElement) {
    article.innerHTML = '<div></div><div><div><div><div><span></span><span></span></div></div></div></div>';
  }

  it('keeps the default automatic cascade through threaded siblings', () => {
    const main = createPostWithContainer(100);
    const reply = createPostWithContainer(100);
    markThreadedReply(reply.article);
    const unrelated = createPostWithContainer(100);
    adapter.hidePost(main.article);
    expect(main.container.style.display).toBe('none');
    expect(reply.container.style.display).toBe('none');
    expect(unrelated.container.style.display).toBe('');
    expect(unrelated.container.dataset.filteredByExtension).toBeUndefined();
    // A collateral reply's unchanged identity remains Bouncer-owned.
    expect(adapter.restoreRecycledPost(reply.article)).toBe(false);
    expect(reply.container.style.display).toBe('none');
  });

  it('uses deferred scroll fading for a manual single-post hide without hiding its threaded sibling', () => {
    vi.useFakeTimers();
    try {
      const main = createPostWithContainer(-300);
      const reply = createPostWithContainer(100);
      markThreadedReply(reply.article);
      adapter.hidePost(main.article, false);
      expect(main.container.dataset.filteredByExtension).toBe('true');
      expect(main.container.style.display).toBe('');
      expect(reply.container.dataset.filteredByExtension).toBeUndefined();
      expect(reply.container.style.display).toBe('');

      main.container.getBoundingClientRect = () => ({
        top: 120, bottom: 320, left: 0, right: 400, width: 400, height: 200,
        x: 0, y: 120, toJSON() {},
      });
      window.dispatchEvent(new Event('scroll'));
      expect(main.container.style.opacity).toBe('0');
      vi.advanceTimersByTime(300);
      expect(main.container.style.display).toBe('none');
      expect(reply.container.style.display).toBe('');
      expect(reply.container.dataset.filteredByExtension).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a replacement article that receives KEEP inside the old hidden cell', () => {
    const { article, container } = createPostWithContainer(100);
    adapter.hidePost(article, false);
    const replacement = article.cloneNode(true) as HTMLElement;
    article.replaceWith(replacement);
    expect(container.style.display).toBe('none');
    expect(adapter.restoreRecycledPost(replacement)).toBe(true);
    // A subsequent KEEP needs no additional hide/restore call.
    expect(container.style.display).toBe('');
    expect(container.dataset.filteredByExtension).toBeUndefined();
    expect(adapter.restoreRecycledPost(replacement)).toBe(false);
  });

  it('restores reused content in the same article but preserves an unchanged hide', () => {
    const { article, container } = createPostWithContainer(100);
    article.innerHTML = '<div data-testid="tweetText">Synthetic original</div>';
    adapter.hidePost(article, false);
    expect(adapter.restoreRecycledPost(article)).toBe(false);
    expect(container.style.display).toBe('none');
    article.querySelector('[data-testid="tweetText"]')!.textContent = 'Synthetic replacement';
    expect(adapter.restoreRecycledPost(article)).toBe(true);
    expect(container.style.display).toBe('');
  });

  it('does not restore native hidden state without a current Bouncer marker and record', () => {
    const { article, container } = createPostWithContainer(100);
    container.style.display = 'none';
    container.style.opacity = '0.5';
    container.style.transition = 'opacity 1s ease';
    expect(adapter.restoreRecycledPost(article)).toBe(false);
    container.dataset.filteredByExtension = 'true';
    expect(adapter.restoreRecycledPost(article)).toBe(false);
    expect(container.style.display).toBe('none');
    expect(container.style.opacity).toBe('0.5');
    expect(container.style.transition).toBe('opacity 1s ease');
  });

  it('does not use an old record to restore native state after Bouncer ownership was cleared', () => {
    const { article, container } = createPostWithContainer(100);
    adapter.hidePost(article, false);
    delete container.dataset.filteredByExtension;
    const replacement = article.cloneNode(true) as HTMLElement;
    article.replaceWith(replacement);
    expect(adapter.restoreRecycledPost(replacement)).toBe(false);
    expect(container.style.display).toBe('none');
  });

  it('does not let a nested article revoke the unchanged primary post hide', () => {
    const { article, container } = createPostWithContainer(100);
    const quote = document.createElement('article');
    quote.dataset.testid = 'tweet';
    article.appendChild(quote);
    adapter.hidePost(article, false);
    expect(adapter.restoreRecycledPost(quote)).toBe(false);
    expect(container.style.display).toBe('none');
    expect(container.dataset.filteredByExtension).toBe('true');
  });

  it('assigns fresh ownership when a replacement is explicitly hidden again', () => {
    const { article, container } = createPostWithContainer(100);
    adapter.hidePost(article, false);
    const replacement = article.cloneNode(true) as HTMLElement;
    article.replaceWith(replacement);
    // Returning above the viewport must use the new deferred hide, rather
    // than preserving the former article's inherited display:none.
    container.getBoundingClientRect = () => ({
      top: -300, bottom: -100, left: 0, right: 400, width: 400, height: 200,
      x: 0, y: -300, toJSON() {},
    });
    adapter.hidePost(replacement, false);
    expect(container.style.display).toBe('');
    expect(container.dataset.filteredByExtension).toBe('true');
    expect(adapter.restoreRecycledPost(replacement)).toBe(false);
  });
});
