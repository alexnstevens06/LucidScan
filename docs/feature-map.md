# LucidScan feature map (draft PR verification)

Each feature and how to verify it (v0.4.0). Extension root: `chrome_plugin/`.

## Product constraints
| Constraint | Status |
|------------|--------|
| Inject-only after Enable on this site | Yes — no static `content_scripts` |
| First-run HF download (no weight vendoring) | Yes |
| Auto-warmup text on offscreen start | Yes |
| No accuracy claims in UI | Yes — local score / local heuristics |
| CLIP model-card local-dev flag | README + popup About |
| Zero WAR | Yes — enforced by `health_check.py` |
| Per-site pause (not global) | Yes — `pausedOrigins` |
| No `webNavigation` | Yes — history hooks only |
| No `addHostAccessRequest` | Yes |

## User flows
1. Load unpacked `chrome_plugin/` → `./test/serve.sh` → Enable / `Alt+Shift+L`
2. Badges on visible images + selection chip
3. Pause this site / Resume / Disable / Clear all
4. Load / Retry / Cancel load watch for models

## Inference
| Path | Stack |
|------|-------|
| Text | Transformers.js + `onnx-community/tmr-ai-text-detector-ONNX` q8, WebGPU→WASM |
| Images | CLIP ViT-B/32 zero-shot; visible-only; src-hash cache LRU≤200 + 24h TTL |
| Prefilter | Tiny dims, tiny data-URIs, near-flat canvases → local heuristics (not CLIP) |
| Fallback | Mock/heuristic scores when models fail |

## Key files
- `manifest.json` — MV3, optional hosts, commands, no WAR
- `background.js` — register/inject, permissions, commands
- `content.js` — Shadow DOM badges, queues, SPA hooks, prefilters
- `offscreen.js` — Transformers pipelines, IDB cache, progress
- `popup.*` — Enable/Pause/models progress UI
- `test/serve.sh` + `test/sample.html` — http harness

## How to verify
| Feature | Verify |
|---------|--------|
| Manifest policy (MV3, zero WAR, no static content_scripts, no webNavigation/addHostAccessRequest, no vendored weights, claim-word scan) | `npm test` (health_check.py) |
| URL guard, origin pattern, hashing, prefilters, cache LRU 200 / 24h TTL | `npm test` (node:test in `chrome_plugin/test/unit/`) |
| SW starts; 0 badges before Enable | `python3 chrome_plugin/scripts/cdp_smoke.py` |
| Enable → badges on visible images | `./test/serve.sh`, open sample, Enable → 2 pills (24×24 image shows `local heuristics`) |
| Selection chip | select a paragraph, scroll/resize → chip follows; flips below near top |
| Model progress + retry | popup → Models: stage/% text and bar; disconnect network → Retry model load |
| Pause / Resume / Disable / Clear all | popup buttons; badges hide/return/teardown |
| SPA rebinding | on a pushState site, navigate → badges rebind without reload |
| Shortcut | `Alt+Shift+L` on an http(s) tab |
