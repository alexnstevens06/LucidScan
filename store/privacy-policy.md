# LucidScan privacy policy

**Effective:** 20 October 2026
**Extension version described:** 0.4.0 (`chrome_plugin/`)
**Status:** Draft for a future public page. This file is not deployed, and LucidScan is not in the Chrome Web Store.

The same text is on the static page `site/privacy.html`.

## Who we are

LucidScan is maintained by Alex Stevens. The source repository is [github.com/alexnstevens06/LucidScan](https://github.com/alexnstevens06/LucidScan). Questions and reports go to [GitHub issues](https://github.com/alexnstevens06/LucidScan/issues). There is no LucidScan account and no LucidScan server.

## Summary

LucidScan scores images and text you select on your own device, and only on websites you turn on. The maintainer does not receive that content. The badge is a local signal. It may suggest whether content may be AI-generated. It is a signal, not a verdict.

## What the extension processes

Processing starts only after you enable a site (Enable badges on this site, or Alt+Shift+L) and allow that site.

**Selected text.** When you select at least 12 characters on an enabled site, up to 4,000 characters are sent to the extension's own offscreen document and scored on the device. That text is not written into the score cache and is not sent to the maintainer.

**Images.** Visible images on an enabled site are drawn to an in-memory canvas and downscaled so the longest side is at most 512 pixels, then scored on the device. The score cache does not store pixels.

**Cross-origin images.** If the canvas is tainted because the image is cross-origin and the page did not grant a usable read, the offscreen document may request that image's URL again from the site that hosts it. That host can see a request from your IP address. The request omits credentials. If the request fails, the badge shows "unavailable".

**Settings you choose.** The extension remembers which sites you enabled or paused.

**Right-click.** A right-click on selected text or an image asks for the same on-device score. The result stored afterward is the score label, not the text or the image.

## What is stored on your device

### Enabled-site list and other settings (`chrome.storage.local`)

Stored only on the device. `storage.sync` is not used.

| Key | What it holds |
|---|---|
| `enabledOrigins` | Sites you turned on, as origin patterns. |
| `pausedOrigins` | Sites where you paused badges. |
| `lastScan` | The latest right-click result: a score if one was produced, a label, the content type (text, image, or video), and the mode. It does not hold the selected text, the image, or the video address. |
| `inferenceMode`, `forceMock`, `autoWarmup` | Local switches for on-device scoring. |
| `_migratedInferenceMode` | A one-time flag so an older local setting is not applied twice. |

Disable and Clear all enabled sites update the enabled-site list and drop the host permission for those sites. They do not delete the score cache or `lastScan`. Pause updates `pausedOrigins`.

### 24-hour local score cache (IndexedDB)

Database name `lucidscan-cache`, object store `imageScores`.

- At most 200 entries. Older entries are dropped when the cap is passed.
- Each entry expires 24 hours after it was written.
- The key is a non-cryptographic 32-bit FNV-1a hash of the image address (or of the canvas data if there is no address). The plain URL is not stored.
- The value is the score, label, state, mode, and a timestamp.
- No pixels and no page text.

A memory cache holds the same kind of rows until the offscreen document closes.

There is no button that deletes this database. Rows expire after 24 hours. Removing LucidScan removes the extension's local storage, this database, and the browser cache of downloaded model files.

## What is transmitted

**Model download from Hugging Face.** The first time a model is needed, and whenever the browser cache misses, the extension downloads model files from huggingface.co and Hugging Face's CDN. Hugging Face can see your IP address, user agent, and which files were requested. Their policy is at <https://huggingface.co/privacy>. The files are data (weights, tokenizer, and config). JavaScript and WebAssembly ship inside the extension package.

Pinned revisions in this version:

- Text: `onnx-community/tmr-ai-text-detector-ONNX` at `b9aa251e5bcda7e429fcc936767d921435945b60` (q8), about 129 MB with its tokenizer and config.
- Images: `Xenova/clip-vit-base-patch32` at `d15189d7028b43f1d3e65039190477f6af591c2a` (fp16), about 306 MB with its tokenizer and config.
- Together, about 435 MB on a first run. If fp16 fails, a smaller quantized image file may be fetched as well.

**Badge path.** On the path that paints badges, page text and image pixels are not sent to the maintainer. There is no analytics, no telemetry, and no LucidScan server on that path.

**Image re-fetch.** Only the cross-origin fallback described above, and only to the host that already served the image.

**Optional localhost server.** Only if you use the right-click item "Scan this video (optional server)". The extension then POSTs the video address to `http://localhost:5000/detect` on your computer. If you are running that program, it receives the address and may download the video itself. That exchange stays on your machine and the video's host. The maintainer does not receive it. The host permission is optional and is not granted at install. If you never use the item, the extension does not make that request. This item is called out as a reviewer risk and is proposed for removal before a public submission.

## What we do not do

We do not sell data, show ads, or use data to determine creditworthiness. We do not review your pages, because we do not receive them. We do not run a payment or account system in this version.

## Chrome Web Store Limited Use

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Permissions, in short

| Manifest entry | Role |
|---|---|
| `storage` | The on-device settings and last right-click result above. |
| `contextMenus` | Right-click local signal for text or an image, plus the optional video item. |
| `scripting` | Injects the badge script only on sites you enabled. |
| `activeTab` | Reads the current tab's URL when you open the popup or use Alt+Shift+L, so it can ask for that one site. |
| `offscreen` | Runs on-device scoring outside the service worker. |
| `http://*/*` and `https://*/*` (optional) | Granted one site at a time when you enable it. Removed when you disable it. |
| `http://localhost:5000/*` (optional) | The optional local video program. Not granted at install. |

There is no required `host_permissions` entry.

## Children

LucidScan is not directed to children under 13.

## Changes

This version describes extension 0.4.0 as of 20 October 2026. When the policy changes, the date at the top of this file and of `site/privacy.html` will change with it. A public URL is required before a Chrome Web Store submission. Publishing that URL is a separate step; this draft does not deploy it.
