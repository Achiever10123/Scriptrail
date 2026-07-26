// ─── content.js ───────────────────────────────────────────────────────────────
// Injected into every Google Docs page.

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT GUARD
// ══════════════════════════════════════════════════════════════════════════════
function isCtxValid() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch (_) {
    return false;
  }
}

function safeSend(msg) {
  if (!isCtxValid()) return;
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) {
        /* swallow */
      }
    });
  } catch (_) {}
}

function safeStorageGet(keys, callback) {
  if (!isCtxValid()) return;
  try {
    chrome.storage.sync.get(keys, (res) => {
      if (!isCtxValid() || chrome.runtime.lastError) return;
      callback(res);
    });
  } catch (_) {}
}

function safeStorageSet(items, callback) {
  if (!isCtxValid()) return;
  try {
    chrome.storage.local.set(items, () => {
      if (!isCtxValid() || chrome.runtime.lastError) return;
      if (callback) callback();
    });
  } catch (_) {}
}

// Simple HTML escape to prevent XSS
function _escHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

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
    if (txt.includes("_docs_flag_initialData")) {
      const m = txt.match(/_docs_flag_initialData=(.*?);/);
      if (m) {
        const raw = m[1];
        const idx = raw.indexOf('"info_params"');
        if (idx !== -1) {
          const sub = raw.substring(idx);
          const end = sub.indexOf("}");
          if (end !== -1) {
            let frag = sub.substring(0, end + 1);
            const st = frag.indexOf('{"token"');
            if (st !== -1) {
              frag = frag.substring(st);
              try {
                const p = JSON.parse(frag);
                if (p.token && typeof p.token === 'string' && /^[a-zA-Z0-9_-]+$/.test(p.token)) {
                  documentToken = p.token;
                  _tokenExtracted = true;
                  return true;
                }
              } catch (_) {}
            }
          }
        }
      }
    }
    if (!documentToken && txt.includes('"token":"')) {
      const tm = txt.match(/"token":"([^"]+)"/);
      if (tm?.[1] && /^[a-zA-Z0-9_-]+$/.test(tm[1])) {
        documentToken = tm[1];
        _tokenExtracted = true;
        return true;
      }
    }
  }
  return false;
}

let _tokenRetries = 0;
function tryExtractToken() {
  if (documentToken || _tokenRetries > 30) return;
  if (!extractToken()) {
    _tokenRetries++;
    setTimeout(tryExtractToken, 200);
  }
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
  if (_btnRetries > 40) return;
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
  
  // Validate token format before use
  if (!/^[a-zA-Z0-9_-]+$/.test(documentToken)) {
    console.error("[Scriptrail] Invalid token format");
    return;
  }
  
  const tilesUrl = `${baseurl}${documentId}/revisions/tiles?id=${documentId}&start=1&showDetailedRevisions=false&token=${encodeURIComponent(documentToken)}`;

  // Send request to background script to handle fetch (avoids CORS issues)
  chrome.runtime.sendMessage({
    type: "fetchRevisionData",
    documentId,
    documentToken,
    baseurl
  }, (response) => {
    if (chrome.runtime.lastError || !response || response.error) {
      console.error("[Scriptrail] tiles:", response?.error || chrome.runtime.lastError);
      if (button) {
        button.textContent = "Report Unavailable";
        button.title = "You need edit access.";
        button.disabled = true;
      }
      return;
    }

    const { totalRevs, userMap, changelog } = response;
    if (button) button.disabled = false;
    
    const edits = generateEdits(changelog, []);
    const tabs = [...new Set(edits.map((e) => e.tab))];
    safeSend({ type: "setData", payload: { edits, userMap, tabs } });
  });
}

async function fetchRevisionData(docId, token, totalRevs) {
  // Validate token format
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    throw new Error("Invalid token format");
  }
  const url = `${baseurl}${docId}/revisions/load?id=${docId}&start=1&end=${totalRevs}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("revision load failed");
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
function startPeriodicRefresh() {
  if (!isCtxValid()) return;
  const intervalId = setInterval(() => {
    if (!isCtxValid()) {
      clearInterval(intervalId);
      const bar = document.getElementById("scriptrailInfoBar");
      if (bar) {
        bar.textContent = "Scriptrail: connection lost – reloading page…";
        bar.style.display = "block";
      }
      setTimeout(() => location.reload(), 1500);
      return;
    }
    if (documentToken) fetchDataForInfobar();
  }, 5000); // increased frequency to 5s for real-time updates
}

// ══════════════════════════════════════════════════════════════════════════════
// BROADCAST WRITING TIME to infobar every second
// ══════════════════════════════════════════════════════════════════════════════
function _broadcastWritingTime() {
  if (!isCtxValid()) return;
  try {
    chrome.runtime.sendMessage(
      {
        type: "writingTimeTick",
        writingTime: _formatWritingTime(_totalWritingMs()),
      },
      () => {
        if (chrome.runtime.lastError) {
        }
      },
    );
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// UI + STORAGE
// ══════════════════════════════════════════════════════════════════════════════
function updateUIFromStorage() {
  if (!isCtxValid()) return;
  try {
    safeStorageGet(["toggleState"], (res) => {
      if (!isCtxValid()) return;
      const show = res?.toggleState !== false;
      if (button) button.style.display = show ? "inline-block" : "none";
    });
  } catch (_) {}
}

function setupListeners() {
  if (!isCtxValid()) return;
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!isCtxValid()) return;
      if (msg?.type === "toggle") updateUIFromStorage();
      // Handle theme updates from popup
      if (msg?.type === "themeUpdate" && msg.theme) {
        document.documentElement.setAttribute("data-theme", msg.theme);
      }
      // NOTE: sharedData is handled entirely in infoBar.js
    });
  } catch (_) {}
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!isCtxValid()) return;
      if (area === "sync" && changes?.toggleState) updateUIFromStorage();
    });
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════
function init() {
  if (!isCtxValid()) {
    setTimeout(init, 500);
    return;
  }
  injectStylesheet();
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
        if (polls < 30) setTimeout(waitForToken, 200);
      }
      waitForToken();
    }
  });
}

init();
