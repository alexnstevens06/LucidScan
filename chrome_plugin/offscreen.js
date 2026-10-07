/**
 * Offscreen inference coordinator.
 * M1: mock local scores (shippable).
 * M2/M3 stubs: Transformers.js + tmr-ai-text-detector-ONNX (q8) and CLIP ViT-B/32.
 * Do NOT use Desklib here — keep that on the optional Python/Flask path.
 */

const imageCache = new Map();
const MODE = "mock";

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function mockTextScore(text) {
  const t = (text || "").trim();
  if (!t) return { score: 0.5, label: "local score", state: "signal", mode: MODE };
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
  return { score, label: "local score", state: "signal", mode: MODE };
}

function mockImageScore(src) {
  if (imageCache.has(src)) return { ...imageCache.get(src), cached: true };
  const key = hashStr(src || "");
  const n = parseInt(key.slice(0, 6), 16) || 0;
  const score = 0.2 + (n % 600) / 1000;
  const result = { score, label: "local score", state: "signal", mode: MODE };
  imageCache.set(src, result);
  return result;
}

/** M2 stub — onnx-community/tmr-ai-text-detector-ONNX via Transformers.js */
async function scoreTextWithTransformers(_text) {
  throw new Error("Transformers.js text pipeline not wired yet (M2)");
}

/** M3 stub — Xenova/clip-vit-base-patch32 via Transformers.js */
async function scoreImageWithTransformers(_src) {
  throw new Error("Transformers.js CLIP B/32 pipeline not wired yet (M3)");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type || !msg.type.startsWith("offscreen.")) return;

  (async () => {
    try {
      if (msg.type === "offscreen.scoreText") {
        let result;
        if (MODE === "transformers") {
          try {
            result = await scoreTextWithTransformers(msg.text);
          } catch {
            result = mockTextScore(msg.text);
          }
        } else {
          result = mockTextScore(msg.text);
        }
        sendResponse({ id: msg.id, ...result });
        return;
      }
      if (msg.type === "offscreen.scoreImage") {
        let result;
        if (MODE === "transformers") {
          try {
            result = await scoreImageWithTransformers(msg.src);
          } catch {
            result = mockImageScore(msg.src);
          }
        } else {
          result = mockImageScore(msg.src);
        }
        sendResponse({ id: msg.id, ...result });
        return;
      }
      if (msg.type === "offscreen.getStatus") {
        sendResponse({ mode: MODE, text: "mock", image: "mock" });
      }
    } catch (err) {
      sendResponse({
        id: msg.id,
        label: "pending",
        state: "pending",
        error: String(err && err.message ? err.message : err),
      });
    }
  })();
  return true;
});
