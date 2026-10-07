# LucidScan

Local browse-time **signal** badges for Chrome (MV3), plus an optional Flask desktop path from TIDALHack 25.

Badges are a **local signal only** — not an authenticity verdict. The UI never claims “AI verified”, “100% human”, or similar.

## Chrome extension (primary)

Load unpacked from `chrome_plugin/`:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `chrome_plugin/` directory
4. Open any `http`/`https` page (or serve `chrome_plugin/test/sample.html` with `python3 -m http.server`)
5. Visible images get a corner pill (`pending` → `local score N`); select text (≥12 chars) for a floating chip
6. Popup: toggle **Badge mode**, optionally **Enable badges on sites** (optional host permissions), view About/licenses

### What badges mean

| Label | Meaning |
|-------|---------|
| `pending` | Score in flight or unavailable |
| `local score N` | Local heuristic/model **signal** (0–100 display). Not authenticity. |
| `offline` | Coordinator unavailable |

Current milestone (**M2/M3**): Transformers.js pipelines in an **offscreen document** (mock fallback if models unavailable). Architecture matches `docs/lucidscan-mv3-local.md`:

- Content script = thin bridge; **closed Shadow DOM** badges
- `MutationObserver` + `IntersectionObserver` (visible images only)
- `selectionchange` + Range floating chip for text
- Service worker coordinates; inference in offscreen
- Context menu kept as fallback (“Scan … (local signal)”)

### Local models (default badge path — not Desklib)

- **Text (M2):** Transformers.js + `onnx-community/tmr-ai-text-detector-ONNX` (q8), WebGPU → WASM, in the offscreen document
- **Images (M3):** Transformers.js + CLIP ViT-B/32 (`Xenova/clip-vit-base-patch32`), IntersectionObserver visible-only, cache by `src` hash; content script sends an ephemeral canvas data URL when possible
- **Runtime:** ORT WASM vendored under `chrome_plugin/lib/`; model weights download from Hugging Face on first use (browser cache). Popup → **Load local models** to warm up.
- **Fallback:** If a pipeline fails to load, badges fall back to mock local scores (`mode: mock`) so the UX stays up.
- **Not** the default badge path: Desklib (~1.75GB) / Flask CLIP-large — optional power-user desktop stack only

Set `chrome.storage.local.inferenceMode = "mock"` or `forceMock: true` to force heuristics without downloading models.

### Legal / model notes

- LucidScan: Apache-2.0
- Transformers.js: Apache-2.0; TMR ONNX port: MIT
- OpenAI CLIP **code** is MIT; the CLIP **model card** describes deployed use (commercial or not) as **out of scope** pending task-specific testing. This project frames the extension as **local/dev research signal tooling**, not a cleared commercial authenticity product.
- Do **not** scrape, bulk-download, or resell third-party site images. Badge path processes in-tab media ephemerally.

See `docs/lucidscan-mv3-local.md` for the full research pack.

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
- `chrome_plugin/offscreen.html` + `offscreen.js` — local scoring (mock in M1)
- `chrome_plugin/popup.*` — badge toggle, status, About
- `chrome_plugin/test/sample.html` — manual badge smoke page
- `docs/lucidscan-mv3-local.md` — architecture & model guidance
- `expectations.txt` — legacy Flask JSON shape

## Manual done-check

1. `python3 -c 'import json; m=json.load(open("chrome_plugin/manifest.json")); assert m["manifest_version"]==3'`
2. Load unpacked `chrome_plugin/` — service worker should not crash
3. Serve sample page; confirm image pills + selection chip
4. Confirm UI copy has no authenticity claims
5. Popup → **Load local models**; after download, selection chip / image pills show `local score N` with `mode: transformers`
