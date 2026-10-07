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

const imageCache = new Map(); // hash -> result
let textPipe = null;
let imagePipe = null;
let textStatus = "idle"; // idle | loading | ready | error
let imageStatus = "idle";
let textError = null;
let imageError = null;
let preferMock = false;
let deviceUsed = { text: null, image: null };

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
  if (imageCache.has(key)) return { ...imageCache.get(key), cached: true };
  const n = parseInt(hashStr(key).slice(0, 6), 16) || 0;
  const score = 0.2 + (n % 600) / 1000;
  const result = { score, label: "local score", state: "signal", mode: "mock" };
  imageCache.set(key, result);
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

async function createPipe(task, model, dtype) {
  // Prefer WebGPU only when an adapter exists; otherwise WASM (ORT).
  const attempts = [];
  if (await canUseWebGPU()) {
    attempts.push({ device: "webgpu", dtype, label: "webgpu" });
  }
  attempts.push({ device: "wasm", dtype, label: "wasm" });
  // Final fallback: let Transformers.js pick a backend
  attempts.push({ dtype, label: "auto" });

  let lastErr = null;
  for (const opts of attempts) {
    try {
      const { label, ...pipelineOpts } = opts;
      const pipe = await pipeline(task, model, pipelineOpts);
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
    const { pipe, device } = await createPipe("text-classification", TEXT_MODEL, "q8");
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
      ({ pipe, device } = await createPipe("zero-shot-image-classification", IMAGE_MODEL, "fp16"));
    } catch {
      ({ pipe, device } = await createPipe("zero-shot-image-classification", IMAGE_MODEL, "q8"));
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
    if (textStatus === "loading") {
      // still loading after ensure kicked
    }
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
    return { ...fallback, fallbackReason: String(err?.message || err) };
  }
}

async function scoreImage({ src, dataUrl, cacheKey }, overrides = null) {
  await loadSettings(overrides);
  const key = cacheKey || hashStr(dataUrl || src || "");
  if (imageCache.has(key)) {
    return { ...imageCache.get(key), cached: true };
  }
  if (preferMock) {
    return mockImageScore(key);
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
    imageCache.set(key, result);
    // Persist small cache in session storage (bounded)
    try {
      if (chrome.storage && chrome.storage.session && chrome.storage.session.set) {
      chrome.storage.session.set({ [`img:${key}`]: { score, ts: Date.now() } });
    }
    } catch (_) {}
    return result;
  } catch (err) {
    console.warn("[LucidScan] image pipeline failed, mock fallback:", err);
    const fallback = mockImageScore(key);
    return { ...fallback, fallbackReason: String(err?.message || err) };
  }
}

async function warmup(which = "both", overrides = null) {
  await loadSettings(overrides);
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
