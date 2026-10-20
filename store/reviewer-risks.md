# Reviewer risks before any Chrome Web Store submission

This list is for a future review of `chrome_plugin/` version 0.4.0. This pull request does not change extension behavior. Nothing here has been submitted.

## Proposal: remove the video item from the store package

The single-purpose statement is:

> LucidScan shows an on-device "local signal" badge on images and selected text, only on websites the user turns it on for, to suggest whether that content may be AI-generated.

The manifest also declares optional host permission `http://localhost:5000/*`. On install, `background.js` creates a context-menu item, "Scan this video (optional server)". Choosing it POSTs the video URL to `http://localhost:5000/detect`. That path uses the optional Flask program in `server.py`, which is a different stack (desktop models, a local HTTP server) from the on-device badge.

A reviewer can treat that as a second purpose. Chrome's quality guidance treats permissions that are unrelated to the single purpose as a problem, and the minimum-permission rule applies to optional host permissions too. The pattern is optional, so it does not warn at install, but it is still part of the item a reviewer reads. The menu item is created for every install, not only after an extra opt-in.

**Recommendation: remove it from the store package before submission.**

- Drop the `scan-video` context menu, the `fetch` to `http://localhost:5000/detect`, and `http://localhost:5000/*`.
- Keep `server.py`, `detect.py`, and `text_detection.py` in the repository for local development, and leave them out of the store ZIP.
- Text and image right-click items stay. They use the same on-device models as the badges, so `contextMenus` remains justified.

**Alternative, if one package must keep the power-user path: gate it.**

- Default off. Do not create the video menu item in `onInstalled`.
- Add an explicit control, such as "Use a local server for video", that is off until the user turns it on.
- Only then create the menu item and call `chrome.permissions.request` for `http://localhost:5000/*`.
- This still leaves a second purpose in the submitted code, so it is the weaker option.

**Not in this pull request.** Either change would alter the extension. The listing text describes the item so it matches the code that exists today, and it says to delete that paragraph if the item is removed.

If the item stays, the local server is a poor fit for a store audience as it stands: `server.py` calls `CORS(app)` and `app.run(port=5000, debug=True)`, and it downloads the URL it is given. Hardening that server would also be a behavior change, so it is out of scope here.

## Other risks

1. **CLIP model card.** Image badges use `Xenova/clip-vit-base-patch32`, an ONNX port of OpenAI CLIP ViT-B/32. The CLIP model card says any deployed use, commercial or not, is out of scope. A public listing is a deployed use. The popup About panel already calls this local/dev signal tooling. Do not submit until the image model changes or a qualified decision accepts the card. The launch notes suggest SigLIP / SigLIP 2 or a purpose-trained head, or shipping text-only first. This pull request does not switch models.

2. **No evaluation.** There is no held-out measurement of the shipped pipelines. Listing, site, and screenshot captions must not state accuracy, a detection rate, latency, or a real-time capability. Say "may suggest". The badge is a signal, not a verdict. The TMR model's published figures describe a different setup and are not LucidScan's results.

3. **Remote ONNX weights.** JavaScript and WebAssembly are bundled (`lib/transformers.min.js`, `lib/ort-wasm-simd-threaded.jsep.*`). Weights download from Hugging Face at pinned revisions in `offscreen.js` (`b9aa251e5bcda7e429fcc936767d921435945b60` and `d15189d7028b43f1d3e65039190477f6af591c2a`). A strict reading of the MV3 remote-code rule could still treat an ONNX graph as logic fetched as data. Prepare the "no remote code" explanation in `listing.md`, and be ready to bundle weights if a reviewer rejects the download. The vendored Transformers.js bundle still contains a jsDelivr path string (overridden at runtime and blocked by CSP) and a Jinja interpreter the badge path does not use.

4. **`offscreen` reason `WORKERS`.** `createDocument` uses `reasons: ["WORKERS"]`. `offscreen.js` sets `numThreads = 1` and does not spawn a worker, because the extension CSP blocks blob workers. Explain that in the justification. A later change could run ONNX Runtime in a real worker, or document the reason in more detail. Not changed here.

5. **Broad optional patterns.** `http://*/*` and `https://*/*` are requested one origin at a time and removed on Disable / Clear all. Reviewers still see the broad patterns. The justification has to say "one site at a time, revocable" and the code has to keep doing that.

6. **`activeTab` is in use.** It exists so the popup and Alt+Shift+L can read `tab.url` without the broader `tabs` permission. Removing it as "unused" would break Enable.

7. **Menu titles say "Scan".** The titles also say "(local signal)". A later copy change could rename them so they match "may suggest" more closely. That would be a user-visible change, so it is not in this pull request.

8. **Privacy policy has no public URL yet.** The policy text is in `store/privacy-policy.md` and `site/privacy.html`. A submission needs a working public URL. This pull request does not deploy the site.

9. **Icons are not in the manifest.** `store/assets/` has the 128px icon and the 440×280 promo tile. `manifest.json` has no `icons` or `action.default_icon`, so an unpacked build still shows Chrome's generic tile. Wiring icons in, and adding 16, 32, and 48px sizes, would change how the extension looks. Left for a follow-up.

10. **Third-party notices.** Transformers.js is Apache-2.0 and ONNX Runtime is MIT. Copies of those notices are not under `chrome_plugin/lib/`. Add them before redistributing a store ZIP. Not a runtime change.

11. **Screenshots.** Do not upload `docs/demo/*.png` as store screenshots. Those captures are about 1279×712 inside a 1280×800 window, they come from a throwaway manifest that adds install-time host permissions, and some ordinary photographs received high scores that are easy to misread. The shot list is `store/screenshot-plan.md`. This pull request does not add fabricated screenshots.

12. **Developer account.** Publishing needs a Chrome Web Store account, the registration fee, 2-Step Verification, and a trader or non-trader declaration. Those are account decisions, not code.

## Open questions

1. Remove the video item from the store package (recommended), or gate it?
2. Image model: keep CLIP ViT-B/32, switch to SigLIP / SigLIP 2, or ship text-only first?
3. Where should the privacy page live once it is deployed? A public URL is required before submission. This pull request does not deploy.
4. Which Google account publishes, and is the publisher a trader or a non-trader?
5. Store screenshots: manual Enable on an unmodified load-unpacked build (recommended), using `chrome_plugin/scripts/demo_capture.py` only as the shot list?
6. Is version 1 free? The draft policy has no payment processor. A paid tier would change the policy and the disclosures.
7. Is GitHub Issues the public contact, or is there an email address that should be on the privacy page? None was invented here.
