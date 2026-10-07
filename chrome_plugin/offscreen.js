/**
 * Offscreen inference coordinator (M2/M3).
 * Transformers.js runs here with vendored ORT WASM under lib/.
 * Text: onnx-community/tmr-ai-text-detector-ONNX (q8), WebGPU → WASM
 * Images: Xenova/clip-vit-base-patch32 zero-shot signal, visible-only + src-hash cache
 * Desklib/Flask are NOT used here.
 *
 * UI contract: return { score, label: "local score"|"loading"|"offline", state, mode }
 * Never claim authenticity.
 */

import { pipeline, env } from "./lib/transformers.min.js";

const TEXT_MODEL = "onnx-community/tmr-ai-text-detector-ONNX";
const IMAGE_MODEL = "Xenova/clip-vit-base-patch32";
const IMAGE_LABELS = [
  "a photograph of a real-world scene",
  "a synthetic computer-generated or AI-generated image",
];

const imageCache = new Map(); // hash -> result (memory)
const IMAGE_CACHE_MAX = 200;
const IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const IDB_NAME = "lucidscan-cache";
const IDB_STORE = "imageScores";
let idbReady = null;

function memoryCacheSet(key, result) {
  if (imageCache.has(key)) imageCache.delete(key);
  imageCache.set(key, { result, ts: Date.now() });
  while (imageCache.size > IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
}

function isFresh(ts) {
  return typeof ts === "number" && Date.now() - ts < IMAGE_CACHE_TTL_MS;
}

function openIdb() {
  if (idbReady) return idbReady;
  idbReady = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
  return idbReady;
}

async function idbGet(key) {
  try {
    const db = await openIdb();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
  }
}

async function idbPut(key, result) {
  try {
    const db = await openIdb();
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      store.put({ key, result, ts: Date.now() });
      // Opportunistic trim: count + delete oldest if over cap
      const countReq = store.count();
      countReq.onsuccess = () => {
        const n = countReq.result || 0;
        if (n <= IMAGE_CACHE_MAX) {
          resolve();
          return;
        }
        const cursorReq = store.openCursor();
        let toDelete = n - IMAGE_CACHE_MAX;
        cursorReq.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor || toDelete <= 0) {
            resolve();
            return;
          }
          store.delete(cursor.primaryKey);
          toDelete--;
          cursor.continue();
        };
        cursorReq.onerror = () => resolve();
      };
      countReq.onerror = () => resolve();
    });
  } catch (_) {}
}

async function cacheGet(key) {
  if (imageCache.has(key)) {
    const hit = imageCache.get(key);
    if (hit && isFresh(hit.ts)) {
      imageCache.delete(key);
      imageCache.set(key, hit); // LRU refresh
      return { ...hit.result, cached: true };
    }
    imageCache.delete(key);
  }
  const row = await idbGet(key);
  if (row && row.result && isFresh(row.ts)) {
    memoryCacheSet(key, row.result);
    return { ...row.result, cached: true };
  }
  if (row && row.key) {
    // expired — best-effort delete
    try {
      const db = await openIdb();
      await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}
  }
  return null;
}

async function cacheSet(key, result) {
  const slim = {
    score: result.score,
    label: result.label || "local score",
    state: result.state || "signal",
    mode: result.mode || "transformers",
  };
  memoryCacheSet(key, slim);
  await idbPut(key, slim);
}
let textPipe = null;
let imagePipe = null;
let textStatus = "idle"; // idle | loading | ready | error
let imageStatus = "idle";
let textError = null;
let imageError = null;
let preferMock = false;
let deviceUsed = { text: null, image: null };
let loadProgress = { which: null, status: "idle", percent: null, file: null, message: null };
let loadCancelled = false;

function configureEnv() {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.allowRemoteModels = true;
  const wasmPath = chrome.runtime.getURL("lib/");
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = wasmPath;
    // MV3 CSP blocks blob workers — stay single-threaded
    env.backends.onnx.wasm.numThreads = 1;
  }
  console.info("[LucidScan offscreen] WASM path", wasmPath);
}

configureEnv();

function storageSet(obj) {
  try {
    if (chrome.storage && chrome.storage.local && chrome.storage.local.set) {
      chrome.storage.local.set(obj);
    }
  } catch (_) {}
}


let offscreenReady = true; // module evaluated; pipelines lazy
try {
  document.documentElement.dataset.lucidOffscreen = "ready";
  document.title = "LucidScan offscreen ready";
} catch (_) {}
chrome.runtime.sendMessage({ type: "offscreen.ready", ready: true }).catch(() => {});

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function mockTextScore(text) {
  const t = (text || "").trim();
  if (!t) return { score: 0.5, label: "local score", state: "signal", mode: "mock" };
  let entropy = 0;
  const freq = {};
  for (const ch of t.toLowerCase()) freq[ch] = (freq[ch] || 0) + 1;
  const n = t.length;
  for (const c of Object.values(freq)) {
    const p = c / n;
    entropy -= p * Math.log2(p);
  }
  const words = t.split(/\s+/).filter(Boolean);
  const avgLen = words.reduce((a, w) => a + w.length, 0) / Math.max(words.length, 1);
  let score = 0.35 + Math.min(entropy / 6, 0.4) + Math.min(avgLen / 20, 0.2);
  score = Math.max(0.05, Math.min(0.95, score));
  return { score, label: "local score", state: "signal", mode: "mock" };
}

function mockImageScore(key) {
  if (imageCache.has(key)) {
    const hit = imageCache.get(key);
    if (hit && isFresh(hit.ts)) return { ...hit.result, cached: true };
  }
  const n = parseInt(hashStr(key).slice(0, 6), 16) || 0;
  const score = 0.2 + (n % 600) / 1000;
  const result = { score, label: "local score", state: "signal", mode: "mock", heuristics: true };
  memoryCacheSet(key, result);
  return result;
}

async function loadSettings(overrides = null) {
  return new Promise((resolve) => {
    const apply = (r) => {
      preferMock = r.forceMock === true || r.inferenceMode === "mock";
      resolve();
    };
    if (overrides && (overrides.inferenceMode != null || overrides.forceMock != null)) {
      apply({
        inferenceMode: overrides.inferenceMode ?? "transformers",
        forceMock: overrides.forceMock === true,
      });
      return;
    }
    try {
      if (!chrome.storage || !chrome.storage.local) {
        preferMock = false;
        resolve();
        return;
      }
      chrome.storage.local.get({ inferenceMode: "transformers", forceMock: false }, (r) => apply(r || {}));
    } catch (_) {
      preferMock = false;
      resolve();
    }
  });
}

async function canUseWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (_) {
    return false;
  }
}

function makeProgressHandler(which) {
  return (info) => {
    if (loadCancelled) return;
    const status = info && info.status ? String(info.status) : "progress";
    let percent = null;
    if (typeof info?.progress === "number") percent = Math.round(info.progress);
    else if (typeof info?.loaded === "number" && typeof info?.total === "number" && info.total > 0) {
      percent = Math.round((100 * info.loaded) / info.total);
    }
    const file = info?.file ? String(info.file).split("/").pop() : null;
    loadProgress = {
      which,
      status,
      percent,
      file,
      message:
        percent != null
          ? `${which}: ${status} ${percent}%${file ? " · " + file : ""}`
          : `${which}: ${status}${file ? " · " + file : ""}`,
    };
  };
}

async function createPipe(task, model, dtype, which = "model") {
  // Prefer WebGPU only when an adapter exists; otherwise WASM (ORT).
  const attempts = [];
  if (await canUseWebGPU()) {
    attempts.push({ device: "webgpu", dtype, label: "webgpu" });
  }
  attempts.push({ device: "wasm", dtype, label: "wasm" });
  attempts.push({ dtype, label: "auto" });

  let lastErr = null;
  for (const opts of attempts) {
    if (loadCancelled) throw new Error("load cancelled");
    try {
      const { label, ...pipelineOpts } = opts;
      loadProgress = {
        which,
        status: "starting",
        percent: 0,
        file: null,
        message: `${which}: starting (${label})…`,
      };
      const pipe = await pipeline(task, model, {
        ...pipelineOpts,
        progress_callback: makeProgressHandler(which),
      });
      loadProgress = {
        which,
        status: "ready",
        percent: 100,
        file: null,
        message: `${which}: ready (${label})`,
      };
      return { pipe, device: label };
    } catch (err) {
      lastErr = err;
      console.warn("[LucidScan] pipeline attempt failed:", opts.label, err?.message || err);
    }
  }
  throw lastErr || new Error("no pipeline backend available");
}

async function ensureTextPipe() {
  if (preferMock) throw new Error("mock mode");
  if (textPipe) return textPipe;
  if (textStatus === "loading") {
    // wait briefly for in-flight load
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (textPipe) return textPipe;
      if (textStatus === "error") throw new Error(textError || "text model failed");
    }
    throw new Error("text model load timeout");
  }
  textStatus = "loading";
  textError = null;
  try {
    const { pipe, device } = await createPipe("text-classification", TEXT_MODEL, "q8", "text");
    textPipe = pipe;
    deviceUsed.text = device;
    textStatus = "ready";
    storageSet({
      textModelStatus: "ready",
      textModelDevice: device,
    });
    return textPipe;
  } catch (err) {
    textStatus = "error";
    textError = String(err?.message || err);
    storageSet({ textModelStatus: "error", textModelError: textError });
    throw err;
  }
}

async function ensureImagePipe() {
  if (preferMock) throw new Error("mock mode");
  if (imagePipe) return imagePipe;
  if (imageStatus === "loading") {
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (imagePipe) return imagePipe;
      if (imageStatus === "error") throw new Error(imageError || "image model failed");
    }
    throw new Error("image model load timeout");
  }
  imageStatus = "loading";
  imageError = null;
  try {
    // fp16 on webgpu when possible; q8/wasm fallback via createPipe dtype
    let pipe, device;
    try {
      ({ pipe, device } = await createPipe("zero-shot-image-classification", IMAGE_MODEL, "fp16", "image"));
    } catch {
      ({ pipe, device } = await createPipe("zero-shot-image-classification", IMAGE_MODEL, "q8", "image"));
    }
    imagePipe = pipe;
    deviceUsed.image = device;
    imageStatus = "ready";
    storageSet({
      imageModelStatus: "ready",
      imageModelDevice: device,
    });
    return imagePipe;
  } catch (err) {
    imageStatus = "error";
    imageError = String(err?.message || err);
    storageSet({ imageModelStatus: "error", imageModelError: imageError });
    throw err;
  }
}

/**
 * Map text-classification output to a single 0..1 local signal score.
 * Prefer the score of the AI/generated-looking label when present; else top score.
 * Label strings stay "local score" — never "AI-detected".
 */
function textOutputToScore(output) {
  const rows = Array.isArray(output) ? output : [output];
  const flat = rows.flat().filter(Boolean);
  if (!flat.length) return 0.5;
  const aiLike = flat.find((r) => /ai|generated|machine|fake|synthetic/i.test(String(r.label || "")));
  const humanLike = flat.find((r) => /human|real|authentic|organic/i.test(String(r.label || "")));
  if (aiLike && typeof aiLike.score === "number") return clamp01(aiLike.score);
  if (humanLike && typeof humanLike.score === "number") return clamp01(1 - humanLike.score);
  const top = flat.reduce((a, b) => (a.score > b.score ? a : b));
  return clamp01(top.score ?? 0.5);
}

function imageOutputToScore(output) {
  const rows = Array.isArray(output) ? output : [output];
  const synth = rows.find((r) => /synthetic|generated|ai/i.test(String(r.label || "")));
  if (synth && typeof synth.score === "number") return clamp01(synth.score);
  const real = rows.find((r) => /photograph|real-world|real/i.test(String(r.label || "")));
  if (real && typeof real.score === "number") return clamp01(1 - real.score);
  return clamp01(rows[0]?.score ?? 0.5);
}

function clamp01(n) {
  return Math.max(0.01, Math.min(0.99, Number(n) || 0.5));
}

async function scoreText(text, overrides = null) {
  await loadSettings(overrides);
  const sample = String(text || "").slice(0, 4000);
  if (preferMock) return mockTextScore(sample);
  if (textStatus === "loading" && !textPipe) {
    ensureTextPipe().catch(() => {});
    return { label: "loading", state: "pending", mode: "transformers" };
  }
  try {
    // Fire-and-forget if idle so first call can also show loading via race with content timeout
    const pipePromise = ensureTextPipe();
    const pipe = await pipePromise;
    const out = await pipe(sample);
    const score = textOutputToScore(out);
    return {
      score,
      label: "local score",
      state: "signal",
      mode: "transformers",
      device: deviceUsed.text,
      model: TEXT_MODEL,
    };
  } catch (err) {
    console.warn("[LucidScan] text pipeline failed, mock fallback:", err);
    const fallback = mockTextScore(sample);
    return { ...fallback, heuristics: true, fallbackReason: String(err?.message || err) };
  }
}

async function scoreImage({ src, dataUrl, cacheKey }, overrides = null) {
  await loadSettings(overrides);
  const key = cacheKey || hashStr(dataUrl || src || "");
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (preferMock) {
    const result = mockImageScore(key);
    await cacheSet(key, result);
    return result;
  }
  if (imageStatus === "loading" && !imagePipe) {
    ensureImagePipe().catch(() => {});
    return { label: "loading", state: "pending", mode: "transformers" };
  }
  try {
    const pipe = await ensureImagePipe();
    const input = dataUrl || src;
    if (!input) throw new Error("no image input");
    const out = await pipe(input, IMAGE_LABELS);
    const score = imageOutputToScore(out);
    const result = {
      score,
      label: "local score",
      state: "signal",
      mode: "transformers",
      device: deviceUsed.image,
      model: IMAGE_MODEL,
    };
    await cacheSet(key, result);
    return result;
  } catch (err) {
    console.warn("[LucidScan] image pipeline failed, mock fallback:", err);
    const fallback = mockImageScore(key);
    return { ...fallback, heuristics: true, fallbackReason: String(err?.message || err) };
  }
}

async function warmup(which = "both", overrides = null) {
  await loadSettings(overrides);
  loadCancelled = false;
  const out = {};
  if (which === "text" || which === "both") {
    try {
      await ensureTextPipe();
      out.text = { status: textStatus, device: deviceUsed.text };
    } catch (e) {
      out.text = { status: "error", error: String(e?.message || e) };
    }
  }
  if (which === "image" || which === "both") {
    try {
      await ensureImagePipe();
      out.image = { status: imageStatus, device: deviceUsed.image };
    } catch (e) {
      out.image = { status: "error", error: String(e?.message || e) };
    }
  }
  return out;
}

function statusPayload() {
  return {
    mode: preferMock ? "mock" : "transformers",
    text: textStatus,
    image: imageStatus,
    textDevice: deviceUsed.text,
    imageDevice: deviceUsed.image,
    textModel: TEXT_MODEL,
    imageModel: IMAGE_MODEL,
    textError,
    imageError,
    progress: { ...loadProgress },
    cancelled: loadCancelled,
  };
}


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type || !String(msg.type).startsWith("offscreen.")) return;

  (async () => {
    try {
      if (msg.type === "offscreen.scoreText") {
        const result = await scoreText(msg.text, msg);
        sendResponse({ id: msg.id, ...result });
        return;
      }
      if (msg.type === "offscreen.scoreImage") {
        const result = await scoreImage({
          src: msg.src,
          dataUrl: msg.dataUrl,
          cacheKey: msg.cacheKey,
        }, msg);
        sendResponse({ id: msg.id, ...result });
        return;
      }
      if (msg.type === "offscreen.ping" || msg.type === "offscreen.ready") {
        sendResponse({ ready: true, offscreenReady });
        return;
      }
      if (msg.type === "offscreen.getStatus") {
        await loadSettings(msg);
        sendResponse(statusPayload());
        return;
      }
      if (msg.type === "offscreen.warmup") {
        const warm = await warmup(msg.which || "both", msg);
        sendResponse({ ok: true, ...warm, ...statusPayload() });
        return;
      }
      if (msg.type === "offscreen.cancelLoad") {
        loadCancelled = true;
        loadProgress = { which: loadProgress.which, status: "cancelled", percent: null, file: null, message: "load cancelled" };
        sendResponse({ ok: true, ...statusPayload() });
        return;
      }
      if (msg.type === "offscreen.getProgress") {
        sendResponse(statusPayload());
        return;
      }
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
});

// Eager settings + optional auto-warmup of text model (smaller than CLIP)
loadSettings().then(() => {
  chrome.storage.local.get({ autoWarmup: true }, (r) => {
    if (r.autoWarmup !== false && !preferMock) {
      warmup("text").catch((e) => console.warn("[LucidScan] auto warmup text failed", e));
    }
  });
});
