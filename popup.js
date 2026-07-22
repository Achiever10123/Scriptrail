// ─── popup.js ─────────────────────────────────────────────────────────────────
// Controls the extension popup.
// - Reads and writes the "toggleState" from chrome.storage.sync
// - Notifies all Google Docs tabs when the toggle changes
// - Handles dark mode theme toggle

document.addEventListener("DOMContentLoaded", () => {
  const checkbox = document.getElementById("toggleCheckbox");
  const themeToggleBtn = document.getElementById("themeToggleBtn");

  // ── Load saved toggle state ────────────────────────────────────────────────
  chrome.storage.sync.get(["toggleState", "theme"], (res) => {
    // Default to true if never set
    const state = res.toggleState !== false;
    checkbox.checked = state;

    // Ensure storage is initialised on first install
    if (res.toggleState === undefined) {
      chrome.storage.sync.set({ toggleState: true });
    }

    // Apply saved theme
    const theme = res.theme || 'light';
    applyTheme(theme);
  });

  // ── Persist & broadcast toggle changes ────────────────────────────────────
  checkbox.addEventListener("change", () => {
    const newValue = checkbox.checked;
    chrome.storage.sync.set({ toggleState: newValue });
    chrome.runtime.sendMessage(
      { action: "toggleUpdate", toggleValue: newValue },
      () => { if (chrome.runtime.lastError) { /* popup may close first */ } }
    );
  });

  // ── Theme toggle functionality ─────────────────────────────────────────────
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      chrome.storage.sync.get(["theme"], (res) => {
        const currentTheme = res.theme || 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        chrome.storage.sync.set({ theme: newTheme }, () => {
          applyTheme(newTheme);
          // Broadcast theme change to all tabs
          chrome.runtime.sendMessage({ action: "themeUpdate", theme: newTheme });
        });
      });
    });
  }

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (themeToggleBtn) themeToggleBtn.textContent = '☀️';
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (themeToggleBtn) themeToggleBtn.textContent = '🌙';
    }
  }
});