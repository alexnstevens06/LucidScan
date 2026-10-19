// Minimal fake page + chrome APIs so the real content.js can run in node:vm.
// Only the surface content.js touches is modelled; listener bookkeeping is exact so the tests
// can assert "no duplicate listeners" and "everything removed on teardown".
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CONTENT_SRC = fs.readFileSync(path.resolve(__dirname, "..", "..", "content.js"), "utf8");

class CountingTarget {
  constructor() { this._l = new Map(); }
  addEventListener(type, fn, opts) {
    const capture = typeof opts === "boolean" ? opts : !!(opts && opts.capture);
    const list = this._l.get(type) || [];
    if (list.some((x) => x.fn === fn && x.capture === capture)) return; // DOM de-dupes identical
    list.push({ fn, capture, once: !!(opts && opts.once) });
    this._l.set(type, list);
  }
  removeEventListener(type, fn, opts) {
    const capture = typeof opts === "boolean" ? opts : !!(opts && opts.capture);
    const list = this._l.get(type) || [];
    this._l.set(type, list.filter((x) => !(x.fn === fn && x.capture === capture)));
  }
  dispatch(type, ev = {}) {
    for (const x of [...(this._l.get(type) || [])]) {
      if (x.once) this.removeEventListener(type, x.fn, x.capture);
      x.fn.call(this, { type, ...ev });
    }
  }
  count(type) {
    if (type) return (this._l.get(type) || []).length;
    let n = 0;
    for (const v of this._l.values()) n += v.length;
    return n;
  }
}

class FakeElement extends CountingTarget {
  constructor(tag, page) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.children = [];
    this.parentElement = null;
    this.page = page;
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.offsetTop = 10;
    this.offsetLeft = 10;
    this.offsetWidth = 100;
    this.offsetHeight = 20;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  hasAttribute(k) { return k in this.attrs; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  attachShadow() {
    const root = { kids: [], append: (...k) => root.kids.push(...k) };
    this.shadow = root;
    return root;
  }
  append(...k) { for (const c of k) this.appendChild(c); }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
      this.parentElement = null;
    }
  }
  get isConnected() {
    let n = this;
    while (n) { if (n === this.page.document.documentElement) return true; n = n.parentElement; }
    return false;
  }
  get offsetParent() { return this.parentElement; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll(sel) { return sel === "img" ? this.page.imgs.filter((i) => i.isConnected) : []; }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { top: 50, left: 50, bottom: 70, width: 100, height: 20 }; }
}

function makePage({ respond } = {}) {
  const page = { imgs: [], pills: [], sent: [], timers: [], now: 1_000_000 };
  const document = new CountingTarget();
  page.document = document;
  document.documentElement = new FakeElement("html", page);
  document.body = new FakeElement("body", page);
  document.documentElement.appendChild(document.body);
  document.createElement = (tag) => {
    if (tag === "canvas") {
      // Cross-origin image: drawing taints the canvas, reading pixels throws (as in Chrome).
      return { width: 0, height: 0, getContext: () => ({
        drawImage() {},
        getImageData() { throw Object.assign(new Error("tainted"), { name: "SecurityError" }); },
      }), toDataURL() { throw Object.assign(new Error("tainted"), { name: "SecurityError" }); } };
    }
    const el = new FakeElement(tag, page);
    if (tag === "div") page.pills.push(el);
    return el;
  };
  document.querySelectorAll = (sel) => (sel === "img" ? page.imgs.filter((i) => i.isConnected) : []);

  const window = new CountingTarget();
  window.innerWidth = 1024;
  window.innerHeight = 768;
  window.getSelection = () => page.selection || { isCollapsed: true, rangeCount: 0, toString: () => "" };
  page.window = window;

  const origPush = function pushState() {};
  const origReplace = function replaceState() {};
  const history = { pushState: origPush, replaceState: origReplace };
  page.history = history;
  page.origPush = origPush;
  page.origReplace = origReplace;

  const observers = { io: 0, mo: 0 };
  class IntersectionObserver {
    constructor(cb) { this.cb = cb; this.on = new Set(); }
    observe(t) {
      if (!this.on.has(t)) { this.on.add(t); observers.io++; }
      queueMicrotask(() => this.cb([{ isIntersecting: true, target: t }]));
    }
    disconnect() { observers.io -= this.on.size; this.on.clear(); }
  }
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.active = false; }
    observe() { if (!this.active) { this.active = true; observers.mo++; } }
    disconnect() { if (this.active) { this.active = false; observers.mo--; } }
  }
  page.observers = observers;

  const makeEvent = () => {
    const ls = new Set();
    return { addListener: (f) => ls.add(f), removeListener: (f) => ls.delete(f), ls };
  };
  const onMessage = makeEvent();
  const onChanged = makeEvent();
  page.storage = { pausedOrigins: [], enabledOrigins: ["https://site.example/*"] };
  page.respond = respond || (() => ({ state: "signal", score: 0.5, mode: "transformers" }));
  const chrome = {
    runtime: {
      id: "ext-id",
      lastError: undefined,
      onMessage,
      sendMessage(msg, cb) {
        page.sent.push(msg);
        const r = page.respond(msg, page.sent.length);
        queueMicrotask(() => cb && cb(r));
      },
    },
    storage: {
      onChanged,
      local: { get(defs, cb) { const out = {}; for (const k of Object.keys(defs)) out[k] = page.storage[k] ?? defs[k]; queueMicrotask(() => cb(out)); } },
    },
  };
  page.chrome = chrome;
  page.message = (msg, sender = { id: "ext-id" }) => { for (const f of [...onMessage.ls]) f(msg, sender, () => {}); };
  page.storageChange = (changes) => { for (const f of [...onChanged.ls]) f(changes, "local"); };

  const setTimeout = (fn, ms) => { const t = { fn, at: page.now + (ms || 0), id: Symbol("t") }; page.timers.push(t); return t; };
  const clearTimeout = (t) => { page.timers = page.timers.filter((x) => x !== t); };

  page.ctx = vm.createContext({
    window, document, history, chrome, location: { protocol: "https:", host: "site.example" },
    IntersectionObserver, MutationObserver, setTimeout, clearTimeout, queueMicrotask,
    requestAnimationFrame: (f) => queueMicrotask(f), requestIdleCallback: (f) => queueMicrotask(f),
    getComputedStyle: () => ({ position: "relative", display: "block", visibility: "visible", opacity: "1" }),
    Date: { now: () => page.now }, Math, String, Map, WeakMap, WeakSet, Set, Promise, Array, Symbol, Number, Object,
  });
  page.inject = () => vm.runInContext(CONTENT_SRC, page.ctx);
  page.instance = () => page.ctx.__lucidScanInstance;
  page.addImg = (src = "https://cdn.other.example/photo.jpg") => {
    const img = new FakeElement("img", page);
    Object.assign(img, { src, currentSrc: src, naturalWidth: 300, naturalHeight: 200, width: 300, height: 200, complete: true });
    document.body.appendChild(img);
    page.imgs.push(img);
    return img;
  };
  page.badgeHosts = () => document.body.children.filter((c) => c.hasAttribute("data-lucidscan-host"));
  page.pillTexts = () => page.badgeHosts().map((h) => h.shadow.kids.find((k) => k.className === "pill").textContent);
  page.flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  page.advance = async (ms) => {
    const end = page.now + ms;
    for (;;) {
      page.timers.sort((a, b) => a.at - b.at);
      const t = page.timers[0];
      if (!t || t.at > end) break;
      page.timers.shift();
      page.now = t.at;
      t.fn();
      await page.flush();
    }
    page.now = end;
    await page.flush();
  };
  page.listenerCounts = () => ({
    window: window.count(), document: document.count(),
    onMessage: onMessage.ls.size, onChanged: onChanged.ls.size,
    io: observers.io, mo: observers.mo,
  });
  return page;
}

module.exports = { makePage };
