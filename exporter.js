// exporter.js — generates the full report page from chrome.storage data

// ─── Helpers ─────────────────────────────────────────────

function formatTime(ms) {
  if (!ms || ms < 1000) return '0m';
  const mins = Math.floor(ms / 60000);
  const hrs  = Math.floor(mins / 60);
  return hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function getDocIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('docId');
}

// ─── Integrity scoring ────────────────────────────────────

function scoreIntegrity(session) {
  const s = session.stats;
  const pasteRatio = s.pastedChars / Math.max(s.keystrokes, 1);

  if (pasteRatio > 0.5 || s.pastes > 3) return { label: 'Review', cls: 'badge-red' };
  if (s.pastes > 1)                      return { label: 'Caution', cls: 'badge-blue' };
  return                                        { label: 'Good', cls: 'badge-green' };
}

function overallIntegrity(sessions) {
  const flags = sessions.map(scoreIntegrity);
  if (flags.some(f => f.cls === 'badge-red'))   return 'Needs Review';
  if (flags.some(f => f.cls === 'badge-blue'))  return 'Caution';
  return 'Good';
}

// ─── Build timeline blocks ────────────────────────────────

function buildTimeline(session) {
  const events = session.events;
  if (!events.length) return '<div class="timeline-empty">No data</div>';

  const start = events[0].timestamp;
  const end   = events[events.length - 1].timestamp;
  const span  = end - start || 1;
  const BUCKETS = 60;
  const buckets = Array(BUCKETS).fill(null);

  events.forEach(e => {
    const i = Math.floor(((e.timestamp - start) / span) * (BUCKETS - 1));
    if (!buckets[i] || e.type === 'paste') buckets[i] = e.type;
    else if (buckets[i] !== 'paste') buckets[i] = e.type;
  });

  return buckets.map(t => {
    const color = t === 'paste'     ? 'rgba(124,159,252,0.9)'
                : t === 'keystroke' ? 'rgba(124,252,159,0.65)'
                :                     '#1f1f23';
    return `<div class="t-block" style="width:${100/BUCKETS}%;background:${color};height:100%"></div>`;
  }).join('');
}

// ─── Build sessions table rows ────────────────────────────

function buildSessionRows(sessions) {
  return [...sessions].reverse().map(s => {
    const integrity = scoreIntegrity(s);
    return `
      <tr>
        <td>${formatDate(s.startTime)}</td>
        <td>${formatTime(s.stats.activeTime)}</td>
        <td>${s.stats.keystrokes.toLocaleString()}</td>
        <td><span class="badge ${s.stats.pastes > 1 ? 'badge-red' : 'badge-green'}">${s.stats.pastes}</span></td>
        <td>${s.stats.deletes.toLocaleString()}</td>
        <td><span class="badge ${integrity.cls}">${integrity.label}</span></td>
      </tr>
    `;
  }).join('');
}

// ─── Build integrity notes ────────────────────────────────

function buildIntegrityNotes(sessions) {
  const totalPastes    = sessions.reduce((a, s) => a + s.stats.pastes, 0);
  const totalDeletes   = sessions.reduce((a, s) => a + s.stats.deletes, 0);
  const totalKeystrokes= sessions.reduce((a, s) => a + s.stats.keystrokes, 0);

  const notes = [];

  notes.push(totalPastes === 0
    ? { ok: true,  title: 'No paste events',          body: 'All content appears to have been typed directly.' }
    : { ok: false, title: `${totalPastes} paste events detected`, body: `${totalPastes} paste(s) detected. Review the sessions table for details.` }
  );

  notes.push(sessions.length > 1
    ? { ok: true,  title: 'Multiple sessions',         body: `Work was spread across ${sessions.length} sessions — a healthy writing pattern.` }
    : { ok: false, title: 'Single session only',       body: 'All writing happened in one sitting. Consider if this matches the assignment timeline.' }
  );

  notes.push(totalDeletes > 20
    ? { ok: true,  title: 'Active revision',           body: `${totalDeletes} delete events suggest genuine editing and refinement.` }
    : { ok: false, title: 'Very few revisions',        body: 'Low delete count may indicate pasted or pre-written content.' }
  );

  notes.push(totalKeystrokes > 500
    ? { ok: true,  title: 'Consistent typing rhythm',  body: 'Keystrokes were distributed naturally across sessions.' }
    : { ok: false, title: 'Low keystroke count',       body: 'Very few keystrokes recorded relative to document length.' }
  );

  return notes.map(n => `
    <div class="note-card ${n.ok ? 'ok' : 'warn'}">
      <div class="note-icon">${n.ok ? '✓' : '⚠'}</div>
      <div>
        <div class="note-title">${n.title}</div>
        <div class="note-body">${n.body}</div>
      </div>
    </div>
  `).join('');
}

// ─── Main render ─────────────────────────────────────────

async function renderReport() {
  const docId = getDocIdFromUrl();

  // Load data from storage
  const result = await new Promise(resolve =>
    chrome.storage.local.get(docId, resolve)
  );
  const data = result[docId];

  if (!data || !data.sessions.length) {
    document.getElementById('root').innerHTML =
      '<p style="padding:40px;font-family:monospace;color:#fc7c7c">No data found for this document.</p>';
    return;
  }

  const sessions = data.sessions;
  const totals = {
    activeTime:  sessions.reduce((a, s) => a + s.stats.activeTime,  0),
    keystrokes:  sessions.reduce((a, s) => a + s.stats.keystrokes,  0),
    pastes:      sessions.reduce((a, s) => a + s.stats.pastes,      0),
    deletes:     sessions.reduce((a, s) => a + s.stats.deletes,     0),
  };

  const currentSession = sessions[sessions.length - 1];
  const integrity = overallIntegrity(sessions);
  const integrityColor = integrity === 'Good' ? '#7cfc9f'
                       : integrity === 'Caution' ? '#7c9ffc'
                       : '#fc7c7c';

  document.getElementById('root').innerHTML = `
    <div class="header">
      <div class="header-left">
        <div class="brand">
          <div class="brand-dot"></div>
          <span class="brand-name">Scriptrail</span>
        </div>
        <div class="doc-title">${data.docTitle}</div>
        <div class="doc-meta">doc id: ${docId} · ${sessions.length} session${sessions.length > 1 ? 's' : ''}</div>
      </div>
      <div class="header-right">
        <div class="report-label">Writing Report</div>
        <div class="report-date">Generated ${new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}</div>
        <div class="integrity-badge" style="border-color:${integrityColor};color:${integrityColor}">
          <div class="integrity-dot" style="background:${integrityColor}"></div>
          Integrity: ${integrity}
        </div>
      </div>
    </div>

    <div class="content">

      <div class="summary-grid">
        <div class="sum-card highlight">
          <div class="sum-value">${formatTime(totals.activeTime)}</div>
          <div class="sum-label">Total active time</div>
        </div>
        <div class="sum-card">
          <div class="sum-value">${totals.keystrokes.toLocaleString()}</div>
          <div class="sum-label">Total keystrokes</div>
        </div>
        <div class="sum-card ${totals.pastes > 2 ? 'warn' : ''}">
          <div class="sum-value">${totals.pastes}</div>
          <div class="sum-label">Paste events</div>
        </div>
        <div class="sum-card">
          <div class="sum-value">${sessions.length}</div>
          <div class="sum-label">Sessions</div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-title">Activity timeline · latest session</span>
          <div class="section-line"></div>
        </div>
        <div class="timeline-wrap">
          <div class="timeline-track">${buildTimeline(currentSession)}</div>
          <div class="tl-legend">
            <div class="legend-item"><div class="legend-dot" style="background:rgba(124,252,159,0.65)"></div>Typing</div>
            <div class="legend-item"><div class="legend-dot" style="background:rgba(124,159,252,0.9)"></div>Paste</div>
            <div class="legend-item"><div class="legend-dot" style="background:#1f1f23;border:1px solid #333"></div>Idle</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-title">Sessions breakdown</span>
          <div class="section-line"></div>
        </div>
        <table class="sessions-table">
          <thead>
            <tr>
              <th>Date &amp; time</th><th>Duration</th><th>Keystrokes</th>
              <th>Pastes</th><th>Deletes</th><th>Integrity</th>
            </tr>
          </thead>
          <tbody>${buildSessionRows(sessions)}</tbody>
        </table>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-title">Integrity analysis</span>
          <div class="section-line"></div>
        </div>
        <div class="notes-grid">${buildIntegrityNotes(sessions)}</div>
      </div>

      <div class="report-footer">
        <div class="footer-brand">Scriptrail · writing integrity tracker</div>
        <div class="footer-note">All data is stored locally in your browser. Nothing is sent to any server.</div>
      </div>

    </div>
  `;
}

renderReport();