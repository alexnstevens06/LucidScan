# LucidScan MV3 Permissions + CSP Research Pack

**For:** Millwright via Progenitor  
**Topic:** Chrome MV3 `optional_host_permissions` UX + CSP / iframe pitfalls for on-page badges  
**Companion:** `/workspace/research-packs/lucidscan-mv3-local.md` (Shadow DOM badges + MutationObserver + selection chip)  
**Date:** 2026-10-06 (America/Chicago)  
**Goal framing:** always-on browse-time **signal badges** where the user opts in; `activeTab` as gesture-only fallback. No accuracy claims; no scraping/reselling third-party images.

---

## Executive summary (for Millwright)

- Prefer **`optional_host_permissions: ["https://*/*","http://*/*"]` + runtime `chrome.permissions.request({ origins })`**, not required `host_permissions` / static `content_scripts.matches` for all sites — avoids install-time “read and change your data” warnings and eases CWS review.
- Prompt for hosts **in Settings (“Always-on badges”) or a first-use chip CTA**, never as a surprise at install; call `request()` **synchronously inside a user gesture** (no `await` before it). Use `contains()` to gate UI; `remove()` for revoke; listen to `onAdded`/`onRemoved`.
- **`optional_permissions`** = API names (`scripting`, `tabs`, …); **`optional_host_permissions`** = origin patterns. Request hosts via `origins:`, APIs via `permissions:`.
- **`activeTab` + `scripting`** = zero install warning, temporary access after action/context-menu/command — fine for one-shot badges, **not** for SPA MutationObserver always-on.
- Isolated-world content scripts are **not** subject to the **page** CSP; `world: "MAIN"` **is**. Prefer closed Shadow DOM + **inline SVG / CSS** (no WAR) so badges keep working when pages restrict styles/scripts.
- Cross-origin iframes need their **own** match + host grant; `all_frames: true` only if product needs in-frame images. `about:`/`data:`/`blob:` need `match_origin_as_fallback` / `match_about_blank`. No inject into `chrome-error://` / restricted pages.
- Declare **minimal** `web_accessible_resources` (or none): WAR enables fingerprinting. Prefer messaging bitmaps/text to SW/offscreen over loading models/fonts into the page.
- Sites can strip host nodes (anti-extension); closed shadow helps CSS isolation **not** DOM permanence — re-attach with backoff, degrade to toolbar/`activeTab`, don’t fight banking/anti-fraud pages.

---

## 1) `optional_host_permissions` UX patterns

### 1.1 Manifest shape (MV3)

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "scripting", "storage", "contextMenus"],
  "optional_permissions": [],
  "optional_host_permissions": [
    "https://*/*",
    "http://*/*"
  ],
  "host_permissions": [],
  "content_scripts": []
}
```

| Key | When granted | Install warning? | Use for LucidScan |
|-----|--------------|------------------|-------------------|
| `permissions` (API) | Install | Only if API has a warning | `activeTab`, `storage`, `contextMenus`, `scripting` |
| `optional_permissions` | Runtime `request({ permissions })` | No at install; prompt if new warning | Extra APIs if ever needed |
| `host_permissions` | Install / update | Yes for broad patterns | Avoid for v1 always-on |
| `optional_host_permissions` | Runtime `request({ origins })` | No at install | **Preferred** for badge mode |
| `content_scripts.matches` | Install (auto-inject) | Yes (same class as hosts) | Prefer **dynamic** `scripting.registerContentScripts` after grant |
| `activeTab` | User gesture on current tab | **None** | Gesture-only / fallback path |

Official:

- Declare permissions: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions  
- Permissions API: https://developer.chrome.com/docs/extensions/reference/api/permissions  
- Permission warnings: https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings  
- Privacy / optional / activeTab: https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy  
- activeTab: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab  

### 1.2 Runtime request / contains / revoke

```js
// MUST run inside a user gesture (click/keydown). Do not await anything BEFORE request().
async function enableBadgesForOrigin(origin /* e.g. "https://news.example" */) {
  const origins = [`${origin}/*`];
  if (await chrome.permissions.contains({ origins })) {
    await ensureContentScript(origins);
    return true;
  }
  const granted = await chrome.permissions.request({ origins });
  if (granted) await ensureContentScript(origins);
  return granted;
}

async function revokeBadgesForOrigin(origin) {
  await chrome.permissions.remove({ origins: [`${origin}/*`] });
  // Then unregister matching dynamic content scripts.
}

chrome.permissions.onAdded.addListener((p) => { /* refresh options UI / register scripts */ });
chrome.permissions.onRemoved.addListener((p) => { /* tear down observers / unregister */ });
```

After grant, register the badge content script dynamically (so you avoid static `content_scripts.matches` install warnings):

```js
await chrome.scripting.registerContentScripts([{
  id: "lucidscan-badges",
  matches: ["https://example.com/*"], // or broader once user opted in
  js: ["content/badges.js"],
  runAt: "document_idle",
  allFrames: false,
  persistAcrossSessions: true
}]);
```

**Gesture rules (easy to break):**

- `chrome.permissions.request()` must be called during a user gesture.
- A gesture can survive **one** `runtime.sendMessage` hop into the SW, but **any `await` before `request()`** burns the gesture → `"This function must be called during a user gesture..."`.
- Prefer calling `request()` from the **options page / popup / side panel button handler** itself, or as the **first** statement in the SW message listener.

Paths on origin patterns are ignored; you can request a **subset** of a declared optional pattern (e.g. manifest has `https://*/*`, request `https://example.com/*`).

**Revoke nuance:** `remove()` drops **active** access, but Chromium keeps a **granted** set — a later `request()` for the same origin often **does not re-prompt**. UX: Settings should still offer “Disable on this site” (your `remove` + unregister) and point users to `chrome://extensions` → site access for hard revoke. See Chromium permissions model notes: https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/permissions.md

**Chrome 133+ alternative UX:** `chrome.permissions.addHostAccessRequest({ tabId })` surfaces a browser host-access affordance on the tab (resets on cross-origin navigation; accept grants persistent top-origin access). Cookbook sample: https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.permissions-addhostaccessrequest — useful as a *supplement* to an Options toggle, not a replacement for clear product copy.

### 1.3 When to prompt (recommended UX)

| Moment | Verdict for LucidScan | Why |
|--------|----------------------|-----|
| **First install** | **Do not** request broad hosts | Install stays warning-light; users distrust “read all sites” on day 0 |
| **Options / Settings** (“Always-on badges on this site” / “All sites”) | **Primary** | You can explain *why* (local signal badges; no cloud) before the Chrome dialog |
| **First badge attempt** (selection chip or first visible image) | **Good secondary** | In-page CTA: “Enable badges on example.com” → `request({ origins: [current] })` — contextual, per-site |
| **Toolbar action / context menu only** | **Fallback** | Uses `activeTab`; no persistent inject; badges die on navigation |

**Recommended product ladder:**

1. Ship with `activeTab` + context menu (parity with today’s LucidScan gesture path).  
2. Options: per-site enable → `request({ origins: [site] })` → `registerContentScripts`.  
3. Options: “Enable on all sites” → `request({ origins: ["https://*/*","http://*/*"] })` with plain-language warning.  
4. Keep context-menu / action as fallback when `contains()` is false.

### 1.4 CWS / install-warning tradeoffs

| Approach | Install dialog | Always-on SPA badges | CWS review pressure |
|----------|----------------|----------------------|---------------------|
| Required `host_permissions` / static matches (`https://*/*`, `<all_urls>`) | Strong warning (“Read and change all your data…”) | Yes | Higher — broad hosts flagged for longer review |
| `optional_host_permissions` + runtime request | Soft install; runtime prompt when enabling | Yes after grant | Better — request only what user enables |
| `activeTab` only | **No** host warning | No (gesture-scoped, revoked on navigate away) | Lowest |

CWS explicitly calls out broad patterns (`*://*/*`, `https://*/*`, `<all_urls>`) as lengthening review: https://developer.chrome.com/docs/webstore/review-process  

Adding required hosts later can **disable the extension until the user re-accepts** — another reason to keep always-on hosts optional: https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings  

### 1.5 OSS / official examples

1. **GoogleChrome sample — optional permissions (API):**  
   https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/sample.optional_permissions  
   Pattern: declare `optional_permissions`, explain in UI, `permissions.request` on button click. Same UX shape for hosts (swap in `optional_host_permissions` + `origins`).

2. **GoogleChrome cookbook — `addHostAccessRequest` (Chrome 133+):**  
   https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.permissions-addhostaccessrequest  
   Pattern: browser-native host-access affordance tied to a tab.

3. **uBlock Origin Lite (cautionary / historical):** long used optional host escalation for modes; later moved toward required broad `host_permissions` for enterprise/deploy pain points — instructive that **optional hosts are the Chrome-docs best practice for trust**, but ops/admin UX differs. Issues/wiki: https://github.com/uBlockOrigin/uBOL-home · permissions justification: https://github.com/uBlockOrigin/uBOL-home/wiki/Justification-for-the-declared-permissions  

For LucidScan (lighter than a blocker), stick with the **docs/sample optional-host ladder**, not uBOL’s eventual “require all hosts” choice.

---

## 2) CSP / iframe badge pitfalls

### 2.1 Page CSP vs content-script worlds

Official content-scripts CSP section: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts  

| Execution | Whose CSP? | Implication for badges |
|-----------|------------|------------------------|
| Default **`ISOLATED`** content script | Extension isolated CSP (`script-src 'self' 'wasm-unsafe-eval' …`) | Page CSP **does not** block the content script. DOM writes, closed Shadow DOM, and script-created `<style>` generally work. |
| **`world: "MAIN"`** (or injected page-world `<script>`) | **Page** CSP | `eval`, inline scripts, remote scripts — blocked like any page code. **Avoid for LucidScan badges.** |
| Manifest `"css": [...]` inject | Browser-applied, not page author CSSOM | Usually fine; still prefer styles **inside** closed shadow for isolation from page resets. |

Isolated-world CSP still forbids classic `eval` / remote script loads in the content script itself; `'wasm-unsafe-eval'` is present (helpful if any WASM ever ran in CS — prefer models in SW/offscreen per companion pack).

**Practical:** build badge UI entirely from the isolated content script (createElement + closed shadow + textContent/SVG). Do **not** inject a `<script src=…>` into the page.

### 2.2 Cross-origin iframes, `all_frames`, odd schemes

Docs: content scripts “Specify frames” + “Inject into related frames”: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts  
Manifest keys: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts  

| Scenario | What happens | LucidScan guidance |
|----------|--------------|--------------------|
| Default `all_frames: false` | CS only in top frame | **Default for badges** — covers most article/feed images + selection |
| Child iframe, different origin | No inject unless pattern + permission match **that** URL and `all_frames: true` (or targeted `executeScript`) | Enable only if product must badge in-frame media (ads/embeds); each frame is its own CS instance |
| `about:blank` / `data:` / `blob:` / `filesystem:` | URL may not match patterns | Set `match_origin_as_fallback: true` (requires path `*` on matches) and/or `match_about_blank: true` |
| `chrome-error://`, `chrome://`, Web Store, PDF viewer, other restricted pages | No / unreliable inject; `activeTab` also denied on restricted pages | Detect failure; show toolbar message “unavailable on this page” |
| Sandboxed iframe (`sandbox` attr) | May have opaque origin / limited DOM | Treat as best-effort; don’t promise badges |

Selection chip: only meaningful in the frame that owns the selection — with `all_frames: false`, selection inside a cross-origin iframe won’t surface a top-frame chip (by design).

### 2.3 Shadow DOM vs CSP / page hostility

- **Closed shadow** (`attachShadow({ mode: "closed" })`): page CSS cannot restyle internals; page JS cannot query inside. Good for badge chrome.  
- **Does not** defeat page CSP (irrelevant for isolated CS).  
- **Does not** stop the page from **removing the host element** or overlaying an opaque full-page layer.  
- Prefer positioning via `position: fixed` + viewport rects (selection) or anchored hosts near images; optional `popover="manual"` for top-layer (companion pack).

### 2.4 `web_accessible_resources` pitfalls

Official: https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources  

- Default: **nothing** from the extension is loadable by web pages.  
- Declaring WAR exposes those files at `chrome-extension://<id>/…` to matching origins → **extension fingerprinting** and abuse surface.  
- Content scripts themselves do **not** need to be listed as WAR.  
- `use_dynamic_url: true` ties access to a **per-session** dynamic ID (harder to fingerprint; breaks on reload).  
- `matches` path must be `/*` (origin-only matching).

**LucidScan recommendation:**

| Asset | Prefer | Avoid |
|-------|--------|-------|
| Badge icon | Inline SVG / CSS in closed shadow | PNG listed in WAR for all sites |
| Fonts | System UI font stack | WAR `.woff` |
| Models / WASM | SW / offscreen document (extension origin) | WAR + fetch from page |
| Image bytes for CLIP | `drawImage` / OffscreenCanvas from already-decoded `<img>`, or SW `fetch` **with host permission** | Re-download via page-world script |

If you must expose a tiny asset: scope `matches` to granted hosts only, keep the file list tiny, consider `use_dynamic_url`.

### 2.5 Sites that strip overlays (high-level only)

Some properties actively remove unknown DOM, fight fixed overlays, or detect extension resources (anti-fraud, some social/media, enterprise SSO). High-level mitigations only:

- Closed shadow + innocuous host tag (`div` with data attribute), no `chrome-extension://` URLs in page-visible attributes when avoidable.  
- Re-attach with **backoff** if host removed; cap retries.  
- If repeatedly stripped → silence badges on that origin for the session and fall back to **toolbar / context-menu / activeTab**.  
- Do not engage in DOM arms races on banking / payments / anti-abuse surfaces; document “unsupported site” in Options.

### 2.6 Practical LucidScan badge recipe (images + selected text)

1. **Permissions ladder:** `activeTab` always; `optional_host_permissions` for always-on; dynamic `registerContentScripts` after grant.  
2. **World:** isolated only; closed Shadow DOM hosts; styles + inline SVG inside the shadow. **No WAR** for v1.  
3. **Images:** top-frame `img`/`picture` + IntersectionObserver; send compact payload (bitmap transfer / hashed `src`) to SW/offscreen; paint score into shadow. Respect CORS/tainted-canvas limits — if canvas taints, SW fetches with host permission (user already granted that origin).  
4. **Text:** debounced `selectionchange` → Range `getBoundingClientRect()` → fixed chip in closed shadow; message selection string only.  
5. **Frames:** `all_frames: false` until a concrete iframe requirement appears; then opt-in per-site with matching host grant.  
6. **Failure modes:** no host → show enable CTA or use context menu; restricted page → soft message; overlay stripped → backoff + degrade.  
7. **Copy:** badge = “local signal,” never authenticity guarantee (companion pack §4).

---

## 3) Suggested manifest / flow (copy-paste target)

```text
Install: activeTab + scripting + storage + contextMenus  (no broad hosts)
User opens Options → "Enable always-on badges on this site"
  → permissions.request({ origins: ["https://site/*"] })   // user gesture
  → scripting.registerContentScripts({ matches, js: badges.js })
Content script: closed shadow badges + observers
User disables site → permissions.remove + unregisterContentScripts
No grant / restricted page → contextMenus / action + activeTab one-shot
```

---

## 4) Source index (primary)

**Permissions / CWS**

- https://developer.chrome.com/docs/extensions/reference/api/permissions  
- https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions  
- https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings  
- https://developer.chrome.com/docs/extensions/develop/concepts/activeTab  
- https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy  
- https://developer.chrome.com/docs/webstore/review-process  
- https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/permissions.md  

**Content scripts / CSP / frames / WAR**

- https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts  
- https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts  
- https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources  

**Samples**

- https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/sample.optional_permissions  
- https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.permissions-addhostaccessrequest  

**Companion**

- `/workspace/research-packs/lucidscan-mv3-local.md`  
- LucidScan repo: https://github.com/alexnstevens06/LucidScan  
