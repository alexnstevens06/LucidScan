/**
 * LucidScan MV3 service worker: offscreen coordinator + context-menu fallback.
 * Badge inference lives in offscreen.js; content scripts are a thin bridge.
 */

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null;

const CONTENT_SCRIPT_ID = "lucidscan-badges";

function originPatternFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}/*`;
  } catch (_) {
    return null;
  }
}

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

function logInfo(msg, extra) {
  // No URLs/PII in logs — origin host only when provided
  if (extra && extra.host) console.info("[LucidScan]", msg, { host: extra.host });
  else console.info("[LucidScan]", msg);
}

async function getPausedOrigins() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ pausedOrigins: [] }, (r) => {
      const list = Array.isArray(r.pausedOrigins) ? r.pausedOrigins : [];
      resolve([...new Set(list)].filter(Boolean));
    });
  });
}

async function setPausedOrigins(origins) {
  const cleaned = [...new Set(origins)].filter(Boolean).sort();
  await chrome.storage.local.set({ pausedOrigins: cleaned });
  return cleaned;
}

function getEnabledOrigins() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ enabledOrigins: [] }, (r) => {
      const list = Array.isArray(r.enabledOrigins) ? r.enabledOrigins : [];
      resolve([...new Set(list)].filter(Boolean));
    });
  });
}

async function setEnabledOrigins(origins) {
  const cleaned = [...new Set(origins)].filter(Boolean).sort();
  await chrome.storage.local.set({ enabledOrigins: cleaned });
  return cleaned;
}

async function syncRegisteredContentScripts() {
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

async function injectIntoTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["content.js"],
  });
}

async function teardownInTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "teardownBadges" });
  } catch (_) {
    // content script may not be present
  }
}

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

async function scoreViaOffscreen(kind, payload) {
  await ensureOffscreen();
  const id = payload.id || `sw-${Date.now()}`;
  const flags = await getInferenceFlags();
  return chrome.runtime.sendMessage({
    type: kind === "text" ? "offscreen.scoreText" : "offscreen.scoreImage",
    id,
    ...payload,
    ...flags,
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // Ignore offscreen-targeted messages here (offscreen.js handles them).
  if (msg.type.startsWith("offscreen.")) return;

  if (msg.type === "scoreText" || msg.type === "scoreImage") {
    (async () => {
      try {
        const kind = msg.type === "scoreText" ? "text" : "image";
        const result = await scoreViaOffscreen(kind, msg);
        sendResponse(result || { id: msg.id, label: "pending", state: "pending" });
      } catch (err) {
        sendResponse({
          id: msg.id,
          label: "offline",
          state: "pending",
          error: String(err && err.message ? err.message : err),
        });
      }
    })();
    return true;
  }

  if (msg.type === "getInferenceStatus") {
    (async () => {
      try {
        await ensureOffscreen();
        const flags = await getInferenceFlags();
        const status = await chrome.runtime.sendMessage({ type: "offscreen.getStatus", ...flags });
        sendResponse(status || { mode: flags.inferenceMode || "transformers" });
      } catch {
        sendResponse({ mode: "mock", text: "mock", image: "mock" });
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

chrome.contextMenus.onClicked.addListener(async (info) => {
  let type;
  let content;
  if (info.menuItemId === "scan-text" && info.selectionText) {
    type = "text";
    content = info.selectionText;
  } else if (info.menuItemId === "scan-image" && info.srcUrl) {
    type = "image";
    content = info.srcUrl;
  } else if (info.menuItemId === "scan-video" && info.srcUrl) {
    type = "video";
    content = info.srcUrl;
  } else {
    return;
  }

  let display = { confidence: null, label: "pending", contentType: type };

  try {
    if (type === "text" || type === "image") {
      const scored = await scoreViaOffscreen(type, {
        id: `menu-${Date.now()}`,
        text: type === "text" ? content : undefined,
        src: type === "image" ? content : undefined,
      });
      if (scored && typeof scored.score === "number") {
        display = {
          confidence: scored.score,
          label: scored.label || "local score",
          contentType: type,
          mode: scored.mode || "mock",
        };
      }
    } else {
      const resp = await fetch("http://localhost:5000/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, content }),
      });
      const data = await resp.json();
      display = {
        confidence: data.confidence,
        label: "server score",
        contentType: type,
        mode: "flask",
      };
    }
  } catch (err) {
    console.warn("LucidScan scan failed:", err);
    display = { confidence: null, label: "offline", contentType: type };
  }

  try {
    await chrome.storage.local.set({ lastScan: display });
    await chrome.windows.create({ url: "popup.html", type: "popup", width: 420, height: 360 });
  } catch (err) {
    console.warn("[LucidScan] could not show scan result", String(err && err.message ? err.message : err));
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
  if (!perm || !perm.origins) return;
  try {
    const origins = await getEnabledOrigins();
    const next = origins.filter((o) => !perm.origins.includes(o));
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
