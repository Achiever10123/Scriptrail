// ─── infoBar.js ───────────────────────────────────────────────────────────────
// Shows a thin stats bar: Writing Time | Copied Passages | Sessions

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
const INFOBAR_CONFIG = {
  width: 280, // Panel width in pixels (change this to adjust)
};

function setInfoBarWidth(pixels) {
  INFOBAR_CONFIG.width = pixels;
  const root = document.documentElement;
  root.style.setProperty("--scriptrail-panel-width", `${pixels}px`);
}

// ══════════════════════════════════════════════════════════════════════════════
// DOCUMENT ID & STORAGE
// ══════════════════════════════════════════════════════════════════════════════
const _docIdMatch = window.location.href.match(/\/document\/d\/([^/]+)/);
const _documentId = _docIdMatch ? _docIdMatch[1] : "";
const _storageKey = `scriptrail_writingTime_${_documentId}`;

function _saveAccumulatedTime() {
  if (!_ctxOk() || !_documentId) return;
  const currentMs = _getLiveWritingTimeMs();
  try {
    chrome.storage.local.set({ [_storageKey]: currentMs });
  } catch (_) {}
}

function _loadSavedTime() {
  if (!_ctxOk() || !_documentId) return;
  try {
    chrome.storage.local.get([_storageKey], (res) => {
      if (!_ctxOk()) return;
      const saved = res[_storageKey];
      if (saved && typeof saved === "number" && saved > _baseWritingTimeMs) {
        _baseWritingTimeMs = saved;
        _lastFetchTime = Date.now();
        console.log(
          "[Scriptrail infoBar] Restored saved time:",
          formatWritingTime(saved),
        );
      }
    });
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT GUARD
// ══════════════════════════════════════════════════════════════════════════════
function _ctxOk() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch (_) {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CLOSE STATE  — persists across data refreshes so bar stays hidden
// ══════════════════════════════════════════════════════════════════════════════
let _barDismissed = false; // user clicked ×
let _lastCopiedCount = 0;
let _lastSessionCount = 0;

// ── Live-tick state (mirrors report.js calcSessions algorithm exactly) ────────
// After each API refresh we store:
//   _baseWritingTimeMs  — calcTotalWritingTime() result from the revision data
//   _lastFetchTime      — wall-clock Date.now() when we last received fresh data
//
// Every second the live tick checks: is the current wall-clock time still within
// SESSION_GAP of the last edit?  If yes, the current session is still "open" and
// we add (now - _lastFetchTime) to _baseWritingTimeMs to get the live total —
// exactly what report.js would show if it recalculated right now.
const _IB_SESSION_GAP = 600_000; // 10 min — must match report.js SESSION_GAP
let _baseWritingTimeMs = 0;
let _lastFetchTime = 0; // wall-clock time of the last API refresh
let _liveTickInterval = null;

// ══════════════════════════════════════════════════════════════════════════════
// INFO BAR DOM
// ══════════════════════════════════════════════════════════════════════════════
function createInfoBar() {
  if (document.getElementById("scriptrailInfoBar")) return;

  // Initialize CSS custom property with configured width
  document.documentElement.style.setProperty(
    "--scriptrail-panel-width",
    `${INFOBAR_CONFIG.width}px`,
  );

  const style = document.createElement("style");
  style.textContent = `
    #scriptrailInfoBar {
      position: fixed;
      right: 0;
      top: 0;
      width: var(--scriptrail-panel-width, 280px);
      height: 100vh;
      background-color: #f0f9f0;
      border-left: 1px solid #c8e6c9;
      padding: 16px;
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #2d6a2d;
      z-index: 10000;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #scriptrailInfoBar .sr-section { 
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 12px;
      background: white;
      border: 1px solid #c8e6c9;
      border-radius: 6px;
      font-size: 13px;
    }
    #scriptrailInfoBar .sr-section-label {
      font-weight: 600;
      color: #1b5e20;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    #scriptrailInfoBar .sr-section-value {
      font-size: 16px;
      font-weight: 700;
      color: #2d6a2d;
    }
    #scriptrailInfoBar .sr-divider { display: none; }
    #scriptrailInfoBarClose {
      position: absolute; right: 12px; top: 12px;
      background: none; border: none; font-size: 18px;
      cursor: pointer; color: #66bb6a; padding: 4px 8px; border-radius: 4px;
      width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
    }
    #scriptrailInfoBarClose:hover { color: #2d6a2d; background: rgba(0,0,0,0.08); }
    #scriptrailToggleIcon {
      display: flex; align-items: center; justify-content: center;
      background: #f0f9f0; border: 1px solid #a5d6a7;
      border-radius: 4px; padding: 6px 12px; font-size: 12px;
      cursor: pointer; color: #2d6a2d; 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-weight: 500;
    }
    #scriptrailToggleIcon:hover { background: #e0f5e0; }
  `;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "scriptrailInfoBar";
  panel.textContent = "Scriptrail: loading…";
  document.body.appendChild(panel);

  _createToggleIcon();
}

function _createToggleIcon() {
  const sideBar = document.getElementById("docs-side-toolbar");
  if (!sideBar || document.getElementById("scriptrailToggleIcon")) return;
  const icon = document.createElement("div");
  icon.id = "scriptrailToggleIcon";
  icon.textContent = "Stats";
  icon.title = "Show Scriptrail Stats";
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
  _barDismissed = true;
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "none";
  _createToggleIcon();
  _clickNavClose();
}

function _maybeShowBar() {
  if (_barDismissed) return;
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "block";
}

function updateInfoBar(writingTime, copiedCount, sessionCount) {
  createInfoBar();
  const bar = document.getElementById("scriptrailInfoBar");
  if (!bar) return;

  _lastCopiedCount = copiedCount;
  _lastSessionCount = sessionCount;

  _renderBarContent(bar, writingTime, copiedCount, sessionCount);
  _maybeShowBar();
}

function _renderBarContent(bar, writingTime, copiedCount, sessionCount) {
  bar.innerHTML = `
    <button id="scriptrailInfoBarClose" title="Close">×</button>
    <div style="margin-top: 24px;">
      <div class="sr-section">
        <div class="sr-section-label">✍️ Writing Time</div>
        <div class="sr-section-value">${writingTime}</div>
      </div>
      <div class="sr-section">
        <div class="sr-section-label">📋 Copied Passages</div>
        <div class="sr-section-value">${copiedCount}</div>
      </div>
      <div class="sr-section">
        <div class="sr-section-label">🕐 Sessions</div>
        <div class="sr-section-value">${sessionCount}</div>
      </div>
    </div>
  `;
  document
    .getElementById("scriptrailInfoBarClose")
    ?.addEventListener("click", _hideInfoBar);
}

// Updates only the writing-time <strong> every second — never forces bar visible.
function _updateWritingTimeOnly(writingTime) {
  const bar = document.getElementById("scriptrailInfoBar");
  if (!bar || _barDismissed) return;
  const valueSpan = bar.querySelector(".sr-section-value");
  if (valueSpan) valueSpan.textContent = writingTime;
}

// ══════════════════════════════════════════════════════════════════════════════
// LIVE TICK — updates writing time every second using the same logic as report.js
// ══════════════════════════════════════════════════════════════════════════════

// Returns what report.js calcTotalWritingTime() would return if called right now.
// If the user is actively writing (within SESSION_GAP of the last revision edit),
// the current session is still open so we extend it by elapsed wall-clock time.
function _getLiveWritingTimeMs() {
  if (_lastFetchTime === 0) return _baseWritingTimeMs;

  const elapsedSinceLastFetch = Date.now() - _lastFetchTime;

  // Keep ticking as long as the API keeps sending fresh data (every 5s).
  // If we stop receiving data (tab backgrounded, idle > SESSION_GAP), freeze.
  if (elapsedSinceLastFetch < _IB_SESSION_GAP) {
    return _baseWritingTimeMs + elapsedSinceLastFetch;
  }
  return _baseWritingTimeMs;
}

function _startLiveTick() {
  if (_liveTickInterval) return;
  let saveCounter = 0;
  _liveTickInterval = setInterval(() => {
    _updateWritingTimeOnly(formatWritingTime(_getLiveWritingTimeMs()));
    // Save accumulated time every 10 seconds
    if (++saveCounter % 10 === 0) {
      _saveAccumulatedTime();
    }
  }, 1000);
}

// ══════════════════════════════════════════════════════════════════════════════
// STRING HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function _applyInsert(str, loc, text) {
  return str.slice(0, loc - 1) + text + str.slice(loc - 1);
}
function _applyDelete(str, si, ei) {
  return str.slice(0, si - 1) + str.slice(ei);
}

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
// WRITING TIME FROM EDIT HISTORY — exact mirror of report.js calcSessions logic
// ══════════════════════════════════════════════════════════════════════════════
function getWritingTimeFromEdits(edits) {
  // Mirrors report.js calcSessions() + calcTotalWritingTime() exactly.
  // Each session spans from its first edit to its last edit.
  // A gap > SESSION_GAP between consecutive edits ends the current session.
  const SESSION_GAP = 600_000;
  if (!edits || edits.length === 0) return 0;

  let total = 0;
  let sessionStart = edits[0].time;

  for (let i = 0; i < edits.length - 1; i++) {
    const gap = edits[i + 1].time - edits[i].time;
    if (gap > SESSION_GAP) {
      total += edits[i].time - sessionStart;
      sessionStart = edits[i + 1].time;
    }
  }
  total += edits[edits.length - 1].time - sessionStart;
  return total;
}

function formatWritingTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} hr ${m} min ${sec} sec`;
  if (m > 0) return `${m} min ${sec} sec`;
  return `${sec} sec`;
}

// ══════════════════════════════════════════════════════════════════════════════
// COPY / PASTE DETECTION  (same doc-replay logic as report.js)
// ══════════════════════════════════════════════════════════════════════════════
async function getCopiedCount(edits) {
  try {
    if (!edits || edits.length === 0) return 0;

    const TIMEOUT_MS = 5000;
    const MIN_LEN = 20;
    const t0 = performance.now();

    const tabArr = [...new Set(edits.map((e) => e.tab || "first"))];
    let docStates = tabArr.map(() => "");

    const candidates = edits
      .map((e, i) => ({ ...e, _idx: i }))
      .filter((e) => e.ty === "is" && e.text && e.text.length >= MIN_LEN);

    if (candidates.length === 0) return 0;

    let candPtr = 0;
    let found = 0;

    for (let i = 0; i < edits.length; i++) {
      if (i % 500 === 0) {
        if (performance.now() - t0 > TIMEOUT_MS) return found;
        await new Promise((r) => setTimeout(r, 0));
      }

      const edit = edits[i];
      const tIdx = tabArr.indexOf(edit.tab || "first");
      if (tIdx < 0) continue;

      if (edit.ty === "is" && edit.text) {
        const docBefore = docStates[tIdx];
        docStates[tIdx] = _applyInsert(docStates[tIdx], edit.loc, edit.text);

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
    document.querySelector(".miniChapterSwitcherNavigationEntryPointIcon"),
  ].forEach((el) => {
    if (!el) return;
    try {
      const r = el.getBoundingClientRect();
      ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => {
        el.dispatchEvent(
          new PointerEvent(t, {
            bubbles: true,
            cancelable: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          }),
        );
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

      console.log("[Scriptrail infoBar] Message received:", msg?.type);

      // writingTimeTick is still sent by content.js every second but we no
      // longer use it — the live tick interval does the job from revision data.
      if (msg?.type === "writingTimeTick") return;

      // ── Full data refresh from revision API ───────────────────────────────
      if (msg?.type !== "sharedData") return;

      const edits = msg?.payload?.edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        console.warn("[Scriptrail infoBar] No edits received");
        return;
      }

      // Try to restore previously accumulated time before processing new data
      _loadSavedTime();

      if (!_barDismissed) {
        createInfoBar();
        const bar = document.getElementById("scriptrailInfoBar");
        if (bar) {
          bar.textContent = "Scriptrail: calculating…";
          bar.style.display = "block";
        }
      }

      try {
        const sessionCount = getWritingSessionCount(edits);
        const writingTimeMs = getWritingTimeFromEdits(edits);

        // CRITICAL: Only update _baseWritingTimeMs if it represents a NEW/LATER time
        // than what the live tick would currently show. This prevents the display from
        // reverting to old values when fresh data arrives with a stale last-edit timestamp.
        const currentLiveMs = _getLiveWritingTimeMs();
        if (writingTimeMs > currentLiveMs) {
          _baseWritingTimeMs = writingTimeMs;
          _lastFetchTime = Date.now();
          console.log(
            "[Scriptrail infoBar] Updated base time:",
            formatWritingTime(writingTimeMs),
            "→ live:",
            formatWritingTime(_getLiveWritingTimeMs()),
          );
        } else {
          // Data is stale; do NOT reset _lastFetchTime or it will revert the timer.
          // Just continue with the live tick as-is.
          console.log(
            "[Scriptrail infoBar] Stale data (calc:",
            formatWritingTime(writingTimeMs),
            "vs live:",
            formatWritingTime(currentLiveMs),
            "), keeping live tick",
          );
        }

        // Get copied count with timeout protection
        let copiedCount = "N/A";
        try {
          copiedCount = await Promise.race([
            getCopiedCount(edits),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("getCopiedCount timeout")),
                4500,
              ),
            ),
          ]);
        } catch (err) {
          console.warn("[Scriptrail infoBar] getCopiedCount error:", err);
          copiedCount = "N/A";
        }

        if (!_ctxOk()) return;

        // Display current live value (already extends the open session if active)
        const writingTimeFormatted = formatWritingTime(_getLiveWritingTimeMs());
        updateInfoBar(writingTimeFormatted, copiedCount, sessionCount);

        // Start the 1-second tick if not already running
        _startLiveTick();
      } catch (err) {
        console.error("[Scriptrail infoBar] Error processing data:", err);
        // Fallback: show at least the bar with placeholder values
        updateInfoBar("0 sec", "N/A", "0");
      }
    });
  } catch (err) {
    console.error("[Scriptrail infoBar] Listener setup failed:", err);
  }
}

setupInfoBarListener();

// Show the bar immediately on load so the user sees "loading…"
// _maybeShowBar() will keep it visible once data arrives.
createInfoBar();
_loadSavedTime();
_maybeShowBar();
