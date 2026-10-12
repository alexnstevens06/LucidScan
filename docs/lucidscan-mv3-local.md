# LucidScan MV3 Local Badge Research Pack

**For:** Millwright via Progenitor  
**Topic:** Chrome MV3 on-page badges + local-only inference  
**Repo inspected:** https://github.com/alexnstevens06/LucidScan (main @ `272bfa35`, ~24 KB, Apache-2.0)  
**Date:** 2026-10-06 (America/Chicago)  
**Goal framing:** browse-time **signal badge only** — **no accuracy claims**; do **not** scrape/resell third-party site images.

---

## 0) LucidScan today (baseline)

| Area | Finding |
|------|---------|
| Purpose | “Integrated chrome extension for detecting text, image, and video authenticity locally” (repo description) |
| Chrome path | `chrome_plugin/background.js` — **context-menu only** (`selection` / `image` / `video`) → opens popup → `POST http://localhost:5000/detect` |
| Manifest | **No `manifest.json`** in tree; README notes this explicitly |
| Text | `text_detection.py` loads **`desklib/ai-text-detector-v1.01`** (custom `DesklibAIDetectionModel` head on DeBERTa) on **CPU** |
| Images/video | `detect.py` loads **`openai/clip-vit-large-patch14`** + **`google/vit-large-patch32-224-in21k`**, plus heuristic checks (noise, edges, FFT, EXIF, color hist, invisible watermark) |
| Server | Flask `server.py` on port 5000; Python deps via `pyproject.toml` / `requirements.txt` |
| Gap vs goal | Context-menu + localhost Python server ≠ MV3 on-page badges + in-browser local inference |

Primary repo: https://github.com/alexnstevens06/LucidScan

---

## 1) Chrome MV3: on-page badges (not context-menu-only)

### Recommended MV3 pattern (one choice)

**Content-script overlays in a closed Shadow DOM + MutationObserver (images) + `selectionchange` floating badge (text), with inference in an offscreen document / service-worker coordinator.**

Why this over context-menu: badges appear at browse time without right-click; Shadow DOM isolates CSS; MutationObserver catches SPA/lazy images; selection Range rects position the text chip without mouse coords.

### (a) Image badges

1. Declare a content script (`run_at: "document_idle"`) matching target hosts (or register dynamically after user opt-in).
2. Scan existing `img` / `picture` / CSS-background candidates once at inject.
3. Attach a **scoped MutationObserver** (`childList` + `subtree` on a feed container when known; else `document.documentElement` with cheap filters). Prefer `requestIdleCallback` batching; pair with **IntersectionObserver** so only visible images enqueue inference.
4. Mount a small fixed/absolute badge host **per image** (corner overlay), inside a **closed shadow root** so page CSS cannot restyle it.
5. Teardown: `observer.disconnect()`, remove hosts, abort in-flight work on navigation.

Official / solid refs:

- Content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts  
- MutationObserver patterns (MV3): https://mv3-extension.com/manifest-v3-architecture-extension-lifecycle/content-scripts-dom-injection/observing-dom-changes-efficiently-with-mutationobserver/  
- In-page overlays / Shadow DOM: https://mv3-extension.com/uiux-patterns-interactive-components/in-page-overlays-injected-ui/

Tiny sketch (structure only):

```js
// content: observe + badge host
const { host, root } = mountShadowHost(img); // closed shadow
observer.observe(container, { childList: true, subtree: true });
io.observe(img); // visibility gate before messaging SW/offscreen
```

### (b) Selected-text badges

1. Debounced `document.addEventListener("selectionchange", ...)`.
2. `const r = getSelection()?.getRangeAt(0); const box = r.getBoundingClientRect();`
3. Position a **fixed** chip from viewport coords; reposition on capture-phase `scroll`/`resize`.
4. Prefer `popover="manual"` (or equivalent top-layer) so page z-index cannot bury the chip; dismiss on empty selection / Esc.
5. Send selected string to background/offscreen for local classify; paint badge with **signal label only** (e.g. “local score”) — never “AI / human verified.”

Refs:

- Selection tooltip positioning: https://mv3-extension.com/uiux-patterns-interactive-components/in-page-overlays-injected-ui/positioning-tooltips-near-a-text-selection/  
- Transformers.js MV3 architecture (SW owns models; content script = thin page bridge): https://huggingface.co/blog/transformersjs-chrome-extension  
- Example OSS: https://github.com/nico-martin/gemma4-browser-extension

### Permissions notes

| Need | Mechanism | Tradeoff |
|------|-----------|----------|
| Always-on badges on many sites | `content_scripts.matches` and/or `host_permissions` / `optional_host_permissions` | Triggers install warnings; CWS review scrutiny |
| User-gesture only inject | `"activeTab"` + `"scripting"` + `chrome.scripting.executeScript` / `registerContentScripts` | No persistent host access; badge path starts after click/command |
| Fetch models / WAR | Declare model assets in `web_accessible_resources` if content script loads them; prefer loading models from **extension origin** in SW/offscreen | Avoid exposing large WARs broadly |

Official:

- activeTab: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab  
- Declare permissions: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions  
- activeTab inject tutorial: https://developer.chrome.com/docs/extensions/get-started/tutorial/scripts-activetab  

**Practical LucidScan recommendation:** ship **optional host permissions** (user enables “badge mode” per site or broadly) so SPA MutationObserver works without requiring a context click every time; keep context menu as fallback. For Web Store trust, start with opt-in hosts.

CSP note: extension isolated worlds allow `'wasm-unsafe-eval'` — required for WASM/ORT backends (see content-scripts CSP section on Chrome docs above).

---

## 2) Local-only inference (laptop CPU / modest GPU)

**Constraint:** badge path must not call a cloud API. Keep LucidScan’s Flask server as an optional power-user path; badges should run in-extension.

### Runtime map

| Stack | Fit for badges | Notes |
|-------|----------------|-------|
| **Transformers.js** (ORT Web under the hood) | **Best default** | Pipelines, WebGPU/`wasm`, HF ONNX community models, Chrome-extension guide exists |
| **ONNX Runtime Web** (+ WebGPU EP) | Strong if you own custom ONNX graphs | Direct control; WebGPU for heavy models; WASM for tiny ones. Docs: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html |
| **MediaPipe Tasks (JS)** | Good for **vision classify/embed** only | ImageClassifier / ImageEmbedder WASM; not a drop-in for Desklib text. https://developers.google.com/edge/mediapipe/solutions/setup_web |
| **TensorFlow.js** | Viable but more DIY for HF checkpoints | Larger ecosystem; usually heavier than T.js+ORT for transformer ports |
| Pure WASM custom | Last resort | Highest engineering cost |

Architecture tip (from HF Chrome guide): **load models once in background/offscreen**, message scores to content scripts. Service workers can suspend — treat model state as re-initable. WebGPU often needs an **offscreen document** if SW lacks GPU access.

### (i) AI-text / authenticity **signals**

| Option | Size / ballpark | Latency ballpark | Local? |
|--------|-----------------|------------------|--------|
| **desklib/ai-text-detector-v1.01** (current LucidScan) | ~0.4B params; HF tree ~**1.75 GB** F32 | Seconds on laptop CPU; poor for per-selection badge | Local if you ship weights, but **too heavy** for MV3 badge UX unless heavily quantized + off-main-thread |
| **onnx-community/tmr-ai-text-detector-ONNX** (RoBERTa-base, RAID) | ~125M; quantized ONNX (q8 typical tens–low-hundreds MB) | Roughly **tens–few hundreds ms** on WASM; faster with WebGPU on discrete GPU | Yes — Transformers.js `text-classification` |
| **onnx-community/BERT-tiny-RAID-ONNX** | Tiny BERT | Low tens of ms aspirational on WASM | Yes — prototype / low-end laptops |
| Heuristic authenticity signals (perplexity proxies, length/style features) | Tiny | &lt;10 ms | Yes — weak signal only; fits “no accuracy claim” |

**Recommended text stack:** **Transformers.js + `onnx-community/tmr-ai-text-detector-ONNX` (q8), device `webgpu` with WASM fallback**, run in offscreen/SW; content script only sends selection text and paints badge.

- Model: https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX  
- Tiny alt: https://huggingface.co/onnx-community/BERT-tiny-RAID-ONNX  
- T.js docs: https://huggingface.co/docs/transformers.js/en/index  
- WebGPU guide: https://huggingface.co/docs/transformers.js/guides/webgpu  

If Millwright insists on Desklib parity: export/quantize `desklib/ai-text-detector-v1.01` to ONNX (DeBERTa-v3-large is large; expect multi-hundred-MB even quantized) and gate behind “high quality / slow” mode — not the default badge path.

### (ii) CLIP / ViT **image embeddings** for on-page images

LucidScan currently uses **CLIP ViT-L/14** + **ViT-L/32 ImageNet-21k** — strong but heavy for every visible `<img>`.

| Option | Size / ballpark | Latency ballpark | Local? |
|--------|-----------------|------------------|--------|
| **Xenova / onnx-community CLIP ViT-B/32** via Transformers.js | Demo load ~**85 MB** | WebGPU fp16 reported **~20+ fps** class for zero-shot; WASM slower (tens–hundreds ms/image) | Yes |
| CLIP ViT-L/14 (current) | Hundreds of MB–GB class | Too slow for dense page badges on modest GPU | Local only if user-triggered |
| MediaPipe ImageEmbedder | Small TFLite/.task | Fast on CPU/WASM for embeddings | Yes — embeddings ≠ “AI detector” |
| Lightweight CNN (MobileNet-class) via T.js/ORT | ~5–20 MB | Low ms–tens ms | Yes — different signal |

**Recommended image stack:** **Transformers.js + CLIP ViT-B/32 ONNX (`Xenova/clip-vit-base-patch32` or onnx-community equivalent), WebGPU fp16, WASM fallback**; score **only IntersectionObserver-visible** images; debounce; cache by `src` URL hash in `chrome.storage` / IndexedDB.

- CLIP B/32 (Transformers.js-ready): https://huggingface.co/Xenova/clip-vit-base-patch32  
- Zero-shot playground cites ~85 MB: https://transformers-js.github.io/  
- MediaPipe vision tasks: https://developers.google.com/edge/api/mediapipe/js/tasks-vision  

Keep LucidScan’s noise/FFT/EXIF heuristics as **cheap prefilters** in the content script or worker (no model) before CLIP — still framed as signals, not verdicts.

### Backend pick rule of thumb

- Small text / single selection → WASM often fine.  
- Vision / batched images → WebGPU when available (ORT WebGPU docs above).  
- Always ship WASM fallback for CPU-only laptops.

---

## 3) License / model notes

| Asset | License / policy | Redistribution / commercial flags |
|-------|------------------|-----------------------------------|
| **LucidScan** repo | Apache-2.0 | OK to build on; keep NOTICE/LICENSE |
| **desklib/ai-text-detector-v1.01** | **MIT** (model card) | Redistribution OK under MIT; still no accuracy claims in UI. https://huggingface.co/desklib/ai-text-detector-v1.01 · https://github.com/desklib/ai-text-detector |
| **microsoft/deberta-v3-large** (Desklib base) | MIT (widely reported on HF cards / Microsoft DeBERTa line) | Confirm on card before shipping: https://huggingface.co/microsoft/deberta-v3-large |
| **Oxidane/tmr-ai-text-detector** (+ ONNX community port) | **MIT** | Good badge candidate; cite RAID training limits (English-centric) |
| **openai/CLIP** code | **MIT** | https://github.com/openai/CLIP/blob/main/LICENSE |
| **OpenAI CLIP model card** | Deployed use (commercial **or not**) described as **out of scope** pending task-specific testing | **Flag for product/legal:** software license ≠ model-card blessing for unconstrained deployment. Prefer framing as research/signal tool; consider non-OpenAI CLIP-likes (e.g. OpenCLIP Apache weights) if commercial packaging tightens. Model card: https://github.com/openai/CLIP/blob/main/model-card.md · HF: https://huggingface.co/openai/clip-vit-large-patch14 |
| **google/vit-*** (incl. large-patch32-224-in21k) | **Apache-2.0** (google-research/vision_transformer) | Generally redistribution-friendly: https://github.com/google-research/vision_transformer |
| **Transformers.js / @huggingface/transformers** | Apache-2.0 | Runtime OK to bundle |
| **ONNX Runtime Web** | MIT (Microsoft ORT) | Bundle WASM artifacts; respect binary size in CWS package |

**Do not:** scrape, bulk-download, or resell others’ on-page images. Badge path should process **in-tab bitmaps/URLs the user is already viewing**, ephemerally, for a local signal — no dataset harvesting.

---

## 4) Explicit product constraints (carry into UI copy)

1. Badge = **browse-time local signal**, not a forensic or authenticity guarantee.  
2. No UI strings like “100% AI” / “verified human.” Prefer “local score” / “signal.”  
3. No cloud required for the badge path.  
4. No scraping/reselling third-party images.  
5. Optional: disclose model names + licenses in an About / Options page.

---

## 5) Concrete build targets for Millwright

| Decision | Recommendation | Primary URLs |
|----------|----------------|--------------|
| **MV3 UI pattern** | Content-script **Shadow DOM badges** + MutationObserver/IntersectionObserver (images) + Range-based selection chip (text); models in offscreen/SW | https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts · https://mv3-extension.com/uiux-patterns-interactive-components/in-page-overlays-injected-ui/ · https://huggingface.co/blog/transformersjs-chrome-extension |
| **Text inference** | Transformers.js + **tmr-ai-text-detector-ONNX** (q8), WebGPU→WASM | https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX · https://huggingface.co/docs/transformers.js/guides/webgpu |
| **Image inference** | Transformers.js + **CLIP ViT-B/32** ONNX, visible-only | https://huggingface.co/Xenova/clip-vit-base-patch32 · https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html |
| **Permissions** | Start with `optional_host_permissions` + user toggle; `activeTab` for one-shot; avoid broad required hosts at v1 | https://developer.chrome.com/docs/extensions/develop/concepts/activeTab · https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions |
| **Desklib** | Keep as optional heavy/desktop path (current Python) or future quantized ONNX “max” mode — not default badge | https://huggingface.co/desklib/ai-text-detector-v1.01 |

### Suggested milestone order

1. Add real MV3 `manifest.json` + content script badge chrome (mock scores).  
2. Wire Transformers.js offscreen + text pipeline on selection.  
3. Wire CLIP B/32 on visible images + cache.  
4. Optional: port Desklib to quantized ONNX; keep heuristics as free prefilter.  
5. Strip accuracy claim language; add license/About panel.

---

## 6) Source index (primary)

- LucidScan: https://github.com/alexnstevens06/LucidScan  
- Chrome content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts  
- Chrome activeTab: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab  
- Chrome permissions: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions  
- MV3 overlays / MutationObserver / selection tooltips: https://mv3-extension.com/uiux-patterns-interactive-components/in-page-overlays-injected-ui/  
- HF Transformers.js Chrome extension guide: https://huggingface.co/blog/transformersjs-chrome-extension  
- Transformers.js WebGPU: https://huggingface.co/docs/transformers.js/guides/webgpu  
- ORT WebGPU: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html  
- Desklib detector: https://huggingface.co/desklib/ai-text-detector-v1.01  
- TMR ONNX detector: https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX  
- CLIP B/32 (JS): https://huggingface.co/Xenova/clip-vit-base-patch32  
- OpenAI CLIP license + model card: https://github.com/openai/CLIP  
- Google ViT (Apache-2.0): https://github.com/google-research/vision_transformer  
- MediaPipe web setup: https://developers.google.com/edge/mediapipe/solutions/setup_web
