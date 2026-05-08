// ─── infoBar.js ───────────────────────────────────────────────────────────────
// Shows a thin stats bar: Writing Time | Copied Passages | Sessions

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT GUARD
// ══════════════════════════════════════════════════════════════════════════════
function _ctxOk() {
  try { return typeof chrome !== "undefined" && !!chrome.runtime?.id; }
  catch (_) { return false; }
}

// ══════════════════════════════════════════════════════════════════════════════
// CLOSE STATE  — persists across data refreshes so bar stays hidden
// ══════════════════════════════════════════════════════════════════════════════
let _barDismissed = false;   // user clicked ×
let _lastWritingTime  = "0 sec";
let _lastCopiedCount  = 0;
let _lastSessionCount = 0;

// ══════════════════════════════════════════════════════════════════════════════
// INFO BAR DOM
// ══════════════════════════════════════════════════════════════════════════════
function createInfoBar() {
  const docsBar = document.getElementById("docs-bars");
  if (!docsBar || document.getElementById("scriptrailInfoBar")) return;

  const style = document.createElement("style");
  style.textContent = `
    #scriptrailInfoBar {
      display: none;
      text-align: center;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background-color: #f0f9f0;
      padding: 7px 40px 7px 12px;
      border-bottom: 1px solid #c8e6c9;
      position: relative;
      color: #2d6a2d;
    }
    #scriptrailInfoBar .sr-section { display: inline-block; margin: 0 8px; }
    #scriptrailInfoBar .sr-divider { color: #a5d6a7; margin: 0 4px; }
    #scriptrailInfoBarClose {
      position: absolute; right: 10px; top: 50%;
      transform: translateY(-50%);
      background: none; border: none; font-size: 15px;
      cursor: pointer; color: #66bb6a; padding: 2px 6px; border-radius: 3px;
    }
    #scriptrailInfoBarClose:hover { color: #2d6a2d; background: rgba(0,0,0,0.06); }
    #scriptrailToggleIcon {
      display: inline-flex; align-items: center;
      background: #f0f9f0; border: 1px solid #a5d6a7;
      border-radius: 4px; padding: 3px 8px; font-size: 11px;
      cursor: pointer; color: #2d6a2d; margin-left: 6px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #scriptrailToggleIcon:hover { background: #e0f5e0; }
  `;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id          = "scriptrailInfoBar";
  bar.textContent = "Scriptrail: loading…";
  docsBar.appendChild(bar);

  _createToggleIcon();
}

function _createToggleIcon() {
  const sideBar = document.getElementById("docs-side-toolbar");
  if (!sideBar || document.getElementById("scriptrailToggleIcon")) return;
  const icon = document.createElement("div");
  icon.id          = "scriptrailToggleIcon";
  icon.textContent = "Stats";
  icon.title       = "Show Scriptrail Stats";
  icon.addEventListener("click", _showInfoBar);
  sideBar.appendChild(icon);
}

function _showInfoBar() {
  _barDismissed = false;
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "block";
  const icon = document.getElementById("scriptrailToggleIcon");
  if (icon) icon.remove();
  _clickNavClose();
}

function _hideInfoBar() {
  _barDismissed = true;           // ← remember user closed it
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "none";
  _createToggleIcon();
  _clickNavClose();
}

// Only show the bar if the user has not dismissed it
function _maybeShowBar() {
  if (_barDismissed) return;
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "block";
}

function updateInfoBar(writingTime, copiedCount, sessionCount) {
  createInfoBar();       // no-op if already created
  const bar = document.getElementById("scriptrailInfoBar");
  if (!bar) return;

  // Cache latest values (used by the 1-second writing time tick)
  _lastWritingTime  = writingTime;
  _lastCopiedCount  = copiedCount;
  _lastSessionCount = sessionCount;

  _renderBarContent(bar, writingTime, copiedCount, sessionCount);
  _maybeShowBar();       // only shows if NOT dismissed
}

function _renderBarContent(bar, writingTime, copiedCount, sessionCount) {
  bar.innerHTML = `
    <span class="sr-section">✍️ Writing Time: <strong>${writingTime}</strong></span>
    <span class="sr-divider">|</span>
    <span class="sr-section">📋 Copied Passages: <strong>${copiedCount}</strong></span>
    <span class="sr-divider">|</span>
    <span class="sr-section">🕐 Sessions: <strong>${sessionCount}</strong></span>
    <button id="scriptrailInfoBarClose" title="Close">×</button>
  `;
  document.getElementById("scriptrailInfoBarClose")
    ?.addEventListener("click", _hideInfoBar);
}

// Called every second by content.js writingTimeTick — only updates the
// writing time span, leaving copied/sessions untouched, and NEVER forces
// the bar visible.
function _updateWritingTimeOnly(writingTime) {
  _lastWritingTime = writingTime;
  const bar = document.getElementById("scriptrailInfoBar");
  if (!bar || _barDismissed) return;

  const span = bar.querySelector(".sr-section strong");
  if (span) span.textContent = writingTime;   // update just the first <strong>
}

// ══════════════════════════════════════════════════════════════════════════════
// STRING HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function _applyInsert(str, loc, text) { return str.slice(0, loc - 1) + text + str.slice(loc - 1); }
function _applyDelete(str, si, ei)    { return str.slice(0, si - 1) + str.slice(ei); }

// ══════════════════════════════════════════════════════════════════════════════
// SESSION COUNT
// ══════════════════════════════════════════════════════════════════════════════
function getWritingSessionCount(edits) {
  if (!edits || edits.length === 0) return 0;
  let sessions = 1;
  for (let i = 0; i < edits.length - 1; i++) {
    if (edits[i + 1].time - edits[i].time > 600_000) sessions++;
  }
  return sessions;
}

// ══════════════════════════════════════════════════════════════════════════════
// COPY / PASTE DETECTION  (same doc-replay logic as report.js)
// Lower MIN_LEN to catch more realistic pastes; skip pure URLs optionally.
// ══════════════════════════════════════════════════════════════════════════════
async function getCopiedCount(edits) {
  try {
    if (!edits || edits.length === 0) return 0;

    const TIMEOUT_MS = 5000;
    const MIN_LEN    = 20;   // lowered from 50 — catches shorter pastes too
    const t0         = performance.now();

    const tabArr  = [...new Set(edits.map((e) => e.tab || "first"))];
    let docStates = tabArr.map(() => "");

    const candidates = edits
      .map((e, i) => ({ ...e, _idx: i }))
      .filter((e) => e.ty === "is" && e.text && e.text.length >= MIN_LEN);

    if (candidates.length === 0) return 0;

    let candPtr = 0;
    let found   = 0;

    for (let i = 0; i < edits.length; i++) {
      if (i % 500 === 0) {
        if (performance.now() - t0 > TIMEOUT_MS) return found;
        await new Promise((r) => setTimeout(r, 0));
      }

      const edit = edits[i];
      const tIdx = tabArr.indexOf(edit.tab || "first");
      if (tIdx < 0) continue;

      if (edit.ty === "is" && edit.text) {
        const docBefore   = docStates[tIdx];
        docStates[tIdx]   = _applyInsert(docStates[tIdx], edit.loc, edit.text);

        if (candPtr < candidates.length && i === candidates[candPtr]._idx) {
          if (!docBefore.includes(edit.text)) found++;
          candPtr++;
        }
      } else if (edit.ty === "ds") {
        docStates[tIdx] = _applyDelete(docStates[tIdx], edit.si, edit.ei);
      }
    }

    return found;
  } catch (err) {
    console.error("[Scriptrail] getCopiedCount error:", err);
    return "N/A";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DOCS LAYOUT WORKAROUND
// ══════════════════════════════════════════════════════════════════════════════
function _clickNavClose() {
  [
    document.querySelector(".navigation-widget-hat-close"),
    document.querySelector(".miniChapterSwitcherNavigationEntryPointIcon")
  ].forEach((el) => {
    if (!el) return;
    try {
      const r = el.getBoundingClientRect();
      ["pointerdown","mousedown","mouseup","click"].forEach((t) => {
        el.dispatchEvent(new PointerEvent(t, {
          bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
          pointerId: 1, pointerType: "mouse", isPrimary: true
        }));
      });
    } catch (_) {}
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE LISTENER
// ══════════════════════════════════════════════════════════════════════════════
function setupInfoBarListener() {
  if (!_ctxOk()) return;
  try {
    chrome.runtime.onMessage.addListener(async (msg) => {
      if (!_ctxOk()) return;

      // ── Live writing time tick from content.js (every 1 second) ───────────
      if (msg?.type === "writingTimeTick") {
        _updateWritingTimeOnly(msg.writingTime);
        return;
      }

      // ── Full data refresh from revision API ───────────────────────────────
      if (msg?.type !== "sharedData" && msg?.action !== "refreshData") return;

      const edits = msg?.payload?.edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        console.warn("[Scriptrail infoBar] No edits received");
        return;
      }

      // Show "calculating…" only if bar is currently visible
      if (!_barDismissed) {
        createInfoBar();
        const bar = document.getElementById("scriptrailInfoBar");
        if (bar) { bar.textContent = "Scriptrail: calculating…"; bar.style.display = "block"; }
      }

      const sessionCount = getWritingSessionCount(edits);
      const copiedCount  = await getCopiedCount(edits);

      if (!_ctxOk()) return;

      // Writing time comes from the live timer, not revision timestamps
      updateInfoBar(_lastWritingTime, copiedCount, sessionCount);
    });
  } catch (err) {
    console.error("[Scriptrail infoBar] Listener setup failed:", err);
  }
}

setupInfoBarListener();