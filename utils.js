// ─── utils.js ─────────────────────────────────────────────────────────────────
// Shared utilities for Scriptrail extension
// Provides: security helpers, validation, constants, and common functions

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════
const SCRIPTRAIL_CONFIG = {
  TOKEN_MIN_LENGTH: 8,
  SESSION_GAP_MS: 600_000, // 10 minutes
  POLL_INTERVAL_MS: 5000,
  TOKEN_RETRY_LIMIT: 60,
  BUTTON_RETRY_LIMIT: 40,
  FETCH_TIMEOUT_MS: 10000,
  COPY_DETECTION_MIN_LEN: 20,
  COPY_DETECTION_TIMEOUT_MS: 5000,
};

Object.freeze(SCRIPTRAIL_CONFIG);

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT GUARDS
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Checks if Chrome runtime context is valid
 * @returns {boolean} True if context is valid
 */
function isCtxValid() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch (_) {
    return false;
  }
}

/**
 * Checks if Chrome storage context is valid
 * @returns {boolean} True if storage context is valid
 */
function isStorageValid() {
  try {
    return typeof chrome !== "undefined" && !!chrome.storage?.sync;
  } catch (_) {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECURITY: INPUT VALIDATION & SANITIZATION
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Validates token format to prevent injection attacks
 * @param {string} token - Token to validate
 * @returns {boolean} True if token is valid
 */
function isValidToken(token) {
  if (!token || typeof token !== "string") return false;
  if (token.length < SCRIPTRAIL_CONFIG.TOKEN_MIN_LENGTH) return false;
  // Reject tokens with whitespace, quotes, angle brackets, or backslashes —
  // these are the characters that could break out of the URL/query context.
  // Real Docs tokens can legitimately contain other punctuation (=, /, +, :,
  // etc.), so we blocklist dangerous characters instead of whitelisting a
  // narrow charset.
  if (/[\s"'\\<>]/.test(token)) return false;
  return true;
}

/**
 * HTML escapes a string to prevent XSS
 * @param {any} str - Value to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sanitizes user-provided text for safe display
 * @param {string} text - Text to sanitize
 * @param {number} maxLength - Maximum length (optional)
 * @returns {string} Sanitized text
 */
function sanitizeText(text, maxLength = null) {
  let result = escapeHtml(String(text));
  if (maxLength !== null && result.length > maxLength) {
    result = result.slice(0, maxLength - 1) + "…";
  }
  return result;
}

/**
 * Validates URL components to prevent open redirect
 * @param {string} url - URL to validate
 * @returns {boolean} True if URL is safe
 */
function isValidDocsUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "docs.google.com" && 
           parsed.protocol === "https:" &&
           parsed.pathname.includes("/document/d/");
  } catch (_) {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SAFE CHROME API WRAPPERS
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Safely sends a message to Chrome runtime
 * @param {object} msg - Message to send
 * @returns {boolean} True if message was sent
 */
function safeSend(msg) {
  if (!isCtxValid()) return false;
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) {
        // Silently ignore - recipient may not exist
      }
    });
    return true;
  } catch (e) {
    console.warn("[Scriptrail] safeSend error:", e.message);
    return false;
  }
}

/**
 * Safely gets values from Chrome storage
 * @param {string[]} keys - Keys to retrieve
 * @param {function} callback - Callback function
 * @returns {boolean} True if request was initiated
 */
function safeStorageGet(keys, callback) {
  if (!isStorageValid()) return false;
  try {
    chrome.storage.sync.get(keys, (res) => {
      if (!isCtxValid() || chrome.runtime.lastError) return;
      callback(res);
    });
    return true;
  } catch (e) {
    console.warn("[Scriptrail] safeStorageGet error:", e.message);
    return false;
  }
}

/**
 * Safely sets values in Chrome storage
 * @param {object} items - Items to set
 * @param {function} [callback] - Optional callback
 * @returns {boolean} True if request was initiated
 */
function safeStorageSet(items, callback) {
  if (!isStorageValid()) return false;
  try {
    chrome.storage.local.set(items, () => {
      if (!isCtxValid() || chrome.runtime.lastError) return;
      if (callback) callback();
    });
    return true;
  } catch (e) {
    console.warn("[Scriptrail] safeStorageSet error:", e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TIME FORMATTING UTILITIES
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Formats milliseconds into human-readable duration
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted duration
 */
function formatWritingTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} hr ${m} min ${sec} sec`;
  if (m > 0) return `${m} min ${sec} sec`;
  return `${sec} sec`;
}

/**
 * Formats milliseconds as hours and minutes
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted time
 */
function formatDuration(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${h}h ${m}m ${s}s`;
}

/**
 * Formats timestamp to locale string
 * @param {number} ms - Timestamp in milliseconds
 * @returns {string} Formatted date/time
 */
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

// ══════════════════════════════════════════════════════════════════════════════
// DOM MANIPULATION HELPERS
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Safely clears all children from a DOM element
 * @param {Element} element - Element to clear
 */
function clearElement(element) {
  if (!element) return;
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

/**
 * Creates a text node with optional sanitization
 * @param {string} text - Text content
 * @param {boolean} [sanitize=true] - Whether to sanitize
 * @returns {Text} Text node
 */
function createTextNode(text, sanitize = true) {
  return document.createTextNode(sanitize ? escapeHtml(String(text)) : String(text));
}

/**
 * Safely sets text content of an element
 * @param {Element} element - Target element
 * @param {string} text - Text to set
 */
function setTextContent(element, text) {
  if (!element) return;
  element.textContent = String(text);
}

// ══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING UTILITIES
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Logs errors with consistent formatting
 * @param {string} context - Context/source of error
 * @param {Error|string} error - Error object or message
 * @param {boolean} [verbose=false] - Whether to log stack trace
 */
function logError(context, error, verbose = false) {
  const prefix = `[Scriptrail] ${context}:`;
  if (error instanceof Error) {
    console.error(prefix, error.message);
    if (verbose) console.error(error.stack);
  } else {
    console.error(prefix, String(error));
  }
}

/**
 * Wraps async operations with timeout protection
 * @param {Promise} promise - Promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} [operationName="Operation"] - Name for error message
 * @returns {Promise} Wrapped promise
 */
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

// ══════════════════════════════════════════════════════════════════════════════
// DATA PROCESSING UTILITIES
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Applies an insert operation to a string
 * @param {string} str - Original string
 * @param {number} loc - Insertion location (1-indexed)
 * @param {string} text - Text to insert
 * @returns {string} Modified string
 */
function applyInsert(str, loc, text) {
  return str.slice(0, loc - 1) + text + str.slice(loc - 1);
}

/**
 * Applies a delete operation to a string
 * @param {string} str - Original string
 * @param {number} si - Start index (1-indexed)
 * @param {number} ei - End index (1-indexed)
 * @returns {string} Modified string
 */
function applyDelete(str, si, ei) {
  return str.slice(0, si - 1) + str.slice(ei);
}

/**
 * Extracts unique values from an array
 * @param {Array} arr - Input array
 * @returns {Array} Array of unique values
 */
function uniqueValues(arr) {
  return [...new Set(arr)];
}

// Export for potential ES module usage (future-proofing)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SCRIPTRAIL_CONFIG,
    isCtxValid,
    isStorageValid,
    isValidToken,
    escapeHtml,
    sanitizeText,
    isValidDocsUrl,
    safeSend,
    safeStorageGet,
    safeStorageSet,
    formatWritingTime,
    formatDuration,
    formatDate,
    clearElement,
    createTextNode,
    setTextContent,
    logError,
    withTimeout,
    applyInsert,
    applyDelete,
    uniqueValues,
  };
}
