// ─── background.js ────────────────────────────────────────────────────────────
// Service worker for Scriptrail.
// Responsibilities:
//   1. Open the report tab when requested by content.js
//   2. Relay toggle (show/hide button) messages to all open Google Docs tabs
//   3. Forward shared edit data back to the originating tab
//   4. Handle theme updates across tabs

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

 // ── 1. Open Report Tab ──────────────────────────────────────────────────────
if (message.action === "openReportTab") {
  const params = new URLSearchParams({
    id: message.id
  });

  const url = chrome.runtime.getURL("report.html") + "?" + params.toString();
  chrome.tabs.create({ url });
}

  // ── 2. Toggle Button Visibility on All Docs Tabs ────────────────────────────
  if (message.action === "toggleUpdate") {
    _broadcastToDocs({
      type: "toggle",
      toggleValue: message.toggleValue
    });
  }

  // ── 3. Forward Shared Edit Data Back to the Sending Tab ────────────────────
  if (message.type === "setData") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      chrome.tabs.sendMessage(tabId, {
        type: "sharedData",
        payload: message.payload
      });
    }
  }

  // ── 4. Refresh Data (re-relay to sending tab) ───────────────────────────────
  if (message.action === "refreshData") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      chrome.tabs.sendMessage(tabId, {
        action: "refreshData",
        payload: message.payload
      });
    }
  }

   // ── 5. Relay writing-time ticks to infoBar.js in the same tab ────────────
  if (message.type === "writingTimeTick") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      chrome.tabs.sendMessage(tabId, {
        type: "writingTimeTick",
        writingTime: message.writingTime,
      }, () => {
        if (chrome.runtime.lastError) { /* tab may not have infoBar yet */ }
      });
    }
  }

  // ── 6. Broadcast theme update to all tabs ───────────────────────────────────
  if (message.action === "themeUpdate") {
    _broadcastToDocs({
      type: "themeUpdate",
      theme: message.theme
    });
  }

  // ── 7. Broadcast infobar visibility update to all tabs ──────────────────────
  if (message.action === "infobarUpdate") {
    _broadcastToDocs({
      type: "infobarUpdate",
      infobarValue: message.infobarValue
    });
  }
});

// ── Helper: broadcast a message to all open Google Docs tabs ──────────────────
function _broadcastToDocs(msg) {
  chrome.tabs.query({ url: "https://docs.google.com/document/*" }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, msg, () => {
        // suppress errors for tabs without the content script yet
        if (chrome.runtime.lastError) { /* noop */ }
      });
    });
  });
}