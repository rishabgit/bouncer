// Stand-ins for the extension APIs the content scripts call. Filter actions
// update storage and fire onChanged as the background worker does. Every post
// stays visible unless bouncerHarness.classify is replaced, for example:
//   bouncerHarness.classify = m => m.post.includes('price')
//     ? { shouldHide: true, reasoning: 'harness', matches: ['crypto price hype'] }
//     : { shouldHide: false, reasoning: 'harness', matches: [] };
(() => {
  const storage = {
    enabled: true,
    nativeModelStatus: { state: 'ready', message: '', revision: 1 },
    descriptions_twitter: ['crypto price hype'],
    strictFilters_twitter: [],
  };
  const listeners = [];
  const messages = [];

  function write(values) {
    const changes = {};
    for (const [key, newValue] of Object.entries(values)) {
      changes[key] = { oldValue: storage[key], newValue };
      storage[key] = newValue;
    }
    // chrome.storage delivers onChanged after the write resolves.
    setTimeout(() => listeners.forEach(listener => listener(changes, 'local')));
  }

  function setPhrases(phrases) {
    // The worker drops a removed phrase's Strict entry in the same write.
    write({
      descriptions_twitter: phrases,
      strictFilters_twitter: storage.strictFilters_twitter.filter(phrase => phrases.includes(phrase)),
    });
  }

  // The worker's checks before it adds a phrase.
  function addPhrase(phrase) {
    const phrases = storage.descriptions_twitter;
    if (phrases.includes(phrase)) return false;
    if (phrases.length >= 10) throw new Error('You can use up to 10 filters. Remove a filter before adding another.');
    if ([...phrases, phrase].join('').length > 1000) throw new Error('Filter phrases exceed the 1000-character limit.');
    setPhrases([...phrases, phrase]);
    return true;
  }

  const harness = {
    storage,
    messages,
    set: write,
    classify: () => ({ shouldHide: false, reasoning: 'Harness keep', matches: [] }),
  };
  window.bouncerHarness = harness;

  // Every message type the content script sends, answered as the worker does.
  async function handle(message) {
    switch (message.type) {
      case 'pageLoad':
      case 'clearSinglePost':
      case 'overrideCacheEntry':
        return { success: true };
      case 'evaluatePost':
        return harness.classify(message);
      case 'bouncePost':
        addPhrase(message.phrase);
        return { success: true };
      case 'addFilterPhrase':
        return { success: true, added: addPhrase(message.phrase) };
      case 'removeFilterPhrase':
        setPhrases(storage.descriptions_twitter.filter(phrase => phrase !== message.phrase));
        return { success: true };
      case 'setFilterStrictness': {
        const others = storage.strictFilters_twitter.filter(phrase => phrase !== message.phrase);
        write({ strictFilters_twitter: message.strict ? [...others, message.phrase] : others });
        return { success: true };
      }
      case 'getReasoning':
        return { found: false, reasoning: 'Post not yet evaluated' };
      default:
        return { error: `Unknown message type: ${message.type}` };
    }
  }

  function pick(keys) {
    const list = keys == null ? Object.keys(storage)
      : Array.isArray(keys) ? keys
        : typeof keys === 'string' ? [keys] : Object.keys(keys);
    return Object.fromEntries(list.filter(key => key in storage).map(key => [key, storage[key]]));
  }

  window.chrome = {
    runtime: {
      id: 'bouncer-ui-harness',
      getManifest: () => ({ manifest_version: 3, name: 'Bouncer', version: '0.0.0-harness' }),
      getURL: path => new URL(`/ext/${path.replace(/^\//, '')}`, location.origin).href,
      onMessage: { addListener() {} },
      sendMessage: async message => {
        messages.push(message);
        try {
          return await handle(message);
        } catch (error) {
          return message.type === 'evaluatePost'
            ? { retry: true, reasoning: error.message, retryAfterMs: 1000 }
            : { success: false, error: error.message };
        }
      },
    },
    storage: {
      local: {
        get: async keys => pick(keys),
        set: async values => write(values),
        remove: async keys => {
          const changes = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (!(key in storage)) continue;
            changes[key] = { oldValue: storage[key] };
            delete storage[key];
          }
          setTimeout(() => listeners.forEach(listener => listener(changes, 'local')));
        },
      },
      onChanged: { addListener: listener => listeners.push(listener) },
    },
  };
})();
