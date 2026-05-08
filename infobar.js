// ─── infoBar.js ───────────────────────────────────────────────────────────────
// Injected alongside content.js.
// Shows a thin stats bar: Writing Time | Copied Passages | Sessions

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT GUARD
// ══════════════════════════════════════════════════════════════════════════════
function _ctxOk() {
  try { return typeof chrome !== "undefined" && !!chrome.runtime?.id; }
  catch (_) { return false; }
}

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
  bar.id = "scriptrailInfoBar";
  bar.textContent = "Scriptrail: loading…";
  docsBar.appendChild(bar);

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
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "block";
  const icon = document.getElementById("scriptrailToggleIcon");
  if (icon) icon.remove();
  _clickNavClose();
}

function _hideInfoBar() {
  const bar = document.getElementById("scriptrailInfoBar");
  if (bar) bar.style.display = "none";
  _createToggleIcon();
  _clickNavClose();
}

function updateInfoBar(writingTime, copiedCount, sessionCount) {
  createInfoBar();
  const bar = document.getElementById("scriptrailInfoBar");
  if (!bar) return;
  bar.innerHTML = `
    <span class="sr-section">✍️ Writing Time: <strong>${writingTime}</strong></span>
    <span class="sr-divider">|</span>
    <span class="sr-section">📋 Copied Passages: <strong>${copiedCount}</strong></span>
    <span class="sr-divider">|</span>
    <span class="sr-section">🕐 Sessions: <strong>${sessionCount}</strong></span>
    <button id="scriptrailInfoBarClose" title="Close">×</button>
  `;
  document.getElementById("scriptrailInfoBarClose")?.addEventListener("click", _hideInfoBar);
  bar.style.display = "block";
}

// ══════════════════════════════════════════════════════════════════════════════
// STRING HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function _applyInsert(str, loc, text) { return str.slice(0, loc - 1) + text + str.slice(loc - 1); }
function _applyDelete(str, si, ei)    { return str.slice(0, si - 1) + str.slice(ei); }

// ══════════════════════════════════════════════════════════════════════════════
// WRITING TIME
// FIX: The old version only showed minutes, so anything < 2 min showed "1 min"
// or "0 min". Now shows hours + minutes + seconds so short sessions are visible.
// ══════════════════════════════════════════════════════════════════════════════
function getWritingTime(edits) {
  if (!edits || edits.length === 0) return "0 sec";

  const GAP_MS = 600_000; // 10-minute gap ends a session
  let totalMs  = 0;
  let sessionStart = edits[0].time;

  for (let i = 0; i < edits.length - 1; i++) {
    const gap = edits[i + 1].time - edits[i].time;
    if (gap > GAP_MS) {
      totalMs     += edits[i].time - sessionStart;  // close this session
      sessionStart = edits[i + 1].time;             // start next session
    }
  }
  // Always close the final (or only) session
  totalMs += edits[edits.length - 1].time - sessionStart;

  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (h > 0) return `${h} hr ${m} min ${s} sec`;
  if (m > 0) return `${m} min ${s} sec`;
  return `${s} sec`;
}

// ══════════════════════════════════════════════════════════════════════════════
// SESSION COUNT
// FIX: The old version used an "inSession" flag that missed the last edit in
// each session. Now simply starts at 1 and increments on every >10-min gap.
// ══════════════════════════════════════════════════════════════════════════════
function getWritingSessionCount(edits) {
  if (!edits || edits.length === 0) return 0;
  let sessions = 1; // always at least one session if edits exist
  for (let i = 0; i < edits.length - 1; i++) {
    if (edits[i + 1].time - edits[i].time > 600_000) sessions++;
  }
  return sessions;
}

// ══════════════════════════════════════════════════════════════════════════════
// COPY / PASTE DETECTION
//
// BUG THAT WAS FIXED:
//   Old code:  if (i === candidates[0]._idx - 1)  ← fires BEFORE the insert
//              Then checks docStates which does NOT yet contain the pasted text.
//              So `full.includes(text)` is always false → everything looks copied.
//
// THE FIX:
//   We snapshot docBefore = docStates[tIdx] BEFORE calling _applyInsert.
//   We apply the insert to update docStates[tIdx].
//   Then at  if (i === candidates[0]._idx)  we check docBefore.
//   If the text was NOT in the document the moment before it appeared as a
//   single large insert → it is externally copied/pasted.
//   Normal typing arrives character-by-character, never as a 50+ char insert.
// ══════════════════════════════════════════════════════════════════════════════
async function getCopiedCount(edits) {
  try {
    if (!edits || edits.length === 0) return 0;

    const TIMEOUT_MS = 3000;
    const MIN_LEN    = 50;
    const t0         = performance.now();

    const tabArr  = [...new Set(edits.map((e) => e.tab || "first"))];
    let docStates = tabArr.map(() => "");

    // All large inserts are candidates (with their original index stored)
    const candidates = edits
      .map((e, i) => ({ ...e, _idx: i }))
      .filter((e) => e.ty === "is" && e.text && e.text.length >= MIN_LEN);

    if (candidates.length === 0) return 0;

    let candPtr = 0; // index into candidates[]
    let found   = 0;

    for (let i = 0; i < edits.length; i++) {
      // Yield every 500 iterations to avoid blocking the Docs page
      if (i % 500 === 0) {
        if (performance.now() - t0 > TIMEOUT_MS) {
          console.warn("[Scriptrail] getCopiedCount: timeout, partial result");
          return found;
        }
        await new Promise((r) => setTimeout(r, 0));
      }

      const edit = edits[i];
      const tIdx = tabArr.indexOf(edit.tab || "first");
      if (tIdx < 0) continue;

      if (edit.ty === "is" && edit.text) {
        // ── Snapshot doc state BEFORE applying this insert ──────────────────
        const docBefore = docStates[tIdx];

        // Apply the insert
        docStates[tIdx] = _applyInsert(docStates[tIdx], edit.loc, edit.text);

        // ── Check: is this the next candidate? ──────────────────────────────
        if (candPtr < candidates.length && i === candidates[candPtr]._idx) {
          // If text was NOT already in the doc just before this insert →
          // it wasn't built up by typing, so it's an external paste
          if (!docBefore.includes(edit.text)) {
            found++;
          }
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
          bubbles:true, cancelable:true,
          clientX: r.left + r.width/2, clientY: r.top + r.height/2,
          pointerId:1, pointerType:"mouse", isPrimary:true
        }));
      });
    } catch (_) {}
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE LISTENER
// Receives { type:"sharedData", payload:{ edits, userMap, tabs } } relayed
// from background.js after content.js finishes fetching revisions.
// ══════════════════════════════════════════════════════════════════════════════
function setupInfoBarListener() {
  if (!_ctxOk()) return;
  try {
    chrome.runtime.onMessage.addListener(async (msg) => {
      if (!_ctxOk()) return; // context may have died while we awaited

      if (msg?.type !== "sharedData" && msg?.action !== "refreshData") return;

      const edits = msg?.payload?.edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        console.warn("[Scriptrail infoBar] No edits received");
        return;
      }

      // Show immediate "calculating" feedback
      createInfoBar();
      const bar = document.getElementById("scriptrailInfoBar");
      if (bar) { bar.textContent = "Scriptrail: calculating…"; bar.style.display = "block"; }

      // Calculate all three stats (copy detection is async)
      const writingTime  = getWritingTime(edits);
      const sessionCount = getWritingSessionCount(edits);
      const copiedCount  = await getCopiedCount(edits);

      updateInfoBar(writingTime, copiedCount, sessionCount);
    });
  } catch (err) {
    console.error("[Scriptrail infoBar] Listener setup failed:", err);
  }
}

setupInfoBarListener();