const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./extract");
const plain = (o) => JSON.parse(JSON.stringify(o)); // vm objects have foreign prototypes

const bg = load("background.js", ["originPatternFromUrl", "isRestrictedUrl"]);
const content = load("content.js", ["hashStr", "cheapImagePrefilter"], "const MIN_IMG = 48;", {
  document: { createElement: () => { throw new Error("no canvas in node"); } },
});

test("originPatternFromUrl: http(s) only", () => {
  assert.equal(bg.originPatternFromUrl("https://example.com/a?b=1"), "https://example.com/*");
  assert.equal(bg.originPatternFromUrl("http://127.0.0.1:8765/test/sample.html"), "http://127.0.0.1:8765/*");
  assert.equal(bg.originPatternFromUrl("file:///tmp/x.html"), null);
  assert.equal(bg.originPatternFromUrl("chrome://extensions"), null);
  assert.equal(bg.originPatternFromUrl("not a url"), null);
});

test("isRestrictedUrl guards browser-internal pages", () => {
  for (const u of ["chrome://newtab", "chrome-extension://abc/popup.html", "about:blank",
    "file:///x", "view-source:https://a.com", "devtools://x", "edge://settings", "", null]) {
    assert.equal(bg.isRestrictedUrl(u), true, String(u));
  }
  assert.equal(bg.isRestrictedUrl("https://example.com"), false);
});

test("hashStr is stable FNV-1a hex", () => {
  assert.equal(content.hashStr("abc"), content.hashStr("abc"));
  assert.notEqual(content.hashStr("abc"), content.hashStr("abd"));
  assert.match(content.hashStr(""), /^[0-9a-f]+$/);
});

test("cheapImagePrefilter heuristics", () => {
  assert.deepEqual(plain(content.cheapImagePrefilter({ naturalWidth: 20, naturalHeight: 200 })), { skip: true, reason: "tiny" });
  assert.deepEqual(
    plain(content.cheapImagePrefilter({ naturalWidth: 100, naturalHeight: 100, src: "data:image/png;base64,AAAA" })),
    { skip: true, reason: "tiny-data-uri" }
  );
  // canvas unavailable/tainted -> do not skip
  assert.deepEqual(
    plain(content.cheapImagePrefilter({ naturalWidth: 300, naturalHeight: 300, src: "https://a/b.jpg", complete: true })),
    { skip: false }
  );
});

test("image cache: LRU capped at 200, 24h TTL", () => {
  let now = 1_000_000;
  const FakeDate = { now: () => now };
  const c = load("offscreen.js", ["memoryCacheSet", "isFresh"],
    "const imageCache = new Map(); const IMAGE_CACHE_MAX = 200; const IMAGE_CACHE_TTL_MS = 24*60*60*1000;",
    { Date: FakeDate }, ["imageCache"]);
  for (let i = 0; i < 250; i++) c.memoryCacheSet("k" + i, { score: i });
  assert.equal(c.imageCache.size, 200);
  assert.equal(c.imageCache.has("k0"), false);
  assert.equal(c.imageCache.has("k249"), true);
  c.memoryCacheSet("k50", { score: 1 }); // touch -> most recent
  assert.equal([...c.imageCache.keys()].pop(), "k50");
  assert.equal(c.isFresh(now), true);
  now += 24 * 60 * 60 * 1000 - 1;
  assert.equal(c.isFresh(1_000_000), true);
  now += 2;
  assert.equal(c.isFresh(1_000_000), false);
  assert.equal(c.isFresh(undefined), false);
});
