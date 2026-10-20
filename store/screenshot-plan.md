# Screenshot plan (1280×800)

Draft only. This folder does not contain store screenshots. The PNGs under `docs/demo/` are development captures, not store assets.

## What to capture

Chrome Web Store screenshots are 1280×800 or 640×400, full bleed, at least one and at most five. Use **1280×800**.

The harness is `chrome_plugin/scripts/demo_capture.py`. It opens a 1280×800 window (`W, H = 1280, 800`) and saves `Page.captureScreenshot` PNGs. The notes in `docs/demo/README.md` say an earlier run's viewport was about 1279×712 because of browser chrome inside that window. Before upload, check every file:

```bash
python3 -c "from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(im.size)" path/to/shot.png
```

The bitmap itself must be 1280×800. If the page viewport is shorter, increase the window until the captured bitmap matches, and do not letterbox.

`demo_capture.py` is a test harness. It copies the extension outside the repo, adds install-time `host_permissions` for a few demo origins, and renames that copy. The real manifest is not modified. Prefer a **manual Enable** on an unmodified load-unpacked `chrome_plugin/` for any file that will be uploaded, so the shot matches the package a reviewer sees. Use the script for the page list, the 1280×800 frame, and a reminder of which UI states exist.

Captions stay with the files. They may say "may suggest" and "local signal". They must not state accuracy, a detection rate, latency, or a real-time capability. If a badge shows a number, the caption calls that number that run's local signal.

## Shots that match the product

Take these, in this order. Skip a row if it cannot be captured from the real UI.

| # | Size | How | What the real UI shows | Caption to store with the file |
|---|---|---|---|---|
| 1 | 1280×800 | Manual Enable on the sample page (`chrome_plugin/test/serve.sh`, then Enable badges on this site). `demo_capture.py` key `sample` is the reference for framing. | Corner badges on the visible sample images. The 24×24 image is too small to badge. | After you enable the sample page, visible images can show a local-signal badge. |
| 2 | 1280×800 | Same page, with the first paragraph selected. The script's `chip=True` path is the reference. | The floating chip on the selection. | Selecting text on an enabled site can show a floating local-signal chip. |
| 3 | 1280×800 | Manual. `demo_capture.py` does not shoot the popup. | The popup on that site: site state, Enable or Pause, and the enabled-site list. | You turn badges on for one site at a time. Pause hides them. Disable removes the site. |
| 4 | 1280×800 | Manual, only during a real model load or after models have finished. | The popup Models section with the status text the popup actually renders (stage, progress, or ready). | The first run downloads model weights from Hugging Face. The popup shows that progress. |
| 5 | — | Do not shoot. | — | — |

Shot 4 is optional. Four images are enough. One is the minimum if time is short; shot 1 is the one to keep.

## Do not include

These are not store screenshots:

- **Video / localhost.** No capture of "Scan this video (optional server)" exists, and that item is proposed for removal. Do not mock the menu.
- **Wikipedia, Commons, or NASA pages.** `demo_capture.py` can open them, and `docs/demo/` has development frames from that harness. They are third-party pages. The demo notes also say ordinary photographs, including NASA images, can receive high local scores. That is easy to misread on a listing.
- **Accuracy charts, comparison tables, or a rate.** They do not exist.
- **A store badge, an "Add to Chrome" button, or an install confirmation.** The item is not published.
- **A WebGPU settings screen.** The runtime tries WebGPU, then WASM. There is no separate control to photograph.
- **Invented scores.** The graphic in `store/assets/promo-440x280.svg` is a promo tile. It is not a screenshot and must not be uploaded as one.

`docs/demo/01-sample-badges.png` and `docs/demo/01-sample-text-chip.png` are useful as a content check: they show the sample-page pills and the text chip from a real model run. They are the wrong size and the wrong manifest for the store.
