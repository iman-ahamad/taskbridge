/* TaskBridge — content entry point
 * Detects forms, shows the launcher, watches for page changes (multi-step forms, SPAs,
 * conditional fields) and answers commands from the side panel.
 */
(() => {
  if (window.__taskbridgeLoaded) return;
  window.__taskbridgeLoaded = true;
  const TB = window.TB;

  let lastSig = '';
  let timer = null;

  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      /* extension reloaded; ignore */
    }
  }

  function isSearchOnly(snap) {
    const f = snap.fields.filter((x) => !x.sensitive);
    return f.length === 1 && /search|খুঁজ|query/i.test(`${f[0].label} ${f[0].name} ${f[0].placeholder || ''}`);
  }

  function detect() {
    let snap;
    try {
      snap = TB.scan();
    } catch (e) {
      console.warn('[TaskBridge] scan failed', e);
      return;
    }
    const n = snap.fillableCount;
    const hasForm = n >= 2 || (n === 1 && !isSearchOnly(snap) && !!document.querySelector('form'));
    if (hasForm) TB.overlay.show(n);
    else TB.overlay.hide();

    if (snap.signature !== lastSig) {
      const first = !lastSig;
      lastSig = snap.signature;
      safeSend({ type: 'TB_FORM_DETECTED', count: hasForm ? n : 0 });
      if (!first) safeSend({ type: 'TB_PAGE_CHANGED', signature: snap.signature, count: n });
    }
  }

  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => {
      const t = m.target;
      return !(t && t.nodeType === 1 && (t.id === 'taskbridge-root' || (t.closest && t.closest('#taskbridge-root'))));
    });
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(detect, 600);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden', 'open'],
  });

  window.addEventListener('hashchange', () => setTimeout(detect, 300));
  window.addEventListener('popstate', () => setTimeout(detect, 300));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg && msg.type) {
        case 'TB_PING': {
          const snap = TB.scan();
          sendResponse({ ok: true, url: location.href, count: snap.fillableCount, title: document.title });
          break;
        }
        case 'TB_SCAN':
          sendResponse({ ok: true, snapshot: TB.scan() });
          break;
        case 'TB_FILL':
          sendResponse(TB.fill(msg.fieldId, msg.value));
          break;
        case 'TB_RESTORE':
          sendResponse(TB.restore(msg.fieldId, msg.state));
          break;
        case 'TB_HIGHLIGHT':
          TB.highlight(msg.fieldId);
          sendResponse({ ok: true });
          break;
        case 'TB_CLEAR':
          TB.clearHighlights();
          sendResponse({ ok: true });
          break;
        case 'TB_CLEAR_ALL':
          TB.clearAllMarks();
          sendResponse({ ok: true });
          break;
        case 'TB_VALIDATE':
          sendResponse({ ok: true, errors: TB.validate() });
          break;
        case 'TB_CLICK':
          sendResponse(TB.clickButton(msg.buttonId));
          break;
        case 'TB_SESSION_STATE':
          TB.overlay.setActive(msg.active);
          sendResponse({ ok: true });
          break;
        default:
          return false;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return false;
  });

  detect();
  setTimeout(detect, 1500); // late-rendering SPAs
})();
