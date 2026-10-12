# LucidScan launch-readiness checklist

**As of:** 2026-10-07 · **Code:** branch `feat/browse-badges-loadable` (v0.4.0, draft PR #1) · **Scope:** a public Chrome Web Store (CWS) release of `chrome_plugin/`

**Status key:** **Done** · **Partial** · **Not started** · **Blocker** (must be resolved before a public listing)

**Bottom line:** the extension works as a load-unpacked dev build (`npm test` passes: 5/5 unit tests plus `health_check.py`). It is **not ready for a public listing yet**. The main blockers are: the image model's license/model-card terms, no evaluation of any kind, no privacy policy or landing page, no icons or store assets, and permissions that need trimming.

---

## 1. Chrome Web Store listing

### 1.1 Single purpose — **Partial**

Proposed single-purpose statement (for the dashboard's *Single purpose* field):

> LucidScan shows an on-device "local signal" badge on images and selected text, only on websites the user turns it on for, to suggest whether that content may be AI-generated.

- Policy: an extension must have one narrow purpose, and "excessive permissions unrelated to your extension's single purpose will be viewed as enabling unrelated functionalities" ([Quality guidelines FAQ](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq)).
- Risk: the **"Scan this video (optional server)"** context-menu item and the `localhost:5000` host permission belong to a second product, the Python server. A reviewer may see that as outside the single purpose.
- **Next action:** either drop video scan from the store build, or move `http://localhost:5000/*` into `optional_host_permissions` and request it only when the user turns on an "Advanced: local server" toggle. Put the sentence above in the listing description too.

### 1.2 Permission justifications (current `chrome_plugin/manifest.json`) — **Partial**

Reviewers expect a justification for every permission. Unused permissions get rejected under "Purple Potassium" ([Troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting), [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)). The minimum-permission rule applies to optional permissions too ([User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)).

| Manifest entry | Used by (code) | Draft justification | Status / next action |
|---|---|---|---|
| `storage` | `background.js`, `content.js`, `popup.js`: `enabledOrigins`, `pausedOrigins`, `lastScan`, `inferenceMode`, model status | Remembers which sites the user enabled or paused, plus the last scan result. Stored only on the device. | **Done** |
| `contextMenus` | `background.js` `onInstalled`: "Scan selected text / this image (local signal)", "Scan this video (optional server)" | Right-click fallback to score one selection or image on demand. | **Done** (drop the video item if 1.1 goes that way) |
| `scripting` | `registerContentScripts` / `executeScript` / `unregisterContentScripts` | Injects the badge script only into origins the user explicitly enabled. | **Done** |
| `activeTab` | **Not actually needed by current code.** The context-menu handler reads `info.selectionText` / `info.srcUrl` and never touches the tab. The `Alt+Shift+L` command calls `permissions.request` for a persistent grant instead. | (none valid today) | **Blocker-lite**: remove it, or use it for real (e.g. a one-shot "scan this page once" via `executeScript` with no persistent grant). Unused `activeTab` is the first example in Purple Potassium. |
| `offscreen` | `chrome.offscreen.createDocument({reasons:["WORKERS"]})` | Runs the bundled Transformers.js / ONNX Runtime WASM inference outside the service worker, which can't host it. | **Partial**: the code never spawns a Worker (`numThreads = 1`), so the `WORKERS` reason is a loose fit. Either run ORT inside a Worker from the offscreen doc, or explain this in the justification. |
| `optional_host_permissions`: `http://*/*`, `https://*/*` | `popup.js` → `chrome.permissions.request({origins:[thisOrigin]})` on each **Enable** click; revoked on Disable / Clear all | Never granted at install. The user grants one origin at a time by clicking Enable, and Disable revokes it. Needed to show badges on that site's images and selected text. | **Done**: this is the narrowest workable pattern. Say "one site at a time, revocable" in the listing. |
| `host_permissions`: `http://localhost:5000/*` | `background.js` POSTs video URLs to `/detect` | Optional local power-user server for video. | **Partial**: causes an install-time warning. Make it optional, or remove it (see 1.1). |
| `host_permissions`: `https://huggingface.co/*`, `https://*.huggingface.co/*`, `https://cdn-lfs.huggingface.co/*`, `https://cdn-lfs-us-east-1.huggingface.co/*`, `https://cdn-lfs-eu-1.huggingface.co/*`, `https://hf.co/*`, `https://*.hf.co/*` | Transformers.js model download in the offscreen document | First-run model download. | **Partial**: probably **unnecessary**. On 2026-10-07, `curl` with an `Origin: chrome-extension://…` header got `access-control-allow-origin` echoing the extension origin from `huggingface.co`, and `*` from the CDN (`us.aws.cdn.hf.co`, already covered by `*.hf.co`). The `cdn-lfs*` patterns look stale. **Next action:** remove all seven, test a first-run download in real Chrome, and keep only what's proven necessary. That drops the "read and change your data on huggingface.co…" install warning. |
| `commands` (`Alt+Shift+L`) | `chrome.commands.onCommand` | Keyboard shortcut for Enable on this site. | **Done** (not a permission) |
| CSP `'wasm-unsafe-eval'` | ORT WASM compile in `offscreen.html` | Needed to instantiate the bundled ONNX Runtime WebAssembly. No `unsafe-eval`, no remote script. | **Done** |

Also noted: zero `web_accessible_resources`, no static `content_scripts`, no `webNavigation` (all **Done**, enforced by `health_check.py`).

### 1.3 Remote code policy — **Partial (risk flagged)**

- Policy: the MV3 rules require "the full functionality of an extension [to be] easily discernible from its submitted code". External resources "must not contain any logic". Listed violations include "building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data". Fetching "remote resources that are not used to evaluate logic, such as images" is allowed ([MV3 additional requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements), [Blue Argon](https://developer.chrome.com/docs/webstore/troubleshooting)).
- What LucidScan does: **all executable code is bundled.** That covers `lib/transformers.min.js` (Transformers.js 3.8.1), `lib/ort-wasm-simd-threaded.jsep.{mjs,wasm}`, and the extension JS. `offscreen.js` points `env.backends.onnx.wasm.wasmPaths` at `chrome.runtime.getURL("lib/")`, and the extension-page CSP is `script-src 'self'`. **Model weights** (ONNX files, tokenizer, config) are downloaded from Hugging Face as data on first use.
- Assessment: this matches the pattern Hugging Face documents for extensions ([HF blog](https://huggingface.co/blog/transformersjs-chrome-extension)). The policy text never mentions ML models, so acceptability is an inference, not something Google states. I think it's **likely acceptable but not guaranteed.**
  - Risk A: an ONNX file is a computation graph that ORT interprets. A strict reviewer could read it under the "interpreter… fetched as data" clause.
  - Risk B: the model **revision is not pinned**. Transformers.js defaults to `main`, so the model could change after review.
  - Risk C: the vendored bundle still contains a default `https://cdn.jsdelivr.net/npm/@huggingface/transformers@…/dist/` wasm path string. It's overridden at runtime and blocked by CSP, but a static scan could flag it. The bundle also includes the `@huggingface/jinja` template interpreter, which LucidScan doesn't use.
- **Next actions:**
  1. Pin `revision: "<commit sha>"` for both models in `pipeline(...)` (the TMR repo is currently at `b9aa251e…`).
  2. In the dashboard choose "No, I am not using remote code" and explain: "Model weights are downloaded as data from huggingface.co at pinned revisions. All JS/WASM is in the package."
  3. Name both model IDs and revisions in the listing description.
  4. Optional fallback if rejected: bundle the weights. The CWS package limit is 2 GB ([Publish](https://developer.chrome.com/docs/webstore/publish)), so ~300–450 MB fits, but updates get heavy.

### 1.4 Privacy practices tab / data-use certification — **Not started**

- Required for every item: data-type disclosures, Limited Use certification, and a privacy policy URL. Disclosures must match the policy and the actual behavior, or the publisher risks suspension ([Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)). Local-only processing **still has to be disclosed** (User Data FAQ Q3 and Q14).
- Proposed answers:
  - **Website content: yes.** Selected text and on-page images are processed locally.
  - **Web browsing activity: yes, to be conservative.** The list of enabled/paused origins is stored locally.
  - Every other category: no.
  - Certify: not sold, not used for unrelated purposes, not used for creditworthiness.
- **Next action:** fill this in after the privacy policy (§2) is published. Also add a short in-UI disclosure to the popup before the first Enable, e.g. "Runs on this device. First use downloads ~300–450 MB of models from Hugging Face." The prominent-disclosure rule (FAQ Q10) is aimed at off-device collection, but a line in the UI is cheap insurance.

### 1.5 Limited Use — **Not started**

- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) requires an affirmative statement on a site belonging to the extension (homepage or one click away). For example: "The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements."
- LucidScan transfers nothing to its developer, so compliance is easy. The only gap is the statement and the site it lives on. **Next action:** put it in the privacy policy (§2) and link it from the landing page (§4).

### 1.6 Store assets — **Not started**

Requirements from [Supplying images](https://developer.chrome.com/docs/webstore/images):

- **Icon:** 128×128 PNG inside the ZIP (96×96 artwork plus 16 px transparent padding), readable on light and dark backgrounds. The manifest currently has **no `icons` and no `action.default_icon`**, so Chrome shows a generic letter tile. Also needed in the manifest: 16, 32 and 48 px.
- **Screenshots:** at least 1, up to 5, at 1280×800 (or 640×400), full bleed, showing the real UX.
- **Promo tiles:** small 440×280 is **required**. Marquee 1400×560 is optional (needed for featuring).
- Missing icon, screenshots or description is a "Yellow Zinc" rejection ([Troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting)).
- **Next action:** design the icon, then capture screenshots. The demo capture work happening in parallel (`docs/demo/`, `chrome_plugin/scripts/demo_*`) can feed the screenshots. Captions must stick to "local signal" wording, with no accuracy claims (§6).

### 1.7 Developer account — **Not started** (unknown whether Alex has one)

- One-time **$5** registration fee ([Register](https://developer.chrome.com/docs/webstore/register); fee amount per [webstore-docs](https://github.com/GoogleChrome/webstore-docs/blob/master/publish.md)).
- **2-Step Verification required** to publish or update ([2SV policy](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)).
- Verified contact email ([Set up account](https://developer.chrome.com/docs/webstore/set-up-account)).
- **Trader / Non-Trader declaration** (EU DSA). Traders must verify their legal name, address and phone number, and these are shown publicly ([Trader FAQ](https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq)).
- A physical address is required if the item sells features or subscriptions.
- New publishers can publish at most two items at first.
- The account email can't be changed later, so consider a dedicated publishing address.
- **Next action:** Alex creates the account, turns on 2SV, and decides trader status (a paid tier, §5, pushes toward Trader).

---

## 2. Privacy policy — **Not started**

**Facts the policy must reflect (from the code):**

- **Selected text:** when you select 12+ characters on an enabled site, up to 4,000 characters go to the extension's own offscreen document and are scored on-device. They are not stored or transmitted.
- **Images:** visible images on enabled sites are downscaled to at most 512 px into an in-memory canvas data URL and scored on-device. If the canvas is cross-origin tainted, the extension passes the image URL instead, and the offscreen document **fetches that image again from its original host**. That host sees a request from the user's IP.
- **Cache:** image scores are cached in IndexedDB (`lucidscan-cache`): at most 200 entries, 24 h TTL, keyed by a non-cryptographic 32-bit FNV hash of the image src. The cache holds score, label, state and mode only, with no pixels and no plain URL.
- **Settings:** stored in `chrome.storage.local`: enabled/paused origins, last context-menu scan (score and content type), inference mode, and model status. Nothing uses `storage.sync`.
- **Network:** nothing goes to any LucidScan server, because none exists. There is no analytics or telemetry. Console logs avoid URLs (host only).
- **Hugging Face:** the first-run (and cache-miss) model download from huggingface.co / hf.co CDN reveals the user's IP, user agent and the model files requested to Hugging Face and its CDN provider ([HF privacy policy](https://huggingface.co/privacy)).
- **Optional local server:** only if the user runs it. Video URLs are POSTed to `localhost:5000`, and that server then downloads the video itself. All of this stays on the user's machine plus the video host.

**Draft outline Alex can adopt:**

1. **Who we are:** LucidScan, maintained by Alex Stevens. Contact email.
2. **Summary:** LucidScan runs entirely in your browser. We don't collect, sell, or receive your data.
3. **What the extension processes, only on sites you enable:** selected text, visible images (pixels or URL), and per-site settings. Explain on-device inference.
4. **What is stored on your device:** settings plus the score cache (hashed keys, 24 h, at most 200 entries). How to clear it: Disable / Clear all, or remove the extension.
5. **Network requests:** the Hugging Face model download (what HF can see, with a link to its policy); re-fetching some images from their original host; the optional local server.
6. **What we don't do:** no accounts, analytics, ads, sale, or transfer. No human access, because we never receive anything.
7. **Chrome Web Store Limited Use statement** (exact wording from §1.5).
8. **Permissions explained:** a short version of the table in §1.2.
9. **Children:** not directed to children under 13.
10. **Changes and effective date:** version history on the changelog page.
11. **If a paid tier is ever added:** a section on the payment provider (§5). This changes the policy materially.

- **Hosting:** it must live at a **public, working URL** entered in the dashboard's privacy-policy field. Putting the policy only in the description is a "Purple Lithium" rejection ([Troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting)).
- **Next action:** publish it as a page on the landing site (§4). Have someone qualified review it if a paid tier is added.

---

## 3. Model and code licenses

| Component | Where used | License (verified 2026-10-07) | Status |
|---|---|---|---|
| **CLIP ViT-B/32** (`Xenova/clip-vit-base-patch32`, ONNX port of `openai/clip-vit-base-patch32`) | Default image badge path | OpenAI CLIP **code** is MIT ([LICENSE](https://github.com/openai/CLIP/blob/main/LICENSE)). Neither the HF weights repo nor the Xenova port declares a license tag. The model card says: "**Any** deployed use case of the model – whether commercial or not – is currently out of scope" ([HF card](https://huggingface.co/openai/clip-vit-base-patch32), [model-card.md](https://github.com/openai/CLIP/blob/main/model-card.md)). It also limits use to English and says CLIP "was not developed for general model deployment". | **Blocker** for a public / commercial listing |
| TMR detector `Oxidane/tmr-ai-text-detector` + ONNX port `onnx-community/tmr-ai-text-detector-ONNX` | Default text badge path | MIT (both HF cards). Base is RoBERTa-base. Training data is RAID, also MIT ([dataset](https://huggingface.co/datasets/liamdugan/raid)). English only. | **Done** (attribution needed). Its RAID scores are **not** LucidScan's accuracy (§6). |
| Transformers.js 3.8.1 (`@huggingface/transformers`) | Vendored `lib/transformers.min.js` | Apache-2.0 ([LICENSE](https://github.com/huggingface/transformers.js/blob/main/LICENSE)) | **Partial**: the vendored bundle has no license header and the repo ships no copy of its license |
| ONNX Runtime Web | Vendored `lib/ort-wasm-simd-threaded.jsep.*` (also bundled inside transformers.min.js) | MIT ([LICENSE](https://github.com/microsoft/onnxruntime/blob/main/LICENSE)) | **Partial**: the MIT notice must ship with the copy |
| Desklib `desklib/ai-text-detector-v1.01` (DeBERTa-v3-large base) | Optional Flask server only | MIT per the [HF card](https://huggingface.co/desklib/ai-text-detector-v1.01). Its GitHub repo has no license file that GitHub detects. | **Done** for the optional path |
| CLIP ViT-L/14 + `google/vit-large-patch32-224-in21k` | Optional Flask server (`detect.py`) | CLIP-L has the same model-card caveat as above. Google ViT is Apache-2.0. | Same caveat if the server is ever distributed |
| LucidScan repo | All | Apache-2.0 (`LICENSE`). There's **no NOTICE file** and no third-party notices. | **Partial** |

**The key blocker: CLIP's model card.** The MIT code license doesn't cancel the model card's statement that deployed use is out of scope. Shipping CLIP-based badges to the public is exactly a "deployed use", and it wouldn't hold up well if questioned. The extension's About panel already says "local/dev signal tooling only", which is honest but contradicts a store launch.

**Alternatives checked:**

- **OpenCLIP / LAION weights don't fix it by themselves.** `laion/CLIP-ViT-B-32-laion2B-s34B-b79K` and its port `onnx-community/CLIP-ViT-B-32-laion2B-s34B-b79K-ONNX` are MIT-licensed, but their model cards **copy the same "Any deployed use case … out of scope" text** (verified on both cards, 2026-10-07).
- **SigLIP / SigLIP 2 (Google): best drop-in candidate.** `google/siglip-base-patch16-224` and `google/siglip2-base-patch16-224` are **Apache-2.0**, and their cards have no deployed-use exclusion. Transformers.js ports exist (`Xenova/siglip-base-patch16-224`, `onnx-community/siglip2-base-patch16-224-ONNX`). The ports carry no license tag, so treat them as inheriting Apache-2.0 from the base and keep attribution. Still need to verify that zero-shot classification works through the same pipeline, and check sizes.
- **TinyCLIP (Microsoft):** MIT ([Cream LICENSE](https://github.com/microsoft/Cream/blob/main/TinyCLIP/LICENSE)), trained on LAION-400M, ONNX ports exist. Smaller, but read its card for use restrictions before adopting.
- **Purpose-trained classifier (recommended long-term):** a small head (logistic regression or MLP) on frozen SigLIP image embeddings, trained on images Alex has rights to (own generations plus licensed real photos). This fixes the license question **and** the validity question. Zero-shot CLIP with two prompts ("photograph" vs "synthetic…") was never designed or validated as an AI-image detector.

**Next actions:**

1. Decide on the image model (see Decisions).
2. Add `NOTICE` / `THIRD_PARTY_NOTICES.md` and `chrome_plugin/lib/LICENSES/` containing the Apache-2.0 text for Transformers.js and the MIT notice for ONNX Runtime. Apache-2.0 §4 requires a copy of the license and any NOTICE when you redistribute ([Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)).
3. List model IDs, licenses and revisions in the popup's About panel and on the site.

---

## 4. Landing site — **Not started**

- **Minimum pages:** Home (what it is, "local signal, not a verdict", install button); How it works (the 5-line walkthrough plus the diagram from `docs/architecture.md`); **Privacy policy** (§2, including the Limited Use statement); Support / contact (email or GitHub Issues, known limits, how to report a false positive); Changelog (versions and model revisions).
- **Domain:** the fastest and free option is a sub-path of Alex's existing GitHub Pages site (`https://alexnstevens06.github.io/lucidscan/`). A custom domain (~$10–20/yr; availability not checked) looks more trustworthy on a store listing.
- **Hosting options:** GitHub Pages (Alex already uses it), Cloudflare Pages, or Netlify. A static site is enough for a free, local-only product.
- **Existing asset:** Alex's personal-site repo is on tower at `/home/alexn/Documents/code/personal-site`. It's an Astro static site deployed to GitHub Pages from `main` via `.github/workflows/deploy.yml`, so a LucidScan section could be added there. *(Mentioned only; not modified.)*
- **Next action:** pick the domain, then publish privacy + home pages first, since the CWS submission needs the privacy URL.

---

## 5. Subscription / payments model — **Not started (decision needed)**

- **Background:** Chrome Web Store payments and its Licensing API are **deprecated**. New paid items stopped in Sept 2020 and charging ended Feb 1, 2021, so developers must use their own processor and entitlement system ([deprecation notice, official docs source](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/webstore/cws-payments-deprecation/index.md)).
- **The honest point:** a local-only extension costs almost nothing to run (static site plus Hugging Face hosting the weights). Any paid feature needs an **entitlement check**, though. That means a network call to a payment or licensing service, usually a new host permission (ExtensionPay's own FAQ mentions the "read and change your data on extensionpay.com" warning), an email or account, and a **materially different privacy policy and CWS disclosure**. It also means a physical address on the CWS account and probably Trader status. And selling a detector without evaluation creates FTC exposure (§6).

| Option | How | Pros | Cons |
|---|---|---|---|
| **Free + donation** (recommended for v1) | GitHub Sponsors / Ko-fi / Buy Me a Coffee link on the site and in About. No code in the extension. | Keeps the "nothing leaves your device" story intact; no new permissions; fastest review | Little revenue |
| Freemium with paid tier | [ExtensionPay](https://extensionpay.com/) (open-source ExtPay.js, Stripe-backed, 5% fee, subscriptions / one-time / trials); or [Stripe](https://stripe.com/) Checkout / Payment Links plus your own small entitlement endpoint; or [Lemon Squeezy](https://www.lemonsqueezy.com/) (merchant of record, License API; acquired by Stripe in 2024 and, per its [Jan 2026 update](https://www.lemonsqueezy.com/blog/2026-update), moving toward Stripe Managed Payments) | Recurring revenue | Needs a server or third party, new host permission, privacy rewrite, support burden. Paid features must be things that are actually valuable (e.g. batch / video), not accuracy promises. |
| One-time license | License keys via Lemon Squeezy, Gumroad or Paddle, validated online once, then cached | Simple, low ongoing cost | Key-paste UX; still needs an online validation call and privacy disclosure; client-side checks can be bypassed (ExtensionPay's FAQ says the same) |

- Extenshi Pay advertises offline-verifiable signed entitlements, but its own docs say it is not production-launched yet, so it's not recommended now.
- **Next action:** launch free (optionally with a donation link), and revisit a paid tier only after §3 and §6 are resolved.

---

## 6. Claims — **Blocker for any accuracy or detection claim**

**No evaluation of LucidScan has been done.** There's no benchmark, no held-out test set, and no measured precision, recall or false-positive rate for either the text or the image path as shipped (quantized in-browser models, LucidScan's own score mapping, 512 px JPEG re-encode for images). The TMR card's RAID numbers (e.g. AUROC 99.28%) describe a different setup and **can't be reused as LucidScan's accuracy**, and TMR was trained on RAID, so RAID isn't held-out for it. CLIP zero-shot with two prompts has no detector validation at all.

**Why this matters (FTC):**

- In 2025 the FTC finalized an order against Workado (Content at Scale AI), which advertised "98%" accuracy for an AI-content detector. The FTC alleged it was about 53% accurate on general (non-academic) content. Workado is now barred from making efficacy claims without "competent and reliable evidence" ([FTC press release, Aug 28, 2025](https://www.ftc.gov/news-events/news/press-releases/2025/08/ftc-approves-final-order-against-workado-llc-which-misrepresented-accuracy-its-artificial), [case page](https://www.ftc.gov/legal-library/browse/cases-proceedings/2323092-content-scale-ai)).
- In Sept 2024 the FTC ran "Operation AI Comply", a crackdown on deceptive AI claims ([press release](https://www.ftc.gov/news-events/news/press-releases/2024/09/ftc-announces-crackdown-deceptive-ai-claims-schemes)). The FTC's 2023 business-blog post "Keep your AI claims in check" is widely cited, but its ftc.gov URL returned 404 on 2026-10-07. The Workado order is the current, directly on-point reference.

**Required before any claim (listing, site, screenshots, social posts):**

1. **Held-out labeled datasets per modality**, never used in training any shipped model:
   - Text: multiple domains (news, essays, social, code comments), multiple generators, and human text from non-native English writers.
   - Images: real photos plus outputs from current generators, including compressed and resized versions, screenshots, and art.
   - Check each dataset's license.
2. **Evaluate the shipped pipeline exactly:** same quantization, same preprocessing (≤512 px JPEG q0.85, 4,000-char truncation), same score mapping.
3. **Report** precision, recall and **false-positive rate** at the displayed threshold, AUROC and calibration, **sliced by language, domain, text length and image type**. Include confidence intervals.
4. **Document known failure modes:** non-English text (both models are English-centric), short text, edited or paraphrased AI text, heavily compressed images, screenshots, illustrations, and cross-origin images falling back to heuristics.
5. **Keep evidence on file** and publish a short methodology page before making a claim.
6. **Until then:** keep the UI as "local signal / local score N", and keep the existing claim-word scan in `health_check.py`. The store description says "may suggest", never "detects", and no percentages appear anywhere.

**Status:** UI wording **Done** (local signal only). Evaluation **Not started**.

---

## 7. Engineering gaps before public release

| Item | Status | Next action |
|---|---|---|
| Manual **Enable + first-run download** in a real, headed Chrome. Automated CDP smoke stops at "0 badges before Enable" because the permission grant needs a real click. | **Not started** | Run the README's manual done-check on a clean Chrome profile: Enable → grant → badges → models download → `mode: transformers`. Test once on a GPU machine (WebGPU) and once CPU-only (WASM). |
| **First-run download size** is understated. README says "tens of MB" + "~85 MB". Actual HF files: TMR `model_quantized.onnx` ≈ 126 MB; CLIP `model_fp16.onnx` ≈ 304 MB (tried first, including on the WASM fallback) or `model_quantized.onnx` ≈ 154 MB. | **Partial** | Fix the README and popup copy (~280–430 MB). Try q8 first on WASM. For the 2 fixed prompts, precompute text embeddings and download only the vision encoder (`vision_model_quantized.onnx` ≈ 89 MB). |
| Model revisions not pinned | **Not started** | Pass `revision` SHAs in `pipeline()` (§1.3) |
| **Icons** (16/32/48/128) | **Not started** | §1.6 |
| Error telemetry stance | **Done** (stance is "none"). No analytics; logs stay in the local console. | Say "no telemetry" in the privacy policy. Optionally add a "Copy diagnostics" button so users can paste errors into a support email. |
| Extension size | **Done / acceptable**: ~22.6 MB unpacked, of which the ORT WASM is 21.6 MB, far under the 2 GB package limit | Optionally drop the JSEP/WebGPU build if WebGPU is abandoned |
| Unneeded permissions (`activeTab`, HF hosts, localhost) | **Partial** | §1.2 |
| Third-party license notices for vendored `lib/` | **Not started** | §3 |
| SPA history hooks run in the isolated world, so they don't see the page's own `pushState` calls | **Partial** | Works in practice through MutationObserver + popstate/hashchange. Verify on 2–3 real SPAs and either drop the wrappers or document them. |
| Cross-origin images that taint the canvas fall back to URL re-fetch, which often fails CORS and shows heuristics | **Partial** | Measure how often this happens on real sites. Disclose it in the privacy policy (§2). |
| **Video scan depends on the Flask server** (`localhost:5000`). The server uses `CORS(app)` (any origin), `debug=True`, downloads arbitrary URLs, and prints submitted content. While it runs, any website could make it fetch URLs. | **Partial** (fine for dev; unsafe to recommend) | Store build: remove video scan, or gate it behind an optional permission. Server: restrict CORS to the extension origin, turn off debug, and validate URL schemes and hosts. |
| Firefox / Edge | **Not started** (later) | Edge Add-ons takes Chromium MV3 mostly as-is. Firefox has no `chrome.offscreen`, so inference would move to the event page or a worker. Plan for v1.x. |
| Stray `StableGuard` gitlink (submodule entry with no `.gitmodules`) | **Partial** (repo hygiene, not in the store ZIP) | Remove it or add `.gitmodules` |
| Store packaging script (ZIP of `chrome_plugin/` minus `test/`, `scripts/`, `requirements.txt`) | **Not started** | Add `npm run package`. Re-run `health_check.py` on the ZIP contents. |

---

## Blockers

1. **CLIP ViT-B/32 model card:** "any deployed use … out of scope". Swapping to LAION OpenCLIP weights doesn't fix this (same text). Switch to SigLIP/SigLIP 2 (Apache-2.0) or a purpose-trained head before a public listing.
2. **No evaluation at all.** No accuracy or detection claims are possible (FTC Workado precedent). Keep the "local signal" framing until a held-out benchmark exists.
3. **No privacy policy at a public URL, and no Limited Use statement.** The CWS submission can't be completed without them.
4. **No icons, screenshots or small promo tile.**
5. **Permission trim:** remove the unused `activeTab`, test removing the 7 Hugging Face host patterns, and make `localhost:5000` optional or drop it.
6. **Real-Chrome manual test** of Enable + first-run download hasn't been done.

## Decisions for Alex

1. **Image model:** switch to SigLIP / SigLIP 2 zero-shot now, train a small classifier head on SigLIP embeddings, or ship text-only first and add images later?
2. **Video scan in the store build:** drop it, or keep it as an opt-in "local server" feature behind an optional permission?
3. **Business model:** free (+ donation link) for v1, or plan a paid tier? A paid tier means a server or third party, privacy-policy changes, and probably Trader status.
4. **Domain / hosting:** `alexnstevens06.github.io/lucidscan` (free, existing Pages setup) or a custom domain?
5. **Developer account:** which Google account / email publishes, and Trader vs Non-Trader?
6. **Weights:** download from Hugging Face at pinned revisions (smaller package, HF sees the user's IP), or bundle them in the ZIP (~300–450 MB, fully offline, lower remote-code risk)?
7. **Evaluation budget:** who builds the held-out test sets, and what's the bar (e.g. maximum false-positive rate on human text) before any claim is allowed?
