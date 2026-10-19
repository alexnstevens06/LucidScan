#!/usr/bin/env node
// Real-browser lifecycle check for the LucidScan extension (needs google-chrome + network for the
// first-run model download). Not part of npm test.
//
//   node --experimental-websocket chrome_plugin/scripts/lifecycle_e2e.mjs [outDir]
//
// What it does:
//  - Copies chrome_plugin/ to a temp dir and adds http://127.0.0.1/* to that copy's
//    host_permissions (Enable needs a user-gesture permission prompt automation can't click; the
//    real manifest is untouched). localhost (the cross-origin image hosts) is NOT granted.
//  - Serves a page on 127.0.0.1:8801 with a same-origin image, a cross-origin image from
//    localhost:8802 (no CORS) and one from localhost:8803 (CORS *).
//  - Enable (twice), wait for first-run model load to reach a real score or "unavailable",
//    Disable, check nothing is left, re-enable (twice), check no duplicates.
//  - Writes log.txt, summary.json and screenshots into outDir.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(HERE, "..");
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), "lucidscan-e2e"));
const PORT = 9344, PAGE = 8801, XO = 8802, CORS = 8803;
const ORIGIN = `http://127.0.0.1:${PAGE}/*`;
const MODEL_WAIT_MS = Number(process.env.MODEL_WAIT_MS || 15 * 60 * 1000);
fs.mkdirSync(OUT, { recursive: true });
const logFile = fs.createWriteStream(path.join(OUT, "log.txt"));
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
  console.log(line);
  logFile.write(line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = { checks: {}, timeline: [] };
const check = (name, ok, detail) => {
  summary.checks[name] = { ok: !!ok, detail };
  log(ok ? "PASS" : "FAIL", name, detail ?? "");
};

// --- fixtures: a textured BMP (not flat, so the prefilter doesn't skip it) ---
function bmp(w, h, seed) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write("BM"); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * h, 34);
  let s = seed;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const n = (s >>> 24) & 63;
    const o = 54 + y * row + x * 3;
    buf[o] = (x * 255 / w + n) & 255; buf[o + 1] = (y * 255 / h + n) & 255; buf[o + 2] = ((x + y) * 2 + seed + n) & 255;
  }
  return buf;
}
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>LucidScan lifecycle e2e</title>
<style>body{font:16px system-ui;margin:20px;background:#fff} img{display:block;margin:10px 0}</style></head><body>
<h1>LucidScan lifecycle e2e</h1>
<p id="para">This paragraph is selected by the test to check the text chip appears only while enabled.</p>
<div style="display:flex;gap:16px">
<figure><img id="same" src="/same.bmp" width="320" height="240"><figcaption>same-origin</figcaption></figure>
<figure><img id="xo" src="http://localhost:${XO}/xo.bmp" width="320" height="240"><figcaption>cross-origin, no CORS</figcaption></figure>
<figure><img id="cors" src="http://localhost:${CORS}/cors.bmp" width="320" height="240"><figcaption>cross-origin, CORS *</figcaption></figure>
</div></body></html>`;
function serve(port, routes, headers = {}) {
  const srv = http.createServer((req, res) => {
    const body = routes[req.url.split("?")[0]];
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": req.url.endsWith(".bmp") ? "image/bmp" : "text/html", "cache-control": "no-store", ...headers });
    res.end(body);
  });
  srv.listen(port); // dual-stack so "localhost" works whether it resolves to ::1 or 127.0.0.1
  return srv;
}

// --- CDP client ---
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.n = 0; this.wait = new Map(); this.handlers = [];
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.wait.has(m.id)) {
        const { res, rej, method } = this.wait.get(m.id); this.wait.delete(m.id);
        m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result);
      } else for (const h of this.handlers) h(m);
    };
  }
  open() { return new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); }
  call(method, params = {}, sessionId) {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.wait.set(id, { res, rej, method }));
  }
  on(h) { this.handlers.push(h); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-e2e-"));
  const ext = path.join(tmp, "ext");
  fs.cpSync(EXT_SRC, ext, { recursive: true, filter: (p) => !p.includes("__pycache__") });
  const mf = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  mf.host_permissions = ["http://127.0.0.1/*"];
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(mf, null, 2));
  log("test-only extension copy", ext, "host_permissions", mf.host_permissions);

  const servers = [
    serve(PAGE, { "/page.html": PAGE_HTML, "/same.bmp": bmp(320, 240, 7) }),
    serve(XO, { "/xo.bmp": bmp(320, 240, 91) }),
    serve(CORS, { "/cors.bmp": bmp(320, 240, 173) }, { "access-control-allow-origin": "*" }),
  ];
  const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`,
    "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--test-type",
    "--password-store=basic", "--disable-search-engine-choice-screen", "--window-size=1280,900",
    `--user-data-dir=${path.join(tmp, "profile")}`, "about:blank"], { stdio: "ignore", detached: true });
  let cdp;
  try {
    let ver;
    for (let i = 0; i < 100 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); }
    }
    log("browser", ver.Browser);
    summary.browser = ver.Browser;
    cdp = new CDP(ver.webSocketDebuggerUrl); await cdp.open();
    const extId = (await cdp.call("Extensions.loadUnpacked", { path: ext })).id;
    log("extension id", extId);

    // offscreen + SW console -> log
    const consoleOf = (label) => (m) => {
      if (m.method === "Runtime.consoleAPICalled" && m.sessionId === consoleOf[label]) {
        log(`[${label} console.${m.params.type}]`, m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
      }
    };
    const attachConsole = async (label, pred) => {
      for (let i = 0; i < 50; i++) {
        const t = (await cdp.call("Target.getTargets")).targetInfos.find(pred);
        if (t) {
          const sid = (await cdp.call("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
          consoleOf[label] = sid; cdp.on(consoleOf(label));
          await cdp.call("Runtime.enable", {}, sid);
          return sid;
        }
        await sleep(200);
      }
      return null;
    };
    const swSid = await attachConsole("sw", (t) => t.type === "service_worker" && t.url.includes(extId));
    const offSid = await attachConsole("offscreen", (t) => t.url.includes(`${extId}/offscreen.html`));
    log("attached sw", !!swSid, "offscreen", !!offSid);

    // page tab + isolated-world tracking
    const pageT = (await cdp.call("Target.getTargets")).targetInfos.find((t) => t.type === "page");
    const pSid = (await cdp.call("Target.attachToTarget", { targetId: pageT.targetId, flatten: true })).sessionId;
    const isolated = new Map();
    cdp.on((m) => {
      if (m.sessionId !== pSid) return;
      if (m.method === "Runtime.executionContextCreated") {
        const c = m.params.context;
        if (c.auxData?.type === "isolated" && c.origin?.includes(extId)) isolated.set(c.id, c);
      }
      if (m.method === "Runtime.executionContextsCleared") isolated.clear();
      if (m.method === "Runtime.executionContextDestroyed") isolated.delete(m.params.executionContextId);
    });
    await cdp.call("Page.enable", {}, pSid);
    await cdp.call("Runtime.enable", {}, pSid);
    await cdp.call("Page.navigate", { url: `http://127.0.0.1:${PAGE}/page.html` }, pSid);
    const evalPage = async (expression, contextId) => {
      const r = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, pSid);
      if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    for (let i = 0; i < 50; i++) { if (await evalPage("document.readyState === 'complete' && [...document.images].every(i => i.complete)")) break; await sleep(200); }
    const shot = async (name) => {
      const { data } = await cdp.call("Page.captureScreenshot", { format: "png" }, pSid);
      const f = path.join(OUT, name); fs.writeFileSync(f, Buffer.from(data, "base64")); log("screenshot", f);
    };
    const domBadges = () => evalPage("document.querySelectorAll('[data-lucidscan-host]').length");
    const stats = async () => {
      const ids = [...isolated.keys()];
      const out = [];
      for (const id of ids) {
        try { out.push(await evalPage("globalThis.__lucidScanInstance ? globalThis.__lucidScanInstance.stats() : null", id)); } catch (e) { out.push({ err: String(e) }); }
      }
      return { isolatedWorlds: ids.length, instances: out };
    };

    // extension page used as "popup" to send privileged messages (sender = extension page)
    const popT = await cdp.call("Target.createTarget", { url: `chrome-extension://${extId}/popup.html`, background: true });
    const popSid = (await cdp.call("Target.attachToTarget", { targetId: popT.targetId, flatten: true })).sessionId;
    await sleep(800);
    const evalPop = async (expression) => {
      const r = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, popSid);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const send = (msg) => evalPop(`new Promise(r => chrome.runtime.sendMessage(${JSON.stringify(msg)}, x => r({ resp: x ?? null, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))`);
    const tabId = await evalPop(`chrome.tabs.query({ url: "http://127.0.0.1:${PAGE}/*" }).then(t => t[0] && t[0].id)`);
    log("page tab id", tabId);

    check("0 badges before enable", (await domBadges()) === 0, await domBadges());

    // ---- enable twice ----
    const en1 = await send({ type: "enableBadgesForSite", origin: ORIGIN, permissionGranted: true, tabId });
    log("enable #1", en1);
    const en2 = await send({ type: "enableBadgesForSite", origin: ORIGIN, permissionGranted: true, tabId });
    log("enable #2 (double click)", en2);
    await sleep(1500);
    const s1 = await stats();
    log("stats after enable x2", s1);
    const live1 = s1.instances.filter((x) => x && x.alive);
    check("enable x2 -> exactly one live instance", live1.length === 1, s1);
    check("enable x2 -> one badge per image (3)", (await domBadges()) === 3, await domBadges());
    await shot("01-enabled-first-run-loading.png");

    // ---- first-run loading -> real score / unavailable ----
    const t0 = Date.now();
    let final = null;
    let sawLoading = false;
    while (Date.now() - t0 < MODEL_WAIT_MS) {
      const st = (await stats()).instances.find((x) => x && x.alive);
      const texts = st ? st.badgeTexts : [];
      summary.timeline.push({ t_s: Math.round((Date.now() - t0) / 1000), texts });
      if (texts.some((t) => /loading|downloading|…/.test(t))) sawLoading = true;
      if (summary.timeline.length % 6 === 1) log("badges", texts);
      if (texts.length === 3 && texts.every((t) => /^local score \d+$/.test(t) || t === "unavailable")) { final = texts; break; }
      await sleep(5000);
    }
    log("final badges after", Math.round((Date.now() - t0) / 1000), "s:", final);
    summary.firstRun = { seconds: Math.round((Date.now() - t0) / 1000), sawLoading, final };
    check("first run shows a loading/progress state", sawLoading);
    check("first-run loading reaches real score or unavailable (no stuck badges)", !!final, final);
    await shot("02-after-first-run.png");

    // which images the page canvas can read (content.js sends a dataUrl only for those)
    const perImg = {};
    for (const id of ["same", "xo", "cors"]) {
      const dataUrlExpr = `c(document.getElementById('${id}'))`;
      // dataUrl exactly as content.js computes it (null when the canvas is tainted)
      const dataUrl = await evalPage(`(() => { const c = (img) => { try { const k = document.createElement('canvas'); k.width = 64; k.height = 48; k.getContext('2d').drawImage(img, 0, 0, 64, 48); return k.toDataURL('image/jpeg'); } catch (e) { return null; } }; return ${dataUrlExpr}; })()`);
      perImg[id] = { canvasReadable: dataUrl !== null };
    }
    log("canvas readability per image", perImg);
    check("cross-origin no-CORS image taints canvas", perImg.xo.canvasReadable === false);
    const nums = (final || []).filter((t) => /^local score/.test(t)).length;
    const unav = (final || []).filter((t) => t === "unavailable").length;
    summary.firstRun.counts = { realScores: nums, unavailable: unav };
    const by = Object.fromEntries(((await stats()).instances.find((x) => x && x.alive) || {}).badgesBySrc || []);
    log("badge per image src", by);
    summary.firstRun.bySrc = by;
    const pick = (frag) => Object.entries(by).find(([k]) => k.includes(frag))?.[1];
    check("same-origin image -> real model score", /^local score \d+$/.test(pick("/same.bmp") || ""), pick("/same.bmp"));
    check("cross-origin image WITHOUT CORS -> 'unavailable' (no fake number)", pick("/xo.bmp") === "unavailable", pick("/xo.bmp"));
    check("cross-origin image WITH CORS (tainted canvas, offscreen fetch) -> real model score", /^local score \d+$/.test(pick("/cors.bmp") || ""), pick("/cors.bmp"));
    check("totals: 2 real scores + 1 unavailable", nums === 2 && unav === 1, final);

    // ---- text chip while enabled ----
    await evalPage("getSelection().selectAllChildren(document.getElementById('para'))");
    await sleep(1500);
    const withChip = await domBadges();
    check("text selection shows chip while enabled", withChip === 4, withChip);
    await evalPage("getSelection().removeAllRanges()");

    // ---- sender checks ----
    const isoId = [...isolated.keys()][0];
    const forged = await evalPage(`new Promise(r => chrome.runtime.sendMessage({ type: "clearAllBadgeOrigins" }, x => r({ resp: x ?? null, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))`, isoId);
    const forgedOff = await evalPage(`new Promise(r => chrome.runtime.sendMessage({ type: "offscreen.cancelLoad" }, x => r({ resp: x ?? null, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))`, isoId);
    const stillEnabled = await evalPop(`chrome.storage.local.get({ enabledOrigins: [] }).then(r => r.enabledOrigins)`);
    log("content-script forged clearAllBadgeOrigins ->", forged, "offscreen.cancelLoad ->", forgedOff, "enabledOrigins now", stillEnabled);
    check("content script cannot call privileged clearAllBadgeOrigins", forged.resp === null && stillEnabled.includes(ORIGIN), { forged, stillEnabled });
    check("content script cannot drive offscreen directly", forgedOff.resp === null, forgedOff);

    // ---- disable ----
    const dis = await send({ type: "disableBadgeOrigin", origin: ORIGIN });
    log("disable", dis);
    await sleep(1000);
    const s2 = await stats();
    log("stats after disable", s2);
    check("disable -> no live instance", s2.instances.every((x) => x === null || (x && x.alive === false)), s2);
    check("disable -> 0 badges in DOM", (await domBadges()) === 0, await domBadges());
    await evalPage("getSelection().selectAllChildren(document.getElementById('para'))");
    await evalPage("history.pushState({}, '', '/page.html#soft-nav'); dispatchEvent(new PopStateEvent('popstate'))");
    await sleep(2500);
    check("after disable: selection shows no chip and soft nav brings no badges back", (await domBadges()) === 0, await domBadges());
    await evalPage("getSelection().removeAllRanges()");
    await shot("03-disabled.png");

    // ---- re-enable twice ----
    log("re-enable #1", await send({ type: "enableBadgesForSite", origin: ORIGIN, permissionGranted: true, tabId }));
    log("re-enable #2", await send({ type: "enableBadgesForSite", origin: ORIGIN, permissionGranted: true, tabId }));
    await sleep(4000);
    const s3 = await stats();
    log("stats after re-enable x2", s3);
    const live3 = s3.instances.filter((x) => x && x.alive);
    check("re-enable x2 -> exactly one live instance", live3.length === 1, s3);
    check("re-enable -> same listener counts as first enable (no duplicates)",
      live3.length === 1 && live1.length === 1 && live3[0].listeners === live1[0].listeners && live3[0].chromeListeners === live1[0].chromeListeners,
      { first: live1[0] && live1[0].listeners, again: live3[0] && live3[0].listeners });
    check("re-enable -> one badge per image (3)", (await domBadges()) === 3, await domBadges());
    for (let i = 0; i < 12; i++) {
      const st = (await stats()).instances.find((x) => x && x.alive);
      if (st && st.badgeTexts.every((t) => /^local score \d+$/.test(t) || t === "unavailable")) break;
      await sleep(2000);
    }
    const s4 = (await stats()).instances.find((x) => x && x.alive);
    log("badges after re-enable", s4 && s4.badgeTexts);
    summary.reenableBadges = s4 && s4.badgeTexts;
    await shot("04-re-enabled.png");
  } finally {
    summary.ok = Object.values(summary.checks).every((c) => c.ok);
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
    log(summary.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
    try { process.kill(-chrome.pid, "SIGTERM"); } catch {}
    for (const s of servers) s.close();
    logFile.end();
    setTimeout(() => process.exit(summary.ok ? 0 : 1), 500);
  }
}
main().catch((e) => { log("ERROR", String(e && e.stack || e)); summary.ok = false; process.exitCode = 1; });
