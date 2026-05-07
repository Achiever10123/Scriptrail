// ─── content.js ───────────────────────────────────────────────────────────────
// Injected into every Google Docs page.
// Responsibilities:
//   - Inject the "View Report" button into the Docs toolbar
//   - Fetch revision data from the Docs revision API
//   - Send parsed edit data to background.js → infoBar.js

// ── Inject stylesheet for the button ─────────────────────────────────────────
const _styleLink = document.createElement("link");
_styleLink.rel  = "stylesheet";
_styleLink.type = "text/css";
_styleLink.href = chrome.runtime.getURL("docsStyle.css");
document.head.appendChild(_styleLink);

// ── Create & inject the "View Report" button ──────────────────────────────────
const _btnWrapper = document.createElement("div");
_btnWrapper.innerHTML = '<button id="scriptrailBtn" disabled>View Report</button>';

const _toolbar = document.querySelector(".docs-titlebar-buttons");
if (_toolbar) _toolbar.appendChild(_btnWrapper);

const button = document.getElementById("scriptrailBtn");

// ── Extract Document ID from URL ──────────────────────────────────────────────
const _urlMatch = window.location.href.match(/\/document\/d\/([^/]+)/);
const documentId = _urlMatch ? _urlMatch[1] : "";

// ── Extract base URL (everything up to and including "/d/") ───────────────────
const _embedMeta = document.querySelector('meta[itemprop="embedURL"]');
const _ogMeta    = document.querySelector('meta[property="og:url"]');
const _sourceUrl = _embedMeta?.getAttribute("content")
                || _ogMeta?.getAttribute("content")
                || window.location.href;
const _dIdx = _sourceUrl.indexOf("/d/");
const baseurl = _dIdx !== -1
  ? _sourceUrl.substring(0, _dIdx + 3)
  : "https://docs.google.com/document/d/";

// ── Extract document auth token from inline script data ───────────────────────
let documentToken = "";
const _scripts = document.getElementsByTagName("script");
for (let i = 0; i < _scripts.length; i++) {
  const s = _scripts[i];
  if (s.textContent.includes("_docs_flag_initialData")) {
    const match = s.textContent.match(/_docs_flag_initialData=(.*?);/);
    if (match) {
      const raw  = match[1];
      const idx  = raw.indexOf('"info_params"');
      if (idx !== -1) {
        const sub   = raw.substring(idx);
        const end   = sub.indexOf("}");
        if (end !== -1) {
          let fragment = sub.substring(0, end + 1);
          const start  = fragment.indexOf('{"token"');
          if (start !== -1) {
            fragment = fragment.substring(start);
            try {
              const parsed = JSON.parse(fragment);
              documentToken = parsed.token;
            } catch (_) { /* couldn't parse */ }
          }
        }
      }
    }
    break;
  }
}

// ── Document title & chapter tab data ─────────────────────────────────────────
const documentTitle = document.title;
const chapterData   = {};

// ── Button click → open report tab ───────────────────────────────────────────
button.addEventListener("click", () => {
  // Collect chapter/tab containers
  document.querySelectorAll(".chapter-container").forEach((el) => {
    let id = el.id;
    if (id === "chapter-container-") id = "first";
    const label = el.querySelector(".chapter-label-content");
    chapterData[id] = label ? label.textContent.trim() : "";
  });

  chrome.runtime.sendMessage({
    action:  "openReportTab",
    id:      documentId,
    token:   documentToken,
    baseurl: baseurl,
    title:   documentTitle,
    tabs:    chapterData
  });
});

// ── Fetch revision tile metadata (to get totalRevs) ───────────────────────────
function fetchDataForInfobar() {
  const tilesUrl = `${baseurl}${documentId}/revisions/tiles?id=${documentId}&start=1&showDetailedRevisions=false&token=${documentToken}`;

  fetch(tilesUrl)
    .then((res) => {
      if (!res.ok) throw new Error("tiles fetch failed");
      return res.text();
    })
    .then((text) => {
      const json      = JSON.parse(text.slice(")]}'".length));
      const totalRevs = json.tileInfo[json.tileInfo.length - 1].end;
      const userMap   = json.userMap;

      button.disabled = false;

      // Fetch full revision changelog
      fetchRevisionData(documentId, documentToken, totalRevs).then((changelog) => {
        const edits  = generateEdits(changelog, []);
        const tabs   = [...new Set(edits.map((e) => e.tab))];

        chrome.runtime.sendMessage({
          type:    "setData",
          payload: { edits, userMap, tabs }
        });
      });
    })
    .catch((err) => {
      console.error("[Scriptrail] tiles fetch error:", err);
      if (button) {
        button.innerHTML = '<span title="You need edit access to this document.">Report Unavailable</span>';
        button.disabled  = true;
      }
    });
}

// ── Fetch full changelog ───────────────────────────────────────────────────────
async function fetchRevisionData(docId, token, totalRevs) {
  const url = `${baseurl}${docId}/revisions/load?id=${docId}&start=1&end=${totalRevs}`;
  const res  = await fetch(url);
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
      edits.push({ ty: "is", text: entry[0].s, loc: entry[0].ibi, time: entry[1], userId: entry[2], tab: "first" });

    } else if (type === "ds" || type === "dss") {
      edits.push({ ty: "ds", si: entry[0].si, ei: entry[0].ei, time: entry[1], userId: entry[2], tab: "first" });

    } else if (type === "mlti") {
      const expanded = entry[0].mts.map((mt) => [mt, entry[1], entry[2]]);
      generateEdits(expanded, edits);

    } else if (type === "nm") {
      const nmc = entry[0].nmc;
      const tab = entry[0].nmr[1];
      if (nmc.ty === "is") {
        edits.push({ ty: "is", text: nmc.s, loc: nmc.ibi, time: entry[1], userId: entry[2], tab });
      } else if (nmc.ty === "ds") {
        edits.push({ ty: "ds", si: nmc.si, ei: nmc.ei, time: entry[1], userId: entry[2], tab });
      }
    }
  });
  return edits;
}

// ── Respond to toggle messages from background.js ─────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "toggle") {
    updateUIFromStorage();
  }
});

// ── Read storage and show/hide button accordingly ─────────────────────────────
function updateUIFromStorage() {
  chrome.storage.sync.get(["toggleState"], (res) => {
    const show = res.toggleState !== false;
    if (button) button.style.display = show ? "block" : "none";
  });
}

// ── Initialise on load ────────────────────────────────────────────────────────
function init() {
  updateUIFromStorage();
  chrome.storage.sync.get(["toggleState"], (res) => {
    if (res.toggleState !== false) {
      fetchDataForInfobar();
    }
  });
}

init();

// Re-run if toggle storage changes while the tab is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.toggleState) {
    updateUIFromStorage();
  }
});