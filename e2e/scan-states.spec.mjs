import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extensionSource, stageExtension, startFixtureServer } from "./fixture.mjs";

// Isolated unpacked extension. Model hosts are blocked, so this never downloads weights.
// Last-scan rows are written through chrome.storage and read back from the real popup.

test.setTimeout(90_000);

test("popup shows stored scan states and does not call the scorer mock", async () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(extensionSource(), "manifest.json"), "utf8"));
  expect(shipped.host_permissions, "shipped manifest stays free of install-time host permissions").toBeFalsy();

  const fixture = await startFixtureServer();
  const extensionDir = stageExtension(fixture.origin);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucidscan-e2e-scan-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: "chrome-for-testing",
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
        "--host-resolver-rules=MAP huggingface.co 127.0.0.1, MAP *.huggingface.co 127.0.0.1, MAP *.hf.co 127.0.0.1",
      ],
    });
    await context.route(/huggingface\.co|hf\.co/i, (route) => route.abort());

    const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(serviceWorker.url()).host;

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        lastScan: {
          state: "unavailable",
          label: "unavailable",
          contentType: "video",
          confidence: null,
          reason: "server returned no score",
        },
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });

    await expect(popup.locator("#last-scan-card")).toHaveAttribute("data-state", "unavailable");
    await expect(popup.locator("#score-label")).toHaveText("unavailable");
    await expect(popup.locator("#confidence-score")).toHaveText("—");
    await expect(popup.locator("#content-type")).toHaveText("video");
    await expect(popup.locator("#scan-detail")).toContainText("server returned no score");

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        lastScan: {
          state: "signal",
          label: "local score",
          contentType: "text",
          confidence: 0.73,
          mode: "transformers",
        },
      });
    });
    await expect(popup.locator("#confidence-score")).toHaveText("73");
    await expect(popup.locator("#score-label")).toHaveText("local score");
    await expect(popup.locator("#last-scan-card")).toHaveAttribute("data-state", "signal");
    await expect(popup.locator("#scan-detail")).toBeHidden();

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        lastScan: {
          state: "cancelled",
          label: "cancelled",
          contentType: "image",
          confidence: null,
          reason: "scan cancelled",
        },
      });
    });
    await expect(popup.locator("#score-label")).toHaveText("cancelled");
    await expect(popup.locator("#confidence-score")).toHaveText("—");
    await expect(popup.locator("#last-scan-card")).toHaveAttribute("data-state", "cancelled");
    await expect(popup.locator("#scan-detail")).toContainText("scan cancelled");

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        lastScan: {
          state: "loading",
          label: "loading",
          contentType: "text",
          confidence: null,
          reason: "model still loading",
          progress: 40,
        },
      });
    });
    await expect(popup.locator("#score-label")).toHaveText("loading");
    await expect(popup.locator("#confidence-score")).toHaveText("…");
    await expect(popup.locator("#confidence-score")).not.toHaveText("40");
    await expect(popup.locator("#scan-detail")).toContainText("model still loading");

    const status = await popup.evaluate(async () => {
      const reply = await chrome.runtime.sendMessage({ type: "getInferenceStatus" });
      return reply && typeof reply === "object" ? reply : { missing: true, reply };
    });
    expect(status.missing, JSON.stringify(status)).toBeFalsy();
    expect(status.mode, JSON.stringify(status)).toEqual(expect.any(String));
    expect(status.mode, JSON.stringify(status)).not.toBe("mock");
    expect(["unavailable", "idle", "loading", "error", "ready"], JSON.stringify(status)).toContain(status.text);
    expect(["unavailable", "idle", "loading", "error", "ready"], JSON.stringify(status)).toContain(status.image);
    expect(status, JSON.stringify(status)).not.toHaveProperty("score");
    const modelText = await popup.locator("#model-status").innerText();
    expect(modelText).not.toMatch(/mock/i);
    expect(modelText).not.toBe("Models: …");
    await expect(popup.locator("#confidence-score")).toHaveText("…");
  } finally {
    if (context) await context.close();
    await fixture.close();
    fs.rmSync(extensionDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
