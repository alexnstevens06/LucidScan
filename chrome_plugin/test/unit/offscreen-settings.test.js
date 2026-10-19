const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const offscreen = fs.readFileSync(path.join(root, "offscreen.js"), "utf8");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");

test("offscreen startup does not call chrome.storage.local.get", () => {
  const start = offscreen.indexOf("Eager settings");
  assert.ok(start >= 0, "startup block missing");
  const startup = offscreen.slice(start);
  assert.equal(/chrome\.storage\.local\.get\s*\(/.test(startup), false);
  assert.equal(/chrome\.storage\s*\./.test(startup), false);
  assert.match(startup, /type:\s*["']getOffscreenSettings["']/);
  assert.match(startup, /loadSettings\s*\(\s*result\s*\)/);
  assert.match(startup, /result\.autoWarmup\s*!==\s*false/);
  assert.match(startup, /warmup\s*\(\s*["']text["']\s*\)/);
  assert.match(startup, /attempt\s*<\s*5/);
  assert.match(startup, /setTimeout\s*\(\s*r\s*,\s*300\s*\)/);
});

test("offscreen.js does not touch chrome.storage", () => {
  assert.equal(/chrome\.storage\s*\./.test(offscreen), false);
  assert.equal(/chrome\.storage\.local\.get\s*\(/.test(offscreen), false);
});

test("background.js handles getOffscreenSettings from storage", () => {
  const ignoreAt = background.indexOf('startsWith("offscreen.")');
  const handlerAt = background.indexOf('msg.type === "getOffscreenSettings"');
  assert.ok(ignoreAt >= 0, "offscreen. ignore missing");
  assert.ok(handlerAt > ignoreAt, "handler must not use an offscreen. prefix");
  assert.equal(background.includes("offscreen.getOffscreenSettings"), false);

  const next = background.indexOf("if (msg.type", handlerAt + 10);
  const body = background.slice(handlerAt, next === -1 ? handlerAt + 1500 : next);
  assert.match(body, /chrome\.storage\.local\.get\s*\(/);
  assert.match(body, /autoWarmup:\s*true/);
  assert.match(body, /inferenceMode:\s*["']transformers["']/);
  assert.match(body, /forceMock:\s*false/);
  assert.match(body, /sendResponse\s*\(\s*\{/);
  assert.match(body, /autoWarmup/);
  assert.match(body, /inferenceMode/);
  assert.match(body, /forceMock/);
});
