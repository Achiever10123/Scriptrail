// ─── settings.js ──────────────────────────────────────────────────────────────
// Controls the extension settings popup.
// - Handles language selection
// - Handles infobar panel width
// - Handles resetting stored writing-time data
// - Saves preferences to chrome.storage.sync

document.addEventListener("DOMContentLoaded", () => {
  const languageSelect = document.getElementById("languageSelect");
  const panelWidthInput = document.getElementById("panelWidthInput");
  const resetDataBtn = document.getElementById("resetDataBtn");
  const resetDataStatus = document.getElementById("resetDataStatus");

  // ── Language ────────────────────────────────────────────────────────────────
  // Load saved language setting
  chrome.storage.sync.get(["language"], (res) => {
    const savedLanguage = res.language || "en";
    languageSelect.value = savedLanguage;
  });

  // Persist language changes and broadcast to open Docs tabs so the
  // infobar/button re-render immediately without a page reload.
  languageSelect.addEventListener("change", () => {
    const selectedLanguage = languageSelect.value;
    chrome.storage.sync.set({ language: selectedLanguage });
    chrome.runtime.sendMessage({ action: "languageUpdate", language: selectedLanguage });
  });

  // ── Infobar panel width ────────────────────────────────────────────────────
  // Reuses infobar.js's existing setInfoBarWidth() hook, previously hardcoded.
  if (panelWidthInput) {
    chrome.storage.sync.get(["infobarWidth"], (res) => {
      panelWidthInput.value = res.infobarWidth || 280;
    });

    panelWidthInput.addEventListener("change", () => {
      let width = parseInt(panelWidthInput.value, 10);
      if (isNaN(width)) return;
      width = Math.min(500, Math.max(200, width)); // keep it usable
      panelWidthInput.value = width;
      chrome.storage.sync.set({ infobarWidth: width });
      chrome.runtime.sendMessage({ action: "panelWidthUpdate", width });
    });
  }

  // ── Reset stored writing-time data ─────────────────────────────────────────
  if (resetDataBtn) {
    resetDataBtn.addEventListener("click", () => {
      if (!confirm("This clears all saved writing-time data for every document. Continue?")) return;
      chrome.storage.local.get(null, (items) => {
        const keysToRemove = Object.keys(items).filter(
          (k) => k.startsWith("scriptrail_writingTime_") || k.startsWith("report_")
        );
        chrome.storage.local.remove(keysToRemove, () => {
          if (resetDataStatus) {
            resetDataStatus.textContent = "Data cleared.";
            setTimeout(() => { resetDataStatus.textContent = ""; }, 3000);
          }
        });
      });
    });
  }
});
