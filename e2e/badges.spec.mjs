import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extensionSource, stageExtension, startFixtureServer } from "./fixture.mjs";

// Terminal badge copy. A real score needs the Hugging Face download (~435 MB).
// CI blocks those hosts so the offscreen load fails and the badge shows unavailable.
const SETTLED = /^(?:unavailable|local score \d+)$/;

const allowModels = process.env.LUCIDSCAN_E2E_ALLOW_MODELS === "1";
const settleMs = Number(process.env.MODEL_WAIT_MS || (allowModels ? 180_000 : 20_000));

test.setTimeout(settleMs + 60_000);

test("enable badges on a local page, then disable tears them down", async () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(extensionSource(), "manifest.json"), "utf8"));
  expect(shipped.host_permissions, "shipped manifest stays free of install-time host permissions").toBeFalsy();

  const fixture = await startFixtureServer();
  const extensionDir = stageExtension(fixture.origin);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucidscan-e2e-profile-"));
  let context;
  try {
    const args = [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
    ];
    if (!allowModels) {
      // Fail model fetches immediately. A hung Hugging Face download stays on
      // "loading model…" until the content script's 10 minute retry budget.
      args.push(
        "--host-resolver-rules=MAP huggingface.co 127.0.0.1, MAP *.huggingface.co 127.0.0.1, MAP *.hf.co 127.0.0.1"
      );
    }

    // channel "chrome-for-testing" forces the full Chromium binary. Playwright's
    // default headless shell does not load extensions. --load-extension still
    // works on that Chrome-for-Testing build (branded Chrome 137+ ignores it).
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: "chrome-for-testing",
      viewport: { width: 1280, height: 800 },
      args,
    });
    if (!allowModels) {
      await context.route(/huggingface\.co|hf\.co/i, (route) => route.abort());
    }

    const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(serviceWorker.url()).host;
    const page = context.pages()[0];
    await page.goto(fixture.pageUrl, { waitUntil: "load" });
    await expect.poll(() => page.locator("#pic").evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(48);
    expect(await page.locator("[data-lucidscan-host]").count(), "nothing is injected before Enable").toBe(0);

    // chrome.action.openPopup() creates a real toolbar popup, but Playwright does
    // not adopt that target as a Page (Chrome for Testing 156). popup.html in a
    // background tab runs the same listeners. A trusted locator.click() would focus
    // that tab, and Enable/Disable read the active tab asynchronously — so the click
    // is dispatched while the fixture stays in front.
    const popup = await context.newPage();
    await focusFixture(page);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
    await focusFixture(page);
    await expect.poll(async () => popup.locator("#site-origin").innerText(), { timeout: 5_000 }).toContain(`${fixture.origin}/`);
    await expect(popup.locator("#enable-site")).toBeEnabled();

    await clickKeepingFixtureActive(page, popup, "enable-site");
    await expect(popup.locator("#status")).toContainText(`Enabled on ${fixture.origin}/*`);
    await expect(popup.locator("#site-state")).toHaveText("ON for this site");

    const reader = await badgeReader(page);
    await expect.poll(() => page.locator("[data-lucidscan-host]").count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(async () => settlement(await reader.texts()), {
      timeout: settleMs,
      message: "image badge should settle to a local score or unavailable",
    }).toBe("settled:1");

    await page.locator("#para").selectText();
    await expect.poll(() => page.locator("[data-lucidscan-host]").count(), { timeout: 10_000 }).toBe(2);
    await expect.poll(async () => settlement(await reader.texts()), {
      timeout: settleMs,
      message: "image badge and selection chip should both settle",
    }).toBe("settled:2");
    const hosts = await page.locator("[data-lucidscan-host]").evaluateAll((els) => els.map((el) => el.style.position));
    expect(hosts).toEqual(expect.arrayContaining(["absolute", "fixed"]));

    await expect(popup.locator("#disable-site")).toBeVisible();
    await clickKeepingFixtureActive(page, popup, "disable-site");
    await expect(popup.locator("#status")).toContainText(`Disabled ${fixture.origin}/*`);
    await expect.poll(async () => teardownSnapshot(serviceWorker, page), { timeout: 10_000 }).toEqual({
      hosts: 0,
      origins: [],
      scripts: 0,
    });

    await page.locator("#para").selectText();
    await page.evaluate(() => history.pushState({}, "", "/page.html#after-disable"));
    // Selection chip is debounced (280ms). A zombie listener would show a host again.
    await page.waitForTimeout(1_000);
    expect(await page.locator("[data-lucidscan-host]").count()).toBe(0);
    const instance = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
      const tab = tabs[0];
      if (!tab || tab.id == null) return null;
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (globalThis.__lucidScanInstance ? globalThis.__lucidScanInstance.stats() : null),
      });
      return injected ? injected.result : null;
    });
    expect(instance == null || instance.alive === false).toBe(true);
  } finally {
    if (context) await context.close();
    await fixture.close();
    fs.rmSync(extensionDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

function settlement(texts) {
  if (texts.length > 0 && texts.every((text) => SETTLED.test(text))) return `settled:${texts.length}`;
  return texts.join(" | ") || "(no badges)";
}

async function focusFixture(page) {
  await page.bringToFront();
}

async function clickKeepingFixtureActive(page, popup, buttonId) {
  await focusFixture(page);
  await popup.evaluate((id) => {
    const button = document.getElementById(id);
    if (!button || button.disabled || button.hidden) {
      throw new Error(`popup button #${id} is not clickable`);
    }
    button.click();
  }, buttonId);
}

async function badgeReader(page) {
  const session = await page.context().newCDPSession(page);
  return {
    async texts() {
      const doc = await session.send("DOM.getDocument", { depth: -1, pierce: true });
      const texts = [];
      const walk = (node) => {
        if (!node) return;
        const attrs = {};
        if (node.attributes) {
          for (let i = 0; i < node.attributes.length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
        }
        if ((attrs.class || "").split(/\s+/).includes("pill")) {
          const text = (node.children || [])
            .filter((child) => child.nodeName === "#text")
            .map((child) => child.nodeValue || "")
            .join("")
            .trim();
          texts.push(text);
        }
        for (const child of node.children || []) walk(child);
        for (const shadow of node.shadowRoots || []) walk(shadow);
      };
      walk(doc.root);
      return texts;
    },
  };
}

async function teardownSnapshot(serviceWorker, page) {
  const hosts = await page.locator("[data-lucidscan-host]").count();
  const stored = await serviceWorker.evaluate(async () => {
    const data = await chrome.storage.local.get({ enabledOrigins: [] });
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    return {
      origins: data.enabledOrigins,
      scripts: scripts.length,
    };
  });
  return { hosts, origins: stored.origins, scripts: stored.scripts };
}
