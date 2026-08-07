// ─── report.js ────────────────────────────────────────────────────────────────
// Runs inside report.html (the full-page report tab).
// Mirrors Aidify's data-page logic with our own variable names and structure.
// All data comes from the Google Docs revision API. No server needed.
// Note: utils.js must be loaded before this file (see report.html)

// ══════════════════════════════════════════════════════════════════════════════
// 0.  GLOBALS
// ══════════════════════════════════════════════════════════════════════════════
let globalEdits = []; // all parsed edits for the document
let globalUsers = {}; // { userId: { name, color } }
let globalTabs = []; // ordered list of tab keys found in edits
let tabsData = {}; // { tabKey: "Tab label" }, from localStorage
let firstContent = ""; // document content at revision 1

// Alias for compatibility with utils.js naming  
const _ctxOk = typeof isCtxValid === 'function' ? isCtxValid : () => true;

// Chart instances (kept so we can destroy before redrawing)
let chartDate, chartTime, chartTimePerDay, chartGroupPie;

// Sessions array, populated by getWritingSessions() and reused by displaySessions()
let _sessions = [];

const SESSIONS_PREVIEW = 3;
const COPY_PREVIEW = 3;

// ══════════════════════════════════════════════════════════════════════════════
// 1.  UTILITIES
// ══════════════════════════════════════════════════════════════════════════════
function applyInsert(str, loc, text) {
  return str.slice(0, loc - 1) + text + str.slice(loc - 1);
}

function applyDelete(str, si, ei) {
  return str.slice(0, si - 1) + str.slice(ei);
}

// utils.js isn't loaded on this page (report.js is standalone), so this
// mirrors utils.js's clearElement() exactly.
function clearElement(element) {
  if (!element) return;
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function formatDate(ms) {
  return new Date(ms).toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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
  r = Math.round(Math.min(255, r + ((255 - r) * pct) / 100));
  g = Math.round(Math.min(255, g + ((255 - g) * pct) / 100));
  b = Math.round(Math.min(255, b + ((255 - b) * pct) / 100));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2.  DATA FETCHING
// ══════════════════════════════════════════════════════════════════════════════

const REPORT_FETCH_TIMEOUT_MS = 15000;

// Local timeout wrapper; report.js runs standalone (no utils.js on this page)
async function withTimeout(promise, timeoutMs, operationName = "Operation") {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchTileData(docId, token, baseurl) {
  const url = `${baseurl}${docId}/revisions/tiles?id=${docId}&start=1&showDetailedRevisions=false&token=${encodeURIComponent(token)}`;
  const res = await withTimeout(fetch(url), REPORT_FETCH_TIMEOUT_MS, "Tiles fetch");
  if (!res.ok) throw new Error("tiles fetch failed");
  const text = await res.text();
  return JSON.parse(text.slice(")]}'".length));
}

async function fetchChangelog(docId, token, baseurl, totalRevs) {
  const url = `${baseurl}${docId}/revisions/load?id=${docId}&start=1&end=${totalRevs}&token=${encodeURIComponent(token)}`;
  const res = await withTimeout(fetch(url), REPORT_FETCH_TIMEOUT_MS, "Revision fetch");
  if (!res.ok) throw new Error("changelog fetch failed");
  const text = await res.text();
  return JSON.parse(text.slice(")]}'".length));
}

async function fetchFirstContent(docId, token, baseurl) {
  const url = `${baseurl}${docId}/showrevision?start=1&end=1&id=${docId}&token=${encodeURIComponent(token)}`;
  const res = await withTimeout(fetch(url), REPORT_FETCH_TIMEOUT_MS, "First revision fetch");
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
  const len = changelog.length;
  for (let i = 0; i < len; i++) {
    const entry = changelog[i];
    let type;
    try {
      type = entry[0].ty;
    } catch (_) {}

    if (type === "is" || type === "iss") {
      edits.push({
        ty: "is",
        text: entry[0].s,
        loc: entry[0].ibi,
        time: entry[1],
        userId: entry[2],
        tab: "first",
      });
    } else if (type === "ds" || type === "dss") {
      edits.push({
        ty: "ds",
        si: entry[0].si,
        ei: entry[0].ei,
        time: entry[1],
        userId: entry[2],
        tab: "first",
      });
    } else if (type === "mlti") {
      const mts = entry[0].mts;
      const mtsLen = mts.length;
      for (let j = 0; j < mtsLen; j++) {
        generateEdits([[mts[j], entry[1], entry[2]]], edits);
      }
    } else if (type === "nm") {
      const nmc = entry[0].nmc;
      const tab = entry[0].nmr[1];
      if (nmc.ty === "is") {
        edits.push({
          ty: "is",
          text: nmc.s,
          loc: nmc.ibi,
          time: entry[1],
          userId: entry[2],
          tab,
        });
      } else if (nmc.ty === "ds") {
        edits.push({
          ty: "ds",
          si: nmc.si,
          ei: nmc.ei,
          time: entry[1],
          userId: entry[2],
          tab,
        });
      }
    }
  }
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
  clearElement(container);

  tabKeys.forEach((key, i) => {
    const div = document.createElement("div");
    div.id = key;
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
  document
    .querySelectorAll(".tab-item")
    .forEach((el) => el.classList.remove("active"));
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

function renderDocStats(edits, savedTimeMs = 0) {
  let text = "";
  let deletes = 0;
  const editsLen = edits.length;

  for (let i = 0; i < editsLen; i++) {
    const e = edits[i];
    if (e.ty === "is") text = applyInsert(text, e.loc, e.text);
    else if (e.ty === "ds") {
      text = applyDelete(text, e.si, e.ei);
      deletes++;
    }
  }

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const calculatedTimeMs = calcTotalWritingTime(edits);
  // Use saved time if it's greater (infobar has live-ticked it forward)
  const timeMs = Math.max(calculatedTimeMs, savedTimeMs);
  const totalMins = Math.floor(timeMs / 60_000);

  document.getElementById("statWords").textContent = `Word Count: ${wordCount}`;
  document.getElementById("statDeletes").textContent = `Deletes: ${deletes}`;
  
  // Build statTime safely with textContent to prevent XSS
  const statTimeEl = document.getElementById("statTime");
  clearElement(statTimeEl);
  const tooltipWrap1 = document.createElement('span');
  tooltipWrap1.className = 'tooltip-wrap';
  tooltipWrap1.style.cursor = 'default';
  tooltipWrap1.textContent = 'Time Spent';
  const tooltipText1 = document.createElement('span');
  tooltipText1.className = 'tooltip-text';
  tooltipText1.textContent = 'Active typing time; gaps > 10 min end a session.';
  tooltipWrap1.appendChild(tooltipText1);
  statTimeEl.appendChild(tooltipWrap1);
  statTimeEl.appendChild(document.createTextNode(`: ${Math.floor(totalMins / 60)} hr ${totalMins % 60} min`));
  
  // Build statEdits safely with textContent to prevent XSS
  const statEditsEl = document.getElementById("statEdits");
  clearElement(statEditsEl);
  const tooltipWrap2 = document.createElement('span');
  tooltipWrap2.className = 'tooltip-wrap';
  tooltipWrap2.style.cursor = 'default';
  tooltipWrap2.textContent = 'Edits';
  const tooltipText2 = document.createElement('span');
  tooltipText2.className = 'tooltip-text';
  tooltipText2.textContent = 'Total inserts + deletes, including pastes.';
  tooltipWrap2.appendChild(tooltipText2);
  statEditsEl.appendChild(tooltipWrap2);
  statEditsEl.appendChild(document.createTextNode(`: ${edits.length}`));
}

// ══════════════════════════════════════════════════════════════════════════════
// 7.  WRITING TIME & SESSIONS
// ══════════════════════════════════════════════════════════════════════════════
const SESSION_GAP = 600_000; // 10 minutes

function calcSessions(edits) {
  if (!edits || edits.length === 0) return [];
  const sessions = [];
  let sessionStart = edits[0].time;
  let revCount = 1; // Start with the first edit

  for (let i = 0; i < edits.length - 1; i++) {
    const gap = edits[i + 1].time - edits[i].time;
    if (gap > SESSION_GAP) {
      // Session ends at current edit, start new session at next
      sessions.push({
        startTime: new Date(sessionStart),
        endTime: new Date(edits[i].time),
        duration: edits[i].time - sessionStart,
        revisions: revCount,
      });
      sessionStart = edits[i + 1].time;
      revCount = 1; // Reset for new session
    } else {
      revCount++;
    }
  }

  // Always add the final session
  if (edits.length > 0) {
    sessions.push({
      startTime: new Date(sessionStart),
      endTime: new Date(edits[edits.length - 1].time),
      duration: edits[edits.length - 1].time - sessionStart,
      revisions: revCount,
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
  const sessionCardsEl = document.getElementById("sessionCards");
  clearElement(sessionCardsEl);

  const seeAllBtn = document.getElementById("showAllSessionsBtn");
  const hideBtn = document.getElementById("hideSessionsBtn");

  function showSessions(from, to) {
    const container = document.getElementById("sessionCards");
    clearElement(container);
    for (let i = from; i < to; i++) {
      const s = _sessions[i];
      const div = document.createElement("div");
      div.className = "session-card";
      // Use textContent to prevent XSS - build DOM safely
      const p1 = document.createElement('p');
      const label1 = document.createElement('span');
      label1.className = 'label';
      label1.textContent = 'Start:';
      p1.appendChild(label1);
      p1.appendChild(document.createTextNode(' ' + formatDate(s.startTime)));
      
      const p2 = document.createElement('p');
      const label2 = document.createElement('span');
      label2.className = 'label';
      label2.textContent = 'Duration:';
      p2.appendChild(label2);
      p2.appendChild(document.createTextNode(' ' + formatDuration(s.duration)));
      
      const p3 = document.createElement('p');
      const label3 = document.createElement('span');
      label3.className = 'label';
      label3.textContent = 'Edits:';
      p3.appendChild(label3);
      p3.appendChild(document.createTextNode(' ' + String(s.revisions)));
      
      div.appendChild(p1);
      div.appendChild(p2);
      div.appendChild(p3);
      container.appendChild(div);
    }
  }

  if (count > SESSIONS_PREVIEW) {
    showSessions(0, SESSIONS_PREVIEW);
    seeAllBtn.style.display = "inline-block";
    hideBtn.style.display = "none";
  } else {
    showSessions(0, count);
    seeAllBtn.style.display = "none";
    hideBtn.style.display = "none";
  }

  seeAllBtn.onclick = () => {
    showSessions(0, count);
    seeAllBtn.style.display = "none";
    hideBtn.style.display = "inline-block";
  };
  hideBtn.onclick = () => {
    showSessions(0, SESSIONS_PREVIEW);
    seeAllBtn.style.display = "inline-block";
    hideBtn.style.display = "none";
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 8.  COPY / PASTE DETECTION
// ══════════════════════════════════════════════════════════════════════════════

async function detectCopiedText(edits, userId = "default") {
  const TIMEOUT = 7_000;
  const MIN_LEN = 20;
  const started = performance.now();
  const showLinks =
    document.getElementById("showLinksCheckbox")?.checked ?? true;

  const tabKeys = [...new Set(edits.map((e) => e.tab))];
  const tabKeyToIdx = new Map(tabKeys.map((k, i) => [k, i]));
  let docStates = tabKeys.map(() => "");
  const found = [];

  // Pre-filter candidates once
  let candidates = edits
    .map((e, i) => ({ ...e, _idx: i }))
    .filter((e) => e.ty === "is" && e.text && e.text.length >= MIN_LEN);

  if (userId !== "default")
    candidates = candidates.filter((e) => e.userId === userId);

  if (!showLinks) {
    candidates = candidates.filter((e) => {
      const t = e.text.trim();
      return !(t.startsWith("http") && !t.includes(" "));
    });
  }

  // Create candidate lookup for O(1) access
  const candidateByIndex = new Map(candidates.map((c) => [c._idx, c]));

  for (let i = 0; i < edits.length; i++) {
    if (i % 700 === 0) {
      if (performance.now() - started > TIMEOUT) {
        _renderCopyCards(found, edits);
        document.getElementById("copyCount").textContent = " (partial)";
        return;
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    const edit = edits[i];
    const tIdx = tabKeyToIdx.get(edit.tab || "first");
    if (tIdx === undefined) continue;

    if (edit.ty === "is" && edit.text) {
      const docBefore = docStates[tIdx];
      docStates[tIdx] = applyInsert(docStates[tIdx], edit.loc, edit.text);

      const cand = candidateByIndex.get(i);
      if (cand) {
        const normBefore = docBefore.replace(/\s+/g, " ");
        const normText = edit.text.replace(/\s+/g, " ").trim();

        if (normText.length >= MIN_LEN && !normBefore.includes(normText)) {
          found.push(edit);
        }
      }
    } else if (edit.ty === "ds") {
      docStates[tIdx] = applyDelete(docStates[tIdx], edit.si, edit.ei);
    }
  }

  _renderCopyCards(found, edits);
  document.getElementById("copyCount").textContent = ` (${found.length})`;
}

function _renderCopyCards(items, allEdits) {
  const container = document.getElementById("copyCardContainer");
  const showAllBtn = document.getElementById("showAllCopyBtn");
  const hideBtn = document.getElementById("hideCopyBtn");

  function render(from, to) {
    clearElement(container);
    for (let i = from; i < to; i++) {
      const item = items[i];
      const card = document.createElement("div");
      card.className = "copy-card";
      // Use textContent to prevent XSS - build DOM safely
      const metaP = document.createElement('p');
      metaP.className = 'copy-meta';
      const userName = globalUsers[item.userId]?.name ?? item.userId;
      metaP.textContent = `${formatDate(item.time)} by ${userName}`;
      
      const textDiv = document.createElement('div');
      textDiv.textContent = item.text;
      
      card.appendChild(metaP);
      card.appendChild(textDiv);
      card.addEventListener("click", () => _jumpToEdit(item, allEdits));
      container.appendChild(card);
    }
  }

  if (items.length > COPY_PREVIEW) {
    render(0, COPY_PREVIEW);
    showAllBtn.style.display = "inline-block";
    hideBtn.style.display = "none";
  } else {
    render(0, items.length);
    showAllBtn.style.display = "none";
  }

  showAllBtn.onclick = () => {
    render(0, items.length);
    showAllBtn.style.display = "none";
    hideBtn.style.display = "inline-block";
  };
  hideBtn.onclick = () => {
    render(0, COPY_PREVIEW);
    showAllBtn.style.display = "inline-block";
    hideBtn.style.display = "none";
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
      document
        .getElementById("playbackSlider")
        .scrollIntoView({ behavior: "smooth" });
    }, 150);
  } else {
    const slider = document.getElementById("playbackSlider");
    slider.value = posInTab;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    document
      .getElementById("playbackSlider")
      .scrollIntoView({ behavior: "smooth" });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 9.  CHARTS
// ══════════════════════════════════════════════════════════════════════════════

const CHART_COLOR = "rgba(227, 168, 87, 1.0)"; // blaze amber
const CHART_LINE_COLOR = "rgba(79, 166, 151, 1.0)"; // pine teal
const CHART_FILL_COLOR = "rgba(227, 168, 87, 0.14)";
let CHART_GRID_COLOR = "rgba(20, 20, 20, 0.08)"; // set per-theme in initializeDarkMode()

function buildDateChart(edits) {
  const dateMap = new Map();
  const editsLen = edits.length;

  for (let i = 0; i < editsLen; i++) {
    const e = edits[i];
    const d = new Date(e.time);
    const key = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    dateMap.set(key, (dateMap.get(key) || 0) + 1);
  }

  const labels = [...dateMap.keys()];
  const data = [...dateMap.values()];

  if (chartDate) chartDate.destroy();
  chartDate = new Chart(document.getElementById("dateChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: CHART_COLOR,
          backgroundColor: CHART_FILL_COLOR,
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointBackgroundColor: CHART_COLOR,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          pointHoverBackgroundColor: CHART_LINE_COLOR,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: {
          title: { display: true, text: "Date" },
          grid: { color: CHART_GRID_COLOR },
        },
        y: {
          title: { display: true, text: "Edits" },
          beginAtZero: true,
          grid: { color: CHART_GRID_COLOR },
        },
      },
      onClick(_, elements) {
        if (elements.length > 0) {
          const idx = elements[0].index;
          const parts = labels[idx].split("/");
          const date = new Date(
            parseInt(parts[0]),
            parseInt(parts[1]) - 1,
            parseInt(parts[2]),
          );
          buildHourChart(edits, date);
        }
      },
    },
  });
}

function buildHourChart(edits, filterDate) {
  let filtered = edits;
  const resetBtn = document.getElementById("resetTimeChartBtn");

  if (filterDate && filterDate !== "all") {
    filtered = edits.filter((e) => {
      const d = new Date(e.time);
      return (
        d.getFullYear() === filterDate.getFullYear() &&
        d.getMonth() === filterDate.getMonth() &&
        d.getDate() === filterDate.getDate()
      );
    });
    const label = `${filterDate.getFullYear()}/${String(filterDate.getMonth() + 1).padStart(2, "0")}/${String(filterDate.getDate()).padStart(2, "0")}`;
    document.getElementById("hourChartDateLabel").textContent = label;
    resetBtn.style.display = "inline-block";
  } else {
    document.getElementById("hourChartDateLabel").textContent = "All Dates";
    resetBtn.style.display = "none";
  }

  const hourMap = new Map();
  const filteredLen = filtered.length;
  for (let i = 0; i < filteredLen; i++) {
    const e = filtered[i];
    const h = new Date(e.time).getHours();
    hourMap.set(h, (hourMap.get(h) || 0) + 1);
  }

  const sortedHours = [...hourMap.keys()].sort((a, b) => a - b);
  const labels = sortedHours.map((h) => {
    const period = h >= 12 ? "PM" : "AM";
    const hour = h % 12 || 12;
    return `${hour} ${period}`;
  });
  const data = sortedHours.map((h) => hourMap.get(h));

  if (chartTime) chartTime.destroy();
  chartTime = new Chart(document.getElementById("timeChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: CHART_COLOR,
          backgroundColor: CHART_FILL_COLOR,
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointBackgroundColor: CHART_COLOR,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          pointHoverBackgroundColor: CHART_LINE_COLOR,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: {
          title: { display: true, text: "Hour of Day" },
          grid: { color: CHART_GRID_COLOR },
        },
        y: {
          title: { display: true, text: "Edits" },
          beginAtZero: true,
          grid: { color: CHART_GRID_COLOR },
        },
      },
    },
  });
}

function buildTimePerDayChart(edits) {
  const dayMap = new Map();
  const editsLen = edits.length;

  for (let i = 0; i < editsLen; i++) {
    const e = edits[i];
    const d = new Date(e.time);
    const key = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(e);
  }

  const labels = [];
  const data = [];
  const dayKeys = [...dayMap.keys()];
  const dayKeysLen = dayKeys.length;

  for (let i = 0; i < dayKeysLen; i++) {
    const key = dayKeys[i];
    labels.push(key);
    const ms = calcTotalWritingTime(dayMap.get(key));
    data.push(Math.round(ms / 60_000));
  }

  if (chartTimePerDay) chartTimePerDay.destroy();
  chartTimePerDay = new Chart(document.getElementById("timePerDayChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: CHART_COLOR,
          backgroundColor: CHART_FILL_COLOR,
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointBackgroundColor: CHART_COLOR,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          pointHoverBackgroundColor: CHART_LINE_COLOR,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: {
          title: { display: true, text: "Date" },
          grid: { color: CHART_GRID_COLOR },
        },
        y: {
          title: { display: true, text: "Minutes" },
          beginAtZero: true,
          grid: { color: CHART_GRID_COLOR },
        },
      },
    },
  });
}

async function buildGroupPieChart(edits, users, metric = "time") {
  const names = [];
  const data = [];
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
    type: "doughnut",
    data: {
      labels: names,
      datasets: [
        {
          data,
          backgroundColor: colors.map((c) => c + "20"),
          borderColor: colors,
          borderWidth: 3,
          hoverOffset: 12,
        },
      ],
    },
    options: {
      plugins: {
        legend: {
          position: "right",
          labels: {
            font: { size: 12, weight: "600" },
            padding: 15,
            usePointStyle: true,
          },
        },
        tooltip: {
          backgroundColor: "rgba(30, 27, 75, 0.9)",
          titleFont: { size: 13, weight: "700" },
          bodyFont: { size: 12, weight: "600" },
          padding: 12,
          borderColor: "rgba(139, 92, 246, 0.5)",
          borderWidth: 1,
          callbacks: {
            label(ctx) {
              return metric === "time"
                ? `${ctx.parsed} min`
                : `${ctx.parsed} edits`;
            },
          },
        },
      },
    },
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
    const opt = document.createElement("option");
    opt.value = uid;
    opt.text = info.name || "Anonymous";
    sel.appendChild(opt);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 11.  EDIT REPLAY ENGINE
// ══════════════════════════════════════════════════════════════════════════════

function replayToIndex(edits, index, initialContent) {
  let docBefore = initialContent;
  let docAfter = initialContent;

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
    document.getElementById("replayDate").textContent = "";
    return;
  }

  document.getElementById("replayDate").textContent = formatDate(edit.time);

  // Build HTML safely using DOM methods instead of innerHTML
  const area = document.getElementById("playbackArea");
  // Clear area safely using DOM methods
  clearElement(area);

  if (edit.ty === "is") {
    const before = docAfter.slice(0, edit.loc - 1);
    const ins = edit.text;
    const after = docAfter.slice(edit.loc - 1 + ins.length);
    const cls =
      highlightUserId !== "default" && edit.userId === highlightUserId
        ? "ins-hl"
        : "ins";
    
    // Create text node for before
    area.appendChild(document.createTextNode(before));
    
    // Create mark element for insertion
    const mark = document.createElement('mark');
    mark.id = 'scrollMark';
    mark.className = cls;
    mark.textContent = ins;
    area.appendChild(mark);
    
    // Create text node for after
    area.appendChild(document.createTextNode(after));
  } else if (edit.ty === "ds") {
    const pre = docBefore.slice(0, edit.si - 1);
    const deleted = docBefore.slice(edit.si - 1, edit.ei);
    const post = docBefore.slice(edit.ei);
    
    // Create text node for pre
    area.appendChild(document.createTextNode(pre));
    
    // Create del element for deletion
    const delEl = document.createElement('del');
    delEl.id = 'scrollMark';
    delEl.className = 'del';
    delEl.textContent = deleted;
    area.appendChild(delEl);
    
    // Create text node for post
    area.appendChild(document.createTextNode(post));
  } else {
    area.textContent = docAfter;
  }

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
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function initVideoReplay(allEdits, initialContent) {
  const slider = document.getElementById("playbackSlider");
  const playBtn = document.getElementById("playBtn");
  const nextBtn = document.getElementById("nextEditBtn");
  const prevBtn = document.getElementById("prevEditBtn");
  const speedSel = document.getElementById("speedSelect");
  const hlSelect = document.getElementById("highlightUserSelect");

  let playing = false;
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
    currentIdx = idx;
  }

  function startPlay() {
    const speed = parseFloat(speedSel.value);
    playing = true;
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

  playBtn.addEventListener("click", () => (playing ? stopPlay() : startPlay()));

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
    if (playing) {
      stopPlay();
      startPlay();
    }
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
  const slider = document.getElementById("playbackSlider");
  const filtered = filterByTab(allEdits, getActiveTab()).slice(
    0,
    parseInt(slider.value) + 1,
  );

  let text = initialContent;
  let authors = new Array(initialContent.length).fill(null);

  filtered.forEach((e) => {
    if (e.ty === "is") {
      const before = authors.slice(0, e.loc - 1);
      const newArr = new Array(e.text.length).fill(e.userId);
      const after = authors.slice(e.loc - 1);
      authors = before.concat(newArr, after);
      text = applyInsert(text, e.loc, e.text);
    } else if (e.ty === "ds") {
      authors = authors.slice(0, e.si - 1).concat(authors.slice(e.ei));
      text = applyDelete(text, e.si, e.ei);
    }
  });

  // Build coloured HTML safely using DOM methods
  const playbackArea = document.getElementById("playbackArea");
  // Clear playbackArea safely using DOM methods
  clearElement(playbackArea);

  let curUid = authors[0];
  let segment = text[0] || "";

  for (let i = 1; i < text.length; i++) {
    if (authors[i] === curUid) {
      segment += text[i];
    } else {
      if (curUid && users[curUid]) {
        const span = document.createElement('span');
        span.style.backgroundColor = lightenColor(users[curUid].color);
        span.textContent = segment;
        playbackArea.appendChild(span);
      } else {
        playbackArea.appendChild(document.createTextNode(segment));
      }
      segment = text[i];
      curUid = authors[i];
    }
  }
  // Last segment
  if (segment) {
    if (curUid && users[curUid]) {
      const span = document.createElement('span');
      span.style.backgroundColor = lightenColor(users[curUid].color);
      span.textContent = segment;
      playbackArea.appendChild(span);
    } else {
      playbackArea.appendChild(document.createTextNode(segment));
    }
  }

  // Legend
  const legend = document.getElementById("groupBreakdownColors");
  // Clear legend safely using DOM methods
  clearElement(legend);

  Object.entries(users).forEach(([uid, info]) => {
    const tag = document.createElement("span");
    tag.className = "user-color-tag";
    tag.textContent = info.name || "Anonymous";
    tag.style.backgroundColor = lightenColor(info.color || "#aaa");
    legend.appendChild(tag);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 13.  FULL REPORT RENDER (called on load and on user filter change)
// ══════════════════════════════════════════════════════════════════════════════

async function renderFullReport(edits, users, savedTimeMs = 0) {
  renderDocStats(edits, savedTimeMs);
  renderSessionsSection(edits);
  buildDateChart(edits);
  buildHourChart(edits, "all");
  buildTimePerDayChart(edits);
  buildGroupPieChart(
    edits,
    users,
    document.getElementById("groupMetricSelect").value,
  );
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
        name: info.name || "Anonymous",
        color: info.color || "#888",
      };
    }
  });
  return cleaned;
}

// ══════════════════════════════════════════════════════════════════════════════
// 15. ENTRY POINT: DOMContentLoaded
// ══════════════════════════════════════════════════════════════════════════════

// Dark mode functions
function initializeDarkMode() {
  const darkModeBtn = document.getElementById("themeToggleBtn");
  const savedTheme = localStorage.getItem("scriptrail-theme") || "light";

  // Apply saved theme
  if (savedTheme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    if (darkModeBtn) darkModeBtn.textContent = "☀️";
  } else {
    document.documentElement.removeAttribute("data-theme");
    if (darkModeBtn) darkModeBtn.textContent = "🌙";
  }
  _applyChartTheme(savedTheme === "dark");

  // Add toggle listener
  if (darkModeBtn) {
    darkModeBtn.addEventListener("click", () => {
      const currentTheme = document.documentElement.getAttribute("data-theme");
      const newTheme = currentTheme === "dark" ? "light" : "dark";

      document.documentElement.setAttribute("data-theme", newTheme);
      localStorage.setItem("scriptrail-theme", newTheme);

      darkModeBtn.textContent = newTheme === "dark" ? "☀️" : "🌙";

      _applyChartTheme(newTheme === "dark");
      // Redraw existing charts so their canvas colors pick up the change.
      // CSS variables don't reach into already-rendered canvas content.
      if (globalEdits && globalEdits.length) {
        const uid = document.getElementById("userSelect")?.value || "default";
        renderFullReport(filterByUser(globalEdits, uid), globalUsers, 0);
      }
    });
  }
}

// Sets Chart.js's default text/grid colors to match the active theme.
// Canvas-rendered charts don't pick up CSS custom properties, so this has
// to happen in JS whenever the theme changes.
function _applyChartTheme(isDark) {
  CHART_GRID_COLOR = isDark ? "rgba(241, 236, 224, 0.10)" : "rgba(33, 38, 44, 0.08)";
  if (window.Chart) {
    Chart.defaults.color = isDark ? "#A9B1B9" : "#545C64";
    Chart.defaults.borderColor = CHART_GRID_COLOR;
  }
}

// Export to Markdown function
function exportToMarkdown() {
  const docTitle = document.getElementById("docTitle").textContent;
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  
  let mdContent = `# ${docTitle}\n\n`;
  mdContent += `*Exported from Scriptrail on ${new Date().toLocaleDateString()}*\n\n`;
  mdContent += `---\n\n`;
  
  // Add sections
  mdContent += `## Edit History\n\n`;
  mdContent += `Total revisions: ${globalEdits.length}\n\n`;
  
  // Add copy/paste section
  const copyCount = document.getElementById("copyCount")?.textContent || "0";
  mdContent += `## Copy/Paste Detection\n\n`;
  mdContent += `Detected ${copyCount} instances of copied text.\n\n`;
  
  // Add sessions section
  const sessionCount = document.getElementById("sessionCount")?.textContent || "0";
  mdContent += `## Writing Sessions\n\n`;
  mdContent += `${sessionCount} writing sessions recorded.\n\n`;
  
  // Create blob and download
  const blob = new Blob([mdContent], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${docTitle.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.addEventListener("DOMContentLoaded", async () => {
  // Initialize dark mode first
  initializeDarkMode();

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

  const token = reportData.token;
  const baseurl = reportData.baseurl;
  const title = reportData.title;
  tabsData = reportData.tabs || {};
  // (Save tabsData to localStorage for future reloads if needed)
  try {
    localStorage.setItem("srTabsData", JSON.stringify(tabsData));
  } catch (_) {}

  document.getElementById("docTitle").textContent =
    title || "Untitled Document";

  const overlay = document.getElementById("loadingOverlay");
  overlay.style.display = "flex";

  try {
    // 1. Fetch tile metadata
    const loadingMsg = document.getElementById("loadingMessage");
    if (loadingMsg) loadingMsg.textContent = "Fetching revision data…";
    const tileData = await fetchTileData(docId, token, baseurl);
    const totalRevs = tileData.tileInfo[tileData.tileInfo.length - 1].end;
    const rawUsers = tileData.userMap;

    // 2. Fetch full changelog and first-revision content in parallel.
    // fetchFirstContent doesn't depend on totalRevs, so no need to wait for it.
    if (loadingMsg) loadingMsg.textContent = "Loading revision history…";
    const [changelogJson, firstContentResult] = await Promise.all([
      fetchChangelog(docId, token, baseurl, totalRevs),
      fetchFirstContent(docId, token, baseurl),
    ]);
    firstContent = firstContentResult;

    // 3. Parse edits
    globalEdits = generateEdits(changelogJson.changelog, []);

    // 4. Clean user map
    globalUsers = cleanUserMap(globalEdits, rawUsers);

    // 5. Build tabs panel
    if (loadingMsg) loadingMsg.textContent = "Building replay…";
    buildTabsPanel(globalEdits, true);

    // 7. Populate user dropdowns
    populateUserDropdown("highlightUserSelect", globalUsers);
    populateUserDropdown("userSelect", globalUsers);

    // 8. Init replay
    initVideoReplay(globalEdits, firstContent);

    // Load saved accumulated time from infobar if available
    let _reportSavedTimeMs = 0;
    const storageName = `scriptrail_writingTime_${docId}`;
    const savedData = await chrome.storage.local.get([storageName]);
    if (savedData[storageName] && typeof savedData[storageName] === "number") {
      _reportSavedTimeMs = savedData[storageName];
      console.log(
        "[Scriptrail report] Loaded saved time:",
        Math.floor(_reportSavedTimeMs / 60_000),
        "min"
      );
    }

    // 9. Render report (with saved time for all-users view)
    await renderFullReport(globalEdits, globalUsers, _reportSavedTimeMs);

    // ── Wire up group breakdown button
    document
      .getElementById("groupBreakdownBtn")
      .addEventListener("click", () => {
        // Pause replay if playing
        if (document.getElementById("playBtn").textContent === "Pause") {
          document.getElementById("playBtn").click();
        }
        setTimeout(
          () => renderGroupBreakdown(globalEdits, firstContent, globalUsers),
          80,
        );
      });

    // ── Wire up group metric dropdown
    document
      .getElementById("groupMetricSelect")
      .addEventListener("change", () => {
        buildGroupPieChart(
          filterByUser(
            globalEdits,
            document.getElementById("userSelect").value,
          ),
          globalUsers,
          document.getElementById("groupMetricSelect").value,
        );
      });

    // ── Wire up report user filter
    const userSelect = document.getElementById("userSelect");
    userSelect.addEventListener("change", async () => {
      const uid = userSelect.value;
      const label = userSelect.options[userSelect.selectedIndex].text;
      const filtered = filterByUser(globalEdits, uid);

      // Update all "All Users" labels
      document.getElementById("reportUserLabel").textContent = label;
      document.querySelectorAll(".report-user-span").forEach((el) => {
        el.textContent = label;
      });
      document.querySelectorAll(".stat-user-label").forEach((el) => {
        el.textContent = label;
      });

      // Don't use saved time when filtering by user; calculate fresh for that user only
      await renderFullReport(filtered, globalUsers, 0);
    });

    // ── Wire up "show links" checkbox
    document
      .getElementById("showLinksCheckbox")
      .addEventListener("change", async () => {
        const uid = document.getElementById("userSelect").value;
        const filtered = filterByUser(globalEdits, uid);
        await detectCopiedText(filtered, uid);
      });

    // ── Wire up reset time chart button
    document
      .getElementById("resetTimeChartBtn")
      .addEventListener("click", () => {
        const uid = document.getElementById("userSelect").value;
        const filtered = filterByUser(globalEdits, uid);
        buildHourChart(filtered, "all");
      });

    // ── Wire up export markdown button
    document
      .getElementById("exportMdBtn")
      .addEventListener("click", () => {
        exportToMarkdown();
      });
  } catch (err) {
    console.error("[Scriptrail] report error:", err);
    const timedOut = /timed out/i.test(err?.message || "");
    document.getElementById("loadingMessage").textContent = timedOut
      ? "The connection is too slow to load this report. Check your network and refresh."
      : "An error occurred. Make sure you have edit access to this document, then refresh.";
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
