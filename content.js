// content.js — injected into every Google Docs page
// Tracks: keystrokes, pastes, deletes, and idle time

const SESSION_START = Date.now();
let lastActivityTime = Date.now();
let idleTimer = null;
const IDLE_THRESHOLD = 30000; // 30 seconds of no activity = idle

// ─── Helpers ────────────────────────────────────────────

function getDocId() {
  // Extracts the doc ID from the URL: /document/d/DOC_ID/edit
  const match = window.location.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : 'unknown';
}

function getDocTitle() {
  // Google Docs puts the title in this element
  const el = document.querySelector('.docs-title-input');
  return el ? el.value || el.innerText : 'Untitled';
}

function sendEvent(type, extra = {}) {
  chrome.runtime.sendMessage({
    action: 'TRACK_EVENT',
    payload: {
      type,
      timestamp: Date.now(),
      docId: getDocId(),
      docTitle: getDocTitle(),
      ...extra
    }
  });
}

// ─── Idle Detection ──────────────────────────────────────

function resetIdleTimer() {
  lastActivityTime = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    sendEvent('idle', { idleSince: lastActivityTime });
  }, IDLE_THRESHOLD);
}

// ─── Event Listeners ────────────────────────────────────

// Keystroke tracking (fires on every key press inside the doc)
document.addEventListener('keydown', (e) => {
  resetIdleTimer();

  // Detect delete/backspace separately for analysis
  if (e.key === 'Backspace' || e.key === 'Delete') {
    sendEvent('delete');
  } else if (e.key.length === 1) {
    // Only count actual character keys (not Shift, Ctrl, etc.)
    sendEvent('keystroke');
  }
}, true); // 'true' = capture phase, fires before Google Docs can intercept

// Paste tracking (detects copy-paste behavior)
document.addEventListener('paste', (e) => {
  resetIdleTimer();
  const pastedText = e.clipboardData?.getData('text') || '';
  sendEvent('paste', {
    charCount: pastedText.length,
    wordCount: pastedText.trim().split(/\s+/).filter(Boolean).length
  });
}, true);

// Tab/window blur — user switched away from the doc
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    sendEvent('blur');
  } else {
    sendEvent('focus');
    resetIdleTimer();
  }
});

// ─── Session Start ───────────────────────────────────────

// Tell background.js a new session has started on this doc
sendEvent('session_start', { sessionStart: SESSION_START });

// Start the idle timer immediately
resetIdleTimer();