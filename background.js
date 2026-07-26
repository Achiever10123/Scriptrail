// ─── background.js ────────────────────────────────────────────────────────────
// Service worker for Scriptrail.
// Responsibilities:
//   1. Open the report tab when requested by content.js
//   2. Relay toggle (show/hide button) messages to all open Google Docs tabs
//   3. Forward shared edit data back to the originating tab
//   4. Handle theme updates across tabs

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Handle fetchRevisionData request from content script ────────────────────
  if (message.type === "fetchRevisionData") {
    const { documentId, documentToken, baseurl } = message;
    
    // Validate token format
    if (!/^[a-zA-Z0-9_-]+$/.test(documentToken)) {
      sendResponse({ error: "Invalid token format" });
      return true;
    }

    const tilesUrl = `${baseurl}${documentId}/revisions/tiles?id=${documentId}&start=1&showDetailedRevisions=false&token=${encodeURIComponent(documentToken)}`;
    const loadUrl = `${baseurl}${documentId}/revisions/load?id=${documentId}&start=1&end=REPLACE_END&token=${encodeURIComponent(documentToken)}`;

    // First fetch tiles to get total revisions
    fetch(tilesUrl)
      .then((r) => {
        if (!r.ok) throw new Error("tiles fetch failed");
        return r.text();
      })
      .then((text) => {
        const json = JSON.parse(text.slice(")]}'".length));
        const totalRevs = json.tileInfo[json.tileInfo.length - 1].end;
        const userMap = json.userMap;

        // Then fetch revision data
        const finalLoadUrl = loadUrl.replace("REPLACE_END", totalRevs);
        return fetch(finalLoadUrl)
          .then((r) => {
            if (!r.ok) throw new Error("revision load failed");
            return r.text();
          })
          .then((text) => {
            const changelog = JSON.parse(text.slice(")]}'".length)).changelog;
            sendResponse({ totalRevs, userMap, changelog });
          });
      })
      .catch((e) => {
        console.error("[Scriptrail background] fetch error:", e);
        sendResponse({ error: e.message });
      });

    return true; // Keep channel open for async response
  }

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