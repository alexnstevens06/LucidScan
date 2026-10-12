const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const offscreen = fs.readFileSync(path.resolve(__dirname, "..", "..", "offscreen.js"), "utf8");

test("every model id is pinned to a 40-char HF commit SHA and passed to pipeline()", () => {
  const block = offscreen.slice(offscreen.indexOf("const MODEL_REVISIONS"));
  for (const id of ["TEXT_MODEL", "IMAGE_MODEL"]) {
    assert.match(block, new RegExp("\\[" + id + "\\]:\\s*\"[0-9a-f]{40}\""), id + " not pinned");
  }
  assert.match(offscreen, /revision:\s*MODEL_REVISIONS\[model\]/);
  assert.doesNotMatch(offscreen, /revision:\s*["']main["']/);
});
