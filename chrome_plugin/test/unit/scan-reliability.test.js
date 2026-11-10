// Context-menu scan settlement, popup rendering, and empty model output.
// Uses the real functions from background.js, popup.js, and offscreen.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { load } = require("./extract");

const plain = (o) => JSON.parse(JSON.stringify(o));

const VM = { console, Number, Promise, Error, AbortController, DOMException };

function engine() {
  return load("background.js", [
    "menuScanLimits", "finiteScore", "messageOf", "settleEngineScan", "settleServerScan",
    "terminalFromAbort", "resolveContextMenuScan", "menuRequestFromInfo", "createVideoSignal",
  ], "", VM);
}

function bookkeeping() {
  const writes = [];
  const windows = new Map();
  let nextId = 1;
  const chrome = {
    storage: { local: { async set(obj) { writes.push(plain(obj.lastScan)); } } },
    windows: {
      async get(id) {
        if (!windows.has(id)) throw new Error("No window");
        return windows.get(id);
      },
      async update(id, info) {
        const row = windows.get(id);
        if (!row) throw new Error("No window");
        Object.assign(row, info);
        return row;
      },
      async create(info) {
        const row = { id: nextId++, focused: true, ...info };
        windows.set(row.id, row);
        return row;
      },
    },
  };
  const api = load("background.js", [
    "beginContextScan", "scanStillCurrent", "finishContextScan", "publishScan",
    "focusOrCreateScanWindow", "forgetScanWindow", "settleEngineScan", "finiteScore",
  ], `let scanSerial = 0;
      let activeScan = null;
      let scanResultWindowId = null;
      let scanPublishChain = Promise.resolve();`, { ...VM, chrome });
  return { api, writes, windows };
}

function popupDocument() {
  const nodes = {};
  for (const id of ["confidence-score", "content-type", "score-label", "scan-detail", "last-scan-card"]) {
    nodes[id] = { id, textContent: "", hidden: false, dataset: {}, style: {} };
  }
  const circle = { style: {} };
  const document = {
    getElementById: (id) => nodes[id],
    querySelector: (sel) => (sel === ".score-circle" ? circle : null),
  };
  const api = load("popup.js", ["paintLastScan", "presentedScan", "scanViewState", "el"], "", { ...VM, document });
  return { api, nodes, circle };
}

test("menu scan keeps a real score and refuses empty, mock, and numberless results", async () => {
  const api = engine();
  const signal = new AbortController().signal;
  const blank = await api.resolveContextMenuScan({ type: "text", content: "   ", signal });
  assert.equal(blank.state, "unavailable");
  assert.equal(blank.reason, "nothing to scan");
  assert.equal(blank.confidence, null);
  assert.equal(blank.text, undefined);

  let calls = 0;
  const updates = [];
  let now = 1000;
  const scored = await api.resolveContextMenuScan({
    type: "image",
    content: "https://cdn.example/a.jpg",
    signal,
    now: () => now,
    onUpdate: (row) => updates.push(plain(row)),
    sleep: async () => { now += 2000; },
    score: async () => {
      calls += 1;
      return calls < 2
        ? { state: "loading", progress: 40 }
        : { state: "signal", score: 0.42, mode: "transformers", label: "local score" };
    },
  });
  assert.equal(scored.state, "signal");
  assert.equal(scored.confidence, 0.42);
  assert.equal(scored.mode, "transformers");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].state, "loading");
  assert.equal(updates[0].confidence, null);
  assert.equal(updates[0].src, undefined);

  const mock = await api.resolveContextMenuScan({
    type: "text",
    content: "some selected text",
    signal,
    score: async () => ({ state: "signal", score: 0.99, mode: "mock" }),
  });
  assert.equal(mock.state, "unavailable");
  assert.equal(mock.confidence, null);

  const numberless = await api.resolveContextMenuScan({
    type: "text",
    content: "some selected text",
    signal,
    score: async () => ({ state: "signal", mode: "transformers" }),
  });
  assert.equal(numberless.state, "unavailable");
  assert.equal(numberless.reason, "model returned no score");
  assert.equal(numberless.confidence, null);

  const cancelled = await api.resolveContextMenuScan({
    type: "text",
    content: "some selected text",
    signal,
    score: async () => ({ cancelled: true }),
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.confidence, null);

  const pending = plain(api.settleEngineScan({ state: "pending", label: "offline", error: "scoring failed: boom" }, "text"));
  assert.equal(pending.state, "unavailable");
  assert.equal(pending.confidence, null);
  assert.match(pending.reason, /scoring failed/);
});

test("a model that stays loading ends unavailable without a score", async () => {
  const api = engine();
  let now = 0;
  let scores = 0;
  const display = await api.resolveContextMenuScan({
    type: "text",
    content: "selected text that is long enough",
    signal: new AbortController().signal,
    now: () => now,
    score: async () => { scores += 1; return { state: "loading" }; },
    sleep: async () => { now += 20000; },
  });
  assert.equal(display.state, "unavailable");
  assert.match(display.reason, /did not finish loading/);
  assert.equal(display.confidence, null);
  assert.ok(scores >= 2 && scores <= 8);
});

test("aborting a loading scan settles cancelled and does not invent a score", async () => {
  const api = engine();
  const ac = new AbortController();
  const display = await api.resolveContextMenuScan({
    type: "text",
    content: "selected text that is long enough",
    signal: ac.signal,
    score: async () => ({ state: "loading", progress: 10 }),
    sleep: async () => {
      ac.abort();
      throw new DOMException("scan cancelled", "AbortError");
    },
  });
  assert.equal(display.state, "cancelled");
  assert.equal(display.confidence, null);
});

test("video server failures, empty bodies, and timeouts are not server scores", async () => {
  const api = engine();
  const signal = () => new AbortController().signal;
  const failed = await api.resolveContextMenuScan({
    type: "video",
    content: "https://cdn.example/a.mp4",
    signal: signal(),
    postVideo: async () => ({ ok: false, status: 500, data: { error: "Error processing file" } }),
  });
  assert.equal(failed.state, "unavailable");
  assert.equal(failed.reason, "Error processing file");
  assert.equal(failed.confidence, null);
  assert.notEqual(failed.label, "server score");

  const empty = await api.resolveContextMenuScan({
    type: "video",
    content: "https://cdn.example/a.mp4",
    signal: signal(),
    postVideo: async () => ({ ok: true, status: 200, data: {} }),
  });
  assert.equal(empty.state, "unavailable");
  assert.equal(empty.reason, "server returned no score");
  assert.equal(empty.confidence, null);

  const coerced = await api.resolveContextMenuScan({
    type: "video",
    content: "https://cdn.example/a.mp4",
    signal: signal(),
    postVideo: async () => ({ ok: true, status: 200, data: { confidence: "0.8" } }),
  });
  assert.equal(coerced.state, "unavailable");
  assert.equal(coerced.confidence, null);

  const zero = await api.resolveContextMenuScan({
    type: "video",
    content: "https://cdn.example/a.mp4",
    signal: signal(),
    postVideo: async () => ({ ok: true, status: 200, data: { confidence: 0 } }),
  });
  assert.equal(zero.state, "signal");
  assert.equal(zero.confidence, 0);
  assert.equal(zero.mode, "flask");

  const ac = new AbortController();
  ac.abort(new DOMException("video scan timed out", "TimeoutError"));
  let posted = false;
  const timedOut = await api.resolveContextMenuScan({
    type: "video",
    content: "https://cdn.example/a.mp4",
    signal: ac.signal,
    postVideo: async () => { posted = true; return { ok: true, status: 200, data: { confidence: 0.4 } }; },
  });
  assert.equal(posted, false);
  assert.equal(timedOut.state, "unavailable");
  assert.match(timedOut.reason, /did not respond/);
  assert.equal(timedOut.confidence, null);

  const down = await api.resolveContextMenuScan({
    type: "video",
    content: "https://cdn.example/a.mp4",
    signal: signal(),
    postVideo: async () => { throw new TypeError("Failed to fetch"); },
  });
  assert.equal(down.state, "unavailable");
  assert.match(down.reason, /Failed to fetch/);
  assert.equal(down.confidence, null);
});

test("video timeout aborts the child signal and parent abort clears the timer", () => {
  const api = engine();
  let fire = null;
  let cleared = false;
  const parent = new AbortController();
  const video = api.createVideoSignal(parent.signal, (_ms, fn) => {
    fire = fn;
    return () => { cleared = true; fire = null; };
  });
  assert.equal(typeof fire, "function");
  fire();
  assert.equal(video.signal.aborted, true);
  assert.equal(video.signal.reason.name, "TimeoutError");
  assert.equal(cleared, true);
  video.cancel();

  let clearedByParent = false;
  const other = new AbortController();
  const child = api.createVideoSignal(other.signal, () => () => { clearedByParent = true; });
  other.abort();
  assert.equal(child.signal.aborted, true);
  assert.equal(child.signal.reason.name, "AbortError");
  assert.equal(clearedByParent, true);

  let clearedOnFinish = false;
  const done = new AbortController();
  const finished = api.createVideoSignal(done.signal, () => () => { clearedOnFinish = true; });
  assert.equal(finished.signal.aborted, false);
  finished.cancel();
  assert.equal(clearedOnFinish, true);
  assert.equal(finished.signal.aborted, true);
});

test("whitespace menu input is an empty scan, unknown items are ignored", () => {
  const api = engine();
  assert.deepEqual(plain(api.menuRequestFromInfo({ menuItemId: "scan-text", selectionText: "  \n" })), {
    type: "text",
    content: "",
  });
  assert.equal(api.menuRequestFromInfo({ menuItemId: "scan-other", selectionText: "hello" }), null);
  assert.equal(api.menuRequestFromInfo(null), null);
});

test("a newer scan aborts the previous one and a stale result is not stored", async () => {
  const { api, writes, windows } = bookkeeping();
  const first = api.beginContextScan();
  const second = api.beginContextScan();
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.equal(api.scanStillCurrent(first.serial), false);
  const stale = await api.publishScan(first.serial, api.settleEngineScan({ state: "cancelled" }, "text"));
  assert.equal(stale, false);
  assert.equal(writes.length, 0);
  const stored = await api.publishScan(second.serial, api.settleEngineScan({
    state: "unavailable",
    reason: "nothing to scan",
  }, "image"));
  assert.equal(stored, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].state, "unavailable");
  assert.equal(writes[0].confidence, null);
  assert.equal(writes[0].reason, "nothing to scan");

  const id1 = await api.focusOrCreateScanWindow();
  const id2 = await api.focusOrCreateScanWindow();
  assert.equal(id1, id2);
  assert.equal(windows.size, 1);
  assert.equal(windows.get(id1).focused, true);
  api.forgetScanWindow(id1);
  const id3 = await api.focusOrCreateScanWindow();
  assert.notEqual(id3, id1);
  assert.equal(windows.size, 2);
  api.finishContextScan(second.serial);
});

test("popup shows loading, cancelled, failed, and legacy pending without a number", () => {
  const { api, nodes } = popupDocument();
  api.paintLastScan(null);
  assert.equal(nodes["confidence-score"].textContent, "—");
  assert.equal(nodes["last-scan-card"].dataset.state, "empty");
  assert.equal(nodes["scan-detail"].hidden, true);

  api.paintLastScan({ state: "signal", confidence: 0.73, label: "local score", contentType: "text", mode: "transformers" });
  assert.equal(nodes["confidence-score"].textContent, "73");
  assert.equal(nodes["score-label"].textContent, "local score");
  assert.equal(nodes["content-type"].textContent, "text");
  assert.equal(nodes["last-scan-card"].dataset.state, "signal");

  api.paintLastScan({ state: "loading", confidence: null, label: "loading", contentType: "image", reason: "model still loading", progress: 40 });
  assert.equal(nodes["confidence-score"].textContent, "…");
  assert.equal(nodes["score-label"].textContent, "loading");
  assert.equal(nodes["last-scan-card"].dataset.state, "loading");
  assert.match(nodes["scan-detail"].textContent, /model still loading/);
  assert.match(nodes["scan-detail"].textContent, /40%/);
  assert.equal(nodes["confidence-score"].textContent.includes("40"), false);

  api.paintLastScan({ state: "cancelled", contentType: "text", reason: "scan cancelled" });
  assert.equal(nodes["score-label"].textContent, "cancelled");
  assert.equal(nodes["confidence-score"].textContent, "—");
  assert.match(nodes["scan-detail"].textContent, /cancelled/);

  api.paintLastScan({ state: "unavailable", contentType: "video", reason: "server returned no score" });
  assert.equal(nodes["score-label"].textContent, "unavailable");
  assert.equal(nodes["confidence-score"].textContent, "—");
  assert.match(nodes["scan-detail"].textContent, /no score/);
  assert.equal(nodes["content-type"].textContent, "video");

  api.paintLastScan({ label: "pending", contentType: "text", confidence: null });
  assert.equal(nodes["last-scan-card"].dataset.state, "unavailable");
  assert.equal(nodes["confidence-score"].textContent, "—");
  assert.match(nodes["scan-detail"].textContent, /did not finish/);

  api.paintLastScan({ label: "local score", contentType: "image", confidence: 0.5 });
  assert.equal(nodes["confidence-score"].textContent, "50");
  assert.equal(nodes["last-scan-card"].dataset.state, "signal");

  api.paintLastScan({ state: "signal", score: 0.9, confidence: 0.9, mode: "mock", label: "local score", contentType: "text" });
  assert.equal(nodes["last-scan-card"].dataset.state, "unavailable");
  assert.equal(nodes["confidence-score"].textContent, "—");
});

test("empty text and an empty model output do not become a score", async () => {
  const calls = { kick: 0 };
  const empty = load("offscreen.js", ["scoreText", "unavailable"], `
    let preferMock = false;
    async function loadSettings() {}
    function kickLoad() { calls.kick += 1; return false; }
  `, { ...VM, calls });
  const blank = await empty.scoreText(" \n\t ");
  assert.equal(blank.state, "unavailable");
  assert.equal(blank.reason, "nothing to scan");
  assert.equal(Object.hasOwn(blank, "score"), false);
  assert.equal(calls.kick, 0);

  const scored = load("offscreen.js", ["scoreText", "textOutputToScore", "clamp01", "unavailable"], `
    let preferMock = false;
    let textPipe = async () => [];
    let deviceUsed = { text: "wasm" };
    const TEXT_MODEL = "text-model";
    async function loadSettings() {}
    function kickLoad() { return true; }
  `, VM);
  const missing = await scored.scoreText("a real selection of text");
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.reason, "text model returned no score");
  assert.equal(Object.hasOwn(missing, "score"), false);
  assert.equal(scored.textOutputToScore([]), null);
  assert.equal(scored.textOutputToScore([{ label: "AI" }]), null);
  assert.equal(scored.textOutputToScore([{ label: "AI", score: 0.8 }]), 0.8);

  const revoked = [];
  const image = load("offscreen.js", ["scoreImage", "imageOutputToScore", "clamp01", "unavailable"], `
    let preferMock = false;
    let deviceUsed = { image: "wasm" };
    let imagePipe = async () => [];
    const IMAGE_MODEL = "image-model";
    const IMAGE_LABELS = ["photograph", "synthetic"];
    async function loadSettings() {}
    function kickLoad() { return true; }
    async function cacheGet() { return null; }
    async function cacheSet() { throw new Error("empty output must not be cached"); }
    function hashStr() { return "k"; }
    async function resolveImageInput() {
      return { input: "blob:x", revoke() { revoked.push("blob:x"); } };
    }
  `, { ...VM, revoked });
  const noPixels = await image.scoreImage({});
  assert.equal(noPixels.state, "unavailable");
  assert.equal(noPixels.reason, "nothing to scan");
  assert.equal(revoked.length, 0);
  const noScore = await image.scoreImage({ src: "https://cdn.example/a.jpg" });
  assert.equal(noScore.state, "unavailable");
  assert.equal(noScore.reason, "image model returned no score");
  assert.equal(Object.hasOwn(noScore, "score"), false);
  assert.deepEqual(revoked, ["blob:x"]);
  assert.equal(image.imageOutputToScore(null), null);
});

test("a cancelled pipeline load does not start the next backend", async () => {
  const calls = [];
  const off = load("offscreen.js", ["createPipe"], `
    let loadCancelled = false;
    let loadProgress = null;
    let cancelAfterFailure = false;
    function setCancelled(v) { loadCancelled = v; }
    function setCancelAfterFailure(v) { cancelAfterFailure = v; }
    async function canUseWebGPU() { return true; }
    function makeProgressHandler() { return () => {}; }
    const MODEL_REVISIONS = { m: "rev" };
    async function pipeline(_task, _model, opts) {
      calls.push(opts.device || "auto");
      if (cancelAfterFailure) loadCancelled = true;
      throw new Error("backend failed");
    }
  `, { ...VM, calls }, ["setCancelled", "setCancelAfterFailure"]);
  await assert.rejects(() => off.createPipe("text-classification", "m", "q8", "text"));
  assert.deepEqual(calls, ["webgpu", "wasm", "auto"]);
  calls.length = 0;
  off.setCancelled(true);
  await assert.rejects(() => off.createPipe("text-classification", "m", "q8", "text"));
  assert.deepEqual(calls, []);
  off.setCancelled(false);
  off.setCancelAfterFailure(true);
  await assert.rejects(() => off.createPipe("text-classification", "m", "q8", "text"));
  assert.deepEqual(calls, ["webgpu"]);
});

test("offscreen status failure is unavailable and claims mock only from settings", () => {
  const api = load("background.js", ["statusWhenOffscreenDown", "messageOf"], "", VM);
  const down = plain(api.statusWhenOffscreenDown(new Error("Could not establish connection"), {
    inferenceMode: "transformers",
    forceMock: false,
  }));
  assert.equal(down.mode, "transformers");
  assert.equal(down.text, "unavailable");
  assert.equal(down.image, "unavailable");
  assert.equal(down.score, undefined);
  assert.match(down.reason, /offscreen unavailable/);
  assert.doesNotMatch(JSON.stringify(down), /"mock"/);

  const unknown = api.statusWhenOffscreenDown(new Error("no status reply"), null);
  assert.equal(unknown.mode, "unknown");
  assert.equal(unknown.text, "unavailable");

  const configured = api.statusWhenOffscreenDown(new Error("x"), { inferenceMode: "mock", forceMock: true });
  assert.equal(configured.mode, "mock");
  assert.equal(configured.text, "unavailable");
  assert.equal(configured.score, undefined);

  const bg = fs.readFileSync(path.join(__dirname, "..", "..", "background.js"), "utf8");
  assert.match(bg, /sendResponse\(statusWhenOffscreenDown\(err, flags\)\)/);
  assert.doesNotMatch(bg, /text:\s*["']mock["']/);
});

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function bootPopup(lastScan, statusReply) {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "popup.html"), "utf8");
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const nodes = {};
  const make = (tag) => {
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      id: "",
      textContent: "",
      hidden: false,
      disabled: false,
      dataset: {},
      style: {},
      className: "",
      title: "",
      children: [],
      _html: "",
      append(...kids) { for (const kid of kids) this.appendChild(kid); },
      appendChild(kid) { this.children.push(kid); return kid; },
      addEventListener(type, fn) {
        this._handlers = this._handlers || {};
        (this._handlers[type] = this._handlers[type] || []).push(fn);
      },
    };
    Object.defineProperty(el, "innerHTML", {
      get() { return el._html; },
      set(value) {
        el._html = String(value);
        if (value === "") el.children = [];
      },
    });
    return el;
  };
  for (const id of ids) {
    const el = make("div");
    el.id = id;
    nodes[id] = el;
  }
  const circle = { style: {} };
  /** @type {{ type: string, fn: Function }[]} */
  const domListeners = [];
  let storageListener = null;
  const sent = [];
  const document = {
    getElementById: (id) => nodes[id] || null,
    querySelector: (sel) => (sel === ".score-circle" ? circle : null),
    addEventListener: (type, fn) => domListeners.push({ type, fn }),
    createElement: (tag) => make(tag),
  };
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        sent.push(msg);
        queueMicrotask(() => {
          if (msg.type === "getInferenceStatus") cb(statusReply);
          else if (msg.type === "getSiteBadgeStatus") cb({ restricted: true, origin: null });
          else cb({ ok: false, error: "unused in this test" });
        });
      },
    },
    storage: {
      local: { get(_defaults, cb) { queueMicrotask(() => cb({ lastScan })); } },
      onChanged: { addListener(fn) { storageListener = fn; } },
    },
    tabs: { query(_query, cb) { if (cb) queueMicrotask(() => cb([])); } },
    permissions: { request(_query, cb) { if (cb) queueMicrotask(() => cb(false)); } },
  };
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "popup.js"), "utf8");
  vm.runInNewContext(src, {
    document, chrome, console, URL, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const ready = domListeners.find((listener) => listener.type === "DOMContentLoaded");
  if (!ready) throw new Error("popup.js did not register DOMContentLoaded");
  ready.fn();
  return { nodes, sent, storageListener };
}

test("popup boot paints scan state and does not call a dead scorer mock", async () => {
  const api = load("background.js", ["statusWhenOffscreenDown", "messageOf"], "", VM);
  const statusReply = api.statusWhenOffscreenDown(new Error("Could not establish connection"), {
    inferenceMode: "transformers",
    forceMock: false,
  });
  const { nodes, sent, storageListener } = bootPopup({
    state: "unavailable",
    label: "unavailable",
    contentType: "video",
    confidence: null,
    reason: "server returned no score",
  }, statusReply);
  for (let i = 0; i < 8; i++) await flushMicrotasks();

  assert.ok(sent.some((msg) => msg.type === "getInferenceStatus"));
  assert.equal(nodes["last-scan-card"].dataset.state, "unavailable");
  assert.equal(nodes["score-label"].textContent, "unavailable");
  assert.equal(nodes["confidence-score"].textContent, "—");
  assert.equal(nodes["content-type"].textContent, "video");
  assert.match(nodes["scan-detail"].textContent, /no score/);
  assert.equal(nodes["model-status"].dataset.state, "error");
  assert.match(nodes["model-status"].textContent, /not ready/);
  assert.doesNotMatch(nodes["model-status"].textContent, /mock/i);
  assert.equal(statusReply.mode, "transformers");

  storageListener({
    lastScan: {
      newValue: {
        state: "signal",
        label: "local score",
        contentType: "text",
        confidence: 0.42,
        mode: "transformers",
      },
    },
  }, "local");
  assert.equal(nodes["confidence-score"].textContent, "42");
  assert.equal(nodes["last-scan-card"].dataset.state, "signal");
  assert.equal(nodes["score-label"].textContent, "local score");
  assert.equal(nodes["scan-detail"].hidden, true);

  storageListener({
    lastScan: { newValue: { label: "pending", contentType: "image", confidence: null } },
  }, "local");
  assert.equal(nodes["last-scan-card"].dataset.state, "unavailable");
  assert.equal(nodes["confidence-score"].textContent, "—");
  assert.match(nodes["scan-detail"].textContent, /did not finish/);
  assert.doesNotMatch(nodes["confidence-score"].textContent, /\d/);
});

test("offscreen failures are unavailable and carry no score", () => {
  const off = load("offscreen.js", ["failureReply"], "", VM);
  const reply = plain(off.failureReply("id-1", new Error("boom")));
  assert.deepEqual(reply, {
    id: "id-1",
    label: "unavailable",
    state: "unavailable",
    reason: "scoring failed: boom",
  });
});
