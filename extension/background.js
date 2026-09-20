// TaskBridge — background service worker
// Opens the side panel, shows the detected-field count on the toolbar icon,
// and runs first-time setup.

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn('[TaskBridge] setPanelBehavior failed', e);
  }
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  // Floating badge on the page was clicked → open the side panel.
  // sidePanel.open() must be called synchronously inside the user-gesture chain,
  // so nothing is awaited before it.
  if (msg.type === 'TB_OPEN_PANEL' && sender.tab) {
    chrome.sidePanel
      .open({ tabId: sender.tab.id })
      .then(() => sendResponse({ ok: true }))
      .catch(() =>
        chrome.sidePanel
          .open({ windowId: sender.tab.windowId })
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }))
      );
    return true; // async response
  }

  if (msg.type === 'TB_FORM_DETECTED' && sender.tab) {
    const tabId = sender.tab.id;
    const text = msg.count > 0 ? String(msg.count) : '';
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#0F5B43' }).catch(() => {});
    return false;
  }

  if (msg.type === 'TB_OPEN_MIC_SETUP') {
    chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
