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
// Pinned Hugging Face commits (git SHA of each model repo). Bump deliberately: a new SHA means a
// new first-run download (the browser cache is keyed by URL, which includes the revision).
const MODEL_REVISIONS = {
  [TEXT_MODEL]: "b9aa251e5bcda7e429fcc936767d921435945b60",
  [IMAGE_MODEL]: "d15189d7028b43f1d3e65039190477f6af591c2a",
};
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
let textErrorAt = 0;
let imageErrorAt = 0;

// Cancel only affects a load that is in flight, and the flag clears once that load settles,
// so a cancel can never leave later requests stuck.
function settleCancel() {
  if (textStatus !== "loading" && imageStatus !== "loading") loadCancelled = false;
}

function requestCancel() {
  if (textStatus === "loading" || imageStatus === "loading") loadCancelled = true;
  return loadCancelled;
}

/** Start a background load if needed; returns true when the pipe is ready now. */
function kickLoad(which) {
  const ready = which === "text" ? !!textPipe : !!imagePipe;
  if (ready) return true;
  const status = which === "text" ? textStatus : imageStatus;
  const errAt = which === "text" ? textErrorAt : imageErrorAt;
  if (status === "loading") return false;
  if (status === "error" && Date.now() - errAt < RELOAD_AFTER_ERROR_MS) return false;
  (which === "text" ? ensureTextPipe() : ensureImagePipe()).catch(() => {});
  return false;
}

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

function storageSet(_obj) {
  // No-op. This document has no storage API; status goes out on score/status replies.
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

// No stand-in scores: when a model is not ready or the input cannot be read, the answer is
// "loading" (retryable) or "unavailable" (with a reason) — never a made-up number.
function unavailable(reason) {
  return { state: "unavailable", label: "unavailable", reason: String(reason || "models unavailable") };
}

function loadingReply(which) {
  const p = loadProgress && loadProgress.which === which ? loadProgress.percent : null;
  return { state: "loading", label: "loading", mode: "transformers", progress: typeof p === "number" ? p : null };
}

const RELOAD_AFTER_ERROR_MS = 60 * 1000;

/**
 * Resolve the pixels for an image request. dataUrl comes from the content script when the page
 * canvas was readable. Otherwise (tainted canvas: cross-origin image without CORS) fetch src from
 * the extension origin; that only succeeds when the server sends CORS headers or the user granted
 * host permission for the image's origin. Failure => unavailable, not a fallback number.
 */
async function resolveImageInput(src, dataUrl) {
  if (dataUrl) return { input: dataUrl };
  if (!src) return { error: "no image input" };
  let u;
  try {
    u = new URL(src);
  } catch (_) {
    return { error: "image URL not readable" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "data:") {
    return { error: "image URL scheme not supported" };
  }
  try {
    const resp = await fetch(u.href, { credentials: "omit", cache: "force-cache" });
    if (!resp.ok) return { error: `image fetch failed (HTTP ${resp.status})` };
    const blob = await resp.blob();
    if (!blob.size || (blob.type && !blob.type.startsWith("image/"))) return { error: "response is not an image" };
    const url = URL.createObjectURL(blob);
    return { input: url, revoke: () => URL.revokeObjectURL(url) };
  } catch (_) {
    return { error: "cross-origin image not readable (no CORS / host permission)" };
  }
}

async function loadSettings(overrides = null) {
  // Flags are relayed by the service worker (this document has no storage API).
  // No overrides: keep the current mode (default transformers / preferMock false).
  if (overrides && (overrides.inferenceMode != null || overrides.forceMock != null)) {
    preferMock = overrides.forceMock === true || (overrides.inferenceMode ?? "transformers") === "mock";
  }
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
        revision: MODEL_REVISIONS[model],
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
    if (loadCancelled) {
      textStatus = "idle"; // cancelled, not broken: the next request may start a fresh load
      textError = null;
    } else {
      textStatus = "error";
      textError = String(err?.message || err);
      textErrorAt = Date.now();
    }
    storageSet({ textModelStatus: textStatus, textModelError: textError });
    throw err;
  } finally {
    settleCancel();
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
    if (loadCancelled) {
      imageStatus = "idle";
      imageError = null;
    } else {
      imageStatus = "error";
      imageError = String(err?.message || err);
      imageErrorAt = Date.now();
    }
    storageSet({ imageModelStatus: imageStatus, imageModelError: imageError });
    throw err;
  } finally {
    settleCancel();
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
  if (preferMock) return unavailable("models disabled in settings (mock mode)");
  if (!kickLoad("text")) {
    if (textStatus === "error") return unavailable(`text model failed to load: ${textError}`);
    return loadingReply("text");
  }
  try {
    const out = await textPipe(sample);
    return {
      score: textOutputToScore(out),
      label: "local score",
      state: "signal",
      mode: "transformers",
      device: deviceUsed.text,
      model: TEXT_MODEL,
    };
  } catch (err) {
    console.warn("[LucidScan] text inference failed:", err?.message || err);
    return unavailable(`text inference failed: ${String(err?.message || err)}`);
  }
}

async function scoreImage({ src, dataUrl, cacheKey }, overrides = null) {
  await loadSettings(overrides);
  if (preferMock) return unavailable("models disabled in settings (mock mode)");
  const key = cacheKey || hashStr(dataUrl || src || "");
  const cached = await cacheGet(key);
  if (cached && cached.state === "signal" && typeof cached.score === "number" && cached.mode !== "mock") {
    return cached;
  }
  // Never await the first-run CLIP download here: answer "loading" (with progress) right away
  // and let the content script retry with backoff.
  if (!kickLoad("image")) {
    if (imageStatus === "error") return unavailable(`image model failed to load: ${imageError}`);
    return loadingReply("image");
  }
  const resolved = await resolveImageInput(src, dataUrl);
  if (resolved.error) return unavailable(resolved.error);
  try {
    const out = await imagePipe(resolved.input, IMAGE_LABELS);
    const result = {
      score: imageOutputToScore(out),
      label: "local score",
      state: "signal",
      mode: "transformers",
      device: deviceUsed.image,
      model: IMAGE_MODEL,
    };
    await cacheSet(key, result); // only real model scores are cached
    return result;
  } catch (err) {
    console.warn("[LucidScan] image inference failed:", err?.message || err);
    return unavailable(`image not readable by model: ${String(err?.message || err)}`);
  } finally {
    if (resolved.revoke) resolved.revoke();
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


// Only the extension's own pages/service worker may drive the offscreen document. Content
// scripts' runtime.sendMessage also reaches this listener, so reject anything from a tab
// context or a non-extension URL.
const EXTENSION_ORIGIN = chrome.runtime.getURL("");
function isTrustedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (sender.tab) return false;
  return typeof sender.url === "string" && sender.url.startsWith(EXTENSION_ORIGIN);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || !String(msg.type).startsWith("offscreen.")) return;
  if (!isTrustedSender(sender)) return;

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
        if (requestCancel()) {
          loadProgress = { which: loadProgress.which, status: "cancelled", percent: null, file: null, message: "load cancelled" };
        }
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

// Eager settings + optional auto-warmup of text model (smaller than CLIP).
// Ask the service worker; retry because it may still be starting.
(async () => {
  const fallback = { autoWarmup: true, inferenceMode: "transformers", forceMock: false };
  let result = fallback;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "getOffscreenSettings" });
      if (reply && typeof reply === "object") {
        result = reply;
        break;
      }
    } catch (_) {}
    if (attempt < 4) await new Promise((r) => setTimeout(r, 300));
  }
  await loadSettings(result);
  if (result.autoWarmup !== false && !preferMock) {
    warmup("text").catch((e) => console.warn("[LucidScan] auto warmup text failed", e));
  }
})();
