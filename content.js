// ─── content.js ───────────────────────────────────────────────────────────────
// Injected into every Google Docs page.

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT GUARD
// Google Docs is a SPA. When it navigates internally, the extension context
// gets invalidated — every chrome.* call after that throws
// "Extension context invalidated". This guard is the single safe gate for
// every API call. It checks chrome.runtime.id which throws (catchably) when
// the context is gone.
// ══════════════════════════════════════════════════════════════════════════════
function isCtxValid() {
  try { return typeof chrome !== "undefined" && !!chrome.runtime?.id; }
  catch (_) { return false; }
}

function safeSend(msg) {
  if (!isCtxValid()) return;
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) { /* swallow */ }
    });
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE DATA  (document ID, base URL, auth token)
// ══════════════════════════════════════════════════════════════════════════════
const _urlMatch  = window.location.href.match(/\/document\/d\/([^/]+)/);
const documentId = _urlMatch ? _urlMatch[1] : "";

const _embedMeta = document.querySelector('meta[itemprop="embedURL"]');
const _ogMeta    = document.querySelector('meta[property="og:url"]');
const _sourceUrl = _embedMeta?.getAttribute("content")
                || _ogMeta?.getAttribute("content")
                || window.location.href;
const _dIdx  = _sourceUrl.indexOf("/d/");
const baseurl = _dIdx !== -1
  ? _sourceUrl.substring(0, _dIdx + 3)
  : "https://docs.google.com/document/d/";

let documentToken = "";

function extractToken() {
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
                if (p.token) { documentToken = p.token; return true; }
              } catch (_) {}
            }
          }
        }
      }
    }
    // Fallback
    if (!documentToken && txt.includes('"token":"')) {
      const tm = txt.match(/"token":"([^"]+)"/);
      if (tm?.[1]) { documentToken = tm[1]; return true; }
    }
  }
  return false;
}

let _tokenRetries = 0;
function tryExtractToken() {
  if (documentToken || _tokenRetries > 30) return;
  if (!extractToken()) { _tokenRetries++; setTimeout(tryExtractToken, 200); }
}

// ══════════════════════════════════════════════════════════════════════════════
// BUTTON INJECTION  (toolbar loads async in Google Docs)
// ══════════════════════════════════════════════════════════════════════════════
let button = null;

function injectStylesheet() {
  if (!isCtxValid()) return;
  if (document.getElementById("scriptrail-style")) return;
  try {
    const link = document.createElement("link");
    link.id   = "scriptrail-style";
    link.rel  = "stylesheet";
    link.type = "text/css";
    link.href = chrome.runtime.getURL("docsStyle.css");
    document.head.appendChild(link);
  } catch (_) {}
}

function injectButton() {
  if (document.getElementById("scriptrailBtn")) return true;
  const toolbar = document.querySelector(".docs-titlebar-buttons")
               || document.querySelector(".docs-titlebar")
               || document.querySelector("div[role='toolbar']");
  if (!toolbar) return false;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = '<button id="scriptrailBtn" disabled>View Report</button>';
  toolbar.appendChild(wrapper);

  button = document.getElementById("scriptrailBtn");
  if (button) { button.addEventListener("click", handleButtonClick); return true; }
  return false;
}

let _btnRetries = 0;
function tryInjectButton() {
  if (_btnRetries > 40) return;
  if (!injectButton()) { _btnRetries++; setTimeout(tryInjectButton, 300); }
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
  safeSend({
    action: "openReportTab",
    id:     documentId, token: documentToken,
    baseurl, title: documentTitle, tabs: chapters
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// REVISION FETCHING
// ══════════════════════════════════════════════════════════════════════════════
function fetchDataForInfobar() {
  if (!documentId || !documentToken) return;
  const tilesUrl = `${baseurl}${documentId}/revisions/tiles?id=${documentId}&start=1&showDetailedRevisions=false&token=${documentToken}`;

  fetch(tilesUrl)
    .then((r) => { if (!r.ok) throw new Error("tiles"); return r.text(); })
    .then((text) => {
      const json      = JSON.parse(text.slice(")]}'".length));
      const totalRevs = json.tileInfo[json.tileInfo.length - 1].end;
      const userMap   = json.userMap;
      if (button) button.disabled = false;

      fetchRevisionData(documentId, documentToken, totalRevs)
        .then((changelog) => {
          const edits = generateEdits(changelog, []);
          const tabs  = [...new Set(edits.map((e) => e.tab))];
          safeSend({ type: "setData", payload: { edits, userMap, tabs } });
        })
        .catch((e) => console.error("[Scriptrail] changelog:", e));
    })
    .catch((e) => {
      console.error("[Scriptrail] tiles:", e);
      if (button) { button.textContent = "Report Unavailable"; button.title = "You need edit access."; button.disabled = true; }
    });
}

async function fetchRevisionData(docId, token, totalRevs) {
  const url = `${baseurl}${docId}/revisions/load?id=${docId}&start=1&end=${totalRevs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("revision load failed");
  return JSON.parse((await res.text()).slice(")]}'".length)).changelog;
}

function generateEdits(changelog, edits) {
  changelog.forEach((entry) => {
    let type; try { type = entry[0].ty; } catch (_) {}
    if (type === "is" || type === "iss") {
      edits.push({ ty:"is", text:entry[0].s, loc:entry[0].ibi, time:entry[1], userId:entry[2], tab:"first" });
    } else if (type === "ds" || type === "dss") {
      edits.push({ ty:"ds", si:entry[0].si, ei:entry[0].ei, time:entry[1], userId:entry[2], tab:"first" });
    } else if (type === "mlti") {
      generateEdits(entry[0].mts.map((mt) => [mt, entry[1], entry[2]]), edits);
    } else if (type === "nm") {
      const nmc = entry[0].nmc; const tab = entry[0].nmr[1];
      if (nmc.ty === "is") edits.push({ ty:"is", text:nmc.s, loc:nmc.ibi, time:entry[1], userId:entry[2], tab });
      else if (nmc.ty === "ds") edits.push({ ty:"ds", si:nmc.si, ei:nmc.ei, time:entry[1], userId:entry[2], tab });
    }
  });
  return edits;
}

// ══════════════════════════════════════════════════════════════════════════════
// UI + STORAGE
// ══════════════════════════════════════════════════════════════════════════════
function updateUIFromStorage() {
  if (!isCtxValid()) return;
  try {
    chrome.storage.sync.get(["toggleState"], (res) => {
      if (chrome.runtime.lastError) return;
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
  if (!isCtxValid()) { setTimeout(init, 500); return; }
  injectStylesheet();
  tryExtractToken();
  tryInjectButton();
  setupListeners();
  updateUIFromStorage();

  try {
    chrome.storage.sync.get(["toggleState"], (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.toggleState !== false) {
        // Give token extraction time to finish
        setTimeout(() => {
          if (documentId && documentToken) {
            fetchDataForInfobar();
          } else {
            // One more retry
            setTimeout(() => { if (documentId && documentToken) fetchDataForInfobar(); }, 1500);
          }
        }, 600);
      }
    });
  } catch (_) {}
}

init();