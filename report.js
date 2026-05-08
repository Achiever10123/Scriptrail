// ─── report.js ────────────────────────────────────────────────────────────────
// Runs inside report.html (the full-page report tab).
// Mirrors Aidify's data-page logic with our own variable names and structure.
// All data comes from the Google Docs revision API — no server needed.

// ══════════════════════════════════════════════════════════════════════════════
// 0.  GLOBALS
// ══════════════════════════════════════════════════════════════════════════════
let globalEdits   = [];   // all parsed edits for the document
let globalUsers   = {};   // { userId: { name, color } }
let globalTabs    = [];   // ordered list of tab keys found in edits
let tabsData      = {};   // { tabKey: "Tab label" } — from localStorage
let firstContent  = "";   // document content at revision 1

// Chart instances (kept so we can destroy before redrawing)
let chartDate, chartTime, chartTimePerDay, chartGroupPie;

// Sessions array — populated by getWritingSessions(), reused by displaySessions()
let _sessions = [];

const SESSIONS_PREVIEW = 3;
const COPY_PREVIEW     = 3;

// ══════════════════════════════════════════════════════════════════════════════
// 1.  UTILITIES
// ══════════════════════════════════════════════════════════════════════════════
function applyInsert(str, loc, text) {
  return str.slice(0, loc - 1) + text + str.slice(loc - 1);
}

function applyDelete(str, si, ei) {
  return str.slice(0, si - 1) + str.slice(ei);
}

function formatDate(ms) {
  return new Date(ms).toLocaleString("en-US", {
    month: "2-digit", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

function formatDuration(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${h}h ${m}m ${s}s`;
}

function lightenColor(hex, pct = 70) {
  hex = hex.replace(/^#/, "");
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4, 6), 16);
  r = Math.round(Math.min(255, r + (255 - r) * pct / 100));
  g = Math.round(Math.min(255, g + (255 - g) * pct / 100));
  b = Math.round(Math.min(255, b + (255 - b) * pct / 100));
  return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2.  DATA FETCHING
// ══════════════════════════════════════════════════════════════════════════════

async function fetchTileData(docId, token, baseurl) {
  const url = `${baseurl}${docId}/revisions/tiles?id=${docId}&start=1&showDetailedRevisions=false&token=${token}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error("tiles fetch failed");
  const text = await res.text();
  return JSON.parse(text.slice(")]}'".length));
}

async function fetchChangelog(docId, token, baseurl, totalRevs) {
  const loadingMsg = document.getElementById("loadingMessage");
  if (loadingMsg) loadingMsg.textContent = "Loading revision history…";

  const url = `${baseurl}${docId}/revisions/load?id=${docId}&start=1&end=${totalRevs}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error("changelog fetch failed");
  const text = await res.text();
  return JSON.parse(text.slice(")]}'".length));
}

async function fetchFirstContent(docId, token, baseurl) {
  const url = `${baseurl}${docId}/showrevision?start=1&end=1&id=${docId}&token=${token}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error("first revision fetch failed");
  const text = await res.text();
  const json = JSON.parse(text.slice(")]}'".length));
  let content = "";
  json.chunkedSnapshot?.forEach((chunk) => {
    chunk.forEach((op) => {
      if (op.ty === "is") content = applyInsert(content, op.ibi, op.s);
    });
  });
  return content;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3.  PARSE CHANGELOG → EDITS ARRAY
// ══════════════════════════════════════════════════════════════════════════════

function generateEdits(changelog, edits = []) {
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

// ══════════════════════════════════════════════════════════════════════════════
// 4.  FILTER HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function filterByUser(edits, userId) {
  if (userId === "default") return edits;
  return edits.filter((e) => e.userId === userId);
}

function filterByTab(edits, tabKey) {
  return edits.filter((e) => e.tab === tabKey);
}

function getActiveTab() {
  return document.querySelector(".tab-item.active")?.id || "first";
}

// ══════════════════════════════════════════════════════════════════════════════
// 5.  TABS PANEL
// ══════════════════════════════════════════════════════════════════════════════

function buildTabsPanel(edits, redraw = true) {
  if (!redraw) return;

  const tabKeys = [...new Set(edits.map((e) => e.tab))];
  globalTabs = tabKeys;

  const container = document.getElementById("tabsContainer");
  container.innerHTML = "";

  tabKeys.forEach((key, i) => {
    const div = document.createElement("div");
    div.id        = key;
    div.className = "tab-item" + (i === 0 ? " active" : "");

    let label = "Deleted Tab";
    for (const k in tabsData) {
      if (k.includes(key)) {
        label = tabsData[k];
        if (label.length > 22) label = label.slice(0, 22) + "…";
        break;
      }
    }
    if (key === "first") label = tabsData["first"] || "Main Tab";

    div.textContent = label;
    div.addEventListener("click", () => setActiveTab(key, edits));
    container.appendChild(div);
  });
}

function setActiveTab(key, edits) {
  document.querySelectorAll(".tab-item").forEach((el) => el.classList.remove("active"));
  const el = document.getElementById(key);
  if (el) el.classList.add("active");
  resetReplaySlider();
}

function resetReplaySlider() {
  const slider = document.getElementById("playbackSlider");
  if (slider) {
    slider.value = 0;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 6.  DOCUMENT STATS
// ══════════════════════════════════════════════════════════════════════════════

function renderDocStats(edits) {
  let text    = "";
  let deletes = 0;

  edits.forEach((e) => {
    if (e.ty === "is") text = applyInsert(text, e.loc, e.text);
    else if (e.ty === "ds") { text = applyDelete(text, e.si, e.ei); deletes++; }
  });

  const wordCount  = text.trim().split(/\s+/).filter(Boolean).length;
  const timeMs     = calcTotalWritingTime(edits);
  const totalMins  = Math.floor(timeMs / 60_000);

  document.getElementById("statWords").textContent   = `Word Count: ${wordCount}`;
  document.getElementById("statDeletes").textContent = `Deletes: ${deletes}`;
  document.getElementById("statTime").innerHTML =
    `<span class="tooltip-wrap" style="cursor:default">Time Spent<span class="tooltip-text">Active typing time; gaps > 10 min end a session.</span></span>: ${Math.floor(totalMins / 60)} hr ${totalMins % 60} min`;
  document.getElementById("statEdits").innerHTML =
    `<span class="tooltip-wrap" style="cursor:default">Edits<span class="tooltip-text">Total inserts + deletes, including pastes.</span></span>: ${edits.length}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 7.  WRITING TIME & SESSIONS
// ══════════════════════════════════════════════════════════════════════════════
const SESSION_GAP = 600_000; // 10 minutes

function calcSessions(edits) {
  if (!edits || edits.length === 0) return [];
  const sessions = [];
  let start      = edits[0].time;
  let revCount   = 0;

  for (let i = 0; i < edits.length - 1; i++) {
    revCount++;
    const gap = edits[i + 1].time - edits[i].time;
    if (gap > SESSION_GAP || i === edits.length - 2) {
      sessions.push({
        startTime: new Date(start),
        endTime:   new Date(edits[i].time),
        duration:  edits[i].time - start,
        revisions: revCount
      });
      start    = edits[i + 1].time;
      revCount = 0;
    }
  }

  if (sessions.length === 0 && edits.length > 0) {
    sessions.push({
      startTime: new Date(edits[0].time),
      endTime:   new Date(edits[edits.length - 1].time),
      duration:  edits[edits.length - 1].time - edits[0].time,
      revisions: edits.length
    });
  }

  return sessions;
}

function calcTotalWritingTime(edits) {
  return calcSessions(edits).reduce((sum, s) => sum + s.duration, 0);
}

function renderSessionsSection(edits) {
  _sessions = calcSessions(edits);
  const count = _sessions.length;

  document.getElementById("sessionCount").textContent = `(${count})`;
  document.getElementById("sessionCards").innerHTML    = "";

  const seeAllBtn  = document.getElementById("showAllSessionsBtn");
  const hideBtn    = document.getElementById("hideSessionsBtn");

  function showSessions(from, to) {
    const container = document.getElementById("sessionCards");
    container.innerHTML = "";
    for (let i = from; i < to; i++) {
      const s   = _sessions[i];
      const div = document.createElement("div");
      div.className   = "session-card";
      div.innerHTML   = `
        <p><span class="label">Start:</span> ${formatDate(s.startTime)}</p>
        <p><span class="label">Duration:</span> ${formatDuration(s.duration)}</p>
        <p><span class="label">Edits:</span> ${s.revisions}</p>
      `;
      container.appendChild(div);
    }
  }

  if (count > SESSIONS_PREVIEW) {
    showSessions(0, SESSIONS_PREVIEW);
    seeAllBtn.style.display  = "inline-block";
    hideBtn.style.display    = "none";
  } else {
    showSessions(0, count);
    seeAllBtn.style.display  = "none";
    hideBtn.style.display    = "none";
  }

  seeAllBtn.onclick = () => {
    showSessions(0, count);
    seeAllBtn.style.display = "none";
    hideBtn.style.display   = "inline-block";
  };
  hideBtn.onclick = () => {
    showSessions(0, SESSIONS_PREVIEW);
    seeAllBtn.style.display = "inline-block";
    hideBtn.style.display   = "none";
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 8.  COPY / PASTE DETECTION
// ══════════════════════════════════════════════════════════════════════════════

async function detectCopiedText(edits, userId = "default") {
  const TIMEOUT    = 7_000;
  const MIN_LEN    = 50;
  const started    = performance.now();
  const showLinks  = document.getElementById("showLinksCheckbox")?.checked ?? true;

  const tabKeys   = [...new Set(edits.map((e) => e.tab))];
  let docStates   = tabKeys.map(() => "");
  const found     = [];

  // Build candidates: large inserts, optionally filtered
  let candidates = edits
    .map((e, i) => ({ ...e, _idx: i }))
    .filter((e) => e.ty === "is" && e.text && e.text.length > MIN_LEN);

  if (userId !== "default") candidates = candidates.filter((e) => e.userId === userId);

  if (!showLinks) {
    candidates = candidates.filter((e) => {
      const t = e.text.trim();
      return !(t.startsWith("http") && !t.includes(" "));
    });
  }

  let candPtr = 0; // index into candidates[]

  for (let i = 0; i < edits.length; i++) {
    // Yield every 700 edits to avoid freezing the UI
    if (i % 700 === 0) {
      if (performance.now() - started > TIMEOUT) {
        _renderCopyCards(found, edits);
        document.getElementById("copyCount").textContent = " (partial)";
        return;
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    const edit = edits[i];
    const tIdx = tabKeys.indexOf(edit.tab || "first");
    if (tIdx < 0) continue;

    if (edit.ty === "is" && edit.text) {
      // ── Snapshot doc state BEFORE applying this insert ────────────
      const docBefore = docStates[tIdx];

      // Apply the insert
      docStates[tIdx] = applyInsert(docStates[tIdx], edit.loc, edit.text);

      // ── Check: is this the next candidate? ──────────────────────
      if (candPtr < candidates.length && i === candidates[candPtr]._idx) {
        // If text was NOT already in the doc just before this insert,
        // it wasn't built up by typing → it's an external paste
        if (!docBefore.includes(edit.text)) {
          found.push(edit);  // push the original edit (includes time, user, etc.)
        }
        candPtr++;
      }

    } else if (edit.ty === "ds") {
      // We still apply the deletion; no candidate checking needed
      docStates[tIdx] = applyDelete(docStates[tIdx], edit.si, edit.ei);
    }
  }

  _renderCopyCards(found, edits);
  document.getElementById("copyCount").textContent = ` (${found.length})`;
}

function _renderCopyCards(items, allEdits) {
  const container  = document.getElementById("copyCardContainer");
  const showAllBtn = document.getElementById("showAllCopyBtn");
  const hideBtn    = document.getElementById("hideCopyBtn");

  function render(from, to) {
    container.innerHTML = "";
    for (let i = from; i < to; i++) {
      const item = items[i];
      const card = document.createElement("div");
      card.className = "copy-card";
      card.innerHTML = `<p class="copy-meta">${formatDate(item.time)} — ${globalUsers[item.userId]?.name ?? item.userId}</p>${item.text}`;
      card.addEventListener("click", () => _jumpToEdit(item, allEdits));
      container.appendChild(card);
    }
  }

  if (items.length > COPY_PREVIEW) {
    render(0, COPY_PREVIEW);
    showAllBtn.style.display = "inline-block";
    hideBtn.style.display    = "none";
  } else {
    render(0, items.length);
    showAllBtn.style.display = "none";
  }

  showAllBtn.onclick = () => {
    render(0, items.length);
    showAllBtn.style.display = "none";
    hideBtn.style.display    = "inline-block";
  };
  hideBtn.onclick = () => {
    render(0, COPY_PREVIEW);
    showAllBtn.style.display = "inline-block";
    hideBtn.style.display    = "none";
  };
}

function _jumpToEdit(item, allEdits) {
  const targetTab = item.tab;
  const filteredForTab = filterByTab(allEdits, targetTab);

  // Count how many tab-edits came before this item's index
  let posInTab = 0;
  for (let i = 0; i < item._idx; i++) {
    if (allEdits[i]?.tab === targetTab) posInTab++;
  }

  // Switch tab if needed, then set slider
  if (getActiveTab() !== targetTab) {
    setActiveTab(targetTab, allEdits);
    setTimeout(() => {
      const slider = document.getElementById("playbackSlider");
      slider.value = posInTab;
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("playbackSlider").scrollIntoView({ behavior: "smooth" });
    }, 150);
  } else {
    const slider = document.getElementById("playbackSlider");
    slider.value = posInTab;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("playbackSlider").scrollIntoView({ behavior: "smooth" });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 9.  CHARTS
// ══════════════════════════════════════════════════════════════════════════════

const CHART_COLOR = "rgba(61, 212, 196, 1.0)";

function buildDateChart(edits) {
  const dateMap = new Map();

  edits.forEach((e) => {
    const d = new Date(e.time);
    const key = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
    dateMap.set(key, (dateMap.get(key) || 0) + 1);
  });

  const labels = [...dateMap.keys()];
  const data   = [...dateMap.values()];

  if (chartDate) chartDate.destroy();
  chartDate = new Chart(document.getElementById("dateChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{ data, backgroundColor: CHART_COLOR, borderColor: "transparent", maxBarThickness: 35 }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Date" } },
        y: { title: { display: true, text: "Edits" }, beginAtZero: true }
      },
      onClick(_, elements) {
        if (elements.length > 0) {
          const idx   = elements[0].index;
          const parts = labels[idx].split("/");
          const date  = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          buildHourChart(edits, date);
        }
      }
    }
  });
}

function buildHourChart(edits, filterDate) {
  let filtered = edits;
  const resetBtn = document.getElementById("resetTimeChartBtn");

  if (filterDate && filterDate !== "all") {
    filtered = edits.filter((e) => {
      const d = new Date(e.time);
      return d.getFullYear() === filterDate.getFullYear()
          && d.getMonth()    === filterDate.getMonth()
          && d.getDate()     === filterDate.getDate();
    });
    const label = `${filterDate.getFullYear()}/${String(filterDate.getMonth()+1).padStart(2,"0")}/${String(filterDate.getDate()).padStart(2,"0")}`;
    document.getElementById("hourChartDateLabel").textContent = label;
    resetBtn.style.display = "inline-block";
  } else {
    document.getElementById("hourChartDateLabel").textContent = "All Dates";
    resetBtn.style.display = "none";
  }

  const hourMap = new Map();
  filtered.forEach((e) => {
    const h = new Date(e.time).getHours();
    hourMap.set(h, (hourMap.get(h) || 0) + 1);
  });

  const sortedHours = [...hourMap.keys()].sort((a, b) => a - b);
  const labels = sortedHours.map((h) => {
    const period = h >= 12 ? "PM" : "AM";
    const hour   = h % 12 || 12;
    return `${hour} ${period}`;
  });
  const data = sortedHours.map((h) => hourMap.get(h));

  if (chartTime) chartTime.destroy();
  chartTime = new Chart(document.getElementById("timeChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{ data, backgroundColor: CHART_COLOR, borderColor: "transparent", maxBarThickness: 35 }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Hour of Day" } },
        y: { title: { display: true, text: "Edits" }, beginAtZero: true }
      }
    }
  });
}

function buildTimePerDayChart(edits) {
  const dayMap = new Map();

  edits.forEach((e) => {
    const d = new Date(e.time);
    const key = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(e);
  });

  const labels = [];
  const data   = [];

  dayMap.forEach((dayEdits, key) => {
    labels.push(key);
    const ms   = calcTotalWritingTime(dayEdits);
    data.push(Math.round(ms / 60_000));
  });

  if (chartTimePerDay) chartTimePerDay.destroy();
  chartTimePerDay = new Chart(document.getElementById("timePerDayChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{ data, backgroundColor: CHART_COLOR, borderColor: "transparent", maxBarThickness: 35 }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Date" } },
        y: { title: { display: true, text: "Minutes" }, beginAtZero: true }
      }
    }
  });
}

async function buildGroupPieChart(edits, users, metric = "time") {
  const names  = [];
  const data   = [];
  const colors = [];

  for (const uid in users) {
    const userEdits = filterByUser(edits, uid);
    if (userEdits.length === 0) continue;
    names.push(users[uid].name || "Anonymous");
    colors.push(users[uid].color || "#aaa");
    if (metric === "time") {
      data.push(Math.floor(calcTotalWritingTime(userEdits) / 60_000));
    } else {
      data.push(userEdits.length);
    }
  }

  if (chartGroupPie) chartGroupPie.destroy();
  chartGroupPie = new Chart(document.getElementById("groupPieChart"), {
    type: "pie",
    data: {
      labels: names,
      datasets: [{ data, backgroundColor: colors, borderColor: colors, borderWidth: 1 }]
    },
    options: {
      plugins: {
        tooltip: {
          callbacks: {
            label(ctx) {
              return metric === "time" ? `${ctx.parsed} min` : `${ctx.parsed} edits`;
            }
          }
        }
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 10.  USER DROPDOWN POPULATION
// ══════════════════════════════════════════════════════════════════════════════

function populateUserDropdown(selectId, users) {
  const sel = document.getElementById(selectId);
  // Remove all options except the first ("All Users" / "None")
  while (sel.options.length > 1) sel.remove(1);

  Object.entries(users).forEach(([uid, info]) => {
    const opt   = document.createElement("option");
    opt.value   = uid;
    opt.text    = info.name || "Anonymous";
    sel.appendChild(opt);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 11.  EDIT REPLAY ENGINE
// ══════════════════════════════════════════════════════════════════════════════

function replayToIndex(edits, index, initialContent) {
  let docBefore = initialContent;
  let docAfter  = initialContent;

  for (let i = 0; i < index; i++) {
    const e = edits[i];
    if (e.ty === "is") docBefore = applyInsert(docBefore, e.loc, e.text);
    else if (e.ty === "ds") docBefore = applyDelete(docBefore, e.si, e.ei);
  }

  docAfter = docBefore;
  if (index < edits.length) {
    const e = edits[index];
    if (e.ty === "is") docAfter = applyInsert(docAfter, e.loc, e.text);
    else if (e.ty === "ds") docAfter = applyDelete(docAfter, e.si, e.ei);
  }

  return { docBefore, docAfter };
}

function renderEditInPlayback(edits, index, initialContent, highlightUserId) {
  if (edits.length === 0) return;
  const { docBefore, docAfter } = replayToIndex(edits, index, initialContent);
  const edit = edits[index];

  if (!edit) {
    document.getElementById("playbackArea").textContent = docAfter;
    document.getElementById("replayDate").textContent   = "";
    return;
  }

  document.getElementById("replayDate").textContent = formatDate(edit.time);

  let html;
  if (edit.ty === "is") {
    const before = docAfter.slice(0, edit.loc - 1);
    const ins    = edit.text;
    const after  = docAfter.slice(edit.loc - 1 + ins.length);
    const cls    = (highlightUserId !== "default" && edit.userId === highlightUserId)
                   ? "ins-hl" : "ins";
    html = _esc(before) + `<mark id="scrollMark" class="${cls}">${_esc(ins)}</mark>` + _esc(after);
  } else if (edit.ty === "ds") {
    const pre     = docBefore.slice(0, edit.si - 1);
    const deleted = docBefore.slice(edit.si - 1, edit.ei);
    const post    = docBefore.slice(edit.ei);
    html = _esc(pre) + `<del id="scrollMark" class="del">${_esc(deleted)}</del>` + _esc(post);
  } else {
    html = _esc(docAfter);
  }

  const area = document.getElementById("playbackArea");
  area.innerHTML = html;

  // Auto-scroll to the marked span
  const mark = document.getElementById("scrollMark");
  if (mark) {
    const aRect = area.getBoundingClientRect();
    const mRect = mark.getBoundingClientRect();
    if (mRect.top < aRect.top || mRect.bottom > aRect.bottom - 10) {
      area.scrollTop = mark.offsetTop - area.offsetTop;
    }
  }
}

// Simple HTML escape
function _esc(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function initVideoReplay(allEdits, initialContent) {
  const slider     = document.getElementById("playbackSlider");
  const playBtn    = document.getElementById("playBtn");
  const nextBtn    = document.getElementById("nextEditBtn");
  const prevBtn    = document.getElementById("prevEditBtn");
  const speedSel   = document.getElementById("speedSelect");
  const hlSelect   = document.getElementById("highlightUserSelect");

  let playing   = false;
  let currentIdx = 0;
  let interval;

  function getFiltered() {
    return filterByTab(allEdits, getActiveTab());
  }

  function updateSliderMax() {
    const filtered = getFiltered();
    slider.min = 0;
    slider.max = Math.max(filtered.length - 1, 0);
  }

  function render(idx) {
    const filtered = getFiltered();
    renderEditInPlayback(filtered, idx, initialContent, hlSelect.value);
    slider.value = idx;
    currentIdx   = idx;
  }

  function startPlay() {
    const speed = parseFloat(speedSel.value);
    playing     = true;
    playBtn.textContent = "Pause";
    interval = setInterval(() => {
      const filtered = getFiltered();
      if (currentIdx < filtered.length - 1) {
        currentIdx++;
        render(currentIdx);
      } else {
        stopPlay();
      }
    }, 50 / speed);
  }

  function stopPlay() {
    playing = false;
    clearInterval(interval);
    playBtn.textContent = "Play";
  }

  playBtn.addEventListener("click", () => playing ? stopPlay() : startPlay());

  nextBtn.addEventListener("click", () => {
    stopPlay();
    updateSliderMax();
    const filtered = getFiltered();
    render(Math.min(currentIdx + 1, filtered.length - 1));
  });

  prevBtn.addEventListener("click", () => {
    stopPlay();
    updateSliderMax();
    render(Math.max(currentIdx - 1, 0));
  });

  speedSel.addEventListener("change", () => {
    if (playing) { stopPlay(); startPlay(); }
  });

  slider.addEventListener("input", () => {
    stopPlay();
    updateSliderMax();
    render(parseInt(slider.value));
  });

  // Initial render
  updateSliderMax();
  render(0);
}

// ══════════════════════════════════════════════════════════════════════════════
// 12.  GROUP BREAKDOWN (colour each character by author)
// ══════════════════════════════════════════════════════════════════════════════

function renderGroupBreakdown(allEdits, initialContent, users) {
  const slider   = document.getElementById("playbackSlider");
  const filtered = filterByTab(allEdits, getActiveTab()).slice(0, parseInt(slider.value) + 1);

  let text     = initialContent;
  let authors  = new Array(initialContent.length).fill(null);

  filtered.forEach((e) => {
    if (e.ty === "is") {
      const before = authors.slice(0, e.loc - 1);
      const newArr = new Array(e.text.length).fill(e.userId);
      const after  = authors.slice(e.loc - 1);
      authors = before.concat(newArr, after);
      text    = applyInsert(text, e.loc, e.text);
    } else if (e.ty === "ds") {
      authors = authors.slice(0, e.si - 1).concat(authors.slice(e.ei));
      text    = applyDelete(text, e.si, e.ei);
    }
  });

  // Build coloured HTML
  let html     = "";
  let curUid   = authors[0];
  let segment  = text[0] || "";

  for (let i = 1; i < text.length; i++) {
    if (authors[i] === curUid) {
      segment += text[i];
    } else {
      if (curUid && users[curUid]) {
        html += `<span style="background:${lightenColor(users[curUid].color)}">${_esc(segment)}</span>`;
      } else {
        html += _esc(segment);
      }
      segment = text[i];
      curUid  = authors[i];
    }
  }
  // Last segment
  if (segment) {
    if (curUid && users[curUid]) {
      html += `<span style="background:${lightenColor(users[curUid].color)}">${_esc(segment)}</span>`;
    } else {
      html += _esc(segment);
    }
  }

  document.getElementById("playbackArea").innerHTML = html;

  // Legend
  const legend = document.getElementById("groupBreakdownColors");
  legend.innerHTML = "";
  Object.entries(users).forEach(([uid, info]) => {
    const tag = document.createElement("span");
    tag.className             = "user-color-tag";
    tag.textContent           = info.name || "Anonymous";
    tag.style.backgroundColor = lightenColor(info.color || "#aaa");
    legend.appendChild(tag);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 13.  FULL REPORT RENDER (called on load and on user filter change)
// ══════════════════════════════════════════════════════════════════════════════

async function renderFullReport(edits, users) {
  renderDocStats(edits);
  renderSessionsSection(edits);
  buildDateChart(edits);
  buildHourChart(edits, "all");
  buildTimePerDayChart(edits);
  buildGroupPieChart(edits, users, document.getElementById("groupMetricSelect").value);
  await detectCopiedText(edits, document.getElementById("userSelect").value);
}

// ══════════════════════════════════════════════════════════════════════════════
// 14.  CLEAN UP USER MAP
// ══════════════════════════════════════════════════════════════════════════════

function cleanUserMap(edits, rawUserMap) {
  const activeUserIds = new Set(edits.map((e) => e.userId));
  const cleaned = {};
  Object.entries(rawUserMap).forEach(([uid, info]) => {
    if (activeUserIds.has(uid)) {
      cleaned[uid] = {
        name:  info.name || "Anonymous",
        color: info.color || "#888"
      };
    }
  });
  return cleaned;
}

// ══════════════════════════════════════════════════════════════════════════════
// 15.  ENTRY POINT — DOMContentLoaded
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", async () => {
  Chart.defaults.font.size = 13;

  const params = new URLSearchParams(window.location.search);
  const docId = params.get("id");

  // 1. Read saved report data (token, baseurl, title, tabs)
  const storageKey = `report_${docId}`;
  const stored = await chrome.storage.local.get(storageKey);
  const reportData = stored[storageKey];

  if (!reportData) {
    document.getElementById("loadingMessage").textContent =
      "Report data not found. Please reopen the report from the document.";
    return;
  }

  // Remove from storage (single‑use)
  chrome.storage.local.remove(storageKey);

  const token   = reportData.token;
  const baseurl = reportData.baseurl;
  const title   = reportData.title;
  tabsData      = reportData.tabs || {};
  // (Save tabsData to localStorage for future reloads if needed)
  try { localStorage.setItem("srTabsData", JSON.stringify(tabsData)); } catch (_) {}

  document.getElementById("docTitle").textContent = title || "Untitled Document";

  const overlay = document.getElementById("loadingOverlay");
  overlay.style.display = "flex";

  try {
    // 1. Fetch tile metadata
    const tileData  = await fetchTileData(docId, token, baseurl);
    const totalRevs = tileData.tileInfo[tileData.tileInfo.length - 1].end;
    const rawUsers  = tileData.userMap;

    // 2. Fetch full changelog
    const changelogJson = await fetchChangelog(docId, token, baseurl, totalRevs);

    // 3. Parse edits
    globalEdits = generateEdits(changelogJson.changelog, []);

    // 4. Clean user map
    globalUsers = cleanUserMap(globalEdits, rawUsers);

    // 5. Fetch first-revision content (starting point for replay)
    document.getElementById("loadingMessage").textContent = "Building replay…";
    firstContent = await fetchFirstContent(docId, token, baseurl);

    // 6. Build tabs panel
    buildTabsPanel(globalEdits, true);

    // 7. Populate user dropdowns
    populateUserDropdown("highlightUserSelect", globalUsers);
    populateUserDropdown("userSelect", globalUsers);

    // 8. Init replay
    initVideoReplay(globalEdits, firstContent);

    // 9. Render report
    await renderFullReport(globalEdits, globalUsers);

    // ── Wire up group breakdown button
    document.getElementById("groupBreakdownBtn").addEventListener("click", () => {
      // Pause replay if playing
      if (document.getElementById("playBtn").textContent === "Pause") {
        document.getElementById("playBtn").click();
      }
      setTimeout(() => renderGroupBreakdown(globalEdits, firstContent, globalUsers), 80);
    });

    // ── Wire up group metric dropdown
    document.getElementById("groupMetricSelect").addEventListener("change", () => {
      buildGroupPieChart(
        filterByUser(globalEdits, document.getElementById("userSelect").value),
        globalUsers,
        document.getElementById("groupMetricSelect").value
      );
    });

    // ── Wire up report user filter
    const userSelect = document.getElementById("userSelect");
    userSelect.addEventListener("change", async () => {
      const uid        = userSelect.value;
      const label      = userSelect.options[userSelect.selectedIndex].text;
      const filtered   = filterByUser(globalEdits, uid);

      // Update all "All Users" labels
      document.getElementById("reportUserLabel").textContent = label;
      document.querySelectorAll(".report-user-span").forEach((el) => {
        el.textContent = label;
      });
      document.querySelectorAll(".stat-user-label").forEach((el) => {
        el.textContent = label;
      });

      await renderFullReport(filtered, globalUsers);
    });

    // ── Wire up "show links" checkbox
    document.getElementById("showLinksCheckbox").addEventListener("change", async () => {
      const uid      = document.getElementById("userSelect").value;
      const filtered = filterByUser(globalEdits, uid);
      await detectCopiedText(filtered, uid);
    });

    // ── Wire up reset time chart button
    document.getElementById("resetTimeChartBtn").addEventListener("click", () => {
      const uid      = document.getElementById("userSelect").value;
      const filtered = filterByUser(globalEdits, uid);
      buildHourChart(filtered, "all");
    });

  } catch (err) {
    console.error("[Scriptrail] report error:", err);
    document.getElementById("loadingMessage").innerHTML =
      "An error occurred — make sure you have edit access to this document, then refresh.";
    return;
  }

  // Hide overlay
  overlay.style.display = "none";
});


// Restore tabsData from localStorage (if page was refreshed)
try {
  const stored = localStorage.getItem("srTabsData");
  if (stored) tabsData = JSON.parse(stored);
} catch (_) {}