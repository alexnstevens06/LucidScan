// Behavioural tests for sender checks (background.js / offscreen.js), cancel settling and the
// cross-origin image path (offscreen.js), using the real function bodies.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./extract");
const plain = (o) => JSON.parse(JSON.stringify(o));

const ID = "abcdefghijklmnop";
const chrome = { runtime: { id: ID, getURL: (p) => `chrome-extension://${ID}/${p}` } };
const bg = load("background.js", ["isExtensionPage", "isOffscreenDoc", "isOwnContentScript"],
  `const OFFSCREEN_URL = "offscreen.html"; const EXTENSION_ORIGIN = chrome.runtime.getURL("");`, { chrome });

const popup = { id: ID, url: `chrome-extension://${ID}/popup.html` };
const popupWindow = { id: ID, url: `chrome-extension://${ID}/popup.html`, tab: { id: 9 } };
const offscreen = { id: ID, url: `chrome-extension://${ID}/offscreen.html` };
const content = { id: ID, url: "https://site.example/page", tab: { id: 3 } };
const foreign = { id: "other-extension", url: "chrome-extension://other-extension/x.html" };

test("background: popup/extension pages vs content scripts vs others", () => {
  assert.equal(bg.isExtensionPage(popup), true);
  assert.equal(bg.isExtensionPage(popupWindow), true);
  assert.equal(bg.isExtensionPage(content), false);
  assert.equal(bg.isExtensionPage(foreign), false);
  assert.equal(bg.isExtensionPage({ id: ID }), false, "no url => not trusted");
  assert.equal(bg.isOffscreenDoc(offscreen), true);
  assert.equal(bg.isOffscreenDoc(popup), false);
  assert.equal(bg.isOffscreenDoc({ ...content, url: "https://evil.example/offscreen.html" }), false);
  assert.equal(bg.isOwnContentScript(content), true);
  assert.equal(bg.isOwnContentScript(popupWindow), false);
  assert.equal(bg.isOwnContentScript({ ...content, id: "other" }), false);
});

test("offscreen: only extension contexts outside tabs may drive it", () => {
  const off = load("offscreen.js", ["isTrustedSender"], `const EXTENSION_ORIGIN = chrome.runtime.getURL("");`, { chrome });
  assert.equal(off.isTrustedSender({ id: ID, url: `chrome-extension://${ID}/background.js` }), true);
  assert.equal(off.isTrustedSender(content), false);
  assert.equal(off.isTrustedSender(popupWindow), false);
  assert.equal(off.isTrustedSender(foreign), false);
});

test("cancel only flags an in-flight load and clears once it settles", () => {
  const c = load("offscreen.js", ["settleCancel", "requestCancel"],
    `let loadCancelled = false; let textStatus = "idle"; let imageStatus = "idle";
     function set(t, i) { textStatus = t; imageStatus = i; } function flag() { return loadCancelled; }`,
    {}, ["set", "flag"]);
  assert.equal(c.requestCancel(), false, "nothing loading => no sticky flag");
  c.set("idle", "loading");
  assert.equal(c.requestCancel(), true);
  c.set("idle", "idle");
  c.settleCancel();
  assert.equal(c.flag(), false, "flag cleared after load settles");
});

test("cross-origin image fetch failure => unavailable reason, success => blob input", async () => {
  const mk = (fetch) => load("offscreen.js", ["resolveImageInput"], "", {
    fetch, URL: Object.assign(function (u) { return new globalThis.URL(u); },
      { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  });
  const failing = mk(async () => { throw new TypeError("Failed to fetch"); });
  assert.match((await failing.resolveImageInput("https://cdn.other.example/a.jpg", null)).error, /cross-origin/);
  const notOk = mk(async () => ({ ok: false, status: 403 }));
  assert.match((await notOk.resolveImageInput("https://cdn.other.example/a.jpg", null)).error, /HTTP 403/);
  const ok = mk(async () => ({ ok: true, blob: async () => ({ size: 10, type: "image/jpeg" }) }));
  assert.equal((await ok.resolveImageInput("https://cdn.other.example/a.jpg", null)).input, "blob:x");
  assert.deepEqual(plain(await ok.resolveImageInput("x", "data:image/jpeg;base64,AA")), { input: "data:image/jpeg;base64,AA" });
  assert.match((await ok.resolveImageInput("chrome://x", null)).error, /scheme/);
});

test("unavailable() carries a reason and no score", () => {
  const u = load("offscreen.js", ["unavailable"]).unavailable("x");
  assert.deepEqual(plain(u), { state: "unavailable", label: "unavailable", reason: "x" });
});
