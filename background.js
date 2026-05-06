// background.js — service worker
// Receives events from content.js, organises and saves them to chrome.storage

// ─── Listen for events from content.js ──────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'TRACK_EVENT') return;

  const event = message.payload;

  handleEvent(event);
  sendResponse({ status: 'ok' });
  return true; // keeps the message channel open for async
});

// ─── Main Handler ────────────────────────────────────────

async function handleEvent(event) {
  const { docId, docTitle, type, timestamp } = event;

  // Load existing data for this doc (or create fresh structure)
  const existing = await getDocData(docId);

  // Get or create the current session
  let session = getCurrentSession(existing.sessions);

  if (!session || type === 'session_start') {
    // Start a brand new session
    session = createSession(timestamp);
    existing.sessions.push(session);
    existing.docTitle = docTitle; // update title in case it changed
  }

  // Add the event to the current session
  session.events.push({
    type,
    timestamp,
    ...(event.charCount !== undefined && { charCount: event.charCount }),
    ...(event.wordCount !== undefined && { wordCount: event.wordCount }),
  });

  // Update session summary stats
  updateSessionStats(session, type, timestamp);

  // Save back to storage
  await saveDocData(docId, existing);
}

// ─── Session Logic ───────────────────────────────────────

function getCurrentSession(sessions) {
  if (!sessions.length) return null;

  const last = sessions[sessions.length - 1];
  const now = Date.now();
  const GAP_LIMIT = 60 * 60 * 1000; // 1 hour gap = new session

  // If user has been gone more than 1 hour, treat as a new session
  if (now - last.lastActivity > GAP_LIMIT) return null;

  return last;
}

function createSession(timestamp) {
  return {
    sessionId: `s_${timestamp}`,
    startTime: timestamp,
    lastActivity: timestamp,
    events: [],
    stats: {
      keystrokes: 0,
      deletes: 0,
      pastes: 0,
      pastedChars: 0,
      idleCount: 0,
      activeTime: 0, // ms of actual writing time
    }
  };
}

function updateSessionStats(session, type, timestamp) {
  session.lastActivity = timestamp;

  const s = session.stats;

  if (type === 'keystroke') s.keystrokes++;
  if (type === 'delete')    s.deletes++;
  if (type === 'paste')     s.pastes++;
  if (type === 'idle')      s.idleCount++;

  // Calculate active time (time between first and last non-idle event)
  const activeEvents = session.events.filter(e =>
    e.type !== 'idle' && e.type !== 'blur'
  );
  if (activeEvents.length >= 2) {
    s.activeTime = activeEvents[activeEvents.length - 1].timestamp
                 - activeEvents[0].timestamp;
  }
}

// ─── Storage Helpers ─────────────────────────────────────

async function getDocData(docId) {
  return new Promise((resolve) => {
    chrome.storage.local.get(docId, (result) => {
      resolve(result[docId] || {
        docId,
        docTitle: 'Untitled',
        sessions: []
      });
    });
  });
}

async function saveDocData(docId, data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [docId]: data }, resolve);
  });
}

// ─── On Install ──────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('Scriptrail installed ✓');
});