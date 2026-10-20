# LucidScan — Chrome Web Store listing (draft)

Draft materials only. Nothing in this folder has been submitted, and LucidScan is not in the Chrome Web Store.

Permissions below were read from `chrome_plugin/manifest.json` at version **0.4.0**. There is no `host_permissions` key. Host access is declared only under `optional_host_permissions`.

```json
"permissions": ["storage", "contextMenus", "scripting", "activeTab", "offscreen"],
"optional_host_permissions": ["http://*/*", "https://*/*", "http://localhost:5000/*"]
```

The video item and `http://localhost:5000/*` are still in that manifest. The paste-ready description mentions them so the text matches the code. Remove that paragraph before submission if the item is dropped. See [reviewer-risks.md](reviewer-risks.md).

## Name

LucidScan

## Short description

132 characters maximum.

> On-device local signal badges for images and selected text, only on sites you turn on. A signal, not a verdict.

Character count: **111**.

## Category

**Productivity.**

Chosen because the item is a per-site browsing aid. The dashboard category enum also includes Accessibility, Blogging, Developer Tools, Fun, News & Weather, Photos, Search Tools, Shopping, Social & Communication, and Sports. Photos is narrower than the text badge. Developer Tools would match the local-dev framing in the popup, and it is the alternative if the image-model question keeps this out of a general listing.

## Single purpose

Paste this into the dashboard Single purpose field:

> LucidScan shows an on-device "local signal" badge on images and selected text, only on websites the user turns it on for, to suggest whether that content may be AI-generated.

## Detailed description

Paste the block below only after the reviewer notes are resolved. While `Scan this video (optional server)` remains in the package, keep the paragraph that describes it. If that item is removed, delete that paragraph so the listing stays the same shape as the code.

---

LucidScan shows a small badge on images and on text you select. Scoring runs on your device, and only on websites you turn on.

The badge is a local signal. It may suggest whether that content may be AI-generated. It is a signal, not a verdict.

You turn a site on with Enable badges on this site, or with Alt+Shift+L, and then allow that site. On an enabled site, a visible image can show a corner badge. Selecting at least 12 characters can show a floating chip. Pause hides badges and keeps the site on your list. Disable removes that site. Clear all enabled sites resets the list.

A site stays untouched until you turn it on. The extension asks for each site when you enable it.

A badge can read:

- "local score" and a number, an uncalibrated signal from the on-device model
- "loading model…" or "downloading model", while weights are still downloading
- "unavailable", when a score cannot be produced. The badge stays on unavailable instead of showing a stand-in number

A right-click menu can ask for a local signal on selected text or on one image.

Scoring uses Transformers.js 3.8.1 in an offscreen document. The runtime tries WebGPU, then WASM. The first use downloads model weights from Hugging Face (about 435 MB). Later runs use the browser cache. Revisions are pinned:

- Text: onnx-community/tmr-ai-text-detector-ONNX (q8), revision b9aa251e5bcda7e429fcc936767d921435945b60
- Images: Xenova/clip-vit-base-patch32 (fp16, with a quantized fallback), revision d15189d7028b43f1d3e65039190477f6af591c2a

The CLIP model card describes deployed use as out of scope pending task-specific testing. Treat the image badge as local signal tooling.

The package also includes a right-click item titled "Scan this video (optional server)". Using that item sends the video address to a program on your computer at http://localhost:5000. Ordinary badges do not use that program.

The list of enabled sites and a 24-hour cache of image scores stay on your device. The privacy policy describes the Hugging Face download and the optional local program.

---

## Permission justifications

Each entry is a paste-ready justification for the current manifest. Code references are for maintainers; the quoted paragraph is the part to give a reviewer.

### `storage`

Used by `background.js`, `popup.js`, and `content.js` through `chrome.storage.local` only. Nothing uses `storage.sync`.

Keys written or read in the extension scripts: `enabledOrigins`, `pausedOrigins`, `lastScan`, `inferenceMode`, `forceMock`, `autoWarmup`, `_migratedInferenceMode`.

> Stores, on this device only, the sites the user has enabled or paused, the latest right-click result (a score label, not the page text), and local settings for on-device scoring. Nothing is synced and nothing is sent to the developer.

### `contextMenus`

Created in `background.js` on install: "Scan selected text (local signal)", "Scan this image (local signal)", and "Scan this video (optional server)".

> Adds right-click items so the user can ask for an on-device local signal on selected text or one image. The current package also adds an optional video item that talks to a program on the user's own computer. That video item is proposed for removal before submission because it sits outside the single purpose.

### `scripting`

`background.js` calls `scripting.registerContentScripts`, `scripting.unregisterContentScripts`, and `scripting.executeScript`. The manifest has no `content_scripts` array.

> Injects the badge script only into origins the user has turned on, and removes it when they disable the site. The extension does not register a content script for all sites.

### `activeTab`

`popup.js` reads `tab.url` from `chrome.tabs.query` when the user opens the popup. `background.js` reads the active tab URL for the `Alt+Shift+L` command and when it tears badges down. Without a host grant or the `tabs` permission, Chrome hides `tab.url`. Opening the popup or using the command grants `activeTab` for that tab.

> Reads the current tab's URL when the user opens LucidScan or presses Alt+Shift+L, so the extension can ask for that one site. This is narrower than the tabs permission.

### `offscreen`

`background.js` calls `chrome.offscreen.createDocument` with `reasons: ["WORKERS"]` and the justification string "Run local signal scoring for browse-time badges without blocking the service worker." `offscreen.js` sets `env.backends.onnx.wasm.numThreads = 1` because the extension page CSP blocks blob workers.

> Runs Transformers.js and ONNX Runtime in an offscreen document so on-device scoring stays off the service worker. The declared reason is WORKERS. ONNX Runtime is pinned to one thread because this extension's page policy blocks blob workers, so the WORKERS reason is a loose fit and is explained in the reviewer notes.

### `optional_host_permissions`: `http://*/*` and `https://*/*`

Requested one origin at a time from the popup Enable button (`popup.js`) and from the `enable-badges-this-site` command (`background.js`). Disable and Clear all call `chrome.permissions.remove` for those origins. They are not granted at install.

> Not granted at install. The user allows one website at a time by choosing Enable badges on this site or pressing Alt+Shift+L. Disable and Clear all remove that site. The broad pattern is what makes a single-site request possible. The extension does not ask for every site at once.

### `optional_host_permissions`: `http://localhost:5000/*`

`background.js` POSTs to `http://localhost:5000/detect` only from the video context-menu handler. The pattern is optional, so it is not granted at install. The request still needs the permission at the moment it runs; the current handler does not call `permissions.request` itself.

> Not granted at install. Used only if the user chooses the right-click item "Scan this video (optional server)", which sends a video address to http://localhost:5000 on the user's computer. Ordinary image and text badges do not use it. Proposed for removal before submission because it is outside the single purpose.

### `host_permissions`

The key is absent. `health_check.py` fails the build if it is added. Model downloads from Hugging Face are not given a host permission; they rely on the model host's CORS headers.

### Related manifest fields (not permissions)

- `commands.enable-badges-this-site` (`Alt+Shift+L`): keyboard shortcut that enables badges on the current site. Not a permission.
- `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. `'wasm-unsafe-eval'` lets the bundled ONNX Runtime WebAssembly compile. There is no remote script and no `'unsafe-eval'`.
- `web_accessible_resources`: absent.
- `content_scripts`: absent.
- `icons` and `action.default_icon`: absent. Store art is in `store/assets/` and is not wired into the manifest in this draft, so the unpacked extension's appearance stays as it is.

## Privacy dashboard (draft answers)

Fill these in only after a public privacy-policy URL exists. They match [privacy-policy.md](privacy-policy.md) and the code.

| Data type | Disclose? | Why |
|---|---|---|
| Website content | Yes | Selected text and on-page images are processed on the device. |
| Web browsing activity | Yes | The list of enabled and paused origins is stored on the device. |
| Personally identifiable information | No | No account and no name or email collection. |
| Health, financial, authentication, personal communications, location, user activity (other than the enabled-site list) | No | Not collected. |

Certification to prepare: data is not sold, not used for purposes unrelated to the single purpose, and not used to determine creditworthiness.

Limited Use statement (also on the privacy page):

> The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

Remote code question to prepare, if the weights stay a download: "No, I am not using remote code." Explanation to pair with it: JavaScript and WebAssembly are in the package. Model weights are downloaded as data from huggingface.co at the pinned revisions named above. Acceptability of an ONNX graph under the remote-code rule is a reviewer risk, not a settled answer.

## Assets in this folder

| File | Role |
|---|---|
| `assets/icon-128.svg` and `assets/icon-128.png` | 128×128 icon. 96×96 artwork with 16px transparent padding. |
| `assets/promo-440x280.svg` and `assets/promo-440x280.png` | Required small promo tile. A graphic, not a screenshot. |
| [screenshot-plan.md](screenshot-plan.md) | How to capture 1280×800 screenshots from real UI. No screenshot files are included, because none at that size exist yet. |
