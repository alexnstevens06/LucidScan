# LucidScan

Local browse-time **signal** badges for Chrome (MV3, load unpacked, v0.4.0), plus an optional Flask desktop path from TIDALHack 25.

Badges are a **local signal only** from on-device models and local heuristics — not an authenticity verdict.

## Quick start (Load unpacked + Enable)

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → pick `chrome_plugin/`.
2. Serve the sample page over http (Enable does not work on `file://`):
   ```bash
   cd chrome_plugin && ./test/serve.sh      # http://127.0.0.1:8765/test/sample.html
   ```
3. Open the sample page → LucidScan icon → **Enable badges on this site** → **Allow** (or `Alt+Shift+L`).
4. Visible images get a corner pill (`…` → `local score N`); select ≥12 chars of text for a floating chip.
5. First run downloads models from Hugging Face (progress shown in the popup under **Models**; **Retry model load** if it fails).
6. **Pause badges on this site** hides badges but keeps the enable; **Resume** brings them back; **Disable** removes the site enable and tears badges down. **Clear all enabled sites** resets everything.

Nothing is injected on any site until you enable it (no static `content_scripts`).

## Features (how to verify: `docs/feature-map.md`)

- **Inject-only per site:** optional host permission requested in the popup click (gesture-safe), then `scripting.registerContentScripts` for that origin only.
- **Image badges:** visible images only (IntersectionObserver), closed Shadow DOM pills, src-hash score cache (~200 entries, 24h TTL, memory LRU + IndexedDB).
- **Cheap prefilters (local heuristics):** tiny images, tiny data URIs, and near-flat images skip CLIP and show `local heuristics`.
- **Selection chip:** follows the selection on scroll/resize/visualViewport changes; flips below if clipped; readable on light and dark pages.
- **Models:** auto-warmup when the offscreen document starts; popup shows stage / % with Retry; **Cancel load watch** stops the progress UI (an in-flight download may still finish).
- **SPA support:** history-hook rebinding only (no `webNavigation`).
- **Zero `web_accessible_resources`**; no `addHostAccessRequest`.
- **Fallback:** if models fail to load, badges show `local heuristics` (labeled fallback scorer) so the page stays usable.

## Tests

```bash
npm test                 # = bash scripts/test.sh: syntax check + health_check.py + node:test unit tests (offline, no browser)
python3 chrome_plugin/scripts/cdp_smoke.py   # optional: headless Chrome, Extensions.loadUnpacked, SW alive, 0 badges before Enable
```

`health_check.py` checks manifest validity, zero WAR, no static `content_scripts`, no `webNavigation` / `addHostAccessRequest`, no vendored weights, and scans UI strings + README for claim words. Unit tests cover the URL restriction guard, origin patterns, hashing, prefilters, and cache LRU/TTL. The CDP smoke needs `websocket-client` and network for the sample images.

## Known limits

- Cross-origin iframes are not scanned unless that origin is enabled separately; same-origin iframes may be.
- Restricted pages (`chrome://`, `file://`, Web Store, `view-source:`, other extensions) cannot be enabled.
- Cross-origin images that taint the canvas skip the flat-image prefilter and are sent by URL instead of a canvas copy.
- First run needs network (~tens of MB text model + ~85 MB CLIP); later loads use the browser cache.
- Granting host permission needs a real click, so automated tests stop at "0 badges before Enable".
- Scores are an uncalibrated local signal, not a verdict.

### What badges mean

| Label | Meaning |
|-------|---------|
| `…` | Score in flight |
| `local heuristics` | Prefilter or fallback scorer (models unavailable) |
| `local score N` | Local heuristic/model **signal** (0–100 display). Not authenticity. |
| `offline` | Coordinator unavailable |

Transformers.js pipelines run in an **offscreen document** (labeled heuristics fallback if models are unavailable). Architecture matches `docs/lucidscan-mv3-local.md`:

- Content script = thin bridge (injected **only after** Enable badges on this site); **closed Shadow DOM** badges
- `MutationObserver` + `IntersectionObserver` (visible images only)
- `selectionchange` + Range floating chip for text
- Service worker coordinates; inference in offscreen
- Context menu kept as fallback (“Scan … (local signal)”)

### Local models (default badge path — not Desklib)

- **Text (M2):** Transformers.js + `onnx-community/tmr-ai-text-detector-ONNX` (q8), WebGPU → WASM, in the offscreen document
- **Images (M3):** Transformers.js + CLIP ViT-B/32 (`Xenova/clip-vit-base-patch32`), IntersectionObserver visible-only, cache by `src` hash; content script sends an ephemeral canvas data URL when possible
- **Runtime:** ORT WASM vendored under `chrome_plugin/lib/`; model weights download from Hugging Face on first use (browser cache). Popup → **Load local models** to warm up.
- **Fallback:** If a pipeline fails to load, badges fall back to labeled `local heuristics` scores so the UX stays up.
- **Not** the default badge path: Desklib (~1.75GB) / Flask CLIP-large — optional power-user desktop stack only

Set `chrome.storage.local.inferenceMode = "mock"` or `forceMock: true` to force heuristics without downloading models.

### Legal / model notes

- LucidScan: Apache-2.0
- Transformers.js: Apache-2.0; TMR ONNX port: MIT
- OpenAI CLIP **code** is MIT; the CLIP **model card** describes deployed use (commercial or not) as **out of scope** pending task-specific testing. This project frames the extension as **local/dev research signal tooling**, not a cleared commercial authenticity product.
- Do **not** scrape, bulk-download, or resell third-party site images. Badge path processes in-tab media ephemerally.

See `docs/lucidscan-mv3-local.md` for the full research pack.


### First-run model download (size expectations)

Weights are **not** shipped in git. On first inference (or popup → **Load local models**), Transformers.js downloads from Hugging Face into the browser cache:

| Pipeline | Model id | Ballpark download |
|----------|----------|-------------------|
| Text (q8) | `onnx-community/tmr-ai-text-detector-ONNX` | on the order of **tens of MB** (RoBERTa-base ONNX q8) |
| Images | `Xenova/clip-vit-base-patch32` | often cited ~**85 MB** class for CLIP ViT-B/32 ONNX |
| Runtime (vendored) | `chrome_plugin/lib/*` | ~**22 MB** ORT WASM + Transformers.js bundle (already in the extension folder) |

Exact bytes vary by dtype/device (WebGPU fp16 vs WASM q8). Use a network connection the first time; later loads hit the browser cache.

### Automated smoke note (tower / CI)

Branded Chrome 137+ ignores `--load-extension`. `cdp_smoke.py` uses CDP `Extensions.loadUnpacked` with `--enable-unsafe-extension-debugging` (verified on Chrome 154). Chrome offscreen documents may not expose `chrome.storage`; LucidScan keeps settings in the service worker / popup.

## Optional Flask server (power user)

`chrome_plugin/background.js` may still `POST http://localhost:5000/detect` for **video** context-menu scans when the server is running.

- `server.py` — Flask on port 5000
- `text_detection.py` — Desklib AI text detector (heavy; desktop)
- `detect.py` — CLIP ViT-L/14 + ViT + heuristics

```bash
# from repo root, with deps installed
python server.py
```

## Layout

- `chrome_plugin/manifest.json` — MV3 load-unpacked root
- `chrome_plugin/content.js` — Shadow DOM badges + observers
- `chrome_plugin/background.js` — service worker / offscreen coordinator / context menus
- `chrome_plugin/offscreen.html` + `offscreen.js` — local model scoring + progress + cache
- `chrome_plugin/popup.*` — badge toggle, status, About
- `chrome_plugin/test/` — `sample.html`, `serve.sh`, `unit/` node tests
- `chrome_plugin/scripts/` — `health_check.py`, `cdp_smoke.py`
- `docs/feature-map.md` — feature → how to verify
- `docs/lucidscan-mv3-local.md` — architecture & model guidance
- `expectations.txt` — legacy Flask JSON shape

## Manual done-check

0. Without enabling a site, sample page should show **no** badge hosts; after **Enable badges on this site**, badges appear.

1. `npm test` passes
2. Load unpacked `chrome_plugin/` — service worker should not crash
3. Serve sample page; confirm image pills + selection chip
4. Confirm UI copy has no authenticity claims
5. Popup → **Load local models**; after download, selection chip / image pills show `local score N` with `mode: transformers`
