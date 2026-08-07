// ─── infoBar.js ───────────────────────────────────────────────────────────────
// Shows a thin stats bar: Writing Time | Copied Passages | Sessions
// Note: utils.js must be loaded before this file (see manifest.json)

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
  if (!isCtxValid() || !_documentId) return;
  const currentMs = _getLiveWritingTimeMs();
  safeStorageSet({ [_storageKey]: currentMs });
}

function _loadSavedTime() {
  if (!isCtxValid() || !_documentId) return;
  try {
    chrome.storage.local.get([_storageKey], (res) => {
      if (!isCtxValid()) return;
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
  } catch (e) {
    logError("_loadSavedTime", e);
  }
}

// Alias for compatibility with utils.js naming
const _ctxOk = isCtxValid;

// ══════════════════════════════════════════════════════════════════════════════
// CLOSE STATE (persists across data refreshes so bar stays hidden)
// ══════════════════════════════════════════════════════════════════════════════
let _barDismissed = false; // user clicked ×
let _lastCopiedCount = 0;
let _lastSessionCount = 0;
// Tracks what's currently shown so a language change can re-render it correctly
// without needing fresh data: "loading" | "calculating" | "error" | "data"
let _lastRenderState = "loading";

// Builds the "Scriptrail" header row shared by every bar state.
function _buildHeader() {
  const header = document.createElement("div");
  header.className = "sr-header";

  const iconWrap = document.createElement("span");
  iconWrap.className = "sr-header-icon";
  const icon = document.createElement("img");
  icon.src = chrome.runtime.getURL("icons/icon128.png");
  icon.alt = "";
  icon.width = 20;
  icon.height = 20;
  const dot = document.createElement("span");
  dot.className = "sr-header-dot";
  iconWrap.appendChild(icon);
  iconWrap.appendChild(dot);

  const title = document.createElement("span");
  title.className = "sr-header-title";
  const em = document.createElement("em");
  em.textContent = "Script";
  title.appendChild(em);
  title.appendChild(document.createTextNode("rail"));

  header.appendChild(iconWrap);
  header.appendChild(title);
  return header;
}

// Renders a header (wordmark + live dot) plus a centered status message.
// used for the loading / calculating / error states so they match the
// styled "data loaded" view instead of falling back to plain text.
function _renderStatus(bar, text) {
  clearElement(bar);

  const closeBtn = document.createElement("button");
  closeBtn.id = "scriptrailInfoBarClose";
  closeBtn.title = "Close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", _hideInfoBar);

  const body = document.createElement("div");
  body.className = "sr-body sr-body-status";
  const msg = document.createElement("p");
  msg.className = "sr-status-text";
  msg.textContent = text;
  body.appendChild(msg);

  bar.appendChild(closeBtn);
  bar.appendChild(_buildHeader());
  bar.appendChild(body);
}

// Re-renders whatever is currently on screen in the newly-selected language.
function _applyLanguage() {
  const bar = document.getElementById("scriptrailInfoBar");
  if (!bar) return;
  switch (_lastRenderState) {
    case "data":
      updateInfoBar(formatWritingTime(_getLiveWritingTimeMs()), _lastCopiedCount, _lastSessionCount);
      break;
    case "calculating":
      _renderStatus(bar, t("calculating"));
      break;
    case "error":
      _renderStatus(bar, t("loadError"));
      break;
    default:
      _renderStatus(bar, t("loading"));
  }
}

// ── Live-tick state (mirrors report.js calcSessions algorithm exactly) ────────
// After each API refresh we store:
//   _baseWritingTimeMs: calcTotalWritingTime() result from the revision data
//   _lastFetchTime: wall-clock Date.now() when we last received fresh data
//
// Every second the live tick checks: is the current wall-clock time still within
// SESSION_GAP of the last edit?  If yes, the current session is still "open" and
// we add (now - _lastFetchTime) to _baseWritingTimeMs to get the live total.
// exactly what report.js would show if it recalculated right now.
const _IB_SESSION_GAP = 600_000; // 10 min, must match report.js SESSION_GAP
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
      --sr-bg: #faf7f0;
      --sr-surface: #ffffff;
      --sr-border: #e3dcc9;
      --sr-border-strong: #cfc4a6;
      --sr-ink: #21262c;
      --sr-ink-soft: #545c64;
      --sr-ink-faint: #8a9096;
      --sr-blaze: #c97f2e;
      --sr-blaze-soft: #f2dfc0;
      --sr-pine: #2e7c6c;
      --sr-pine-soft: #d6ece7;
      --sr-clay: #a83f32;
      --sr-clay-soft: #f3d9d4;

      position: fixed;
      right: 0;
      top: 0;
      width: var(--scriptrail-panel-width, 280px);
      height: 100vh;
      background-color: var(--sr-bg);
      border-left: 1px solid var(--sr-border);
      box-shadow: -8px 0 24px -12px rgba(20, 16, 8, 0.18);
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--sr-ink);
      z-index: 10000;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    [data-theme="dark"] #scriptrailInfoBar {
      --sr-bg: #12161b;
      --sr-surface: #1a2027;
      --sr-border: #2b333d;
      --sr-border-strong: #3a4550;
      --sr-ink: #f1ece0;
      --sr-ink-soft: #a9b1b9;
      --sr-ink-faint: #6e7780;
      --sr-blaze: #e3a857;
      --sr-blaze-soft: #3a2f1c;
      --sr-pine: #5fb7a7;
      --sr-pine-soft: #16302b;
      --sr-clay: #d9776a;
      --sr-clay-soft: #3a1f1c;
      box-shadow: -8px 0 24px -12px rgba(0, 0, 0, 0.5);
    }
    #scriptrailInfoBar .sr-header {
      display: flex; align-items: center; gap: 8px;
      padding: 16px 44px 12px 16px;
      border-bottom: 1px dashed var(--sr-border-strong);
      flex: none;
    }
    #scriptrailInfoBar .sr-header-icon {
      position: relative;
      flex: none;
      display: block;
      line-height: 0;
    }
    #scriptrailInfoBar .sr-header-icon img {
      display: block;
      border-radius: 22%;
      object-fit: cover;
    }
    #scriptrailInfoBar .sr-header-dot {
      position: absolute;
      right: -2px; bottom: -2px;
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--sr-blaze); flex: none;
      border: 2px solid var(--sr-bg);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--sr-blaze) 30%, transparent);
      animation: sr-pulse 2.2s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      #scriptrailInfoBar .sr-header-dot { animation: none; }
    }
    @keyframes sr-pulse {
      0%, 100% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--sr-blaze) 30%, transparent); }
      50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--sr-blaze) 12%, transparent); }
    }
    #scriptrailInfoBar .sr-header-title {
      font-family: Georgia, "Times New Roman", serif;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: -0.01em;
    }
    #scriptrailInfoBar .sr-header-title em {
      font-style: italic; color: var(--sr-blaze); font-weight: 600;
    }
    #scriptrailInfoBar .sr-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px 16px 16px;
      overflow-y: auto;
    }
    #scriptrailInfoBar .sr-body-status {
      flex: 1;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 24px 20px;
    }
    #scriptrailInfoBar .sr-status-text {
      font-size: 12.5px;
      color: var(--sr-ink-soft);
      line-height: 1.5;
      margin: 0;
    }
    #scriptrailInfoBar .sr-section {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 12px 14px;
      background: var(--sr-surface);
      border: 1px solid var(--sr-border);
      border-radius: 10px;
      font-size: 13px;
      position: relative;
      transition: border-color 0.15s ease;
    }
    #scriptrailInfoBar .sr-section:hover { border-color: var(--sr-border-strong); }
    #scriptrailInfoBar .sr-section::before {
      content: "";
      position: absolute; left: 0; top: 14px; bottom: 14px;
      width: 3px; border-radius: 0 3px 3px 0;
      background: var(--sr-blaze);
      opacity: 0.7;
    }
    #scriptrailInfoBar .sr-section:nth-child(2)::before { background: var(--sr-pine); }
    #scriptrailInfoBar .sr-section:nth-child(3)::before { background: var(--sr-ink-faint); }
    #scriptrailInfoBar .sr-section-label {
      font-weight: 600;
      color: var(--sr-ink-faint);
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    #scriptrailInfoBar .sr-section-value {
      font-size: 18px;
      font-weight: 700;
      color: var(--sr-ink);
      font-variant-numeric: tabular-nums;
    }
    #scriptrailInfoBar .sr-divider { display: none; }
    #scriptrailInfoBarClose {
      position: absolute; right: 10px; top: 12px;
      background: none; border: none; font-size: 16px;
      cursor: pointer; color: var(--sr-ink-faint); padding: 4px 8px; border-radius: 6px;
      width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
      transition: color 0.15s ease, background-color 0.15s ease;
    }
    #scriptrailInfoBarClose:hover { color: var(--sr-clay); background: var(--sr-clay-soft); }
  `;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "scriptrailInfoBar";
  document.body.appendChild(panel);
  _renderStatus(panel, t("loading"));
}

function _showInfoBar() {
  _barDismissed = false;
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "block";
  _clickNavClose();
}

function _hideInfoBar() {
  _barDismissed = true;
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "none";
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
  // Use textContent instead of innerHTML to prevent XSS
  // Clear bar safely using DOM methods
  clearElement(bar);

  const closeBtn = document.createElement('button');
  closeBtn.id = 'scriptrailInfoBarClose';
  closeBtn.title = 'Close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', _hideInfoBar);
  bar.appendChild(closeBtn);
  bar.appendChild(_buildHeader());

  const contentDiv = document.createElement('div');
  contentDiv.className = 'sr-body';

  const sections = [
    { label: t('writingTime'), value: String(writingTime) },
    { label: t('copiedPassages'), value: String(copiedCount) },
    { label: t('sessions'), value: String(sessionCount) }
  ];

  sections.forEach(section => {
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'sr-section';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'sr-section-label';
    labelDiv.textContent = section.label;

    const valueDiv = document.createElement('div');
    valueDiv.className = 'sr-section-value';
    // Sanitize display values to prevent XSS
    valueDiv.textContent = sanitizeText(section.value, 50);

    sectionDiv.appendChild(labelDiv);
    sectionDiv.appendChild(valueDiv);
    contentDiv.appendChild(sectionDiv);
  });

  bar.appendChild(contentDiv);
}

// Updates only the writing-time <strong> every second; never forces bar visible.
function _updateWritingTimeOnly(writingTime) {
  const bar = document.getElementById("scriptrailInfoBar");
  if (!bar || _barDismissed) return;
  const valueSpan = bar.querySelector(".sr-section-value");
  if (valueSpan) valueSpan.textContent = writingTime;
}

// ══════════════════════════════════════════════════════════════════════════════
// LIVE TICK: updates writing time every second using the same logic as report.js
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
// WRITING TIME FROM EDIT HISTORY: exact mirror of report.js calcSessions logic
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
    const tabKeyToIdx = new Map(tabArr.map((k, i) => [k, i]));
    let docStates = tabArr.map(() => "");

    const candidates = edits
      .map((e, i) => ({ ...e, _idx: i }))
      .filter((e) => e.ty === "is" && e.text && e.text.length >= MIN_LEN);

    if (candidates.length === 0) return 0;

    // Create candidate lookup for O(1) access
    const candidateByIndex = new Map(candidates.map((c) => [c._idx, c]));

    let found = 0;

    for (let i = 0; i < edits.length; i++) {
      if (i % 500 === 0) {
        if (performance.now() - t0 > TIMEOUT_MS) return found;
        await new Promise((r) => setTimeout(r, 0));
      }

      const edit = edits[i];
      const tIdx = tabKeyToIdx.get(edit.tab || "first");
      if (tIdx === undefined) continue;

      if (edit.ty === "is" && edit.text) {
        const docBefore = docStates[tIdx];
        docStates[tIdx] = _applyInsert(docBefore, edit.loc, edit.text);

        const cand = candidateByIndex.get(i);
        if (cand && !docBefore.includes(edit.text)) {
          found++;
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

      // Handle theme updates from popup
      if (msg?.type === "themeUpdate" && msg.theme) {
        document.documentElement.setAttribute("data-theme", msg.theme);
        return;
      }

      // Handle language changes from settings
      if (msg?.type === "languageUpdate") {
        setScriptrailLanguage(msg.language);
        _applyLanguage();
        return;
      }

      // Handle infobar panel-width changes from settings
      if (msg?.type === "panelWidthUpdate" && msg.width) {
        setInfoBarWidth(msg.width);
        return;
      }

      // Handle infobar visibility toggle from popup
      if (msg?.type === "infobarUpdate") {
        if (msg.infobarValue === false) {
          _hideInfoBar();
        } else {
          _showInfoBar();
        }
        return;
      }

      // writingTimeTick is still sent by content.js every second but we no
      // longer use it; the live tick interval does the job from revision data.
      if (msg?.type === "writingTimeTick") return;

      // ── Full data refresh from revision API ───────────────────────────────
      if (msg?.type !== "sharedData") return;

      if (msg?.payload?.error) {
        console.warn("[Scriptrail infoBar] Data fetch failed");
        _lastRenderState = "error";
        createInfoBar();
        const bar = document.getElementById("scriptrailInfoBar");
        if (bar && !_barDismissed) {
          _renderStatus(bar, t("loadError"));
          bar.style.display = "block";
        }
        return;
      }

      const edits = msg?.payload?.edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        console.warn("[Scriptrail infoBar] No edits received");
        return;
      }

      // Try to restore previously accumulated time before processing new data
      _loadSavedTime();

      if (!_barDismissed) {
        _lastRenderState = "calculating";
        createInfoBar();
        const bar = document.getElementById("scriptrailInfoBar");
        if (bar) {
          _renderStatus(bar, t("calculating"));
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
          console.log(
            "[Scriptrail infoBar] Stale data (calc:",
            formatWritingTime(writingTimeMs),
            "vs live:",
            formatWritingTime(currentLiveMs),
            "), keeping live tick",
          );
        }

        // Get copied count with timeout protection using utility function
        let copiedCount = "N/A";
        try {
          copiedCount = await withTimeout(
            getCopiedCount(edits),
            SCRIPTRAIL_CONFIG.COPY_DETECTION_TIMEOUT_MS,
            "Copy detection"
          );
        } catch (err) {
          logError("getCopiedCount", err);
          copiedCount = "N/A";
        }

        if (!_ctxOk()) return;

        // Display current live value (already extends the open session if active)
        const writingTimeFormatted = formatWritingTime(_getLiveWritingTimeMs());
        _lastRenderState = "data";
        updateInfoBar(writingTimeFormatted, copiedCount, sessionCount);

        // Start the 1-second tick if not already running
        _startLiveTick();
      } catch (err) {
        logError("infoBar data processing", err);
        // Fallback: show at least the bar with placeholder values
        updateInfoBar("0 sec", "N/A", "0");
      }
    });
  } catch (err) {
    logError("infoBar listener setup", err);
  }
}

setupInfoBarListener();

// Load the saved language first so the initial render is already translated,
// then check infobar visibility and show the bar with "loading…",
// _maybeShowBar() will keep it visible once data arrives.
loadScriptrailLanguage(() => {
  chrome.storage.sync.get(["infobarEnabled", "infobarWidth"], (res) => {
    const infobarEnabled = res.infobarEnabled !== false;
    if (res.infobarWidth) setInfoBarWidth(res.infobarWidth);
    if (!infobarEnabled) {
      _hideInfoBar();
    }
  });
  createInfoBar();
  _loadSavedTime();
  _maybeShowBar();
});
