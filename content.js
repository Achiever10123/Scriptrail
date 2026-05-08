// ─── content.js ───────────────────────────────────────────────────────────────
// Injected into every Google Docs page.
// Responsibilities:
//   - Inject the "View Report" button into the Docs toolbar
//   - Fetch revision data from the Docs revision API
//   - Send parsed edit data to background.js → infoBar.js
//   - Capture the current user's Chrome profile email (for student view)

// ── Helper: Check if chrome API is available ────────────────────────────────
function isChromeAvailable() {
  try {
    return typeof chrome !== "undefined" && chrome.runtime;
  } catch (err) {
    return false;
  }
}

// ── Inject stylesheet for the button ─────────────────────────────────────────
function injectStylesheet() {
  try {
    if (!isChromeAvailable()) {
      console.warn("[Scriptrail] Chrome API not available for stylesheet");
      return false;
    }
    const _styleLink = document.createElement("link");
    _styleLink.rel = "stylesheet";
    _styleLink.type = "text/css";
    _styleLink.href = chrome.runtime.getURL("docsStyle.css");
    document.head.appendChild(_styleLink);
    return true;
  } catch (err) {
    console.error("[Scriptrail] Stylesheet injection error:", err);
    return false;
  }
}

injectStylesheet();

// ── Create & inject the "View Report" button ──────────────────────────────────
let button = null;

function injectButton() {
  const toolbarSelectors = [
    ".docs-titlebar-buttons",
    ".docs-titlebar",
    ".docs-toolbar",
    "div[role='toolbar']"
  ];

  let _toolbar = null;
  for (const selector of toolbarSelectors) {
    _toolbar = document.querySelector(selector);
    if (_toolbar) break;
  }

  if (!_toolbar || document.getElementById("scriptrailBtn")) return false;

  const _btnWrapper = document.createElement("div");
  _btnWrapper.innerHTML =
    '<button id="scriptrailBtn" disabled>View Report</button>';
  _toolbar.appendChild(_btnWrapper);

  button = document.getElementById("scriptrailBtn");
  if (button) {
    try {
      button.addEventListener("click", handleButtonClick);
      console.log("[Scriptrail] Button injected successfully");
      return true;
    } catch (err) {
      console.error("[Scriptrail] Failed to add click listener to button:", err);
      return false;
    }
  }
  return false;
}

// ── Retry injection if toolbar not ready ─────────────────────────────────────
let injectionRetries = 0;
const MAX_INJECTION_RETRIES = 30;

function tryInjectButton() {
  if (injectionRetries >= MAX_INJECTION_RETRIES) {
    console.warn("[Scriptrail] Could not inject button after " + MAX_INJECTION_RETRIES + " retries");
    return;
  }
  if (!injectButton()) {
    injectionRetries++;
    const delay = Math.min(100 + (injectionRetries * 50), 2000);
    setTimeout(tryInjectButton, delay);
  } else {
    console.log("[Scriptrail] Button injection successful after " + injectionRetries + " retries");
  }
}

// ── Extract Document ID from URL ──────────────────────────────────────────────
const _urlMatch = window.location.href.match(/\/document\/d\/([^/]+)/);
const documentId = _urlMatch ? _urlMatch[1] : "";

// ── Extract base URL ──────────────────────────────────────────────────────────
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

// ── Token extraction (with retries) ───────────────────────────────────────────
let documentToken = "";
let tokenRetryCount = 0;
const MAX_TOKEN_RETRIES = 30;

function extractToken() {
  const _scripts = document.getElementsByTagName("script");
  for (let i = 0; i < _scripts.length; i++) {
    const s = _scripts[i];
    if (!s.textContent) continue;

    // Primary: look for _docs_flag_initialData
    if (s.textContent.includes("_docs_flag_initialData")) {
      const match = s.textContent.match(/_docs_flag_initialData=(.*?);/);
      if (match) {
        const raw = match[1];
        const idx = raw.indexOf('"info_params"');
        if (idx !== -1) {
          const sub = raw.substring(idx);
          const end = sub.indexOf("}");
          if (end !== -1) {
            let fragment = sub.substring(0, end + 1);
            const start = fragment.indexOf('{"token"');
            if (start !== -1) {
              fragment = fragment.substring(start);
              try {
                const parsed = JSON.parse(fragment);
                if (parsed.token) {
                  documentToken = parsed.token;
                  console.log("[Scriptrail] Token extracted successfully");
                  return true;
                }
              } catch (parseErr) {
                console.warn("[Scriptrail] Token parse error:", parseErr);
              }
            }
          }
        }
      }
    }

    // Fallback: generic token in script
    if (s.textContent.includes('"token":"')) {
      const tokenMatch = s.textContent.match(/"token":"([^"]+)"/);
      if (tokenMatch && tokenMatch[1]) {
        documentToken = tokenMatch[1];
        console.log("[Scriptrail] Token extracted from alternative location");
        return true;
      }
    }
  }
  return false;
}

// Retry token extraction if not found initially
function tryExtractTokenWithRetry() {
  if (documentToken) return;
  if (tokenRetryCount >= MAX_TOKEN_RETRIES) {
    console.warn("[Scriptrail] Token extraction failed after max retries");
    return;
  }
  if (!extractToken()) {
    tokenRetryCount++;
    setTimeout(tryExtractTokenWithRetry, 200);
  }
}

// ── Get current user's Chrome profile email ──────────────────────────────────
function captureCurrentUserEmail() {
  if (!isChromeAvailable() || !chrome.identity || !chrome.identity.getProfileUserInfo) {
    console.warn("[Scriptrail] chrome.identity.getProfileUserInfo not available");
    return;
  }
  try {
    chrome.identity.getProfileUserInfo((userInfo) => {
      if (chrome.runtime.lastError) {
        console.warn("[Scriptrail] getProfileUserInfo error:", chrome.runtime.lastError);
        return;
      }
      if (userInfo.email) {
        chrome.storage.local.set({ currentUserEmail: userInfo.email });
        console.log("[Scriptrail] Stored current user email:", userInfo.email);
      }
    });
  } catch (err) {
    console.error("[Scriptrail] getProfileUserInfo exception:", err);
  }
}

// ── Document title & chapter data ─────────────────────────────────────────────
const documentTitle = document.title;
const chapterData = {};

// ── Button click → open report tab ───────────────────────────────────────────
function handleButtonClick() {
  if (!button) return;

  const chapters = {};
  document.querySelectorAll(".chapter-container").forEach((el) => {
    let id = el.id;
    if (id === "chapter-container-") id = "first";
    const label = el.querySelector(".chapter-label-content");
    chapters[id] = label ? label.textContent.trim() : "";
  });

  try {
    if (!isChromeAvailable()) {
      console.error("[Scriptrail] Chrome API not available for openReportTab");
      return;
    }
    chrome.runtime.sendMessage(
      {
        action: "openReportTab",
        id: documentId,
        token: documentToken,
        baseurl: baseurl,
        title: documentTitle,
        tabs: chapters,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("[Scriptrail] Message error:", chrome.runtime.lastError);
        }
      }
    );
  } catch (err) {
    console.error("[Scriptrail] Failed to send openReportTab message:", err);
  }
}

// ── Fetch revision tile metadata ──────────────────────────────────────────────
function fetchDataForInfobar() {
  if (!documentId || !documentToken) {
    console.warn("[Scriptrail] Missing documentId or token");
    return;
  }

  const tilesUrl = `${baseurl}${documentId}/revisions/tiles?id=${documentId}&start=1&showDetailedRevisions=false&token=${documentToken}`;

  fetch(tilesUrl)
    .then((res) => {
      if (!res.ok) throw new Error("tiles fetch failed");
      return res.text();
    })
    .then((text) => {
      try {
        const json = JSON.parse(text.slice(")]}'".length));
        const totalRevs = json.tileInfo[json.tileInfo.length - 1].end;
        const userMap = json.userMap;

        if (button) button.disabled = false;

        // Fetch full revision changelog
        fetchRevisionData(documentId, documentToken, totalRevs)
          .then((changelog) => {
            const edits = generateEdits(changelog, []);
            const tabs = [...new Set(edits.map((e) => e.tab))];

            try {
              if (!isChromeAvailable()) {
                console.error("[Scriptrail] Chrome API not available for setData");
                return;
              }
              chrome.runtime.sendMessage(
                {
                  type: "setData",
                  payload: { edits, userMap, tabs },
                },
                (response) => {
                  if (chrome.runtime.lastError) {
                    console.error("[Scriptrail] setData message error:", chrome.runtime.lastError);
                  }
                }
              );
            } catch (err) {
              console.error("[Scriptrail] Failed to send setData message:", err);
            }
          })
          .catch((err) => {
            console.error("[Scriptrail] fetchRevisionData error:", err);
          });
      } catch (parseErr) {
        console.error("[Scriptrail] JSON parse error:", parseErr);
      }
    })
    .catch((err) => {
      console.error("[Scriptrail] tiles fetch error:", err);
      if (button) {
        button.innerHTML =
          '<span title="You need edit access to this document.">Report Unavailable</span>';
        button.disabled = true;
      }
    });
}

// ── Fetch full changelog ───────────────────────────────────────────────────────
async function fetchRevisionData(docId, token, totalRevs) {
  const url = `${baseurl}${docId}/revisions/load?id=${docId}&start=1&end=${totalRevs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("revision load failed");
  const text = await res.text();
  const json = JSON.parse(text.slice(")]}'".length));
  return json.changelog;
}

// ── Parse raw changelog into normalised edit objects ──────────────────────────
function generateEdits(changelog, edits) {
  changelog.forEach((entry) => {
    let type;
    try { type = entry[0].ty; } catch (_) {}

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
      const expanded = entry[0].mts.map((mt) => [mt, entry[1], entry[2]]);
      generateEdits(expanded, edits);
    } else if (type === "nm") {
      const nmc = entry[0].nmc;
      const tab = entry[0].nmr[1];
      if (nmc.ty === "is") {
        edits.push({
          ty: "is",
          text: nmc.s,
          loc: nmc.ibi,
          time: entry[1],
          userId: entry[2],
          tab,
        });
      } else if (nmc.ty === "ds") {
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
  });
  return edits;
}

// ── Respond to toggle messages from background.js ─────────────────────────────
function setupMessageListener() {
  try {
    if (!isChromeAvailable()) {
      console.warn("[Scriptrail] Chrome API not available for message listener");
      return;
    }
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try {
        if (msg?.type === "toggle") {
          updateUIFromStorage();
        }
      } catch (err) {
        console.error("[Scriptrail] Message listener error:", err);
      }
    });
  } catch (err) {
    console.error("[Scriptrail] Failed to setup message listener:", err);
  }
}

// ── Read storage and show/hide button accordingly ─────────────────────────────
function updateUIFromStorage() {
  try {
    if (!isChromeAvailable()) {
      console.warn("[Scriptrail] Chrome API not available for updateUIFromStorage");
      return;
    }
    chrome.storage.sync.get(["toggleState"], (res) => {
      if (chrome.runtime.lastError) {
        console.warn("[Scriptrail] Storage get error:", chrome.runtime.lastError);
        return;
      }
      const show = res?.toggleState !== false;
      if (button) button.style.display = show ? "block" : "none";
    });
  } catch (err) {
    console.error("[Scriptrail] updateUIFromStorage error:", err);
  }
}

// ── Initialise on load ────────────────────────────────────────────────────────
let initCompleted = false;

function init() {
  if (initCompleted) return;
  try {
    // Start token extraction with retries
    tryExtractTokenWithRetry();

    // Capture Chrome profile email (for student view)
    captureCurrentUserEmail();

    // Log initialization state
    console.log("[Scriptrail] Init: documentId=" + (documentId ? "✓" : "✗"), "token=" + (documentToken ? "✓" : "✗"));

    // Inject button first
    tryInjectButton();

    // Setup message listener
    setupMessageListener();

    // Update UI from storage
    updateUIFromStorage();

    // Fetch initial data when ready
    if (!isChromeAvailable()) {
      console.warn("[Scriptrail] Chrome API not available during init");
      // Retry init after a delay (only once)
      setTimeout(init, 2000);
      return;
    }

    chrome.storage.sync.get(["toggleState"], (res) => {
      if (chrome.runtime.lastError) {
        console.warn("[Scriptrail] Initial storage check error:", chrome.runtime.lastError);
        return;
      }
      if (res?.toggleState !== false) {
        // Wait a brief moment for token extraction
        setTimeout(() => {
          if (documentId && documentToken) {
            fetchDataForInfobar();
            initCompleted = true;
          } else {
            console.warn("[Scriptrail] Cannot fetch data: missing documentId or token");
            // Retry once after a delay
            setTimeout(init, 2000);
          }
        }, 500);
      } else {
        initCompleted = true;
      }
    });
  } catch (err) {
    console.error("[Scriptrail] Init error:", err);
    setTimeout(init, 2000);
  }
}

// ── Setup storage change listener ──────────────────────────────────────────────
function setupStorageListener() {
  try {
    if (!isChromeAvailable()) {
      console.warn("[Scriptrail] Chrome API not available for storage listener");
      return;
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      try {
        if (area === "sync" && changes?.toggleState) {
          updateUIFromStorage();
        }
      } catch (err) {
        console.error("[Scriptrail] Storage change handler error:", err);
      }
    });
  } catch (err) {
    console.error("[Scriptrail] Failed to setup storage listener:", err);
  }
}

init();
setupStorageListener();