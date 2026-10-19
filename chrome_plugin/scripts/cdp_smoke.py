#!/usr/bin/env python3
"""Optional CDP smoke: load unpacked via Extensions.loadUnpacked, check SW alive and 0 badges before Enable.
Needs: google-chrome, python websocket-client. Usage: python3 chrome_plugin/scripts/cdp_smoke.py"""
import json, os, signal, shutil, socket, subprocess, sys, tempfile, time, urllib.request, http.server, threading, functools
from pathlib import Path
try:
    import websocket
except ImportError:
    print("SKIP: pip install websocket-client"); sys.exit(0)
ROOT = Path(__file__).resolve().parents[1]
PORT, HTTP = 9333, 8799

def main():
    with socket.socket() as so:  # a leftover Chrome on PORT would answer for us and hang the run
        if so.connect_ex(("127.0.0.1", PORT)) == 0:
            print(f"FAIL: port {PORT} already in use (stale Chrome?)"); return 1
    prof = tempfile.mkdtemp(prefix="lucid-cdp-")
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP), h)
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    p = subprocess.Popen(["google-chrome", "--headless=new", f"--remote-debugging-port={PORT}",
        "--no-first-run", "--enable-unsafe-extension-debugging",
        # Same profile flags as demo_capture.py. Without them, on Chrome 154 headless the sample-page
        # navigation often never committed (request never reached the local server) and the run hung.
        "--no-default-browser-check", "--test-type", "--password-store=basic", "--disable-search-engine-choice-screen",
        f"--user-data-dir={prof}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        for _ in range(50):
            try:
                ver = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version")); break
            except Exception: time.sleep(0.2)
        ws = websocket.create_connection(ver["webSocketDebuggerUrl"], timeout=20, suppress_origin=True)
        n = [0]
        def call(method, params=None, sid=None):
            n[0] += 1; msg = {"id": n[0], "method": method, "params": params or {}}
            if sid: msg["sessionId"] = sid
            ws.send(json.dumps(msg))
            while True:
                r = json.loads(ws.recv())
                if r.get("id") == n[0]:
                    if "error" in r: raise RuntimeError(f"{method}: {r['error']}")
                    return r["result"]
        ext = call("Extensions.loadUnpacked", {"path": str(ROOT)})["id"]
        print("loaded extension", ext)
        sw = None
        for _ in range(30):
            sw = [t for t in call("Target.getTargets")["targetInfos"]
                  if t["type"] == "service_worker" and ext in t["url"]]
            if sw: break
            time.sleep(0.3)
        assert sw, "service worker target not found"
        print("SW alive:", sw[0]["url"])
        swsid = call("Target.attachToTarget", {"targetId": sw[0]["targetId"], "flatten": True})["sessionId"]
        perms = call("Runtime.evaluate", {"expression": "chrome.permissions.getAll()", "awaitPromise": True,
                                          "returnByValue": True}, swsid)["result"]["value"]
        print("install-time permissions:", perms)
        assert not perms.get("origins"), f"host origins granted at install: {perms.get('origins')}"
        url = f"http://127.0.0.1:{HTTP}/test/sample.html"
        # Reuse the initial about:blank tab, as demo_capture.py does.
        tid = [t for t in call("Target.getTargets")["targetInfos"] if t["type"] == "page"][0]["targetId"]
        sid = call("Target.attachToTarget", {"targetId": tid, "flatten": True})["sessionId"]
        call("Page.enable", {}, sid)
        nav = call("Page.navigate", {"url": url}, sid)
        if nav.get("errorText"):
            raise RuntimeError(f"navigate failed: {nav['errorText']}")
        ev = lambda e: call("Runtime.evaluate", {"expression": e, "returnByValue": True}, sid)["result"].get("value")
        for _ in range(40):
            if ev("location.href.includes('sample.html') && document.readyState === 'complete'"): break
            time.sleep(0.25)
        time.sleep(2)
        print("page:", ev("location.href"))
        assert "sample.html" in (ev("location.href") or ""), f"sample page did not load: {ev('location.href')} {ev('document.title')}"
        expr = "document.querySelectorAll('[data-lucidscan-host]').length"
        cnt = call("Runtime.evaluate", {"expression": expr, "returnByValue": True}, sid)["result"]["value"]
        imgs = call("Runtime.evaluate", {"expression": "document.images.length", "returnByValue": True}, sid)["result"]["value"]
        print(f"sample.html images={imgs} badges_before_enable={cnt}")
        # Why activeTab stays: without a host grant (and no "tabs" permission) Chrome hides tab.url, so
        # the popup / Alt+Shift+L could not even compute the origin to request. activeTab exposes it
        # for the tab the user invoked the extension on.
        urls = call("Runtime.evaluate", {"expression": "chrome.tabs.query({}).then(ts => ts.map(t => t.url || null))",
                                         "awaitPromise": True, "returnByValue": True}, swsid)["result"]["value"]
        print("tab urls visible to SW before any grant:", urls)
        assert not any(u and "sample.html" in u for u in urls), "tab.url visible without grant (activeTab rationale changed)"
        assert cnt == 0, "badges present before Enable (inject-only violated)"
        print("PASS cdp smoke")
        return 0
    finally:
        try:
            os.killpg(p.pid, signal.SIGTERM); p.wait(timeout=10)
        except Exception:
            try: os.killpg(p.pid, signal.SIGKILL)
            except Exception: pass
        srv.shutdown(); shutil.rmtree(prof, ignore_errors=True)

if __name__ == "__main__":
    sys.exit(main())
