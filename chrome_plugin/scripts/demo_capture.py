#!/usr/bin/env python3
"""TEST-ONLY demo capture for LucidScan badges (screenshots + short screen recording).

!! This is NOT the product flow. !!
The real extension only injects badges after the user clicks "Enable badges on this site",
which calls chrome.permissions.request() and needs a real user gesture. Automation cannot
press that, so this script stands in for the grant like this:

  1. Copies chrome_plugin/ to a throwaway dir OUTSIDE the repo (default /tmp/lucidscan-demo-ext)
     and edits ONLY that copy's manifest: adds the demo origins to "host_permissions"
     (granted at install time, no prompt) and tags the name "(demo test build)".
     No JS is changed; the real chrome_plugin/manifest.json is never touched.
  2. Loads that copy with CDP Extensions.loadUnpacked (branded Chrome 154 ignores --load-extension).
  3. Attaches to the extension service worker over CDP and calls the SAME function the popup's
     Enable path ends in, activateBadgesForOrigin(pattern), via Runtime.evaluate. Its
     permissions.contains() check passes because of step 1, so it stores the origin and calls
     scripting.registerContentScripts exactly as after a real click.

Models: warms both pipelines first (offscreen.warmup, the same message the popup's
"Load local models" sends) and waits for ready (or error -> fallback is captured and reported).

Reading badge text: badges live in a CLOSED shadow root, so page JS cannot read them. This script
reads them only through CDP DOM.describeNode(pierce=true) to know when scores are painted;
verify the PNGs visually as well.

Needs on the host: google-chrome, Xvfb, ffmpeg, pngquant (optional), python3 websocket-client, Pillow.
Usage (from repo root):
  python3 chrome_plugin/scripts/demo_capture.py [--out docs/demo] [--raw /home/bot/LucidScan-demo]
           [--no-video] [--only sample,wikipedia,...]
Screenshots are of pages as a viewer sees them; the script never downloads or stores site images.
"""
import argparse, tempfile, functools, http.server, json, os, shutil, signal, subprocess, sys, threading, time
import urllib.request
from pathlib import Path

try:
    import websocket
except ImportError:
    print("need: pip install websocket-client"); sys.exit(2)

PLUGIN = Path(__file__).resolve().parents[1]
REPO = PLUGIN.parent
HTTP_PORT, CDP_PORT, DISPLAY = 8771, 9344, ":99"
W, H = 1280, 800

# Demo origins granted in the TEST COPY only (match patterns ignore ports).
DEMO_HOSTS = [
    "http://localhost/*",
    "http://127.0.0.1/*",
    "https://en.wikipedia.org/*",
    "https://commons.wikimedia.org/*",
    "https://www.nasa.gov/*",
]

# Wikipedia sometimes shows a campaign banner above the article; start the view at the article title instead.
TO_TITLE_JS = "(()=>{const h=document.querySelector('#firstHeading');if(h){window.scrollTo(0,h.getBoundingClientRect().top+scrollY-14)}})()"

PAGES = [
    # key, url, origin pattern passed to activateBadgesForOrigin, scroll JS (optional), select text?
    dict(key="sample", url=f"http://localhost:{HTTP_PORT}/test/sample.html",
         origin=f"http://localhost:{HTTP_PORT}/*", scroll=None, chip=True, min_badges=2),
    dict(key="wikipedia", url="https://en.wikipedia.org/wiki/Yosemite_National_Park",
         origin="https://en.wikipedia.org/*", scroll=TO_TITLE_JS, chip=True, min_badges=1),
    dict(key="commons", url="https://commons.wikimedia.org/wiki/Commons:Featured_pictures/Places/Natural",
         origin="https://commons.wikimedia.org/*",
         scroll="(()=>{const g=document.querySelector('.gallery, ul.gallery');if(g){window.scrollTo(0,g.getBoundingClientRect().top+scrollY+160)}})()",
         chip=False, min_badges=4),
    dict(key="nasa", url="https://www.nasa.gov/image-of-the-day/",
         origin="https://www.nasa.gov/*", scroll="window.scrollTo(0, 420)", chip=False, min_badges=2),
]
VIDEO_PAGE = dict(url="https://en.wikipedia.org/wiki/Grand_Canyon", origin="https://en.wikipedia.org/*")

PENDING_TEXT = {"…", "pending", ""}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def build_test_extension(dst: Path):
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(PLUGIN, dst, ignore=shutil.ignore_patterns("scripts", "test", "__pycache__", "*.pyc"))
    mf = json.loads((dst / "manifest.json").read_text())
    hp = mf.get("host_permissions", [])
    for h in DEMO_HOSTS:
        if h not in hp:
            hp.append(h)
    mf["host_permissions"] = hp
    mf["name"] = mf["name"] + " (demo test build)"
    (dst / "manifest.json").write_text(json.dumps(mf, indent=2))
    log("test-only extension copy:", dst, "added host_permissions:", DEMO_HOSTS)


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self.n = 0

    def call(self, method, params=None, sid=None, timeout=60):
        self.n += 1
        mid = self.n
        msg = {"id": mid, "method": method, "params": params or {}}
        if sid:
            msg["sessionId"] = sid
        self.ws.send(json.dumps(msg))
        self.ws.settimeout(timeout)
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == mid:
                if "error" in r:
                    raise RuntimeError(f"{method}: {r['error']}")
                return r["result"]

    def ev(self, expr, sid, await_promise=False, timeout=60):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                           "awaitPromise": await_promise}, sid, timeout=timeout)
        if "exceptionDetails" in r:
            raise RuntimeError(f"eval failed: {r['exceptionDetails'].get('text')} "
                               f"{r['exceptionDetails'].get('exception', {}).get('description', '')}")
        return r["result"].get("value")


def pill_texts(cdp, sid):
    """Read badge/chip text from closed shadow roots via CDP (DOM pierce). Returns list of (kind, text)."""
    doc = cdp.call("DOM.getDocument", {"depth": 0}, sid)
    ids = cdp.call("DOM.querySelectorAll", {"nodeId": doc["root"]["nodeId"],
                                            "selector": "[data-lucidscan-host]"}, sid)["nodeIds"]
    out = []
    for nid in ids:
        try:
            node = cdp.call("DOM.describeNode", {"nodeId": nid, "depth": -1, "pierce": True}, sid)["node"]
        except RuntimeError:
            continue
        attrs = node.get("attributes", [])
        style = attrs[attrs.index("style") + 1] if "style" in attrs else ""
        kind = "chip" if "position:fixed" in style.replace(" ", "") else "image"
        hidden = "display:none" in style.replace(" ", "")
        text = ""
        for sr in node.get("shadowRoots", []):
            for ch in sr.get("children", []):
                if ch.get("localName") == "div":
                    text = "".join(c.get("nodeValue", "") for c in ch.get("children", []) if c.get("nodeType") == 3)
        out.append((kind, text.strip(), hidden))
    return out


def wait_badges(cdp, sid, min_badges, timeout):
    t0 = time.time()
    last = []
    while time.time() - t0 < timeout:
        last = [(t, x) for (t, x, hid) in pill_texts(cdp, sid) if t == "image"]
        done = [x for _, x in last if x not in PENDING_TEXT]
        if len(last) >= min_badges and len(done) == len(last):
            time.sleep(1.0)
            return [x for _, x in last]
        time.sleep(1.5)
    return [x for _, x in last]


def navigate(cdp, sid, url, timeout=45):
    cdp.call("Page.navigate", {"url": url}, sid)
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if cdp.ev(f"location.href.startsWith({json.dumps(url[:40])}) && document.readyState === 'complete'", sid):
                return True
        except RuntimeError:
            pass
        time.sleep(0.4)
    return False


SELECT_JS = r"""
(() => {
  const sels = ['#mw-content-text .mw-parser-output > p', 'main p', 'article p', 'body p'];
  let ps = [];
  for (const q of sels) { ps = [...document.querySelectorAll(q)].filter(p => p.innerText.trim().length > 80); if (ps.length) break; }
  const vh = innerHeight;
  const p = ps.find(p => { const r = p.getBoundingClientRect(); return r.top > 90 && r.bottom < vh - 40 && p.innerText.trim().length > 80; })
         || ps.find(p => p.innerText.trim().length > 80);
  if (!p) return null;
  const r = document.createRange(); r.selectNodeContents(p);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
  return p.innerText.trim().slice(0, 60);
})()
"""





def wait_chip(cdp, sid, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        chips = [x for (k, x, hid) in pill_texts(cdp, sid) if k == "chip" and not hid]
        if chips and chips[0] not in PENDING_TEXT:
            time.sleep(0.8)
            return chips[0]
        time.sleep(1)
    return None


def shot(cdp, sid, path: Path):
    import base64
    data = cdp.call("Page.captureScreenshot", {"format": "png"}, sid)["data"]
    path.write_bytes(base64.b64decode(data))
    log("screenshot", path, path.stat().st_size // 1024, "KB")


def compress_png(src: Path, dst: Path, limit=500 * 1024):
    from PIL import Image
    dst.parent.mkdir(parents=True, exist_ok=True)
    img = Image.open(src).convert("RGB")
    for width in (img.width, 1100, 960, 820):
        im = img if width == img.width else img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
        im.save(dst, optimize=True)
        if shutil.which("pngquant"):
            subprocess.run(["pngquant", "--force", "--skip-if-larger", "--quality", "60-90",
                            "--output", str(dst), str(dst)], check=False)
        if dst.stat().st_size <= limit:
            break
    log("compressed", dst, dst.stat().st_size // 1024, "KB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(REPO / "docs" / "demo"))
    ap.add_argument("--raw", default="/home/bot/LucidScan-demo")
    ap.add_argument("--ext-copy", default="/tmp/lucidscan-demo-ext")
    ap.add_argument("--profile", default="",
                    help="Chrome profile dir; default a fresh temp dir (a reused profile can keep a stale "
                         "service worker for the same unpacked path; fresh = honest first-run model download)")
    ap.add_argument("--only", default="")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--model-timeout", type=int, default=900)
    args = ap.parse_args()
    out, raw = Path(args.out), Path(args.raw)
    (raw / "raw").mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    build_test_extension(Path(args.ext_copy))
    tmp_profile = not args.profile
    if tmp_profile:
        args.profile = tempfile.mkdtemp(prefix="lucidscan-demo-profile-")
    signal.signal(signal.SIGTERM, lambda *a: (_ for _ in ()).throw(KeyboardInterrupt()))

    procs = []
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(PLUGIN))
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    xvfb = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", f"{W}x{H}x24", "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs.append(xvfb)
    log("Xvfb pid", xvfb.pid)
    time.sleep(1.5)
    env = dict(os.environ, DISPLAY=DISPLAY)
    chrome = subprocess.Popen([
        "google-chrome", f"--remote-debugging-port={CDP_PORT}", "--enable-unsafe-extension-debugging",
        f"--user-data-dir={args.profile}", "--no-first-run", "--no-default-browser-check", "--test-type",
        "--password-store=basic", "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
        "--disable-search-engine-choice-screen", "--lang=en-US", "--ozone-platform=x11",
        f"--window-size={W},{H}", "--window-position=0,0", "--force-device-scale-factor=1", "about:blank"],
        env=env, stdout=subprocess.DEVNULL, stderr=open(raw / "chrome-stderr.log", "w"),
        start_new_session=True)
    procs.append(chrome)
    log("chrome pid", chrome.pid)
    summary = {"pages": {}, "grant": "test-copy manifest host_permissions + SW activateBadgesForOrigin via CDP"}
    try:
        ver = None
        for _ in range(100):
            try:
                ver = json.load(urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/version")); break
            except Exception:
                time.sleep(0.2)
        cdp = CDP(ver["webSocketDebuggerUrl"])
        log("chrome", ver.get("Browser"))
        ext = cdp.call("Extensions.loadUnpacked", {"path": args.ext_copy})["id"]
        log("loaded test extension", ext)
        sw = None
        for _ in range(50):
            sw = [t for t in cdp.call("Target.getTargets")["targetInfos"]
                  if t["type"] == "service_worker" and ext in t["url"]]
            if sw: break
            time.sleep(0.3)
        assert sw, "service worker target not found"
        swsid = cdp.call("Target.attachToTarget", {"targetId": sw[0]["targetId"], "flatten": True})["sessionId"]
        log("SW attached:", sw[0]["url"])

        # --- models: same message the popup's "Load local models" sends ---
        cdp.ev("""(async () => { await ensureOffscreen();
            chrome.runtime.sendMessage({type:'offscreen.warmup', which:'both'})
              .then(r => { globalThis.__demoWarm = r; }).catch(e => { globalThis.__demoWarm = {error: String(e)}; });
            return 'started'; })()""", swsid, await_promise=True)
        t0, st, lastmsg = time.time(), {}, None
        while time.time() - t0 < args.model_timeout:
            st = cdp.ev("chrome.runtime.sendMessage({type:'offscreen.getProgress'})", swsid, await_promise=True) or {}
            msg = (st.get("progress") or {}).get("message")
            if msg != lastmsg:
                log("models:", st.get("text"), st.get("image"), msg); lastmsg = msg
            if st.get("text") in ("ready", "error") and st.get("image") in ("ready", "error"):
                break
            time.sleep(3)
        summary["models"] = {k: st.get(k) for k in ("mode", "text", "image", "textDevice", "imageDevice",
                                                    "textError", "imageError")}
        summary["model_load_s"] = round(time.time() - t0)
        log("model state:", summary["models"])

        # --- grant stand-in: call the popup's SW activation path for each demo origin ---
        for pat in sorted({p["origin"] for p in PAGES} | {VIDEO_PAGE["origin"]}):
            r = cdp.ev(f"activateBadgesForOrigin({json.dumps(pat)}, null)", swsid, await_promise=True)
            log("activateBadgesForOrigin", pat, "->", {k: r.get(k) for k in ("ok", "granted", "error")})
            summary.setdefault("activate", {})[pat] = r

        page = [t for t in cdp.call("Target.getTargets")["targetInfos"] if t["type"] == "page"][0]
        sid = cdp.call("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})["sessionId"]
        cdp.call("Page.enable", {}, sid); cdp.call("DOM.enable", {}, sid)
        cdp.call("Target.activateTarget", {"targetId": page["targetId"]})

        only = set(filter(None, args.only.split(",")))
        for i, pg in enumerate(PAGES, 1):
            if only and pg["key"] not in only:
                continue
            res = {"url": pg["url"]}
            summary["pages"][pg["key"]] = res
            try:
                ok = navigate(cdp, sid, pg["url"])
                res["loaded"] = ok
                if not ok:
                    raise RuntimeError("page did not finish loading")
                time.sleep(2)
                if pg["scroll"]:
                    cdp.ev(pg["scroll"], sid); time.sleep(1.5)
                texts = wait_badges(cdp, sid, pg["min_badges"], timeout=90)
                res["badges"] = texts
                log(pg["key"], "badges:", texts)
                name = f"{i:02d}-{pg['key']}-badges.png"
                shot(cdp, sid, raw / "raw" / name)
                compress_png(raw / "raw" / name, out / name)
                res["png"] = name
                if pg["chip"]:
                    sel = cdp.ev(SELECT_JS, sid)
                    chip = wait_chip(cdp, sid)
                    res["chip"] = chip
                    log(pg["key"], "selected:", sel, "chip:", chip)
                    cname = f"{i:02d}-{pg['key']}-text-chip.png"
                    shot(cdp, sid, raw / "raw" / cname)
                    compress_png(raw / "raw" / cname, out / cname)
                    res["chip_png"] = cname
                    cdp.ev("getSelection().removeAllRanges()", sid)
            except Exception as e:  # keep going; report the failure
                res["error"] = str(e)
                log("PAGE FAILED", pg["key"], e)

        if not args.no_video:
            mp4 = raw / "lucidscan-demo.mp4"
            cdp.call("Page.navigate", {"url": "about:blank"}, sid); time.sleep(1)
            ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0",
                                   "-video_size", f"{W}x{H}", "-framerate", "15", "-i", f"{DISPLAY}.0",
                                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
                                   "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)],
                                  stdin=subprocess.PIPE, env=env)
            procs.append(ff)
            log("ffmpeg pid", ff.pid)
            time.sleep(1)
            navigate(cdp, sid, VIDEO_PAGE["url"])
            cdp.ev(TO_TITLE_JS, sid)
            wait_badges(cdp, sid, 1, timeout=12)
            for _ in range(12):  # smooth scroll ~ 9 s
                cdp.ev("window.scrollBy({top: 110, behavior: 'smooth'})", sid); time.sleep(0.75)
            time.sleep(3)
            cdp.ev(SELECT_JS, sid)
            vchip = wait_chip(cdp, sid, timeout=10)
            time.sleep(3)
            cdp.ev("window.scrollBy({top: 60, behavior: 'smooth'})", sid); time.sleep(2)
            ff.stdin.write(b"q"); ff.stdin.flush(); ff.wait(timeout=30)
            summary["video"] = {"mp4": str(mp4), "bytes": mp4.stat().st_size, "chip": vchip}
            log("video", mp4, mp4.stat().st_size // 1024, "KB")
    finally:
        (raw / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
        for p in reversed(procs):
            try:
                if p is chrome:
                    os.killpg(p.pid, signal.SIGTERM)
                else:
                    p.terminate()
                p.wait(timeout=10)
            except Exception:
                try: p.kill()
                except Exception: pass
        srv.shutdown()
        if tmp_profile:
            shutil.rmtree(args.profile, ignore_errors=True)
        log("summary:", raw / "summary.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
