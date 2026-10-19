// Runs the real chrome_plugin/content.js against a fake page (fake-page.js) to cover the
// enable -> disable -> re-enable lifecycle and the loading / unavailable badge paths.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makePage } = require("./fake-page");

const plain = (o) => JSON.parse(JSON.stringify(o));

test("enable is idempotent: a second injection adds no listeners", async () => {
  const page = makePage();
  page.inject();
  await page.flush();
  const first = page.listenerCounts();
  assert.equal(first.onMessage, 1);
  assert.equal(first.onChanged, 1);
  assert.equal(page.history.pushState === page.origPush, false, "pushState wrapped");
  const wrapped = page.history.pushState;
  page.inject();
  await page.flush();
  assert.deepEqual(page.listenerCounts(), first);
  assert.equal(page.history.pushState, wrapped, "pushState not wrapped twice");
});

test("disable tears down listeners, observers, badges, history patch and guard", async () => {
  const page = makePage();
  page.addImg();
  page.inject();
  await page.flush();
  assert.equal(page.badgeHosts().length, 1);
  page.message({ type: "teardownBadges" });
  await page.flush();
  assert.deepEqual(plain(page.listenerCounts()), { window: 0, document: 0, onMessage: 0, onChanged: 0, io: 0, mo: 0 });
  assert.equal(page.history.pushState, page.origPush);
  assert.equal(page.history.replaceState, page.origReplace);
  assert.equal(page.badgeHosts().length, 0);
  assert.equal(page.ctx.__lucidScanContentLoaded, false);
  assert.equal(page.timers.length, 0, "no timers left behind");
  // Selection and soft navigation after disable do nothing.
  const sentBefore = page.sent.length;
  page.selection = { isCollapsed: false, rangeCount: 1, toString: () => "some selected text long enough",
    getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 50, left: 50, bottom: 70, width: 100, height: 20 }) }) };
  page.document.dispatch("selectionchange");
  page.window.dispatch("popstate");
  page.history.pushState({}, "", "/next");
  await page.advance(5000);
  assert.equal(page.sent.length, sentBefore, "no scoring after disable");
  assert.equal(page.badgeHosts().length, 0, "soft nav did not bring badges back");
});

test("re-enable after disable yields exactly one fresh instance", async () => {
  const page = makePage();
  page.inject();
  await page.flush();
  const first = plain(page.listenerCounts());
  page.message({ type: "teardownBadges" });
  page.inject();
  await page.flush();
  assert.deepEqual(plain(page.listenerCounts()), first);
  page.inject(); // enable clicked twice
  await page.flush();
  assert.deepEqual(plain(page.listenerCounts()), first);
  assert.equal(page.instance().alive, true);
});

test("disabling the origin via storage (popup list) also destroys the instance", async () => {
  const page = makePage();
  page.inject();
  await page.flush();
  page.storageChange({ enabledOrigins: { newValue: [] } });
  assert.equal(page.listenerCounts().window, 0);
  assert.equal(page.ctx.__lucidScanContentLoaded, false);
});

test("teardown from a foreign sender is ignored", async () => {
  const page = makePage();
  page.inject();
  await page.flush();
  page.message({ type: "teardownBadges" }, { id: "someone-else" });
  assert.equal(page.instance().alive, true);
});

test("cross-origin (tainted) image with unavailable reply shows 'unavailable', no number", async () => {
  const page = makePage({ respond: () => ({ state: "unavailable", reason: "cross-origin image not readable" }) });
  page.addImg();
  page.inject();
  await page.flush();
  assert.equal(page.sent[0].dataUrl, null, "tainted canvas => no dataUrl");
  assert.deepEqual(page.pillTexts(), ["unavailable"]);
});

test("legacy mock/heuristic replies never render a number", async () => {
  const page = makePage({ respond: () => ({ state: "signal", score: 0.42, mode: "mock", heuristics: true }) });
  page.addImg();
  page.inject();
  await page.flush();
  assert.deepEqual(page.pillTexts(), ["unavailable"]);
});

test("first-run loading shows progress, retries with backoff, then a real score", async () => {
  const page = makePage({
    respond: (_m, n) => (n < 3 ? { state: "loading", progress: 40 } : { state: "signal", score: 0.73, mode: "transformers" }),
  });
  page.addImg();
  page.inject();
  await page.flush();
  assert.deepEqual(page.pillTexts(), ["downloading model 40%"]);
  await page.advance(2000);
  assert.equal(page.sent.length, 2);
  await page.advance(4000);
  assert.equal(page.sent.length, 3);
  assert.deepEqual(page.pillTexts(), ["local score 73"]);
  assert.equal(page.timers.length, 0, "no further retries");
});

test("a model that never loads ends at 'unavailable', not a stuck badge", async () => {
  const page = makePage({ respond: () => ({ state: "loading" }) });
  page.addImg();
  page.inject();
  await page.flush();
  assert.deepEqual(page.pillTexts(), ["loading model…"]);
  await page.advance(11 * 60 * 1000);
  assert.deepEqual(page.pillTexts(), ["unavailable"]);
  assert.equal(page.timers.length, 0);
});

test("disable during a pending retry cancels it", async () => {
  const page = makePage({ respond: () => ({ state: "loading" }) });
  page.addImg();
  page.inject();
  await page.flush();
  const n = page.sent.length;
  page.message({ type: "teardownBadges" });
  await page.advance(60000);
  assert.equal(page.sent.length, n);
});
