# lib/ — vendored Transformers.js + ONNX Runtime Web WASM

| File | Purpose |
|------|---------|
| `transformers.min.js` | `@huggingface/transformers` browser bundle (see `VERSION`) |
| `ort-wasm-simd-threaded.jsep.wasm` | ORT Web WASM backend |
| `ort-wasm-simd-threaded.jsep.mjs` | ORT WASM glue (loaded beside the `.wasm`) |

`offscreen.js` sets `env.backends.onnx.wasm.wasmPaths` to `chrome.runtime.getURL("lib/")` and `numThreads = 1` (MV3 CSP blocks blob workers).

**Models are not vendored here.** On first use they download from Hugging Face into the browser cache:

- Text: `onnx-community/tmr-ai-text-detector-ONNX` (q8)
- Images: `Xenova/clip-vit-base-patch32`

Re-vendor after upgrading:

```bash
npm install @huggingface/transformers@3
cp node_modules/@huggingface/transformers/dist/transformers.min.js chrome_plugin/lib/
cp node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.* chrome_plugin/lib/
```
