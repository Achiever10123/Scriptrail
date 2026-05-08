// ─── infoBar.js ───────────────────────────────────────────────────────────────
// Injected alongside content.js.
// Creates a thin stats bar below the Google Docs toolbar showing:
//   Writing Time | Copied Passages | Writing Sessions

// ── Create the info bar DOM ───────────────────────────────────────────────────
function createInfoBar() {
  try {
    const docsBar = document.getElementById("docs-bars");
    if (!docsBar) {
      console.warn("[Scriptrail] docs-bars element not found");
      return;
    }
    if (document.getElementById("scriptrailInfoBar")) return;

    // Inject styles
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
        letter-spacing: 0.01em;
      }
      #scriptrailInfoBar .sr-section {
        display: inline-block;
        margin: 0 6px;
      }
      #scriptrailInfoBar .sr-divider {
        color: #a5d6a7;
        margin: 0 4px;
      }
      #scriptrailInfoBarClose {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        background: none;
        border: none;
        font-size: 15px;
        cursor: pointer;
        color: #66bb6a;
        padding: 2px 5px;
        border-radius: 3px;
        line-height: 1;
      }
      #scriptrailInfoBarClose:hover { color: #2d6a2d; background: rgba(0,0,0,0.05); }
      #scriptrailToggleIcon {
        display: inline-flex;
        align-items: center;
        background: #f0f9f0;
        border: 1px solid #a5d6a7;
        border-radius: 4px;
        padding: 3px 8px;
        font-size: 11px;
        cursor: pointer;
        color: #2d6a2d;
        margin-left: 6px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #scriptrailToggleIcon:hover { background: #e0f5e0; }
    `;
    document.head.appendChild(style);

    // Create bar element
    const bar = document.createElement("div");
    bar.id = "scriptrailInfoBar";
    bar.textContent = "Scriptrail loading...";
    docsBar.appendChild(bar);

    _createToggleIcon();
  } catch (err) {
    console.error("[Scriptrail] Failed to create info bar:", err);
  }
}

// ── Toggle icon in the side toolbar (to re-open bar after close) ──────────────
function _createToggleIcon() {
  const sideBar = document.getElementById("docs-side-toolbar");
  if (!sideBar || document.getElementById("scriptrailToggleIcon")) return;

  const icon = document.createElement("div");
  icon.id = "scriptrailToggleIcon";
  icon.textContent = "Stats";
  icon.title = "Show Scriptrail Stats";

  try {
    icon.addEventListener("click", _showInfoBar);
    sideBar.appendChild(icon);
  } catch (err) {
    console.error("[Scriptrail] Failed to create toggle icon:", err);
  }
}

function _showInfoBar() {
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "block";
  const icon = document.getElementById("scriptrailToggleIcon");
  if (icon) {
    try {
      icon.remove();
    } catch (err) {
      console.error("[Scriptrail] Failed to remove toggle icon:", err);
    }
  }
  _clickNavigationClose();
}

function _hideInfoBar() {
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "none";
  _createToggleIcon();
  _clickNavigationClose();
}

// ── Update bar content ────────────────────────────────────────────────────────
function updateInfoBar(writingTime, copiedCount, sessionCount) {
  createInfoBar();

  const bar = document.getElementById("scriptrailInfoBar");
  if (!bar) return;

  try {
    bar.innerHTML = `
      <span class="sr-section">✍️ Writing Time: <strong>${writingTime}</strong></span>
      <span class="sr-divider">|</span>
      <span class="sr-section">📋 Copied Passages: <strong>${copiedCount}</strong></span>
      <span class="sr-divider">|</span>
      <span class="sr-section">🕐 Sessions: <strong>${sessionCount}</strong></span>
      <button id="scriptrailInfoBarClose" title="Close">×</button>
    `;

    const closeBtn = document.getElementById("scriptrailInfoBarClose");
    if (closeBtn) {
      closeBtn.addEventListener("click", _hideInfoBar);
    }

    bar.style.display = "block";
  } catch (err) {
    console.error("[Scriptrail] Failed to update info bar:", err);
  }
}

// ── String helpers (mirror content.js — infoBar runs in same page context) ────
function _applyInsert(str, loc, text) {
  return str.slice(0, loc - 1) + text + str.slice(loc - 1);
}

function _applyDelete(str, si, ei) {
  return str.slice(0, si - 1) + str.slice(ei);
}

// ── Calculate total writing time (ms → "X hr Y min") ─────────────────────────
function getWritingTime(edits) {
  if (!edits || edits.length === 0) return "0 hr 0 min";

  const SESSION_GAP = 600000; // 10 minutes in ms
  let totalMs = 0;
  let sessionStart = edits[0].time;

  for (let i = 0; i < edits.length - 1; i++) {
    const gap = edits[i + 1].time - edits[i].time;

    // If gap is > 10 min, end this session
    if (gap > SESSION_GAP) {
      // Add the duration of this session
      totalMs += edits[i].time - sessionStart;
      // Start new session from next edit
      sessionStart = edits[i + 1].time;
    }
  }

  // Add the final session
  totalMs += edits[edits.length - 1].time - sessionStart;

  const mins = Math.floor(totalMs / (1000 * 60));
  return `${Math.floor(mins / 60)} hr ${mins % 60} min`;
}

// ── Count writing sessions ────────────────────────────────────────────────────
function getWritingSessionCount(edits) {
  if (!edits || edits.length === 0) return 0;
  let sessions = 0;
  let inSession = false;

  for (let i = 0; i < edits.length - 1; i++) {
    if (!inSession) {
      sessions++;
      inSession = true;
    }
    const gap = edits[i + 1].time - edits[i].time;
    if (gap > 600000) inSession = false;
  }

  return sessions || (edits.length > 0 ? 1 : 0);
}

// ── Detect externally-copied text (async, time-bounded) ───────────────────────
async function getCopiedCount(edits) {
  try {
    if (!edits || edits.length === 0) return 0;

    const TIMEOUT_MS = 2000;
    const MIN_LEN = 50;
    const startPerfMs = performance.now();

    // Collect tabs
    const tabSet = new Set(edits.map((e) => e.tab || "first"));
    const tabArr = [...tabSet];

    // Large inserts are candidates
    let candidates = edits
      .map((e, i) => ({ ...e, _idx: i }))
      .filter((e) => e.ty === "is" && e.text && e.text.length > MIN_LEN);

    let docStates = tabArr.map(() => "");
    const found = [];

    for (let i = 0; i < edits.length; i++) {
      if (i % 500 === 0) {
        if (performance.now() - startPerfMs > TIMEOUT_MS) {
          console.warn("[Scriptrail] getCopiedCount timeout");
          return found.length;
        }
        await new Promise((r) => setTimeout(r, 0));
      }

      const edit = edits[i];
      const tIdx = tabArr.indexOf(edit.tab || "first");

      if (tIdx < 0) continue;

      if (edit.ty === "is" && edit.text) {
        docStates[tIdx] = _applyInsert(docStates[tIdx], edit.loc, edit.text);
      } else if (edit.ty === "ds") {
        const deleted = docStates[tIdx].slice(edit.si - 1, edit.ei);
        docStates[tIdx] = _applyDelete(docStates[tIdx], edit.si, edit.ei);
        // If deleted text matches a candidate, remove it
        if (deleted && deleted.length >= MIN_LEN) {
          for (let c = 0; c < candidates.length; c++) {
            if (candidates[c].text === deleted) {
              candidates.splice(c, 1);
              break;
            }
          }
        }
      }

      if (candidates.length > 0 && i === candidates[0]._idx - 1) {
        const full = docStates.join("");
        if (!full.includes(candidates[0].text)) {
          found.push(candidates[0]);
        }
        candidates.shift();
      }
    }

    return found.length;
  } catch (err) {
    console.error("[Scriptrail] getCopiedCount error:", err);
    return "N/A";
  }
}

// ── Workaround: click Docs navigation close button to refresh layout ──────────
function _clickNavigationClose() {
  try {
    const closeBtn = document.querySelector(".navigation-widget-hat-close");
    const miniBtn = document.querySelector(
      ".miniChapterSwitcherNavigationEntryPointIcon",
    );

    [closeBtn, miniBtn].forEach((el) => {
      if (!el) return;
      try {
        const rect = el.getBoundingClientRect();
        ["pointerdown", "mousedown", "mouseup", "click"].forEach((evType) => {
          el.dispatchEvent(
            new PointerEvent(evType, {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
            }),
          );
        });
      } catch (err) {
        // Silently ignore if element not available
      }
    });
  } catch (err) {
    console.error("[Scriptrail] Navigation close error:", err);
  }
}

// ── Listen for data from background.js ───────────────────────────────────────
function setupInfoBarListener() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime) {
      console.warn("[Scriptrail infoBar] Chrome API not available");
      return;
    }

    chrome.runtime.onMessage.addListener(async (msg) => {
      try {
        const isSharedData = msg?.type === "sharedData";
        const isRefreshData = msg?.action === "refreshData";

        if (isSharedData || isRefreshData) {
          const edits = msg?.payload?.edits;
          if (!edits) {
            console.warn("[Scriptrail infoBar] No edits in message payload");
            return;
          }

          const writingTime = getWritingTime(edits);
          const copiedCount = await getCopiedCount(edits);
          const sessionCount = getWritingSessionCount(edits);

          updateInfoBar(writingTime, copiedCount, sessionCount);
        }
      } catch (err) {
        console.error("[Scriptrail infoBar] Message handler error:", err);
      }
    });
  } catch (err) {
    console.error("[Scriptrail infoBar] Failed to setup listener:", err);
  }
}

// Initialize the listener on load
setupInfoBarListener();
