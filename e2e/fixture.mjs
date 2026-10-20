// Local page + a temp unpacked extension for the Playwright e2e.
// The shipped chrome_plugin/ tree is copied, then host_permissions is set to the
// loopback fixture origin only. Headless CI cannot click Chrome's native permission
// bubble, and without a host grant the popup's tabs.query hides tab.url, so Enable
// cannot see the page. No extension script is stubbed.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "chrome_plugin");

export function extensionSource() {
  return EXT_SRC;
}

/** Textured BMP so content.js does not treat the image as flat (variance < 4) or tiny (< 48px). */
export function texturedBmp(width, height, seed) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * height);
  buf.write("BM");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * height, 34);
  let state = seed;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (state * 1103515245 + 12345) >>> 0;
      const noise = (state >>> 24) & 63;
      const offset = 54 + y * row + x * 3;
      buf[offset] = (x * 255 / width + noise) & 255;
      buf[offset + 1] = (y * 255 / height + noise) & 255;
      buf[offset + 2] = ((x + y) * 2 + seed + noise) & 255;
    }
  }
  return buf;
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>LucidScan e2e fixture</title>
  <style>body{font:16px system-ui;margin:24px;background:#fff} img{display:block;margin-top:16px}</style>
</head>
<body>
  <h1>LucidScan e2e fixture</h1>
  <p id="para">This paragraph is selected by the test to check the text chip appears only while badges are enabled.</p>
  <img id="pic" src="/pic.bmp" width="320" height="240" alt="textured fixture" />
</body>
</html>`;

export function startFixtureServer() {
  const image = texturedBmp(320, 240, 11);
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/pic.bmp") {
      res.writeHead(200, { "content-type": "image/bmp", "cache-control": "no-store" });
      res.end(image);
      return;
    }
    if (url === "/" || url === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        origin,
        pageUrl: `${origin}/page.html`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export function stageExtension(origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lucidscan-e2e-ext-"));
  fs.cpSync(EXT_SRC, dir, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("__pycache__"),
  });
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [`${origin}/*`];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}
