# lib/ — vendored Transformers.js + ONNX Runtime Web WASM

| File | Purpose |
|------|---------|
| `transformers.min.js` | `@huggingface/transformers` browser bundle (see `VERSION`) |
| `ort-wasm-simd-threaded.jsep.wasm` | ORT Web WASM backend |
| `ort-wasm-simd-threaded.jsep.mjs` | ORT WASM glue |

These assets load **only inside extension pages** (offscreen document) via
`chrome.runtime.getURL("lib/")`. They are **not** listed in
`web_accessible_resources` (WAR minimized / empty) so web pages cannot fetch them.

`offscreen.js` sets `env.backends.onnx.wasm.wasmPaths` and `numThreads = 1`.

**Models are not vendored.** First use downloads from Hugging Face into the browser cache.
