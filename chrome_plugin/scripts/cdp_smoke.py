#!/usr/bin/env python3
"""Optional CDP smoke: load unpacked via Extensions.loadUnpacked, check SW alive and 0 badges before Enable.
Needs: google-chrome, python websocket-client. Usage: python3 chrome_plugin/scripts/cdp_smoke.py"""
import json, os, subprocess, sys, tempfile, time, urllib.request, http.server, threading, functools
from pathlib import Path
try:
    import websocket
except ImportError:
    print("SKIP: pip install websocket-client"); sys.exit(0)
ROOT = Path(__file__).resolve().parents[1]
PORT, HTTP = 9333, 8799

def main():
    prof = tempfile.mkdtemp(prefix="lucid-cdp-")
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP), h)
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    p = subprocess.Popen(["google-chrome", "--headless=new", f"--remote-debugging-port={PORT}",
        "--no-first-run", "--enable-unsafe-extension-debugging",
        f"--user-data-dir={prof}", "--no-default-browser-check", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        tid = call("Target.createTarget", {"url": f"http://127.0.0.1:{HTTP}/test/sample.html"})["targetId"]
        sid = call("Target.attachToTarget", {"targetId": tid, "flatten": True})["sessionId"]
        time.sleep(3)
        expr = "document.querySelectorAll('[data-lucidscan-host]').length"
        cnt = call("Runtime.evaluate", {"expression": expr, "returnByValue": True}, sid)["result"]["value"]
        imgs = call("Runtime.evaluate", {"expression": "document.images.length", "returnByValue": True}, sid)["result"]["value"]
        print(f"sample.html images={imgs} badges_before_enable={cnt}")
        assert cnt == 0, "badges present before Enable (inject-only violated)"
        print("PASS cdp smoke")
        return 0
    finally:
        p.terminate(); srv.shutdown()

if __name__ == "__main__":
    sys.exit(main())
