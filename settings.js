// ─── settings.js ──────────────────────────────────────────────────────────────
// Controls the extension settings popup.
// - Handles language selection
// - Saves preferences to chrome.storage.sync

document.addEventListener("DOMContentLoaded", () => {
  const languageSelect = document.getElementById("languageSelect");

  // Load saved language setting
  chrome.storage.sync.get(["language"], (res) => {
    const savedLanguage = res.language || "en";
    languageSelect.value = savedLanguage;
  });

  // Persist language changes
  languageSelect.addEventListener("change", () => {
    const selectedLanguage = languageSelect.value;
    chrome.storage.sync.set({ language: selectedLanguage });
    // Broadcast language change to all tabs
    chrome.runtime.sendMessage({ action: "languageUpdate", language: selectedLanguage });
  });
});
