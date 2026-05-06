// popup.js — reads from chrome.storage and renders the UI

// ─── Helpers ─────────────────────────────────────────────

function formatTime(ms) {
  if (!ms || ms < 1000) return '0m';
  const mins = Math.floor(ms / 60000);
  const hrs  = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

// ─── Get the active Google Docs tab ──────────────────────

async function getActiveDocId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.url?.includes('docs.google.com/document')) {
        resolve(null);
        return;
      }
      const match = tab.url.match(/\/d\/([a-zA-Z0-9_-]+)/);
      resolve(match ? match[1] : null);
    });
  });
}

// ─── Load data from storage ───────────────────────────────

async function loadDocData(docId) {
  return new Promise((resolve) => {
    chrome.storage.local.get(docId, (result) => {
      resolve(result[docId] || null);
    });
  });
}

// ─── Render UI ───────────────────────────────────────────

function renderStats(session) {
  const s = session.stats;
  document.getElementById('stat-keystrokes').textContent = s.keystrokes.toLocaleString();
  document.getElementById('stat-active').textContent     = formatTime(s.activeTime);
  document.getElementById('stat-pastes').textContent     = s.pastes;
  document.getElementById('stat-deletes').textContent    = s.deletes.toLocaleString();
}

function renderTimeline(session) {
  const bar = document.getElementById('timeline-bar');
  const events = session.events;
  if (!events.length) return;

  const start = events[0].timestamp;
  const end   = events[events.length - 1].timestamp;
  const span  = end - start || 1;

  bar.innerHTML = '';

  // Group events into 40 time buckets and colour each bucket
  const BUCKETS = 40;
  const buckets = Array(BUCKETS).fill(null);

  events.forEach(e => {
    const i = Math.floor(((e.timestamp - start) / span) * (BUCKETS - 1));
    if (!buckets[i] || e.type === 'paste') buckets[i] = e.type;
    else if (buckets[i] !== 'paste') buckets[i] = e.type;
  });

  buckets.forEach(type => {
    const block = document.createElement('div');
    block.className = `timeline-block ${type || 'idle'}`;
    block.style.width = `${100 / BUCKETS}%`;
    bar.appendChild(block);
  });
}

function renderSessions(sessions) {
  const list = document.getElementById('sessions-list');
  list.innerHTML = '';

  // Show most recent 5 sessions
  [...sessions].reverse().slice(0, 5).forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.innerHTML = `
      <span class="session-row-label">
        ${i === 0 ? 'Current' : formatDate(s.startTime)}
      </span>
      <span class="session-row-stat">
        ${s.stats.keystrokes} keys · ${formatTime(s.stats.activeTime)}
      </span>
    `;
    list.appendChild(row);
  });
}

// ─── Clear data ───────────────────────────────────────────

async function clearData(docId) {
  if (!confirm('Clear all tracking data for this document?')) return;
  chrome.storage.local.remove(docId, () => location.reload());
}

// ─── Main ─────────────────────────────────────────────────

async function init() {
  const docId = await getActiveDocId();
  const pill  = document.getElementById('status-pill');

  if (!docId) {
    // Not on a Google Doc
    document.getElementById('doc-title').textContent = 'No document open';
    document.getElementById('doc-sub').textContent   = 'Open a Google Doc to start tracking';
    return;
  }

  pill.textContent = 'active';
  pill.classList.add('active');

  const data = await loadDocData(docId);

  if (!data || !data.sessions.length) {
    document.getElementById('doc-title').textContent = 'Waiting for activity...';
    document.getElementById('doc-sub').textContent   = 'Start typing in your document';
    return;
  }

  // Show doc info
  document.getElementById('doc-title').textContent = data.docTitle;
  document.getElementById('doc-sub').textContent   =
    `${data.sessions.length} session${data.sessions.length > 1 ? 's' : ''} tracked`;

  // Render current session stats
  const currentSession = data.sessions[data.sessions.length - 1];
  renderStats(currentSession);
  renderTimeline(currentSession);
  renderSessions(data.sessions);

  // Wire up buttons
  document.getElementById('btn-clear').addEventListener('click', () => clearData(docId));
  document.getElementById('btn-export').addEventListener('click', () => {
    // We'll build this in exporter.js next
    chrome.tabs.create({ url: chrome.runtime.getURL(`report.html?docId=${docId}`) });
  });
}

init();