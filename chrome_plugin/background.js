/**
 * LucidScan MV3 service worker: offscreen coordinator + context-menu fallback.
 * Badge inference lives in offscreen.js; content scripts are a thin bridge.
 */

/**
 * @typedef {{
 *   ok?: boolean,
 *   error?: string,
 *   granted?: boolean,
 *   origin?: string | null,
 *   injected?: boolean,
 *   matches?: string[],
 *   cleared?: string[],
 * }} BadgeOpResult
 */

/**
 * @typedef {{
 *   confidence: number | null,
 *   label: string,
 *   contentType: string,
 *   state: "signal" | "loading" | "unavailable" | "cancelled",
 *   mode?: string,
 *   reason?: string | null,
 *   progress?: number | null,
 * }} ScanDisplay
 */

/**
 * @typedef {{
 *   type: string,
 *   content: string,
 *   signal: AbortSignal,
 *   score?: (type: string, content: string, attempt: number) => Promise<unknown>,
 *   postVideo?: (content: string, signal: AbortSignal) => Promise<{ ok?: boolean, status?: number, data?: unknown } | null>,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 *   now?: () => number,
 *   onUpdate?: (display: ScanDisplay) => void,
 * }} MenuScanRequest
 */

/**
 * @typedef {{ id?: string } & Record<string, unknown>} ScorePayload
 */

const OFFSCREEN_URL = "offscreen.html";
/** @type {Promise<void> | null} */
let creatingOffscreen = null;

const CONTENT_SCRIPT_ID = "lucidscan-badges";

/** @param {string} urlString @returns {string | null} */
function originPatternFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}/*`;
  } catch (_) {
    return null;
  }
}

/** @param {unknown} urlString */
function isRestrictedUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return true;
  const lower = urlString.toLowerCase();
  if (
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("chrome-error://") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("about:") ||
    lower.startsWith("view-source:") ||
    lower.startsWith("file://")
  ) {
    return true;
  }
  return false;
}

/** @param {string} msg @param {{ host?: string }} [extra] */
function logInfo(msg, extra) {
  // No URLs/PII in logs — origin host only when provided
  if (extra && extra.host) console.info("[LucidScan]", msg, { host: extra.host });
  else console.info("[LucidScan]", msg);
}

/** @returns {Promise<string[]>} */
async function getPausedOrigins() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ pausedOrigins: [] }, (r) => {
      const list = Array.isArray(r.pausedOrigins) ? r.pausedOrigins : [];
      resolve([...new Set(list)].filter(Boolean));
    });
  });
}

/** @param {string[]} origins @returns {Promise<string[]>} */
async function setPausedOrigins(origins) {
  const cleaned = [...new Set(origins)].filter(Boolean).sort();
  await chrome.storage.local.set({ pausedOrigins: cleaned });
  return cleaned;
}

/** @returns {Promise<string[]>} */
function getEnabledOrigins() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ enabledOrigins: [] }, (r) => {
      const list = Array.isArray(r.enabledOrigins) ? r.enabledOrigins : [];
      resolve([...new Set(list)].filter(Boolean));
    });
  });
}

/** @param {string[]} origins @returns {Promise<string[]>} */
async function setEnabledOrigins(origins) {
  const cleaned = [...new Set(origins)].filter(Boolean).sort();
  await chrome.storage.local.set({ enabledOrigins: cleaned });
  return cleaned;
}

// Serialize (un)register: permissions.onAdded and activateBadgesForOrigin can race, and two
// overlapping registerContentScripts calls with the same id fail ("Duplicate script ID").
/** @type {Promise<void>} */
let syncChain = Promise.resolve();
function syncRegisteredContentScripts() {
  const run = syncChain.then(doSyncRegisteredContentScripts, doSyncRegisteredContentScripts);
  syncChain = /** @type {Promise<void>} */ (run.catch(() => {}));
  return run;
}

async function doSyncRegisteredContentScripts() {
  const origins = await getEnabledOrigins();
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (_) {
    // not registered yet
  }
  if (!origins.length) return { registered: false, matches: [] };
  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      js: ["content.js"],
      matches: origins,
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
  return { registered: true, matches: origins };
}

/** @param {number} tabId */
async function injectIntoTab(tabId) {
  // content.js is idempotent (globalThis guard in the isolated world), so a tab that already has a
  // live instance from the registered script is not injected twice.
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["content.js"],
  });
}

/** @param {number} tabId */
async function teardownInTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "teardownBadges" });
  } catch (_) {
    // content script may not be present
  }
}

/** @param {string | null} pattern @param {number | null | undefined} tabId @returns {Promise<BadgeOpResult>} */
async function activateBadgesForOrigin(pattern, tabId) {
  if (!pattern) return { ok: false, error: "Missing origin pattern." };
  if (pattern.startsWith("file:") || pattern.startsWith("chrome:") || pattern.startsWith("chrome-error:")) {
    return { ok: false, error: "Restricted URL — use http(s). Serve sample via python3 -m http.server." };
  }
  // Permission must already be granted (popup called permissions.request in the gesture).
  let permitted = false;
  try {
    permitted = await chrome.permissions.contains({ origins: [pattern] });
  } catch (_) {}
  if (!permitted) {
    return {
      ok: false,
      granted: false,
      origin: pattern,
      error: "Host permission missing — click Enable again (gesture required).",
    };
  }
  // Enabling implies resume (pause is per-site hide, not revoke)
  const paused = (await getPausedOrigins()).filter((o) => o !== pattern);
  await setPausedOrigins(paused);
  const origins = await getEnabledOrigins();
  if (!origins.includes(pattern)) origins.push(pattern);
  await setEnabledOrigins(origins);
  const reg = await syncRegisteredContentScripts();
  let injected = false;
  let injectError = null;
  if (tabId) {
    try {
      await injectIntoTab(tabId);
      injected = true;
    } catch (err) {
      injectError = String(err && err.message ? err.message : err);
    }
  }
  return {
    ok: true,
    granted: true,
    origin: pattern,
    injected,
    matches: reg.matches,
    error: injectError || undefined,
  };
}

/** @deprecated gesture-unsafe if awaits precede request — prefer popup request + activateBadgesForOrigin */
/** @param {chrome.tabs.Tab | undefined} tab @returns {Promise<BadgeOpResult>} */
async function enableBadgesForTab(tab) {
  if (!tab || !tab.id || !tab.url) {
    return { ok: false, error: "No active http(s) tab." };
  }
  if (isRestrictedUrl(tab.url)) {
    return { ok: false, error: "Restricted URL (chrome://, file://, etc.). Use http(s) — e.g. python3 -m http.server for sample.html." };
  }
  const pattern = originPatternFromUrl(tab.url);
  if (!pattern) {
    return { ok: false, error: "Badges only work on http(s) pages." };
  }
  // First statement after sync checks: request() — still fragile after tabs.query await in caller.
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    return { ok: false, granted: false, origin: pattern, error: "Permission denied." };
  }
  return activateBadgesForOrigin(pattern, tab.id);
}

/** @param {chrome.tabs.Tab | undefined} tab @returns {Promise<BadgeOpResult>} */
async function disableBadgesForTab(tab) {
  if (!tab || !tab.url) {
    return { ok: false, error: "No active http(s) tab." };
  }
  const pattern = originPatternFromUrl(tab.url);
  if (!pattern) {
    return { ok: false, error: "Not an http(s) page." };
  }
  const origins = (await getEnabledOrigins()).filter((o) => o !== pattern);
  await setEnabledOrigins(origins);
  const reg = await syncRegisteredContentScripts();
  if (tab.id) await teardownInTab(tab.id);
  // Best-effort: drop host permission for this origin
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch (_) {}
  return { ok: true, origin: pattern, matches: reg.matches };
}

/** @param {string | null | undefined} pattern @returns {Promise<BadgeOpResult>} */
async function disableOriginPattern(pattern) {
  if (!pattern) return { ok: false, error: "Missing origin." };
  const origins = (await getEnabledOrigins()).filter((o) => o !== pattern);
  await setEnabledOrigins(origins);
  const reg = await syncRegisteredContentScripts();
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch (_) {}
  // Teardown matching tabs best-effort
  try {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      if (tab.id) await teardownInTab(tab.id);
    }
  } catch (_) {}
  return { ok: true, origin: pattern, matches: reg.matches };
}

async function clearAllEnabledOrigins() {
  const prev = await getEnabledOrigins();
  for (const pattern of prev) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const tab of tabs) {
        if (tab.id) await teardownInTab(tab.id);
      }
    } catch (_) {}
    try {
      await chrome.permissions.remove({ origins: [pattern] });
    } catch (_) {}
  }
  await setEnabledOrigins([]);
  await syncRegisteredContentScripts();
  return { ok: true, cleared: prev };
}

/** @param {chrome.tabs.Tab | undefined} tab */
async function getSiteBadgeStatus(tab) {
  const origins = await getEnabledOrigins();
  const paused = await getPausedOrigins();
  const pattern = tab && tab.url ? originPatternFromUrl(tab.url) : null;
  const enabled = !!(pattern && origins.includes(pattern));
  const sitePaused = !!(pattern && paused.includes(pattern));
  let permission = false;
  if (pattern) {
    try {
      permission = await chrome.permissions.contains({ origins: [pattern] });
    } catch (_) {}
  }
  return {
    origin: pattern,
    enabled,
    sitePaused,
    permission,
    enabledOrigins: origins,
    pausedOrigins: paused,
    restricted: !!(tab && tab.url && isRestrictedUrl(tab.url)),
    tabUrl: tab && tab.url ? tab.url : null,
  };
}



async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (!(contexts && contexts.length > 0)) {
    if (creatingOffscreen) {
      await creatingOffscreen;
    } else {
      creatingOffscreen = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Run local signal scoring for browse-time badges without blocking the service worker.",
      });
      try {
        await creatingOffscreen;
      } finally {
        creatingOffscreen = null;
      }
    }
  }
  // Offscreen is an ES module that imports Transformers.js — wait until it pings ready.
  await waitForOffscreenReady();
}

async function waitForOffscreenReady(timeoutMs = 30000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const ping = await chrome.runtime.sendMessage({ type: "offscreen.ping" });
      if (ping && ping.ready) return true;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.warn("LucidScan: offscreen ready timeout", lastErr);
  return false;
}

function getInferenceFlags() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(
        { inferenceMode: "transformers", forceMock: false },
        (r) => resolve({
          inferenceMode: r.inferenceMode || "transformers",
          forceMock: r.forceMock === true,
        })
      );
    } catch (_) {
      resolve({ inferenceMode: "transformers", forceMock: false });
    }
  });
}

/** @param {string} kind @param {ScorePayload} payload */
async function scoreViaOffscreen(kind, payload) {
  await ensureOffscreen();
  if (!(await waitForOffscreenReady(2000))) {
    return { id: payload.id, state: "loading", label: "loading" };
  }
  const id = payload.id || `sw-${Date.now()}`;
  const flags = await getInferenceFlags();
  // payload is the content-script message (type: "scoreImage"/"scoreText"); spread it first so it
  // cannot override the offscreen.* routing type (otherwise offscreen ignores it -> badges stay "pending").
  return chrome.runtime.sendMessage({
    ...payload,
    ...flags,
    type: kind === "text" ? "offscreen.scoreText" : "offscreen.scoreImage",
    id,
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "scan-text",
      title: "Scan selected text (local signal)",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "scan-image",
      title: "Scan this image (local signal)",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "scan-video",
      title: "Scan this video (optional server)",
      contexts: ["video"],
    });
  });
  // Only reset site lists on a fresh install — keep user choices across updates/reloads.
  if (details && details.reason === "install") {
    chrome.storage.local
      .set({ inferenceMode: "transformers", enabledOrigins: [], pausedOrigins: [] })
      .catch(() => {});
  }
  syncRegisteredContentScripts().catch((e) => console.warn("register scripts", e));
});

const EXTENSION_ORIGIN = chrome.runtime.getURL("");

/** Message came from one of our extension pages (popup, offscreen, popup window), not a web page. */
/**
 * @param {chrome.runtime.MessageSender | null | undefined} sender
 * @returns {sender is chrome.runtime.MessageSender & { url: string }}
 */
function isExtensionPage(sender) {
  return !!(sender && sender.id === chrome.runtime.id && typeof sender.url === "string" &&
    sender.url.startsWith(EXTENSION_ORIGIN));
}

/** @param {chrome.runtime.MessageSender | null | undefined} sender */
function isOffscreenDoc(sender) {
  return isExtensionPage(sender) && !sender.tab &&
    sender.url.startsWith(chrome.runtime.getURL(OFFSCREEN_URL));
}

/** Our own content script running in a web tab. */
/** @param {chrome.runtime.MessageSender | null | undefined} sender */
function isOwnContentScript(sender) {
  return !!(sender && sender.id === chrome.runtime.id && sender.tab && !isExtensionPage(sender));
}

const CONTENT_MESSAGES = new Set(["scoreText", "scoreImage"]);
const PRIVILEGED_MESSAGES = new Set([
  "getInferenceStatus", "cancelModelLoad", "warmupModels", "pauseBadgesForSite", "resumeBadgesForSite",
  "enableBadgesForSite", "disableBadgesForSite", "disableBadgeOrigin", "clearAllBadgeOrigins",
  "getSiteBadgeStatus",
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (CONTENT_MESSAGES.has(msg.type) && !(isOwnContentScript(sender) || isExtensionPage(sender))) return;
  // Site enable/disable, model control: popup / extension pages only, never a tab's content script.
  if (PRIVILEGED_MESSAGES.has(msg.type) && (!isExtensionPage(sender) || isOffscreenDoc(sender))) return;

  // Ignore offscreen-targeted messages here (offscreen.js handles them).
  if (msg.type.startsWith("offscreen.")) return;

  // Offscreen documents have no chrome.storage. Relay the startup flags.
  if (msg.type === "getOffscreenSettings") {
    if (!isOffscreenDoc(sender)) return;
    try {
      chrome.storage.local.get(
        { autoWarmup: true, inferenceMode: "transformers", forceMock: false },
        (r) => {
          const row = r || {};
          sendResponse({
            autoWarmup: row.autoWarmup !== false,
            inferenceMode: row.inferenceMode || "transformers",
            forceMock: row.forceMock === true,
          });
        }
      );
    } catch (_) {
      sendResponse({ autoWarmup: true, inferenceMode: "transformers", forceMock: false });
      return;
    }
    return true;
  }

  if (msg.type === "scoreText" || msg.type === "scoreImage") {
    (async () => {
      try {
        const kind = msg.type === "scoreText" ? "text" : "image";
        const result = await scoreViaOffscreen(kind, msg);
        // No reply = offscreen still starting: retryable loading, never a fake score.
        sendResponse(result || { id: msg.id, label: "loading", state: "loading" });
      } catch (err) {
        sendResponse({
          id: msg.id,
          label: "unavailable",
          state: "unavailable",
          reason: `scoring unavailable: ${String(err && err.message ? err.message : err)}`,
        });
      }
    })();
    return true;
  }

  if (msg.type === "getInferenceStatus") {
    (async () => {
      /** @type {{ inferenceMode: string, forceMock: boolean } | null} */
      let flags = null;
      try {
        flags = await getInferenceFlags();
        await ensureOffscreen();
        const status = await chrome.runtime.sendMessage({ type: "offscreen.getStatus", ...flags });
        // No reply is the scorer being absent, not a user mock setting and not a score.
        sendResponse(status || statusWhenOffscreenDown(new Error("no status reply"), flags));
      } catch (err) {
        sendResponse(statusWhenOffscreenDown(err, flags));
      }
    })();
    return true;
  }


  if (msg.type === "cancelModelLoad") {
    (async () => {
      try {
        await ensureOffscreen();
        const result = await chrome.runtime.sendMessage({ type: "offscreen.cancelLoad" });
        sendResponse(result || { ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === "warmupModels") {
    (async () => {
      try {
        await ensureOffscreen();
        const flags = await getInferenceFlags();
        const result = await chrome.runtime.sendMessage({
          type: "offscreen.warmup",
          which: msg.which || "both",
          ...flags,
        });
        sendResponse(result || { ok: false });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === "pauseBadgesForSite") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const pattern = msg.origin || (tab && tab.url ? originPatternFromUrl(tab.url) : null);
        if (!pattern) {
          sendResponse({ ok: false, error: "No site origin." });
          return;
        }
        const paused = await getPausedOrigins();
        if (!paused.includes(pattern)) paused.push(pattern);
        await setPausedOrigins(paused);
        if (tab && tab.id) await teardownInTab(tab.id);
        logInfo("paused site", { host: pattern });
        sendResponse({ ok: true, origin: pattern, pausedOrigins: paused });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === "resumeBadgesForSite") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const pattern = msg.origin || (tab && tab.url ? originPatternFromUrl(tab.url) : null);
        if (!pattern) {
          sendResponse({ ok: false, error: "No site origin." });
          return;
        }
        const paused = (await getPausedOrigins()).filter((o) => o !== pattern);
        await setPausedOrigins(paused);
        // Re-inject if still enabled
        const enabled = await getEnabledOrigins();
        if (enabled.includes(pattern) && tab && tab.id) {
          try { await injectIntoTab(tab.id); } catch (_) {}
        }
        logInfo("resumed site", { host: pattern });
        sendResponse({ ok: true, origin: pattern, pausedOrigins: paused });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === "enableBadgesForSite") {
    (async () => {
      try {
        // Prefer origin/tabId from popup (popup already called permissions.request in the gesture).
        if (msg.origin && msg.permissionGranted) {
          sendResponse(await activateBadgesForOrigin(msg.origin, msg.tabId || null));
          return;
        }
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const result = await enableBadgesForTab(tab);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === "disableBadgesForSite") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const result = await disableBadgesForTab(tab);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === "disableBadgeOrigin") {
    (async () => {
      try {
        sendResponse(await disableOriginPattern(msg.origin));
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === "clearAllBadgeOrigins") {
    (async () => {
      try {
        sendResponse(await clearAllEnabledOrigins());
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === "getSiteBadgeStatus") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        sendResponse(await getSiteBadgeStatus(tab));
      } catch (err) {
        sendResponse({ error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

});

function menuScanLimits() {
  return {
    delays: [2000, 4000, 8000, 15000],
    budgetMs: 45000,
    videoTimeoutMs: 20000,
    maxAttempts: 8,
  };
}

/** @param {unknown} value @returns {number | null} */
function finiteScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {unknown} err */
function messageOf(err) {
  return String(err && /** @type {{ message?: string }} */ (err).message ? /** @type {{ message?: string }} */ (err).message : err);
}

/**
 * The offscreen document did not answer. Mock is reported only when settings
 * already say so. A connection failure is "unavailable", with no score.
 * @param {unknown} err
 * @param {{ inferenceMode?: string, forceMock?: boolean } | null} [flags]
 */
function statusWhenOffscreenDown(err, flags) {
  const reason = `offscreen unavailable: ${messageOf(err)}`;
  const settingsMock = !!(flags && (flags.forceMock === true || flags.inferenceMode === "mock"));
  const configured = flags && typeof flags.inferenceMode === "string" ? flags.inferenceMode : "";
  return {
    mode: settingsMock ? "mock" : (configured || "unknown"),
    text: "unavailable",
    image: "unavailable",
    reason,
    textError: reason,
    imageError: reason,
  };
}

/**
 * Map an engine reply onto a stored scan. A number is kept only when the engine
 * reported a real signal. Loading stays retryable. Everything else is terminal
 * and has no confidence.
 * @param {any} scored
 * @param {string} contentType
 * @returns {ScanDisplay}
 */
function settleEngineScan(scored, contentType) {
  const type = contentType || "unknown";
  /** @param {ScanDisplay["state"]} state @param {string} label @param {unknown} reason @param {Partial<ScanDisplay>} [extra] @returns {ScanDisplay} */
  const terminal = (state, label, reason, extra) => ({
    confidence: null,
    label,
    contentType: type,
    state,
    reason: reason == null ? null : String(reason),
    ...extra,
  });
  if (!scored || typeof scored !== "object") {
    return terminal("unavailable", "unavailable", "empty scan result");
  }
  if (scored.cancelled === true || scored.state === "cancelled") {
    return terminal("cancelled", "cancelled", scored.reason || scored.error || "scan cancelled");
  }
  const state = typeof scored.state === "string" ? scored.state : "";
  if (state === "loading" || scored.label === "loading") {
    const progress = finiteScore(scored.progress);
    return {
      confidence: null,
      label: "loading",
      contentType: type,
      state: "loading",
      reason: scored.reason || scored.error || "model still loading",
      progress,
    };
  }
  const score = finiteScore(scored.score);
  const honestSignal = state === "signal" && score != null && scored.mode !== "mock" && !scored.heuristics && !scored.fallbackReason;
  if (honestSignal) {
    return {
      confidence: /** @type {number} */ (score),
      label: typeof scored.label === "string" && scored.label ? scored.label : "local score",
      contentType: type,
      state: "signal",
      mode: typeof scored.mode === "string" ? scored.mode : "transformers",
      reason: null,
    };
  }
  if (state === "signal" || state === "pending") {
    return terminal("unavailable", "unavailable", scored.reason || scored.error || "model returned no score");
  }
  return terminal("unavailable", "unavailable", scored.reason || scored.fallbackReason || scored.error || "scan unavailable");
}

/**
 * Optional video server: only a finite numeric confidence on HTTP success is a score.
 * @param {boolean} ok
 * @param {number | undefined} status
 * @param {any} data
 * @param {string} contentType
 * @returns {ScanDisplay}
 */
function settleServerScan(ok, status, data, contentType) {
  const type = contentType || "video";
  const serverReason = data && typeof data === "object" ? (data.error || data.reason) : null;
  if (!ok) {
    return settleEngineScan({
      state: "unavailable",
      reason: serverReason ? String(serverReason) : `server responded HTTP ${status || "error"}`,
    }, type);
  }
  const score = finiteScore(data && data.confidence);
  if (score == null) {
    return settleEngineScan({
      state: "unavailable",
      reason: serverReason ? String(serverReason) : "server returned no score",
    }, type);
  }
  return {
    confidence: score,
    label: "server score",
    contentType: type,
    state: "signal",
    mode: "flask",
    reason: null,
  };
}

/** @param {AbortSignal | null | undefined} signal @param {string} contentType @returns {ScanDisplay} */
function terminalFromAbort(signal, contentType) {
  const reason = signal && signal.reason;
  const name = reason && /** @type {{ name?: string }} */ (reason).name;
  if (name === "TimeoutError") {
    return settleEngineScan({ state: "unavailable", reason: "optional server did not respond" }, contentType);
  }
  return settleEngineScan({ state: "cancelled", reason: "scan cancelled" }, contentType);
}

/**
 * Right-click scan. Retries only while the engine says it is still loading.
 * Empty input, cancellation, timeout, and a missing score stay unscored.
 * @param {MenuScanRequest} request
 * @returns {Promise<ScanDisplay>}
 */
async function resolveContextMenuScan(request) {
  const type = request.type;
  const content = String(request.content || "").trim();
  const signal = request.signal;
  if (!content) return settleEngineScan({ state: "unavailable", reason: "nothing to scan" }, type);
  if (type === "video") {
    if (signal.aborted) return terminalFromAbort(signal, type);
    try {
      const posted = request.postVideo ? await request.postVideo(content, signal) : null;
      return settleServerScan(!!(posted && posted.ok), posted ? posted.status : 0, posted && posted.data, type);
    } catch (err) {
      if (signal.aborted) return terminalFromAbort(signal, type);
      return settleEngineScan({ state: "unavailable", reason: `scan failed: ${messageOf(err)}` }, type);
    }
  }
  const limits = menuScanLimits();
  const now = request.now || (() => Date.now());
  const started = now();
  try {
    for (let attempt = 0; attempt < limits.maxAttempts; attempt++) {
      if (signal.aborted) return terminalFromAbort(signal, type);
      const scored = request.score ? await request.score(type, content, attempt) : null;
      const display = settleEngineScan(scored, type);
      if (display.state !== "loading") return display;
      if (now() - started > limits.budgetMs || attempt === limits.maxAttempts - 1) {
        return settleEngineScan({
          state: "unavailable",
          reason: "model did not finish loading — use Retry model load, then scan again",
        }, type);
      }
      if (request.onUpdate) request.onUpdate(display);
      const delayMs = limits.delays[Math.min(attempt, limits.delays.length - 1)];
      if (request.sleep) await request.sleep(delayMs, signal);
    }
  } catch (err) {
    if (signal.aborted) return terminalFromAbort(signal, type);
    return settleEngineScan({ state: "unavailable", reason: `scan failed: ${messageOf(err)}` }, type);
  }
  return settleEngineScan({
    state: "unavailable",
    reason: "model did not finish loading — use Retry model load, then scan again",
  }, type);
}

/** @param {chrome.contextMenus.OnClickData | null | undefined} info */
function menuRequestFromInfo(info) {
  if (!info || !info.menuItemId) return null;
  if (info.menuItemId === "scan-text") {
    return { type: "text", content: typeof info.selectionText === "string" ? info.selectionText.trim() : "" };
  }
  if (info.menuItemId === "scan-image") {
    return { type: "image", content: typeof info.srcUrl === "string" ? info.srcUrl.trim() : "" };
  }
  if (info.menuItemId === "scan-video") {
    return { type: "video", content: typeof info.srcUrl === "string" ? info.srcUrl.trim() : "" };
  }
  return null;
}

/**
 * Child signal for the optional video POST. Parent abort cancels it; the timer
 * aborts it if the local server never answers. arm() is cleared on abort.
 * @param {AbortSignal} parent
 * @param {(ms: number, fn: () => void) => () => void} arm
 * @returns {{ signal: AbortSignal, cancel: () => void }}
 */
function createVideoSignal(parent, arm) {
  const child = new AbortController();
  /** @type {(() => void) | null} */
  let cancelTimer = null;
  const stopTimer = () => {
    if (!cancelTimer) return;
    cancelTimer();
    cancelTimer = null;
  };
  /** @param {AbortSignal} from */
  const abortChild = (from) => {
    if (child.signal.aborted) return;
    const reason = from && from.reason;
    if (reason instanceof Error) child.abort(reason);
    else child.abort(new DOMException("scan cancelled", "AbortError"));
  };
  if (parent.aborted) abortChild(parent);
  else {
    cancelTimer = arm(menuScanLimits().videoTimeoutMs, () => {
      if (!child.signal.aborted) child.abort(new DOMException("video scan timed out", "TimeoutError"));
    });
    parent.addEventListener("abort", () => abortChild(parent), { once: true });
  }
  child.signal.addEventListener("abort", stopTimer, { once: true });
  const cancel = () => {
    stopTimer();
    if (!child.signal.aborted) child.abort(new DOMException("scan finished", "AbortError"));
  };
  return { signal: child.signal, cancel };
}

let scanSerial = 0;
/** @type {AbortController | null} */
let activeScan = null;
/** @type {number | null} */
let scanResultWindowId = null;

function beginContextScan() {
  if (activeScan) activeScan.abort();
  const controller = new AbortController();
  activeScan = controller;
  const serial = ++scanSerial;
  return { serial, signal: controller.signal };
}

/** @param {number} serial */
function scanStillCurrent(serial) {
  return serial === scanSerial;
}

/** @param {number} serial */
function finishContextScan(serial) {
  if (serial === scanSerial) activeScan = null;
}

/** @type {Promise<unknown>} */
let scanPublishChain = Promise.resolve();

/**
 * Writes are serialized and a stale serial is dropped, so a cancelled scan cannot
 * overwrite the result of the scan that replaced it.
 * @param {number} serial
 * @param {ScanDisplay} display
 */
function publishScan(serial, display) {
  const run = scanPublishChain.then(async () => {
    if (!scanStillCurrent(serial)) return false;
    await chrome.storage.local.set({ lastScan: display });
    return scanStillCurrent(serial);
  });
  scanPublishChain = run.then(() => {}, () => {});
  return run;
}

/** One result window. A later scan focuses it instead of opening another. */
async function focusOrCreateScanWindow() {
  if (scanResultWindowId != null) {
    try {
      await chrome.windows.get(scanResultWindowId);
      await chrome.windows.update(scanResultWindowId, { focused: true });
      return scanResultWindowId;
    } catch (_) {
      scanResultWindowId = null;
    }
  }
  const created = await chrome.windows.create({
    url: "popup.html",
    type: "popup",
    width: 420,
    height: 440,
  });
  scanResultWindowId = created && typeof created.id === "number" ? created.id : null;
  return scanResultWindowId;
}

/** @param {number} windowId */
function forgetScanWindow(windowId) {
  if (windowId === scanResultWindowId) scanResultWindowId = null;
}

/** @param {number} ms @param {() => void} fn */
function armTimeout(ms, fn) {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/** @param {number} ms @param {AbortSignal} signal @returns {Promise<void>} */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("scan cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("scan cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

chrome.windows.onRemoved.addListener(forgetScanWindow);

chrome.contextMenus.onClicked.addListener(async (info) => {
  const request = menuRequestFromInfo(info);
  if (!request) return;
  const started = beginContextScan();
  /** @type {() => void} */
  let releaseVideo = () => {};
  let signal = started.signal;
  if (request.type === "video") {
    const video = createVideoSignal(started.signal, armTimeout);
    signal = video.signal;
    releaseVideo = video.cancel;
  }
  try {
    const display = await resolveContextMenuScan({
      type: request.type,
      content: request.content,
      signal,
      now: () => Date.now(),
      sleep: delay,
      onUpdate: (next) => {
        publishScan(started.serial, next).catch((err) => {
          console.warn("[LucidScan] could not update scan", messageOf(err));
        });
      },
      score: (type, content, attempt) => scoreViaOffscreen(type, {
        id: `menu-${started.serial}-${attempt}`,
        text: type === "text" ? content : undefined,
        src: type === "image" ? content : undefined,
      }),
      postVideo: async (content, videoSignal) => {
        const resp = await fetch("http://localhost:5000/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "video", content }),
          signal: videoSignal,
        });
        /** @type {unknown} */
        let data;
        try {
          data = await resp.json();
        } catch (_) {
          data = null;
        }
        return { ok: resp.ok, status: resp.status, data };
      },
    });
    if (!scanStillCurrent(started.serial)) return;
    await publishScan(started.serial, display);
    await focusOrCreateScanWindow();
  } catch (err) {
    console.warn("[LucidScan] scan failed", messageOf(err));
    if (!scanStillCurrent(started.serial)) return;
    try {
      await publishScan(started.serial, settleEngineScan({
        state: "unavailable",
        reason: `scan failed: ${messageOf(err)}`,
      }, request.type));
      await focusOrCreateScanWindow();
    } catch (showErr) {
      console.warn("[LucidScan] could not show scan result", messageOf(showErr));
    }
  } finally {
    releaseVideo();
    finishContextScan(started.serial);
  }
});


// One-time soft migrate: M1 left inferenceMode=mock in storage; M2+ default is transformers.
chrome.storage.local.get({ inferenceMode: null, _migratedInferenceMode: false }, (r) => {
  if (!r._migratedInferenceMode && r.inferenceMode === "mock") {
    chrome.storage.local.set({
      inferenceMode: "transformers",
      _migratedInferenceMode: true,
    });
  } else if (!r._migratedInferenceMode) {
    chrome.storage.local.set({ _migratedInferenceMode: true });
  }
});

ensureOffscreen().catch(() => {});
syncRegisteredContentScripts().catch((e) => console.warn("LucidScan script sync", e));


chrome.permissions.onAdded.addListener((perm) => {
  if (perm && perm.origins && perm.origins.length) {
    syncRegisteredContentScripts().catch(() => {});
  }
});
chrome.permissions.onRemoved.addListener(async (perm) => {
  const removedOrigins = perm && perm.origins;
  if (!removedOrigins) return;
  try {
    const origins = await getEnabledOrigins();
    const next = origins.filter((o) => !removedOrigins.includes(o));
    if (next.length !== origins.length) {
      await setEnabledOrigins(next);
      await syncRegisteredContentScripts();
    }
  } catch (err) {
    console.warn("[LucidScan] permission cleanup failed", String(err && err.message ? err.message : err));
  }
});


chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "enable-badges-this-site") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || isRestrictedUrl(tab.url)) {
      logInfo("command enable skipped: restricted or missing tab");
      return;
    }
    const pattern = originPatternFromUrl(tab.url);
    if (!pattern) return;
    // Commands are a user gesture — request may work here.
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) {
      logInfo("command enable: permission denied");
      return;
    }
    // Unpause if paused
    const paused = (await getPausedOrigins()).filter((o) => o !== pattern);
    await setPausedOrigins(paused);
    await activateBadgesForOrigin(pattern, tab.id);
    logInfo("command enable ok", { host: pattern });
  } catch (err) {
    console.warn("[LucidScan] command enable failed", String(err && err.message ? err.message : err));
  }
});
