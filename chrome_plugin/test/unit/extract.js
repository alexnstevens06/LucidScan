// Pulls named top-level/nested function declarations out of extension sources
// so pure helpers can be unit-tested in Node without a browser or bundler.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");

function extractFunction(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let i = src.indexOf("{", m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function load(file, names, prelude = "", ctx = {}, extra = []) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const code = prelude + "\n" + names.map((n) => extractFunction(src, n)).join("\n") +
    `\n({ ${names.concat(extra).join(", ")} })`;
  return vm.runInNewContext(code, { Date, Math, String, Map, URL, ...ctx });
}

module.exports = { load, ROOT };
