// ─── popup.js ─────────────────────────────────────────────────────────────────
// Controls the extension popup.
// - Reads and writes the "toggleState" from chrome.storage.sync
// - Notifies all Google Docs tabs when the toggle changes

document.addEventListener("DOMContentLoaded", () => {
  const checkbox = document.getElementById("toggleCheckbox");

  // ── Load saved toggle state ────────────────────────────────────────────────
  chrome.storage.sync.get(["toggleState"], (res) => {
    // Default to true if never set
    const state = res.toggleState !== false;
    checkbox.checked = state;

    // Ensure storage is initialised on first install
    if (res.toggleState === undefined) {
      chrome.storage.sync.set({ toggleState: true });
    }
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
});