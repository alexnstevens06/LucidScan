(() => {
  "use strict";
  // Idempotent injection: one live instance per page (isolated world). Enable may run
  // executeScript while a registered content script already injected us; the second copy exits.
  // A hard teardown (Disable / Pause) destroys the instance and clears this guard, so a later
  // Enable injects a fresh one instead of stacking on a zombie.
  const lucidRoot = /** @type {LucidGlobal} */ (globalThis);
  const prior = lucidRoot.__lucidScanInstance;
  if (prior && prior.alive) return;
  /** @type {LucidInstance} */
  const instance = { alive: true, destroy: null, stats: null };
  lucidRoot.__lucidScanInstance = instance;
  lucidRoot.__lucidScanContentLoaded = true;

  // Every listener/timer this instance adds is tracked so destroy() can remove all of them.
  /** @type {TrackedListener[]} */
  const listeners = [];
  /**
   * @param {EventTarget | null | undefined} target
   * @param {string} type
   * @param {EventListener} fn
   * @param {boolean | AddEventListenerOptions} [opts]
   */
  function on(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, fn, opts);
    listeners.push({ target, type, fn, opts });
  }
  /** @type {TrackedChromeListener[]} */
  const chromeListeners = [];
  /**
   * @param {any} event
   * @param {any} fn
   */
  function onChrome(event, fn) {
    event.addListener(fn);
    chromeListeners.push({ event, fn });
  }
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  /**
   * @param {Function} fn
   * @param {number} ms
   */
  function addTimer(fn, ms) {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }

  const MIN_IMG = 48;
  const MAX_CONCURRENT = 2;
  const SELECTION_DEBOUNCE_MS = 280;
  const BADGE_ATTR = "data-lucidscan-host";
  const TITLE_SIGNAL = "LucidScan local signal — not an authenticity verdict";

  let sitePaused = false;
  let badgesActive = true; // !sitePaused

  /** @returns {string | null} */
  function currentOriginPattern() {
    try {
      const u = location;
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return `${u.protocol}//${u.host}/*`;
    } catch (_) {
      return null;
    }
  }

  /** @param {() => void} [cb] */
  function refreshPauseState(cb) {
    const pattern = currentOriginPattern();
    try {
      chrome.storage.local.get({ pausedOrigins: [] }, (r) => {
        if (!instance.alive) return;
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
  /** @type {Map<string, (value: ScoreResult) => void>} */
  const pending = new Map();
  /** @type {Array<() => Promise<void> | void>} */
  const highQueue = []; // text / interactive
  /** @type {Array<() => Promise<void> | void>} */
  const lowQueue = []; // images
  /** @type {WeakMap<HTMLImageElement, boolean>} */
  const scoredImgs = new WeakMap();
  /** @type {Map<HTMLImageElement, BadgeMount>} */
  const imgHosts = new Map();
  /** @type {HTMLElement | null} */
  let textChip = null;
  /** @type {HTMLElement | null} */
  let textChipLabel = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let selectionTimer = null;
  let moQueued = false;
  /** @type {Node[]} */
  let pendingNodes = [];

  /** @param {string} s */
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < String(s).length; i++) {
      h ^= String(s).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }


  /**
   * Cheap JS prefilters before CLIP (heuristics only — not authenticity).
   * Returns { skip: true, reason } or { skip: false }.
   */
  /**
   * @param {HTMLImageElement} img
   * @param {string | null | undefined} _dataUrl
   * @returns {{ skip: true, reason: string } | { skip: false }}
   */
  function cheapImagePrefilter(img, _dataUrl) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && h > 0 && (w < MIN_IMG || h < MIN_IMG)) {
      return { skip: true, reason: "tiny" };
    }
    const src = img.currentSrc || img.src || "";
    if (src.startsWith("data:") && src.length < 800) {
      return { skip: true, reason: "tiny-data-uri" };
    }
    // Solid-color / near-empty canvas sample (very cheap, small draw)
    try {
      const cw = Math.min(16, w || 16);
      const ch = Math.min(16, h || 16);
      if (cw >= 4 && ch >= 4 && img.complete) {
        const c = document.createElement("canvas");
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        // No 2d context: same outcome as a thrown draw (caught below) — do not skip.
        if (!ctx) return { skip: false };
        ctx.drawImage(img, 0, 0, cw, ch);
        const data = ctx.getImageData(0, 0, cw, ch).data;
        let sum = 0;
        let sumSq = 0;
        const n = cw * ch;
        for (let i = 0; i < data.length; i += 4) {
          const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          sum += y;
          sumSq += y * y;
        }
        const mean = sum / n;
        const variance = sumSq / n - mean * mean;
        if (variance < 4) {
          return { skip: true, reason: "flat" };
        }
      }
    } catch (_) {
      // tainted / security — do not skip; let model path or heuristics handle
    }
    return { skip: false };
  }

  /** @param {HTMLImageElement} img @returns {string | null} */
  function imageToDataUrl(img) {
    try {
      const nw = img.naturalWidth || img.width || 0;
      const nh = img.naturalHeight || img.height || 0;
      if (nw < MIN_IMG || nh < MIN_IMG) return null;
      const scale = Math.min(512 / nw, 512 / nh, 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(nw * scale));
      canvas.height = Math.max(1, Math.round(nh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch (_) {
      return null;
    }
  }

  /** @param {HTMLImageElement | null | undefined} img */
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
      if (!instance.alive) return;
      if (!badgesActive) teardownAll(false);
      else {
        ensureObservers();
        scanImages();
      }
    });
  }

  /**
   * @param {{ [key: string]: chrome.storage.StorageChange }} changes
   * @param {string} area
   */
  function onStorageChanged(changes, area) {
    if (!instance.alive || area !== "local") return;
    if (changes.enabledOrigins) {
      const pattern = currentOriginPattern();
      const list = Array.isArray(changes.enabledOrigins.newValue) ? changes.enabledOrigins.newValue : [];
      if (!pattern || !list.includes(pattern)) {
        destroy(); // site disabled elsewhere (popup list, permission removal)
        return;
      }
    }
    if (!changes.pausedOrigins) return;
    refreshPauseState(() => {
      if (!instance.alive) return;
      if (!badgesActive) teardownAll(false);
      else {
        ensureObservers();
        scanImages();
      }
    });
  }

  /** @param {"fixed" | "absolute"} position @returns {BadgeMount} */
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
      .pill[data-state="unavailable"],
      .pill[data-state="offline"] { border-color: rgba(230, 170, 100, 0.75); color: #ffe8cc; }
    `;
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.dataset.state = "pending";
    pill.textContent = "…";
    pill.title = TITLE_SIGNAL;
    root.append(style, pill);
    return { host, root, pill };
  }

  /** @param {HTMLImageElement} img @param {HTMLElement} host */
  function placeImageBadge(img, host) {
    const parent = /** @type {HTMLElement} */ (img.offsetParent || img.parentElement || document.body);
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    host.style.top = `${img.offsetTop + 4}px`;
    host.style.left = `${img.offsetLeft + 4}px`;
    if (!host.isConnected) parent.appendChild(host);
  }

  /**
   * Render a result. Only a real model score shows a number. Anything else (models failed,
   * image unreadable, prefilter skip, mock mode) shows "unavailable" with the reason in the
   * tooltip; while the model is downloading it shows progress.
   */
  /** @param {HTMLElement | null | undefined} pill @param {ScoreResult | null | undefined} result */
  function paintPill(pill, result) {
    if (!pill || !result) return;
    const r = result;
    let state;
    let text;
    let title = TITLE_SIGNAL;
    if (isRetryable(r)) {
      state = "loading";
      const p = typeof r.progress === "number" ? Math.max(0, Math.min(100, Math.round(r.progress))) : null;
      text = p != null && p < 100 ? `downloading model ${p}%` : "loading model…";
      title = `${TITLE_SIGNAL} — model loading (first run downloads it once)`;
    } else if (
      r.state === "signal" &&
      typeof r.score === "number" &&
      r.mode !== "mock" &&
      !r.heuristics &&
      !r.fallbackReason
    ) {
      state = "signal";
      text = `local score ${Math.round(r.score * 100)}`;
    } else {
      state = "unavailable";
      text = "unavailable";
      title = `${TITLE_SIGNAL} — ${r.reason || r.fallbackReason || r.error || "models unavailable"}`;
    }
    pill.dataset.state = state;
    pill.textContent = text;
    pill.title = title;
  }

  // Retry schedule while the model is still downloading/loading (first run fetches ~300 MB CLIP).
  const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];
  const RETRY_BUDGET_MS = 10 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 12000;

  /** @param {ScoreResult | null | undefined} result */
  function isRetryable(result) {
    if (!result) return true;
    return result.state === "loading" || result.state === "pending" || result.label === "loading";
  }

  /**
   * @param {string} kind
   * @param {Record<string, unknown>} payload
   * @returns {Promise<ScoreResult>}
   */
  function requestScore(kind, payload) {
    const id = `ls-${++seq}`;
    return new Promise((done) => {
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null;
      /** @param {ScoreResult} v */
      const resolve = (v) => {
        if (timer) {
          clearTimeout(timer);
          timers.delete(timer);
          timer = null;
        }
        done(v);
      };
      pending.set(id, resolve);
      try {
        chrome.runtime.sendMessage({ type: kind, id, ...payload }, (resp) => {
          if (chrome.runtime.lastError) {
            pending.delete(id);
            resolve({ state: "unavailable", reason: "extension unreachable" });
            return;
          }
          if (resp) {
            pending.delete(id);
            resolve(resp);
          }
        });
      } catch (_) {
        pending.delete(id);
        resolve({ state: "unavailable", reason: "extension unreachable" });
      }
      // No reply yet (offscreen busy): treat as still loading so the caller retries with backoff.
      timer = addTimer(() => {
        timer = null;
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ state: "loading", reason: "no reply yet" });
        }
      }, REQUEST_TIMEOUT_MS);
    });
  }

  /**
   * @param {(ScoreResult & { type?: string }) | null | undefined} msg
   * @param {chrome.runtime.MessageSender} sender
   */
  function onRuntimeMessage(msg, sender) {
    if (!msg) return;
    if (sender && sender.id && sender.id !== chrome.runtime.id) return;
    if (msg.type === "teardownBadges") {
      destroy();
      return;
    }
    if (msg.type === "lucidscan.ping") return; // presence handled by globalThis guard
    if (msg.id && pending.has(msg.id)) {
      const resolve = /** @type {(value: ScoreResult) => void} */ (pending.get(msg.id));
      pending.delete(msg.id);
      resolve(msg);
    }
  }

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

  /** @param {HTMLImageElement | null | undefined} img */
  function enqueueImage(img) {
    if (!badgesActive || !img || scoredImgs.has(img) || isSkippableImg(img)) return;
    scoredImgs.set(img, true);
    scheduleImageAttempt(img, 0, Date.now(), jobGeneration);
  }

  /**
   * @param {HTMLImageElement} img
   * @param {number} attempt
   * @param {number} startedAt
   * @param {number} gen
   */
  function scheduleImageAttempt(img, attempt, startedAt, gen) {
    lowQueue.push(async () => {
      if (!instance.alive || gen !== jobGeneration || !badgesActive || !img.isConnected) return;
      let entry = imgHosts.get(img);
      if (!entry) {
        entry = mountShadowHost("absolute");
        imgHosts.set(img, entry);
        placeImageBadge(img, entry.host);
        entry.pill.dataset.state = "loading";
        entry.pill.textContent = "…";
      }
      const src = img.currentSrc || img.src;
      // null when the canvas is tainted (cross-origin without CORS); offscreen then fetches src
      // itself and answers with a real score or "unavailable".
      const dataUrl = imageToDataUrl(img);
      const pre = cheapImagePrefilter(img, dataUrl);
      if (pre.skip) {
        paintPill(entry.pill, { state: "unavailable", reason: `not scored (${pre.reason})` });
        return;
      }
      const cacheKey = hashStr(src || dataUrl || "");
      const result = await requestScore("scoreImage", { src, dataUrl, cacheKey });
      if (!instance.alive || gen !== jobGeneration || !imgHosts.has(img)) return;
      if (isRetryable(result)) {
        if (Date.now() - startedAt > RETRY_BUDGET_MS) {
          paintPill(entry.pill, { state: "unavailable", reason: "model did not finish loading" });
          return;
        }
        paintPill(entry.pill, result);
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        addTimer(() => {
          if (!instance.alive || gen !== jobGeneration) return;
          scheduleImageAttempt(img, attempt + 1, startedAt, gen);
          pumpQueue();
        }, delay);
        return;
      }
      paintPill(entry.pill, result);
    });
    pumpQueue();
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) enqueueImage(/** @type {HTMLImageElement} */ (e.target));
      }
    },
    { root: null, rootMargin: "80px", threshold: 0.01 }
  );

  /** @param {HTMLImageElement | null | undefined} img */
  function observeImg(img) {
    if (!img || scoredImgs.has(img)) return;
    const hasSrc = !!(img.src || img.currentSrc);
    if (hasSrc && !img.complete) {
      on(img, "load", () => { if (instance.alive && badgesActive) observeImg(img); }, { once: true });
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
      const el = /** @type {Element} */ (n);
      if (el.tagName === "IMG") observeImg(/** @type {HTMLImageElement} */ (el));
      else if (el.querySelectorAll) el.querySelectorAll("img").forEach(observeImg);
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
    const chip = /** @type {HTMLElement} */ (textChip);
    const label = /** @type {HTMLElement} */ (textChipLabel);
    chip.style.display = "block";
    chip.style.top = `${Math.max(4, box.top - 28)}px`;
    chip.style.left = `${Math.max(4, box.left)}px`;
    label.dataset.state = "loading";
    label.textContent = "…";
    label.title = TITLE_SIGNAL;
    repositionChip();

    const gen = jobGeneration;
    const result = await new Promise((resolve) => {
      highQueue.unshift(async () => {
        if (gen !== jobGeneration || !badgesActive) {
          resolve({ label: "pending", state: "pending" });
          return;
        }
        let r = await requestScore("scoreText", { text: text.slice(0, 4000) });
        const t0 = Date.now();
        let attempt = 0;
        // Model still loading: keep the chip in a loading state and retry with backoff while
        // the same text stays selected.
        while (isRetryable(r) && instance.alive && gen === jobGeneration &&
               String(window.getSelection() || "").trim() === text) {
          if (Date.now() - t0 > RETRY_BUDGET_MS) {
            r = { state: "unavailable", reason: "model did not finish loading" };
            break;
          }
          if (textChipLabel) paintPill(textChipLabel, r);
          const d = RETRY_DELAYS_MS[Math.min(attempt++, RETRY_DELAYS_MS.length - 1)];
          await new Promise((res) => addTimer(res, d));
          if (!instance.alive || gen !== jobGeneration) break;
          r = await requestScore("scoreText", { text: text.slice(0, 4000) });
        }
        resolve(r);
      });
      pumpQueue();
    });
    if (!instance.alive || gen !== jobGeneration || !textChipLabel) return;
    if (!window.getSelection() || String(window.getSelection()).trim() !== text) return;
    paintPill(textChipLabel, result);
  }

  function debouncedSelection() {
    if (!instance.alive) return;
    clearTimeout(selectionTimer ?? undefined);
    selectionTimer = setTimeout(onSelectionChange, SELECTION_DEBOUNCE_MS);
  }

  function repositionChip() {
    if (!textChip || textChip.style.display === "none") return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return hideTextChip();
    const box = sel.getRangeAt(0).getBoundingClientRect();
    if (!box || (box.width === 0 && box.height === 0)) return hideTextChip();
    const vv = window.visualViewport;
    const viewW = vv ? vv.width : window.innerWidth;
    const viewH = vv ? vv.height : window.innerHeight;
    const chipW = textChip.offsetWidth || 120;
    const chipH = textChip.offsetHeight || 24;
    // Prefer above selection; if clipped, place below
    let top = box.top - chipH - 6;
    if (top < 4) top = Math.min(viewH - chipH - 4, box.bottom + 6);
    let left = box.left;
    left = Math.max(4, Math.min(left, viewW - chipW - 4));
    textChip.style.top = `${Math.round(top)}px`;
    textChip.style.left = `${Math.round(left)}px`;
  }

  /** @param {boolean} [hard] */
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
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const resolve of pending.values()) resolve({ state: "unavailable", reason: "torn down" });
    pending.clear();
    clearTimeout(selectionTimer ?? undefined);
    pendingNodes = [];
    if (hard) {
      try { io.disconnect(); } catch (_) {}
      try { mo.disconnect(); } catch (_) {}
      try { stripObserver.disconnect(); } catch (_) {}
    }
  }

  /** Hard teardown: stop everything this instance did and allow a clean re-injection. */
  function destroy() {
    if (!instance.alive) return;
    instance.alive = false;
    badgesActive = false;
    sitePaused = true;
    teardownAll(true);
    for (const { target, type, fn, opts } of listeners.splice(0)) {
      try { target.removeEventListener(type, fn, opts); } catch (_) {}
    }
    for (const { event, fn } of chromeListeners.splice(0)) {
      try { event.removeListener(fn); } catch (_) {}
    }
    if (history.pushState === wrappedPush) history.pushState = origPush;
    if (history.replaceState === wrappedReplace) history.replaceState = origReplace;
    if (lucidRoot.__lucidScanInstance === instance) {
      lucidRoot.__lucidScanInstance = null;
      lucidRoot.__lucidScanContentLoaded = false;
    }
  }
  instance.destroy = destroy;
  instance.stats = () => ({
    alive: instance.alive,
    badgesActive,
    listeners: listeners.length,
    chromeListeners: chromeListeners.length,
    timers: timers.size,
    badges: imgHosts.size,
    badgeTexts: [...imgHosts.values()].map((e) => e.pill.textContent),
    badgesBySrc: [...imgHosts.entries()].map(([img, e]) => [img.currentSrc || img.src, e.pill.textContent]),
    historyPatched: history.pushState === wrappedPush,
  });


  // Re-attach badges if a page strips our host nodes (anti-extension). Back off; don't fight forever.
  let stripStrikes = 0;
  const stripObserver = new MutationObserver((mutations) => {
    if (!badgesActive || stripStrikes > 6) return;
    let stripped = false;
    for (const m of mutations) {
      for (const n of m.removedNodes) {
        const el = /** @type {Element} */ (n);
        if (n.nodeType === 1 && (el.hasAttribute?.(BADGE_ATTR) || el.querySelector?.(`[${BADGE_ATTR}]`))) {
          stripped = true;
        }
      }
    }
    if (!stripped) return;
    stripStrikes++;
    const delay = Math.min(6000, 300 * 2 ** Math.min(stripStrikes, 5));
    addTimer(() => {
      if (!instance.alive || !badgesActive) return;
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
    if (!instance.alive) return;
    try {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
    try {
      stripObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }


  function rebindAfterSoftNav() {
    if (!instance.alive || !badgesActive) return;
    ensureObservers();
    scanImages();
  }

  // History API / SPA soft navigation without extra permissions. Originals are restored on destroy.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  const wrappedPush = /** @type {History["pushState"]} */ (
    /**
     * @this {History}
     * @param {...any} args
     */
    function (...args) {
      const r = origPush.apply(this, /** @type {Parameters<History["pushState"]>} */ (args));
      queueMicrotask(rebindAfterSoftNav);
      return r;
    }
  );
  const wrappedReplace = /** @type {History["replaceState"]} */ (
    /**
     * @this {History}
     * @param {...any} args
     */
    function (...args) {
      const r = origReplace.apply(this, /** @type {Parameters<History["replaceState"]>} */ (args));
      queueMicrotask(rebindAfterSoftNav);
      return r;
    }
  );
  history.pushState = wrappedPush;
  history.replaceState = wrappedReplace;
  on(window, "popstate", rebindAfterSoftNav);
  on(window, "hashchange", rebindAfterSoftNav);

  on(document, "selectionchange", debouncedSelection);
  on(window, "scroll", repositionChip, true);
  on(window, "resize", repositionChip);
  if (window.visualViewport) {
    on(window.visualViewport, "resize", repositionChip);
    on(window.visualViewport, "scroll", repositionChip);
  }
  on(document, "keydown", (e) => {
    if (/** @type {KeyboardEvent} */ (e).key === "Escape") hideTextChip();
  });
  onChrome(chrome.runtime.onMessage, onRuntimeMessage);
  onChrome(chrome.storage.onChanged, onStorageChanged);

  ensureObservers();
  loadSettings();
  scanImages();
})();
