# LucidScan demo captures (test-only harness)

Screenshots of the v0.4.0 extension (branch `feat/browse-badges-loadable`) with real on-device model scores,
captured on tower on 2026-10-07 by `chrome_plugin/scripts/demo_capture.py`.

Badges are a **local signal only** (uncalibrated on-device model output), **not** an authenticity verdict.
The numbers below are what the models produced on that run. They are not accuracy claims. For example, CLIP
gives several real NASA astrophotographs scores in the high 90s.

## How the "Enable badges on this site" grant was stood in for

The real product injects nothing until the user clicks **Enable badges on this site**. That click calls
`chrome.permissions.request()`, which needs a real user gesture, so automation can't press it. For these captures:

1. The script copies `chrome_plugin/` to a throwaway folder **outside the repo** (`/tmp/lucidscan-demo-ext`) and edits
   **only that copy's manifest**. It appends these demo origins to `host_permissions` (granted at install, no prompt):
   `http://localhost/*`, `http://127.0.0.1/*`, `https://en.wikipedia.org/*`, `https://commons.wikimedia.org/*`,
   `https://www.nasa.gov/*`, and renames the extension to "LucidScan (demo test build)". No JS is changed. The real
   `chrome_plugin/manifest.json` is not modified.
2. The copy is loaded with CDP `Extensions.loadUnpacked` (Chrome 154 with `--enable-unsafe-extension-debugging`)
   into a fresh temporary profile.
3. Over CDP `Runtime.evaluate` on the extension **service worker**, the script calls
   `activateBadgesForOrigin("<origin>/*", null)` for each demo origin. The popup's Enable path calls this same function
   after `permissions.request()` succeeds. Its `permissions.contains()` check passes because of step 1. It then
   stores the origin and calls `scripting.registerContentScripts`, the same as after a real click.

So everything after the permission prompt is the unmodified product code path. Only the prompt itself is replaced by
install-time host permissions in a test copy.

## Models

Both pipelines loaded for real from Hugging Face on a fresh profile in about 30 s: text
`onnx-community/tmr-ai-text-detector-ONNX` (q8) and image `Xenova/clip-vit-base-patch32` (fp16). Both used the
**WASM** backend because Xvfb has no WebGPU adapter. The script warms them first with the same `offscreen.warmup`
message the popup's **Load local models** button sends, then waits for `ready`. Every badge here is a `local score N`
from the models. The `local heuristics` fallback did not appear on any captured page.

## Captures

The viewport is about 1279×712 (headed Chrome 154 in a 1280×800 window under Xvfb), captured with CDP
`Page.captureScreenshot` and then compressed with pngquant. Pages were only viewed. No site images were downloaded or
stored separately.

| File | Page | Shows |
|------|------|-------|
| `01-sample-badges.png` | `http://localhost:8771/test/sample.html` (repo sample page) | Two image pills: `local score 53` and `local score 28`. The 24×24 image is too small to badge. |
| `01-sample-text-chip.png` | same | First paragraph selected (Range + `selectionchange`). Text chip reads `local score 98`. |
| `02-wikipedia-badges.png` | https://en.wikipedia.org/wiki/Yosemite_National_Park | Infobox photo `local score 36` and locator map `local score 99`. |
| `02-wikipedia-text-chip.png` | same | Lead paragraph selected. Chip reads `local score 94`. |
| `03-commons-badges.png` | https://commons.wikimedia.org/wiki/Commons:Featured_pictures/Places/Natural | Featured-picture gallery, one pill per visible thumbnail (scores 22–65 in view). |
| `04-nasa-badges.png` | https://www.nasa.gov/image-of-the-day/ | Image-of-the-day grid with pills on every visible card (scores 52–99 in view). |

The Wikipedia view starts at the article title, so a CentralNotice campaign banner, when one shows, sits above the
viewport.

### Screen recording (not committed: `*.mp4` is gitignored)

`lucidscan-demo.mp4`: about 23 s, 1280×800, H.264 yuv420p, about 1.3 MB, recorded with ffmpeg `x11grab` from Xvfb.
It loads https://en.wikipedia.org/wiki/Grand_Canyon, shows the infobox badge, smooth-scrolls while new images get
`local score` pills, then selects a paragraph and the chip appears (`local score 98`). It is kept on tower at
`/home/bot/LucidScan-demo/lucidscan-demo.mp4`, with `lucidscan-demo.gif` (720 px, 8 fps, about 3 MB) next to it.

## Re-run

```bash
# tower: google-chrome, Xvfb, ffmpeg, pngquant, python3 websocket-client + Pillow
python3 chrome_plugin/scripts/demo_capture.py            # writes docs/demo/*.png, raw + MP4 under /home/bot/LucidScan-demo
python3 chrome_plugin/scripts/demo_capture.py --only sample,wikipedia --no-video
```

The script reads badge text only through CDP `DOM.describeNode(pierce: true)`, because the closed Shadow DOM hides it
from page JS. It uses that text to know when scores have painted. Check the PNGs by eye as well. It kills only the
Xvfb, Chrome, and ffmpeg processes it started.

Note: these captures needed fix `c5682ce`. Before it, `scoreViaOffscreen` let the content message's
`type: "scoreImage"` override `offscreen.scoreImage`, and every badge and chip stayed on `pending`.
