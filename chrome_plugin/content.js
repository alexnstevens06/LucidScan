(() => {
  "use strict";
  if (globalThis.__lucidScanContentLoaded) return;
  globalThis.__lucidScanContentLoaded = true;

  const MIN_IMG = 48;
  const MAX_CONCURRENT = 2;
  const SELECTION_DEBOUNCE_MS = 280;
  const BADGE_ATTR = "data-lucidscan-host";
  const TITLE_SIGNAL = "LucidScan local signal — not an authenticity verdict";

  let sitePaused = false;
  let badgesActive = true; // !sitePaused

  function currentOriginPattern() {
    try {
      const u = location;
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return `${u.protocol}//${u.host}/*`;
    } catch (_) {
      return null;
    }
  }

  function refreshPauseState(cb) {
    const pattern = currentOriginPattern();
    try {
      chrome.storage.local.get({ pausedOrigins: [] }, (r) => {
        const paused = Array.isArray(r.pausedOrigins) ? r.pausedOrigins : [];
        sitePaused = !!(pattern && paused.includes(pattern));
        badgesActive = !sitePaused;
        if (typeof cb === "function") cb();
      });
    } catch (_) {
      sitePaused = false;
      badgesActive = true;
      if (typeof cb === "function") cb();
    }
  }
  let seq = 0;
  let inFlight = 0;
  let jobGeneration = 0;
  const pending = new Map();
  const highQueue = []; // text / interactive
  const lowQueue = []; // images
  const scoredImgs = new WeakMap();
  const imgHosts = new Map();
  let textChip = null;
  let textChipLabel = null;
  let selectionTimer = null;
  let moQueued = false;
  let pendingNodes = [];

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < String(s).length; i++) {
      h ^= String(s).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function imageToDataUrl(img) {
    try {
      const nw = img.naturalWidth || img.width || 0;
      const nh = img.naturalHeight || img.height || 0;
      if (nw < MIN_IMG || nh < MIN_IMG) return null;
      const scale = Math.min(512 / nw, 512 / nh, 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(nw * scale));
      canvas.height = Math.max(1, Math.round(nh * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch (_) {
      return null;
    }
  }

  function isSkippableImg(img) {
    if (!img || img.nodeType !== 1) return true;
    if (img.closest("[data-lucidscan-host]")) return true;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && h > 0 && (w < MIN_IMG || h < MIN_IMG)) return true;
    try {
      const st = getComputedStyle(img);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return true;
      if (img.getClientRects().length === 0) return true;
    } catch (_) {}
    if (!img.src && !img.currentSrc) return true;
    return false;
  }

  function loadSettings() {
    refreshPauseState(() => {
      if (!badgesActive) teardownAll(false);
      else {
        ensureObservers();
        scanImages();
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.pausedOrigins) return;
    refreshPauseState(() => {
      if (!badgesActive) teardownAll(false);
      else {
        ensureObservers();
        scanImages();
      }
    });
  });

  function mountShadowHost(position) {
    const host = document.createElement("div");
    host.setAttribute(BADGE_ATTR, "1");
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-label", "LucidScan local signal");
    host.title = TITLE_SIGNAL;
    host.style.cssText =
      position === "fixed"
        ? "all:initial;position:fixed;z-index:2147483646;pointer-events:none;"
        : "all:initial;position:absolute;z-index:2147483645;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .pill {
        font: 600 11px/1.25 system-ui, -apple-system, Segoe UI, sans-serif;
        color: #f4f8ff;
        background: linear-gradient(180deg, rgba(22,34,54,0.96), rgba(12,18,30,0.96));
        border: 1px solid rgba(180, 210, 255, 0.55);
        border-radius: 999px;
        padding: 3px 9px;
        box-shadow: 0 1px 0 rgba(255,255,255,0.12) inset, 0 2px 10px rgba(0,0,0,0.45);
        white-space: nowrap;
        letter-spacing: 0.02em;
        text-shadow: 0 1px 1px rgba(0,0,0,0.55);
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pill[data-state="pending"],
      .pill[data-state="loading"] { opacity: 0.85; border-color: rgba(160,180,210,0.4); }
      .pill[data-state="signal"] { border-color: rgba(120, 220, 180, 0.7); }
      .pill[data-state="offline"] { border-color: rgba(230, 170, 100, 0.75); color: #ffe8cc; }
    `;
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.dataset.state = "pending";
    pill.textContent = "pending";
    pill.title = TITLE_SIGNAL;
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

  function paintPill(pill, result) {
    if (!pill || !result) return;
    const mode = result.mode || "";
    const fallback = result.fallbackReason || result.label === "offline";
    let state = result.state || "signal";
    let text = result.label || "local score";
    if (result.label === "loading" || state === "pending") {
      state = result.label === "loading" ? "loading" : "pending";
      text = result.label || "pending";
    } else if (fallback || result.heuristics || mode === "mock") {
      state = "offline";
      text =
        typeof result.score === "number"
          ? `local heuristics ${Math.round(result.score * 100)}`
          : "local heuristics (models unavailable)";
    } else if (typeof result.score === "number") {
      text = `local score ${Math.round(result.score * 100)}`;
      state = "signal";
    } else if (result.label === "offline") {
      state = "offline";
      text = "models unavailable";
    }
    pill.dataset.state = state;
    pill.textContent = text;
    pill.title = TITLE_SIGNAL;
  }

  function requestScore(kind, payload) {
    const id = `ls-${++seq}`;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      try {
        chrome.runtime.sendMessage({ type: kind, id, ...payload }, (resp) => {
          if (chrome.runtime.lastError) {
            pending.delete(id);
            resolve({ label: "offline", state: "offline", mode: "mock" });
            return;
          }
          if (resp) {
            pending.delete(id);
            resolve(resp);
          }
        });
      } catch (_) {
        pending.delete(id);
        resolve({ label: "offline", state: "offline", mode: "mock" });
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ label: "pending", state: "pending" });
        }
      }, 12000);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "teardownBadges") {
      teardownAll(true);
      globalThis.__lucidScanContentLoaded = false;
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  function pumpQueue() {
    while (inFlight < MAX_CONCURRENT && (highQueue.length || lowQueue.length)) {
      const job = highQueue.length ? highQueue.shift() : lowQueue.shift();
      inFlight++;
      Promise.resolve()
        .then(job)
        .catch(() => {})
        .finally(() => {
          inFlight--;
          pumpQueue();
        });
    }
  }

  function enqueueImage(img) {
    if (!badgesActive || !img || scoredImgs.has(img) || isSkippableImg(img)) return;
    scoredImgs.set(img, true);
    const gen = jobGeneration;
    lowQueue.push(async () => {
      if (gen !== jobGeneration || !badgesActive) return;
      if (!badgesActive || !img.isConnected) return;
      let entry = imgHosts.get(img);
      if (!entry) {
        entry = mountShadowHost("absolute");
        imgHosts.set(img, entry);
        placeImageBadge(img, entry.host);
      }
      entry.pill.dataset.state = "pending";
      entry.pill.textContent = "pending";
      entry.pill.title = TITLE_SIGNAL;
      const src = img.currentSrc || img.src;
      const dataUrl = imageToDataUrl(img);
      const cacheKey = hashStr(src || dataUrl || "");
      const result = await requestScore("scoreImage", { src, dataUrl, cacheKey });
      if (!imgHosts.has(img)) return;
      paintPill(entry.pill, result);
    });
    pumpQueue();
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) enqueueImage(e.target);
      }
    },
    { root: null, rootMargin: "80px", threshold: 0.01 }
  );

  function observeImg(img) {
    if (!img || scoredImgs.has(img)) return;
    const hasSrc = !!(img.src || img.currentSrc);
    if (hasSrc && !img.complete) {
      img.addEventListener("load", () => observeImg(img), { once: true });
      img.addEventListener("error", () => {}, { once: true });
      return;
    }
    if (isSkippableImg(img)) return;
    io.observe(img);
  }

  function scanImages() {
    if (!badgesActive) return;
    document.querySelectorAll("img").forEach(observeImg);
    scanSameOriginIframes();
  }

  function scanSameOriginIframes() {
    if (!badgesActive) return;
    let frames;
    try {
      frames = document.querySelectorAll("iframe");
    } catch (_) {
      return;
    }
    for (const frame of frames) {
      try {
        const doc = frame.contentDocument;
        if (!doc) continue; // cross-origin — needs its own host grant + all_frames
        doc.querySelectorAll("img").forEach((img) => {
          // Observe from parent IO only works for parent-viewport; enqueue directly if visible-ish
          observeImg(img);
        });
      } catch (_) {
        // cross-origin access denied — expected
      }
    }
  }


  function flushMutations() {
    moQueued = false;
    if (!badgesActive) {
      pendingNodes = [];
      return;
    }
    const nodes = pendingNodes;
    pendingNodes = [];
    for (const n of nodes) {
      if (!n || n.nodeType !== 1) continue;
      if (n.tagName === "IMG") observeImg(n);
      else if (n.querySelectorAll) n.querySelectorAll("img").forEach(observeImg);
    }
  }

  function scheduleMutationFlush() {
    if (moQueued) return;
    moQueued = true;
    const run = () => flushMutations();
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => requestAnimationFrame(run), { timeout: 200 });
    } else {
      requestAnimationFrame(run);
    }
  }

  const mo = new MutationObserver((mutations) => {
    if (!badgesActive) return;
    for (const m of mutations) {
      for (const n of m.addedNodes) pendingNodes.push(n);
    }
    scheduleMutationFlush();
  });

  function ensureTextChip() {
    if (textChip) return;
    const mounted = mountShadowHost("fixed");
    textChip = mounted.host;
    textChipLabel = mounted.pill;
    textChip.style.display = "none";
    textChip.setAttribute("aria-label", "LucidScan local score for selection");
    document.documentElement.appendChild(textChip);
  }

  function hideTextChip() {
    if (textChip) textChip.style.display = "none";
  }

  async function onSelectionChange() {
    if (!badgesActive) return hideTextChip();
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
    textChipLabel.title = TITLE_SIGNAL;

    const gen = jobGeneration;
    const result = await new Promise((resolve) => {
      highQueue.unshift(async () => {
        if (gen !== jobGeneration || !badgesActive) {
          resolve({ label: "pending", state: "pending" });
          return;
        }
        resolve(await requestScore("scoreText", { text: text.slice(0, 4000) }));
      });
      pumpQueue();
    });
    if (gen !== jobGeneration) return;
    if (!window.getSelection() || String(window.getSelection()).trim() !== text) return;
    paintPill(textChipLabel, result);
  }

  function debouncedSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(onSelectionChange, SELECTION_DEBOUNCE_MS);
  }

  function repositionChip() {
    if (!textChip || textChip.style.display === "none") return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return hideTextChip();
    const box = sel.getRangeAt(0).getBoundingClientRect();
    textChip.style.top = `${Math.max(4, box.top - 28)}px`;
    textChip.style.left = `${Math.max(4, box.left)}px`;
  }

  function teardownAll(hard = false) {
    highQueue.length = 0;
    lowQueue.length = 0;
    jobGeneration++;
    for (const { host } of imgHosts.values()) host.remove();
    imgHosts.clear();
    hideTextChip();
    if (textChip) {
      textChip.remove();
      textChip = textChipLabel = null;
    }
    if (hard) {
      try { io.disconnect(); } catch (_) {}
      try { mo.disconnect(); } catch (_) {}
      try { stripObserver.disconnect(); } catch (_) {}
    }
  }


  // Re-attach badges if a page strips our host nodes (anti-extension). Back off; don't fight forever.
  let stripStrikes = 0;
  const stripSeen = new WeakSet();
  const stripObserver = new MutationObserver((mutations) => {
    if (!badgesActive || stripStrikes > 6) return;
    let stripped = false;
    for (const m of mutations) {
      for (const n of m.removedNodes) {
        if (n.nodeType === 1 && (n.hasAttribute?.(BADGE_ATTR) || n.querySelector?.(`[${BADGE_ATTR}]`))) {
          stripped = true;
        }
      }
    }
    if (!stripped) return;
    stripStrikes++;
    const delay = Math.min(6000, 300 * 2 ** Math.min(stripStrikes, 5));
    setTimeout(() => {
      if (!badgesActive) return;
      // Clear weak scored markers for visible imgs missing hosts, then rescan
      for (const img of document.querySelectorAll("img")) {
        if (!imgHosts.has(img) && !isSkippableImg(img)) {
          try { scoredImgs.delete(img); } catch (_) {}
          observeImg(img);
        }
      }
    }, delay);
  });

  function ensureObservers() {
    try {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
    try {
      stripObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }


  function rebindAfterSoftNav() {
    if (!badgesActive) return;
    ensureObservers();
    scanImages();
  }

  // History API / SPA soft navigation without extra permissions
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = function (...args) {
    const r = _push(...args);
    queueMicrotask(rebindAfterSoftNav);
    return r;
  };
  history.replaceState = function (...args) {
    const r = _replace(...args);
    queueMicrotask(rebindAfterSoftNav);
    return r;
  };
  window.addEventListener("popstate", rebindAfterSoftNav);
  window.addEventListener("hashchange", rebindAfterSoftNav);

  document.addEventListener("selectionchange", debouncedSelection);
  window.addEventListener("scroll", repositionChip, true);
  window.addEventListener("resize", repositionChip);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTextChip();
  });

  ensureObservers();
  loadSettings();
  scanImages();
})();
