# LucidScan feature map (draft PR verification)

Short map for Millwright / Progenitor checks. Extension root: `chrome_plugin/`.

## Product constraints
| Constraint | Status |
|------------|--------|
| Inject-only after Enable on this site | Yes — no static `content_scripts` |
| First-run HF download (no weight vendoring) | Yes |
| Auto-warmup text on offscreen start | Yes |
| No accuracy claims in UI | Yes — local score / local heuristics |
| CLIP model-card local-dev flag | README + popup About |
| Zero WAR | Yes (v0.3.3+) |
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
