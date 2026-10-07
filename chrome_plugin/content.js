(() => {
  "use strict";

  const MIN_IMG = 48;

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < String(s).length; i++) {
      h ^= String(s).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  /** Ephemeral in-tab bitmap → data URL for offscreen CLIP (no scrape/resell). */
  function imageToDataUrl(img) {
    try {
      const w = Math.min(img.naturalWidth || img.width || 0, 512);
      const h = Math.min(img.naturalHeight || img.height || 0, 512);
      if (w < MIN_IMG || h < MIN_IMG) return null;
      const canvas = document.createElement("canvas");
      // keep aspect
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      const scale = Math.min(512 / nw, 512 / nh, 1);
      canvas.width = Math.max(1, Math.round(nw * scale));
      canvas.height = Math.max(1, Math.round(nh * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch (_) {
      // tainted canvas / CORS — fall back to src URL for extension-host fetch
      return null;
    }
  }
  const BADGE_ATTR = "data-lucidscan-host";
  let badgeModeEnabled = true;
  let seq = 0;
  const pending = new Map();
  const scoredImgs = new WeakMap();

  const imgHosts = new Map(); // img -> {host, root, labelEl}
  let textChip = null;
  let textChipRoot = null;
  let textChipLabel = null;
  let selectionTimer = null;

  function loadSettings() {
    try {
      chrome.storage.local.get({ badgeModeEnabled: true }, (r) => {
        badgeModeEnabled = r.badgeModeEnabled !== false;
        if (!badgeModeEnabled) teardownAll();
        else scanImages();
      });
    } catch (_) {
      badgeModeEnabled = true;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.badgeModeEnabled) return;
    badgeModeEnabled = changes.badgeModeEnabled.newValue !== false;
    if (!badgeModeEnabled) teardownAll();
    else scanImages();
  });

  function mountShadowHost(anchor, position) {
    const host = document.createElement("div");
    host.setAttribute(BADGE_ATTR, "1");
    host.style.cssText =
      position === "fixed"
        ? "all:initial;position:fixed;z-index:2147483646;pointer-events:none;"
        : "all:initial;position:absolute;z-index:2147483645;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .pill {
        font: 11px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
        color: #e8eef7;
        background: rgba(18, 28, 45, 0.88);
        border: 1px solid rgba(120, 160, 220, 0.45);
        border-radius: 999px;
        padding: 3px 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        white-space: nowrap;
        letter-spacing: 0.02em;
      }
      .pill[data-state="pending"] { opacity: 0.75; }
      .pill[data-state="signal"] { border-color: rgba(100, 200, 160, 0.55); }
    `;
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.dataset.state = "pending";
    pill.textContent = "pending";
    root.append(style, pill);
    return { host, root, pill };
  }

  function placeImageBadge(img, host) {
    const parent = img.offsetParent || img.parentElement || document.body;
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    host.style.top = `${img.offsetTop + 4}px`;
    host.style.left = `${img.offsetLeft + 4}px`;
    if (!host.isConnected) parent.appendChild(host);
  }

  function requestScore(kind, payload) {
    const id = `ls-${++seq}`;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      try {
        chrome.runtime.sendMessage({ type: kind, id, ...payload }, (resp) => {
          if (chrome.runtime.lastError) {
            pending.delete(id);
            resolve({ label: "offline", state: "pending" });
            return;
          }
          if (resp) {
            pending.delete(id);
            resolve(resp);
          }
        });
      } catch (_) {
        pending.delete(id);
        resolve({ label: "offline", state: "pending" });
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ label: "pending", state: "pending" });
        }
      }, 8000);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.id || !pending.has(msg.id)) return;
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  });

  async function enqueueImage(img) {
    if (!badgeModeEnabled || !img || scoredImgs.has(img)) return;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < MIN_IMG || h < MIN_IMG) return;
    if (!img.src && !img.currentSrc) return;

    scoredImgs.set(img, true);
    let entry = imgHosts.get(img);
    if (!entry) {
      entry = mountShadowHost(img, "absolute");
      imgHosts.set(img, entry);
      placeImageBadge(img, entry.host);
    }
    entry.pill.dataset.state = "pending";
    entry.pill.textContent = "pending";

    const src = img.currentSrc || img.src;
    const dataUrl = imageToDataUrl(img);
    const cacheKey = hashStr(src || dataUrl || "");
    const result = await requestScore("scoreImage", { src, dataUrl, cacheKey });
    if (!imgHosts.has(img)) return;
    entry.pill.dataset.state = result.state || "signal";
    if (result.label === "loading" || result.state === "pending") {
      entry.pill.textContent = result.label || "pending";
    } else if (typeof result.score === "number") {
      entry.pill.textContent = `local score ${Math.round(result.score * 100)}`;
    } else {
      entry.pill.textContent = result.label || "local score";
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) enqueueImage(e.target);
      }
    },
    { root: null, rootMargin: "64px", threshold: 0.01 }
  );

  function observeImg(img) {
    if (!img || imgHosts.has(img) || scoredImgs.has(img)) {
      if (img && !scoredImgs.has(img)) io.observe(img);
      return;
    }
    io.observe(img);
  }

  function scanImages() {
    if (!badgeModeEnabled) return;
    document.querySelectorAll("img").forEach(observeImg);
  }

  const mo = new MutationObserver((mutations) => {
    if (!badgeModeEnabled) return;
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "IMG") observeImg(n);
        else if (n.querySelectorAll) n.querySelectorAll("img").forEach(observeImg);
      }
    }
  });

  function ensureTextChip() {
    if (textChip) return;
    const mounted = mountShadowHost(document.documentElement, "fixed");
    textChip = mounted.host;
    textChipRoot = mounted.root;
    textChipLabel = mounted.pill;
    textChip.style.display = "none";
    document.documentElement.appendChild(textChip);
  }

  function hideTextChip() {
    if (textChip) textChip.style.display = "none";
  }

  async function onSelectionChange() {
    if (!badgeModeEnabled) return hideTextChip();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideTextChip();
    const text = String(sel).trim();
    if (text.length < 12) return hideTextChip();

    const range = sel.getRangeAt(0);
    const box = range.getBoundingClientRect();
    if (!box || (box.width === 0 && box.height === 0)) return hideTextChip();

    ensureTextChip();
    textChip.style.display = "block";
    textChip.style.top = `${Math.max(4, box.top - 28)}px`;
    textChip.style.left = `${Math.max(4, box.left)}px`;
    textChipLabel.dataset.state = "pending";
    textChipLabel.textContent = "pending";

    const result = await requestScore("scoreText", { text: text.slice(0, 4000) });
    if (!window.getSelection() || String(window.getSelection()).trim() !== text) return;
    textChipLabel.dataset.state = result.state || "signal";
    if (typeof result.score === "number") {
      textChipLabel.textContent = `local score ${Math.round(result.score * 100)}`;
    } else {
      textChipLabel.textContent = result.label || "local score";
    }
  }

  function debouncedSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(onSelectionChange, 220);
  }

  function repositionChip() {
    if (!textChip || textChip.style.display === "none") return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return hideTextChip();
    const box = sel.getRangeAt(0).getBoundingClientRect();
    textChip.style.top = `${Math.max(4, box.top - 28)}px`;
    textChip.style.left = `${Math.max(4, box.left)}px`;
  }

  function teardownAll() {
    io.disconnect();
    for (const { host } of imgHosts.values()) host.remove();
    imgHosts.clear();
    hideTextChip();
    if (textChip) {
      textChip.remove();
      textChip = textChipRoot = textChipLabel = null;
    }
  }

  document.addEventListener("selectionchange", debouncedSelection);
  window.addEventListener("scroll", repositionChip, true);
  window.addEventListener("resize", repositionChip);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTextChip();
  });

  mo.observe(document.documentElement, { childList: true, subtree: true });
  loadSettings();
  scanImages();
})();
