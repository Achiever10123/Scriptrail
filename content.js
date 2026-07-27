// ─── content.js ───────────────────────────────────────────────────────────────
// Injected into every Google Docs page.
// Note: utils.js must be loaded before this file (see manifest.json)

// ══════════════════════════════════════════════════════════════════════════════
// IMPORTS FROM utils.js (available globally when loaded via manifest)
// ══════════════════════════════════════════════════════════════════════════════
// These functions are provided by utils.js:
// - isCtxValid(), safeSend(), safeStorageGet(), safeStorageSet()
// - isValidToken(), escapeHtml(), SCRIPTRAIL_CONFIG
// - formatWritingTime(), logError(), withTimeout()

// ══════════════════════════════════════════════════════════════════════════════
// PAGE DATA  (document ID, base URL, auth token)
// ══════════════════════════════════════════════════════════════════════════════
const _urlMatch = window.location.href.match(/\/document\/d\/([^/]+)/);
const documentId = _urlMatch ? _urlMatch[1] : "";

const _embedMeta = document.querySelector('meta[itemprop="embedURL"]');
const _ogMeta = document.querySelector('meta[property="og:url"]');
const _sourceUrl =
  _embedMeta?.getAttribute("content") ||
  _ogMeta?.getAttribute("content") ||
  window.location.href;
const _dIdx = _sourceUrl.indexOf("/d/");
const baseurl =
  _dIdx !== -1
    ? _sourceUrl.substring(0, _dIdx + 3)
    : "https://docs.google.com/document/d/";

let documentToken = "";
let _tokenExtracted = false;

function extractToken() {
  if (_tokenExtracted) return true;

  const scripts = document.getElementsByTagName("script");
  for (let i = 0; i < scripts.length; i++) {
    const txt = scripts[i].textContent;
    if (!txt) continue;

    // Preferred: token nested under info_params, tolerant of any token charset.
    if (!documentToken) {
      const ipMatch = txt.match(/"info_params"\s*:\s*\{[^{}]*?"token"\s*:\s*"([^"\\]+)"/);
      if (ipMatch?.[1]) {
        documentToken = ipMatch[1];
        _tokenExtracted = true;
        console.log("[Scriptrail] token found via info_params pattern");
        return true;
      }
    }

    // Fallback 1: plain unescaped "token":"...".
    if (!documentToken) {
      const tm = txt.match(/"token"\s*:\s*"([^"\\]+)"/);
      if (tm?.[1]) {
        documentToken = tm[1];
        _tokenExtracted = true;
        console.log("[Scriptrail] token found via plain fallback pattern");
        return true;
      }
    }

    // Fallback 2: escaped quotes from double-encoded JSON (\"token\":\"...\").
    if (!documentToken) {
      const tm2 = txt.match(/\\"token\\"\s*:\s*\\"([^"\\]+)\\"/);
      if (tm2?.[1]) {
        documentToken = tm2[1];
        _tokenExtracted = true;
        console.log("[Scriptrail] token found via escaped fallback pattern");
        return true;
      }
    }
  }
  return false;
}

let _tokenRetries = 0;
let _tokenObserver = null;
function tryExtractToken() {
  if (documentToken || _tokenRetries > SCRIPTRAIL_CONFIG.TOKEN_RETRY_LIMIT) {
    if (!documentToken) logError("tryExtractToken", "gave up, no token found in page scripts");
    return;
  }
  if (!extractToken()) {
    _tokenRetries++;
    setTimeout(tryExtractToken, SCRIPTRAIL_CONFIG.POLL_INTERVAL_MS / 10);
  } else if (_tokenObserver) {
    _tokenObserver.disconnect();
    _tokenObserver = null;
  }
}

// Some Docs scripts (e.g. the one carrying info_params/token) are injected
// well after document_end. Watch for new <script> tags landing and re-scan
// immediately instead of waiting on the next poll tick.
function _watchForTokenScripts() {
  if (_tokenObserver || documentToken) return;
  _tokenObserver = new MutationObserver((mutations) => {
    if (documentToken) {
      _tokenObserver.disconnect();
      _tokenObserver = null;
      return;
    }
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeName === "SCRIPT") {
          if (extractToken()) {
            _tokenObserver.disconnect();
            _tokenObserver = null;
          }
          return;
        }
      }
    }
  });
  _tokenObserver.observe(document.documentElement, { childList: true, subtree: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// WRITING TIME  — MS Word style: real elapsed time while tab is active
// ══════════════════════════════════════════════════════════════════════════════
let _writingMs = 0; // total accumulated ms
let _sessionStart = null; // Date.now() when current active period began
let _writingInterval = null;

function _startWritingTimer() {
  if (_sessionStart !== null) return; // already running
  _sessionStart = Date.now();
  _writingInterval = setInterval(_tickWritingTimer, 1000);
}

function _stopWritingTimer() {
  if (_sessionStart === null) return;
  _writingMs += Date.now() - _sessionStart;
  _sessionStart = null;
  clearInterval(_writingInterval);
  _writingInterval = null;
}

function _tickWritingTimer() {
  // push a live update to the infobar every second
  _broadcastWritingTime();
}

function _totalWritingMs() {
  return _writingMs + (_sessionStart !== null ? Date.now() - _sessionStart : 0);
}

function _formatWritingTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} hr ${m} min ${sec} sec`;
  if (m > 0) return `${m} min ${sec} sec`;
  return `${sec} sec`;
}

// Start timer when tab gains focus, stop when it loses it
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    _startWritingTimer();
  } else {
    _stopWritingTimer();
  }
});

// Also start immediately if already visible
if (document.visibilityState === "visible") _startWritingTimer();

// ══════════════════════════════════════════════════════════════════════════════
// BUTTON INJECTION
// ══════════════════════════════════════════════════════════════════════════════
let button = null;

function injectStylesheet() {
  if (!isCtxValid()) return;
  if (document.getElementById("scriptrail-style")) return;
  try {
    const link = document.createElement("link");
    link.id = "scriptrail-style";
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = chrome.runtime.getURL("docsStyle.css");
    document.head.appendChild(link);
  } catch (_) {}
}

function injectButton() {
  if (document.getElementById("scriptrailBtn")) return true;
  const toolbar =
    document.querySelector(".docs-titlebar-buttons") ||
    document.querySelector(".docs-titlebar") ||
    document.querySelector("div[role='toolbar']");
  if (!toolbar) return false;

  const wrapper = document.createElement("div");
  const buttonEl = document.createElement("button");
  buttonEl.id = "scriptrailBtn";
  buttonEl.disabled = true;
  buttonEl.textContent = "View Report";
  wrapper.appendChild(buttonEl);
  toolbar.appendChild(wrapper);

  button = document.getElementById("scriptrailBtn");
  if (button) {
    button.addEventListener("click", handleButtonClick);
    return true;
  }
  return false;
}

let _btnRetries = 0;
function tryInjectButton() {
  if (_btnRetries > SCRIPTRAIL_CONFIG.BUTTON_RETRY_LIMIT) return;
  if (!injectButton()) {
    _btnRetries++;
    setTimeout(tryInjectButton, 300);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BUTTON CLICK
// ══════════════════════════════════════════════════════════════════════════════
const documentTitle = document.title;

function handleButtonClick() {
  const chapters = {};
  document.querySelectorAll(".chapter-container").forEach((el) => {
    let id = el.id;
    if (id === "chapter-container-") id = "first";
    const label = el.querySelector(".chapter-label-content");
    chapters[id] = label ? label.textContent.trim() : "";
  });

  safeStorageSet(
    {
      [`report_${documentId}`]: {
        token: documentToken,
        baseurl,
        title: documentTitle,
        tabs: chapters,
      },
    },
    () => {
      safeSend({ action: "openReportTab", id: documentId });
    },
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// REVISION FETCHING
// ══════════════════════════════════════════════════════════════════════════════
function fetchDataForInfobar() {
  if (!documentId || !documentToken) return;
  
  // CRITICAL: Validate token format to prevent injection attacks
  if (!isValidToken(documentToken)) {
    logError("fetchDataForInfobar", `Invalid token format (length: ${documentToken?.length})`);
    safeSend({ type: "setData", payload: { edits: [], error: true, message: "Invalid token" } });
    return;
  }
  
  const tilesUrl = `${baseurl}${documentId}/revisions/tiles?id=${documentId}&start=1&showDetailedRevisions=false&token=${encodeURIComponent(documentToken)}`;

  withTimeout(fetch(tilesUrl), SCRIPTRAIL_CONFIG.FETCH_TIMEOUT_MS, "Tiles fetch")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .then((text) => {
      const json = JSON.parse(text.slice(")]}'".length));
      const totalRevs = json.tileInfo[json.tileInfo.length - 1].end;
      const userMap = json.userMap;
      if (button) button.disabled = false;

      return fetchRevisionData(documentId, documentToken, totalRevs)
        .then((changelog) => {
          const edits = generateEdits(changelog, []);
          const tabs = uniqueValues(edits.map((e) => e.tab));
          safeSend({ type: "setData", payload: { edits, userMap, tabs } });
        });
    })
    .catch((e) => {
      logError("fetchDataForInfobar", e);
      if (button) {
        button.textContent = "Report Unavailable";
        button.title = "You need edit access or the token is invalid.";
        button.disabled = true;
      }
      safeSend({ type: "setData", payload: { edits: [], error: true, message: e.message } });
    });
}

async function fetchRevisionData(docId, token, totalRevs) {
  // CRITICAL: Validate token before use
  if (!isValidToken(token)) {
    throw new Error("Invalid token format");
  }
  const url = `${baseurl}${docId}/revisions/load?id=${docId}&start=1&end=${totalRevs}&token=${encodeURIComponent(token)}`;
  const res = await withTimeout(fetch(url), SCRIPTRAIL_CONFIG.FETCH_TIMEOUT_MS, "Revision fetch");
  if (!res.ok) throw new Error(`HTTP ${res.status}: revision load failed`);
  return JSON.parse((await res.text()).slice(")]}'".length)).changelog;
}

function generateEdits(changelog, edits) {
  const len = changelog.length;
  for (let i = 0; i < len; i++) {
    const entry = changelog[i];
    let type;
    try {
      type = entry[0].ty;
    } catch (_) {}
    if (type === "is" || type === "iss") {
      edits.push({
        ty: "is",
        text: entry[0].s,
        loc: entry[0].ibi,
        time: entry[1],
        userId: entry[2],
        tab: "first",
      });
    } else if (type === "ds" || type === "dss") {
      edits.push({
        ty: "ds",
        si: entry[0].si,
        ei: entry[0].ei,
        time: entry[1],
        userId: entry[2],
        tab: "first",
      });
    } else if (type === "mlti") {
      const mts = entry[0].mts;
      const mtsLen = mts.length;
      for (let j = 0; j < mtsLen; j++) {
        generateEdits([[mts[j], entry[1], entry[2]]], edits);
      }
    } else if (type === "nm") {
      const nmc = entry[0].nmc;
      const tab = entry[0].nmr[1];
      if (nmc.ty === "is")
        edits.push({
          ty: "is",
          text: nmc.s,
          loc: nmc.ibi,
          time: entry[1],
          userId: entry[2],
          tab,
        });
      else if (nmc.ty === "ds")
        edits.push({
          ty: "ds",
          si: nmc.si,
          ei: nmc.ei,
          time: entry[1],
          userId: entry[2],
          tab,
        });
    }
  }
  return edits;
}

// ── Paste event: trigger immediate refresh ────────────────────────────────
document.addEventListener("paste", () => {
  if (isCtxValid() && documentToken) fetchDataForInfobar();
});

// ── Debounced input/change listener for real-time copied passages updates ───
let _refreshDebounceTimeout = null;
function _triggerRefreshDebounced() {
  if (!isCtxValid() || !documentToken) return;
  clearTimeout(_refreshDebounceTimeout);
  _refreshDebounceTimeout = setTimeout(() => {
    fetchDataForInfobar();
  }, 500); // wait 500ms after last input event
}
document.addEventListener("input", _triggerRefreshDebounced);
document.addEventListener("compositionend", _triggerRefreshDebounced);

// ── Periodic refresh (real-time updates for copy detection etc.) ──────────
let _refreshIntervalId = null;
function startPeriodicRefresh() {
  if (!isCtxValid() || _refreshIntervalId) return;
  _refreshIntervalId = setInterval(() => {
    if (!isCtxValid()) {
      clearInterval(_refreshIntervalId);
      _refreshIntervalId = null;
      const bar = document.getElementById("scriptrailInfoBar");
      if (bar) {
        setTextContent(bar, "Scriptrail: connection lost – reloading page…");
        bar.style.display = "block";
      }
      setTimeout(() => location.reload(), 1500);
      return;
    }
    if (documentToken) fetchDataForInfobar();
  }, SCRIPTRAIL_CONFIG.POLL_INTERVAL_MS);
}

// Cleanup on page unload to prevent memory leaks
window.addEventListener('beforeunload', () => {
  if (_refreshIntervalId) {
    clearInterval(_refreshIntervalId);
    _refreshIntervalId = null;
  }
  if (_tokenObserver) {
    _tokenObserver.disconnect();
    _tokenObserver = null;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BROADCAST WRITING TIME to infobar every second
// ══════════════════════════════════════════════════════════════════════════════
function _broadcastWritingTime() {
  if (!isCtxValid()) return;
  safeSend({
    type: "writingTimeTick",
    writingTime: formatWritingTime(_totalWritingMs()),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// UI + STORAGE
// ══════════════════════════════════════════════════════════════════════════════
function updateUIFromStorage() {
  if (!isCtxValid()) return;
  safeStorageGet(["toggleState"], (res) => {
    if (!isCtxValid()) return;
    const show = res?.toggleState !== false;
    if (button) button.style.display = show ? "inline-block" : "none";
  });
}

function setupListeners() {
  if (!isCtxValid()) return;
  chrome.runtime.onMessage.addListener((msg) => {
    if (!isCtxValid()) return;
    if (msg?.type === "toggle") updateUIFromStorage();
    // Handle theme updates from popup
    if (msg?.type === "themeUpdate" && msg.theme) {
      document.documentElement.setAttribute("data-theme", msg.theme);
    }
    // NOTE: sharedData is handled entirely in infoBar.js
  });
  
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!isCtxValid()) return;
    if (area === "sync") {
      if (changes?.toggleState) updateUIFromStorage();
      // Listen for infobarEnabled changes and reload the infobar script accordingly
      if (changes?.infobarEnabled) {
        const infobarEnabled = changes.infobarEnabled.newValue !== false;
        console.log("[Scriptrail content] infobarEnabled changed:", infobarEnabled);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════
function init() {
  if (!isCtxValid()) {
    setTimeout(init, SCRIPTRAIL_CONFIG.POLL_INTERVAL_MS / 10);
    return;
  }
  injectStylesheet();
  _watchForTokenScripts();
  tryExtractToken();
  tryInjectButton();
  setupListeners();
  updateUIFromStorage();

  safeStorageGet(["toggleState"], (res) => {
    if (!isCtxValid()) return;
    if (res?.toggleState !== false) {
      let polls = 0;
      function waitForToken() {
        if (!isCtxValid()) return;
        polls++;
        if (documentToken) {
          fetchDataForInfobar();
          startPeriodicRefresh();
          return;
        }
        if (polls < SCRIPTRAIL_CONFIG.TOKEN_RETRY_LIMIT) {
          setTimeout(waitForToken, SCRIPTRAIL_CONFIG.POLL_INTERVAL_MS / 10);
        } else {
          logError("waitForToken", "exhausted retries, notifying infobar");
          safeSend({ type: "setData", payload: { edits: [], error: true, message: "Token not found" } });
        }
      }
      waitForToken();
    }
  });
}

init();
