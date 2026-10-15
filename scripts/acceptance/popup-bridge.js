// Test-copy-only relay. The production popup bundle and background validation
// remain intact. No permission, recovery, unload, deletion or native API route.
(() => {
  if (window.parent === window || location.pathname !== '/popup.html') return;
  const origin = `chrome-extension://${chrome.runtime.id}`;
  let port = null;
  let token = null;
  let allowConnect = false;
  let busy = false;
  let blocked = false;
  let blockedKind = null;
  let lastId = 0;
  const states = new Set(['not_configured', 'needs_download', 'downloading', 'canceling', 'switching', 'not_connected',
    'ready', 'loading', 'filtering', 'paused', 'missing_model', 'blocked', 'recovery_required', 'error']);
  const ownParent = event => {
    if (event.source !== window.parent || event.origin !== origin) return false;
    try {
      const parentUrl = new URL(window.parent.location.href);
      return parentUrl.protocol === 'chrome-extension:' && parentUrl.hostname === chrome.runtime.id && parentUrl.pathname === '/benchmark.html'
        && parentUrl.search === '' && parentUrl.hash === '';
    } catch { return false; }
  };
  const cleanStatus = value => {
    if (!value || !states.has(value.state) || !Number.isSafeInteger(value.selectionRevision)
        || !Number.isSafeInteger(value.revision)) throw new Error('status_invalid');
    const result = { state: value.state, engine: value.engine, selectionRevision: value.selectionRevision, revision: value.revision };
    if (!['litertlm', 'ollama', null].includes(result.engine)) throw new Error('status_invalid');
    if (typeof value.reason === 'string' && /^[a-z_]{1,80}$/.test(value.reason)) result.reason = value.reason;
    for (const key of ['receivedBytes', 'totalBytes', 'progress']) {
      if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 2_100_000_000) result[key] = value[key];
    }
    if (result.state === 'recovery_required' || result.reason === 'browser_cleanup_failed') {
      blocked = true; blockedKind = result.state === 'recovery_required' ? 'native_recovery' : 'browser_cleanup';
    }
    return result;
  };
  const sanitize = response => {
    if (!response || response.error || !response.selection || !['litertlm', 'ollama', null].includes(response.selection.engine)
        || !Number.isSafeInteger(response.selection.revision)) throw new Error('response_invalid');
    return { success: response.success, selection: { engine: response.selection.engine, revision: response.selection.revision },
      status: cleanStatus(response.status) };
  };
  // Wait only on renderer DOM changes, not background reads. This lets the
  // genuine Connect handler finish its own metadata/readback before continuing.
  const popupSettled = () => new Promise(resolve => {
    const settled = () => {
      const choose = document.getElementById('useEngineButton');
      const check = document.getElementById('checkLocalModelStatus');
      const connect = document.getElementById('connectNativeModel');
      return choose && check && connect && !connect.disabled
        && (!choose.disabled || (!check.hidden && !check.disabled));
    };
    if (settled()) { resolve(); return; }
    const observer = new MutationObserver(() => { if (settled()) { observer.disconnect(); resolve(); } });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  });
  // The only enabled human control is the product's real Connect button. Its
  // own click handler owns chrome.permissions.request and browser Allow UI.
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('button,a,input,label') : null;
    if (!target) return;
    if (target.id === 'connectNativeModel' && allowConnect && !busy && !blocked) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  document.addEventListener('change', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of ['localModelStatus', 'browserModelStatus', 'nativeModelStatus']) {
      const status = changes[key]?.newValue;
      if (status?.state === 'recovery_required' || status?.reason === 'browser_cleanup_failed') {
        blocked = true;
        blockedKind = status.state === 'recovery_required' ? 'native_recovery' : 'browser_cleanup';
        port?.postMessage({ protocol: 'bouncer-acceptance-v1', token, event: 'blocked', kind: blockedKind });
      }
    }
  });
  window.addEventListener('message', event => {
    if (port || !ownParent(event) || event.ports.length !== 1) return;
    const data = event.data;
    if (!data || Object.keys(data).sort().join(',') !== 'allowConnect,protocol,token'
        || data.protocol !== 'bouncer-acceptance-v1' || !/^[a-f0-9]{32}$/.test(data.token ?? '')
        || typeof data.allowConnect !== 'boolean') return;
    token = data.token; allowConnect = data.allowConnect; port = event.ports[0];
    port.onmessage = async message => {
      const request = message.data;
      if (!request || request.protocol !== 'bouncer-acceptance-v1' || request.token !== token
          || !Number.isSafeInteger(request.id) || request.id <= lastId || request.id > 100
          || busy || blocked) {
        if (request?.token === token) port.postMessage({ protocol: 'bouncer-acceptance-v1', token, id: request.id,
          error: blocked ? 'relay_blocked' : 'relay_rejected', ...(blocked ? { kind: blockedKind } : {}) });
        return;
      }
      const keys = Object.keys(request).sort().join(',');
      const selection = request.command === 'selectInferenceEngine'
        && ['litertlm', 'ollama'].includes(request.engine) && keys === 'command,engine,id,protocol,token';
      const other = ['getLocalModelStatus', 'downloadBrowserModel'].includes(request.command)
        && keys === 'command,id,protocol,token';
      if (!selection && !other) {
        port.postMessage({ protocol: 'bouncer-acceptance-v1', token, id: request.id, error: 'relay_rejected' }); return;
      }
      busy = true; lastId = request.id;
      try {
        await popupSettled();
        if (blocked) throw new Error('blocked');
        const response = await chrome.runtime.sendMessage(selection
          ? { type: request.command, engine: request.engine } : { type: request.command });
        const result = sanitize(response);
        port.postMessage({ protocol: 'bouncer-acceptance-v1', token, id: request.id, result });
      } catch {
        port.postMessage({ protocol: 'bouncer-acceptance-v1', token, id: request.id,
          error: blocked ? 'relay_blocked' : 'popup_command_failed', ...(blocked ? { kind: blockedKind } : {}) });
      } finally { busy = false; }
    };
    port.start();
    port.postMessage({ protocol: 'bouncer-acceptance-v1', token, ready: true });
    if (blocked) port.postMessage({ protocol: 'bouncer-acceptance-v1', token, event: 'blocked', kind: blockedKind });
  });
})();
