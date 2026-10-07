/**
 * LucidScan MV3 service worker: offscreen coordinator + context-menu fallback.
 * Badge inference lives in offscreen.js; content scripts are a thin bridge.
 */

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts && contexts.length > 0) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
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

async function scoreViaOffscreen(kind, payload) {
  await ensureOffscreen();
  const id = payload.id || `sw-${Date.now()}`;
  return chrome.runtime.sendMessage({
    type: kind === "text" ? "offscreen.scoreText" : "offscreen.scoreImage",
    id,
    ...payload,
  });
}

chrome.runtime.onInstalled.addListener(() => {
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
  chrome.storage.local.set({ badgeModeEnabled: true, inferenceMode: "mock" });
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
        const status = await chrome.runtime.sendMessage({ type: "offscreen.getStatus" });
        sendResponse(status || { mode: "mock" });
      } catch {
        sendResponse({ mode: "mock", text: "mock", image: "mock" });
      }
    })();
    return true;
  }


  if (msg.type === "warmupModels") {
    (async () => {
      try {
        await ensureOffscreen();
        const result = await chrome.runtime.sendMessage({
          type: "offscreen.warmup",
          which: msg.which || "both",
        });
        sendResponse(result || { ok: false });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === "requestBadgeHosts") {
    (async () => {
      try {
        const granted = await chrome.permissions.request({
          origins: ["http://*/*", "https://*/*"],
        });
        sendResponse({ granted: !!granted });
      } catch (err) {
        sendResponse({ granted: false, error: String(err) });
      }
    })();
    return true;
  }

  if (msg.action === "getImages" && sender.tab?.id) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      files: ["rip_images.js"],
    });
  }
  if (msg.imageUrls) {
    chrome.storage.local.set({ imageUrls: msg.imageUrls });
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

  await chrome.storage.local.set({ lastScan: display });
  chrome.windows.create({
    url: "popup.html",
    type: "popup",
    width: 420,
    height: 360,
  });
});

ensureOffscreen().catch(() => {});
